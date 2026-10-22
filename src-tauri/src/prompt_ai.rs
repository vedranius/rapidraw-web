//! Optional AI prompt interpretation.
//!
//! The prompt-to-look generator ships with a deterministic photographic
//! interpreter so it works offline and without an account. When an AI provider
//! is configured, we additionally ask the model to translate the user's wording
//! into the photographic vocabulary the interpreter understands. That is the
//! part a keyword parser is bad at: "Freddy Mercury, Queen" becomes "glam rock,
//! spotlight, warm golds, deep blacks", and "50s" becomes "1950s, faded blacks,
//! restrained saturation, fine grain".
//!
//! Three providers are supported:
//!
//! * local [Ollama](https://ollama.com) (default, private and free),
//! * any OpenAI-compatible `/chat/completions` endpoint (ChatGPT/OpenAI,
//!   OpenRouter, LM Studio, vLLM, OpenCode-compatible gateways, ...),
//! * the Anthropic Messages API (Claude).
//!
//! This is deliberately *not* image generation or a raw slider-value model.
//! The model only produces a short, auditable tag list; the local colour engine
//! renders the actual grade, the histogram guard checks exposure/clipping, so
//! previews are fast, consistent and editable.

use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::json;
use tauri::AppHandle;

use crate::app_settings::{PromptAiConfig, load_settings};

const DEFAULT_OLLAMA_URL: &str = "http://127.0.0.1:11434";
const DEFAULT_OPENAI_URL: &str = "https://api.openai.com/v1";
const DEFAULT_ANTHROPIC_URL: &str = "https://api.anthropic.com/v1";
const MAX_TAGS: usize = 480;

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PromptAiStatus {
    pub available: bool,
    pub model: Option<String>,
    pub url: String,
    pub provider: String,
    pub configured: bool,
    pub models: Vec<String>,
    pub detail: Option<String>,
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
struct OllamaChatRequest<'a> {
    model: &'a str,
    messages: Vec<ChatMessage<'a>>,
    stream: bool,
    keep_alive: &'a str,
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

#[derive(Serialize)]
struct OpenAiChatRequest<'a> {
    model: &'a str,
    messages: Vec<ChatMessage<'a>>,
    temperature: f64,
    max_tokens: u32,
    stream: bool,
}

#[derive(Deserialize)]
struct OpenAiChatResponse {
    #[serde(default)]
    choices: Vec<OpenAiChoice>,
}

#[derive(Deserialize)]
struct OpenAiChoice {
    message: OpenAiChoiceMessage,
}

#[derive(Deserialize)]
struct OpenAiChoiceMessage {
    content: Option<String>,
}

#[derive(Deserialize)]
struct OpenAiModelsResponse {
    #[serde(default)]
    data: Vec<OpenAiModelEntry>,
}

#[derive(Deserialize)]
struct OpenAiModelEntry {
    id: String,
}

#[derive(Serialize)]
struct AnthropicChatRequest<'a> {
    model: &'a str,
    max_tokens: u32,
    system: String,
    messages: Vec<ChatMessage<'a>>,
}

#[derive(Deserialize)]
struct AnthropicChatResponse {
    #[serde(default)]
    content: Vec<AnthropicBlock>,
}

#[derive(Deserialize)]
struct AnthropicBlock {
    #[serde(default)]
    text: Option<String>,
}

fn normalized_provider(config: &PromptAiConfig) -> &'static str {
    match config.provider.trim().to_lowercase().as_str() {
        "openai" | "open-ai" | "openai-compatible" | "openai_compatible" | "custom" | "chatgpt"
        | "openrouter" | "lmstudio" | "opencode" => "openai",
        "anthropic" | "claude" => "anthropic",
        _ => "ollama",
    }
}

fn clean_base_url(value: Option<&String>, fallback: &str) -> String {
    value
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
        .unwrap_or(fallback)
        .trim_end_matches('/')
        .to_string()
}

fn base_url(config: &PromptAiConfig) -> String {
    match normalized_provider(config) {
        "openai" => clean_base_url(config.base_url.as_ref(), DEFAULT_OPENAI_URL),
        "anthropic" => clean_base_url(config.base_url.as_ref(), DEFAULT_ANTHROPIC_URL),
        _ => {
            // Keep the environment override used by headless/test setups.
            let env_url = std::env::var("RR_OLLAMA_URL").ok();
            clean_base_url(
                config.base_url.as_ref().or(env_url.as_ref()),
                DEFAULT_OLLAMA_URL,
            )
        }
    }
}

