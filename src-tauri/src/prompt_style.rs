//! Natural-language look generator.
//!
//! The user describes the treatment they want ("moody teal and orange concert,
//! subtle grain"), and this module turns that description into a handful of
//! complete [`StyleProfile`]s. It is deliberately local and deterministic: the
//! app already ships CLIP and a set of film LUTs, but no text-to-image model, so
//! a curated photographic vocabulary gives predictable, editable results.
//!
//! The interpreter understands English and Croatian keywords, subjects
//! (concert, wedding, portrait, landscape, …), moods (cinematic, airy, moody,
//! teal & orange, black & white, vintage, neon, …), film stocks and modifiers
//! ("subtle", "bold"). It then builds four variations — Balanced, Soft, Bold
//! and Film — so the user can compare treatments instead of accepting a single
//! guess.

use serde_json::{Value, json};

use crate::style_profile::{StyleProfile, curves, film_lut, grading, hsl_look};

// Bundled film emulations (resource names, see `resources/film_luts`).
const LUT_FUJI_400H: &str = "F-Pro 400H";
const LUT_EKTAR_100: &str = "K-Ektar 100";
const LUT_GOLD_200: &str = "K-Gold 200";
const LUT_PORTRA_400: &str = "K-Portra 400";
const LUT_VISION_250D: &str = "K-Vision 250D Cinematic";
const LUT_VISION_500T: &str = "K-Vision 500T Cinematic";

const HSL_CHANNELS: usize = 8;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Variant {
    Balanced,
    Soft,
    Bold,
    Film,
}

impl Variant {
    fn label(self) -> &'static str {
        match self {
            Self::Balanced => "Balanced",
            Self::Soft => "Soft",
            Self::Bold => "Bold",
            Self::Film => "Film",
        }
    }
}

#[derive(Clone, Debug)]
struct LookIntent {
    brightness: f64,
    contrast: f64,
    saturation: f64,
    vibrance: f64,
    temperature: f64,
    tint: f64,
    highlights: f64,
    shadows: f64,
    whites: f64,
    blacks: f64,
    clarity: f64,
    dehaze: f64,
    sharpness: f64,
    grain: f64,
    vignette: f64,
    halation: f64,
    glow: f64,
    /// Per-channel `(hue, saturation, luminance)` for reds..magentas.
    hsl: [(f64, f64, f64); HSL_CHANNELS],
    shadow_grade: Option<(f64, f64)>,
    mid_grade: Option<(f64, f64)>,
    highlight_grade: Option<(f64, f64)>,
    mono: bool,
    sepia: bool,
    /// Black-point lift for a faded film curve.
    fade: f64,
    lut: Option<&'static str>,
    lut_intensity: f64,
    subject: Option<&'static str>,
    labels: Vec<&'static str>,
    strength: f64,
}

impl Default for LookIntent {
    fn default() -> Self {
        Self {
            brightness: 0.0,
            contrast: 0.0,
            saturation: 0.0,
            vibrance: 0.0,
            temperature: 0.0,
            tint: 0.0,
            highlights: 0.0,
            shadows: 0.0,
            whites: 0.0,
            blacks: 0.0,
            clarity: 0.0,
            dehaze: 0.0,
            sharpness: 0.0,
            grain: 0.0,
            vignette: 0.0,
            halation: 0.0,
            glow: 0.0,
            hsl: [(0.0, 0.0, 0.0); HSL_CHANNELS],
            shadow_grade: None,
            mid_grade: None,
            highlight_grade: None,
            mono: false,
            sepia: false,
            fade: 0.0,
            lut: None,
            lut_intensity: 0.0,
            subject: None,
            labels: Vec::new(),
            strength: 1.0,
        }
    }
}

impl LookIntent {
    fn label(&mut self, value: &'static str) {
        if !self.labels.contains(&value) {
            self.labels.push(value);
        }
    }

    fn shadow_grade(&mut self, hue: f64, saturation: f64) {
        let grade = self.shadow_grade.get_or_insert((hue, 0.0));
        grade.0 = hue;
        grade.1 = grade.1.max(saturation);
    }

    fn mid_grade(&mut self, hue: f64, saturation: f64) {
        let grade = self.mid_grade.get_or_insert((hue, 0.0));
        grade.0 = hue;
        grade.1 = grade.1.max(saturation);
    }

    fn highlight_grade(&mut self, hue: f64, saturation: f64) {
        let grade = self.highlight_grade.get_or_insert((hue, 0.0));
        grade.0 = hue;
        grade.1 = grade.1.max(saturation);
    }

    fn hsl(&mut self, channel: usize, hue: f64, saturation: f64, luminance: f64) {
        if let Some(entry) = self.hsl.get_mut(channel) {
            entry.0 += hue;
            entry.1 += saturation;
            entry.2 += luminance;
        }
    }

