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
    /// A decade/era reference such as `1950s`, used as a first-class part of
    /// the look instead of being ignored as an unknown keyword.
    era: Option<&'static str>,
    /// A named photographic/musical reference such as `Glam Rock`, `Grunge`
    /// or `Hollywood Glamour`.
    reference: Option<&'static str>,
    /// The prompt names a portrait in addition to another subject (for example
    /// "concert portrait"), so skin protection is added without replacing the
    /// concert treatment.
    portrait_modifier: bool,
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
            era: None,
            reference: None,
            portrait_modifier: false,
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

    /// A strong reference (era or artist) replaces the subject's default split
    /// tone instead of merely adding to it. Otherwise "50s ... Queen" would
    /// keep the blue concert grade and only get a little warmer.
    fn set_shadow_grade(&mut self, hue: f64, saturation: f64) {
        self.shadow_grade = Some((hue, saturation));
    }

    fn set_mid_grade(&mut self, hue: f64, saturation: f64) {
        self.mid_grade = Some((hue, saturation));
    }

    fn set_highlight_grade(&mut self, hue: f64, saturation: f64) {
        self.highlight_grade = Some((hue, saturation));
    }

    /// Likewise, an era/artist look chooses the film stock that carries its
    /// colour story. An explicit film-stock word in the prompt can still
    /// override this later.
    fn set_lut(&mut self, name: &'static str, intensity: f64) {
        self.lut = Some(name);
        self.lut_intensity = intensity;
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

    if has(text, &["food", "restaurant", "meal", "hrana", "jelo"]) || has_word(text, &["dish"]) {
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

/// True for whole tokens such as `50s` / `1950s`, ignoring apostrophes so
/// "50's" and "50’s" are understood too. A plain "50" is deliberately not an
/// era: it is far more likely to be a lens or an intensity.
fn has_decade(text: &str, needles: &[&str]) -> bool {
    let normalized = text.replace('\'', "").replace('’', "");
    normalized
        .split(|c: char| !c.is_alphanumeric())
        .any(|token| needles.contains(&token))
}

fn detect_era(text: &str) -> Option<&'static str> {
    if has_decade(text, &["1950s", "50s", "fifties"]) {
        Some("1950s")
    } else if has_decade(text, &["1960s", "60s", "sixties"]) {
        Some("1960s")
    } else if has_decade(text, &["1970s", "70s", "seventies"]) {
        Some("1970s")
    } else if has_decade(text, &["1980s", "80s", "eighties"]) {
        Some("1980s")
    } else if has_decade(text, &["1990s", "90s", "nineties"]) {
        Some("1990s")
    } else if has_decade(text, &["2000s", "00s", "y2k", "noughties", "aughts"]) {
        Some("2000s")
    } else {
        None
    }
}

fn detect_reference(text: &str) -> Option<&'static str> {
    let freddie = has(text, &["freddie", "freddy", "mercury"])
        || (has_word(text, &["queen"])
            && has(text, &["glam", "rock", "concert", "stage", "band", "style"]));
    if freddie || has(text, &["glam rock", "glam-rock"]) {
        return Some("Glam Rock");
    }
    if has_word(text, &["bowie", "ziggy"]) || has(text, &["ziggy stardust"]) {
        return Some("Ziggy Glam");
    }
    if has_word(text, &["elvis", "presley"]) || has_word(text, &["rockabilly"]) {
        return Some("Rockabilly");
    }
    if has_word(text, &["beatles"]) || has(text, &["british invasion"]) {
        return Some("British Invasion");
    }
    if has_word(text, &["nirvana", "cobain", "grunge"]) {
        return Some("Grunge");
    }
    if has_word(text, &["madonna"]) || has(text, &["new wave", "synth pop", "synthpop"]) {
        return Some("New Wave");
    }
    if (has_word(text, &["stones"]) && has(text, &["rolling"])) || has(text, &["classic rock"]) {
        return Some("Classic Rock");
    }
    if has(
        text,
        &[
            "hollywood glamour",
            "old hollywood",
            "classic hollywood",
            "silver screen",
        ],
    ) {
        return Some("Hollywood Glamour");
    }
    if has_word(text, &["disco"]) {
        return Some("Disco");
    }
    if has(text, &["film noir"]) || has_word(text, &["noir"]) {
        return Some("Film Noir");
    }
    None
}

fn apply_portrait_modifier(intent: &mut LookIntent) {
    intent.portrait_modifier = true;
    intent.temperature += 2.0;
    intent.vibrance += 3.0;
    intent.clarity -= 5.0;
    intent.shadows += 5.0;
    // Skin lives mostly in the red/orange/yellow channels. Nudge warmth and
    // luminance there, and pull a little saturation out so the result stays
    // photographic rather than orange.
    intent.hsl(0, 1.0, -2.0, 4.0);
    intent.hsl(1, 2.0, -4.0, 6.0);
    intent.hsl(2, 0.0, -3.0, 2.0);
}

