//! rapidraw-web: commands the MCP server (rrweb/relay/mcp.mjs, jobs.mjs) uses for headless processing.
//!
//! - `rrweb_measure_images`: measures rendered or exported images: brightness, clipping, noise and the
//!   regular grid AI denoise tiles can leave. It drives the automatic check after an export and the choice
//!   between no denoise, BM3D and AI denoise.
//! - `rrweb_resolve_ai`: generates the AI results (masks, maps, denoise) photos' edits need, without an open
//!   editor, one photo at a time.
//! - `rrweb_health`: memory and CPU of RapidRAW and the AI job queue, for `rapidraw_status`.
use image::{DynamicImage, GenericImageView, imageops};
use rayon::prelude::*;
use serde::Serialize;

const BLOCK: usize = 16;

#[derive(Serialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct ImageMeasure {
    pub path: String,
    pub width: u32,
    pub height: u32,
    /// size the measures were taken at (long edge ≤ max_edge)
    pub measured_width: u32,
    pub measured_height: u32,
    /// luminance 0..1
    pub median: f32,
    pub mean: f32,
    pub p01: f32,
    pub p99: f32,
    /// share of pixels (0..1) at the white end (≥ 250/255) and the black end (≤ 3/255)
    pub white_clip: f32,
    pub black_clip: f32,
    /// share of the centre (the middle 50 % of width and height, where the subject usually is) that is crushed
    /// to black (≤ 6/255)
    pub center_black: f32,
    /// noise: standard deviation in 0..255 levels at the measured size, in the flattest areas (Immerkær)
    pub noise: f32,
    /// noise in the shadows (blocks with a mean of 15..80 levels), where it shows most
    pub shadow_noise: f32,
    /// a regular horizontal and vertical grid (seams of denoise tiles): strength (≥ 6 is a visible grid) and
    /// period in pixels of the measured size
    pub grid_score: f32,
    pub grid_period: f32,
    pub error: Option<String>,
}

fn luma(img: &DynamicImage, max_edge: u32) -> (Vec<f32>, usize, usize) {
    let (w, h) = img.dimensions();
    let small;
    let img = if max_edge > 0 && w.max(h) > max_edge {
        let s = max_edge as f64 / w.max(h) as f64;
        small = img.resize_exact(
            ((w as f64 * s).round() as u32).max(1),
            ((h as f64 * s).round() as u32).max(1),
            imageops::FilterType::Triangle,
        );
        &small
    } else {
        img
    };
    let rgb = img.to_rgb32f();
    let (w, h) = (rgb.width() as usize, rgb.height() as usize);
    let raw = rgb.as_raw();
    let mut out = vec![0.0f32; w * h];
    out.par_iter_mut().enumerate().for_each(|(i, v)| {
        let p = &raw[i * 3..i * 3 + 3];
        *v = (0.2126 * p[0] + 0.7152 * p[1] + 0.0722 * p[2]).clamp(0.0, 1.0) * 255.0;
    });
    (out, w, h)
}

fn percentile(sorted: &[f32], q: f32) -> f32 {
    if sorted.is_empty() {
        return 0.0;
    }
    sorted[((sorted.len() - 1) as f32 * q).round() as usize]
}

/// Immerkær's fast noise estimate per 16x16 block: (sigma, block mean) of every block
fn block_noise(l: &[f32], w: usize, h: usize) -> Vec<(f32, f32)> {
    if w < BLOCK + 2 || h < BLOCK + 2 {
        return Vec::new();
    }
    let bw = (w - 2) / BLOCK;
    let bh = (h - 2) / BLOCK;
    let factor = (std::f32::consts::PI / 2.0).sqrt() / (6.0 * (BLOCK * BLOCK) as f32);
    (0..bh)
        .into_par_iter()
        .flat_map_iter(|by| {
            (0..bw).map(move |bx| {
                let (mut acc, mut sum) = (0.0f32, 0.0f32);
                for y in by * BLOCK + 1..by * BLOCK + 1 + BLOCK {
                    for x in bx * BLOCK + 1..bx * BLOCK + 1 + BLOCK {
                        let at = |dx: isize, dy: isize| {
                            l[(y as isize + dy) as usize * w + (x as isize + dx) as usize]
                        };
                        let v = at(-1, -1) - 2.0 * at(0, -1) + at(1, -1) - 2.0 * at(-1, 0)
                            + 4.0 * at(0, 0)
                            - 2.0 * at(1, 0)
                            + at(-1, 1)
                            - 2.0 * at(0, 1)
                            + at(1, 1);
                        acc += v.abs();
                        sum += at(0, 0);
                    }
                }
                (acc * factor, sum / (BLOCK * BLOCK) as f32)
            })
        })
        .collect()
}

