use std::fmt;

use serde::{Deserialize, Serialize};
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

#[derive(Clone, Default, Serialize, Deserialize, PartialEq, Eq, TS)]
#[serde(deny_unknown_fields)]
#[ts(export)]
pub struct LlmConfig {
    pub provider: String,
    pub model: String,
    pub base_url: String,
    pub api_key: String,
    pub prompt: String,
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
            .finish()
    }
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
    pub mute_voice: bool,
    pub camera_fov: f64,
    pub viewmodel_fov: f64,
    pub flash_alpha: u8,
    pub show_hud: bool,
    pub isolate_target_voice: bool,
}

impl Default for RecordingDefaults {
    fn default() -> Self {
        Self {
            pre_roll_seconds: 3.0,
            post_roll_seconds: 2.5,
            resolution: "1920x1080".to_owned(),
            fps: 60,
            show_radar: true,
            mute_voice: false,
            camera_fov: 90.0,
            viewmodel_fov: 68.0,
            flash_alpha: 255,
            show_hud: true,
            isolate_target_voice: false,
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