    fn summary(&self) -> String {
        let mut traits: Vec<String> = Vec::new();
        if self.mono {
            traits.push(if self.sepia {
                "sepia tone".to_string()
            } else {
                "black and white".to_string()
            });
        }
        let tinted = [self.shadow_grade, self.mid_grade, self.highlight_grade]
            .into_iter()
            .flatten()
            .any(|(_, saturation)| saturation > 0.0);
        if tinted && (!self.mono || self.sepia) {
            traits.push("split toning".to_string());
        }
        let contrast = self.contrast * self.strength;
        if contrast > 10.0 {
            traits.push("punchy contrast".to_string());
        } else if contrast < -6.0 {
            traits.push("soft contrast".to_string());
        }
        let temperature = self.temperature * self.strength;
        if temperature > 4.0 {
            traits.push("warm white balance".to_string());
        } else if temperature < -4.0 {
            traits.push("cool white balance".to_string());
        }
        if self.grain * self.strength > 4.0 {
            traits.push("subtle grain".to_string());
        }
        if self.fade * self.strength > 4.0 {
            traits.push("faded blacks".to_string());
        }
        if let Some(lut) = self.lut {
            traits.push(format!("{lut} LUT"));
        }
        if traits.is_empty() {
            "clean, natural colour".to_string()
        } else {
            traits.join(", ")
        }
    }
}

// ---------------------------------------------------------------------------
// Interpreter
// ---------------------------------------------------------------------------

fn clamp(value: f64, min: f64, max: f64) -> f64 {
    value.clamp(min, max)
}

fn round(value: f64) -> f64 {
    (value * 10.0).round() / 10.0
}

fn has(text: &str, needles: &[&str]) -> bool {
    needles.iter().any(|needle| text.contains(needle))
}

/// Whole-word match for short tokens that would otherwise fire inside unrelated
/// words (`mat` in `cinematic`, `portra` in `portrait`, `auto` in `automatic`).
fn has_word(text: &str, words: &[&str]) -> bool {
    text.split(|c: char| !c.is_alphanumeric() && c != '&')
        .any(|token| words.contains(&token))
}

fn detect_subject(text: &str) -> Option<&'static str> {
    let concert = has(
        text,
        &[
            "concert",
            "live music",
            "rock band",
            "metal band",
            "punk band",
            "on stage",
            "stage lighting",
            "mosh",
            "headbang",
            "koncert",
            "pozornica",
        ],
    ) || has_word(text, &["gig", "bend"]);
    if concert {
        return Some("concert");
    }

    if has(
        text,
        &[
            "wedding",
            "bride",
            "groom",
            "vjenčanje",
            "mladenci",
            "svadba",
        ],
    ) {
        return Some("wedding");
    }

    if has(
        text,
        &[
            "portrait", "headshot", "model", "fashion", "portret", "portreti",
        ],
    ) {
        return Some("portrait");
    }

    let landscape = has(
        text,
        &[
            "landscape",
            "mountain",
            "ocean",
            "forest",
            "desert",
            "nature",
            "pejzaž",
            "krajolik",
            "planina",
            "obala",
            "plaža",
            "morski",
            "šuma",
        ],
    ) || has_word(text, &["sea"]);
    if landscape {
        return Some("landscape");
    }

    if has(
        text,
        &["food", "restaurant", "dish", "meal", "hrana", "jelo"],
    ) {
        return Some("food");
    }

    if has(text, &["street", "urban", "ulica", "arhitektura"]) || has_word(text, &["city", "grad"])
    {
        return Some("street");
    }

    if has(
        text,
        &["night", "nightclub", "neon", "noć", "noćni", "club"],
    ) {
        return Some("night");
    }

    if has(text, &["festival", "crowd", "publika"]) {
        return Some("festival");
    }

    if has(text, &["sport", "action", "athlete", "stadium"]) {
        return Some("sports");
    }

    if has(text, &["wildlife", "bird", "animal", "divlje", "ptica"]) {
        return Some("wildlife");
    }

    if has(text, &["architecture", "building", "interior", "zgrada"]) {
        return Some("architecture");
    }

    if has(text, &["product", "still life", "proizvod"]) {
        return Some("product");
    }

    if has(text, &["automotive", "vehicle"]) || has_word(text, &["car", "auto"]) {
        return Some("automotive");
    }

    None
}

fn subject_label(subject: &str) -> &'static str {
    match subject {
        "concert" => "Concert",
        "wedding" => "Wedding",
        "portrait" => "Portrait",
        "landscape" => "Landscape",
        "food" => "Food",
        "street" => "Street",
        "night" => "Night",
        "festival" => "Festival",
        "sports" => "Sports",
        "wildlife" => "Wildlife",
        "architecture" => "Architecture",
        "product" => "Product",
        "automotive" => "Automotive",
        _ => "Custom",
    }
}

fn subject_tags(subject: &str) -> Vec<String> {
    let tags: &[&str] = match subject {
        "concert" => &[
            "concert",
            "live concert",
            "live music",
            "rock concert",
            "metal concert",
            "stage",
            "stage lighting",
            "musician",
            "band",
            "gig",
        ],
        "wedding" => &["wedding", "bride", "groom", "couple", "ceremony"],
        "portrait" => &["portrait", "person", "face", "candid", "model", "fashion"],
        "landscape" => &[
            "landscape",
            "mountain",
            "ocean",
            "forest",
            "sunset",
            "nature",
        ],
        "food" => &["food", "dish", "restaurant", "meal"],
        "street" => &["street", "city", "urban", "architecture"],
        "night" => &["night", "neon", "city lights"],
        "festival" => &["festival", "festival crowd", "crowd", "open air concert"],
        "sports" => &["sports", "action", "athlete", "stadium"],
        "wildlife" => &["wildlife", "bird", "animal"],
        "architecture" => &["architecture", "building", "interior"],
        "product" => &["product", "still life"],
        "automotive" => &["car", "automotive", "vehicle"],
        _ => &[],
    };
    tags.iter().map(|tag| (*tag).to_string()).collect()
}