fn openai_models_url(base: &str) -> String {
    if base.ends_with("/models") {
        base.to_string()
    } else if let Some(base) = base.strip_suffix("/chat/completions") {
        format!("{base}/models")
    } else if base.ends_with("/v1") {
        format!("{base}/models")
    } else {
        format!("{base}/v1/models")
    }
}

fn openai_chat_url(base: &str) -> String {
    if base.ends_with("/chat/completions") {
        base.to_string()
    } else if base.ends_with("/v1") {
        format!("{base}/chat/completions")
    } else {
        format!("{base}/v1/chat/completions")
    }
}

fn anthropic_messages_url(base: &str) -> String {
    if base.ends_with("/messages") {
        base.to_string()
    } else if base.ends_with("/v1") {
        format!("{base}/messages")
    } else {
        format!("{base}/v1/messages")
    }
}

fn anthropic_models_url(base: &str) -> String {
    if base.ends_with("/models") {
        base.to_string()
    } else if let Some(base) = base.strip_suffix("/messages") {
        format!("{base}/models")
    } else if base.ends_with("/v1") {
        format!("{base}/models")
    } else {
        format!("{base}/v1/models")
    }
}

/// Prefer small, fast text models. The app only needs reliable instruction
/// following and a short tag list, not a giant vision model: a 12B vision model
/// can take minutes per prompt on a CPU, which would make the feature unusable.
fn pick_model(models: &[String]) -> Option<String> {
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
        if let Some(model) = models.iter().find(|model| model == preferred) {
            return Some(model.clone());
        }
    }
    // A tag at the end (e.g. "qwen2.5:7b-instruct-q4_K_M") still matches the
    // family name; accept the first model rather than reporting "unavailable".
    models.first().cloned()
}

fn configured_model(config: &PromptAiConfig) -> Option<String> {
    config
        .model
        .as_ref()
        .map(|model| model.trim())
        .filter(|model| !model.is_empty())
        .map(str::to_string)
}

fn configured_key(config: &PromptAiConfig) -> Option<String> {
    config
        .api_key
        .as_ref()
        .map(|key| key.trim())
        .filter(|key| !key.is_empty())
        .map(str::to_string)
}

fn configured_timeout(config: &PromptAiConfig) -> Duration {
    Duration::from_secs(config.timeout_secs.unwrap_or(120).clamp(10, 300))
}

fn status_from(
    provider: &str,
    available: bool,
    model: Option<String>,
    url: String,
    configured: bool,
    models: Vec<String>,
    detail: Option<String>,
) -> PromptAiStatus {
    PromptAiStatus {
        available,
        model,
        url,
        provider: provider.to_string(),
        configured,
        models,
        detail,
    }
}

async fn ollama_status(config: &PromptAiConfig) -> PromptAiStatus {
    let url = base_url(config);
    let client = match reqwest::Client::builder()
        .timeout(Duration::from_secs(4))
        .build()
    {
        Ok(client) => client,
        Err(error) => {
            return status_from(
                "ollama",
                false,
                None,
                url,
                true,
                Vec::new(),
                Some(error.to_string()),
            );
        }
    };

    let response = match client.get(format!("{url}/api/tags")).send().await {
        Ok(response) if response.status().is_success() => response,
        Ok(response) => {
            return status_from(
                "ollama",
                false,
                configured_model(config),
                url,
                true,
                Vec::new(),
                Some(format!("Ollama returned {}", response.status())),
            );
        }
        Err(error) => {
            return status_from(
                "ollama",
                false,
                configured_model(config),
                url,
                true,
                Vec::new(),
                Some(error.to_string()),
            );
        }
    };
    let tags: TagsResponse = match response.json().await {
        Ok(tags) => tags,
        Err(error) => {
            return status_from(
                "ollama",
                false,
                configured_model(config),
                url,
                true,
                Vec::new(),
                Some(format!("Invalid Ollama response: {error}")),
            );
        }
    };
    let models: Vec<String> = tags.models.into_iter().map(|model| model.name).collect();
    let wanted = configured_model(config);
    let model = wanted
        .as_ref()
        .filter(|model| models.is_empty() || models.iter().any(|entry| entry == *model))
        .cloned()
        .or_else(|| pick_model(&models));
    let detail = match (&wanted, &model) {
        (Some(wanted), Some(model)) if wanted != model && !models.is_empty() => Some(format!(
            "Configured model '{wanted}' is not installed; using '{model}'."
        )),
        _ => None,
    };
    status_from("ollama", model.is_some(), model, url, true, models, detail)
}

