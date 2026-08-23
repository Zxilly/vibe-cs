use std::fmt;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use ts_rs::TS;

#[derive(Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct AppConfig {
    pub locale: String,
    pub theme: String,
    /// Optional administrator-controlled HTTPS manifest used for manual update checks.
    pub update_manifest_url: String,
    pub data_dir: String,
    pub demo_watch_paths: Vec<String>,
    pub cs2_path: String,
    pub steam_path: String,
    pub steam: SteamConfig,
    pub llm: LlmConfig,
    pub recording: RecordingDefaults,
}

impl fmt::Debug for AppConfig {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("AppConfig")
            .field("locale", &self.locale)
            .field("theme", &self.theme)
            .field("update_manifest_url", &self.update_manifest_url)
            .field("data_dir", &self.data_dir)
            .field("demo_watch_paths", &self.demo_watch_paths)
            .field("cs2_path", &self.cs2_path)
            .field("steam_path", &self.steam_path)
            .field("steam", &self.steam)
            .field("llm", &self.llm)
            .field("recording", &self.recording)
            .finish()
    }
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            locale: "zh-CN".to_owned(),
            theme: "light".to_owned(),
            update_manifest_url: String::new(),
            data_dir: String::new(),
            demo_watch_paths: Vec::new(),
            cs2_path: String::new(),
            steam_path: String::new(),
            steam: SteamConfig::default(),
            llm: LlmConfig::default(),
            recording: RecordingDefaults::default(),
        }
    }
}

#[derive(Clone, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(deny_unknown_fields)]
#[ts(export)]
pub struct SteamConfig {
    pub steam_id: String,
    pub web_api_key: String,
    pub authentication_code: String,
    pub known_share_code: String,
    pub maximum_results: u32,
}

impl fmt::Debug for SteamConfig {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("SteamConfig")
            .field("steam_id", &self.steam_id)
            .field("web_api_key", &secret_debug_value(&self.web_api_key))
            .field(
                "authentication_code",
                &secret_debug_value(&self.authentication_code),
            )
            .field(
                "known_share_code",
                &secret_debug_value(&self.known_share_code),
            )
            .field("maximum_results", &self.maximum_results)
            .finish()
    }
}

impl Default for SteamConfig {
    fn default() -> Self {
        Self {
            steam_id: String::new(),
            web_api_key: String::new(),
            authentication_code: String::new(),
            known_share_code: String::new(),
            maximum_results: 20,
        }
    }
}

fn secret_debug_value(value: &str) -> &'static str {
    if value.is_empty() {
        "unset"
    } else {
        "[REDACTED]"
    }
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum LlmParameterStyle {
    #[default]
    #[serde(rename = "openai")]
    #[ts(rename = "openai")]
    OpenAi,
    Anthropic,
}

#[derive(Clone, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(deny_unknown_fields)]
#[ts(export)]
pub struct LlmConfig {
    pub provider: String,
    pub model: String,
    pub base_url: String,
    pub api_key: String,
    pub prompt: String,
    #[serde(default)]
    pub parameter_style: LlmParameterStyle,
    #[serde(default = "empty_provider_parameters")]
    pub parameters: Value,
}

impl Default for LlmConfig {
    fn default() -> Self {
        Self {
            provider: String::new(),
            model: String::new(),
            base_url: String::new(),
            api_key: String::new(),
            prompt: String::new(),
            parameter_style: LlmParameterStyle::OpenAi,
            parameters: empty_provider_parameters(),
        }
    }
}

impl fmt::Debug for LlmConfig {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("LlmConfig")
            .field("provider", &self.provider)
            .field("model", &self.model)
            .field("base_url", &self.base_url)
            .field(
                "api_key",
                &if self.api_key.is_empty() {
                    "unset"
                } else {
                    "[REDACTED]"
                },
            )
            .field("prompt", &self.prompt)
            .field("parameter_style", &self.parameter_style)
            .field(
                "parameter_keys",
                &self
                    .parameters
                    .as_object()
                    .map(|parameters| parameters.keys().collect::<Vec<_>>()),
            )
            .finish()
    }
}

fn empty_provider_parameters() -> Value {
    Value::Object(Map::new())
}