fn apply_subject(intent: &mut LookIntent, subject: &'static str) {
    intent.subject = Some(subject);
    match subject {
        "concert" | "night" | "festival" => {
            intent.contrast += 14.0;
            intent.highlights -= 20.0;
            intent.shadows -= 2.0;
            intent.blacks -= 14.0;
            intent.clarity += 9.0;
            intent.vibrance += 9.0;
            intent.saturation -= 5.0;
            intent.vignette -= 22.0;
            intent.halation += 8.0;
            intent.shadow_grade(212.0, 18.0);
            intent.highlight_grade(38.0, 13.0);
            intent.lut.get_or_insert(LUT_VISION_500T);
            intent.lut_intensity = intent.lut_intensity.max(50.0);
        }
        "wedding" => {
            intent.contrast -= 8.0;
            intent.highlights -= 10.0;
            intent.shadows += 18.0;
            intent.whites += 8.0;
            intent.temperature += 4.0;
            intent.saturation -= 4.0;
            intent.vibrance += 6.0;
            intent.clarity -= 4.0;
            intent.lut.get_or_insert(LUT_PORTRA_400);
            intent.lut_intensity = intent.lut_intensity.max(30.0);
        }
        "portrait" => {
            intent.contrast += 4.0;
            intent.temperature += 3.0;
            intent.vibrance += 7.0;
            intent.clarity -= 4.0;
            intent.hsl(1, 2.0, -4.0, 6.0);
            intent.lut.get_or_insert(LUT_PORTRA_400);
            intent.lut_intensity = intent.lut_intensity.max(28.0);
        }
        "landscape" => {
            intent.contrast += 8.0;
            intent.vibrance += 12.0;
            intent.clarity += 8.0;
            intent.dehaze += 5.0;
            intent.hsl(3, 4.0, 10.0, -3.0);
            intent.hsl(5, 0.0, 8.0, -3.0);
            intent.lut.get_or_insert(LUT_EKTAR_100);
            intent.lut_intensity = intent.lut_intensity.max(28.0);
        }
        "food" => {
            intent.contrast += 6.0;
            intent.temperature += 8.0;
            intent.saturation += 6.0;
            intent.hsl(1, 2.0, 12.0, 4.0);
            intent.vignette -= 14.0;
            intent.lut.get_or_insert(LUT_GOLD_200);
            intent.lut_intensity = intent.lut_intensity.max(28.0);
        }
        "street" => {
            intent.contrast += 12.0;
            intent.clarity += 10.0;
            intent.saturation -= 8.0;
            intent.blacks -= 10.0;
            intent.lut.get_or_insert(LUT_VISION_250D);
            intent.lut_intensity = intent.lut_intensity.max(24.0);
        }
        "sports" => {
            intent.contrast += 10.0;
            intent.clarity += 12.0;
            intent.sharpness += 10.0;
            intent.vibrance += 8.0;
        }
        "wildlife" => {
            intent.sharpness += 12.0;
            intent.clarity += 8.0;
            intent.vibrance += 8.0;
            intent.lut.get_or_insert(LUT_EKTAR_100);
            intent.lut_intensity = intent.lut_intensity.max(20.0);
        }
        "architecture" => {
            intent.contrast += 8.0;
            intent.clarity += 10.0;
            intent.dehaze += 4.0;
            intent.sharpness += 5.0;
        }
        "product" => {
            intent.contrast += 6.0;
            intent.clarity += 12.0;
            intent.sharpness += 8.0;
        }
        "automotive" => {
            intent.contrast += 12.0;
            intent.clarity += 10.0;
            intent.blacks -= 8.0;
            intent.sharpness += 6.0;
        }
        _ => {}
    }
}

