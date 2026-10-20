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
use tauri::{AppHandle, Manager};

use crate::file_management::{
    apply_adjustments_to_paths_map, cached_analysis_source, parse_virtual_path,
};
use crate::photo_analysis::{PhotoStats, analyze_thumbnail_cached};

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

const HSL_CHANNELS: [&str; 8] = [
    "reds", "oranges", "yellows", "greens", "aquas", "blues", "purples", "magentas",
];

/// HSL mixer values as `[(hue, saturation, luminance); 8]` for reds..magentas.
/// This is what gives a look its colour identity instead of a blunt global
/// saturation slider.
fn hsl_look(values: [(f64, f64, f64); 8]) -> Value {
    let mut map = Map::new();
    for (i, name) in HSL_CHANNELS.iter().enumerate() {
        let (hue, saturation, luminance) = values[i];
        map.insert(
            (*name).to_string(),
            json!({
                "hue": hue,
                "saturation": saturation,
                "luminance": luminance,
            }),
        );
    }
    Value::Object(map)
}

/// Three-way colour grading: `(hue, saturation, luminance)` per tonal range.
/// Hue is in degrees, saturation/luminance in -100..100.
fn grading(
    shadows: (f64, f64, f64),
    midtones: (f64, f64, f64),
    highlights: (f64, f64, f64),
    balance: f64,
    blending: f64,
) -> Value {
    let leaf = |(hue, saturation, luminance): (f64, f64, f64)| json!({ "hue": hue, "saturation": saturation, "luminance": luminance });
    json!({
        "balance": balance,
        "blending": blending,
        "global": { "hue": 0.0, "saturation": 0.0, "luminance": 0.0 },
        "shadows": leaf(shadows),
        "midtones": leaf(midtones),
        "highlights": leaf(highlights),
    })
}

/// Point curves. A channel left empty is an identity line. X/Y are 0..255.
fn curves(
    luma: &[(f64, f64)],
    red: &[(f64, f64)],
    green: &[(f64, f64)],
    blue: &[(f64, f64)],
) -> Value {
    fn points(points: &[(f64, f64)]) -> Value {
        Value::Array(
            points
                .iter()
                .map(|(x, y)| json!({ "x": x, "y": y }))
                .collect(),
        )
    }
    let identity: &[(f64, f64)] = &[(0.0, 0.0), (255.0, 255.0)];
    json!({
        "luma": points(if luma.is_empty() { identity } else { luma }),
        "red": points(if red.is_empty() { identity } else { red }),
        "green": points(if green.is_empty() { identity } else { green }),
        "blue": points(if blue.is_empty() { identity } else { blue }),
    })
}

/// Reference to one of the film LUTs bundled with the app
/// (`src-tauri/resources/film_luts`). The concrete path is resolved in
/// [`all_style_profiles`] because it depends on the installation directory.
fn film_lut(name: &str, intensity: f64) -> Option<StyleProfileLut> {
    Some(StyleProfileLut {
        name: name.to_string(),
        path: String::new(),
        is_built_in: true,
        intensity: intensity.clamp(0.0, 100.0),
    })
}

fn tag_list(list: &[&str]) -> Vec<String> {
    list.iter().map(|value| (*value).to_string()).collect()
}

/// The bundled film emulations, by exact resource name.
const LUT_FUJI_400H: &str = "F-Pro 400H";
const LUT_EKTAR_100: &str = "K-Ektar 100";
const LUT_GOLD_200: &str = "K-Gold 200";
const LUT_PORTRA_400: &str = "K-Portra 400";
const LUT_VISION_250D: &str = "K-Vision 250D Cinematic";
const LUT_VISION_500T: &str = "K-Vision 500T Cinematic";

