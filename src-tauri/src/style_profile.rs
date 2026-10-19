//! Content-aware style profiles.
//!
//! A `StyleProfile` is a reusable "look" (a partial adjustments JSON, optionally
//! a LUT) plus the content tags that should trigger it. Profiles can be:
//!
//! * built-in (shipped with the app, matched against CLIP tags such as
//!   `concert` / `metal concert` / `stage lighting`),
//! * authored by the user (saved to `style_profiles.json`),
//! * *learned* from a set of already-edited images (their `.rrdata` sidecars),
//!   which is how a photographer captures a band-specific or personal look.
//!
//! Matching uses the same CLIP tags the background indexer writes into the
//! sidecar, so no extra inference is needed. Applying a profile reuses the
//! existing `apply_adjustments_to_paths` pipeline (merge + thumbnail refresh).

use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use rayon::prelude::*;
use tauri::{AppHandle, Manager};

use crate::file_management::{apply_adjustments_to_paths, parse_virtual_path};

/// Values that are pure "look" scalars and have a neutral (0) default, so they
/// can be scaled by intensity and averaged when learning a profile.
const SCALAR_LOOK_KEYS: &[&str] = &[
    "exposure",
    "brightness",
    "contrast",
    "highlights",
    "shadows",
    "whites",
    "blacks",
    "clarity",
    "dehaze",
    "vibrance",
    "saturation",
    "structure",
    "sharpness",
    "grainAmount",
    "vignetteAmount",
    "temperature",
    "tint",
    "hue",
    "colorNoiseReduction",
    "lumaNoiseReduction",
    "flareAmount",
    "glowAmount",
    "halationAmount",
];

/// Groups whose numeric leaves all default to 0 and can be scaled/averaged.
/// (Individual leaves that should not be scaled are skipped below.)
const NESTED_LOOK_GROUPS: &[&str] = &["hsl", "colorGrading", "colorCalibration"];

/// Nested leaves that are positions/tuning rather than amounts and must not be
/// scaled by intensity.
const NESTED_UNSCALED_LEAVES: &[&str] = &["blending", "split1", "split2", "split3"];

const CURVE_GROUPS: &[&str] = &["curves", "pointCurves"];
const CURVE_CHANNELS: &[&str] = &["luma", "red", "green", "blue"];

/// x positions (0..255) at which learned curves are sampled and averaged.
const CURVE_GRID: [u8; 9] = [0, 32, 64, 96, 128, 160, 192, 224, 255];