fn apply_mood(intent: &mut LookIntent, text: &str) {
    // --- Strength modifiers (apply to every numeric value later) ----------
    if has(
        text,
        &[
            "subtle", "slight", "gentle", "barely", "suptilno", "blago", "nježno",
        ],
    ) {
        intent.strength = 0.62;
    } else if has(
        text,
        &[
            "extreme",
            "very strong",
            "over the top",
            "ekstremno",
            "jako izraženo",
        ],
    ) {
        intent.strength = 1.55;
    } else if has(
        text,
        &[
            "strong",
            "heavy",
            "intense",
            "bold",
            "dramatic",
            "izraženo",
            "dramatično",
        ],
    ) {
        intent.strength = 1.32;
    }

    // --- Colour stories ---------------------------------------------------
    if (has(text, &["teal"]) && has(text, &["orange"])) || has(text, &["tirkizno", "narančasto"]) {
        intent.shadow_grade(200.0, 22.0);
        intent.highlight_grade(35.0, 24.0);
        intent.temperature += 5.0;
        intent.contrast += 12.0;
        intent.vibrance += 8.0;
        intent.saturation -= 2.0;
        intent.label("Teal & Orange");
        intent.lut.get_or_insert(LUT_VISION_250D);
        intent.lut_intensity = intent.lut_intensity.max(35.0);
    }

    if has(
        text,
        &[
            "cinematic",
            "cinema",
            "movie",
            "film still",
            "filmski",
            "kao film",
        ],
    ) {
        intent.contrast += 10.0;
        intent.saturation -= 5.0;
        intent.shadow_grade(205.0, 14.0);
        intent.highlight_grade(40.0, 16.0);
        intent.halation += 10.0;
        intent.clarity += 4.0;
        intent.label("Cinematic");
        intent.lut.get_or_insert(LUT_VISION_250D);
        intent.lut_intensity = intent.lut_intensity.max(35.0);
    }

    if has(
        text,
        &[
            "moody",
            "dark",
            "low key",
            "low-key",
            "lowkey",
            "dramatic",
            "mračn",
            "tamno",
            "dramatično",
        ],
    ) {
        intent.brightness -= 7.0;
        intent.contrast += 11.0;
        intent.blacks -= 13.0;
        intent.shadows -= 5.0;
        intent.highlights -= 13.0;
        intent.saturation -= 5.0;
        intent.shadow_grade(215.0, 16.0);
        intent.vignette -= 16.0;
        intent.label("Moody");
    }

    if has(
        text,
        &[
            "bright",
            "airy",
            "high key",
            "high-key",
            "light and airy",
            "svijetlo",
            "prozračno",
        ],
    ) {
        intent.brightness += 7.0;
        intent.shadows += 19.0;
        intent.highlights -= 8.0;
        intent.contrast -= 6.0;
        intent.whites += 8.0;
        intent.saturation -= 3.0;
        intent.label("Airy");
    }

    if has(
        text,
        &[
            "vintage",
            "retro",
            "analog",
            "analogue",
            "faded",
            "starinski",
            "analogni",
        ],
    ) {
        intent.temperature += 6.0;
        intent.saturation -= 8.0;
        intent.contrast -= 4.0;
        intent.fade += 12.0;
        intent.grain += 14.0;
        intent.shadow_grade(35.0, 8.0);
        intent.lut.get_or_insert(LUT_GOLD_200);
        intent.lut_intensity = intent.lut_intensity.max(35.0);
        intent.label("Vintage Film");
    }

    if has(text, &["modern", "clean", "crisp", "moderan", "čisto"]) {
        intent.contrast += 9.0;
        intent.clarity += 8.0;
        intent.sharpness += 5.0;
        intent.dehaze += 3.0;
        intent.label("Modern");
    }

    if has(text, &["natural", "prirodno"]) {
        intent.contrast += 3.0;
        intent.vibrance += 3.0;
        intent.clarity += 2.0;
        intent.label("Natural");
    }

    if has(
        text,
        &[
            "punchy",
            "bold",
            "vivid",
            "vibrant",
            "high contrast",
            "contrasty",
            "živopisno",
            "kontrastno",
            "vibrantno",
        ],
    ) {
        intent.contrast += 19.0;
        intent.vibrance += 14.0;
        intent.saturation += 4.0;
        intent.blacks -= 10.0;
        intent.clarity += 8.0;
        intent.label("Punchy");
    }

    if has(
        text,
        &[
            "soft look",
            "soft light",
            "soft lighting",
            "soft tones",
            "softly",
            "dreamy",
            "pastel",
            "hazy",
            "ethereal",
            "mekano",
            "sanjivo",
            "pastelno",
            "snoliko",
        ],
    ) {
        intent.contrast -= 9.0;
        intent.shadows += 15.0;
        intent.highlights -= 6.0;
        intent.saturation -= 8.0;
        intent.glow += 11.0;
        intent.halation += 6.0;
        intent.clarity -= 4.0;
        intent.label("Dreamy");
    }

    if has_word(text, &["matte", "mat"]) {
        intent.fade += 15.0;
        intent.contrast -= 4.0;
        intent.blacks += 6.0;
        intent.label("Matte");
    }

    let mono_requested = has(
        text,
        &[
            "black and white",
            "black & white",
            "monochrome",
            "noir",
            "crno-bijel",
            "crno bijel",
            "monokromatski",
        ],
    ) || has_word(text, &["mono", "bw", "b&w"]);
    if mono_requested {
        intent.mono = true;
        intent.contrast += 16.0;
        intent.clarity += 6.0;
        intent.grain += 10.0;
        if has(text, &["noir"]) {
            intent.blacks -= 16.0;
            intent.vignette -= 18.0;
            intent.label("Noir");
        } else {
            intent.label("Black & White");
        }
    }

    if has(text, &["sepia", "sepiya", "sepi"]) {
        intent.mono = true;
        intent.sepia = true;
        intent.temperature += 16.0;
        intent.shadow_grade(35.0, 28.0);
        intent.highlight_grade(42.0, 20.0);
        intent.grain += 8.0;
        intent.label("Sepia");
    }

    if has(
        text,
        &[
            "neon",
            "cyberpunk",
            "synthwave",
            "vaporwave",
            "neon lights",
            "neonski",
        ],
    ) {
        intent.shadow_grade(195.0, 30.0);
        intent.mid_grade(312.0, 22.0);
        intent.highlight_grade(330.0, 18.0);
        intent.saturation += 12.0;
        intent.vibrance += 10.0;
        intent.contrast += 12.0;
        intent.halation += 12.0;
        intent.label("Neon");
        intent.lut = Some(LUT_VISION_500T);
        intent.lut_intensity = 45.0;
    }

    if has(
        text,
        &[
            "golden hour",
            "sunset",
            "sunrise",
            "sun-kissed",
            "sunkissed",
            "zlatni sat",
            "zalazak",
            "izlazak",
        ],
    ) {
        intent.temperature += 12.0;
        intent.highlight_grade(40.0, 20.0);
        intent.shadow_grade(25.0, 8.0);
        intent.vibrance += 10.0;
        intent.label("Golden Hour");
        intent.lut = Some(LUT_GOLD_200);
        intent.lut_intensity = 38.0;
    }

    if has(
        text,
        &["warm", "toasty", "cozy", "toplo", "toplina", "topli"],
    ) {
        intent.temperature += 8.0;
        intent.highlight_grade(38.0, 12.0);
        intent.saturation += 2.0;
        intent.label("Warm");
    }

    if has(
        text,
        &[
            "cool",
            "cold",
            "blue hour",
            "icy",
            "winter",
            "hladno",
            "plavkasto",
            "zima",
        ],
    ) {
        intent.temperature -= 10.0;
        intent.shadow_grade(215.0, 18.0);
        intent.saturation -= 4.0;
        intent.label("Cool");
    }

    if has(
        text,
        &["green", "forest", "earthy", "zeleno", "šuma", "zemljano"],
    ) {
        intent.hsl(3, 6.0, 14.0, -4.0);
        intent.temperature += 1.0;
        intent.label("Earthy");
        intent.lut.get_or_insert(LUT_FUJI_400H);
        intent.lut_intensity = intent.lut_intensity.max(25.0);
    }

    if has(text, &["crimson", "crveno", "crvena"]) || has_word(text, &["red"]) {
        intent.hsl(0, 2.0, 16.0, -2.0);
        intent.highlight_grade(0.0, 10.0);
        intent.label("Red");
    }

    if has(text, &["ljubičasto", "purpurno"]) || has_word(text, &["purple", "violet", "magenta"]) {
        intent.hsl(6, 0.0, 16.0, -2.0);
        intent.hsl(7, 0.0, 12.0, 0.0);
        intent.mid_grade(310.0, 12.0);
        intent.label("Purple");
    }

    if has(
        text,
        &[
            "desaturated",
            "muted",
            "subdued",
            "prigušeno",
            "blijedo",
            "bez boje",
        ],
    ) {
        intent.saturation -= 22.0;
        intent.vibrance -= 8.0;
        intent.label("Muted");
    }

    // --- Physical / finishing cues ---------------------------------------
    if has(text, &["grain", "grainy", "filmic grain", "zrnato", "zrno"]) {
        intent.grain += 18.0;
        intent.label("Grain");
    }
    if has(
        text,
        &["soft highlights", "soft highlight", "soften highlights"],
    ) {
        intent.highlights -= 10.0;
        intent.highlight_grade(38.0, 5.0);
    }
    if has(text, &["halation", "glow", "bloom", "sjaj"]) {
        intent.halation += 9.0;
        intent.glow += 6.0;
    }
    if has(text, &["vignette", "dark edges", "vinjeta"]) {
        intent.vignette -= 20.0;
    }
    if has(
        text,
        &["sharp", "crisp detail", "detailed", "oštro", "detaljno"],
    ) {
        intent.sharpness += 12.0;
        intent.clarity += 8.0;
    }
    if has(text, &["soft skin", "skin tones", "skin", "koža"]) || has_word(text, &["ten"]) {
        intent.hsl(1, 2.0, -4.0, 6.0);
        intent.clarity -= 4.0;
    }

    // --- Film stocks ------------------------------------------------------
    if has_word(text, &["portra"]) {
        intent.lut = Some(LUT_PORTRA_400);
        intent.lut_intensity = 35.0;
        intent.temperature += 3.0;
        intent.grain += 6.0;
        intent.label("Portra");
    } else if has(text, &["ektar"]) {
        intent.lut = Some(LUT_EKTAR_100);
        intent.lut_intensity = 35.0;
        intent.vibrance += 8.0;
        intent.contrast += 5.0;
        intent.label("Ektar");
    } else if has(text, &["gold 200", "kodak gold"]) || has_word(text, &["gold"]) {
        intent.lut = Some(LUT_GOLD_200);
        intent.lut_intensity = 35.0;
        intent.temperature += 5.0;
        intent.grain += 7.0;
        intent.label("Gold");
    } else if has(text, &["400h", "fuji", "f-pro"]) {
        intent.lut = Some(LUT_FUJI_400H);
        intent.lut_intensity = 35.0;
        intent.temperature -= 2.0;
        intent.hsl(3, 0.0, 8.0, 0.0);
        intent.label("Fuji");
    } else if has(text, &["cinestill", "vision 250d", "250d"]) {
        intent.lut = Some(LUT_VISION_250D);
        intent.lut_intensity = 38.0;
        intent.label("Cinestill");
    } else if has(text, &["vision 500t", "500t", "tungsten"]) {
        intent.lut = Some(LUT_VISION_500T);
        intent.lut_intensity = 40.0;
        intent.label("Tungsten");
    } else if has(text, &["ilford", "tri-x", "tri x", "hp5"]) {
        intent.mono = true;
        intent.grain += 18.0;
        intent.contrast += 10.0;
        intent.label("Black & White");
    }
}