async fn openai_status(config: &PromptAiConfig) -> PromptAiStatus {
    let url = base_url(config);
    let model = configured_model(config);
    // Local OpenAI-compatible servers (LM Studio, vLLM, OpenCode gateways)
    // often run without an API key, so only the model is mandatory here.
    let key = configured_key(config);
    let configured = model.is_some();
    if !configured {
        return status_from(
            "openai",
            false,
            model,
            url,
            false,
            Vec::new(),
            Some("Enter the endpoint URL and model name.".to_string()),
        );
    }

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(5))
        .build();
    let Ok(client) = client else {
        return status_from("openai", true, model, url, true, Vec::new(), None);
    };
    let mut request = client.get(openai_models_url(&url));
    if let Some(key) = key {
        request = request.bearer_auth(key);
    }
    match request.send().await {
        Ok(response) if response.status().is_success() => {
            let models: Vec<String> = response
                .json::<OpenAiModelsResponse>()
                .await
                .map(|body| body.data.into_iter().map(|entry| entry.id).collect())
                .unwrap_or_default();
            let chosen = model
                .clone()
                .filter(|wanted| models.is_empty() || models.iter().any(|entry| entry == wanted))
                .or_else(|| models.first().cloned());
            status_from("openai", chosen.is_some(), chosen, url, true, models, None)
        }
        Ok(response) => status_from(
            "openai",
            true,
            model,
            url,
            true,
            Vec::new(),
            Some(format!(
                "The endpoint did not list models ({}); it will be used for chat completions.",
                response.status()
            )),
        ),
        Err(error) => status_from(
            "openai",
            true,
            model,
            url,
            true,
            Vec::new(),
            Some(format!(
                "Could not reach the model list endpoint: {error}. Chat completions will still be attempted."
            )),
        ),
    }
}

async fn anthropic_status(config: &PromptAiConfig) -> PromptAiStatus {
    let url = base_url(config);
    let model = configured_model(config);
    let key = configured_key(config);
    let configured = model.is_some() && key.is_some();
    if !configured {
        return status_from(
            "anthropic",
            false,
            model,
            url,
            false,
            Vec::new(),
            Some("Enter the Claude API key and model name.".to_string()),
        );
    }

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(5))
        .build();
    let Ok(client) = client else {
        return status_from("anthropic", true, model, url, true, Vec::new(), None);
    };
    let request = client
        .get(anthropic_models_url(&url))
        .header("x-api-key", key.unwrap_or_default())
        .header("anthropic-version", "2023-06-01");
    match request.send().await {
        Ok(response) if response.status().is_success() => {
            let models: Vec<String> = response
                .json::<OpenAiModelsResponse>()
                .await
                .map(|body| body.data.into_iter().map(|entry| entry.id).collect())
                .unwrap_or_default();
            let chosen = model
                .clone()
                .filter(|wanted| models.is_empty() || models.iter().any(|entry| entry == wanted))
                .or_else(|| models.first().cloned());
            status_from(
                "anthropic",
                chosen.is_some(),
                chosen,
                url,
                true,
                models,
                None,
            )
        }
        Ok(response) => status_from(
            "anthropic",
            true,
            model,
            url,
            true,
            Vec::new(),
            Some(format!(
                "Claude did not list models ({}); the Messages API will still be attempted.",
                response.status()
            )),
        ),
        Err(error) => status_from(
            "anthropic",
            true,
            model,
            url,
            true,
            Vec::new(),
            Some(format!(
                "Could not reach Claude: {error}. Messages will still be attempted."
            )),
        ),
    }
}

pub async fn status_for_config(config: &PromptAiConfig) -> PromptAiStatus {
    match normalized_provider(config) {
        "openai" => openai_status(config).await,
        "anthropic" => anthropic_status(config).await,
        _ => ollama_status(config).await,
    }
}

pub async fn status(app_handle: AppHandle) -> PromptAiStatus {
    let config = load_settings(app_handle)
        .map(|settings| settings.prompt_ai)
        .unwrap_or_default();
    status_for_config(&config).await
}