/// Robust spread of a profile (MAD scaled to a standard deviation)
fn spread(profile: &[f32]) -> f32 {
    let mut v: Vec<f32> = profile.to_vec();
    v.sort_by(|a, b| a.total_cmp(b));
    let med = v[v.len() / 2];
    let mut dev: Vec<f32> = v.iter().map(|x| (x - med).abs()).collect();
    dev.sort_by(|a, b| a.total_cmp(b));
    dev[dev.len() / 2] * 1.4826
}

/// Strength of a line that repeats every `period` samples: the profile is folded at that period (epoch
/// folding) and the strongest phase bin is given as a z-score against the profile's own robust spread.
/// About 3 to 4.5 for noise, far above 6 for a regular grid. (A single DFT bin does not work here: the second
/// difference of a thin seam has almost no energy at the fundamental.)
fn periodicity(profile: &[f32], period: f32, sigma: f32) -> f32 {
    let n = profile.len();
    if n < 3 * period as usize || period < 8.0 || sigma <= 1e-9 {
        return 0.0;
    }
    let bins = period.round() as usize;
    let mut sum = vec![0.0f64; bins];
    let mut count = vec![0u32; bins];
    for (i, v) in profile.iter().enumerate() {
        let b = ((i as f32 % period) as usize).min(bins - 1);
        sum[b] += *v as f64;
        count[b] += 1;
    }
    sum.iter()
        .zip(&count)
        .filter(|(_, c)| **c >= 3)
        .map(|(s, c)| ((s / *c as f64).abs() * (*c as f64).sqrt() / sigma as f64) as f32)
        .fold(0.0, f32::max)
}

/// Seams of tiles are straight lines at the same spacing across and down. The profile of each direction is the
/// mean second difference of every column (row): seams add the same sign along their whole length, the scene
/// averages out. A grid must show in both directions with one period; repeating things on stage (an LED wall,
/// a truss) are rarely periodic both ways at the same spacing.
fn grid(l: &[f32], w: usize, h: usize, expected: Option<f32>) -> (f32, f32) {
    if w < 64 || h < 64 {
        return (0.0, 0.0);
    }
    let cols: Vec<f32> = (0..w)
        .into_par_iter()
        .map(|x| {
            if x < 2 || x + 2 >= w {
                return 0.0;
            }
            let s: f32 = (0..h)
                .map(|y| l[y * w + x] - 0.5 * (l[y * w + x - 2] + l[y * w + x + 2]))
                .sum();
            s / h as f32
        })
        .collect();
    let rows: Vec<f32> = (0..h)
        .into_par_iter()
        .map(|y| {
            if y < 2 || y + 2 >= h {
                return 0.0;
            }
            let s: f32 = (0..w)
                .map(|x| l[y * w + x] - 0.5 * (l[(y - 2) * w + x] + l[(y + 2) * w + x]))
                .sum();
            s / w as f32
        })
        .collect();
    let (cols, rows) = (&cols[2..w - 2], &rows[2..h - 2]);
    let (sc, sr) = (spread(cols), spread(rows));
    let periods: Vec<f32> = match expected.filter(|p| *p >= 8.0) {
        Some(p) => (0..=48).map(|i| p * (0.94 + 0.0025 * i as f32)).collect(),
        None => {
            let max = (w.min(h) as f32 / 3.0).min(600.0);
            let mut v = Vec::new();
            let mut p = 24.0f32;
            while p <= max {
                v.push(p);
                p *= 1.0025;
            }
            v
        }
    };
    periods
        .par_iter()
        .map(|&p| (periodicity(cols, p, sc).min(periodicity(rows, p, sr)), p))
        .reduce(|| (0.0, 0.0), |a, b| if b.0 > a.0 { b } else { a })
}

