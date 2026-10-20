use crate::app_settings::load_settings;
use crate::exif_processing::load_sidecar;
use crate::file_management::parse_virtual_path;
use image::{GenericImageView, GrayImage, imageops};
use image_hasher::{HashAlg, HasherConfig};
use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use tauri::{AppHandle, Emitter};

use crate::image_loader;

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CullingSettings {
    pub similarity_threshold: u32,
    pub blur_threshold: f64,
    pub group_similar: bool,
    pub filter_blurry: bool,
}

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ImageAnalysisResult {
    pub path: String,
    pub quality_score: f64,
    pub ai_score: f64,
    pub semantic_score: f64,
    pub tags: Vec<String>,
    pub sharpness_metric: f64,
    pub center_focus_metric: f64,
    pub exposure_metric: f64,
    pub color_metric: f64,
    pub luma_mean: f64,
    pub luma_median: f64,
    pub shadow_clip: f64,
    pub highlight_clip: f64,
    pub saturation: f64,
    pub colorfulness: f64,
    pub iso: Option<u32>,
    pub width: u32,
    pub height: u32,
}

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CullGroup {
    pub representative: ImageAnalysisResult,
    pub duplicates: Vec<ImageAnalysisResult>,
}

#[derive(Serialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct CullingSuggestions {
    pub similar_groups: Vec<CullGroup>,
    pub blurry_images: Vec<ImageAnalysisResult>,
    pub failed_paths: Vec<String>,
}

#[derive(Serialize, Clone)]
struct CullingProgress {
    current: usize,
    total: usize,
    stage: String,
}

struct ImageAnalysisData {
    hash: image_hasher::ImageHash,
    result: ImageAnalysisResult,
}

const WEIGHT_SHARPNESS: f64 = 0.35;
const WEIGHT_CENTER_FOCUS: f64 = 0.30;
const WEIGHT_EXPOSURE: f64 = 0.25;
const WEIGHT_COLOR: f64 = 0.10;

// How much the AI/CLIP semantic score (from the `.rrdata` sidecar tags that the
// background indexer already wrote) contributes to the final `ai_score`, versus
// the classical quality score. When an image has no meaningful tags, `ai_score`
// falls back to the pure quality score so nothing is distorted.
const WEIGHT_AI_SEMANTIC: f64 = 0.40;
const SEMANTIC_NEUTRAL: f64 = 0.5;
// Summed tag signal is squashed with `tanh(sum / SEMANTIC_SQUASH_SCALE)`. A plain
// clamped sum saturates at 1.0 as soon as a frame has a handful of strong concert
// tags, which makes every good frame read `1.00` and destroys the ranking inside a
// burst. `tanh` compresses the top end without ever quite reaching 1.0.
const SEMANTIC_SQUASH_SCALE: f64 = 0.5;

/// How many of the image's sidecar tags to surface to the UI per image.
const MAX_REPORTED_TAGS: usize = 8;