fn apply_era(intent: &mut LookIntent, era: &'static str) {
    intent.era = Some(era);
    match era {
        "1950s" => {
            // Warm, gently faded, restrained colour and fine grain. The warm
            // white balance also rescues portraits shot under blue stage LEDs.
            // The finish is deliberately open (lifted shadows, protected
            // highlights): early colour film is warm, not crushed.
            intent.temperature = intent.temperature.max(24.0) + 2.0;
            intent.tint += 1.0;
            intent.contrast -= 2.0;
            intent.highlights -= 8.0;
            intent.shadows += 14.0;
            intent.blacks += 2.0;
            intent.whites += 4.0;
            intent.saturation -= 8.0;
            intent.vibrance += 4.0;
            intent.clarity -= 4.0;
            intent.grain += 8.0;
            intent.fade += 8.0;
            intent.glow += 4.0;
            intent.halation += 3.0;
            intent.vignette -= 6.0;
            intent.hsl(0, 2.0, 6.0, 2.0);
            intent.hsl(1, 2.0, 10.0, 4.0);
            intent.hsl(2, 0.0, -4.0, 0.0);
            intent.hsl(3, 0.0, -10.0, -2.0);
            intent.hsl(4, 0.0, -14.0, -4.0);
            intent.hsl(5, -2.0, -24.0, -8.0);
            intent.hsl(6, 0.0, -8.0, 0.0);
            intent.set_shadow_grade(35.0, 8.0);
            intent.set_mid_grade(32.0, 4.0);
            intent.set_highlight_grade(43.0, 14.0);
            intent.set_lut(LUT_GOLD_200, 34.0);
        }
        "1960s" => {
            intent.temperature = intent.temperature.max(6.0) + 1.0;
            intent.contrast += 3.0;
            intent.highlights -= 6.0;
            intent.shadows += 4.0;
            intent.saturation += 2.0;
            intent.vibrance += 4.0;
            intent.clarity -= 2.0;
            intent.grain += 5.0;
            intent.fade += 3.0;
            intent.hsl(1, 1.0, 6.0, 2.0);
            intent.hsl(5, -1.0, -10.0, -3.0);
            intent.set_shadow_grade(35.0, 5.0);
            intent.set_highlight_grade(40.0, 10.0);
            intent.set_lut(LUT_EKTAR_100, 30.0);
        }
        "1970s" => {
            intent.temperature = intent.temperature.max(10.0) + 2.0;
            intent.contrast -= 2.0;
            intent.highlights -= 8.0;
            intent.shadows += 8.0;
            intent.blacks += 4.0;
            intent.saturation -= 4.0;
            intent.vibrance += 6.0;
            intent.clarity -= 2.0;
            intent.grain += 12.0;
            intent.fade += 10.0;
            intent.glow += 2.0;
            intent.hsl(1, 1.0, 6.0, 3.0);
            intent.hsl(3, 3.0, 4.0, -2.0);
            intent.hsl(5, -1.0, -10.0, -4.0);
            intent.set_shadow_grade(30.0, 10.0);
            intent.set_highlight_grade(42.0, 12.0);
            intent.set_lut(LUT_GOLD_200, 38.0);
        }
        "1980s" => {
            intent.temperature = intent.temperature.min(-2.0);
            intent.contrast += 14.0;
            intent.highlights -= 10.0;
            intent.blacks -= 12.0;
            intent.saturation += 6.0;
            intent.vibrance += 8.0;
            intent.clarity += 8.0;
            intent.halation += 10.0;
            intent.grain += 4.0;
            intent.vignette -= 14.0;
            intent.hsl(5, 2.0, 4.0, -2.0);
            intent.hsl(7, 0.0, 10.0, 0.0);
            intent.set_shadow_grade(205.0, 16.0);
            intent.set_mid_grade(315.0, 4.0);
            intent.set_highlight_grade(35.0, 14.0);
            intent.set_lut(LUT_VISION_500T, 38.0);
        }
        "1990s" => {
            intent.contrast += 10.0;
            intent.highlights -= 12.0;
            intent.blacks -= 6.0;
            intent.saturation -= 8.0;
            intent.clarity += 4.0;
            intent.grain += 14.0;
            intent.fade += 6.0;
            intent.hsl(1, 0.0, -4.0, 0.0);
            intent.hsl(3, 3.0, 6.0, -2.0);
            intent.hsl(5, -1.0, -8.0, -3.0);
            intent.set_shadow_grade(120.0, 10.0);
            intent.set_highlight_grade(40.0, 6.0);
            intent.set_lut(LUT_FUJI_400H, 32.0);
        }
        "2000s" => {
            intent.temperature -= 2.0;
            intent.contrast += 10.0;
            intent.clarity += 10.0;
            intent.sharpness += 5.0;
            intent.hsl(4, 0.0, 4.0, 0.0);
            intent.set_shadow_grade(210.0, 8.0);
            intent.set_highlight_grade(40.0, 8.0);
            intent.set_lut(LUT_VISION_250D, 25.0);
        }
        _ => {}
    }
}