pub fn measure(img: &DynamicImage, max_edge: u32, expected_grid: Option<f32>) -> ImageMeasure {
    let (width, height) = img.dimensions();
    let (l, w, h) = luma(img, max_edge);
    let mut sorted = l.clone();
    sorted.par_sort_unstable_by(|a, b| a.total_cmp(b));
    let n = l.len().max(1) as f32;
    let white = l.par_iter().filter(|v| **v >= 250.0).count() as f32 / n;
    let black = l.par_iter().filter(|v| **v <= 3.0).count() as f32 / n;
    let (cx0, cx1, cy0, cy1) = (w / 4, w * 3 / 4, h / 4, h * 3 / 4);
    let center = (cy0..cy1)
        .flat_map(|y| (cx0..cx1).map(move |x| (x, y)))
        .filter(|(x, y)| l[y * w + x] <= 6.0)
        .count() as f32
        / ((cx1 - cx0) * (cy1 - cy0)).max(1) as f32;

    let blocks = block_noise(&l, w, h);
    let mut usable: Vec<f32> = blocks
        .iter()
        .filter(|(_, m)| (12.0..=235.0).contains(m))
        .map(|(s, _)| *s)
        .collect();
    usable.sort_by(|a, b| a.total_cmp(b));
    let mut shadows: Vec<f32> = blocks
        .iter()
        .filter(|(_, m)| (15.0..=80.0).contains(m))
        .map(|(s, _)| *s)
        .collect();
    shadows.sort_by(|a, b| a.total_cmp(b));
    let (grid_score, grid_period) = grid(&l, w, h, expected_grid);

    let mean = l.par_iter().sum::<f32>() / n;
    ImageMeasure {
        path: String::new(),
        width,
        height,
        measured_width: w as u32,
        measured_height: h as u32,
        median: percentile(&sorted, 0.5) / 255.0,
        mean: mean / 255.0,
        p01: percentile(&sorted, 0.01) / 255.0,
        p99: percentile(&sorted, 0.99) / 255.0,
        white_clip: white,
        black_clip: black,
        center_black: center,
        noise: percentile(&usable, 0.3),
        shadow_noise: percentile(&shadows, 0.5),
        grid_score,
        grid_period,
        error: None,
    }
}