fn system_prompt() -> String {
    r#"You are a photographic style translator for a RAW editor. Convert the user's request into a short comma-separated list of visual style tags. Do not explain. Maximum 14 tags.

Think like a photographer before answering:
- Preserve the subject, era and any artist/reference the user named.
- The final image must stay photographically plausible: a median tone roughly in the 0.04-0.80 luma range, no accidental blown highlights, no crushed shadows, no green/magenta skin casts and no flat primary-colour wash.
- Do not invent a different subject or a different decade.
- Prefer a coherent look over a pile of contradictory adjectives.
- If the prompt is already a complete style, add only the semantic context (era, reference, subject, film stock). Do not repeat finishing words such as "high contrast", "halation" or "deep blacks"; the local renderer already derives those from the reference.

Vocabulary (use these exact words when relevant):
Subjects: concert, portrait, wedding, street, landscape, night, festival, sports, wildlife, architecture, food, product, automotive
Eras: 1950s, 1960s, 1970s, 1980s, 1990s, 2000s
References: glam rock, film noir, Hollywood glamour, rockabilly, grunge, new wave, disco, motown, punk, jazz, editorial fashion
Moods: cinematic, moody, airy, dramatic, soft, punchy, vintage, modern, natural, editorial
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
- Blade Runner / cyberpunk => neon, teal and orange, night, cinematic
- Wes Anderson => 1960s, pastel, symmetrical, editorial
- Annie Leibovitz => editorial fashion, portrait, dramatic, soft highlights
- Motown / soul => 1960s, warm, saturated, Gold 200
- punk / CBGB => 1970s, punk, high contrast, gritty, Tri-X 400

Preserve every subject and explicit request. Output only the comma-separated tags, no quotes, no preamble."#
        .to_string()
}

fn extract_tags(raw: &str) -> Result<String, String> {
    let tags = raw
        .trim()
        .trim_matches('`')
        .trim_matches('"')
        .replace('\n', ", ")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    if tags.is_empty() {
        return Err("The AI returned an empty tag list".to_string());
    }
    let tags: String = tags.chars().take(MAX_TAGS).collect();
    let filtered = filter_semantic_tags(&tags);
    if filtered.trim().is_empty() {
        return Err("The AI returned no usable photographic tags".to_string());
    }
    Ok(filtered)
}