fn interpret(prompt: &str) -> LookIntent {
    let text = prompt.to_lowercase();
    let mut intent = LookIntent::default();

    if let Some(subject) = detect_subject(&text) {
        apply_subject(&mut intent, subject);
    }
    apply_mood(&mut intent, &text);

    // Nothing recognised: still return a gentle, usable baseline instead of
    // failing the request.
    if intent.labels.is_empty()
        && intent.subject.is_none()
        && intent.lut.is_none()
        && intent.adjustments_are_neutral()
    {
        intent.contrast += 6.0;
        intent.vibrance += 5.0;
        intent.clarity += 4.0;
        intent.label("Natural");
    }

    intent
}

impl LookIntent {
    fn adjustments_are_neutral(&self) -> bool {
        self.brightness == 0.0
            && self.contrast == 0.0
            && self.saturation == 0.0
            && self.vibrance == 0.0
            && self.temperature == 0.0
            && self.tint == 0.0
            && self.highlights == 0.0
            && self.shadows == 0.0
            && self.whites == 0.0
            && self.blacks == 0.0
            && self.clarity == 0.0
            && self.dehaze == 0.0
            && self.sharpness == 0.0
            && self.grain == 0.0
            && self.vignette == 0.0
            && self.halation == 0.0
            && self.glow == 0.0
            && self.fade == 0.0
            && self.shadow_grade.is_none()
            && self.mid_grade.is_none()
            && self.highlight_grade.is_none()
            && self.hsl.iter().all(|entry| *entry == (0.0, 0.0, 0.0))
    }
}