/// Validate the provider-owned portion of an LLM request without interpreting
/// model-specific fields. Vibe CS owns the conversation and tool protocol, so
/// those structural fields cannot be replaced by configuration.
pub fn validate_llm_provider_parameters(parameters: &Value) -> Result<(), String> {
    const MAXIMUM_PARAMETER_BYTES: usize = 64 * 1024;
    const RESERVED: &[&str] = &[
        "api_key",
        "base_url",
        "function_call",
        "functions",
        "messages",
        "model",
        "stream",
        "stream_options",
        "system",
        "tool_choice",
        "tools",
    ];
    let object = parameters
        .as_object()
        .ok_or_else(|| "LLM provider parameters must be a JSON object".to_owned())?;
    let serialized = serde_json::to_vec(parameters)
        .map_err(|error| format!("LLM provider parameters are invalid: {error}"))?;
    if serialized.len() > MAXIMUM_PARAMETER_BYTES {
        return Err("LLM provider parameters must not exceed 64 KiB".to_owned());
    }
    for key in object.keys() {
        let normalized = key.to_ascii_lowercase();
        if key.is_empty() || key.len() > 128 || key.chars().any(char::is_control) {
            return Err(
                "LLM provider parameter names must contain 1 to 128 printable bytes".to_owned(),
            );
        }
        if RESERVED.contains(&normalized.as_str()) {
            return Err(format!(
                "LLM provider parameter '{key}' is owned by the Agent runtime"
            ));
        }
    }
    Ok(())
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, TS)]
#[serde(deny_unknown_fields)]
#[allow(
    clippy::struct_excessive_bools,
    reason = "independent managed-HLAE presentation toggles are part of the current config contract"
)]
#[ts(export)]
pub struct RecordingDefaults {
    pub pre_roll_seconds: f64,
    pub post_roll_seconds: f64,
    pub resolution: String,
    pub fps: u32,
    pub show_radar: bool,
    pub camera_fov: f64,
    pub viewmodel_fov: f64,
    pub flash_alpha: u8,
    pub show_hud: bool,
    /// What the recorder does with voice communication.
    ///
    /// One three-valued enum rather than the two booleans this used to be
    /// (`mute_voice` + `isolate_target_voice`). Two booleans express four
    /// states and only three of them are legal — the fourth, "mute everyone
    /// *and* isolate the target", was rejected at runtime as the first thing
    /// `presentation` did. A configuration shape that can hold an illegal
    /// value needs a guard at every read; one that cannot, does not. §10 note 5
    /// scheduled this collapse for the settings pane that finally exposes it.
    pub voice: crate::RecordingVoicePolicy,
}

impl Default for RecordingDefaults {
    fn default() -> Self {
        Self {
            pre_roll_seconds: 3.0,
            post_roll_seconds: 2.5,
            resolution: "1920x1080".to_owned(),
            fps: 60,
            show_radar: true,
            camera_fov: 90.0,
            viewmodel_fov: 68.0,
            flash_alpha: 255,
            show_hud: true,
            voice: crate::RecordingVoicePolicy::AllPlayers,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DependencyStatus {
    pub name: String,
    pub available: bool,
    pub version: Option<String>,
    pub path: Option<String>,
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SetupStatus {
    pub ready: bool,
    pub dependencies: Vec<DependencyStatus>,
}

/// Read-only product status for the managed HLAE integration.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(deny_unknown_fields)]
#[allow(
    clippy::struct_excessive_bools,
    reason = "independent installation and immutable safety-policy facts are part of the status wire contract"
)]
#[ts(export)]
pub struct HlaeStatus {
    pub available: bool,
    pub executable: Option<String>,
    pub source2_hook: Option<String>,
    pub source: Option<String>,
    /// Reviewed application-managed portable release. Preparing it is an
    /// explicit user action and never launches or injects into CS2.
    pub managed_release: ManagedHlaeReleaseStatus,
    pub messages: Vec<String>,
    pub cs2_executable: Option<String>,
    /// True when the typed launch-profile inputs are present.
    pub launch_profile_ready: bool,
    /// True only for the integrity-verified managed release used by explicit
    /// recording jobs. AI proposal previews and exports remain process-free.
    pub automatic_launch_enabled: bool,
    pub insecure_mode_required: bool,
    pub vac_servers_prohibited: bool,
    pub demo_playback_only: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(deny_unknown_fields)]
#[ts(export)]
pub struct ManagedHlaeReleaseStatus {
    pub version: String,
    pub archive_sha256: String,
    pub signing_fingerprint: String,
    pub prepared: bool,
}
