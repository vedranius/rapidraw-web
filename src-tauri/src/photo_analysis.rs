//! Content/technical analysis of a photo, used by both AI culling and AI Style.
//!
//! Everything here works on small RGB images (a 480 px thumbnail or the 720 px
//! analysis preview culling already decodes), so it is cheap enough to run over
//! a whole event. The numbers are the "what does this photo actually look like"
//! inputs that let a look adapt its exposure, highlight/shadow recovery, white
//! balance, saturation and noise reduction per image instead of applying the
//! same fixed preset to every frame.

use image::{DynamicImage, GenericImageView, RgbImage};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::UNIX_EPOCH;

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PhotoStats {
    /// Mean linear-ish luma in 0..1 (Rec.709 weights, sRGB thumbnail).
    pub luma_mean: f64,
    /// Median luma, robust against specular highlights and dark corners.
    pub luma_median: f64,
    /// 5th / 95th luma percentiles.
    pub luma_p05: f64,
    pub luma_p95: f64,
    /// Standard deviation of luma in 0..1.
    pub contrast: f64,
    /// Fraction of pixels at/below ~2% luma.
    pub shadow_clip: f64,
    /// Fraction of pixels at/above ~98% luma.
    pub highlight_clip: f64,
    /// Mean HSV saturation in 0..1.
    pub saturation: f64,
    /// Hasler-Süsstrunk colourfulness, normalized to 0..1.
    pub colorfulness: f64,
    /// Red minus blue mean (positive = warm cast), normalized.
    pub cast_rb: f64,
    /// Green minus (red+blue)/2 mean (positive = green cast), normalized.
    pub cast_gm: f64,
    /// Mean corner luma divided by mean centre luma (low = already vignetted).
    pub corner_ratio: f64,
    /// Noise level in 0..1 derived from ISO (0 when unknown).
    pub noise: f64,
    pub iso: Option<u32>,
}

impl Default for PhotoStats {
    fn default() -> Self {
        Self {
            luma_mean: 0.45,
            luma_median: 0.45,
            luma_p05: 0.05,
            luma_p95: 0.9,
            contrast: 0.18,
            shadow_clip: 0.0,
            highlight_clip: 0.0,
            saturation: 0.3,
            colorfulness: 0.35,
            cast_rb: 0.0,
            cast_gm: 0.0,
            corner_ratio: 1.0,
            noise: 0.0,
            iso: None,
        }
    }
}

fn iso_noise(iso: u32) -> f64 {
    let log2 = (iso.max(50) as f64).log2();
    ((log2 - 6.0) / 9.0).clamp(0.0, 1.0)
}

fn percentile(hist: &[u32; 256], total: u32, fraction: f64) -> f64 {
    if total == 0 {
        return 0.0;
    }
    let target = ((fraction.clamp(0.0, 1.0)) * total as f64).ceil() as u32;
    let mut seen = 0u32;
    for (value, count) in hist.iter().enumerate() {
        seen += *count;
        if seen >= target {
            return value as f64 / 255.0;
        }
    }
    1.0
}

/// Analyses an already-decoded image. Anything larger than 512 px is downscaled
/// first; the statistics are scale-invariant enough for tone/colour decisions.
pub fn analyze_image(image: &DynamicImage, iso: Option<u32>) -> PhotoStats {
    let (width, height) = image.dimensions();
    if width == 0 || height == 0 {
        return PhotoStats::default();
    }

    // Convert to 8-bit *before* resizing. `DynamicImage::thumbnail` on the
    // Rgba32F image the RAW pipeline produces multiplies the float channels
    // (a 0.5 corner becomes 255), which made every frame read as pure white.
    // The whole culling score then collapsed to a constant. Resizing the
    // already-tone-mapped 8-bit image is both correct and faster.
    let rgb = image.to_rgb8();
    let sample = if width > 512 || height > 512 {
        DynamicImage::ImageRgb8(rgb).thumbnail(512, 512).to_rgb8()
    } else {
        rgb
    };

    analyze_rgb(&sample, iso)
}

