//! Optional local-AI prompt interpretation.
//!
//! The prompt-to-look generator ships with a deterministic photographic
//! interpreter so it works offline and without an account. When a local
//! [Ollama](https://ollama.com) instance is running, we additionally ask a
//! small language model to translate the user's wording into the photographic
//! vocabulary the interpreter understands. That is the part a keyword parser is
//! bad at: "Freddy Mercury, Queen" becomes "glam rock, spotlight, warm golds,
//! deep blacks", and "50s" becomes "1950s, faded blacks, restrained saturation,
//! fine grain".
//!
//! This is deliberately *not* image generation or a raw slider-value model.
//! The model only produces a short, auditable tag list; the local colour engine
//! renders the actual grade, so previews are fast, consistent and editable.

use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::json;

const DEFAULT_URL: &str = "http://127.0.0.1:11434";
const MAX_TAGS: usize = 480;

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PromptAiStatus {
    pub available: bool,
    pub model: Option<String>,
    pub url: String,
}

#[derive(Deserialize)]
struct TagsResponse {
    #[serde(default)]
    models: Vec<ModelEntry>,
}

#[derive(Deserialize)]
struct ModelEntry {
    name: String,
}

#[derive(Serialize)]
struct ChatMessage<'a> {
    role: &'a str,
    content: String,
}

#[derive(Serialize)]
struct ChatRequest<'a> {
    model: &'a str,
    messages: Vec<ChatMessage<'a>>,
    stream: bool,
    options: serde_json::Value,
}

#[derive(Deserialize)]
struct ChatResponse {
    message: ChatMessageResponse,
}

#[derive(Deserialize)]
struct ChatMessageResponse {
    content: String,
}

fn base_url() -> String {
    std::env::var("RR_OLLAMA_URL")
        .unwrap_or_else(|_| DEFAULT_URL.to_string())
        .trim_end_matches('/')
        .to_string()
}

/// Prefer small, fast text models. The app only needs reliable instruction
/// following and a short tag list, not a giant vision model: a 12B vision model
/// can take minutes per prompt on a CPU, which would make the feature unusable.
fn pick_model(models: &[ModelEntry]) -> Option<String> {
    const PREFERRED: &[&str] = &[
        "qwen2.5:7b",
        "qwen2.5-coder:7b",
        "qwen2.5:3b",
        "llama3.2:3b",
        "llama3.2:1b",
        "gemma3:4b",
        "gemma3:12b",
        "llava:7b",
        "minicpm-v",
    ];

    for preferred in PREFERRED {
        if let Some(model) = models.iter().find(|model| model.name == *preferred) {
            return Some(model.name.clone());
        }
    }
    // A tag at the end (e.g. "qwen2.5:7b-instruct-q4_K_M") still matches the
    // family name; accept the first model rather than reporting "unavailable".
    models.first().map(|model| model.name.clone())
}

pub async fn status() -> PromptAiStatus {
    let url = base_url();
    let client = match reqwest::Client::builder()
        .timeout(Duration::from_secs(3))
        .build()
    {
        Ok(client) => client,
        Err(_) => {
            return PromptAiStatus {
                available: false,
                model: None,
                url,
            };
        }
    };

    let response = match client.get(format!("{url}/api/tags")).send().await {
        Ok(response) if response.status().is_success() => response,
        _ => {
            return PromptAiStatus {
                available: false,
                model: None,
                url,
            };
        }
    };
    let tags: TagsResponse = match response.json().await {
        Ok(tags) => tags,
        Err(_) => {
            return PromptAiStatus {
                available: false,
                model: None,
                url,
            };
        }
    };
    let model = pick_model(&tags.models);
    PromptAiStatus {
        available: model.is_some(),
        model,
        url,
    }
}

fn system_prompt() -> String {
    r#"You are a photographic style translator for a RAW editor. Convert the user's request into a short comma-separated list of visual style tags. Do not explain. Maximum 14 tags.

Vocabulary (use these exact words when relevant):
Subjects: concert, portrait, wedding, street, landscape, night, festival, sports, wildlife, architecture, food, product, automotive
Eras: 1950s, 1960s, 1970s, 1980s, 1990s, 2000s
References: glam rock, film noir, Hollywood glamour, rockabilly, grunge, new wave, disco
Moods: cinematic, moody, airy, dramatic, soft, punchy, vintage, modern, natural
Colour: warm, cool, teal and orange, monochrome, sepia, neon, muted, golden hour
Light: low-key, high-key, backlit, soft highlights, spotlight, stage lighting
Film: Portra 400, Gold 200, Ektar 100, Fuji 400H, Vision 250D, Vision 500T, Tri-X 400, Cinestill 800T
Finish: fine grain, heavy grain, halation, glow, vignette, faded blacks, deep blacks, high contrast, low contrast

Reference knowledge:
- Freddie Mercury / Queen / glam rock => glam rock, dramatic, spotlight, warm golds, deep blacks, high contrast, halation, concert
- 1950s / fifties => 1950s, warm, faded blacks, restrained saturation, low contrast, fine grain
- David Bowie / Ziggy => glam rock, cool, high contrast, teal and orange, halation
- Elvis / rockabilly => 1950s, warm, high contrast, Gold 200, fine grain
- Nirvana / grunge => 1990s, grunge, muted, green, heavy grain, high contrast
- 1980s / new wave => 1980s, cool, punchy, neon, halation

Preserve every subject and explicit request. Do not invent a different subject. Output only the comma-separated tags, no quotes, no preamble."#
        .to_string()
}