// ---------------------------------------------------------------------------
// Data model
// ---------------------------------------------------------------------------

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct StyleProfileLut {
    pub name: String,
    pub path: String,
    pub is_built_in: bool,
    #[serde(default = "default_intensity")]
    pub intensity: f64,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct StyleProfile {
    pub id: String,
    pub name: String,
    /// Content tags that make this profile a candidate for an image.
    #[serde(default)]
    pub detect_tags: Vec<String>,
    /// Optional artist/subject this look belongs to (e.g. "Iron Maiden").
    #[serde(default)]
    pub subject: Option<String>,
    /// Partial adjustments overlaid onto the image when applied.
    pub adjustments: Value,
    #[serde(default)]
    pub lut: Option<StyleProfileLut>,
    #[serde(default = "default_intensity")]
    pub intensity: f64,
    /// Built-in profiles cannot be overwritten or deleted.
    #[serde(default)]
    pub built_in: bool,
    #[serde(default)]
    pub description: Option<String>,
}

fn default_intensity() -> f64 {
    100.0
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct StyleMatch {
    pub path: String,
    pub profile_id: String,
    pub profile_name: String,
    pub score: f64,
    pub matched_tags: Vec<String>,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProfileUsage {
    pub profile_id: String,
    pub profile_name: String,
    pub count: usize,
}

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct AutoStyleSummary {
    pub applied: usize,
    pub skipped: Vec<String>,
    pub by_profile: Vec<ProfileUsage>,
}

// ---------------------------------------------------------------------------
// Built-in profiles
// ---------------------------------------------------------------------------

fn full_hsl(values: [f64; 8]) -> Value {
    // hue, saturation, luminance per channel; built-ins keep hue/luminance at 0
    // except where noted, so the look is mostly a saturation shift.
    let names = [
        "reds", "oranges", "yellows", "greens", "aquas", "blues", "purples", "magentas",
    ];
    let mut map = Map::new();
    for (i, name) in names.iter().enumerate() {
        map.insert(
            (*name).to_string(),
            json!({ "hue": 0.0, "saturation": values[i], "luminance": 0.0 }),
        );
    }
    Value::Object(map)
}

fn color_grading(shadows_hue: f64, shadows_sat: f64, high_hue: f64, high_sat: f64) -> Value {
    json!({
        "balance": 0.0,
        "blending": 50.0,
        "global": { "hue": 0.0, "saturation": 0.0, "luminance": 0.0 },
        "highlights": { "hue": high_hue, "saturation": high_sat, "luminance": 0.0 },
        "midtones": { "hue": 0.0, "saturation": 0.0, "luminance": 0.0 },
        "shadows": { "hue": shadows_hue, "saturation": shadows_sat, "luminance": 0.0 }
    })
}

/// Genre-based starter looks, matched against CLIP content tags. They are
/// deliberately moderate; the real "band look" comes from learning a profile
/// from the photographer's own edits (see `derive_style_profile_from_paths`).
pub fn builtin_style_profiles() -> Vec<StyleProfile> {
    vec![
        StyleProfile {
            id: "builtin-concert-dark".to_string(),
            name: "Concert — Dark & Punchy".to_string(),
            detect_tags: [
                "concert",
                "live music",
                "live concert",
                "metal concert",
                "rock concert",
                "stage",
                "stage lighting",
                "stage lights",
                "spotlight",
                "smoke machine",
                "laser lights",
                "musician",
                "band",
                "guitarist",
                "singer",
                "drummer",
                "headbanging",
                "mosh pit",
            ]
            .iter()
            .map(|s| s.to_string())
            .collect(),
            subject: None,
            adjustments: json!({
                "contrast": 14.0,
                "highlights": -12.0,
                "shadows": 8.0,
                "blacks": -10.0,
                "clarity": 12.0,
                "dehaze": 8.0,
                "vibrance": 10.0,
                "saturation": -4.0,
                "hsl": full_hsl([6.0, 8.0, 0.0, -6.0, -4.0, 6.0, 4.0, 4.0]),
                "colorGrading": color_grading(220.0, 16.0, 35.0, 10.0),
                "vignetteAmount": -18.0,
                "grainAmount": 6.0
            }),
            lut: None,
            intensity: 100.0,
            built_in: true,
            description: Some(
                "Dark, high-contrast stage look with cool shadows and warm highlights."
                    .to_string(),
            ),
        },
        StyleProfile {
            id: "builtin-concert-warm".to_string(),
            name: "Concert — Warm Stage".to_string(),
            detect_tags: [
                "concert",
                "live music",
                "acoustic concert",
                "musician",
                "singer",
                "saxophone",
                "piano",
                "acoustic guitar",
                "audience",
                "backlighting",
            ]
            .iter()
            .map(|s| s.to_string())
            .collect(),
            subject: None,
            adjustments: json!({
                "contrast": 8.0,
                "highlights": -8.0,
                "shadows": 12.0,
                "blacks": -4.0,
                "clarity": 6.0,
                "vibrance": 8.0,
                "saturation": 2.0,
                "temperature": 8.0,
                "hsl": full_hsl([4.0, 10.0, 6.0, -4.0, -4.0, -6.0, 2.0, 2.0]),
                "colorGrading": color_grading(30.0, 14.0, 45.0, 12.0),
                "vignetteAmount": -10.0,
                "grainAmount": 4.0
            }),
            lut: None,
            intensity: 100.0,
            built_in: true,
            description: Some(
                "Warm, soft stage-light look that flatters skin and wood tones.".to_string(),
            ),
        },
        StyleProfile {
            id: "builtin-festival-pop".to_string(),
            name: "Festival — Bright & Vivid".to_string(),
            detect_tags: [
                "festival",
                "festival crowd",
                "concert",
                "music",
                "neon",
                "colorful",
                "crowd",
                "light show",
                "confetti",
                "pyrotechnics",
            ]
            .iter()
            .map(|s| s.to_string())
            .collect(),
            subject: None,
            adjustments: json!({
                "contrast": 6.0,
                "highlights": -6.0,
                "shadows": 16.0,
                "whites": 6.0,
                "clarity": 4.0,
                "vibrance": 18.0,
                "saturation": 6.0,
                "hsl": full_hsl([6.0, 8.0, 8.0, 8.0, 6.0, 10.0, 8.0, 6.0]),
                "colorGrading": color_grading(200.0, 8.0, 55.0, 8.0)
            }),
            lut: None,
            intensity: 100.0,
            built_in: true,
            description: Some(
                "Bright, vivid festival look with lifted shadows and strong vibrance.".to_string(),
            ),
        },
    ]
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

fn profiles_path(app_handle: &AppHandle) -> Result<PathBuf, String> {
    let dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("style_profiles");

    if !dir.exists() {
        fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    }

    Ok(dir.join("style_profiles.json"))
}

fn load_user_style_profiles(app_handle: &AppHandle) -> Vec<StyleProfile> {
    let Ok(path) = profiles_path(app_handle) else {
        return Vec::new();
    };
    let Ok(content) = fs::read_to_string(path) else {
        return Vec::new();
    };
    serde_json::from_str::<Vec<StyleProfile>>(&content).unwrap_or_default()
}

fn save_user_style_profiles(
    profiles: &[StyleProfile],
    app_handle: &AppHandle,
) -> Result<(), String> {
    let path = profiles_path(app_handle)?;
    let json_string = serde_json::to_string_pretty(profiles).map_err(|e| e.to_string())?;
    fs::write(path, json_string).map_err(|e| e.to_string())
}

fn all_style_profiles(app_handle: &AppHandle) -> Vec<StyleProfile> {
    let mut profiles = builtin_style_profiles();
    profiles.extend(load_user_style_profiles(app_handle));
    profiles
}

// ---------------------------------------------------------------------------
// Applying a profile
// ---------------------------------------------------------------------------

/// Recursively scales the numeric leaves of an adjustments object by `fraction`
/// (0..1), leaving geometry, booleans and tuning keys untouched.
fn scale_look_adjustments(adjustments: &mut Value, fraction: f64) {
    let Some(obj) = adjustments.as_object_mut() else {
        return;
    };

    let keys: Vec<String> = obj.keys().cloned().collect();
    for key in keys {
        if SCALAR_LOOK_KEYS.contains(&key.as_str()) {
            if let Some(num) = obj.get(&key).and_then(Value::as_f64) {
                obj.insert(key, json!((num * fraction * 100.0).round() / 100.0));
            }
        } else if NESTED_LOOK_GROUPS.contains(&key.as_str()) {
            if let Some(group) = obj.get_mut(&key) {
                scale_nested_numbers(group, fraction);
            }
        } else if CURVE_GROUPS.contains(&key.as_str()) {
            if let Some(group) = obj.get_mut(&key) {
                scale_curves(group, fraction);
            }
        }
    }
}

fn scale_nested_numbers(group: &mut Value, fraction: f64) {
    let Some(map) = group.as_object_mut() else {
        return;
    };
    for (leaf_key, leaf) in map.iter_mut() {
        if let Some(inner) = leaf.as_object_mut() {
            for (k, v) in inner.iter_mut() {
                if NESTED_UNSCALED_LEAVES.contains(&k.as_str()) {
                    continue;
                }
                if let Some(num) = v.as_f64() {
                    *v = json!((num * fraction * 100.0).round() / 100.0);
                }
            }
        } else if !NESTED_UNSCALED_LEAVES.contains(&leaf_key.as_str()) {
            if let Some(num) = leaf.as_f64() {
                *leaf = json!((num * fraction * 100.0).round() / 100.0);
            }
        }
    }
}

fn scale_curves(group: &mut Value, fraction: f64) {
    let Some(map) = group.as_object_mut() else {
        return;
    };
    for channel in CURVE_CHANNELS {
        let Some(points) = map.get_mut(*channel).and_then(Value::as_array_mut) else {
            continue;
        };
        for point in points.iter_mut() {
            if let Some(p) = point.as_object_mut() {
                if let (Some(x), Some(y)) = (p.get("x").and_then(Value::as_f64), p.get("y").and_then(Value::as_f64)) {
                    // Blend the curve toward the identity line y = x.
                    let new_y = x + (y - x) * fraction;
                    p.insert("y".to_string(), json!((new_y * 100.0).round() / 100.0));
                }
            }
        }
    }
}

/// Builds the final adjustments object for applying `profile` at `intensity`
/// (0..100), including any LUT reference.
pub fn profile_to_adjustments(profile: &StyleProfile, intensity: Option<f64>) -> Value {
    let mut adjustments = profile.adjustments.clone();
    if !adjustments.is_object() {
        adjustments = json!({});
    }

    let intensity = intensity.unwrap_or(profile.intensity).clamp(0.0, 100.0);
    if intensity < 100.0 {
        scale_look_adjustments(&mut adjustments, intensity / 100.0);
    }

    if let Some(lut) = &profile.lut {
        if let Some(obj) = adjustments.as_object_mut() {
            obj.insert("lutPath".to_string(), json!(lut.path));
            obj.insert("lutName".to_string(), json!(lut.name));
            obj.insert("lutIsSceneReferred".to_string(), json!(lut.is_built_in));
            obj.insert(
                "lutIntensity".to_string(),
                json!(lut.intensity.clamp(0.0, 100.0)),
            );
            let active = obj
                .entry("activeTools".to_string())
                .or_insert_with(|| json!({}));
            if let Some(active_obj) = active.as_object_mut() {
                active_obj.insert("lut".to_string(), json!(true));
            }
        }
    }

    adjustments
}

// ---------------------------------------------------------------------------
// Matching content tags to profiles
// ---------------------------------------------------------------------------

fn normalize_tag(tag: &str) -> String {
    tag.trim().to_ascii_lowercase()
}

/// Canonical tag used to mark images as belonging to an artist/subject. This is
/// how a band is propagated across an event: tag the event once, then a learned
/// profile with that subject matches those images automatically.
pub fn artist_tag(artist: &str) -> String {
    let slug = artist
        .split_whitespace()
        .collect::<Vec<_>>()
        .join("-")
        .to_ascii_lowercase();
    format!("user:artist:{}", slug)
}

/// Fraction of a profile's `detect_tags` present in the image tags (0..1),
/// together with the tags that matched. A profile without `detect_tags` never
/// matches automatically (score 0) and is only used as an explicit fallback.
///
/// If the profile has a `subject` and the image carries that artist tag, the
/// match is a hard 1.0 — this is what makes "this is the Iron Maiden event"
/// reliable without any entity-recognition model.
fn match_score(image_tags: &[String], profile: &StyleProfile) -> (f64, Vec<String>) {
    let normalized: Vec<String> = image_tags.iter().map(|t| normalize_tag(t)).collect();

    if let Some(subject) = &profile.subject {
        if !subject.trim().is_empty() {
            let wanted = artist_tag(subject);
            if normalized.iter().any(|t| *t == wanted) {
                return (1.0, vec![wanted]);
            }
        }
    }

    if profile.detect_tags.is_empty() {
        return (0.0, Vec::new());
    }

    let mut matched = Vec::new();
    for detect in &profile.detect_tags {
        let detect_norm = normalize_tag(detect);
        if normalized.iter().any(|t| *t == detect_norm) {
            matched.push(detect.clone());
        }
    }

    if matched.is_empty() {
        (0.0, Vec::new())
    } else {
        // Bounded denominator: a broad, many-tag profile should not be punished
        // for not matching every tag. One match on a large profile still counts.
        let denom = profile.detect_tags.len().clamp(1, 6) as f64;
        let score = (matched.len() as f64 / denom).min(1.0);
        (score, matched)
    }
}

fn tags_for_path(path: &str) -> Vec<String> {
    let (_, sidecar_path) = parse_virtual_path(path);
    crate::exif_processing::load_sidecar(&sidecar_path)
        .tags
        .unwrap_or_default()
}

fn best_profile_for_tags<'a>(
    image_tags: &[String],
    profiles: &'a [StyleProfile],
    min_score: f64,
) -> Option<(f64, Vec<String>, &'a StyleProfile)> {
    let mut best: Option<(f64, Vec<String>, &StyleProfile)> = None;
    for profile in profiles {
        let (score, matched) = match_score(image_tags, profile);
        if score < min_score || score <= 0.0 {
            continue;
        }
        let better = match &best {
            None => true,
            Some((best_score, best_matched, best_profile)) => {
                if (score - *best_score).abs() < 1e-9 {
                    // On a tie, prefer user profiles over built-ins and, within
                    // the same kind, the profile with more matched tags.
                    (!profile.built_in && best_profile.built_in)
                        || (profile.built_in == best_profile.built_in
                            && matched.len() > best_matched.len())
                } else {
                    score > *best_score
                }
            }
        };
        if better {
            best = Some((score, matched, profile));
        }
    }
    best
}

// ---------------------------------------------------------------------------
// Learning a profile from edited images
// ---------------------------------------------------------------------------

#[derive(Default)]
struct LookStats {
    scalars: BTreeMap<String, (f64, usize)>,
    /// key = "curves.luma" -> (sum per CURVE_GRID cell, sample count)
    curves: BTreeMap<String, (Vec<f64>, usize)>,
}

impl LookStats {
    fn add_scalar(&mut self, key: &str, value: f64) {
        let entry = self.scalars.entry(key.to_string()).or_insert((0.0, 0));
        entry.0 += value;
        entry.1 += 1;
    }

    fn add_curve(&mut self, key: &str, sums: [f64; CURVE_GRID.len()]) {
        let entry = self.curves.entry(key.to_string()).or_insert((
            vec![0.0; CURVE_GRID.len()],
            0,
        ));
        for (i, v) in sums.iter().enumerate() {
            entry.0[i] += v;
        }
        entry.1 += 1;
    }
}

fn sample_curve_y(points: &[Value], x: f64) -> Option<f64> {
    let mut pts: Vec<(f64, f64)> = points
        .iter()
        .filter_map(|p| {
            let x = p.get("x")?.as_f64()?;
            let y = p.get("y")?.as_f64()?;
            Some((x, y))
        })
        .collect();
    if pts.is_empty() {
        return None;
    }
    pts.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));

    if x <= pts[0].0 {
        return Some(pts[0].1);
    }
    if x >= pts[pts.len() - 1].0 {
        return Some(pts[pts.len() - 1].1);
    }
    for pair in pts.windows(2) {
        let (x0, y0) = pair[0];
        let (x1, y1) = pair[1];
        if x >= x0 && x <= x1 {
            if (x1 - x0).abs() < f64::EPSILON {
                return Some(y1);
            }
            let t = (x - x0) / (x1 - x0);
            return Some(y0 + (y1 - y0) * t);
        }
    }
    Some(pts[pts.len() - 1].1)
}

fn collect_look_stats(adjustments: &Value, stats: &mut LookStats) {
    let Some(obj) = adjustments.as_object() else {
        return;
    };

    for key in SCALAR_LOOK_KEYS {
        if let Some(value) = obj.get(*key).and_then(Value::as_f64) {
            stats.add_scalar(key, value);
        }
    }

    for group in NESTED_LOOK_GROUPS {
        if let Some(group_obj) = obj.get(*group).and_then(Value::as_object) {
            for (leaf_key, leaf) in group_obj {
                if NESTED_UNSCALED_LEAVES.contains(&leaf_key.as_str()) {
                    continue;
                }
                if let Some(inner) = leaf.as_object() {
                    for (k, v) in inner {
                        if NESTED_UNSCALED_LEAVES.contains(&k.as_str()) {
                            continue;
                        }
                        if let Some(num) = v.as_f64() {
                            stats.add_scalar(&format!("{}.{}.{}", group, leaf_key, k), num);
                        }
                    }
                } else if let Some(num) = leaf.as_f64() {
                    stats.add_scalar(&format!("{}.{}", group, leaf_key), num);
                }
            }
        }
    }

    for group in CURVE_GROUPS {
        if let Some(group_obj) = obj.get(*group).and_then(Value::as_object) {
            for channel in CURVE_CHANNELS {
                if let Some(points) = group_obj.get(*channel).and_then(Value::as_array) {
                    let mut sums = [0.0f64; CURVE_GRID.len()];
                    let mut any = false;
                    for (i, gx) in CURVE_GRID.iter().enumerate() {
                        if let Some(y) = sample_curve_y(points, *gx as f64) {
                            sums[i] = y;
                            any = true;
                        }
                    }
                    if any {
                        stats.add_curve(&format!("{}.{}", group, channel), sums);
                    }
                }
            }
        }
    }
}

fn build_adjustments_from_stats(stats: &LookStats) -> Value {
    let mut root = Map::new();

    let set_path = |root: &mut Map<String, Value>, key: &str, value: Value| {
        let parts: Vec<&str> = key.split('.').collect();
        if parts.len() == 1 {
            root.insert(parts[0].to_string(), value);
        } else if parts.len() == 2 {
            let group = root
                .entry(parts[0].to_string())
                .or_insert_with(|| Value::Object(Map::new()));
            if let Some(g) = group.as_object_mut() {
                g.insert(parts[1].to_string(), value);
            }
        } else if parts.len() == 3 {
            let group = root
                .entry(parts[0].to_string())
                .or_insert_with(|| Value::Object(Map::new()));
            if let Some(g) = group.as_object_mut() {
                let sub = g
                    .entry(parts[1].to_string())
                    .or_insert_with(|| Value::Object(Map::new()));
                if let Some(s) = sub.as_object_mut() {
                    s.insert(parts[2].to_string(), value);
                }
            }
        }
    };

    for (key, (sum, count)) in &stats.scalars {
        if *count == 0 {
            continue;
        }
        let avg = (sum / *count as f64 * 100.0).round() / 100.0;
        set_path(&mut root, key, json!(avg));
    }

    for (key, (sums, count)) in &stats.curves {
        if *count == 0 {
            continue;
        }
        let points: Vec<Value> = CURVE_GRID
            .iter()
            .enumerate()
            .map(|(i, x)| {
                let avg = (sums[i] / *count as f64 * 100.0).round() / 100.0;
                json!({ "x": *x as f64, "y": avg })
            })
            .collect();
        set_path(&mut root, key, Value::Array(points));
    }

    Value::Object(root)
}

fn collect_detect_tags(paths: &[String], max_tags: usize) -> Vec<String> {
    let mut counts: HashMap<String, usize> = HashMap::new();
    for path in paths {
        for tag in tags_for_path(path) {
            let norm = normalize_tag(&tag);
            if norm.is_empty()
                || norm.starts_with("color:")
                || matches!(
                    norm.as_str(),
                    "black" | "white" | "gray" | "grey" | "color" | "red" | "orange" | "yellow"
                        | "green" | "blue" | "purple" | "pink" | "brown"
                )
            {
                continue;
            }
            *counts.entry(norm).or_insert(0) += 1;
        }
    }

    let mut ranked: Vec<(String, usize)> = counts.into_iter().collect();
    ranked.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
    ranked.into_iter().take(max_tags).map(|(t, _)| t).collect()
}

/// Captures the LUT that most of the source edits used, so a learned profile can
/// reproduce a LUT-based look too. Returns `None` unless a LUT was used by at
/// least half of the images.
fn collect_lut(paths: &[String]) -> Option<StyleProfileLut> {
    let mut counts: HashMap<(String, String, bool), usize> = HashMap::new();
    let mut intensities: HashMap<String, (f64, usize)> = HashMap::new();

    for path in paths {
        let (_, sidecar_path) = parse_virtual_path(path);
        let adjustments = crate::exif_processing::load_sidecar(&sidecar_path).adjustments;
        let Some(lut_path) = adjustments.get("lutPath").and_then(Value::as_str) else {
            continue;
        };
        if lut_path.trim().is_empty() {
            continue;
        }

        let name = adjustments
            .get("lutName")
            .and_then(Value::as_str)
            .unwrap_or(lut_path)
            .to_string();
        let is_built_in = adjustments
            .get("lutIsSceneReferred")
            .and_then(Value::as_bool)
            .unwrap_or(false);

        *counts
            .entry((lut_path.to_string(), name, is_built_in))
            .or_insert(0) += 1;

        let intensity = adjustments
            .get("lutIntensity")
            .and_then(Value::as_f64)
            .unwrap_or(100.0);
        let entry = intensities.entry(lut_path.to_string()).or_insert((0.0, 0));
        entry.0 += intensity;
        entry.1 += 1;
    }

    let ((path, name, is_built_in), count) =
        counts.into_iter().max_by_key(|(_, count)| *count)?;

    if count * 2 < paths.len() {
        return None;
    }

    let (sum, n) = intensities.get(&path).copied().unwrap_or((100.0, 1));
    Some(StyleProfileLut {
        name,
        path,
        is_built_in,
        intensity: if n > 0 { sum / n as f64 } else { 100.0 },
    })
}

/// Derives a profile from a set of already-edited images by averaging the
/// "look" values found in their `.rrdata` sidecars. This is how a personal or
/// band-specific look is captured without any model training.
pub fn derive_profile_from_paths(
    paths: &[String],
    name: &str,
    subject: Option<String>,
) -> StyleProfile {
    let mut stats = LookStats::default();
    for path in paths {
        let (_, sidecar_path) = parse_virtual_path(path);
        let metadata = crate::exif_processing::load_sidecar(&sidecar_path);
        if !metadata.adjustments.is_null() {
            collect_look_stats(&metadata.adjustments, &mut stats);
        }
    }

    let mut detect_tags = collect_detect_tags(paths, 8);
    if let Some(subject) = &subject {
        let tag = artist_tag(subject);
        if tag != "user:artist:" && !detect_tags.iter().any(|t| normalize_tag(t) == tag) {
            detect_tags.insert(0, tag);
        }
    }

    StyleProfile {
        id: uuid::Uuid::new_v4().to_string(),
        name: name.to_string(),
        detect_tags,
        subject,
        adjustments: build_adjustments_from_stats(&stats),
        lut: collect_lut(paths),
        intensity: 100.0,
        built_in: false,
        description: Some(format!("Learned from {} edited image(s).", paths.len())),
    }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn list_style_profiles(app_handle: AppHandle) -> Result<Vec<StyleProfile>, String> {
    Ok(all_style_profiles(&app_handle))
}

#[tauri::command]
pub fn save_style_profile(
    mut profile: StyleProfile,
    app_handle: AppHandle,
) -> Result<Vec<StyleProfile>, String> {
    if profile.built_in {
        return Err("Built-in profiles cannot be modified".to_string());
    }
    if profile.id.trim().is_empty() {
        profile.id = uuid::Uuid::new_v4().to_string();
    }

    let mut user = load_user_style_profiles(&app_handle);
    match user.iter_mut().find(|p| p.id == profile.id) {
        Some(existing) => *existing = profile,
        None => user.push(profile),
    }
    save_user_style_profiles(&user, &app_handle)?;
    Ok(all_style_profiles(&app_handle))
}

#[tauri::command]
pub fn delete_style_profile(
    id: String,
    app_handle: AppHandle,
) -> Result<Vec<StyleProfile>, String> {
    let mut user = load_user_style_profiles(&app_handle);
    user.retain(|p| p.id != id);
    save_user_style_profiles(&user, &app_handle)?;
    Ok(all_style_profiles(&app_handle))
}

#[tauri::command]
pub fn derive_style_profile_from_paths(
    paths: Vec<String>,
    name: String,
    subject: Option<String>,
) -> Result<StyleProfile, String> {
    if paths.is_empty() {
        return Err("Select at least one edited image to learn from".to_string());
    }
    let profile = derive_profile_from_paths(&paths, &name, subject);
    let has_look = profile
        .adjustments
        .as_object()
        .map(|obj| !obj.is_empty())
        .unwrap_or(false);
    if !has_look && profile.lut.is_none() {
        return Err(
            "None of the selected images has saved edits to learn from. Edit a few photos first."
                .to_string(),
        );
    }
    Ok(profile)
}

/// Marks images as belonging to an artist/subject (e.g. "Iron Maiden"). The tag
/// is written into their sidecars and then makes subject-bound profiles match
/// those images with a perfect score.
#[tauri::command]
pub fn assign_artist_to_paths(
    paths: Vec<String>,
    artist: String,
    app_handle: AppHandle,
) -> Result<String, String> {
    let tag = artist_tag(&artist);
    if tag == "user:artist:" {
        return Err("Artist name cannot be empty".to_string());
    }
    crate::tagging::add_tag_for_paths(paths, tag.clone(), app_handle)?;
    Ok(tag)
}

#[tauri::command]
pub fn match_style_profiles_for_paths(
    paths: Vec<String>,
    min_score: Option<f64>,
    app_handle: AppHandle,
) -> Result<Vec<StyleMatch>, String> {
    let profiles = all_style_profiles(&app_handle);
    let min_score = min_score.unwrap_or(0.12);

    let matches = paths
        .par_iter()
        .filter_map(|path| {
            let tags = tags_for_path(path);
            let (score, matched, profile) = best_profile_for_tags(&tags, &profiles, min_score)?;
            Some(StyleMatch {
                path: path.clone(),
                profile_id: profile.id.clone(),
                profile_name: profile.name.clone(),
                score,
                matched_tags: matched,
            })
        })
        .collect();

    Ok(matches)
}

#[tauri::command]
pub async fn apply_style_profile_to_paths(
    paths: Vec<String>,
    profile_id: String,
    intensity: Option<f64>,
    app_handle: AppHandle,
) -> Result<(), String> {
    let profile = all_style_profiles(&app_handle)
        .into_iter()
        .find(|p| p.id == profile_id)
        .ok_or_else(|| format!("Style profile '{}' not found", profile_id))?;

    let adjustments = profile_to_adjustments(&profile, intensity);
    apply_adjustments_to_paths(paths, adjustments, app_handle).await
}

/// The fully automatic pass: for every image, pick the best matching profile
/// from its content tags and apply it. Images below `min_score` fall back to
/// `fallback_profile_id` when provided, otherwise they are skipped.
#[tauri::command]
pub async fn auto_style_paths_with_ai(
    paths: Vec<String>,
    min_score: Option<f64>,
    fallback_profile_id: Option<String>,
    intensity: Option<f64>,
    app_handle: AppHandle,
) -> Result<AutoStyleSummary, String> {
    if paths.is_empty() {
        return Ok(AutoStyleSummary::default());
    }

    let profiles = all_style_profiles(&app_handle);
    let min_score = min_score.unwrap_or(0.12);

    // Decide a profile per path (parallel), then group by profile so we can
    // reuse the batched apply pipeline once per look.
    let decisions: Vec<(String, Option<String>, String)> = paths
        .par_iter()
        .map(|path| {
            let tags = tags_for_path(path);
            if let Some((_, _, profile)) = best_profile_for_tags(&tags, &profiles, min_score) {
                (path.clone(), Some(profile.id.clone()), profile.name.clone())
            } else {
                (path.clone(), None, String::new())
            }
        })
        .collect();

    let fallback = fallback_profile_id
        .as_ref()
        .and_then(|id| profiles.iter().find(|p| p.id == *id));

    let mut groups: HashMap<String, Vec<String>> = HashMap::new();
    let mut names: HashMap<String, String> = HashMap::new();
    let mut counts: HashMap<String, usize> = HashMap::new();
    let mut skipped: Vec<String> = Vec::new();

    for (path, profile_id, profile_name) in decisions {
        let chosen = profile_id.or_else(|| fallback.map(|fb| fb.id.clone()));

        match chosen {
            Some(id) => {
                let display_name = if profile_name.is_empty() {
                    profiles
                        .iter()
                        .find(|p| p.id == id)
                        .map(|p| p.name.clone())
                        .unwrap_or_else(|| id.clone())
                } else {
                    profile_name
                };
                names.entry(id.clone()).or_insert(display_name);
                *counts.entry(id.clone()).or_insert(0) += 1;
                groups.entry(id).or_default().push(path);
            }
            None => skipped.push(path),
        }
    }

    for (profile_id, group_paths) in groups {
        let Some(profile) = profiles.iter().find(|p| p.id == profile_id) else {
            continue;
        };
        let adjustments = profile_to_adjustments(profile, intensity);
        apply_adjustments_to_paths(group_paths, adjustments, app_handle.clone()).await?;
    }

    let applied = counts.values().sum();
    let by_profile: Vec<ProfileUsage> = counts
        .into_iter()
        .map(|(profile_id, count)| {
            let profile_name = names
                .get(&profile_id)
                .cloned()
                .unwrap_or_else(|| profile_id.clone());
            ProfileUsage {
                profile_id,
                profile_name,
                count,
            }
        })
        .collect();

    Ok(AutoStyleSummary {
        applied,
        skipped,
        by_profile,
    })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn match_score_counts_shared_tags() {
        let profile = StyleProfile {
            id: "p".into(),
            name: "p".into(),
            detect_tags: vec!["concert".into(), "guitarist".into(), "stage".into()],
            subject: None,
            adjustments: json!({}),
            lut: None,
            intensity: 100.0,
            built_in: false,
            description: None,
        };

        let tags = vec!["Concert".to_string(), "STAGE".to_string(), "crowd".to_string()];
        let (score, matched) = match_score(&tags, &profile);
        assert!((score - 2.0 / 3.0).abs() < 1e-9);
        assert_eq!(matched.len(), 2);

        let no_tags: Vec<String> = vec![];
        assert_eq!(match_score(&no_tags, &profile).0, 0.0);
    }

    #[test]
    fn intensity_scales_scalars_and_flattens_curves() {
        let profile = StyleProfile {
            id: "p".into(),
            name: "p".into(),
            detect_tags: vec![],
            subject: None,
            adjustments: json!({
                "contrast": 20.0,
                "curves": { "luma": [ {"x":0,"y":0}, {"x":255,"y":200} ] },
                "hsl": { "reds": { "saturation": 10.0 } }
            }),
            lut: None,
            intensity: 100.0,
            built_in: false,
            description: None,
        };

        let scaled = profile_to_adjustments(&profile, Some(50.0));
        assert_eq!(scaled["contrast"], json!(10.0));
        assert_eq!(scaled["hsl"]["reds"]["saturation"], json!(5.0));
        // Curve y moves halfway back toward identity: 200 -> 227.5
        let y = scaled["curves"]["luma"][1]["y"].as_f64().unwrap();
        assert!((y - 227.5).abs() < 1e-6);
    }

    #[test]
    fn sample_curve_interpolates() {
        let points = json!([{"x":0,"y":0},{"x":100,"y":50},{"x":255,"y":255}]);
        let arr = points.as_array().unwrap();
        assert!((sample_curve_y(arr, 50.0).unwrap() - 25.0).abs() < 1e-6);
        assert!((sample_curve_y(arr, 200.0).unwrap() - ((50.0 + (255.0 - 50.0) * (100.0 / 155.0)))).abs() < 1e-6);
    }

    #[test]
    fn derived_profile_averages_scalars() {
        let stats = LookStats::default();
        let mut stats = stats;
        stats.add_scalar("contrast", 10.0);
        stats.add_scalar("contrast", 20.0);
        stats.add_curve("curves.luma", [0.0, 32.0, 64.0, 96.0, 128.0, 160.0, 192.0, 224.0, 255.0]);

        let adjustments = build_adjustments_from_stats(&stats);
        assert_eq!(adjustments["contrast"], json!(15.0));
        let curve = adjustments["curves"]["luma"].as_array().unwrap();
        assert_eq!(curve.len(), CURVE_GRID.len());
        assert_eq!(curve[0]["x"], json!(0.0));
    }
}
