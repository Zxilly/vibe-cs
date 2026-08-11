use std::{convert::Infallible, io, path::Path};

use axum::{
    Json, Router,
    extract::State,
    response::sse::{Event, KeepAlive, Sse},
    routing::{get, post},
};
use chrono::Utc;
use futures_util::stream;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use vibe_cs_domain::{AppConfig, DependencyStatus, SetupStatus};
use vibe_cs_integrations::discover_paths;
use walkdir::WalkDir;

use crate::{ApiError, ApiJson, ApiResult, AppState};

pub(crate) fn router() -> Router<AppState> {
    Router::new()
        .route("/api/v1/health", get(health))
        .route("/api/v1/app/runtime-state", get(runtime_state))
        .route("/api/v1/config", get(get_config).put(put_config))
        .route("/api/v1/config/detect-paths", post(detect_paths))
        .route("/api/v1/config/quick-check", get(quick_check))
        .route("/api/v1/storage/status", get(storage_status))
        .route("/api/v1/status/setup", get(setup_status))
}

const MAXIMUM_STORAGE_SCAN_ENTRIES: usize = 500_000;

#[derive(Debug, Serialize)]
struct StorageStatusResponse {
    data_dir: String,
    directory_bytes: u64,
    filesystem_total_bytes: u64,
    filesystem_available_bytes: u64,
    file_count: u64,
    directory_count: u64,
    scan_complete: bool,
    checked_at: chrono::DateTime<Utc>,
}

#[derive(Debug, Default, PartialEq, Eq)]
struct DirectoryUsage {
    bytes: u64,
    files: u64,
    directories: u64,
    complete: bool,
}

async fn storage_status(State(state): State<AppState>) -> ApiResult<Json<StorageStatusResponse>> {
    let data_dir = state.data_dir().clone();
    let snapshot = tokio::task::spawn_blocking(move || storage_snapshot(&data_dir))
        .await
        .map_err(|error| {
            crate::ApiError::new(
                axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                "storage_status_failed",
                format!("storage status task failed: {error}"),
            )
        })??;
    Ok(Json(snapshot))
}

fn storage_snapshot(data_dir: &Path) -> io::Result<StorageStatusResponse> {
    std::fs::create_dir_all(data_dir)?;
    let usage = directory_usage(data_dir, MAXIMUM_STORAGE_SCAN_ENTRIES);
    Ok(StorageStatusResponse {
        data_dir: data_dir.to_string_lossy().into_owned(),
        directory_bytes: usage.bytes,
        filesystem_total_bytes: fs4::total_space(data_dir)?,
        filesystem_available_bytes: fs4::available_space(data_dir)?,
        file_count: usage.files,
        directory_count: usage.directories,
        scan_complete: usage.complete,
        checked_at: Utc::now(),
    })
}

fn directory_usage(root: &Path, maximum_entries: usize) -> DirectoryUsage {
    let mut usage = DirectoryUsage {
        complete: true,
        ..DirectoryUsage::default()
    };
    for (index, entry) in WalkDir::new(root)
        .follow_links(false)
        .max_depth(32)
        .into_iter()
        .enumerate()
    {
        if index >= maximum_entries {
            usage.complete = false;
            break;
        }
        let Ok(entry) = entry else {
            usage.complete = false;
            continue;
        };
        let Ok(metadata) = entry.metadata() else {
            usage.complete = false;
            continue;
        };
        if metadata.is_file() {
            usage.files = usage.files.saturating_add(1);
            usage.bytes = usage.bytes.saturating_add(metadata.len());
        } else if metadata.is_dir() {
            usage.directories = usage.directories.saturating_add(1);
        }
    }
    usage
}

#[derive(Debug, Serialize)]
#[allow(
    clippy::struct_field_names,
    reason = "the stable wire contract names each independently detected value with a _path suffix"
)]
struct DetectedPathsResponse {
    cs2_path: Option<String>,
    steam_path: Option<String>,
    obs_path: Option<String>,
    ffmpeg_path: Option<String>,
    ffprobe_path: Option<String>,
}