/// Genre-based starter looks, matched against CLIP content tags.
///
/// Design rules:
/// * no fixed exposure — photos are already exposed; only small lifts for
///   low-key scenes, and the automatic pass adds tag-aware tweaks on top,
/// * every look combines a bundled film LUT with deliberate grading (HSL
///   mixer + three-way colour grading + a point curve) instead of one blunt
///   slider, so the result reads as a real "filter",
/// * highlights are protected and blacks are deep but not crushed,
/// * concert looks are split into dark/punchy, warm/acoustic, neon/EDM and
///   monochrome so a whole event does not get one identical treatment.
pub fn builtin_style_profiles() -> Vec<StyleProfile> {
    vec![
        StyleProfile {
            id: "builtin-concert-dark".to_string(),
            name: "Concert — Dark & Punchy".to_string(),
            detect_tags: tag_list(&[
                "metal concert",
                "rock concert",
                "rock band",
                "guitarist",
                "bassist",
                "drummer",
                "headbanging",
                "mosh pit",
                "crowd surfing",
                "smoke machine",
                "laser lights",
                "pyrotechnics",
                "concert",
                "live music",
                "live concert",
                "stage",
                "stage lighting",
                "stage lights",
                "spotlight",
                "musician",
                "band",
                "performer",
                "singer",
                "audience",
                "gig",
                "encore",
            ]),
            subject: None,
            adjustments: json!({
                "contrast": 14.0,
                "highlights": -22.0,
                "shadows": -4.0,
                "whites": 6.0,
                "blacks": -14.0,
                "clarity": 10.0,
                "structure": 8.0,
                "dehaze": 6.0,
                "vibrance": 10.0,
                "saturation": -6.0,
                "temperature": -2.0,
                "tint": 2.0,
                "hsl": hsl_look([
                    (-4.0, 14.0, -4.0),
                    (-2.0, 8.0, 0.0),
                    (0.0, -14.0, -6.0),
                    (0.0, -28.0, -10.0),
                    (0.0, -10.0, -4.0),
                    (-4.0, 2.0, -10.0),
                    (0.0, 6.0, 0.0),
                    (0.0, 12.0, 0.0),
                ]),
                "colorGrading": grading(
                    (210.0, 18.0, -2.0),
                    (0.0, 0.0, 0.0),
                    (38.0, 12.0, 0.0),
                    -10.0,
                    55.0,
                ),
                "curves": curves(
                    &[(0.0, 0.0), (28.0, 22.0), (96.0, 100.0), (176.0, 186.0), (255.0, 255.0)],
                    &[],
                    &[],
                    &[(0.0, 8.0), (96.0, 96.0), (255.0, 255.0)],
                ),
                "glowAmount": 4.0,
                "halationAmount": 8.0,
                "vignetteAmount": -26.0,
                "vignetteFeather": 55.0,
                "vignetteMidpoint": 45.0,
                "grainAmount": 8.0,
                "grainRoughness": 55.0,
                "grainSize": 30.0,
            }),
            lut: film_lut(LUT_VISION_500T, 55.0),
            intensity: 100.0,
            built_in: true,
            description: Some(
                "Cinematic tungsten film with deep blacks, cool shadows, warm stage lights and a subtle halation glow. Built for metal and rock shows.".to_string(),
            ),
        },
        StyleProfile {
            id: "builtin-concert-warm".to_string(),
            name: "Concert — Warm Stage".to_string(),
            detect_tags: tag_list(&[
                "acoustic concert",
                "classical concert",
                "club concert",
                "saxophone",
                "piano",
                "violin",
                "trumpet",
                "acoustic guitar",
                "keyboard",
                "vocalist",
                "concert",
                "live music",
                "musician",
                "band",
                "stage",
                "audience",
                "singer",
            ]),
            subject: None,
            adjustments: json!({
                "contrast": 8.0,
                "highlights": -18.0,
                "shadows": 14.0,
                "whites": 4.0,
                "blacks": -6.0,
                "clarity": 2.0,
                "dehaze": 4.0,
                "vibrance": 10.0,
                "temperature": 6.0,
                "tint": 2.0,
                "hsl": hsl_look([
                    (2.0, 8.0, 4.0),
                    (4.0, 12.0, 6.0),
                    (6.0, 8.0, 4.0),
                    (0.0, -10.0, 0.0),
                    (0.0, -6.0, 0.0),
                    (6.0, -8.0, 0.0),
                    (0.0, 4.0, 0.0),
                    (0.0, 4.0, 0.0),
                ]),
                "colorGrading": grading(
                    (30.0, 12.0, 0.0),
                    (35.0, 4.0, 0.0),
                    (45.0, 14.0, 0.0),
                    10.0,
                    50.0,
                ),
                "curves": curves(
                    &[(0.0, 4.0), (64.0, 70.0), (160.0, 178.0), (255.0, 250.0)],
                    &[],
                    &[],
                    &[],
                ),
                "glowAmount": 6.0,
                "vignetteAmount": -14.0,
                "grainAmount": 6.0,
            }),
            lut: film_lut(LUT_GOLD_200, 45.0),
            intensity: 100.0,
            built_in: true,
            description: Some(
                "Warm Kodak Gold film look with creamy skin, amber stage light and a gentle filmic fade. Built for acoustic, jazz and soul sets.".to_string(),
            ),
        },
        StyleProfile {
            id: "builtin-concert-neon".to_string(),
            name: "Concert — Neon / EDM".to_string(),
            detect_tags: tag_list(&[
                "club concert",
                "arena concert",
                "dj",
                "turntable",
                "laser lights",
                "light show",
                "smoke machine",
                "pyrotechnics",
                "confetti",
                "neon",
                "concert",
                "live music",
                "stage",
                "stage lighting",
                "festival",
                "festival crowd",
            ]),
            subject: None,
            adjustments: json!({
                "contrast": 14.0,
                "highlights": -20.0,
                "shadows": 4.0,
                "whites": 4.0,
                "blacks": -12.0,
                "clarity": 8.0,
                "dehaze": 6.0,
                "vibrance": 16.0,
                "saturation": -2.0,
                "temperature": -4.0,
                "tint": 6.0,
                "hsl": hsl_look([
                    (0.0, 10.0, 0.0),
                    (-2.0, -4.0, 0.0),
                    (0.0, -10.0, 0.0),
                    (0.0, -22.0, -6.0),
                    (-6.0, 12.0, 0.0),
                    (-8.0, 18.0, -6.0),
                    (0.0, 18.0, 0.0),
                    (0.0, 22.0, 0.0),
                ]),
                "colorGrading": grading(
                    (220.0, 24.0, 0.0),
                    (270.0, 6.0, 0.0),
                    (300.0, 18.0, 0.0),
                    0.0,
                    55.0,
                ),
                "curves": curves(
                    &[(0.0, 0.0), (32.0, 24.0), (128.0, 136.0), (208.0, 222.0), (255.0, 255.0)],
                    &[],
                    &[],
                    &[(0.0, 12.0), (128.0, 130.0), (255.0, 255.0)],
                ),
                "glowAmount": 8.0,
                "halationAmount": 6.0,
                "vignetteAmount": -18.0,
                "grainAmount": 5.0,
            }),
            lut: film_lut(LUT_VISION_500T, 40.0),
            intensity: 100.0,
            built_in: true,
            description: Some(
                "Cool cinematic base with teal shadows and magenta highlights so lasers and LED walls pop. Built for EDM, club and arena shows.".to_string(),
            ),
        },
        StyleProfile {
            id: "builtin-concert-mono".to_string(),
            name: "Concert — Monochrome".to_string(),
            detect_tags: tag_list(&[
                "monochrome",
                "black and white",
                "silhouette",
                "low-key",
                "dramatic",
                "concert",
                "live music",
                "stage",
                "stage lighting",
                "musician",
                "singer",
                "guitarist",
                "drummer",
            ]),
            subject: None,
            adjustments: json!({
                "saturation": -100.0,
                "contrast": 18.0,
                "highlights": -25.0,
                "shadows": 2.0,
                "whites": 8.0,
                "blacks": -18.0,
                "clarity": 14.0,
                "structure": 10.0,
                "dehaze": 8.0,
                "curves": curves(
                    &[(0.0, 0.0), (32.0, 20.0), (128.0, 138.0), (224.0, 232.0), (255.0, 255.0)],
                    &[],
                    &[],
                    &[],
                ),
                "vignetteAmount": -30.0,
                "grainAmount": 14.0,
                "grainRoughness": 60.0,
                "grainSize": 35.0,
            }),
            lut: None,
            intensity: 100.0,
            built_in: true,
            description: Some(
                "Gritty high-contrast black and white with strong structure and heavy grain. Great when the stage light does the work.".to_string(),
            ),
        },
        StyleProfile {
            id: "builtin-festival-pop".to_string(),
            name: "Festival — Bright & Vivid".to_string(),
            detect_tags: tag_list(&[
                "festival",
                "festival crowd",
                "open air concert",
                "confetti",
                "pyrotechnics",
                "light show",
                "colorful",
                "crowd",
                "concert",
                "live music",
                "music",
                "celebration",
            ]),
            subject: None,
            adjustments: json!({
                "contrast": 6.0,
                "highlights": -12.0,
                "shadows": 18.0,
                "whites": 6.0,
                "blacks": -2.0,
                "clarity": 4.0,
                "vibrance": 20.0,
                "saturation": 4.0,
                "hsl": hsl_look([
                    (0.0, 8.0, 0.0),
                    (0.0, 6.0, 2.0),
                    (-2.0, 10.0, 6.0),
                    (0.0, 6.0, 2.0),
                    (0.0, 8.0, 0.0),
                    (0.0, 12.0, 0.0),
                    (0.0, 10.0, 0.0),
                    (0.0, 10.0, 0.0),
                ]),
                "colorGrading": grading(
                    (200.0, 8.0, 0.0),
                    (0.0, 0.0, 0.0),
                    (55.0, 8.0, 0.0),
                    5.0,
                    50.0,
                ),
                "curves": curves(
                    &[(0.0, 4.0), (64.0, 74.0), (160.0, 172.0), (255.0, 252.0)],
                    &[],
                    &[],
                    &[],
                ),
                "vignetteAmount": -10.0,
                "grainAmount": 3.0,
            }),
            lut: film_lut(LUT_EKTAR_100, 40.0),
            intensity: 100.0,
            built_in: true,
            description: Some(
                "Bright, saturated Kodak Ektar daylight look with lifted shadows. For outdoor festivals, confetti and daylight crowds.".to_string(),
            ),
        },
        StyleProfile {
            id: "builtin-portrait-natural".to_string(),
            name: "Portrait — Natural & Soft".to_string(),
            detect_tags: tag_list(&[
                "portrait",
                "candid",
                "face",
                "smile",
                "person",
                "woman",
                "man",
                "child",
                "couple",
                "family",
                "group",
                "natural light",
                "soft light",
            ]),
            subject: None,
            adjustments: json!({
                "contrast": 3.0,
                "highlights": -12.0,
                "shadows": 10.0,
                "whites": 2.0,
                "clarity": -6.0,
                "structure": -2.0,
                "vibrance": 6.0,
                "saturation": -2.0,
                "temperature": 4.0,
                "tint": 1.0,
                "hsl": hsl_look([
                    (2.0, 2.0, 4.0),
                    (4.0, 4.0, 8.0),
                    (0.0, -4.0, 4.0),
                    (0.0, -6.0, 0.0),
                    (0.0, -2.0, 0.0),
                    (0.0, -2.0, 0.0),
                    (0.0, 0.0, 0.0),
                    (0.0, 0.0, 0.0),
                ]),
                "colorGrading": grading(
                    (25.0, 8.0, 0.0),
                    (30.0, 2.0, 0.0),
                    (45.0, 6.0, 0.0),
                    5.0,
                    50.0,
                ),
                "curves": curves(
                    &[(0.0, 6.0), (64.0, 72.0), (160.0, 170.0), (255.0, 248.0)],
                    &[],
                    &[],
                    &[],
                ),
                "vignetteAmount": -8.0,
                "grainAmount": 3.0,
            }),
            lut: film_lut(LUT_PORTRA_400, 30.0),
            intensity: 100.0,
            built_in: true,
            description: Some(
                "Soft Kodak Portra portrait look: gentle contrast, creamy skin and a filmic highlight roll-off.".to_string(),
            ),
        },
        StyleProfile {
            id: "builtin-wedding-airy".to_string(),
            name: "Wedding — Airy & Bright".to_string(),
            detect_tags: tag_list(&[
                "wedding",
                "couple",
                "celebration",
                "flowers",
                "rose",
                "cake",
                "dancing",
                "portrait",
                "group",
                "romantic",
                "love",
                "soft light",
            ]),
            subject: None,
            adjustments: json!({
                "contrast": -6.0,
                "highlights": -14.0,
                "shadows": 22.0,
                "whites": 10.0,
                "clarity": -6.0,
                "vibrance": 8.0,
                "saturation": -4.0,
                "temperature": 4.0,
                "tint": 2.0,
                "hsl": hsl_look([
                    (-2.0, 0.0, 4.0),
                    (0.0, 4.0, 8.0),
                    (0.0, -6.0, 6.0),
                    (4.0, -14.0, 4.0),
                    (0.0, -6.0, 0.0),
                    (0.0, -6.0, 2.0),
                    (0.0, -2.0, 0.0),
                    (0.0, -2.0, 0.0),
                ]),
                "colorGrading": grading(
                    (25.0, 8.0, 0.0),
                    (35.0, 2.0, 0.0),
                    (50.0, 8.0, 0.0),
                    8.0,
                    50.0,
                ),
                "curves": curves(
                    &[(0.0, 12.0), (64.0, 82.0), (160.0, 176.0), (255.0, 250.0)],
                    &[],
                    &[],
                    &[],
                ),
                "vignetteAmount": -4.0,
                "grainAmount": 2.0,
            }),
            lut: film_lut(LUT_FUJI_400H, 35.0),
            intensity: 100.0,
            built_in: true,
            description: Some(
                "Airy Fuji Pro 400H look with lifted blacks, pastel greens and clean skin. For weddings and bright celebrations.".to_string(),
            ),
        },
        StyleProfile {
            id: "builtin-golden-hour".to_string(),
            name: "Golden Hour — Warm Glow".to_string(),
            detect_tags: tag_list(&[
                "golden hour",
                "sunset",
                "sunrise",
                "dusk",
                "dawn",
                "sun",
                "sunlight",
                "backlighting",
                "warm colors",
                "beach",
                "field",
                "silhouette",
            ]),
            subject: None,
            adjustments: json!({
                "contrast": 6.0,
                "highlights": -18.0,
                "shadows": 14.0,
                "whites": 6.0,
                "blacks": -4.0,
                "clarity": 2.0,
                "dehaze": 4.0,
                "vibrance": 14.0,
                "saturation": 2.0,
                "temperature": 10.0,
                "tint": 3.0,
                "hsl": hsl_look([
                    (-2.0, 8.0, 2.0),
                    (-4.0, 14.0, 6.0),
                    (-4.0, 10.0, 4.0),
                    (6.0, -10.0, 0.0),
                    (0.0, -6.0, 0.0),
                    (0.0, -10.0, 2.0),
                    (0.0, 0.0, 0.0),
                    (0.0, 2.0, 0.0),
                ]),
                "colorGrading": grading(
                    (30.0, 10.0, 0.0),
                    (35.0, 4.0, 0.0),
                    (45.0, 18.0, 0.0),
                    15.0,
                    55.0,
                ),
                "curves": curves(
                    &[(0.0, 4.0), (64.0, 70.0), (160.0, 176.0), (255.0, 252.0)],
                    &[],
                    &[],
                    &[],
                ),
                "glowAmount": 12.0,
                "halationAmount": 4.0,
                "vignetteAmount": -12.0,
                "grainAmount": 3.0,
            }),
            lut: film_lut(LUT_GOLD_200, 45.0),
            intensity: 100.0,
            built_in: true,
            description: Some(
                "Kodak Gold glow with amber highlights and soft halation. For sunset, sunrise and backlit portraits.".to_string(),
            ),
        },
        StyleProfile {
            id: "builtin-landscape-vivid".to_string(),
            name: "Landscape — Vivid Nature".to_string(),
            detect_tags: tag_list(&[
                "landscape",
                "mountain",
                "mountains",
                "valley",
                "canyon",
                "forest",
                "lake",
                "river",
                "waterfall",
                "sky",
                "clouds",
                "field",
                "meadow",
                "coast",
                "beach",
                "nature",
                "reflection",
            ]),
            subject: None,
            adjustments: json!({
                "contrast": 10.0,
                "highlights": -20.0,
                "shadows": 16.0,
                "whites": 6.0,
                "blacks": -8.0,
                "clarity": 10.0,
                "dehaze": 10.0,
                "vibrance": 18.0,
                "saturation": 4.0,
                "sharpness": 10.0,
                "hsl": hsl_look([
                    (0.0, 4.0, 0.0),
                    (0.0, 2.0, 2.0),
                    (-2.0, 8.0, 4.0),
                    (-4.0, 14.0, 6.0),
                    (-6.0, 10.0, 0.0),
                    (-4.0, 14.0, -4.0),
                    (0.0, 4.0, 0.0),
                    (0.0, 0.0, 0.0),
                ]),
                "colorGrading": grading(
                    (210.0, 8.0, 0.0),
                    (0.0, 0.0, 0.0),
                    (45.0, 6.0, 0.0),
                    0.0,
                    50.0,
                ),
                "curves": curves(
                    &[(0.0, 0.0), (40.0, 34.0), (128.0, 132.0), (208.0, 218.0), (255.0, 255.0)],
                    &[],
                    &[],
                    &[],
                ),
                "vignetteAmount": -10.0,
            }),
            lut: film_lut(LUT_EKTAR_100, 35.0),
            intensity: 100.0,
            built_in: true,
            description: Some(
                "Deep greens, rich blues and crisp Kodak Ektar colour with recovered highlights. For landscapes and nature.".to_string(),
            ),
        },
        StyleProfile {
            id: "builtin-night-neon".to_string(),
            name: "Night — Neon & Moody".to_string(),
            detect_tags: tag_list(&[
                "night",
                "night sky",
                "city",
                "cityscape",
                "skyline",
                "urban",
                "street",
                "neon",
                "long exposure",
                "light painting",
                "moon",
                "stars",
            ]),
            subject: None,
            adjustments: json!({
                "contrast": 14.0,
                "highlights": -20.0,
                "shadows": 8.0,
                "whites": 2.0,
                "blacks": -16.0,
                "clarity": 8.0,
                "dehaze": 8.0,
                "vibrance": 16.0,
                "saturation": -2.0,
                "temperature": -6.0,
                "tint": 6.0,
                "hsl": hsl_look([
                    (0.0, 10.0, 0.0),
                    (-2.0, -6.0, 0.0),
                    (0.0, -16.0, -4.0),
                    (0.0, -20.0, -6.0),
                    (-8.0, 16.0, 0.0),
                    (-10.0, 20.0, -8.0),
                    (0.0, 20.0, 0.0),
                    (0.0, 24.0, 0.0),
                ]),
                "colorGrading": grading(
                    (220.0, 24.0, 0.0),
                    (270.0, 6.0, 0.0),
                    (300.0, 18.0, 0.0),
                    0.0,
                    55.0,
                ),
                "curves": curves(
                    &[(0.0, 0.0), (32.0, 22.0), (128.0, 134.0), (208.0, 220.0), (255.0, 255.0)],
                    &[],
                    &[],
                    &[(0.0, 10.0), (128.0, 130.0), (255.0, 255.0)],
                ),
                "glowAmount": 8.0,
                "halationAmount": 8.0,
                "vignetteAmount": -20.0,
                "grainAmount": 8.0,
            }),
            lut: film_lut(LUT_VISION_500T, 50.0),
            intensity: 100.0,
            built_in: true,
            description: Some(
                "Moody night-city look with teal shadows, magenta neon and halation around bright lights.".to_string(),
            ),
        },
        StyleProfile {
            id: "builtin-cinematic".to_string(),
            name: "Cinematic — Teal & Orange".to_string(),
            detect_tags: tag_list(&[
                "city",
                "cityscape",
                "skyline",
                "urban",
                "street",
                "night",
                "car",
                "motorcycle",
                "architecture",
                "neon",
                "reflection",
                "long exposure",
            ]),
            subject: None,
            adjustments: json!({
                "contrast": 12.0,
                "highlights": -20.0,
                "shadows": 6.0,
                "whites": 2.0,
                "blacks": -10.0,
                "clarity": 6.0,
                "dehaze": 6.0,
                "vibrance": 10.0,
                "saturation": -4.0,
                "hsl": hsl_look([
                    (0.0, 8.0, 2.0),
                    (0.0, 10.0, 4.0),
                    (0.0, -10.0, 0.0),
                    (0.0, -20.0, -4.0),
                    (-8.0, 12.0, 0.0),
                    (-10.0, 16.0, -6.0),
                    (0.0, 6.0, 0.0),
                    (0.0, 6.0, 0.0),
                ]),
                "colorGrading": grading(
                    (205.0, 22.0, 0.0),
                    (0.0, 0.0, 0.0),
                    (35.0, 14.0, 0.0),
                    0.0,
                    55.0,
                ),
                "curves": curves(
                    &[(0.0, 0.0), (32.0, 26.0), (128.0, 134.0), (208.0, 220.0), (255.0, 255.0)],
                    &[],
                    &[],
                    &[],
                ),
                "vignetteAmount": -18.0,
                "grainAmount": 4.0,
            }),
            lut: film_lut(LUT_VISION_250D, 45.0),
            intensity: 100.0,
            built_in: true,
            description: Some(
                "Classic teal-and-orange cinema grade with warm skin and cool shadows. For urban, night and car photography.".to_string(),
            ),
        },
        StyleProfile {
            id: "builtin-sports-crisp".to_string(),
            name: "Sports — Crisp Action".to_string(),
            detect_tags: tag_list(&[
                "sports",
                "running",
                "jogging",
                "cycling",
                "swimming",
                "surfing",
                "skiing",
                "snowboarding",
                "climbing",
                "skating",
                "stadium",
                "arena",
                "motion blur",
                "activity",
            ]),
            subject: None,
            adjustments: json!({
                "contrast": 12.0,
                "highlights": -18.0,
                "shadows": 12.0,
                "whites": 4.0,
                "blacks": -8.0,
                "clarity": 12.0,
                "structure": 12.0,
                "dehaze": 6.0,
                "vibrance": 10.0,
                "sharpness": 14.0,
                "hsl": hsl_look([
                    (0.0, 6.0, 0.0),
                    (0.0, 4.0, 0.0),
                    (0.0, 4.0, 0.0),
                    (0.0, 4.0, 0.0),
                    (0.0, 4.0, 0.0),
                    (0.0, 8.0, 0.0),
                    (0.0, 4.0, 0.0),
                    (0.0, 4.0, 0.0),
                ]),
                "curves": curves(
                    &[(0.0, 0.0), (40.0, 34.0), (128.0, 134.0), (208.0, 216.0), (255.0, 255.0)],
                    &[],
                    &[],
                    &[],
                ),
                "vignetteAmount": -6.0,
            }),
            lut: film_lut(LUT_EKTAR_100, 25.0),
            intensity: 100.0,
            built_in: true,
            description: Some(
                "Clean, crisp action look with strong micro-contrast and colour that stays natural. For field, track and arena sports.".to_string(),
            ),
        },
        StyleProfile {
            id: "builtin-wildlife-detail".to_string(),
            name: "Wildlife — Detail & Color".to_string(),
            detect_tags: tag_list(&[
                "wildlife",
                "animal",
                "bird",
                "eagle",
                "owl",
                "lion",
                "tiger",
                "bear",
                "deer",
                "fox",
                "horse",
                "close-up",
                "telephoto",
            ]),
            subject: None,
            adjustments: json!({
                "contrast": 8.0,
                "highlights": -22.0,
                "shadows": 14.0,
                "whites": 4.0,
                "blacks": -6.0,
                "clarity": 12.0,
                "structure": 14.0,
                "dehaze": 6.0,
                "vibrance": 12.0,
                "saturation": 2.0,
                "sharpness": 16.0,
                "hsl": hsl_look([
                    (0.0, 4.0, 0.0),
                    (0.0, 6.0, 2.0),
                    (0.0, 4.0, 0.0),
                    (-2.0, 8.0, 0.0),
                    (0.0, 6.0, 0.0),
                    (0.0, 6.0, 0.0),
                    (0.0, 0.0, 0.0),
                    (0.0, 0.0, 0.0),
                ]),
                "curves": curves(
                    &[(0.0, 0.0), (36.0, 32.0), (128.0, 132.0), (208.0, 218.0), (255.0, 255.0)],
                    &[],
                    &[],
                    &[],
                ),
                "vignetteAmount": -8.0,
            }),
            lut: film_lut(LUT_EKTAR_100, 20.0),
            intensity: 100.0,
            built_in: true,
            description: Some(
                "Feather and fur detail with recovered highlights and natural colour. For birds and wildlife.".to_string(),
            ),
        },
        StyleProfile {
            id: "builtin-street-mono".to_string(),
            name: "Street — High-Contrast B&W".to_string(),
            detect_tags: tag_list(&[
                "street",
                "urban",
                "city",
                "architecture",
                "alley",
                "sidewalk",
                "monochrome",
                "black and white",
                "silhouette",
                "low-key",
                "candid",
                "person",
            ]),
            subject: None,
            adjustments: json!({
                "saturation": -100.0,
                "contrast": 22.0,
                "highlights": -24.0,
                "shadows": 4.0,
                "whites": 10.0,
                "blacks": -20.0,
                "clarity": 14.0,
                "structure": 10.0,
                "curves": curves(
                    &[(0.0, 0.0), (32.0, 24.0), (128.0, 140.0), (224.0, 234.0), (255.0, 255.0)],
                    &[],
                    &[],
                    &[],
                ),
                "vignetteAmount": -18.0,
                "grainAmount": 12.0,
            }),
            lut: None,
            intensity: 100.0,
            built_in: true,
            description: Some(
                "Punchy street black and white with deep blacks, bright highlights and visible grain.".to_string(),
            ),
        },
        StyleProfile {
            id: "builtin-food-warm".to_string(),
            name: "Food — Warm & Appetizing".to_string(),
            detect_tags: tag_list(&[
                "food",
                "meal",
                "dish",
                "pizza",
                "pasta",
                "sushi",
                "burger",
                "cake",
                "coffee",
                "drink",
                "wine",
                "still life",
                "close-up",
            ]),
            subject: None,
            adjustments: json!({
                "contrast": 6.0,
                "highlights": -14.0,
                "shadows": 10.0,
                "whites": 4.0,
                "blacks": -4.0,
                "clarity": 8.0,
                "structure": 4.0,
                "vibrance": 12.0,
                "saturation": 2.0,
                "temperature": 6.0,
                "tint": 2.0,
                "hsl": hsl_look([
                    (0.0, 8.0, 0.0),
                    (2.0, 10.0, 4.0),
                    (0.0, 6.0, 4.0),
                    (-2.0, 4.0, 0.0),
                    (0.0, 0.0, 0.0),
                    (0.0, -8.0, 0.0),
                    (0.0, 0.0, 0.0),
                    (0.0, 0.0, 0.0),
                ]),
                "colorGrading": grading(
                    (25.0, 8.0, 0.0),
                    (35.0, 4.0, 0.0),
                    (45.0, 8.0, 0.0),
                    8.0,
                    50.0,
                ),
                "curves": curves(
                    &[(0.0, 4.0), (64.0, 72.0), (160.0, 172.0), (255.0, 250.0)],
                    &[],
                    &[],
                    &[],
                ),
                "vignetteAmount": -10.0,
                "grainAmount": 2.0,
            }),
            lut: film_lut(LUT_GOLD_200, 35.0),
            intensity: 100.0,
            built_in: true,
            description: Some(
                "Warm, appetising Kodak Gold look with richer reds and oranges and a soft vignette.".to_string(),
            ),
        },
    ]
}

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