/// Per-tag contribution to the semantic score. Positive tags are things a
/// photographer would consider "this is a keeper" for event/music work; the
/// negative ones are visual defects. Returns `0.0` for tags we don't care about
/// (e.g. plain color tags), so the caller can tell "no signal" from "neutral".
fn tag_semantic_delta(tag: &str) -> f64 {
    match tag.trim().to_ascii_lowercase().as_str() {
        // Scene: clearly a live-music/event frame.
        "concert" | "live music" | "live concert" | "music" | "festival" | "performance"
        | "gig" | "stage" | "rock concert" | "metal concert" | "acoustic concert"
        | "open air concert" | "arena concert" | "club concert" | "stadium concert"
        | "rehearsal" | "encore" => 0.14,
        // The subject: a performer in frame.
        "musician" | "band" | "rock band" | "guitarist" | "singer" | "vocalist" | "drummer"
        | "bassist" | "performer" | "dj" => 0.12,
        // Instruments / gear: strong signal of the music subject.
        "guitar" | "electric guitar" | "bass guitar" | "acoustic guitar" | "drums" | "piano"
        | "violin" | "saxophone" | "trumpet" | "keyboard" | "microphone" | "microphone stand"
        | "in-ear monitor" | "monitor speaker" | "soundboard" | "mixing console" | "turntable" => {
            0.09
        }
        // Staging / crowd.
        "crowd" | "audience" | "festival crowd" | "stage lighting" | "stage lights"
        | "spotlight" | "laser lights" | "light show" | "smoke machine" | "haze"
        | "pyrotechnics" | "confetti" | "mosh pit" | "crowd surfing" => 0.07,
        // A person is present (portrait-ish candidates).
        "portrait" | "face" | "person" | "people" | "man" | "woman" | "smile" | "group"
        | "candid" | "headbanging" => 0.06,
        // Mood / energy that reads well.
        "dramatic" | "intense" | "epic" | "powerful" | "energetic" | "majestic" | "mysterious" => {
            0.06
        }
        "neon" | "vibrant" | "colorful" | "backlighting" | "low-key" | "silhouette"
        | "high-key" | "bokeh" => 0.04,
        // Composition and craft signals. CLIP is softer on these abstractions,
        // so they only nudge the score.
        "rule of thirds" | "leading lines" | "framing" | "symmetry" | "composition"
        | "reflection" | "depth of field" | "minimalist" | "wide angle" | "telephoto" => 0.05,
        // Flattering light.
        "golden hour" | "sunset" | "sunrise" | "soft light" | "natural light" | "blue hour"
        | "dawn" | "dusk" => 0.04,
        // Visible defects.
        "motion blur" | "blurry" | "blur" | "out of focus" | "noise" | "underexposed"
        | "overexposed" | "empty" => -0.14,
        _ => 0.0,
    }
}

/// Computes the semantic score in `0.0..=1.0` from an image's tags and returns
/// it together with the subset of tags that actually carried signal (used for
/// the UI and to pick the best frame inside a burst).
fn calculate_semantic_score(tags: &[String]) -> (f64, Vec<String>) {
    let mut raw = 0.0;
    let mut meaningful: Vec<String> = Vec::new();

    for tag in tags {
        let delta = tag_semantic_delta(tag);
        if delta != 0.0 {
            raw += delta;
            meaningful.push(tag.clone());
        }
    }

    let score = (SEMANTIC_NEUTRAL
        + (1.0 - SEMANTIC_NEUTRAL) * (raw / SEMANTIC_SQUASH_SCALE).tanh())
    .clamp(0.0, 1.0);

    (score, meaningful)
}

/// Blends the classical quality score with the semantic score. When there are no
/// meaningful tags the semantic layer is skipped entirely (`ai_score == quality`).
fn combine_ai_score(quality_score: f64, semantic_score: f64, has_semantic_signal: bool) -> f64 {
    if has_semantic_signal {
        (quality_score * (1.0 - WEIGHT_AI_SEMANTIC) + semantic_score * WEIGHT_AI_SEMANTIC)
            .clamp(0.0, 1.0)
    } else {
        quality_score.clamp(0.0, 1.0)
    }
}

fn calculate_laplacian_variance(image: &GrayImage) -> f64 {
    let (width, height) = image.dimensions();
    if width < 3 || height < 3 {
        return 0.0;
    }

    let mut laplacian_values = Vec::with_capacity(((width - 2) * (height - 2)) as usize);
    let mut sum = 0.0;

    for y in 1..height - 1 {
        for x in 1..width - 1 {
            let p_center = image.get_pixel(x, y)[0] as i32;
            let p_north = image.get_pixel(x, y - 1)[0] as i32;
            let p_south = image.get_pixel(x, y + 1)[0] as i32;
            let p_west = image.get_pixel(x - 1, y)[0] as i32;
            let p_east = image.get_pixel(x + 1, y)[0] as i32;
            let conv_val = (p_north + p_south + p_west + p_east - 4 * p_center) as f64;
            laplacian_values.push(conv_val);
            sum += conv_val;
        }
    }

    if laplacian_values.is_empty() {
        return 0.0;
    }
    let mean = sum / laplacian_values.len() as f64;

    laplacian_values
        .iter()
        .map(|v| (v - mean).powi(2))
        .sum::<f64>()
        / laplacian_values.len() as f64
}