fn apply_reference(intent: &mut LookIntent, reference: &'static str) {
    intent.reference = Some(reference);
    match reference {
        "Glam Rock" => {
            // Queen / Freddie Mercury: a hard spotlight, gold and amber
            // highlights, deep blacks and rich reds/yellows. The blue stage
            // wash is deliberately pulled back so the performer reads warm.
            //
            // The look opens the face instead of only darkening it: a concert
            // frame is usually low-key, and the earlier -16 highlights / -2
            // shadows combination made the singer read almost as a silhouette.
            // A small brightness lift, lifted shadows and a protected highlight
            // give the skin its glow while the split tone and LUT carry the
            // period colour. Blue stage light is rescued below in
            // `adapt_look_to_photo`, where the measured cast is available.
            intent.temperature = intent.temperature.max(36.0) + 2.0;
            intent.tint += 5.0;
            intent.brightness += 2.0;
            intent.contrast += 16.0;
            intent.highlights -= 12.0;
            intent.shadows += 12.0;
            intent.blacks -= 10.0;
            intent.whites += 6.0;
            intent.vibrance += 16.0;
            intent.saturation += 2.0;
            intent.clarity += 14.0;
            intent.halation += 9.0;
            intent.glow += 2.0;
            intent.vignette -= 10.0;
            intent.grain += 4.0;
            intent.hsl(0, 2.0, 12.0, 4.0);
            intent.hsl(1, 2.0, 12.0, 8.0);
            intent.hsl(2, 0.0, 6.0, 6.0);
            intent.hsl(4, 0.0, -20.0, -8.0);
            intent.hsl(5, -2.0, -30.0, -14.0);
            intent.hsl(7, 0.0, 6.0, 0.0);
            intent.set_shadow_grade(30.0, 12.0);
            intent.set_mid_grade(30.0, 6.0);
            intent.set_highlight_grade(42.0, 22.0);
            intent.set_lut(LUT_GOLD_200, 45.0);
        }
        "Ziggy Glam" => {
            intent.temperature = intent.temperature.min(-4.0);
            intent.contrast += 18.0;
            intent.highlights -= 10.0;
            intent.blacks -= 14.0;
            intent.saturation += 6.0;
            intent.vibrance += 8.0;
            intent.clarity += 8.0;
            intent.halation += 8.0;
            intent.grain += 4.0;
            intent.vignette -= 14.0;
            intent.hsl(5, 2.0, 6.0, -2.0);
            intent.hsl(7, 0.0, 10.0, 0.0);
            intent.set_shadow_grade(205.0, 18.0);
            intent.set_mid_grade(315.0, 6.0);
            intent.set_highlight_grade(45.0, 18.0);
            intent.set_lut(LUT_VISION_250D, 40.0);
        }
        "Rockabilly" => {
            intent.temperature = intent.temperature.max(10.0) + 2.0;
            intent.contrast += 14.0;
            intent.highlights -= 10.0;
            intent.shadows += 2.0;
            intent.blacks -= 10.0;
            intent.saturation -= 4.0;
            intent.grain += 12.0;
            intent.fade += 4.0;
            intent.halation += 5.0;
            intent.vignette -= 10.0;
            intent.hsl(0, 1.0, 8.0, 1.0);
            intent.hsl(2, 0.0, 8.0, 2.0);
            intent.set_shadow_grade(30.0, 8.0);
            intent.set_highlight_grade(42.0, 14.0);
            intent.set_lut(LUT_GOLD_200, 38.0);
        }
        "British Invasion" => {
            intent.temperature = intent.temperature.max(6.0) + 1.0;
            intent.contrast += 8.0;
            intent.highlights -= 6.0;
            intent.saturation += 4.0;
            intent.vibrance += 6.0;
            intent.grain += 6.0;
            intent.fade += 3.0;
            intent.set_shadow_grade(35.0, 6.0);
            intent.set_highlight_grade(40.0, 10.0);
            intent.set_lut(LUT_EKTAR_100, 32.0);
        }
        "Grunge" => {
            intent.contrast += 14.0;
            intent.highlights -= 14.0;
            intent.shadows -= 2.0;
            intent.blacks -= 12.0;
            intent.saturation -= 14.0;
            intent.vibrance -= 4.0;
            intent.clarity += 6.0;
            intent.grain += 20.0;
            intent.fade += 8.0;
            intent.halation += 6.0;
            intent.vignette -= 16.0;
            intent.hsl(1, 0.0, -4.0, 0.0);
            intent.hsl(3, 3.0, 6.0, -2.0);
            intent.hsl(5, -1.0, -8.0, -3.0);
            intent.set_shadow_grade(120.0, 12.0);
            intent.set_highlight_grade(40.0, 8.0);
            intent.set_lut(LUT_FUJI_400H, 30.0);
        }
        "New Wave" => {
            intent.temperature = intent.temperature.min(-4.0);
            intent.contrast += 16.0;
            intent.highlights -= 10.0;
            intent.blacks -= 12.0;
            intent.saturation += 8.0;
            intent.vibrance += 8.0;
            intent.clarity += 8.0;
            intent.halation += 9.0;
            intent.grain += 4.0;
            intent.vignette -= 14.0;
            intent.hsl(5, 2.0, 6.0, -2.0);
            intent.hsl(7, 0.0, 10.0, 0.0);
            intent.set_shadow_grade(200.0, 18.0);
            intent.set_mid_grade(315.0, 6.0);
            intent.set_highlight_grade(330.0, 12.0);
            intent.set_lut(LUT_VISION_500T, 38.0);
        }
        "Classic Rock" => {
            intent.temperature = intent.temperature.max(8.0) + 1.0;
            intent.contrast += 12.0;
            intent.highlights -= 10.0;
            intent.blacks -= 10.0;
            intent.saturation -= 4.0;
            intent.clarity += 6.0;
            intent.grain += 10.0;
            intent.vignette -= 12.0;
            intent.hsl(0, 1.0, 6.0, 1.0);
            intent.hsl(2, 0.0, 4.0, 0.0);
            intent.set_shadow_grade(30.0, 8.0);
            intent.set_highlight_grade(42.0, 12.0);
            intent.set_lut(LUT_GOLD_200, 34.0);
        }
        "Hollywood Glamour" => {
            // Classic studio portrait: soft glow, strong cheekbones, warm
            // neutral skin. Not automatically black and white; the prompt
            // can still ask for monochrome.
            intent.temperature = intent.temperature.max(6.0) + 1.0;
            intent.contrast += 16.0;
            intent.highlights -= 12.0;
            intent.shadows += 8.0;
            intent.blacks -= 8.0;
            intent.clarity += 2.0;
            intent.glow += 8.0;
            intent.grain += 8.0;
            intent.vignette -= 18.0;
            intent.fade += 2.0;
            intent.hsl(0, 1.0, 4.0, 3.0);
            intent.hsl(1, 1.0, 4.0, 5.0);
            intent.set_shadow_grade(35.0, 6.0);
            intent.set_highlight_grade(43.0, 12.0);
            intent.set_lut(LUT_PORTRA_400, 25.0);
        }
        "Disco" => {
            intent.temperature = intent.temperature.max(6.0) + 1.0;
            intent.contrast += 8.0;
            intent.highlights -= 8.0;
            intent.saturation += 8.0;
            intent.vibrance += 10.0;
            intent.halation += 8.0;
            intent.glow += 4.0;
            intent.hsl(0, 1.0, 6.0, 1.0);
            intent.hsl(2, 0.0, 8.0, 2.0);
            intent.hsl(5, -1.0, -6.0, -2.0);
            intent.set_shadow_grade(30.0, 8.0);
            intent.set_highlight_grade(40.0, 14.0);
            intent.set_lut(LUT_GOLD_200, 35.0);
        }
        "Film Noir" => {
            intent.mono = true;
            intent.contrast += 18.0;
            intent.highlights -= 10.0;
            intent.shadows += 4.0;
            intent.blacks -= 14.0;
            intent.clarity += 4.0;
            intent.grain += 10.0;
            intent.vignette -= 18.0;
        }
        _ => {}
    }
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
            "subtle", "slight", "gentle", "barely", "suptiln", "blag", "nježn",
        ],
    ) {
        intent.strength = 0.62;
    } else if has(
        text,
        &[
            "extreme",
            "very strong",
            "over the top",
            "ekstremn",
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
            "izražen",
            "dramatičn",
        ],
    ) {
        intent.strength = 1.32;
    }

    // --- Colour stories ---------------------------------------------------
    if (has(text, &["teal"]) && has(text, &["orange"]))
        || (has(text, &["tirkiz"]) && has(text, &["narančast"]))
    {
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
            "moody", "dark", "low key", "low-key", "lowkey", "mračn", "tamn",
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
            "dramatic",
            "dramatic lighting",
            "dramatic light",
            "dramatičn",
        ],
    ) {
        // "Dramatic" is primarily a contrast/spotlight cue, not a request to
        // underexpose the frame. The old code treated it as "moody" and made
        // every AI-expanded prompt needlessly dark.
        intent.contrast += 7.0;
        intent.vignette -= 8.0;
        intent.highlight_grade(42.0, 8.0);
        intent.label("Dramatic");
    }

    if has(
        text,
        &[
            "spotlight",
            "spot light",
            "spot-lit",
            "stage light",
            "stage lighting",
            "stage lights",
            "reflektor",
        ],
    ) {
        intent.contrast += 4.0;
        intent.highlight_grade(42.0, 12.0);
        intent.vignette -= 10.0;
    }

    if has(
        text,
        &["deep blacks", "deep black", "crushed blacks", "duboke crne"],
    ) {
        intent.blacks -= 12.0;
        intent.contrast += 4.0;
    }

    if has(text, &["low contrast", "flat contrast", "meki kontrast"]) {
        intent.contrast -= 12.0;
        intent.shadows += 8.0;
    }

    if has(
        text,
        &[
            "bright",
            "airy",
            "high key",
            "high-key",
            "light and airy",
            "svijetl",
            "prozračn",
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

    let vintage_requested = has(
        text,
        &[
            "vintage",
            "retro",
            "analog",
            "analogue",
            "polaroid",
            "disposable",
            "starinsk",
        ],
    ) || (has_word(text, &["faded"])
        && !has(text, &["faded blacks", "faded black"]));
    if vintage_requested {
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

    if has(text, &["faded blacks", "faded black", "faded shadow"]) {
        intent.fade += 10.0;
        intent.blacks += 6.0;
    }

    if has(text, &["modern", "clean", "crisp", "moder", "čist"]) {
        intent.contrast += 9.0;
        intent.clarity += 8.0;
        intent.sharpness += 5.0;
        intent.dehaze += 3.0;
        intent.label("Modern");
    }

    if has(text, &["natural", "prirodn"]) {
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
            "živopisn",
            "kontrastn",
            "vibrantn",
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
            "mekan",
            "sanjiv",
            "pastel",
            "snolik",
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
        // A monochrome frame needs real blacks or it turns into a grey haze,
        // especially when the RAW preview is bright and low-contrast.
        intent.blacks -= 6.0;
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
            "zlatn",
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

    if has(text, &["warm", "toasty", "cozy", "topl"]) {
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
            "hladn",
            "plavkast",
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
        &[
            "green", "forest", "earthy", "zelen", "šuma", "zemljan", "smeđ",
        ],
    ) {
        intent.hsl(3, 6.0, 14.0, -4.0);
        intent.temperature += 1.0;
        intent.label("Earthy");
        intent.lut.get_or_insert(LUT_FUJI_400H);
        intent.lut_intensity = intent.lut_intensity.max(25.0);
    }

    if has(text, &["crimson", "crven"]) || has_word(text, &["red"]) {
        intent.hsl(0, 2.0, 16.0, -2.0);
        intent.highlight_grade(0.0, 10.0);
        intent.label("Red");
    }

    if has(text, &["ljubičast", "purpurn"]) || has_word(text, &["purple", "violet", "magenta"]) {
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
            "prigušen",
            "blijed",
            "bez boje",
        ],
    ) {
        intent.saturation -= 22.0;
        intent.vibrance -= 8.0;
        intent.label("Muted");
    }

    // --- Physical / finishing cues ---------------------------------------
    if has(
        text,
        &["fine grain", "subtle grain", "light grain", "fino zrno"],
    ) {
        intent.grain += 8.0;
        intent.label("Grain");
    } else if has(
        text,
        &[
            "heavy grain",
            "strong grain",
            "grainy",
            "filmic grain",
            "grain",
            "zrnat",
            "zrno",
        ],
    ) {
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
        &[
            "sharp",
            "crisp detail",
            "detailed",
            "clarity",
            "microcontrast",
            "oštro",
            "detaljno",
        ],
    ) {
        intent.sharpness += 12.0;
        intent.clarity += 8.0;
    }
    if has(text, &["dehaze", "remove haze", "ukloni maglu"]) {
        intent.dehaze += 12.0;
        intent.contrast += 3.0;
    }
    if has(text, &["soft skin", "skin tones", "skin", "koža"]) || has_word(text, &["ten"]) {
        intent.hsl(1, 2.0, -4.0, 6.0);
        intent.clarity -= 4.0;
    }
}

/// Explicit film-stock words are applied after era/artist cues, so
/// "1970s, Portra 400" keeps Portra instead of being forced back to Gold.
fn apply_film_stock(intent: &mut LookIntent, text: &str) {
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

    let subject = detect_subject(&text);
    if let Some(subject) = subject {
        apply_subject(&mut intent, subject);
    }

    // "Concert portrait" keeps the concert treatment but also protects skin;
    // treating it as one or the other loses half of the request.
    let portrait_requested =
        has(&text, &["portrait", "headshot", "portret", "portreti"]) || has_word(&text, &["model"]);
    if portrait_requested && subject != Some("portrait") {
        apply_portrait_modifier(&mut intent);
    }

    // Mood first, then the stronger era/artist references. A reference must be
    // able to replace the subject's default blue concert grade; an explicit
    // film stock can still replace the reference's default stock afterwards.
    apply_mood(&mut intent, &text);
    if let Some(era) = detect_era(&text) {
        apply_era(&mut intent, era);
    }
    if let Some(reference) = detect_reference(&text) {
        apply_reference(&mut intent, reference);
    }
    apply_film_stock(&mut intent, &text);

    // Nothing recognised: still return a gentle, usable baseline instead of
    // failing the request.
    if intent.labels.is_empty()
        && intent.subject.is_none()
        && intent.era.is_none()
        && intent.reference.is_none()
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

fn add_scalar(adjustments: &mut Value, key: &str, delta: f64) {
    let Some(object) = adjustments.as_object_mut() else {
        return;
    };
    let current = object.get(key).and_then(Value::as_f64).unwrap_or(0.0);
    object.insert(key.to_string(), json!(current + delta));
}

fn scale_scalar(adjustments: &mut Value, key: &str, factor: f64) {
    let Some(object) = adjustments.as_object_mut() else {
        return;
    };
    if let Some(current) = object.get(key).and_then(Value::as_f64) {
        object.insert(key.to_string(), json!(current * factor));
    }
}

fn scale_nested_saturation(adjustments: &mut Value, group: &str, factor: f64) {
    let Some(entries) = adjustments.get_mut(group).and_then(Value::as_object_mut) else {
        return;
    };
    for entry in entries.values_mut() {
        if let Some(saturation) = entry.get_mut("saturation") {
            if let Some(number) = saturation.as_f64() {
                *saturation = json!(number * factor);
            }
        }
    }
}

/// The four candidates must read as four different treatments, not four
/// contrast percentages of one preset. This adds a real soft/bold/film
/// character on top of the shared colour story: different curves, split-tone
/// strength, LUT blend, grain, halation, vignette and temperature.
fn apply_variant_character(adjustments: &mut Value, variant: Variant, intent: &LookIntent) {
    match variant {
        Variant::Balanced => {}
        Variant::Soft => {
            add_scalar(adjustments, "contrast", -3.0);
            add_scalar(adjustments, "clarity", -2.0);
            add_scalar(adjustments, "highlights", -6.0);
            add_scalar(adjustments, "shadows", 18.0);
            add_scalar(adjustments, "blacks", 12.0);
            add_scalar(adjustments, "whites", -4.0);
            add_scalar(adjustments, "saturation", -3.0);
            add_scalar(adjustments, "temperature", 3.0);
            add_scalar(adjustments, "grainAmount", 2.0);
            add_scalar(adjustments, "halationAmount", 4.0);
            add_scalar(adjustments, "glowAmount", 8.0);
            scale_scalar(adjustments, "vignetteAmount", 0.5);
            adjustments["grainSize"] = json!(22.0);
            adjustments["grainRoughness"] = json!(40.0);
            if !intent.mono {
                scale_nested_saturation(adjustments, "colorGrading", 0.7);
                scale_nested_saturation(adjustments, "hsl", 0.8);
            }
        }
        Variant::Bold => {
            add_scalar(adjustments, "contrast", 5.0);
            add_scalar(adjustments, "clarity", 2.0);
            add_scalar(adjustments, "highlights", -8.0);
            add_scalar(adjustments, "shadows", -4.0);
            add_scalar(adjustments, "blacks", -12.0);
            add_scalar(adjustments, "whites", 6.0);
            add_scalar(adjustments, "saturation", 6.0);
            add_scalar(adjustments, "vibrance", 4.0);
            add_scalar(adjustments, "temperature", -1.0);
            scale_scalar(adjustments, "grainAmount", 0.8);
            scale_scalar(adjustments, "halationAmount", 0.8);
            scale_scalar(adjustments, "glowAmount", 0.6);
            scale_scalar(adjustments, "vignetteAmount", 1.25);
            add_scalar(adjustments, "vignetteAmount", -6.0);
            adjustments["grainSize"] = json!(32.0);
            adjustments["grainRoughness"] = json!(55.0);
            if !intent.mono {
                scale_nested_saturation(adjustments, "colorGrading", 1.2);
                scale_nested_saturation(adjustments, "hsl", 1.15);
            }
        }
        Variant::Film => {
            add_scalar(adjustments, "contrast", -1.0);
            add_scalar(adjustments, "highlights", -4.0);
            add_scalar(adjustments, "shadows", 4.0);
            add_scalar(adjustments, "blacks", 4.0);
            add_scalar(adjustments, "temperature", 2.0);
            scale_scalar(adjustments, "grainAmount", 1.0);
            add_scalar(adjustments, "grainAmount", 14.0);
            add_scalar(adjustments, "halationAmount", 8.0);
            add_scalar(adjustments, "glowAmount", 4.0);
            adjustments["grainSize"] = json!(42.0);
            adjustments["grainRoughness"] = json!(60.0);
            if !intent.mono {
                scale_nested_saturation(adjustments, "colorGrading", 1.05);
                scale_nested_saturation(adjustments, "hsl", 0.95);
            }
        }
    }
}

fn build_adjustments(intent: &LookIntent, variant: Variant) -> Value {
    let strength = intent.strength;
    let (contrast_scale, clarity_scale, grain_scale, sat_scale) = match variant {
        Variant::Balanced => (1.0, 1.0, 1.0, 1.0),
        Variant::Soft => (0.65, 0.5, 0.6, 0.85),
        Variant::Bold => (1.35, 1.25, 1.1, 1.05),
        Variant::Film => (0.9, 0.9, 1.2, 0.95),
    };

    let scale = |value: f64| round(value * strength);
    // Cap the stacked intent *before* the variant scale so Balanced and Bold
    // stay distinct instead of both hitting the final clamp.
    let contrast_intent = intent.contrast.clamp(-20.0, 26.0);
    let blacks_intent = intent.blacks.clamp(-18.0, 20.0);
    let mut adjustments = json!({
        // Brightness is a -5..+5 stop control in the editor (the contrast,
        // saturation and colour tools use their own -100..100 scales). The
        // mood cues above use the same numeric scale as the other tools, so a
        // "moody" intent of -7 must become about -0.7 stops here. Writing -7
        // straight through used to crush the render almost to black.
        "brightness": round(clamp(scale(intent.brightness) / 10.0, -5.0, 5.0)),
        // The subject and mood blocks stack additively, so a prompt such as
        // "moody teal and orange concert" can otherwise land at +40 contrast
        // and -30 blacks, which can crush a bright linear RAW preview. The
        // learned photographer profile sits around +11 contrast / -20 blacks,
        // so the generated defaults stay close to that range.
        "contrast": round(clamp(scale(contrast_intent) * contrast_scale, -40.0, 34.0)),
        "highlights": round(clamp(scale(intent.highlights), -50.0, 60.0)),
        "shadows": round(clamp(scale(intent.shadows), -20.0, 60.0)),
        "whites": round(clamp(scale(intent.whites), -40.0, 40.0)),
        "blacks": round(clamp(scale(blacks_intent), -20.0, 40.0)),
        "clarity": round(clamp(scale(intent.clarity) * clarity_scale, -30.0, 40.0)),
        "dehaze": round(clamp(scale(intent.dehaze), -10.0, 30.0)),
        "vibrance": round(clamp(scale(intent.vibrance) * sat_scale, -40.0, 40.0)),
        "saturation": round(clamp(scale(intent.saturation) * sat_scale, -100.0, 30.0)),
        // Period/glam looks need a real warm shift on a blue stage wash; the
        // editor itself accepts -100..100. Keep the default prompts conservative
        // through the intent values, not by silently clipping the strong ones.
        "temperature": round(clamp(scale(intent.temperature), -60.0, 60.0)),
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

    // Variant character is applied after the split tone exists so Soft/Bold/Film
    // can genuinely change its strength rather than only the contrast slider.
    apply_variant_character(&mut adjustments, variant, intent);

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

    let fade = match variant {
        Variant::Soft => intent.fade + 6.0,
        Variant::Film => intent.fade + 10.0,
        Variant::Bold => intent.fade,
        Variant::Balanced => intent.fade,
    };
    let fade = clamp(scale(fade), 0.0, 32.0);
    let contrast = clamp(scale(contrast_intent) * contrast_scale, -40.0, 45.0);
    let curve_points = match variant {
        Variant::Soft => Some(vec![
            (0.0, fade + 2.0),
            (64.0, 64.0 + fade * 0.55 + 2.0),
            (128.0, 128.0 + fade * 0.15),
            (192.0, 191.0),
            (255.0, 252.0),
        ]),
        Variant::Bold => Some(vec![
            (0.0, 0.0),
            (48.0, 34.0),
            (128.0, 128.0),
            (200.0, 220.0),
            (255.0, 255.0),
        ]),
        Variant::Film => Some(vec![
            (0.0, fade + 4.0),
            (64.0, 64.0 + fade * 0.45),
            (128.0, 128.0),
            (192.0, 196.0),
            (255.0, 252.0),
        ]),
        Variant::Balanced if fade > 0.5 || intent.contrast.abs() > 8.0 => {
            let mid_lift = fade * 0.4;
            let shoulder = (contrast * 0.12).clamp(-8.0, 10.0);
            Some(vec![
                (0.0, fade),
                (64.0, 64.0 + mid_lift),
                (128.0, 128.0),
                (192.0, 192.0 + shoulder),
                (255.0, 255.0 - fade * 0.2),
            ])
        }
        Variant::Balanced => None,
    };
    if let Some(points) = curve_points {
        adjustments["curves"] = curves(&points, &[], &[], &[]);
    }

    let lut = match variant {
        Variant::Film if intent.lut.is_none() && !intent.mono => {
            Some((default_lut_for(intent), 48.0))
        }
        _ => intent.lut.map(|name| (name, intent.lut_intensity)),
    };
    if let Some((name, lut_intensity)) = lut
        && !intent.mono
    {
        let variant_intensity = match variant {
            Variant::Soft => lut_intensity * 0.70,
            Variant::Bold => lut_intensity * 1.15,
            Variant::Film => lut_intensity * 1.20,
            Variant::Balanced => lut_intensity,
        };
        adjustments["__lut_name"] = json!(name);
        adjustments["__lut_intensity"] = json!(round(clamp(variant_intensity, 0.0, 100.0)));
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

/// Describes the finished candidate rather than the abstract intent, so a Soft
/// variant is not advertised with the Balanced variant's punchy contrast, and a
/// monochrome look never mentions the film LUT that was dropped.
fn summary_from_adjustments(
    adjustments: &Value,
    intent: &LookIntent,
    lut: Option<&crate::style_profile::StyleProfileLut>,
) -> String {
    let mut traits: Vec<String> = Vec::new();
    if intent.mono {
        traits.push(if intent.sepia {
            "sepia tone".to_string()
        } else {
            "black and white".to_string()
        });
    }

    if !intent.mono || intent.sepia {
        let tinted = ["shadows", "midtones", "highlights"].iter().any(|band| {
            adjustments
                .get("colorGrading")
                .and_then(|grading| grading.get(*band))
                .and_then(|band| band.get("saturation"))
                .and_then(Value::as_f64)
                .unwrap_or(0.0)
                > 0.5
        });
        if tinted {
            traits.push("split toning".to_string());
        }
    }

    let value = |key: &str| adjustments.get(key).and_then(Value::as_f64).unwrap_or(0.0);

    let contrast = value("contrast");
    if contrast > 15.0 {
        traits.push("punchy contrast".to_string());
    } else if contrast < -6.0 {
        traits.push("soft contrast".to_string());
    }

    let temperature = value("temperature");
    if temperature > 4.0 {
        traits.push("warm white balance".to_string());
    } else if temperature < -4.0 {
        traits.push("cool white balance".to_string());
    }

    if value("grainAmount") > 4.0 {
        traits.push("subtle grain".to_string());
    }

    let faded = adjustments
        .get("curves")
        .and_then(|curves| curves.get("luma"))
        .and_then(|luma| luma.get(0))
        .and_then(|point| point.get("y"))
        .and_then(Value::as_f64)
        .unwrap_or(0.0)
        > 2.0;
    if faded {
        traits.push("faded blacks".to_string());
    }

    if !intent.mono && value("vibrance") > 10.0 {
        traits.push("vibrance boost".to_string());
    }

    if let Some(lut) = lut {
        traits.push(format!("{} LUT", lut.name));
    }

    if traits.is_empty() {
        "clean, natural color".to_string()
    } else {
        traits.join(", ")
    }
}

/// Specific requests name the result before generic adjectives: "cinematic
/// neon" should become "Neon Portrait", not "Cinematic Portrait".
const LABEL_PRIORITY: &[&str] = &[
    "Neon",
    "Golden Hour",
    "Teal & Orange",
    "Sepia",
    "Noir",
    "Black & White",
    "Vintage Film",
    "Matte",
    "Dreamy",
    "Punchy",
    "Airy",
    "Warm",
    "Cool",
    "Earthy",
    "Red",
    "Purple",
    "Muted",
    "Moody",
    "Cinematic",
    "Natural",
    "Modern",
];

fn preferred_label(intent: &LookIntent) -> Option<&str> {
    LABEL_PRIORITY
        .iter()
        .find(|preferred| intent.labels.iter().any(|label| label == *preferred))
        .copied()
        .or_else(|| intent.labels.first().copied())
}

fn base_label(intent: &LookIntent) -> String {
    let subject = if intent.portrait_modifier {
        // A named era/artist already supplies the context; "1950s Glam Rock
        // Portrait" reads better than "1950s Glam Rock Concert Portrait".
        if intent.reference.is_some() {
            "Portrait"
        } else if intent.subject == Some("concert") {
            "Concert Portrait"
        } else {
            "Portrait"
        }
    } else {
        intent.subject.map(subject_label).unwrap_or("Look")
    };

    let stage = match (intent.era, intent.reference) {
        (Some(era), Some(reference)) => Some(format!("{era} {reference}")),
        (Some(era), None) => Some(era.to_string()),
        (None, Some(reference)) => Some(reference.to_string()),
        _ => None,
    };
    let lead = stage.or_else(|| preferred_label(intent).map(str::to_string));
    match (intent.subject, lead) {
        // Avoid "Portra Portrait": when one label contains the other, the more
        // specific style already says everything.
        (Some(_), Some(lead))
            if lead.to_lowercase().contains(&subject.to_lowercase())
                || subject.to_lowercase().contains(&lead.to_lowercase()) =>
        {
            lead
        }
        (Some(_), Some(lead)) => format!("{lead} {subject}"),
        (Some(_), None) => format!("{subject} Look"),
        (None, Some(lead)) => lead,
        (None, None) => "Custom Look".to_string(),
    }
}

fn build_profile(
    prompt: &str,
    intent: &LookIntent,
    variant: Variant,
    ai_tags: Option<&str>,
) -> StyleProfile {
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

    let mut tags = intent.subject.map(subject_tags).unwrap_or_default();
    if intent.portrait_modifier {
        // "Concert portrait" must still match portrait photos when the saved
        // look is reused, so carry both vocabularies.
        for tag in subject_tags("portrait") {
            if !tags.contains(&tag) {
                tags.push(tag);
            }
        }
    }
    let traits = summary_from_adjustments(&adjustments, intent, lut.as_ref());
    let description = match ai_tags {
        Some(ai_tags) => {
            let ai_tags = ai_tags.trim();
            let ai_tags = if ai_tags.chars().count() > 240 {
                ai_tags.chars().take(237).collect::<String>() + "..."
            } else {
                ai_tags.to_string()
            };
            format!(
                "AI interpreted: {ai_tags}. Generated from \"{}\". {} variation: {}.",
                prompt.trim(),
                variant.label(),
                traits
            )
        }
        None => format!(
            "Generated from \"{}\". {} variation: {}.",
            prompt.trim(),
            variant.label(),
            traits
        ),
    };

    let id = if ai_tags.is_some() {
        format!("generated-ai-{}", uuid::Uuid::new_v4())
    } else {
        format!("generated-{}", uuid::Uuid::new_v4())
    };

    StyleProfile {
        id,
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

fn candidates_from_text(
    original_prompt: &str,
    effective_prompt: &str,
    ai_tags: Option<&str>,
) -> Result<Vec<StyleProfile>, String> {
    let prompt = original_prompt.trim();
    if prompt.is_empty() {
        return Err("Describe the look you want first.".to_string());
    }
    if prompt.chars().count() > 600 {
        return Err("Keep the description under 600 characters.".to_string());
    }

    let intent = interpret(effective_prompt);
    let variants = [
        Variant::Balanced,
        Variant::Soft,
        Variant::Bold,
        Variant::Film,
    ];
    Ok(variants
        .iter()
        .map(|variant| build_profile(prompt, &intent, *variant, ai_tags))
        .collect())
}

/// Turns a free-form prompt into four candidate looks. LUT paths are resolved
/// later by the command (they depend on the installation directory). Test-only
/// because the Tauri command uses the AI-aware entry point below.
#[cfg(test)]
pub fn generate_candidates(prompt: &str) -> Result<Vec<StyleProfile>, String> {
    candidates_from_text(prompt, prompt, None)
}

/// Generates the four looks. When `use_ai` is on and a local Ollama model is
/// available, the prompt is first expanded into photographic style tags
/// ("1950s", "glam rock", "warm golds", ...). The grade itself is still built
/// by the deterministic colour engine, so the result is fast and editable
/// instead of an unpredictable wall of invented slider values.
#[tauri::command]
pub async fn generate_style_candidates(
    prompt: String,
    use_ai: Option<bool>,
    app_handle: tauri::AppHandle,
) -> Result<Vec<StyleProfile>, String> {
    let original = prompt.trim().to_string();
    if original.is_empty() {
        return Err("Describe the look you want first.".to_string());
    }
    // Count characters, not UTF-8 bytes: a 300-character Croatian prompt is
    // 600+ bytes and used to be rejected even though the textarea allowed it.
    if original.chars().count() > 600 {
        return Err("Keep the description under 600 characters.".to_string());
    }

    let mut ai_tags: Option<String> = None;
    let effective = if use_ai.unwrap_or(true) {
        match crate::prompt_ai::expand_prompt(&original).await {
            Ok(tags) if !tags.trim().is_empty() => {
                let tags = tags.trim().to_string();
                ai_tags = Some(tags.clone());
                format!("{original}, {tags}")
            }
            _ => original.clone(),
        }
    } else {
        original.clone()
    };

    let mut candidates = candidates_from_text(&original, &effective, ai_tags.as_deref())?;
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
        build_profile(prompt, &intent, variant, None)
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
    fn brightness_uses_the_editor_stop_range() {
        // The editor's Brightness slider runs from -5 to +5 stops. Mood cues
        // are expressed on the wider -100..100 scale used by contrast, so they
        // must be converted rather than written straight into the profile.
        for prompt in [
            "moody dark concert",
            "bright airy portrait",
            "moody neon night portrait",
            "bright high key wedding",
        ] {
            for profile in generate_candidates(prompt).unwrap() {
                let brightness = number(&profile, "brightness");
                assert!(
                    (-5.0..=5.0).contains(&brightness),
                    "{prompt}: brightness {brightness} is outside the editor range"
                );
                assert!(
                    brightness.abs() <= 1.0,
                    "{prompt}: mood brightness {brightness} is too extreme"
                );
            }
        }
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
    fn croatian_colour_stems_need_both_colours_for_teal_and_orange() {
        let orange_only = named("narančasti tonovi", Variant::Balanced);
        assert!(!orange_only.name.contains("Teal & Orange"));

        let warm = named("topli portret", Variant::Balanced);
        assert!(number(&warm, "temperature") > 3.0);

        let cool = named("hladni portret", Variant::Balanced);
        assert!(number(&cool, "temperature") < 3.0);

        let teal_orange = named("tirkizno i narančasto", Variant::Balanced);
        assert!(teal_orange.name.contains("Teal & Orange"));
    }

    #[test]
    fn monochrome_description_does_not_mention_a_dropped_lut() {
        let profile = named("black and white portrait", Variant::Balanced);
        assert!(profile.lut.is_none());
        let description = profile.description.unwrap_or_default();
        assert!(!description.contains("LUT"), "{description}");
    }

    #[test]
    fn the_most_specific_label_names_the_look() {
        let neon = named("cinematic neon night portrait", Variant::Balanced);
        assert!(neon.name.starts_with("Neon"), "{}", neon.name);

        let teal = named("moody teal and orange concert", Variant::Balanced);
        assert!(teal.name.starts_with("Teal & Orange"), "{}", teal.name);
    }

    #[test]
    fn description_reflects_the_variant_that_was_built() {
        let soft = named("moody teal and orange concert, subtle", Variant::Soft);
        let bold = named("moody teal and orange concert, subtle", Variant::Bold);
        let soft_text = soft.description.unwrap_or_default();
        let bold_text = bold.description.unwrap_or_default();
        assert_ne!(soft_text, bold_text);
        assert!(
            !soft_text.contains("punchy contrast"),
            "the soft variant should not be described as punchy: {soft_text}"
        );
        assert!(bold_text.contains("punchy contrast"), "{bold_text}");
    }

    #[test]
    fn film_stock_label_does_not_repeat_the_subject() {
        let profile = named("Kodak Portra 400 portrait", Variant::Balanced);
        assert_eq!(profile.name, "Portra — Balanced");
        assert!(profile.detect_tags.iter().any(|tag| tag == "portrait"));
    }

    #[test]
    fn prompt_limit_counts_characters_not_bytes() {
        let croatian = "mračni koncert ".repeat(30); // 420 chars, 500+ bytes
        assert!(croatian.chars().count() <= 600);
        assert!(generate_candidates(&croatian).is_ok());

        let too_long = "a".repeat(601);
        assert!(generate_candidates(&too_long).is_err());
    }

    #[test]
    fn reddish_is_not_a_food_prompt() {
        let profile = named("reddish tones", Variant::Balanced);
        assert!(!profile.name.contains("Food"), "{}", profile.name);
        assert!(profile.lut.is_none(), "no food LUT should be selected");
    }

    #[test]
    fn clarity_and_dehaze_prompts_are_understood() {
        let clarity = named("clarity and detail", Variant::Balanced);
        assert!(number(&clarity, "clarity") > 0.0);
        assert!(number(&clarity, "sharpness") > 0.0);

        let dehaze = named("dehaze landscape", Variant::Balanced);
        assert!(number(&dehaze, "dehaze") > 0.0);
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

    #[test]
    fn fifties_queen_prompt_becomes_a_warm_glam_look() {
        let profile = named(
            "Make it 50s style portrait concert with Freddy Mercury style, queen",
            Variant::Balanced,
        );
        assert!(
            profile.name.starts_with("1950s Glam Rock"),
            "{}",
            profile.name
        );
        assert!(
            number(&profile, "temperature") > 10.0,
            "the blue stage wash should be warmed: {}",
            number(&profile, "temperature")
        );
        assert!(number(&profile, "grainAmount") > 5.0);
        let lut = profile.lut.expect("the era should choose a film stock");
        assert!(lut.name.contains("Gold"), "{}", lut.name);
        let blues = profile.adjustments["hsl"]["blues"]["saturation"]
            .as_f64()
            .unwrap_or(0.0);
        assert!(
            blues < -15.0,
            "blue stage light should be pulled back: {blues}"
        );
        assert!(profile.detect_tags.iter().any(|tag| tag == "concert"));
        assert!(profile.detect_tags.iter().any(|tag| tag == "portrait"));
        assert!(profile.id.starts_with("generated-"));
    }

    #[test]
    fn the_four_era_variants_are_visibly_different() {
        let prompt = "1950s glam rock concert portrait, queen";
        let balanced = named(prompt, Variant::Balanced);
        let soft = named(prompt, Variant::Soft);
        let bold = named(prompt, Variant::Bold);
        let film = named(prompt, Variant::Film);

        assert!(
            number(&soft, "shadows") > number(&bold, "shadows"),
            "Soft should open the shadows, Bold should keep them deep"
        );
        assert!(
            number(&bold, "contrast") > number(&soft, "contrast"),
            "Bold should be visibly contrastier than Soft"
        );
        assert!(
            number(&film, "grainAmount") > number(&balanced, "grainAmount"),
            "Film should carry noticeably more grain"
        );

        let lut_intensity =
            |profile: &StyleProfile| profile.lut.as_ref().map(|lut| lut.intensity).unwrap_or(0.0);
        assert!(lut_intensity(&soft) < lut_intensity(&balanced));
        assert!(lut_intensity(&bold) > lut_intensity(&balanced));
        assert!(lut_intensity(&film) > lut_intensity(&bold));

        let black_point = |profile: &StyleProfile| {
            profile.adjustments["curves"]["luma"][0]["y"]
                .as_f64()
                .unwrap_or(0.0)
        };
        assert!(
            black_point(&soft) > black_point(&bold),
            "Soft should have a lifted black point, Bold should not"
        );
    }

    #[test]
    fn decade_words_do_not_misfire_on_lens_or_iso_numbers() {
        let profile = named("50mm lens, ISO 1600 portrait", Variant::Balanced);
        assert!(!profile.name.starts_with("1950s"), "{}", profile.name);
        assert!(!profile.name.contains("Glam Rock"), "{}", profile.name);
    }
}