/// Fills in the on-disk path of every bundled film LUT a built-in profile
/// references. Paths depend on the installation directory, so they cannot be
/// hard-coded; if the resource is missing (e.g. a stripped build) the path is
/// left empty and the look is applied without the LUT instead of breaking.
fn resolve_builtin_lut_paths(app_handle: &AppHandle, profiles: &mut [StyleProfile]) {
    let Some(dir) = crate::lut_processing::film_luts_dir(app_handle) else {
        log::warn!(
            "Built-in film LUT directory is unavailable; style profiles will run without LUTs"
        );
        return;
    };
    let entries = crate::lut_processing::list_luts_in_dir(&dir, true).unwrap_or_default();

    for profile in profiles {
        let Some(lut) = profile.lut.as_mut() else {
            continue;
        };
        if !lut.path.is_empty() {
            continue;
        }
        match entries.iter().find(|entry| entry.name == lut.name) {
            Some(entry) => lut.path = entry.path.clone(),
            None => log::warn!(
                "Built-in LUT '{}' for style profile '{}' was not found",
                lut.name,
                profile.id
            ),
        }
    }
}

fn all_style_profiles(app_handle: &AppHandle) -> Vec<StyleProfile> {
    let mut profiles = builtin_style_profiles();
    resolve_builtin_lut_paths(app_handle, &mut profiles);
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
                if let (Some(x), Some(y)) = (
                    p.get("x").and_then(Value::as_f64),
                    p.get("y").and_then(Value::as_f64),
                ) {
                    // Blend the curve toward the identity line y = x.
                    let new_y = x + (y - x) * fraction;
                    p.insert("y".to_string(), json!((new_y * 100.0).round() / 100.0));
                }
            }
        }
    }
}