// ---------------------------------------------------------------------------
// Profile construction
// ---------------------------------------------------------------------------

fn build_adjustments(intent: &LookIntent, variant: Variant) -> Value {
    let strength = intent.strength;
    let (contrast_scale, clarity_scale, grain_scale, sat_scale) = match variant {
        Variant::Balanced => (1.0, 1.0, 1.0, 1.0),
        Variant::Soft => (0.65, 0.5, 0.6, 0.85),
        Variant::Bold => (1.35, 1.25, 1.1, 1.05),
        Variant::Film => (0.9, 0.9, 1.2, 0.95),
    };

    let scale = |value: f64| round(value * strength);
    let mut adjustments = json!({
        "brightness": round(clamp(scale(intent.brightness), -60.0, 60.0)),
        "contrast": round(clamp(scale(intent.contrast) * contrast_scale, -60.0, 60.0)),
        "highlights": round(clamp(scale(intent.highlights), -80.0, 60.0)),
        "shadows": round(clamp(scale(intent.shadows), -40.0, 60.0)),
        "whites": round(clamp(scale(intent.whites), -40.0, 40.0)),
        "blacks": round(clamp(scale(intent.blacks), -40.0, 40.0)),
        "clarity": round(clamp(scale(intent.clarity) * clarity_scale, -30.0, 40.0)),
        "dehaze": round(clamp(scale(intent.dehaze), -10.0, 30.0)),
        "vibrance": round(clamp(scale(intent.vibrance) * sat_scale, -40.0, 40.0)),
        "saturation": round(clamp(scale(intent.saturation) * sat_scale, -100.0, 30.0)),
        "temperature": round(clamp(scale(intent.temperature), -40.0, 40.0)),
        "tint": round(clamp(scale(intent.tint), -30.0, 30.0)),
        "sharpness": round(clamp(scale(intent.sharpness) * clarity_scale, 0.0, 80.0)),
        "grainAmount": round(clamp(scale(intent.grain) * grain_scale, 0.0, 60.0)),
        "grainRoughness": 50.0,
        "grainSize": 30.0,
        "vignetteAmount": round(clamp(scale(intent.vignette), -60.0, 0.0)),
        "vignetteFeather": 55.0,
        "vignetteMidpoint": 45.0,
        "halationAmount": round(clamp(scale(intent.halation), 0.0, 40.0)),
        "glowAmount": round(clamp(scale(intent.glow), 0.0, 40.0)),
        "hsl": hsl_look(intent.hsl),
    });

    if intent.mono {
        let saturation = adjustments["saturation"].as_f64().unwrap_or(0.0);
        adjustments["saturation"] = json!(clamp(saturation - 100.0, -100.0, 100.0));
        adjustments["vibrance"] = json!(0.0);
        adjustments["halationAmount"] = json!(0.0);
        // A monochrome look must not keep colour mixer or split-tone hues,
        // except for sepia where the warm tint is the point.
        if !intent.sepia {
            const KEYS: [&str; HSL_CHANNELS] = [
                "reds", "oranges", "yellows", "greens", "aquas", "blues", "purples", "magentas",
            ];
            for key in KEYS {
                if let Some(entry) = adjustments["hsl"].get_mut(key) {
                    entry["hue"] = json!(0.0);
                    entry["saturation"] = json!(0.0);
                }
            }
        }
    }

    let radius = |grade: Option<(f64, f64)>, fallback_hue: f64| -> (f64, f64, f64) {
        match grade {
            Some((hue, saturation)) if !intent.mono || intent.sepia => {
                (hue, clamp(saturation * strength, 0.0, 100.0), 0.0)
            }
            _ => (fallback_hue, 0.0, 0.0),
        }
    };
    adjustments["colorGrading"] = grading(
        radius(intent.shadow_grade, 210.0),
        radius(intent.mid_grade, 0.0),
        radius(intent.highlight_grade, 38.0),
        0.0,
        52.0,
    );

    let fade = if variant == Variant::Film {
        intent.fade + 7.0
    } else if variant == Variant::Soft {
        intent.fade + 4.0
    } else {
        intent.fade
    };
    let fade = clamp(scale(fade), 0.0, 32.0);
    if fade > 0.5 || intent.contrast.abs() > 8.0 {
        let contrast = clamp(scale(intent.contrast) * contrast_scale, -40.0, 45.0);
        let lift = fade;
        let mid_lift = lift * 0.4;
        let shoulder = (contrast * 0.12).clamp(-8.0, 10.0);
        adjustments["curves"] = curves(
            &[
                (0.0, lift),
                (64.0, 64.0 + mid_lift),
                (128.0, 128.0),
                (192.0, 192.0 + shoulder),
                (255.0, 255.0 - lift * 0.2),
            ],
            &[],
            &[],
            &[],
        );
    }

    let lut = match variant {
        Variant::Film if intent.lut.is_none() && !intent.mono => {
            Some((default_lut_for(intent), 42.0))
        }
        _ => intent.lut.map(|name| (name, intent.lut_intensity)),
    };
    if let Some((name, lut_intensity)) = lut
        && !intent.mono
    {
        adjustments["__lut_name"] = json!(name);
        adjustments["__lut_intensity"] = json!(round(clamp(lut_intensity, 0.0, 100.0)));
    }

    adjustments
}

