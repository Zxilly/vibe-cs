use std::fmt;

use serde::{Deserialize, Serialize};

#[derive(Clone, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct AppConfig {
    pub locale: String,
    pub theme: String,
    /// Optional administrator-controlled HTTPS manifest used for manual update checks.
    pub update_manifest_url: String,
    pub data_dir: String,
    pub demo_watch_paths: Vec<String>,
    pub ffmpeg_path: String,
    pub ffprobe_path: String,
    pub preferred_encoder: String,
    pub cs2_path: String,
    /// Optional user-selected HLAE.exe. Discovery also checks conservative
    /// common locations when this is empty.
    pub hlae_path: String,
    pub steam_path: String,
    pub steam: SteamConfig,
    pub obs: ObsConfig,
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
            .field("ffmpeg_path", &self.ffmpeg_path)
            .field("ffprobe_path", &self.ffprobe_path)
            .field("preferred_encoder", &self.preferred_encoder)
            .field("cs2_path", &self.cs2_path)
            .field("hlae_path", &self.hlae_path)
            .field("steam_path", &self.steam_path)
            .field("steam", &self.steam)
            .field("obs", &self.obs)
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
            ffmpeg_path: String::new(),
            ffprobe_path: String::new(),
            preferred_encoder: "auto".to_owned(),
            cs2_path: String::new(),
            hlae_path: String::new(),
            steam_path: String::new(),
            steam: SteamConfig::default(),
            obs: ObsConfig::default(),
            llm: LlmConfig::default(),
            recording: RecordingDefaults::default(),
        }
    }
}

#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(default)]
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

#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(default)]
pub struct ObsConfig {
    pub host: String,
    pub port: u16,
    pub password: String,
    pub executable: String,
    pub scene: String,
}

impl fmt::Debug for ObsConfig {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ObsConfig")
            .field("host", &self.host)
            .field("port", &self.port)
            .field(
                "password",
                &if self.password.is_empty() {
                    "unset"
                } else {
                    "[REDACTED]"
                },
            )
            .field("executable", &self.executable)
            .field("scene", &self.scene)
            .finish()
    }
}

impl Default for ObsConfig {
    fn default() -> Self {
        Self {
            host: "127.0.0.1".to_owned(),
            port: 4455,
            password: String::new(),
            executable: String::new(),
            scene: String::new(),
        }
    }
}

#[derive(Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(default)]
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

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(default)]
#[allow(
    clippy::struct_excessive_bools,
    reason = "independent capture toggles and their explicit restoration state are part of the stable config wire contract"
)]
pub struct RecordingDefaults {
    pub pre_roll_seconds: f64,
    pub post_roll_seconds: f64,
    pub transition_seconds: f64,
    pub resolution: String,
    pub fps: u32,
    pub show_radar: bool,
    pub radar_restore_visible: bool,
    pub show_keyboard: bool,
    pub mute_voice: bool,
    pub voice_restore_volume: f64,
    pub camera_fov: f64,
    pub camera_fov_restore: f64,
    pub viewmodel_fov: f64,
    pub viewmodel_fov_restore: f64,
    pub flash_alpha: u8,
    pub flash_alpha_restore: u8,
    pub grenade_trajectory: bool,
    pub grenade_trajectory_restore: bool,
    pub show_hud: bool,
    pub hud_restore_visible: bool,
    pub isolate_target_voice: bool,
    /// Optional absolute directory containing user-provided first-person HUD assets.
    pub first_person_hud_assets: String,
    pub obs_realtime_kill_fx_media: String,
    pub obs_realtime_keyboard_media: String,
    pub capture_delay_ms: i64,
}

impl Default for RecordingDefaults {
    fn default() -> Self {
        Self {
            pre_roll_seconds: 3.0,
            post_roll_seconds: 2.5,
            transition_seconds: 0.35,
            resolution: "1920x1080".to_owned(),
            fps: 60,
            show_radar: true,
            radar_restore_visible: true,
            show_keyboard: false,
            mute_voice: false,
            voice_restore_volume: 1.0,
            camera_fov: 90.0,
            camera_fov_restore: 90.0,
            viewmodel_fov: 68.0,
            viewmodel_fov_restore: 68.0,
            flash_alpha: 255,
            flash_alpha_restore: 255,
            grenade_trajectory: false,
            grenade_trajectory_restore: false,
            show_hud: true,
            hud_restore_visible: true,
            isolate_target_voice: false,
            first_person_hud_assets: String::new(),
            obs_realtime_kill_fx_media: String::new(),
            obs_realtime_keyboard_media: String::new(),
            capture_delay_ms: 0,
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

/// Read-only product status for the process-free HLAE integration.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[allow(
    clippy::struct_excessive_bools,
    reason = "independent installation and immutable safety-policy facts are part of the status wire contract"
)]
pub struct HlaeStatus {
    pub available: bool,
    pub configured_path: Option<String>,
    pub executable: Option<String>,
    pub source2_hook: Option<String>,
    pub source: Option<String>,
    pub checked_locations: Vec<String>,
    pub messages: Vec<String>,
    pub cs2_executable: Option<String>,
    /// True when the typed launch-profile inputs are present. Vibe CS still
    /// never starts HLAE or CS2 from an AI proposal.
    pub launch_profile_ready: bool,
    pub automatic_launch_enabled: bool,
    pub insecure_mode_required: bool,
    pub vac_servers_prohibited: bool,
    pub demo_playback_only: bool,
}