/// Upper/lower bounds for the look scalars. This is a safety net for learned
/// and user-authored profiles: a bad value (a former built-in had `exposure:
/// 6.0`, i.e. +6 EV) must never blow up an otherwise good photo.
const SCALAR_LOOK_RANGES: &[(&str, f64, f64)] = &[
    ("exposure", -2.0, 2.0),
    ("brightness", -100.0, 100.0),
    ("contrast", -100.0, 100.0),
    ("highlights", -100.0, 100.0),
    ("shadows", -100.0, 100.0),
    ("whites", -100.0, 100.0),
    ("blacks", -100.0, 100.0),
    ("clarity", -100.0, 100.0),
    ("structure", -100.0, 100.0),
    ("dehaze", -100.0, 100.0),
    ("vibrance", -100.0, 100.0),
    ("saturation", -100.0, 100.0),
    ("sharpness", 0.0, 150.0),
    ("grainAmount", 0.0, 100.0),
    ("vignetteAmount", -100.0, 100.0),
    ("temperature", -100.0, 100.0),
    ("tint", -100.0, 100.0),
    ("hue", -180.0, 180.0),
    ("glowAmount", 0.0, 100.0),
    ("halationAmount", 0.0, 100.0),
    ("flareAmount", 0.0, 100.0),
    ("colorNoiseReduction", 0.0, 100.0),
    ("lumaNoiseReduction", 0.0, 100.0),
];