pub fn analyze_rgb(rgb: &RgbImage, iso: Option<u32>) -> PhotoStats {
    let (width, height) = rgb.dimensions();
    let total = width as f64 * height as f64;
    if total == 0.0 {
        return PhotoStats::default();
    }

    let mut histogram = [0u32; 256];
    let mut sum_luma = 0.0;
    let mut sum_luma_sq = 0.0;
    let mut sum_saturation = 0.0;
    let mut saturated_pixels = 0.0;
    let mut sum_r = 0.0;
    let mut sum_g = 0.0;
    let mut sum_b = 0.0;
    let mut sum_rg = 0.0;
    let mut sum_rg_sq = 0.0;
    let mut sum_yb = 0.0;
    let mut sum_yb_sq = 0.0;
    let mut corner_luma = 0.0;
    let mut corner_pixels = 0.0;
    let mut center_luma = 0.0;
    let mut center_pixels = 0.0;

    for (x, y, pixel) in rgb.enumerate_pixels() {
        let r = pixel[0] as f64 / 255.0;
        let g = pixel[1] as f64 / 255.0;
        let b = pixel[2] as f64 / 255.0;

        let luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        let index = (luma * 255.0).round().clamp(0.0, 255.0) as usize;
        histogram[index] += 1;

        sum_luma += luma;
        sum_luma_sq += luma * luma;

        let max = r.max(g).max(b);
        let min = r.min(g).min(b);
        if max > 1.0e-6 {
            sum_saturation += (max - min) / max;
            saturated_pixels += 1.0;
        }

        sum_r += r;
        sum_g += g;
        sum_b += b;

        let rg = r - g;
        let yb = 0.5 * (r + g) - b;
        sum_rg += rg;
        sum_rg_sq += rg * rg;
        sum_yb += yb;
        sum_yb_sq += yb * yb;

        let nx = (x as f64 + 0.5) / width as f64;
        let ny = (y as f64 + 0.5) / height as f64;
        if nx < 0.1 || nx > 0.9 || ny < 0.1 || ny > 0.9 {
            corner_luma += luma;
            corner_pixels += 1.0;
        } else if nx > 0.3 && nx < 0.7 && ny > 0.3 && ny < 0.7 {
            center_luma += luma;
            center_pixels += 1.0;
        }
    }

    let luma_mean = sum_luma / total;
    let variance = (sum_luma_sq / total - luma_mean * luma_mean).max(0.0);
    let mean_rg = sum_rg / total;
    let mean_yb = sum_yb / total;
    let std_rg = (sum_rg_sq / total - mean_rg * mean_rg).max(0.0).sqrt();
    let std_yb = (sum_yb_sq / total - mean_yb * mean_yb).max(0.0).sqrt();
    let colorfulness_raw = (std_rg * std_rg + std_yb * std_yb).sqrt()
        + 0.3 * (mean_rg * mean_rg + mean_yb * mean_yb).sqrt();

    let total_u32 = (total as u64).min(u32::MAX as u64) as u32;
    let shadow_clip = histogram[0..=5].iter().sum::<u32>() as f64 / total;
    let highlight_clip = histogram[250..=255].iter().sum::<u32>() as f64 / total;

    let mean_r = sum_r / total;
    let mean_b = sum_b / total;
    let mean_g = sum_g / total;

    PhotoStats {
        luma_mean,
        luma_median: percentile(&histogram, total_u32, 0.5),
        luma_p05: percentile(&histogram, total_u32, 0.05),
        luma_p95: percentile(&histogram, total_u32, 0.95),
        contrast: variance.sqrt(),
        shadow_clip,
        highlight_clip,
        saturation: if saturated_pixels > 0.0 {
            sum_saturation / saturated_pixels
        } else {
            0.0
        },
        // ~0.35 on the 0..1 scale corresponds to a vividly colourful frame;
        // real concert shots measure 0.15-0.35, so this keeps headroom instead
        // of pinning every neon frame at 1.0.
        colorfulness: (colorfulness_raw / 0.35).clamp(0.0, 1.0),
        cast_rb: mean_r - mean_b,
        cast_gm: mean_g - 0.5 * (mean_r + mean_b),
        corner_ratio: if center_pixels > 0.0 && center_luma > 1.0e-6 {
            (corner_luma / corner_pixels) / (center_luma / center_pixels)
        } else {
            1.0
        },
        noise: iso.map(iso_noise).unwrap_or(0.0),
        iso,
    }
}

/// Decodes a JPEG/PNG thumbnail and analyses it. Results are cached by path and
/// modification time, so repeated applies over the same selection are free.
pub fn analyze_thumbnail_cached(path: &Path, iso: Option<u32>) -> Option<Arc<PhotoStats>> {
    static CACHE: OnceLock<Mutex<HashMap<PathBuf, (u64, Arc<PhotoStats>)>>> = OnceLock::new();

    let modified = std::fs::metadata(path)
        .ok()
        .and_then(|meta| meta.modified().ok())
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_secs())
        .unwrap_or(0);

    let cache = CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    if let Some((cached_modified, stats)) = cache.lock().unwrap().get(path)
        && *cached_modified == modified
    {
        return Some(stats.clone());
    }

    let image = image::open(path).ok()?;
    let stats = Arc::new(analyze_image(&image, iso));
    cache
        .lock()
        .unwrap()
        .insert(path.to_path_buf(), (modified, stats.clone()));
    Some(stats)
}