async fn expand_ollama(config: &PromptAiConfig, prompt: &str) -> Result<String, String> {
    let status = ollama_status(config).await;
    let Some(model) = status.model else {
        return Err(status
            .detail
            .unwrap_or_else(|| "No local Ollama model is available".to_string()));
    };

    let client = reqwest::Client::builder()
        // A dead host must fail in seconds, not sit on the full generation
        // timeout while the user waits for a fallback.
        .connect_timeout(Duration::from_secs(5))
        .timeout(configured_timeout(config))
        .build()
        .map_err(|error| error.to_string())?;

    let payload = OllamaChatRequest {
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
        // Keep the model warm between the four/eight previews; the first
        // request is what usually times out when a model has to be loaded.
        keep_alive: "15m",
        options: json!({
            "temperature": 0.1,
            "top_p": 0.9,
            "num_predict": 96,
            "num_ctx": 2048,
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
    extract_tags(&body.message.content)
}

async fn expand_openai(config: &PromptAiConfig, prompt: &str) -> Result<String, String> {
    let url = base_url(config);
    let model = configured_model(config)
        .ok_or_else(|| "Enter an OpenAI-compatible model name first.".to_string())?;
    let key = configured_key(config);

    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(5))
        .timeout(configured_timeout(config))
        .build()
        .map_err(|error| error.to_string())?;
    let payload = OpenAiChatRequest {
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
        temperature: 0.1,
        max_tokens: 140,
        stream: false,
    };
    let mut request = client.post(openai_chat_url(&url)).json(&payload);
    if let Some(key) = key {
        request = request.bearer_auth(key);
    }
    let response = request
        .send()
        .await
        .map_err(|error| format!("AI endpoint request failed: {error}"))?;
    if !response.status().is_success() {
        return Err(format!(
            "AI endpoint returned {}: {}",
            response.status(),
            response.text().await.unwrap_or_default()
        ));
    }
    let body: OpenAiChatResponse = response
        .json()
        .await
        .map_err(|error| format!("AI endpoint returned invalid JSON: {error}"))?;
    let content = body
        .choices
        .into_iter()
        .find_map(|choice| choice.message.content)
        .unwrap_or_default();
    extract_tags(&content)
}

async fn expand_anthropic(config: &PromptAiConfig, prompt: &str) -> Result<String, String> {
    let url = base_url(config);
    let model =
        configured_model(config).ok_or_else(|| "Enter a Claude model name first.".to_string())?;
    let key = configured_key(config).ok_or_else(|| "Enter a Claude API key first.".to_string())?;

    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(5))
        .timeout(configured_timeout(config))
        .build()
        .map_err(|error| error.to_string())?;
    let payload = AnthropicChatRequest {
        model: &model,
        max_tokens: 160,
        system: system_prompt(),
        messages: vec![ChatMessage {
            role: "user",
            content: prompt.trim().to_string(),
        }],
    };
    let response = client
        .post(anthropic_messages_url(&url))
        .header("x-api-key", key)
        .header("anthropic-version", "2023-06-01")
        .json(&payload)
        .send()
        .await
        .map_err(|error| format!("Claude request failed: {error}"))?;
    if !response.status().is_success() {
        return Err(format!(
            "Claude returned {}: {}",
            response.status(),
            response.text().await.unwrap_or_default()
        ));
    }
    let body: AnthropicChatResponse = response
        .json()
        .await
        .map_err(|error| format!("Claude returned invalid JSON: {error}"))?;
    let content = body
        .content
        .into_iter()
        .filter_map(|block| block.text)
        .collect::<Vec<_>>()
        .join(" ");
    extract_tags(&content)
}

/// Expands a prompt with the configured provider. The caller falls back to the
/// deterministic interpreter on any error, so a slow or offline provider can
/// never block the feature.
pub async fn expand_prompt_with_config(
    config: &PromptAiConfig,
    prompt: &str,
) -> Result<String, String> {
    if prompt.trim().is_empty() {
        return Err("The prompt is empty".to_string());
    }
    match normalized_provider(config) {
        "openai" => expand_openai(config, prompt).await,
        "anthropic" => expand_anthropic(config, prompt).await,
        _ => expand_ollama(config, prompt).await,
    }
}

pub async fn expand_prompt(app_handle: &AppHandle, prompt: &str) -> Result<String, String> {
    let config = load_settings(app_handle.clone())
        .map(|settings| settings.prompt_ai)
        .unwrap_or_default();
    expand_prompt_with_config(&config, prompt).await
}

/// The model tends to echo back finishing words from the reference guide
/// ("high contrast", "deep blacks", "halation"). The local `Glam Rock` /
/// `1950s` recipes already contain those, so appending them again doubles the
/// grade and produces an over-processed look. Keep only the tags that carry
/// *semantics* the keyword parser cannot infer on its own: era, artist/reference,
/// subject, film stock and a few colour-story words that are not merely
/// finishing touches. Explicit words in the user's own prompt (e.g. "extra high
/// contrast", "teal and orange") are still parsed normally.
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
        "motown",
        "punk",
        "jazz",
        "editorial",
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
        "neon",
        "teal and orange",
        "monochrome",
        "sepia",
        "golden hour",
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
pub async fn get_prompt_ai_status(app_handle: AppHandle) -> PromptAiStatus {
    status(app_handle).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn semantic_filter_keeps_era_and_reference_but_drops_double_grading() {
        let filtered = super::filter_semantic_tags(
            "1950s, glam rock, dramatic, spotlight, warm golds, deep blacks, high contrast, halation, concert, portrait",
        );
        assert_eq!(filtered, "1950s, glam rock, concert, portrait");
    }

    #[test]
    fn semantic_filter_keeps_colour_story_words() {
        let filtered = super::filter_semantic_tags(
            "Blade Runner, cyberpunk, neon, teal and orange, high contrast, halation",
        );
        assert!(filtered.contains("neon"));
        assert!(filtered.contains("teal and orange"));
        assert!(!filtered.contains("high contrast"));
    }

    #[test]
    fn external_urls_work_with_or_without_v1() {
        assert_eq!(
            openai_chat_url("https://api.openai.com/v1"),
            "https://api.openai.com/v1/chat/completions"
        );
        assert_eq!(
            openai_chat_url("https://openrouter.ai/api/v1"),
            "https://openrouter.ai/api/v1/chat/completions"
        );
        assert_eq!(
            openai_chat_url("http://localhost:1234/v1"),
            "http://localhost:1234/v1/chat/completions"
        );
        assert_eq!(
            anthropic_messages_url("https://api.anthropic.com"),
            "https://api.anthropic.com/v1/messages"
        );
        assert_eq!(
            openai_models_url("https://api.openai.com/v1"),
            "https://api.openai.com/v1/models"
        );
    }

    /// Manual integration check; ignored because it needs a running Ollama.
    /// Run with: `cargo test --lib prompt_ai -- --ignored --nocapture`
    #[tokio::test]
    #[ignore]
    async fn real_ollama_expands_the_queen_prompt() {
        let tags = super::expand_prompt_with_config(
            &PromptAiConfig::default(),
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