fn clamp_number(value: &mut Value, min: f64, max: f64) {
    if let Some(number) = value.as_f64() {
        *value = json!(number.clamp(min, max));
    }
}

/// Clamps every look value to the range the editor UI allows.
fn clamp_look_adjustments(adjustments: &mut Value) {
    let Some(obj) = adjustments.as_object_mut() else {
        return;
    };

    for (key, min, max) in SCALAR_LOOK_RANGES {
        if let Some(value) = obj.get_mut(*key) {
            clamp_number(value, *min, *max);
        }
    }

    if let Some(hsl) = obj.get_mut("hsl").and_then(Value::as_object_mut) {
        for leaf in hsl.values_mut() {
            if let Some(leaf_obj) = leaf.as_object_mut() {
                for value in leaf_obj.values_mut() {
                    clamp_number(value, -100.0, 100.0);
                }
            }
        }
    }

    if let Some(grading) = obj.get_mut("colorGrading").and_then(Value::as_object_mut) {
        for (key, value) in grading.iter_mut() {
            match key.as_str() {
                "balance" => clamp_number(value, -100.0, 100.0),
                "blending" => clamp_number(value, 0.0, 100.0),
                _ => {
                    if let Some(leaf_obj) = value.as_object_mut() {
                        for (leaf_key, leaf) in leaf_obj.iter_mut() {
                            match leaf_key.as_str() {
                                // Hue is an angle; wrap rather than clamp so a
                                // slightly out-of-range learned value still works.
                                "hue" => {
                                    if let Some(number) = leaf.as_f64() {
                                        *leaf = json!(number.rem_euclid(360.0));
                                    }
                                }
                                "saturation" => clamp_number(leaf, 0.0, 100.0),
                                _ => clamp_number(leaf, -100.0, 100.0),
                            }
                        }
                    }
                }
            }
        }
    }

    for curve_key in CURVE_GROUPS {
        let Some(group) = obj.get_mut(*curve_key).and_then(Value::as_object_mut) else {
            continue;
        };
        for channel in CURVE_CHANNELS {
            let Some(points) = group.get_mut(*channel).and_then(Value::as_array_mut) else {
                continue;
            };
            for point in points.iter_mut() {
                if let Some(point_obj) = point.as_object_mut() {
                    if let Some(x) = point_obj.get_mut("x") {
                        clamp_number(x, 0.0, 255.0);
                    }
                    if let Some(y) = point_obj.get_mut("y") {
                        clamp_number(y, 0.0, 255.0);
                    }
                }
            }
        }
    }
}