fn default_lut_for(intent: &LookIntent) -> &'static str {
    match intent.subject {
        Some("concert") | Some("night") | Some("festival") => LUT_VISION_500T,
        Some("wedding") | Some("portrait") => LUT_PORTRA_400,
        Some("landscape") | Some("wildlife") => LUT_EKTAR_100,
        Some("food") => LUT_GOLD_200,
        Some("street") => LUT_VISION_250D,
        _ => LUT_PORTRA_400,
    }
}

fn base_label(intent: &LookIntent) -> String {
    let subject = intent.subject.map(subject_label);
    let style = if intent.mono {
        intent
            .labels
            .iter()
            .find(|label| matches!(**label, "Black & White" | "Noir" | "Sepia"))
            .copied()
            .or_else(|| intent.labels.first().copied())
    } else {
        intent.labels.first().copied()
    };
    match (subject, style) {
        (Some(subject), Some(style)) => format!("{style} {subject}"),
        (Some(subject), None) => format!("{subject} Look"),
        (None, Some(style)) => style.to_string(),
        (None, None) => "Custom Look".to_string(),
    }
}

fn build_profile(prompt: &str, intent: &LookIntent, variant: Variant) -> StyleProfile {
    let label = base_label(intent);
    let name = format!("{label} — {}", variant.label());
    let mut adjustments = build_adjustments(intent, variant);

    let lut = adjustments
        .as_object_mut()
        .and_then(|object| {
            let name = object.remove("__lut_name")?;
            let intensity = object.remove("__lut_intensity")?;
            Some((name.as_str()?.to_string(), intensity.as_f64()?))
        })
        .and_then(|(name, intensity)| film_lut(&name, intensity));

    let tags = intent.subject.map(subject_tags).unwrap_or_default();

    let description = format!(
        "Generated from \"{}\". {} variation: {}.",
        prompt.trim(),
        variant.label(),
        intent.summary()
    );

    StyleProfile {
        id: format!("generated-{}", uuid::Uuid::new_v4()),
        name,
        detect_tags: tags,
        subject: None,
        adjustments,
        lut,
        intensity: 100.0,
        built_in: false,
        description: Some(description),
    }
}

/// Turns a free-form prompt into four candidate looks. LUT paths are resolved
/// later by the command (they depend on the installation directory).
pub fn generate_candidates(prompt: &str) -> Result<Vec<StyleProfile>, String> {
    let prompt = prompt.trim();
    if prompt.is_empty() {
        return Err("Describe the look you want first.".to_string());
    }
    if prompt.len() > 600 {
        return Err("Keep the description under 600 characters.".to_string());
    }

    let intent = interpret(prompt);
    let variants = [
        Variant::Balanced,
        Variant::Soft,
        Variant::Bold,
        Variant::Film,
    ];
    Ok(variants
        .iter()
        .map(|variant| build_profile(prompt, &intent, *variant))
        .collect())
}