/// Wide "usable exposure" quality: a dark concert frame is fine, a frame with
/// crushed shadows or blown highlights is not. 0..1, higher is better.
pub fn exposure_quality(stats: &PhotoStats) -> f64 {
    let median = stats.luma_median;
    let under = if median < 0.12 {
        (0.12 - median) / 0.12
    } else {
        0.0
    };
    let over = if median > 0.72 {
        (median - 0.72) / 0.28
    } else {
        0.0
    };
    let band = 1.0 - under.max(over).clamp(0.0, 1.0);

    let clip_penalty = (stats.shadow_clip * 4.0 + stats.highlight_clip * 4.0).clamp(0.0, 0.85);

    (0.65 * band + 0.35 * (1.0 - clip_penalty)).clamp(0.0, 1.0)
}

/// Colour quality used by culling. Rewards images that carry real colour while
/// staying kind to intentionally monochrome or moody frames.
pub fn color_quality(stats: &PhotoStats) -> f64 {
    let richness = stats.colorfulness.clamp(0.0, 1.0);
    let balance = 1.0 - ((stats.saturation - 0.35).abs() / 0.65).min(1.0) * 0.5;
    (0.4 + 0.4 * richness + 0.2 * balance).clamp(0.0, 1.0)
}

/// Mild quality penalty for very high ISO frames (noise eats detail).
pub fn noise_penalty(stats: &PhotoStats) -> f64 {
    match stats.iso.unwrap_or(0) {
        iso if iso >= 12800 => 0.18,
        iso if iso >= 6400 => 0.14,
        iso if iso >= 3200 => 0.10,
        iso if iso >= 1600 => 0.05,
        _ => 0.0,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{Rgb, RgbImage};

    fn solid(value: u8, width: u32, height: u32) -> RgbImage {
        RgbImage::from_pixel(width, height, Rgb([value, value, value]))
    }

    #[test]
    fn mid_grey_is_neutral_and_colourless() {
        let stats = analyze_rgb(&solid(128, 64, 64), Some(100));
        assert!((stats.luma_median - 0.5).abs() < 0.03, "{stats:?}");
        assert!(stats.saturation < 0.01);
        assert!(stats.colorfulness < 0.01);
        assert!(stats.shadow_clip < 0.01);
        assert!(stats.highlight_clip < 0.01);
        assert!((stats.cast_rb).abs() < 0.01);
    }

    #[test]
    fn clipping_is_detected() {
        let black = analyze_rgb(&solid(0, 64, 64), None);
        assert!(black.shadow_clip > 0.95);
        assert!(exposure_quality(&black) < 0.5);

        let white = analyze_rgb(&solid(255, 64, 64), None);
        assert!(white.highlight_clip > 0.95);
        assert!(exposure_quality(&white) < 0.5);
    }

    #[test]
    fn well_exposed_scores_higher_than_underexposed() {
        let good = analyze_rgb(&solid(110, 64, 64), None);
        let dark = analyze_rgb(&solid(20, 64, 64), None);
        assert!(exposure_quality(&good) > exposure_quality(&dark));
    }

    #[test]
    fn colour_and_cast_are_measured() {
        let mut image = RgbImage::new(64, 64);
        for (x, _y, pixel) in image.enumerate_pixels_mut() {
            if x % 3 == 0 {
                *pixel = Rgb([220, 40, 40]);
            } else if x % 3 == 1 {
                *pixel = Rgb([40, 200, 60]);
            } else {
                *pixel = Rgb([40, 60, 220]);
            }
        }
        let stats = analyze_rgb(&image, Some(3200));
        assert!(stats.saturation > 0.5);
        assert!(stats.colorfulness > 0.5);
        assert!(stats.noise > 0.3);

        let warm = analyze_rgb(&RgbImage::from_pixel(32, 32, Rgb([200, 120, 80])), None);
        assert!(warm.cast_rb > 0.1);
    }

    #[test]
    fn float_images_are_analysed_in_display_space() {
        // Regression: `DynamicImage::thumbnail` on an Rgba32F image (what the RAW
        // pipeline produces) used to turn a 0.5 grey frame into pure white, which
        // collapsed every culling score to the same constant.
        let mut float = image::Rgba32FImage::new(640, 640);
        for pixel in float.pixels_mut() {
            *pixel = image::Rgba([0.5, 0.5, 0.5, 1.0]);
        }
        let stats = analyze_image(&DynamicImage::ImageRgba32F(float), None);
        assert!(
            (stats.luma_median - 0.5).abs() < 0.05,
            "float frame read as {:.2} instead of ~0.50",
            stats.luma_median
        );
        assert!(stats.highlight_clip < 0.01);
        assert!(stats.contrast < 0.01);
    }

    #[test]
    fn high_iso_increases_noise() {
        let low = analyze_rgb(&solid(128, 16, 16), Some(100));
        let high = analyze_rgb(&solid(128, 16, 16), Some(12800));
        assert!(high.noise > low.noise);
        assert!(noise_penalty(&high) > noise_penalty(&low));
    }
}