/// Force-enables the editor tools a look relies on. A sidecar can carry
/// `activeTools: { "curves": false, ... }` from earlier edits; without this a
/// perfectly good style would be written but silently ignored by the renderer.
fn enable_tools_for_adjustments(adjustments: &mut Value) {
    let Some(obj) = adjustments.as_object_mut() else {
        return;
    };

    const BASIC_KEYS: &[&str] = &[
        "exposure",
        "brightness",
        "contrast",
        "highlights",
        "shadows",
        "whites",
        "blacks",
        "temperature",
        "tint",
    ];

    let mut tools: Vec<&str> = Vec::new();
    if BASIC_KEYS.iter().any(|key| obj.contains_key(*key)) {
        tools.push("basic");
        tools.push("whiteBalance");
    }
    if obj.contains_key("vibrance") || obj.contains_key("saturation") {
        tools.push("colorPresence");
    }
    if obj.contains_key("hue") {
        tools.push("hue");
    }
    if obj.contains_key("curves") {
        tools.push("curves");
    }
    if obj.contains_key("hsl") {
        tools.push("colorMixer");
    }
    if obj.contains_key("colorGrading") {
        tools.push("colorGrading");
    }
    if obj.contains_key("clarity") || obj.contains_key("structure") || obj.contains_key("dehaze") {
        tools.push("presence");
    }
    if obj.contains_key("sharpness") {
        tools.push("sharpening");
    }
    if obj.contains_key("grainAmount")
        || obj.contains_key("grainSize")
        || obj.contains_key("grainRoughness")
    {
        tools.push("grain");
    }
    if obj.contains_key("vignetteAmount")
        || obj.contains_key("vignetteFeather")
        || obj.contains_key("vignetteMidpoint")
    {
        tools.push("vignette");
    }
    if obj.contains_key("glowAmount")
        || obj.contains_key("halationAmount")
        || obj.contains_key("flareAmount")
    {
        tools.push("creative");
    }
    if obj.contains_key("lutPath") {
        tools.push("lut");
    }

    let active = obj
        .entry("activeTools".to_string())
        .or_insert_with(|| json!({}));
    if let Some(active_obj) = active.as_object_mut() {
        for tool in tools {
            active_obj.insert(tool.to_string(), json!(true));
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
    let fraction = intensity / 100.0;
    if intensity < 100.0 {
        scale_look_adjustments(&mut adjustments, fraction);
    }

    // Keep the point-curve backup in sync so switching the Curves tool to
    // parametric mode and back does not silently drop the look's tone curve.
    if let Some(curves) = adjustments.get("curves").cloned()
        && let Some(obj) = adjustments.as_object_mut()
    {
        obj.entry("pointCurves".to_string()).or_insert(curves);
    }

    if let Some(lut) = &profile.lut {
        // An unresolved built-in LUT has an empty path. Do not point the render
        // pipeline at it: the look should simply fall back to the grading.
        if !lut.path.trim().is_empty()
            && let Some(obj) = adjustments.as_object_mut()
        {
            obj.insert("lutPath".to_string(), json!(lut.path));
            obj.insert("lutName".to_string(), json!(lut.name));
            obj.insert("lutIsSceneReferred".to_string(), json!(lut.is_built_in));
            // Intensity also controls the LUT blend, otherwise a 0% look would
            // still be coloured by the film emulation.
            obj.insert(
                "lutIntensity".to_string(),
                json!(lut.intensity.clamp(0.0, 100.0) * fraction),
            );
            let active = obj
                .entry("activeTools".to_string())
                .or_insert_with(|| json!({}));
            if let Some(active_obj) = active.as_object_mut() {
                active_obj.insert("lut".to_string(), json!(true));
            }
        }
    }

    clamp_look_adjustments(&mut adjustments);
    enable_tools_for_adjustments(&mut adjustments);
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

/// Tags that appear on so many event photos that they say little about *which*
/// look fits. They still count, but at half weight, so specific tags (an
/// instrument, a genre, "mosh pit", "neon", ...) decide between variants.
const GENERIC_TAGS: &[&str] = &[
    "concert",
    "live music",
    "live concert",
    "music",
    "festival",
    "stage",
    "stage lighting",
    "stage lights",
    "spotlight",
    "musician",
    "band",
    "performer",
    "singer",
    "vocalist",
    "audience",
    "crowd",
    "festival crowd",
    "person",
    "people",
    "portrait",
    "night",
    "dark",
    "neon",
    "colorful",
    "event",
    "celebration",
    "party",
    "dancing",
    "activity",
];

fn tag_weight(tag: &str) -> f64 {
    if GENERIC_TAGS.contains(&tag) {
        0.5
    } else {
        1.0
    }
}

/// Weighted fraction of a profile's `detect_tags` present in the image tags
/// (0..1), together with the tags that matched. A profile without `detect_tags`
/// never matches automatically (score 0) and is only used as an explicit
/// fallback.
///
/// Generic event tags (see [`GENERIC_TAGS`]) count half so that, for example, a
/// photo tagged "concert, saxophone, singer" prefers the warm/acoustic look over
/// the metal look instead of tying on "concert" and "singer".
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
        return (0.0, Vec::new());
    }

    let specific_total = profile
        .detect_tags
        .iter()
        .filter(|tag| tag_weight(&normalize_tag(tag)) >= 1.0)
        .count();
    let generic_total = profile.detect_tags.len().saturating_sub(specific_total);

    // Bounded denominator: a broad, many-tag profile should not be punished for
    // every tag it declares, while a narrow profile stays easy to match.
    let denom = (specific_total as f64 + generic_total as f64 * 0.5).clamp(1.0, 4.0);
    let matched_weight: f64 = matched
        .iter()
        .map(|tag| tag_weight(&normalize_tag(tag)))
        .sum();
    ((matched_weight / denom).min(1.0), matched)
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
        let entry = self
            .curves
            .entry(key.to_string())
            .or_insert((vec![0.0; CURVE_GRID.len()], 0));
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
        // Exposure is per-image (the renderer already applies a baseline
        // exposure); averaging it across a set would bake in a random EV bump.
        if *key == "exposure" {
            continue;
        }
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
                    "black"
                        | "white"
                        | "gray"
                        | "grey"
                        | "color"
                        | "red"
                        | "orange"
                        | "yellow"
                        | "green"
                        | "blue"
                        | "purple"
                        | "pink"
                        | "brown"
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

    let ((path, name, is_built_in), count) = counts.into_iter().max_by_key(|(_, count)| *count)?;

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
pub async fn match_style_profiles_for_paths(
    paths: Vec<String>,
    min_score: Option<f64>,
    app_handle: AppHandle,
) -> Result<Vec<StyleMatch>, String> {
    // This used to be a synchronous command with a rayon `par_iter`, so it ran
    // on the GTK main thread and waited for the *global* rayon pool. When a
    // bulk job (thumbnail regeneration after a batch edit) occupied that pool,
    // the main thread waited forever and the whole UI froze. Keep it off the
    // main thread and off the global pool: reading sidecars is I/O, not compute.
    tauri::async_runtime::spawn_blocking(move || {
        let profiles = all_style_profiles(&app_handle);
        let min_score = min_score.unwrap_or(0.12);

        let mut matches = Vec::new();
        for path in &paths {
            let tags = tags_for_path(path);
            if let Some((score, matched, profile)) =
                best_profile_for_tags(&tags, &profiles, min_score)
            {
                matches.push(StyleMatch {
                    path: path.clone(),
                    profile_id: profile.id.clone(),
                    profile_name: profile.name.clone(),
                    score,
                    matched_tags: matched,
                });
            }
        }

        log::info!(
            "AI Style: matched {} of {} images",
            matches.len(),
            paths.len()
        );
        Ok(matches)
    })
    .await
    .map_err(|e| format!("Style matching task failed: {e}"))?
}

/// Cached stats for one photo, or `None` when its 480 px preview has not been
/// generated yet (the look is then applied with its defaults).
fn stats_for_path(app_handle: &AppHandle, path: &str) -> Option<std::sync::Arc<PhotoStats>> {
    let (thumbnail, iso) = cached_analysis_source(app_handle, path)?;
    analyze_thumbnail_cached(&thumbnail, iso)
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

    let intensity = intensity.unwrap_or(profile.intensity).clamp(0.0, 100.0);
    log::info!(
        "AI Style: applying profile '{}' to {} images (intensity {:.0})",
        profile.name,
        paths.len(),
        intensity
    );

    // Per-image analysis (JPEG decode of the cached 480 px previews) is CPU
    // work; keep it off the async runtime's core threads and off the GTK thread.
    let task_handle = app_handle.clone();
    let task_profile = profile.clone();
    let entries = tauri::async_runtime::spawn_blocking(move || {
        let mut entries = Vec::with_capacity(paths.len());
        for path in paths {
            let tags = tags_for_path(&path);
            let mut adjustments = profile_to_adjustments(&task_profile, Some(intensity));
            merge_adjustments_additive(
                &mut adjustments,
                &tone_tweak_adjustments(tone_tweak_for_tags(&tags)),
            );
            if let Some(stats) = stats_for_path(&task_handle, &path) {
                adapt_look_to_photo(&mut adjustments, &task_profile, &stats, &tags);
            } else {
                clamp_look_adjustments(&mut adjustments);
            }
            entries.push((path, adjustments));
        }
        entries
    })
    .await
    .map_err(|error| format!("Style adaptation task failed: {error}"))?;

    apply_adjustments_to_paths_map(entries, app_handle).await
}

/// Small, per-image corrections derived from content/lighting tags, so the same
/// profile does not treat a low-key silhouette and a bright daylight frame
/// identically.
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
enum ToneTweak {
    Neutral,
    LiftShadows,
    TameHighlights,
    Backlit,
}

fn tone_tweak_for_tags(tags: &[String]) -> ToneTweak {
    let has = |needle: &str| tags.iter().any(|tag| normalize_tag(tag) == needle);
    if has("low-key") || has("dark") || has("night") {
        ToneTweak::LiftShadows
    } else if has("backlighting") || has("silhouette") {
        ToneTweak::Backlit
    } else if has("high-key") || has("bright") {
        ToneTweak::TameHighlights
    } else {
        ToneTweak::Neutral
    }
}

fn tone_tweak_adjustments(tweak: ToneTweak) -> Value {
    match tweak {
        ToneTweak::Neutral => json!({}),
        ToneTweak::LiftShadows => json!({
            "exposure": 0.15,
            "shadows": 6.0,
            "blacks": 2.0,
        }),
        ToneTweak::TameHighlights => json!({
            "exposure": -0.1,
            "highlights": -6.0,
            "whites": -3.0,
        }),
        ToneTweak::Backlit => json!({
            "exposure": 0.1,
            "shadows": 10.0,
            "highlights": -6.0,
        }),
    }
}

/// Adds the numeric top-level values of `overlay` to `base`. Adjustments are
/// deltas applied to the photo, so a profile and a tone tweak stack additively.
fn merge_adjustments_additive(base: &mut Value, overlay: &Value) {
    let (Some(base_obj), Some(overlay_obj)) = (base.as_object_mut(), overlay.as_object()) else {
        return;
    };
    for (key, overlay_value) in overlay_obj {
        if let Some(number) = overlay_value.as_f64() {
            let current = base_obj.get(key).and_then(Value::as_f64).unwrap_or(0.0);
            base_obj.insert(key.clone(), json!(current + number));
        }
    }
}

/// Where a given look wants the median tone to land. Concert looks are meant to
/// stay moody, wedding/portrait looks brighter; `None` (learned/user profiles)
/// uses a neutral 0.42.
fn profile_target_luma(profile: &StyleProfile) -> f64 {
    match profile.id.as_str() {
        "builtin-concert-dark" | "builtin-concert-mono" => 0.30,
        "builtin-concert-neon" => 0.32,
        "builtin-concert-warm" => 0.36,
        "builtin-night-neon" => 0.28,
        "builtin-cinematic" => 0.36,
        "builtin-street-mono" => 0.38,
        "builtin-golden-hour" => 0.40,
        "builtin-portrait-natural" | "builtin-festival-pop" | "builtin-sports-crisp" => 0.46,
        "builtin-wedding-airy" | "builtin-food-warm" => 0.50,
        _ => 0.42,
    }
}

fn add_to_scalar(adjustments: &mut Value, key: &str, delta: f64) {
    let Some(obj) = adjustments.as_object_mut() else {
        return;
    };
    let current = obj.get(key).and_then(Value::as_f64).unwrap_or(0.0);
    obj.insert(key.to_string(), json!(current + delta));
}

/// Scales an existing (usually positive) look value, e.g. taming `vibrance` when
/// the photo is already neon-bright.
fn scale_existing_scalar(adjustments: &mut Value, key: &str, factor: f64) {
    let Some(obj) = adjustments.as_object_mut() else {
        return;
    };
    if let Some(value) = obj.get(key).and_then(Value::as_f64) {
        obj.insert(key.to_string(), json!(value * factor));
    }
}

fn replace_scalar(adjustments: &mut Value, key: &str, value: f64) {
    if let Some(obj) = adjustments.as_object_mut() {
        obj.insert(key.to_string(), json!(value));
    }
}

fn contains_tag(tags: &[String], needle: &str) -> bool {
    tags.iter().any(|tag| normalize_tag(tag) == needle)
}

/// Adapts a look to what the photo *actually* contains.
///
/// One fixed preset cannot work for a correctly exposed daylight frame and a
/// dark, clipping stage shot. This reads the measured histogram/colour stats and:
///
/// * moves the median tone towards the look's target with a bounded EV shift and
///   backs off when highlights are already clipping,
/// * recovers blown highlights and lifts crushed shadows,
/// * re-balances SATURATION when the scene is already neon-vivid,
/// * applies a small grey-world white-balance correction for neutral/skin looks
///   on a strong cast (never for neon/stage-light scenes or warm looks),
/// * lowers clarity/sharpening and adds noise reduction on high-ISO frames,
/// * reduces the LUT blend when the photo already carries a lot of colour.
fn adapt_look_to_photo(
    adjustments: &mut Value,
    profile: &StyleProfile,
    stats: &PhotoStats,
    tags: &[String],
) {
    // --- Exposure: median-based, highlight-aware ---------------------------
    let target = profile_target_luma(profile);
    let median = stats.luma_median.max(0.01);
    let mut delta_ev = (target / median).log2();

    if delta_ev > 0.0 {
        if stats.highlight_clip > 0.01 {
            // Already blowing highlights: raising exposure makes it worse. The
            // shadow lift below opens the frame without adding more clipping.
            delta_ev = 0.0;
        } else if stats.highlight_clip > 0.004 {
            delta_ev *= 0.25;
        } else if stats.luma_p95 > 0.94 {
            delta_ev *= 0.55;
        }
    } else if stats.shadow_clip > 0.05 {
        // Do not crush a frame that is already sitting on the floor.
        delta_ev *= 0.5;
    }

    let delta_ev = if delta_ev.abs() < 0.12 {
        0.0
    } else {
        delta_ev.clamp(-0.8, 0.9)
    };
    if delta_ev != 0.0 {
        add_to_scalar(adjustments, "exposure", delta_ev);
    }

    // --- Highlight recovery / shadow lift ---------------------------------
    if stats.highlight_clip > 0.002 || stats.luma_p95 > 0.90 {
        let recover = (stats.highlight_clip * 2500.0 + (stats.luma_p95 - 0.90).max(0.0) * 120.0)
            .clamp(3.0, 28.0);
        add_to_scalar(adjustments, "highlights", -recover);
        add_to_scalar(adjustments, "whites", -recover * 0.35);
    }

    if stats.shadow_clip > 0.01 || stats.luma_p05 < 0.02 {
        let lift = (stats.shadow_clip * 1200.0 + (0.02 - stats.luma_p05).max(0.0) * 300.0)
            .clamp(2.0, 18.0);
        add_to_scalar(adjustments, "shadows", lift);
        add_to_scalar(adjustments, "blacks", lift * 0.2);
    }

    // --- Contrast: help flat frames, avoid crunching contrasty ones --------
    if stats.contrast < 0.09 {
        add_to_scalar(adjustments, "contrast", 4.0);
    } else if stats.contrast > 0.32 {
        add_to_scalar(adjustments, "contrast", -5.0);
    }

    // --- Saturation: do not pour neon on top of neon ----------------------
    if stats.saturation > 0.50 {
        let factor = (0.50 / stats.saturation).clamp(0.55, 1.0);
        if adjustments["saturation"].as_f64().unwrap_or(0.0) > 0.0 {
            scale_existing_scalar(adjustments, "saturation", factor);
        }
        if adjustments["vibrance"].as_f64().unwrap_or(0.0) > 0.0 {
            scale_existing_scalar(adjustments, "vibrance", factor);
        }
    } else if stats.saturation < 0.12 {
        add_to_scalar(adjustments, "vibrance", 4.0);
    }

    // --- LUT blend: keep strong film colour away from already-vivid frames -
    if let Some(obj) = adjustments.as_object_mut()
        && let Some(lut_intensity) = obj.get("lutIntensity").and_then(Value::as_f64)
    {
        let factor = if stats.colorfulness > 0.55 {
            0.80
        } else if stats.colorfulness > 0.40 {
            0.90
        } else {
            1.0
        };
        obj.insert(
            "lutIntensity".to_string(),
            json!((lut_intensity * factor).clamp(0.0, 100.0)),
        );
    }

    // --- Noise: high ISO gets less crunch and more noise reduction ---------
    let iso = stats.iso.unwrap_or(0);
    let reduction = match iso {
        iso if iso >= 6400 => 0.60,
        iso if iso >= 3200 => 0.45,
        iso if iso >= 1600 => 0.25,
        _ => 0.0,
    };
    if reduction > 0.0 {
        for key in ["clarity", "structure", "sharpness"] {
            if adjustments[key].as_f64().unwrap_or(0.0) > 0.0 {
                scale_existing_scalar(adjustments, key, 1.0 - reduction);
            }
        }
        add_to_scalar(adjustments, "lumaNoiseReduction", 20.0 * reduction);
        add_to_scalar(adjustments, "colorNoiseReduction", 12.0 * reduction);
    }

    // --- Vignette: don't double up on an already-dark border --------------
    if stats.corner_ratio < 0.80
        && let Some(vignette) = adjustments["vignetteAmount"].as_f64()
        && vignette < 0.0
    {
        replace_scalar(adjustments, "vignetteAmount", vignette * 0.5);
    }

    // --- White balance: conservative grey-world for neutral/skin looks -----
    let neutral_look = matches!(
        profile.id.as_str(),
        "builtin-portrait-natural"
            | "builtin-wedding-airy"
            | "builtin-landscape-vivid"
            | "builtin-sports-crisp"
            | "builtin-wildlife-detail"
            | "builtin-food-warm"
    );
    let colourful_scene = stats.colorfulness > 0.45
        || [
            "neon",
            "stage lighting",
            "stage lights",
            "laser lights",
            "colorful",
        ]
        .iter()
        .any(|tag| contains_tag(tags, tag));

    if neutral_look && !colourful_scene {
        if stats.cast_rb.abs() > 0.07 {
            let correction =
                -stats.cast_rb.signum() * ((stats.cast_rb.abs() - 0.07) * 350.0).min(6.0);
            add_to_scalar(adjustments, "temperature", correction);
        }
        if stats.cast_gm.abs() > 0.06 {
            let correction =
                stats.cast_gm.signum() * ((stats.cast_gm.abs() - 0.06) * 300.0).min(5.0);
            add_to_scalar(adjustments, "tint", correction);
        }
    }

    // Clamp once more: the adaptive deltas must stay inside editor ranges.
    clamp_look_adjustments(adjustments);
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
    let fallback = fallback_profile_id
        .as_ref()
        .and_then(|id| profiles.iter().find(|p| p.id == *id))
        .cloned();

    log::info!(
        "AI Style: auto pass over {} images (min score {:.2})",
        paths.len(),
        min_score
    );

    // Matching + per-image analysis + look adaptation all happen in one blocking
    // task: sidecar reads and 480 px JPEG decodes are cheap but must stay off
    // the GTK/async threads. Nothing here touches the GPU or the global rayon
    // pool, so it cannot deadlock with rendering.
    let task_handle = app_handle.clone();
    let profiles_for_task = profiles.clone();
    let (entries, names, counts, skipped) = tauri::async_runtime::spawn_blocking(move || {
        let mut entries = Vec::with_capacity(paths.len());
        let mut names: HashMap<String, String> = HashMap::new();
        let mut counts: HashMap<String, usize> = HashMap::new();
        let mut skipped: Vec<String> = Vec::new();

        for path in paths {
            let tags = tags_for_path(&path);
            let matched = best_profile_for_tags(&tags, &profiles_for_task, min_score);
            let chosen = matched
                .as_ref()
                .map(|(_, _, profile)| *profile)
                .or(fallback.as_ref());

            let Some(profile) = chosen else {
                skipped.push(path);
                continue;
            };

            names
                .entry(profile.id.clone())
                .or_insert_with(|| profile.name.clone());
            *counts.entry(profile.id.clone()).or_insert(0) += 1;

            let look_intensity = intensity.unwrap_or(profile.intensity).clamp(0.0, 100.0);
            let mut adjustments = profile_to_adjustments(profile, Some(look_intensity));
            merge_adjustments_additive(
                &mut adjustments,
                &tone_tweak_adjustments(tone_tweak_for_tags(&tags)),
            );
            if let Some(stats) = stats_for_path(&task_handle, &path) {
                adapt_look_to_photo(&mut adjustments, profile, &stats, &tags);
            } else {
                clamp_look_adjustments(&mut adjustments);
            }
            entries.push((path, adjustments));
        }

        (entries, names, counts, skipped)
    })
    .await
    .map_err(|error| format!("Style adaptation task failed: {error}"))?;

    let applied = counts.values().sum();
    apply_adjustments_to_paths_map(entries, app_handle).await?;

    log::info!(
        "AI Style: auto pass done, {} applied, {} skipped",
        applied,
        skipped.len()
    );

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

        let tags = vec![
            "Concert".to_string(),
            "STAGE".to_string(),
            "crowd".to_string(),
        ];
        let (score, matched) = match_score(&tags, &profile);
        // Two matches, but both are generic ("concert", "stage") so they count
        // half; the only specific tag ("guitarist") did not match.
        // denom = 1 specific + 2 generic * 0.5 = 2.0, weight = 0.5 + 0.5 = 1.0
        assert!((score - 0.5).abs() < 1e-9);
        assert_eq!(matched.len(), 2);

        let no_tags: Vec<String> = vec![];
        assert_eq!(match_score(&no_tags, &profile).0, 0.0);
    }

    fn profile_with_tags(id: &str, tags: &[&str]) -> StyleProfile {
        StyleProfile {
            id: id.into(),
            name: id.into(),
            detect_tags: tags.iter().map(|tag| (*tag).to_string()).collect(),
            subject: None,
            adjustments: json!({}),
            lut: None,
            intensity: 100.0,
            built_in: true,
            description: None,
        }
    }

    #[test]
    fn specific_tags_pick_the_right_variant() {
        let metal = profile_with_tags(
            "metal",
            &["guitarist", "metal concert", "concert", "stage", "musician"],
        );
        let warm = profile_with_tags(
            "warm",
            &[
                "saxophone",
                "acoustic concert",
                "concert",
                "stage",
                "musician",
            ],
        );

        // A concert photo with a saxophone should not be treated as a metal show.
        let tags = vec![
            "concert".to_string(),
            "saxophone".to_string(),
            "singer".to_string(),
        ];
        let (metal_score, _) = match_score(&tags, &metal);
        let (warm_score, _) = match_score(&tags, &warm);
        assert!(warm_score > metal_score, "{warm_score} <= {metal_score}");

        // ...while a guitarist photo prefers the metal look.
        let tags = vec!["concert".to_string(), "guitarist".to_string()];
        let (metal_score, _) = match_score(&tags, &metal);
        let (warm_score, _) = match_score(&tags, &warm);
        assert!(metal_score > warm_score, "{metal_score} <= {warm_score}");
    }

    #[test]
    fn dangerous_exposure_is_clamped() {
        let mut profile = profile_with_tags("p", &[]);
        profile.adjustments = json!({ "exposure": 6.0, "contrast": 400.0 });

        let adjustments = profile_to_adjustments(&profile, None);
        assert_eq!(adjustments["exposure"], json!(2.0));
        assert_eq!(adjustments["contrast"], json!(100.0));
    }

    #[test]
    fn unresolved_lut_is_ignored() {
        let mut profile = profile_with_tags("p", &[]);
        profile.lut = Some(StyleProfileLut {
            name: "missing".into(),
            path: String::new(),
            is_built_in: true,
            intensity: 40.0,
        });

        let adjustments = profile_to_adjustments(&profile, None);
        assert!(adjustments.get("lutPath").is_none());
    }

    #[test]
    fn intensity_scales_lut_blend() {
        let mut profile = profile_with_tags("p", &[]);
        profile.lut = Some(StyleProfileLut {
            name: "test".into(),
            path: "/tmp/test.cube".into(),
            is_built_in: true,
            intensity: 60.0,
        });

        let adjustments = profile_to_adjustments(&profile, Some(50.0));
        assert_eq!(adjustments["lutIntensity"], json!(30.0));

        let adjustments = profile_to_adjustments(&profile, Some(0.0));
        assert_eq!(adjustments["lutIntensity"], json!(0.0));
    }

    #[test]
    fn builtin_profiles_are_sane_and_distinct() {
        let profiles = builtin_style_profiles();
        assert!(profiles.len() >= 14);

        let mut ids = std::collections::HashSet::new();
        for profile in &profiles {
            assert!(
                ids.insert(profile.id.clone()),
                "duplicate id {}",
                profile.id
            );
            assert!(
                !profile.detect_tags.is_empty(),
                "{} has no tags",
                profile.id
            );

            let adjustments = profile_to_adjustments(profile, None);
            let exposure = adjustments["exposure"].as_f64().unwrap_or(0.0);
            assert!(
                exposure.abs() <= 0.5,
                "{} bakes in {exposure} EV",
                profile.id
            );

            // Every look must do more than nudge one slider: a LUT or a real
            // grading stack (HSL/curves/colour grading).
            let has_grading = adjustments.get("hsl").is_some()
                || adjustments.get("curves").is_some()
                || adjustments.get("colorGrading").is_some();
            assert!(has_grading, "{} has no grading", profile.id);
        }
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
        assert!(
            (sample_curve_y(arr, 200.0).unwrap() - (50.0 + (255.0 - 50.0) * (100.0 / 155.0))).abs()
                < 1e-6
        );
    }

    #[test]
    fn derived_profile_averages_scalars() {
        let stats = LookStats::default();
        let mut stats = stats;
        stats.add_scalar("contrast", 10.0);
        stats.add_scalar("contrast", 20.0);
        stats.add_curve(
            "curves.luma",
            [0.0, 32.0, 64.0, 96.0, 128.0, 160.0, 192.0, 224.0, 255.0],
        );

        let adjustments = build_adjustments_from_stats(&stats);
        assert_eq!(adjustments["contrast"], json!(15.0));
        let curve = adjustments["curves"]["luma"].as_array().unwrap();
        assert_eq!(curve.len(), CURVE_GRID.len());
        assert_eq!(curve[0]["x"], json!(0.0));
    }

    fn adapt_profile() -> StyleProfile {
        StyleProfile {
            id: "builtin-portrait-natural".into(),
            name: "portrait".into(),
            detect_tags: vec!["portrait".into()],
            subject: None,
            adjustments: json!({}),
            lut: None,
            intensity: 100.0,
            built_in: true,
            description: None,
        }
    }

    fn look_inputs() -> Value {
        json!({
            "exposure": 0.0,
            "highlights": -10.0,
            "shadows": 10.0,
            "whites": 0.0,
            "blacks": 0.0,
            "contrast": 0.0,
            "saturation": 12.0,
            "vibrance": 10.0,
            "clarity": 12.0,
            "structure": 12.0,
            "sharpness": 20.0,
            "vignetteAmount": -10.0,
        })
    }

    #[test]
    fn dark_photo_gets_a_positive_exposure_lift() {
        let stats = PhotoStats {
            luma_median: 0.10,
            luma_p05: 0.01,
            luma_p95: 0.45,
            contrast: 0.10,
            ..PhotoStats::default()
        };
        let mut adjustments = look_inputs();
        adapt_look_to_photo(&mut adjustments, &adapt_profile(), &stats, &[]);
        assert!(adjustments["exposure"].as_f64().unwrap() > 0.3);
        // Crushed shadows are lifted too.
        assert!(adjustments["shadows"].as_f64().unwrap() > 10.0);
    }

    #[test]
    fn clipped_highlights_block_a_positive_lift_and_are_recovered() {
        let stats = PhotoStats {
            luma_median: 0.12,
            luma_p95: 0.99,
            highlight_clip: 0.10,
            contrast: 0.14,
            ..PhotoStats::default()
        };
        let mut adjustments = look_inputs();
        adapt_look_to_photo(&mut adjustments, &adapt_profile(), &stats, &[]);
        // A quarter of the (large) lift still keeps it modest.
        assert!(adjustments["exposure"].as_f64().unwrap() <= 0.3);
        assert!(adjustments["highlights"].as_f64().unwrap() < -10.0);
        assert!(adjustments["whites"].as_f64().unwrap() < 0.0);
    }

    #[test]
    fn already_vivid_photos_reduce_saturation_and_lut_blend() {
        let mut profile = adapt_profile();
        profile.lut = Some(StyleProfileLut {
            name: "Kodak".into(),
            path: "/tmp/kodak.cube".into(),
            is_built_in: true,
            intensity: 60.0,
        });
        let stats = PhotoStats {
            saturation: 0.80,
            colorfulness: 0.90,
            contrast: 0.18,
            ..PhotoStats::default()
        };
        let mut adjustments = look_inputs();
        adjustments["lutIntensity"] = json!(60.0);
        adapt_look_to_photo(&mut adjustments, &profile, &stats, &[]);
        assert!(adjustments["saturation"].as_f64().unwrap() < 12.0);
        assert!(adjustments["vibrance"].as_f64().unwrap() < 10.0);
        assert!(adjustments["lutIntensity"].as_f64().unwrap() < 60.0);
    }

    #[test]
    fn high_iso_reduces_crunch_and_adds_noise_reduction() {
        let stats = PhotoStats {
            iso: Some(12800),
            noise: 0.75,
            contrast: 0.18,
            ..PhotoStats::default()
        };
        let mut adjustments = look_inputs();
        adapt_look_to_photo(&mut adjustments, &adapt_profile(), &stats, &[]);
        assert!(adjustments["clarity"].as_f64().unwrap() < 12.0);
        assert!(adjustments["sharpness"].as_f64().unwrap() < 20.0);
        assert!(adjustments["lumaNoiseReduction"].as_f64().unwrap() > 0.0);
    }

    #[test]
    fn warm_neutral_photo_gets_a_conservative_cooling_correction() {
        let stats = PhotoStats {
            cast_rb: 0.20,
            colorfulness: 0.20,
            saturation: 0.30,
            contrast: 0.18,
            ..PhotoStats::default()
        };
        let mut adjustments = look_inputs();
        adapt_look_to_photo(&mut adjustments, &adapt_profile(), &stats, &[]);
        let temperature = adjustments["temperature"].as_f64().unwrap();
        assert!(temperature < 0.0 && temperature >= -6.0, "{temperature}");
    }
}