async fn detect_paths(State(state): State<AppState>) -> ApiResult<Json<DetectedPathsResponse>> {
    let config = state.storage.get_config().await?.unwrap_or_default();
    let paths = tokio::task::spawn_blocking(move || discover_paths(&config))
        .await
        .map_err(|error| {
            crate::ApiError::new(
                axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                "path_discovery_failed",
                format!("dependency discovery task failed: {error}"),
            )
        })?;
    Ok(Json(DetectedPathsResponse {
        cs2_path: lossy_path(paths.cs2.as_deref()),
        steam_path: lossy_path(paths.steam.as_deref()),
        obs_path: lossy_path(paths.obs.as_deref()),
        ffmpeg_path: lossy_path(paths.ffmpeg.as_deref()),
        ffprobe_path: lossy_path(paths.ffprobe.as_deref()),
    }))
}

fn lossy_path(path: Option<&Path>) -> Option<String> {
    path.map(|path| path.to_string_lossy().into_owned())
}

#[derive(Debug, Serialize)]
struct HealthResponse {
    status: &'static str,
    version: &'static str,
    started_at: chrono::DateTime<Utc>,
}

async fn health(State(state): State<AppState>) -> Json<HealthResponse> {
    Json(HealthResponse {
        status: "ok",
        version: env!("CARGO_PKG_VERSION"),
        started_at: state.started_at,
    })
}

#[derive(Debug, Serialize)]
struct RuntimeStateResponse {
    status: &'static str,
    version: &'static str,
    started_at: chrono::DateTime<Utc>,
    data_dir: String,
    active_recording_job: Option<uuid::Uuid>,
    runtime_session: &'static str,
}