fn analyze_image(
    path: &str,
    hasher: &image_hasher::Hasher,
    settings: &crate::app_settings::AppSettings,
) -> Result<ImageAnalysisData, String> {
    const ANALYSIS_DIM: u32 = 720; // FIXME: How should we calculate good focus if it's downscaled?!?

    if crate::file_management::is_cloud_placeholder(Path::new(path)) {
        return Err(format!("'{}' is stored in iCloud and not downloaded", path));
    }

    let file_bytes = std::fs::read(path).map_err(|e| e.to_string())?;

    let img = image_loader::load_base_image_from_bytes(&file_bytes, path, true, settings, None)
        .map_err(|e| e.to_string())?;

    let (width, height) = img.dimensions();
    let thumbnail = img.thumbnail(ANALYSIS_DIM, ANALYSIS_DIM);
    let gray_thumbnail = thumbnail.to_luma8();

    // Brightness, clipping, saturation, colourfulness and cast are measured on
    // the *display-referred* image, not the linear RAW base: the base is flat
    // (median ~0.5, saturation ~0.04) and would make every frame look identical.
    // The camera's embedded preview is already tone-mapped and, for non-RAW
    // files, the decoded image is. This also keeps the numbers consistent with
    // the 480 px thumbnails AI Style analyses.
    let iso = crate::exif_processing::read_iso(path, &file_bytes);
    let stats_image = crate::image_loader::safe_embedded_preview_fallback(&file_bytes, path)
        .unwrap_or_else(|| thumbnail.clone());
    let stats = crate::photo_analysis::analyze_image(&stats_image, iso);
    let exposure_metric = crate::photo_analysis::exposure_quality(&stats);
    let color_metric = crate::photo_analysis::color_quality(&stats);

    let sharpness_metric = calculate_laplacian_variance(&gray_thumbnail);

    let (thumb_w, thumb_h) = gray_thumbnail.dimensions();
    let center_crop = imageops::crop_imm(
        &gray_thumbnail,
        thumb_w / 4,
        thumb_h / 4,
        thumb_w / 2,
        thumb_h / 2,
    )
    .to_image();
    let center_focus_metric = calculate_laplacian_variance(&center_crop);

    let normalized_sharpness = ((sharpness_metric + 1.0).log10() / 3.5).min(1.0);
    let normalized_center_focus = ((center_focus_metric + 1.0).log10() / 3.5).min(1.0);

    let quality_score = ((normalized_sharpness * WEIGHT_SHARPNESS)
        + (normalized_center_focus * WEIGHT_CENTER_FOCUS)
        + (exposure_metric * WEIGHT_EXPOSURE)
        + (color_metric * WEIGHT_COLOR))
        * (1.0 - crate::photo_analysis::noise_penalty(&stats));

    // Semantic layer: reuse the CLIP tags that the background indexer already
    // wrote into the `.rrdata` sidecar. No extra model inference happens during
    // culling, so this stays as fast as the classical pass.
    let (_, sidecar_path) = parse_virtual_path(path);
    let tags = load_sidecar(&sidecar_path).tags.unwrap_or_default();
    let (semantic_score, meaningful_tags) = calculate_semantic_score(&tags);
    let has_semantic_signal = !meaningful_tags.is_empty();
    let ai_score = combine_ai_score(quality_score, semantic_score, has_semantic_signal);

    let source_tags = if has_semantic_signal {
        &meaningful_tags
    } else {
        &tags
    };
    let reported_tags: Vec<String> = source_tags
        .iter()
        .take(MAX_REPORTED_TAGS)
        .cloned()
        .collect();

    let hash = hasher.hash_image(&thumbnail);

    Ok(ImageAnalysisData {
        hash,
        result: ImageAnalysisResult {
            path: path.to_string(),
            quality_score,
            ai_score,
            semantic_score,
            tags: reported_tags,
            sharpness_metric,
            center_focus_metric,
            exposure_metric,
            color_metric,
            luma_mean: stats.luma_mean,
            luma_median: stats.luma_median,
            shadow_clip: stats.shadow_clip,
            highlight_clip: stats.highlight_clip,
            saturation: stats.saturation,
            colorfulness: stats.colorfulness,
            iso: stats.iso,
            width,
            height,
        },
    })
}