/// Asks Ollama to expand the prompt into photographic tags. Returns an error
/// (never blocks forever) when Ollama is absent or the model is too slow; the
/// caller then falls back to the local keyword interpreter.
pub async fn expand_prompt(prompt: &str) -> Result<String, String> {
    let status = status().await;
    let Some(model) = status.model else {
        return Err("No local Ollama model is available".to_string());
    };

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(45))
        .build()
        .map_err(|error| error.to_string())?;

    let payload = ChatRequest {
        model: &model,
        messages: vec![
            ChatMessage {
                role: "system",
                content: system_prompt(),
            },
            ChatMessage {
                role: "user",
                content: prompt.trim().to_string(),
            },
        ],
        stream: false,
        options: json!({
            "temperature": 0.2,
            "num_predict": 120,
            "num_ctx": 4096,
        }),
    };

    let response = client
        .post(format!("{}/api/chat", status.url))
        .json(&payload)
        .send()
        .await
        .map_err(|error| format!("Ollama request failed: {error}"))?;

    if !response.status().is_success() {
        return Err(format!(
            "Ollama returned {}: {}",
            response.status(),
            response.text().await.unwrap_or_default()
        ));
    }

    let body: ChatResponse = response
        .json()
        .await
        .map_err(|error| format!("Ollama returned invalid JSON: {error}"))?;

    let tags = body
        .message
        .content
        .trim()
        .trim_matches('`')
        .trim_matches('"')
        .replace('\n', ", ")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    if tags.is_empty() {
        return Err("Ollama returned an empty tag list".to_string());
    }
    let tags: String = tags.chars().take(MAX_TAGS).collect();
    Ok(filter_semantic_tags(&tags))
}

/// The model tends to echo back finishing words from the reference guide
/// ("high contrast", "deep blacks", "halation"). The local `Glam Rock` /
/// `1950s` recipes already contain those, so appending them again doubles the
/// grade and produces an over-processed look. Keep only the tags that carry
/// *semantics* the keyword parser cannot infer on its own: era, artist/reference,
/// subject and film stock. Explicit words in the user's own prompt (e.g. "extra
/// high contrast", "teal and orange") are still parsed normally.
fn filter_semantic_tags(tags: &str) -> String {
    const KEEP: &[&str] = &[
        "1950",
        "1960",
        "1970",
        "1980",
        "1990",
        "2000",
        "fifties",
        "sixties",
        "seventies",
        "eighties",
        "nineties",
        "y2k",
        "glam",
        "rockabilly",
        "grunge",
        "new wave",
        "disco",
        "noir",
        "hollywood",
        "british invasion",
        "classic rock",
        "concert",
        "portrait",
        "wedding",
        "street",
        "landscape",
        "festival",
        "sports",
        "wildlife",
        "architecture",
        "food",
        "product",
        "automotive",
        "portra",
        "ektar",
        "fuji",
        "vision",
        "cinestill",
        "tri-x",
        "ilford",
    ];
    const DECADES: &[&str] = &["50s", "60s", "70s", "80s", "90s", "00s"];

    tags.split(',')
        .map(str::trim)
        .filter(|tag| !tag.is_empty())
        .filter(|tag| {
            let lower = tag.to_lowercase();
            KEEP.iter().any(|key| lower.contains(key))
                || DECADES.contains(&lower.as_str())
                || lower == "gold"
                || lower.contains("gold 200")
                || lower.contains("kodak gold")
        })
        .collect::<Vec<_>>()
        .join(", ")
}

#[tauri::command]
pub async fn get_prompt_ai_status() -> PromptAiStatus {
    status().await
}

#[cfg(test)]
mod tests {
    #[test]
    fn semantic_filter_keeps_era_and_reference_but_drops_double_grading() {
        let filtered = super::filter_semantic_tags(
            "1950s, glam rock, dramatic, spotlight, warm golds, deep blacks, high contrast, halation, concert, portrait",
        );
        assert_eq!(filtered, "1950s, glam rock, concert, portrait");
    }

    /// Manual integration check; ignored because it needs a running Ollama.
    /// Run with: `cargo test --lib prompt_ai -- --ignored --nocapture`
    #[tokio::test]
    #[ignore]
    async fn real_ollama_expands_the_queen_prompt() {
        let tags = super::expand_prompt(
            "Make it 50s style portrait concert with Freddy Mercury style, queen",
        )
        .await
        .expect("Ollama should be running for this manual test");
        println!("AI tags: {tags}");
        let lower = tags.to_lowercase();
        assert!(lower.contains("1950s"), "{tags}");
        assert!(lower.contains("glam"), "{tags}");
    }
}