async fn runtime_state(State(state): State<AppState>) -> Json<RuntimeStateResponse> {
    let (runtime_session, active_recording_job) = state.runtime_session_snapshot().await;
    Json(RuntimeStateResponse {
        status: "ready",
        version: env!("CARGO_PKG_VERSION"),
        started_at: state.started_at,
        data_dir: state.data_dir().to_string_lossy().into_owned(),
        active_recording_job,
        runtime_session,
    })
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[allow(
    clippy::struct_excessive_bools,
    reason = "wire compatibility exposes one presence bit per independently stored secret"
)]
struct ConfigDto {
    language: String,
    theme: String,
    update_manifest_url: String,
    game_path: String,
    demo_watch_paths: Vec<String>,
    ffmpeg_path: String,
    obs_host: String,
    obs_port: u16,
    output_directory: String,
    preferred_encoder: String,
    analysis_mode: String,
    locale: String,
    data_dir: String,
    ffprobe_path: String,
    cs2_path: String,
    steam_path: String,
    steam: vibe_cs_domain::SteamConfig,
    steam_has_web_api_key: bool,
    steam_has_authentication_code: bool,
    steam_has_share_code: bool,
    obs: vibe_cs_domain::ObsConfig,
    obs_has_password: bool,
    llm: vibe_cs_domain::LlmConfig,
    llm_has_api_key: bool,
    recording: vibe_cs_domain::RecordingDefaults,
}

impl From<AppConfig> for ConfigDto {
    fn from(config: AppConfig) -> Self {
        let analysis_mode = if config.llm.provider.is_empty() {
            "local"
        } else {
            "assisted"
        }
        .to_owned();
        let mut obs = config.obs;
        let obs_has_password = !obs.password.is_empty();
        obs.password.clear();
        let mut llm = config.llm;
        let llm_has_api_key = !llm.api_key.is_empty();
        llm.api_key.clear();
        let mut steam = config.steam;
        let steam_has_web_api_key = !steam.web_api_key.is_empty();
        let steam_has_authentication_code = !steam.authentication_code.is_empty();
        let steam_has_share_code = !steam.known_share_code.is_empty();
        steam.web_api_key.clear();
        steam.authentication_code.clear();
        steam.known_share_code.clear();
        Self {
            language: config.locale.clone(),
            theme: config.theme.clone(),
            update_manifest_url: config.update_manifest_url.clone(),
            game_path: config.cs2_path.clone(),
            demo_watch_paths: config.demo_watch_paths.clone(),
            ffmpeg_path: config.ffmpeg_path.clone(),
            obs_host: obs.host.clone(),
            obs_port: obs.port,
            output_directory: config.data_dir.clone(),
            preferred_encoder: config.preferred_encoder,
            analysis_mode,
            locale: config.locale,
            data_dir: config.data_dir,
            ffprobe_path: config.ffprobe_path,
            cs2_path: config.cs2_path,
            steam_path: config.steam_path,
            steam,
            steam_has_web_api_key,
            steam_has_authentication_code,
            steam_has_share_code,
            obs,
            obs_has_password,
            llm,
            llm_has_api_key,
            recording: config.recording,
        }
    }
}

#[derive(Debug, Deserialize)]
struct CompatibleConfigInput {
    language: String,
    theme: String,
    #[serde(default)]
    update_manifest_url: String,
    game_path: String,
    #[serde(default)]
    demo_watch_paths: Vec<String>,
    ffmpeg_path: String,
    obs_host: String,
    obs_port: u16,
    output_directory: String,
    #[serde(default)]
    preferred_encoder: String,
    #[serde(default)]
    analysis_mode: String,
}

async fn get_config(State(state): State<AppState>) -> ApiResult<Json<ConfigDto>> {
    let config = state.storage.get_config().await?.unwrap_or_default();
    Ok(Json(config.into()))
}

async fn put_config(
    State(state): State<AppState>,
    ApiJson(input): ApiJson<Value>,
) -> ApiResult<Json<ConfigDto>> {
    let current = state.storage.get_config().await?.unwrap_or_default();
    let config = if input.get("locale").is_some() || input.get("obs").is_some() {
        let mut updated = serde_json::from_value::<AppConfig>(input)
            .map_err(|error| crate::ApiError::invalid(error.to_string()))?;
        if is_secret_placeholder(&updated.obs.password) {
            updated.obs.password.clone_from(&current.obs.password);
        }
        if is_secret_placeholder(&updated.llm.api_key) {
            updated.llm.api_key.clone_from(&current.llm.api_key);
        }
        if is_secret_placeholder(&updated.steam.web_api_key) {
            updated
                .steam
                .web_api_key
                .clone_from(&current.steam.web_api_key);
        }
        if is_secret_placeholder(&updated.steam.authentication_code) {
            updated
                .steam
                .authentication_code
                .clone_from(&current.steam.authentication_code);
        }
        if is_secret_placeholder(&updated.steam.known_share_code) {
            updated
                .steam
                .known_share_code
                .clone_from(&current.steam.known_share_code);
        }
        updated
    } else {
        let input = serde_json::from_value::<CompatibleConfigInput>(input)
            .map_err(|error| crate::ApiError::invalid(error.to_string()))?;
        let _ = &input.analysis_mode;
        let preferred_encoder = if input.preferred_encoder.trim().is_empty() {
            current.preferred_encoder.clone()
        } else {
            input.preferred_encoder
        };
        AppConfig {
            locale: input.language,
            theme: input.theme,
            update_manifest_url: input.update_manifest_url,
            data_dir: input.output_directory,
            demo_watch_paths: input.demo_watch_paths,
            ffmpeg_path: input.ffmpeg_path,
            preferred_encoder,
            cs2_path: input.game_path,
            obs: vibe_cs_domain::ObsConfig {
                host: input.obs_host,
                port: input.obs_port,
                ..current.obs
            },
            ..current
        }
    };
    validate_config(&config)?;
    let config = state.storage.put_config(config).await?;
    state
        .demo_watch
        .reconfigure(config.demo_watch_paths.clone())
        .await?;
    state.events.publish("config", "updated", None);
    Ok(Json(config.into()))
}

fn validate_config(config: &AppConfig) -> ApiResult<()> {
    if !config.update_manifest_url.trim().is_empty() {
        super::product::validate_configured_manifest_url(&config.update_manifest_url)?;
    }
    if config.demo_watch_paths.len() > 64 {
        return Err(crate::ApiError::invalid(
            "at most 64 demo watch directories may be configured",
        ));
    }
    if config
        .demo_watch_paths
        .iter()
        .any(|path| path.trim().is_empty() || !Path::new(path).is_absolute())
    {
        return Err(crate::ApiError::invalid(
            "demo watch directories must be non-empty absolute paths",
        ));
    }
    let recording = &config.recording;
    if !recording.pre_roll_seconds.is_finite()
        || !(0.0..=15.0).contains(&recording.pre_roll_seconds)
        || !recording.post_roll_seconds.is_finite()
        || !(0.0..=15.0).contains(&recording.post_roll_seconds)
    {
        return Err(crate::ApiError::invalid(
            "recording pre/post-roll must be between 0 and 15 seconds",
        ));
    }
    if !recording.transition_seconds.is_finite()
        || !(0.0..=2.0).contains(&recording.transition_seconds)
    {
        return Err(crate::ApiError::invalid(
            "recording transition must be between 0 and 2 seconds",
        ));
    }
    if !matches!(
        recording.resolution.as_str(),
        "1920x1080" | "2560x1440" | "3840x2160"
    ) {
        return Err(crate::ApiError::invalid(
            "recording resolution is not supported",
        ));
    }
    if !matches!(recording.fps, 30 | 60) {
        return Err(crate::ApiError::invalid(
            "recording frame rate must be 30 or 60 FPS",
        ));
    }
    if !recording.voice_restore_volume.is_finite()
        || !(0.0..=1.0).contains(&recording.voice_restore_volume)
    {
        return Err(ApiError::invalid(
            "recording voice restore volume must be between 0 and 1",
        ));
    }
    if ![recording.camera_fov, recording.camera_fov_restore]
        .into_iter()
        .all(|value| value.is_finite() && (60.0..=140.0).contains(&value))
    {
        return Err(ApiError::invalid(
            "recording camera FOV and its restore value must be between 60 and 140",
        ));
    }
    if ![recording.viewmodel_fov, recording.viewmodel_fov_restore]
        .into_iter()
        .all(|value| value.is_finite() && (54.0..=68.0).contains(&value))
    {
        return Err(ApiError::invalid(
            "recording viewmodel FOV and its restore value must be between 54 and 68",
        ));
    }
    if !(-5_000..=5_000).contains(&recording.capture_delay_ms) {
        return Err(ApiError::invalid(
            "recording capture delay must be between -5000 and 5000 milliseconds",
        ));
    }
    if recording.mute_voice && recording.isolate_target_voice {
        return Err(ApiError::invalid(
            "recording global voice mute and target-player isolation are mutually exclusive",
        ));
    }
    for path in [
        &recording.first_person_hud_assets,
        &recording.obs_realtime_kill_fx_media,
        &recording.obs_realtime_keyboard_media,
    ] {
        if !path.is_empty()
            && (path.trim() != path
                || !Path::new(path).is_absolute()
                || path.chars().any(char::is_control))
        {
            return Err(ApiError::invalid(
                "recording HUD and realtime overlay paths must be normalized absolute paths",
            ));
        }
    }
    if !matches!(
        config
            .preferred_encoder
            .trim()
            .to_ascii_lowercase()
            .as_str(),
        "auto" | "libx264" | "h264_qsv" | "h264_nvenc" | "h264_amf"
    ) {
        return Err(crate::ApiError::invalid(
            "preferred encoder is not supported",
        ));
    }
    if config.obs.port == 0 {
        return Err(crate::ApiError::invalid(
            "OBS port must be greater than zero",
        ));
    }
    if !(1..=100).contains(&config.steam.maximum_results) {
        return Err(crate::ApiError::invalid(
            "Steam history result limit must be between 1 and 100",
        ));
    }
    if !config.steam.steam_id.is_empty()
        && (config.steam.steam_id.len() != 17
            || !config
                .steam
                .steam_id
                .chars()
                .all(|character| character.is_ascii_digit()))
    {
        return Err(crate::ApiError::invalid(
            "Steam ID must contain exactly 17 digits",
        ));
    }
    if !config.steam.web_api_key.is_empty()
        && (config.steam.web_api_key.len() != 32
            || !config
                .steam
                .web_api_key
                .chars()
                .all(|character| character.is_ascii_hexdigit()))
    {
        return Err(crate::ApiError::invalid(
            "Steam Web API key must contain exactly 32 hexadecimal characters",
        ));
    }
    if !config.steam.authentication_code.is_empty()
        && !has_alphanumeric_groups(&config.steam.authentication_code, &[4, 5, 4], None)
    {
        return Err(crate::ApiError::invalid(
            "Steam game authentication code must use the XXXX-XXXXX-XXXX format",
        ));
    }
    if !config.steam.known_share_code.is_empty()
        && !is_match_sharing_code(&config.steam.known_share_code)
    {
        return Err(crate::ApiError::invalid(
            "Steam match sharing code must use the CSGO-xxxxx-xxxxx-xxxxx-xxxxx-xxxxx format",
        ));
    }
    Ok(())
}

fn is_match_sharing_code(value: &str) -> bool {
    const ALPHABET: &str = "ABCDEFGHJKLMNOPQRSTUVWXYZabcdefhijkmnopqrstuvwxyz23456789";
    has_alphanumeric_groups(value, &[4, 5, 5, 5, 5, 5], Some("CSGO"))
        && value.strip_prefix("CSGO-").is_some_and(|code| {
            code.chars()
                .all(|character| character == '-' || ALPHABET.contains(character))
        })
}

fn has_alphanumeric_groups(value: &str, lengths: &[usize], prefix: Option<&str>) -> bool {
    let groups = value.split('-').collect::<Vec<_>>();
    groups.len() == lengths.len()
        && prefix.is_none_or(|prefix| groups.first() == Some(&prefix))
        && groups.iter().zip(lengths).all(|(group, length)| {
            group.len() == *length
                && group
                    .chars()
                    .all(|character| character.is_ascii_alphanumeric())
        })
}

fn is_secret_placeholder(value: &str) -> bool {
    let value = value.trim();
    value.is_empty()
        || value == "********"
        || value == "••••••••"
        || value.eq_ignore_ascii_case("<redacted>")
}

async fn setup_status(State(state): State<AppState>) -> ApiResult<Json<SetupStatus>> {
    let config = state.storage.get_config().await?.unwrap_or_default();
    let dependencies = dependency_statuses(&config);
    let ready = dependencies
        .iter()
        .filter(|dependency| dependency.name != "llm")
        .all(|dependency| dependency.available);
    Ok(Json(SetupStatus {
        ready,
        dependencies,
    }))
}

#[derive(Debug, Serialize)]
struct QuickCheckResponse {
    checks: Vec<DependencyCheck>,
    checked_at: chrono::DateTime<Utc>,
}

#[derive(Debug, Serialize)]
struct DependencyCheck {
    kind: &'static str,
    state: &'static str,
    label: &'static str,
    detail: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    action_path: Option<&'static str>,
}

async fn quick_check(State(state): State<AppState>) -> ApiResult<Json<QuickCheckResponse>> {
    let config = state.storage.get_config().await?.unwrap_or_default();
    let checks = vec![
        check_path("game", "Game", &config.cs2_path, Some("/settings")),
        check_obs(&config),
        check_path("ffmpeg", "FFmpeg", &config.ffmpeg_path, Some("/settings")),
        DependencyCheck {
            kind: "encoder",
            state: if config.ffmpeg_path.is_empty() {
                "missing"
            } else {
                "checking"
            },
            label: "Encoder",
            detail: "Encoder capability is verified when an export adapter starts".to_owned(),
            action_path: Some("/settings"),
        },
        DependencyCheck {
            kind: "storage",
            state: "ready",
            label: "Storage",
            detail: state.data_dir().to_string_lossy().into_owned(),
            action_path: None,
        },
    ];
    Ok(Json(QuickCheckResponse {
        checks,
        checked_at: Utc::now(),
    }))
}

fn dependency_statuses(config: &AppConfig) -> Vec<DependencyStatus> {
    vec![
        dependency("game", &config.cs2_path),
        dependency("ffmpeg", &config.ffmpeg_path),
        dependency("ffprobe", &config.ffprobe_path),
        DependencyStatus {
            name: "obs".to_owned(),
            available: !config.obs.executable.is_empty()
                && Path::new(&config.obs.executable).is_file(),
            version: None,
            path: (!config.obs.executable.is_empty()).then(|| config.obs.executable.clone()),
            message: Some("Connectivity is verified by the OBS endpoint".to_owned()),
        },
        DependencyStatus {
            name: "llm".to_owned(),
            available: !config.llm.provider.is_empty()
                && !config.llm.model.is_empty()
                && !config.llm.api_key.is_empty(),
            version: None,
            path: None,
            message: Some("Credentials are never included in status responses".to_owned()),
        },
    ]
}

fn dependency(name: &str, configured_path: &str) -> DependencyStatus {
    let available = !configured_path.is_empty() && Path::new(configured_path).is_file();
    DependencyStatus {
        name: name.to_owned(),
        available,
        version: None,
        path: (!configured_path.is_empty()).then(|| configured_path.to_owned()),
        message: (!available).then(|| format!("{name} executable is not configured or accessible")),
    }
}

fn check_path(
    kind: &'static str,
    label: &'static str,
    path: &str,
    action_path: Option<&'static str>,
) -> DependencyCheck {
    let available = !path.is_empty() && Path::new(path).exists();
    DependencyCheck {
        kind,
        state: if available { "ready" } else { "missing" },
        label,
        detail: if available {
            path.to_owned()
        } else {
            format!("{label} is not configured or accessible")
        },
        action_path,
    }
}

fn check_obs(config: &AppConfig) -> DependencyCheck {
    let available = !config.obs.executable.is_empty() && Path::new(&config.obs.executable).exists();
    DependencyCheck {
        kind: "obs",
        state: if available { "checking" } else { "missing" },
        label: "OBS",
        detail: if available {
            "Executable found; use the OBS status endpoint to verify connectivity".to_owned()
        } else {
            "OBS is not configured or accessible".to_owned()
        },
        action_path: Some("/settings"),
    }
}

pub(crate) async fn events(
    State(state): State<AppState>,
) -> Sse<impl futures_util::Stream<Item = Result<Event, Infallible>>> {
    let receiver = state.events.subscribe();
    let stream = stream::unfold(receiver, |mut receiver| async move {
        loop {
            match receiver.recv().await {
                Ok(change) => {
                    let event = Event::default()
                        .event("changed")
                        .json_data(change)
                        .unwrap_or_else(|_| Event::default().event("changed"));
                    return Some((Ok(event), receiver));
                }
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {}
                Err(tokio::sync::broadcast::error::RecvError::Closed) => return None,
            }
        }
    });
    Sse::new(stream).keep_alive(KeepAlive::default())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compatible_config_round_trip_keeps_core_fields() {
        let config = AppConfig {
            locale: "en-US".to_owned(),
            cs2_path: "C:/Game/game.exe".to_owned(),
            ..AppConfig::default()
        };
        let dto = ConfigDto::from(config);
        assert_eq!(dto.language, "en-US");
        assert_eq!(dto.game_path, "C:/Game/game.exe");
    }

    #[test]
    fn serialized_config_never_contains_credentials() {
        let mut config = AppConfig::default();
        config.obs.password = "obs-private-value".to_owned();
        config.llm.api_key = "llm-private-value".to_owned();
        config.steam.web_api_key = "steam-api-private-value".to_owned();
        config.steam.authentication_code = "steam-auth-private-value".to_owned();
        config.steam.known_share_code = "steam-share-private-value".to_owned();
        let dto = ConfigDto::from(config);
        let json = serde_json::to_string(&dto).expect("serialize config response");
        assert!(!json.contains("obs-private-value"));
        assert!(!json.contains("llm-private-value"));
        assert!(!json.contains("steam-api-private-value"));
        assert!(!json.contains("steam-auth-private-value"));
        assert!(!json.contains("steam-share-private-value"));
        assert!(json.contains("\"obs_has_password\":true"));
        assert!(json.contains("\"llm_has_api_key\":true"));
        assert!(json.contains("\"steam_has_web_api_key\":true"));
        assert!(json.contains("\"steam_has_authentication_code\":true"));
        assert!(json.contains("\"steam_has_share_code\":true"));
    }

    #[test]
    fn recording_defaults_are_validated_at_the_configuration_boundary() {
        let mut config = AppConfig::default();
        assert!(validate_config(&config).is_ok());
        config.recording.pre_roll_seconds = -1.0;
        assert!(validate_config(&config).is_err());
        config.recording.pre_roll_seconds = 3.0;
        config.recording.fps = 144;
        assert!(validate_config(&config).is_err());
        config.recording.fps = 60;
        config.recording.voice_restore_volume = f64::NAN;
        assert!(validate_config(&config).is_err());
        config.recording.voice_restore_volume = 1.01;
        assert!(validate_config(&config).is_err());
        config.recording.voice_restore_volume = 1.0;
        config.recording.camera_fov = 200.0;
        assert!(validate_config(&config).is_err());
        config.recording.camera_fov = 90.0;
        config.recording.viewmodel_fov_restore = 40.0;
        assert!(validate_config(&config).is_err());
        config.recording.viewmodel_fov_restore = 68.0;
        config.recording.capture_delay_ms = 5_001;
        assert!(validate_config(&config).is_err());
        config.recording.capture_delay_ms = 0;
        config.recording.obs_realtime_kill_fx_media = "relative.webm".to_owned();
        assert!(validate_config(&config).is_err());
        config.recording.obs_realtime_kill_fx_media.clear();
        config.recording.mute_voice = true;
        config.recording.isolate_target_voice = true;
        assert!(validate_config(&config).is_err());
    }

    #[test]
    fn steam_credentials_are_validated_at_the_configuration_boundary() {
        let mut config = AppConfig {
            steam: vibe_cs_domain::SteamConfig {
                steam_id: "76561198000000000".to_owned(),
                web_api_key: "a".repeat(32),
                authentication_code: "ABCD-EFGHI-JKLM".to_owned(),
                known_share_code: "CSGO-ABCDE-ABCDE-ABCDE-ABCDE-ABCDE".to_owned(),
                maximum_results: 20,
            },
            ..AppConfig::default()
        };
        assert!(validate_config(&config).is_ok());
        config.steam.web_api_key = "not-a-key".to_owned();
        assert!(validate_config(&config).is_err());
        config.steam.web_api_key = "a".repeat(32);
        config.steam.known_share_code = "CSGO-ABCDI-ABCDE-ABCDE-ABCDE-ABCDE".to_owned();
        assert!(validate_config(&config).is_err());
    }

    #[test]
    fn watch_configuration_accepts_only_bounded_absolute_paths() {
        let mut config = AppConfig {
            demo_watch_paths: vec!["relative/demos".to_owned()],
            ..AppConfig::default()
        };
        assert!(validate_config(&config).is_err());
        let absolute = std::env::current_dir()
            .expect("current directory")
            .join("demos");
        config.demo_watch_paths = (0..65)
            .map(|index| {
                absolute
                    .join(index.to_string())
                    .to_string_lossy()
                    .into_owned()
            })
            .collect();
        assert!(validate_config(&config).is_err());
        config.demo_watch_paths = vec![absolute.to_string_lossy().into_owned()];
        assert!(validate_config(&config).is_ok());
    }

    #[test]
    fn directory_usage_counts_files_without_following_links() {
        let root = tempfile::tempdir().expect("temporary directory");
        std::fs::create_dir(root.path().join("nested")).expect("nested directory");
        std::fs::write(root.path().join("first.bin"), [0_u8; 3]).expect("first file");
        std::fs::write(root.path().join("nested/second.bin"), [0_u8; 5]).expect("second file");

        let usage = directory_usage(root.path(), 16);

        assert_eq!(usage.bytes, 8);
        assert_eq!(usage.files, 2);
        assert_eq!(usage.directories, 2);
        assert!(usage.complete);
    }

    #[test]
    fn directory_usage_reports_a_bounded_partial_scan() {
        let root = tempfile::tempdir().expect("temporary directory");
        std::fs::write(root.path().join("first.bin"), [0_u8; 3]).expect("first file");

        let usage = directory_usage(root.path(), 1);

        assert!(!usage.complete);
        assert_eq!(usage.files, 0);
        assert_eq!(usage.directories, 1);
    }
}