#[tauri::command]
pub async fn cull_images(
    paths: Vec<String>,
    settings: CullingSettings,
    app_handle: AppHandle,
) -> Result<CullingSuggestions, String> {
    if paths.is_empty() {
        return Ok(CullingSuggestions::default());
    }

    let app_settings = load_settings(app_handle.clone()).unwrap_or_default();

    let total_count = paths.len();
    let completed_count = Arc::new(AtomicUsize::new(0));
    log::info!("Culling: analyzing {} images", total_count);
    let _ = app_handle.emit("culling-start", total_count);

    let hasher = HasherConfig::new()
        .hash_alg(HashAlg::DoubleGradient)
        .hash_size(16, 16)
        .to_hasher();

    let analysis_results: Vec<Result<ImageAnalysisData, (String, String)>> = paths
        .par_iter()
        .map(|path| {
            let completed = completed_count.fetch_add(1, Ordering::Relaxed) + 1;
            let _ = app_handle.emit(
                "culling-progress",
                CullingProgress {
                    current: completed,
                    total: total_count,
                    stage: "Analyzing images...".to_string(),
                },
            );

            analyze_image(path, &hasher, &app_settings).map_err(|e| (path.to_string(), e))
        })
        .collect();

    let mut successful_analyses = Vec::new();
    let mut failed_paths = Vec::new();
    for res in analysis_results {
        match res {
            Ok(data) => successful_analyses.push(data),
            Err((path, error)) => {
                eprintln!("Failed to analyze image {}: {}", path, error);
                failed_paths.push(path);
            }
        }
    }

    let _ = app_handle.emit(
        "culling-progress",
        CullingProgress {
            current: total_count,
            total: total_count,
            stage: "Grouping similar images...".to_string(),
        },
    );
    log::info!(
        "Culling: analyzed {} images ({} ok, {} failed), grouping",
        total_count,
        successful_analyses.len(),
        failed_paths.len()
    );

    let mut suggestions = CullingSuggestions {
        failed_paths,
        ..Default::default()
    };
    let mut processed_indices = vec![false; successful_analyses.len()];

    if settings.group_similar {
        for i in 0..successful_analyses.len() {
            if processed_indices[i] {
                continue;
            }

            processed_indices[i] = true;
            let mut current_group_indices = vec![i];

            // Compare every candidate against the seed of this group only. The
            // previous transitive walk (A~B and B~C => group A, B, C) drifts across
            // a long event set and produced 90+ frame "duplicate" groups of frames
            // that do not actually look alike. Seeds still cover the whole set
            // because an ungrouped frame becomes a seed on a later iteration.
            for j in (i + 1)..successful_analyses.len() {
                if processed_indices[j] {
                    continue;
                }

                let dist = successful_analyses[i]
                    .hash
                    .dist(&successful_analyses[j].hash);
                if dist <= settings.similarity_threshold {
                    processed_indices[j] = true;
                    current_group_indices.push(j);
                }
            }

            if current_group_indices.len() > 1 {
                // Pick the keeper of a burst by the combined AI score (classical
                // quality + semantic content), not sharpness alone.
                current_group_indices.sort_by(|&a, &b| {
                    successful_analyses[b]
                        .result
                        .ai_score
                        .partial_cmp(&successful_analyses[a].result.ai_score)
                        .unwrap_or(std::cmp::Ordering::Equal)
                });

                let representative_idx = current_group_indices[0];
                // The keeper is chosen by AI score, so it can differ from the seed.
                // Keep only the frames that are also close to that keeper; the rest
                // are not duplicates of what is being shown as the best image.
                let duplicates: Vec<ImageAnalysisResult> = current_group_indices[1..]
                    .iter()
                    .filter(|&&idx| {
                        successful_analyses[representative_idx]
                            .hash
                            .dist(&successful_analyses[idx].hash)
                            <= settings.similarity_threshold
                    })
                    .map(|&idx| successful_analyses[idx].result.clone())
                    .collect();

                if !duplicates.is_empty() {
                    suggestions.similar_groups.push(CullGroup {
                        representative: successful_analyses[representative_idx].result.clone(),
                        duplicates,
                    });
                }
            }
        }
    }

    // Surface the most promising bursts first (highest AI score on the keeper),
    // so the user reviews the strongest candidates before the long tail.
    suggestions.similar_groups.sort_by(|a, b| {
        b.representative
            .ai_score
            .partial_cmp(&a.representative.ai_score)
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    if settings.filter_blurry {
        for i in 0..successful_analyses.len() {
            if !processed_indices[i] {
                let item = &successful_analyses[i];
                if item.result.sharpness_metric < settings.blur_threshold {
                    suggestions.blurry_images.push(item.result.clone());
                }
            }
        }
        suggestions.blurry_images.sort_by(|a, b| {
            a.sharpness_metric
                .partial_cmp(&b.sharpness_metric)
                .unwrap_or(std::cmp::Ordering::Equal)
        });
    }

    log::info!(
        "Culling: done, {} similar groups ({} duplicates) and {} blurry images",
        suggestions.similar_groups.len(),
        suggestions
            .similar_groups
            .iter()
            .map(|group| group.duplicates.len())
            .sum::<usize>(),
        suggestions.blurry_images.len()
    );

    let _ = app_handle.emit("culling-complete", &suggestions);
    Ok(suggestions)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tags(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| value.to_string()).collect()
    }

    #[test]
    fn semantic_score_does_not_saturate_on_tag_rich_frames() {
        let (score, meaningful) = calculate_semantic_score(&tags(&[
            "concert",
            "musician",
            "guitar",
            "crowd",
            "stage lighting",
            "dramatic",
        ]));

        assert!(meaningful.len() >= 5);
        assert!(score < 0.999, "semantic score saturated at {score}");
        assert!(score > 0.7, "expected a strong score, got {score}");
    }

    #[test]
    fn semantic_score_is_neutral_without_tags() {
        let (score, meaningful) = calculate_semantic_score(&[]);
        assert!(meaningful.is_empty());
        assert!((score - SEMANTIC_NEUTRAL).abs() < 1e-9);
    }

    #[test]
    fn semantic_score_orders_by_tag_strength() {
        let weak = calculate_semantic_score(&tags(&["person"])).0;
        let strong = calculate_semantic_score(&tags(&["concert", "musician"])).0;
        let defective = calculate_semantic_score(&tags(&["blurry"])).0;

        assert!(strong > weak, "{strong} should beat {weak}");
        assert!(weak > defective, "{weak} should beat {defective}");
    }
}

/// Real-library culling smoke test. Needs the local photos, so it is ignored by
/// default:
///
/// ```text
/// cargo test --lib real_culling_scores -- --ignored --nocapture
/// ```
///
/// Only sidecars that already contain EXIF are sampled, so the test never
/// modifies the library (the EXIF persistence path is a no-op for them).
#[cfg(test)]
mod real_photos {
    use super::*;
    use crate::app_settings::AppSettings;
    use crate::image_processing::ImageFlag;
    use std::path::PathBuf;

    fn photos_dir() -> PathBuf {
        std::env::var("RAPIDRAW_PHOTOS_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|_| {
                PathBuf::from(std::env::var("HOME").unwrap_or_default())
                    .join("Pictures/The Catch 22s - BBF - 16.10.2026.")
            })
    }

    fn mean(values: &[f64]) -> f64 {
        if values.is_empty() {
            return f64::NAN;
        }
        values.iter().sum::<f64>() / values.len() as f64
    }

    #[test]
    #[ignore = "needs the local photo library and RAW decoding"]
    fn real_culling_scores() {
        let root = photos_dir();
        if !root.is_dir() {
            eprintln!("skipping: {} missing", root.display());
            return;
        }

        let mut picks: Vec<PathBuf> = Vec::new();
        let mut others: Vec<PathBuf> = Vec::new();
        for entry in walkdir::WalkDir::new(&root)
            .max_depth(2)
            .into_iter()
            .filter_map(Result::ok)
        {
            let sidecar = entry.into_path();
            if !sidecar.to_string_lossy().ends_with(".rrdata") {
                continue;
            }
            let metadata = crate::exif_processing::load_sidecar(&sidecar);
            if metadata.exif.is_none() {
                continue; // avoid touching the user's sidecars
            }
            let raf = PathBuf::from(sidecar.to_string_lossy().trim_end_matches(".rrdata"));
            if !raf.exists() {
                continue;
            }
            match metadata.flag {
                Some(ImageFlag::Pick) => picks.push(raf),
                _ => others.push(raf),
            }
        }
        picks.sort();
        others.sort();

        let take = |paths: &[PathBuf], count: usize| -> Vec<PathBuf> {
            if paths.is_empty() {
                return Vec::new();
            }
            let step = (paths.len() / count.max(1)).max(1);
            paths.iter().step_by(step).take(count).cloned().collect()
        };
        let mut sample = take(&picks, 16);
        sample.extend(take(&others, 16));

        let hasher = HasherConfig::new()
            .hash_alg(HashAlg::Gradient)
            .hash_size(8, 8)
            .to_hasher();
        let settings = AppSettings::default();

        let mut pick_scores = Vec::new();
        let mut other_scores = Vec::new();
        let mut all_scores = Vec::new();
        let mut rows = Vec::new();

        for path in &sample {
            let path_str = path.to_string_lossy();
            match analyze_image(&path_str, &hasher, &settings) {
                Ok(analysis) => {
                    let result = &analysis.result;
                    let is_pick = picks.iter().any(|pick| pick == path);
                    if is_pick {
                        pick_scores.push(result.ai_score);
                    } else {
                        other_scores.push(result.ai_score);
                    }
                    all_scores.push(result.ai_score);
                    rows.push(format!(
                        "  {:<12} {} ai {:.3} q {:.3} exp {:.3} col {:.3} med {:.2} clip {:.3}/{:.3} iso {}",
                        path.file_name().unwrap().to_string_lossy(),
                        if is_pick { "PICK  " } else { "reject" },
                        result.ai_score,
                        result.quality_score,
                        result.exposure_metric,
                        result.color_metric,
                        result.luma_median,
                        result.shadow_clip,
                        result.highlight_clip,
                        result.iso.map(|iso| iso.to_string()).unwrap_or_else(|| "-".into()),
                    ));

                    for value in [
                        result.quality_score,
                        result.ai_score,
                        result.semantic_score,
                        result.exposure_metric,
                        result.color_metric,
                        result.luma_median,
                        result.shadow_clip,
                        result.highlight_clip,
                        result.saturation,
                        result.colorfulness,
                    ] {
                        assert!(
                            value.is_finite(),
                            "non-finite metric for {}",
                            path.display()
                        );
                    }
                    for value in [
                        result.quality_score,
                        result.ai_score,
                        result.semantic_score,
                        result.exposure_metric,
                        result.color_metric,
                    ] {
                        assert!(
                            (0.0..=1.0).contains(&value),
                            "metric out of range for {}: {value}",
                            path.display()
                        );
                    }
                    assert!((0.0..=1.0).contains(&result.luma_median));
                }
                Err(error) => eprintln!("  failed {}: {error}", path.display()),
            }
        }

        for row in &rows {
            println!("{row}");
        }
        println!(
            "\nanalysed {} frames ({} picks, {} others)",
            all_scores.len(),
            pick_scores.len(),
            other_scores.len()
        );
        println!(
            "  ai mean  picks {:.3}  others {:.3}",
            mean(&pick_scores),
            mean(&other_scores)
        );
        let overall = mean(&all_scores);
        let variance = all_scores
            .iter()
            .map(|score| (score - overall).powi(2))
            .sum::<f64>()
            / all_scores.len().max(1) as f64;
        println!("  ai mean  all {:.3}  std {:.3}", overall, variance.sqrt());

        assert!(all_scores.len() >= 10, "not enough frames analysed");
        assert!(
            variance.sqrt() > 0.005,
            "AI scores are suspiciously flat (std {:.4}) — the ranking would be useless",
            variance.sqrt()
        );
    }
}