#[tauri::command]
pub fn generate_style_candidates(
    prompt: String,
    app_handle: tauri::AppHandle,
) -> Result<Vec<StyleProfile>, String> {
    let mut candidates = generate_candidates(&prompt)?;
    crate::style_profile::resolve_builtin_lut_paths(&app_handle, &mut candidates);
    Ok(candidates)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn number(profile: &StyleProfile, key: &str) -> f64 {
        profile.adjustments[key].as_f64().unwrap_or(0.0)
    }

    fn named(prompt: &str, variant: Variant) -> StyleProfile {
        let intent = interpret(prompt);
        build_profile(prompt, &intent, variant)
    }

    #[test]
    fn teal_and_orange_builds_split_toning_and_a_lut() {
        let profile = named("cinematic teal and orange concert", Variant::Balanced);
        assert!(number(&profile, "contrast") > 8.0);
        assert!(number(&profile, "temperature") > 0.0);
        let grading = &profile.adjustments["colorGrading"];
        assert!(grading["shadows"]["saturation"].as_f64().unwrap() > 0.0);
        assert!(grading["highlights"]["saturation"].as_f64().unwrap() > 0.0);
        assert!(profile.lut.is_some());
        assert!(profile.detect_tags.iter().any(|tag| tag == "concert"));
    }

    #[test]
    fn black_and_white_removes_colour_and_adds_grain() {
        let profile = named("black and white portrait", Variant::Balanced);
        assert_eq!(number(&profile, "saturation"), -100.0);
        assert!(number(&profile, "contrast") > 10.0);
        assert!(number(&profile, "grainAmount") > 0.0);
        let grading = &profile.adjustments["colorGrading"];
        assert_eq!(grading["shadows"]["saturation"].as_f64().unwrap(), 0.0);
    }

    #[test]
    fn airy_wedding_lifts_shadows_and_stays_warm() {
        let profile = named("bright airy wedding, soft skin", Variant::Balanced);
        assert!(number(&profile, "shadows") > 10.0);
        assert!(number(&profile, "temperature") > 0.0);
        assert!(number(&profile, "contrast") < 0.0);
    }

    #[test]
    fn vintage_adds_grain_fade_and_a_curve() {
        let profile = named("vintage film look", Variant::Balanced);
        assert!(number(&profile, "grainAmount") > 8.0);
        assert!(profile.adjustments.get("curves").is_some());
        let first = profile.adjustments["curves"]["luma"][0]["y"]
            .as_f64()
            .unwrap();
        assert!(first > 2.0, "faded look should lift the black point");
    }

    #[test]
    fn subtle_modifier_scales_the_look_down() {
        let normal = named("punchy street look", Variant::Balanced);
        let subtle = named("subtle punchy street look", Variant::Balanced);
        assert!(number(&subtle, "contrast") < number(&normal, "contrast"));
    }

    #[test]
    fn four_candidates_are_distinct_and_named() {
        let candidates = generate_candidates("moody neon night portrait").unwrap();
        assert_eq!(candidates.len(), 4);
        let ids: std::collections::HashSet<_> = candidates.iter().map(|p| p.id.clone()).collect();
        assert_eq!(ids.len(), 4);
        assert!(candidates.iter().all(|p| p.name.contains('—')));
        let contrasts: std::collections::HashSet<String> = candidates
            .iter()
            .map(|p| format!("{:.1}", number(p, "contrast")))
            .collect();
        assert!(contrasts.len() > 1, "variants should differ in strength");
    }

    #[test]
    fn monochrome_labels_the_look_and_drops_colour_tools() {
        let profile = named(
            "black and white metal concert, high contrast",
            Variant::Balanced,
        );
        assert!(profile.name.starts_with("Black & White"));
        assert_eq!(number(&profile, "vibrance"), 0.0);
        assert_eq!(number(&profile, "halationAmount"), 0.0);
    }

    #[test]
    fn cinematic_does_not_accidentally_apply_matte() {
        let profile = named("cinematic portrait", Variant::Balanced);
        assert_eq!(number(&profile, "blacks"), 0.0);
        let black_point = profile.adjustments["curves"]["luma"][0]["y"]
            .as_f64()
            .unwrap_or(0.0);
        assert_eq!(black_point, 0.0);
    }

    #[test]
    fn neon_overrides_a_portrait_film_stock() {
        let profile = named("cinematic cyberpunk neon night portrait", Variant::Balanced);
        let lut = profile.lut.expect("neon look should carry a LUT");
        assert!(lut.name.contains("500T"), "got {}", lut.name);
    }

    #[test]
    fn soft_highlights_compress_highlights_instead_of_glowing() {
        let plain = named("concert stage", Variant::Balanced);
        let soft = named("concert stage, soft highlights", Variant::Balanced);
        assert!(number(&soft, "highlights") < number(&plain, "highlights"));
        assert!(
            number(&soft, "halationAmount") <= number(&plain, "halationAmount"),
            "soft highlights must not add halation"
        );
    }

    #[test]
    fn croatian_prompt_maps_to_the_same_story() {
        let profile = named(
            "mračni koncert, tirkizno i narančasto, zrnato",
            Variant::Balanced,
        );
        assert!(profile.name.contains("Concert"));
        assert!(number(&profile, "grainAmount") > 0.0);

        let mono = named("crno-bijeli portret", Variant::Balanced);
        assert_eq!(number(&mono, "saturation"), -100.0);
    }

    #[test]
    fn short_words_do_not_misfire_across_subjects() {
        let more = named("more contrast", Variant::Balanced);
        assert!(
            more.detect_tags.is_empty(),
            "\"more\" must not become \"sea\""
        );

        let scary = named("scary portrait", Variant::Balanced);
        assert!(scary.name.contains("Portrait"));
        assert!(!scary.name.contains("Automotive"));

        let gigantic = named("gigantic portrait", Variant::Balanced);
        assert!(gigantic.name.contains("Portrait"));
        assert!(!gigantic.name.contains("Concert"));
    }

    #[test]
    fn kodak_film_stock_is_not_treated_as_vintage() {
        let profile = named("Kodak Portra portrait", Variant::Balanced);
        assert!(profile.name.contains("Portra"));
        let black_point = profile.adjustments["curves"]["luma"][0]["y"]
            .as_f64()
            .unwrap_or(0.0);
        assert_eq!(black_point, 0.0, "Portra alone must not fade the blacks");
    }

    #[test]
    fn bw_token_is_monochrome() {
        let profile = named("bw concert", Variant::Balanced);
        assert_eq!(number(&profile, "saturation"), -100.0);
    }

    #[test]
    fn natural_portrait_stays_gentle() {
        let profile = named("natural portrait", Variant::Balanced);
        assert!(number(&profile, "contrast") <= 8.0);
    }

    #[test]
    fn empty_prompt_is_rejected() {
        assert!(generate_candidates("   ").is_err());
    }

    #[test]
    fn unrecognised_prompt_still_returns_a_gentle_look() {
        let candidates = generate_candidates("asdf qwer").unwrap();
        assert_eq!(candidates.len(), 4);
        assert!(number(&candidates[0], "contrast") > 0.0);
    }
}