#[tauri::command]
pub async fn rrweb_measure_images(
    paths: Vec<String>,
    max_edge: Option<u32>,
    expected_grid: Option<f32>,
) -> Result<Vec<ImageMeasure>, String> {
    tokio::task::spawn_blocking(move || {
        paths
            .into_iter()
            .map(|path| match image::open(&path) {
                Ok(img) => ImageMeasure {
                    path: path.clone(),
                    ..measure(&img, max_edge.unwrap_or(2048), expected_grid)
                },
                Err(e) => ImageMeasure {
                    path,
                    error: Some(e.to_string()),
                    ..Default::default()
                },
            })
            .collect()
    })
    .await
    .map_err(|e| e.to_string())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolveResult {
    path: String,
    ok: bool,
    error: Option<String>,
    ms: u64,
}

#[tauri::command]
pub async fn rrweb_resolve_ai(
    paths: Vec<String>,
    skip_denoise: Option<bool>,
    app_handle: tauri::AppHandle,
) -> Result<Vec<ResolveResult>, String> {
    tokio::task::spawn_blocking(move || {
        paths
            .into_iter()
            .map(|path| {
                let t0 = std::time::Instant::now();
                let r = crate::ai::jobs::ensure_ready_with(
                    &app_handle,
                    &path,
                    skip_denoise.unwrap_or(false),
                );
                ResolveResult {
                    path,
                    ok: r.is_ok(),
                    error: r.err(),
                    ms: t0.elapsed().as_millis() as u64,
                }
            })
            .collect()
    })
    .await
    .map_err(|e| e.to_string())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Health {
    rss_bytes: u64,
    cpu_percent: f32,
    cores: usize,
    total_memory: u64,
    available_memory: u64,
    ai_threads: usize,
    ai_jobs: crate::ai::jobs::AiJobsStatus,
}

#[tauri::command]
pub async fn rrweb_health() -> Result<Health, String> {
    tokio::task::spawn_blocking(|| {
        use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System};
        let mut sys = System::new();
        sys.refresh_memory();
        let pid = Pid::from_u32(std::process::id());
        let refresh = ProcessRefreshKind::nothing().with_cpu().with_memory();
        sys.refresh_processes_specifics(ProcessesToUpdate::Some(&[pid]), true, refresh);
        std::thread::sleep(
            sysinfo::MINIMUM_CPU_UPDATE_INTERVAL.max(std::time::Duration::from_millis(250)),
        );
        sys.refresh_processes_specifics(ProcessesToUpdate::Some(&[pid]), true, refresh);
        let (rss, cpu) = sys
            .process(pid)
            .map_or((0, 0.0), |p| (p.memory(), p.cpu_usage()));
        Health {
            rss_bytes: rss,
            cpu_percent: cpu,
            cores: std::thread::available_parallelism().map_or(1, |n| n.get()),
            total_memory: sys.total_memory(),
            available_memory: sys.available_memory(),
            ai_threads: crate::ai::models::ai_cpu_threads(),
            ai_jobs: crate::ai::jobs::get_ai_jobs_status(),
        }
    })
    .await
    .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{Rgb, RgbImage};

    // deterministic pseudo-random noise, roughly gaussian (sum of uniforms)
    fn noise(seed: &mut u64) -> f32 {
        let mut s = 0.0;
        for _ in 0..6 {
            *seed ^= *seed << 13;
            *seed ^= *seed >> 7;
            *seed ^= *seed << 17;
            s += (*seed % 10_000) as f32 / 10_000.0;
        }
        (s - 3.0) * std::f32::consts::SQRT_2
    }

    fn scene(sigma: f32, grid_every: Option<u32>) -> DynamicImage {
        scene_with(sigma, grid_every, 3.0)
    }

    fn scene_with(sigma: f32, grid_every: Option<u32>, dip: f32) -> DynamicImage {
        let (w, h) = (1600u32, 1067u32);
        let mut seed = 0x9e3779b97f4a7c15u64;
        DynamicImage::ImageRgb8(RgbImage::from_fn(w, h, |x, y| {
            let mut v = 60.0 + 80.0 * (x as f32 / w as f32) + 20.0 * ((y as f32) / 200.0).sin();
            if let Some(p) = grid_every
                && (x % p < 2 || y % p < 2)
            {
                v -= dip;
            }
            let v = (v + sigma * noise(&mut seed)).clamp(0.0, 255.0) as u8;
            Rgb([v, v, v])
        }))
    }

    #[test]
    fn noise_estimate_follows_the_added_noise() {
        for sigma in [1.0f32, 3.0, 8.0] {
            let m = measure(&scene(sigma, None), 2048, None);
            assert!(
                (m.noise - sigma).abs() < 0.35 * sigma + 0.5,
                "sigma {sigma}: measured {}",
                m.noise
            );
        }
        let clean = measure(&scene(0.0, None), 2048, None).noise;
        assert!(clean < 0.6, "clean image measured {clean}");
    }

    #[test]
    fn a_tile_grid_is_found_and_a_clean_image_is_not() {
        let with = measure(&scene(3.0, Some(137)), 2048, None);
        assert!(with.grid_score >= 6.0, "grid score {}", with.grid_score);
        assert!(
            (with.grid_period - 137.0).abs() < 3.0,
            "period {}",
            with.grid_period
        );
        let without = measure(&scene(3.0, None), 2048, None);
        assert!(
            without.grid_score < 4.0,
            "false grid {}",
            without.grid_score
        );
        let expected = measure(&scene(3.0, Some(137)), 2048, Some(137.0));
        assert!(expected.grid_score >= 6.0);
        // a seam one level deep under heavy noise is still found; heavy noise alone is not a grid
        let faint = measure(&scene_with(8.0, Some(160), 1.0), 2048, None);
        assert!(faint.grid_score >= 6.0, "faint grid {}", faint.grid_score);
        let noisy = measure(&scene(12.0, None), 2048, None);
        assert!(noisy.grid_score < 5.0, "noise as grid {}", noisy.grid_score);
    }

    #[test]
    fn white_and_black_frames_are_reported() {
        let white = DynamicImage::ImageRgb8(RgbImage::from_pixel(400, 300, Rgb([252, 252, 252])));
        let m = measure(&white, 2048, None);
        assert!(m.median > 0.95 && m.white_clip > 0.99);
        let black = DynamicImage::ImageRgb8(RgbImage::from_pixel(400, 300, Rgb([2, 2, 2])));
        let m = measure(&black, 2048, None);
        assert!(m.median < 0.02 && m.black_clip > 0.99 && m.center_black > 0.99);
    }
}
