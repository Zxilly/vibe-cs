use std::{
    convert::Infallible,
    io,
    path::{Path, PathBuf},
};

use axum::{
    Json, Router,
    extract::State,
    response::sse::{Event, KeepAlive, Sse},
    routing::{get, post},
};
use chrono::Utc;
use futures_util::{StreamExt as _, stream};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use url::Url;
use vibe_cs_domain::{
    AppConfig, DependencyStatus, HlaeStatus, ManagedHlaeReleaseStatus, SetupStatus,
};
use vibe_cs_hlae::{
    HlaeBundleLaunchInputs, HlaeError, LaunchResolution, ManagedHlaeRelease,
    build_hlae_launch_profile, install_managed_hlae_archive, verify_managed_hlae_installation,
};
use vibe_cs_integrations::discover_paths;
use walkdir::WalkDir;

use crate::{ApiError, ApiJson, ApiResult, AppState};

pub(crate) fn router() -> Router<AppState> {
    Router::new()
        .route("/api/health", get(health))
        .route("/api/app/runtime-state", get(runtime_state))
        .route("/api/config", get(get_config).put(put_config))
        .route("/api/config/detect-paths", post(detect_paths))
        .route("/api/config/quick-check", get(quick_check))
        .route("/api/hlae/status", get(hlae_status))
        .route("/api/hlae/managed/prepare", post(prepare_managed_hlae))
        .route("/api/storage/status", get(storage_status))
        .route("/api/status/setup", get(setup_status))
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
}

async fn detect_paths(State(state): State<AppState>) -> ApiResult<Json<DetectedPathsResponse>> {
    let config = state.storage.get_config().await?.unwrap_or_default();
    let discovery_config = config.clone();
    let paths = tokio::task::spawn_blocking(move || discover_paths(&discovery_config))
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
    }))
}

#[derive(Debug, Serialize)]
struct ManagedHlaeStatusDto {
    available: bool,
    executable: Option<String>,
    source2_hook: Option<String>,
    source: Option<String>,
    managed_release: ManagedHlaeReleaseStatus,
    messages: Vec<String>,
    cs2_executable: Option<String>,
    launch_profile_ready: bool,
    automatic_launch_enabled: bool,
    safety_boundary: HlaeSafetyBoundaryDto,
}

#[derive(Debug, Serialize)]
struct HlaeSafetyBoundaryDto {
    insecure_mode_required: bool,
    vac_servers_prohibited: bool,
    demo_playback_only: bool,
}

impl From<HlaeStatus> for ManagedHlaeStatusDto {
    fn from(status: HlaeStatus) -> Self {
        Self {
            available: status.available,
            executable: status.executable,
            source2_hook: status.source2_hook,
            source: status.source,
            managed_release: status.managed_release,
            messages: status.messages,
            cs2_executable: status.cs2_executable,
            launch_profile_ready: status.launch_profile_ready,
            automatic_launch_enabled: status.automatic_launch_enabled,
            safety_boundary: HlaeSafetyBoundaryDto {
                insecure_mode_required: status.insecure_mode_required,
                vac_servers_prohibited: status.vac_servers_prohibited,
                demo_playback_only: status.demo_playback_only,
            },
        }
    }
}

async fn hlae_status(State(state): State<AppState>) -> ApiResult<Json<ManagedHlaeStatusDto>> {
    Ok(Json(current_hlae_status(&state).await?.into()))
}

pub(super) async fn current_hlae_status(state: &AppState) -> ApiResult<HlaeStatus> {
    let config = state.storage.get_config().await?.unwrap_or_default();
    let profile_root = state.data_dir().join("hlae-plans");
    let managed_root = managed_hlae_root(state);
    let status = tokio::task::spawn_blocking(move || {
        build_hlae_status(&config, &profile_root, &managed_root)
    })
    .await
    .map_err(|error| {
        ApiError::new(
            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
            "hlae_status_failed",
            format!("HLAE status task failed: {error}"),
        )
    })?;
    Ok(status)
}

pub(super) async fn current_hlae_launch_inputs(
    state: &AppState,
) -> ApiResult<Option<HlaeBundleLaunchInputs>> {
    let config = state.storage.get_config().await?.unwrap_or_default();
    let managed_root = managed_hlae_root(state);
    tokio::task::spawn_blocking(move || resolve_hlae_launch_inputs(&config, &managed_root))
        .await
        .map_err(|error| {
            ApiError::new(
                axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                "hlae_status_failed",
                format!("HLAE launch input task failed: {error}"),
            )
        })
}

fn resolve_hlae_launch_inputs(
    config: &AppConfig,
    managed_root: &Path,
) -> Option<HlaeBundleLaunchInputs> {
    let installation = verify_managed_hlae_installation(managed_root).ok()?;
    let game_executable = PathBuf::from(&config.cs2_path);
    let steam_executable = discover_paths(config).steam?;
    if !game_executable.is_file()
        || !game_executable
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.eq_ignore_ascii_case("cs2.exe"))
    {
        return None;
    }
    Some(HlaeBundleLaunchInputs {
        installation,
        game_executable,
        steam_executable,
        resolution: LaunchResolution {
            width: 1920,
            height: 1080,
        },
    })
}

fn build_hlae_status(config: &AppConfig, profile_root: &Path, managed_root: &Path) -> HlaeStatus {
    let verification = verify_managed_hlae_installation(managed_root);
    let installation = verification.as_ref().ok();
    let cs2 = (!config.cs2_path.trim().is_empty())
        .then(|| Path::new(&config.cs2_path))
        .filter(|path| {
            path.is_file()
                && path
                    .file_name()
                    .and_then(|name| name.to_str())
                    .is_some_and(|name| name.eq_ignore_ascii_case("cs2.exe"))
        });
    let launch_inputs = resolve_hlae_launch_inputs(config, managed_root);
    let launch_profile_ready = launch_inputs.as_ref().is_some_and(|inputs| {
        build_hlae_launch_profile(
            &inputs.installation,
            &inputs.game_executable,
            &inputs.steam_executable,
            profile_root,
            inputs.resolution,
        )
        .is_ok()
    });
    let automatic_launch_enabled = launch_profile_ready && installation.is_some();
    let mut messages = verification
        .as_ref()
        .err()
        .map(|error| vec![error.to_string()])
        .unwrap_or_default();
    if installation.is_some() && cs2.is_none() {
        messages.push(
            "CS2.exe is required before a typed HLAE launch profile can be prepared".to_owned(),
        );
    }
    messages.push(if automatic_launch_enabled {
        "Recording jobs launch a fresh managed HLAE and CS2 process for offline Demo playback with -insecure; proposal exports remain process-free"
            .to_owned()
    } else {
        "Automatic recording launch requires the integrity-verified app-managed HLAE release"
            .to_owned()
    });
    HlaeStatus {
        available: installation.is_some(),
        executable: installation.map(|value| value.executable.to_string_lossy().into_owned()),
        source2_hook: installation.map(|value| value.source2_hook.to_string_lossy().into_owned()),
        source: installation.map(|_| "managed".to_owned()),
        managed_release: ManagedHlaeReleaseStatus {
            version: ManagedHlaeRelease::current().version,
            archive_sha256: ManagedHlaeRelease::current().archive_sha256,
            signing_fingerprint: ManagedHlaeRelease::current().signing_fingerprint,
            prepared: installation.is_some(),
        },
        messages,
        cs2_executable: cs2.map(|path| path.to_string_lossy().into_owned()),
        launch_profile_ready,
        automatic_launch_enabled,
        insecure_mode_required: true,
        vac_servers_prohibited: true,
        demo_playback_only: true,
    }
}

fn managed_hlae_root(state: &AppState) -> PathBuf {
    state.data_dir().join("runtimes/hlae")
}

async fn prepare_managed_hlae(
    State(state): State<AppState>,
) -> ApiResult<Json<ManagedHlaeStatusDto>> {
    if !cfg!(windows) {
        return Err(ApiError::new(
            axum::http::StatusCode::BAD_REQUEST,
            "hlae_unsupported_platform",
            "HLAE is supported only on Windows",
        ));
    }
    let _preparation = state.hlae_preparation.lock().await;
    let config = state.storage.get_config().await?.unwrap_or_default();
    let profile_root = state.data_dir().join("hlae-plans");
    let managed_root = managed_hlae_root(&state);
    let existing = build_hlae_status(&config, &profile_root, &managed_root);
    if existing.managed_release.prepared {
        return Ok(Json(existing.into()));
    }

    let release = ManagedHlaeRelease::current();
    let archive = download_managed_hlae_archive(&release).await?;
    let install_root = managed_root.clone();
    tokio::task::spawn_blocking(move || install_managed_hlae_archive(&archive, &install_root))
        .await
        .map_err(|error| {
            ApiError::new(
                axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                "hlae_prepare_failed",
                format!("managed HLAE preparation task failed: {error}"),
            )
        })?
        .map_err(|error| hlae_api_error(&error))?;
    Ok(Json(
        build_hlae_status(&config, &profile_root, &managed_root).into(),
    ))
}

async fn download_managed_hlae_archive(release: &ManagedHlaeRelease) -> ApiResult<Vec<u8>> {
    let client = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(15))
        .timeout(std::time::Duration::from_secs(120))
        .build()
        .map_err(|_| managed_download_error("unable to initialize the HTTPS client"))?;
    let response = client
        .get(&release.archive_url)
        .header(reqwest::header::ACCEPT, "application/zip")
        .send()
        .await
        .map_err(|_| managed_download_error("official HLAE release download failed"))?
        .error_for_status()
        .map_err(|_| managed_download_error("official HLAE release returned an error"))?;
    if response
        .content_length()
        .is_some_and(|length| length != release.archive_size)
    {
        return Err(managed_download_error(
            "official HLAE release reported an unexpected size",
        ));
    }
    let capacity = usize::try_from(release.archive_size).map_err(|_| {
        managed_download_error("reviewed HLAE release size is unsupported on this system")
    })?;
    let mut archive = Vec::with_capacity(capacity);
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk =
            chunk.map_err(|_| managed_download_error("HLAE release download was interrupted"))?;
        let total = archive
            .len()
            .checked_add(chunk.len())
            .ok_or_else(|| managed_download_error("HLAE release download size overflow"))?;
        if total > capacity {
            return Err(managed_download_error(
                "HLAE release exceeded the reviewed archive size",
            ));
        }
        archive.extend_from_slice(&chunk);
    }
    if archive.len() != capacity {
        return Err(managed_download_error(
            "HLAE release download ended before the reviewed archive size",
        ));
    }
    Ok(archive)
}

fn managed_download_error(message: &'static str) -> ApiError {
    ApiError::new(
        axum::http::StatusCode::BAD_GATEWAY,
        "hlae_download_failed",
        message,
    )
}

fn hlae_api_error(error: &HlaeError) -> ApiError {
    let (status, code) = match error {
        HlaeError::ArtifactBundleExists(_) | HlaeError::ArtifactBundleConflict { .. } => {
            (axum::http::StatusCode::CONFLICT, "hlae_prepare_conflict")
        }
        HlaeError::InvalidInstallation(_) | HlaeError::UnsafePath { .. } => (
            axum::http::StatusCode::UNPROCESSABLE_ENTITY,
            "hlae_integrity_failed",
        ),
        _ => (
            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
            "hlae_prepare_failed",
        ),
    };
    ApiError::new(status, code, error.to_string())
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
#[serde(deny_unknown_fields)]
#[allow(
    clippy::struct_excessive_bools,
    reason = "the settings contract exposes one presence bit per independently stored secret"
)]
struct ConfigDto {
    theme: String,
    update_manifest_url: String,
    demo_watch_paths: Vec<String>,
    locale: String,
    data_dir: String,
    cs2_path: String,
    steam_path: String,
    steam: vibe_cs_domain::SteamConfig,
    steam_has_web_api_key: bool,
    steam_has_authentication_code: bool,
    steam_has_share_code: bool,
    llm: vibe_cs_domain::LlmConfig,
    llm_has_api_key: bool,
    clear_llm_api_key: bool,
    recording: vibe_cs_domain::RecordingDefaults,
}

impl From<AppConfig> for ConfigDto {
    fn from(config: AppConfig) -> Self {
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
            theme: config.theme.clone(),
            update_manifest_url: config.update_manifest_url.clone(),
            demo_watch_paths: config.demo_watch_paths.clone(),
            locale: config.locale,
            data_dir: config.data_dir,
            cs2_path: config.cs2_path,
            steam_path: config.steam_path,
            steam,
            steam_has_web_api_key,
            steam_has_authentication_code,
            steam_has_share_code,
            llm,
            llm_has_api_key,
            clear_llm_api_key: false,
            recording: config.recording,
        }
    }
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
    let input = serde_json::from_value::<ConfigDto>(input)
        .map_err(|error| crate::ApiError::invalid(error.to_string()))?;
    let clear_llm_api_key = input.clear_llm_api_key;
    let mut config = AppConfig {
        locale: input.locale,
        theme: input.theme,
        update_manifest_url: input.update_manifest_url,
        data_dir: input.data_dir,
        demo_watch_paths: input.demo_watch_paths,
        cs2_path: input.cs2_path,
        steam_path: input.steam_path,
        steam: input.steam,
        llm: input.llm,
        recording: input.recording,
    };
    merge_llm_api_key(&current, &mut config, clear_llm_api_key)?;
    if is_secret_placeholder(&config.steam.web_api_key) {
        config
            .steam
            .web_api_key
            .clone_from(&current.steam.web_api_key);
    }
    if is_secret_placeholder(&config.steam.authentication_code) {
        config
            .steam
            .authentication_code
            .clone_from(&current.steam.authentication_code);
    }
    if is_secret_placeholder(&config.steam.known_share_code) {
        config
            .steam
            .known_share_code
            .clone_from(&current.steam.known_share_code);
    }
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
    validate_game_path(config)?;
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
    if !recording.camera_fov.is_finite() || !(60.0..=140.0).contains(&recording.camera_fov) {
        return Err(ApiError::invalid(
            "recording camera FOV must be between 60 and 140",
        ));
    }
    if !recording.viewmodel_fov.is_finite() || !(54.0..=68.0).contains(&recording.viewmodel_fov) {
        return Err(ApiError::invalid(
            "recording viewmodel FOV must be between 54 and 68",
        ));
    }
    if recording.mute_voice && recording.isolate_target_voice {
        return Err(ApiError::invalid(
            "recording global voice mute and target-player isolation are mutually exclusive",
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

fn validate_game_path(config: &AppConfig) -> ApiResult<()> {
    if !config.cs2_path.is_empty()
        && (!Path::new(&config.cs2_path).is_absolute()
            || config.cs2_path.trim() != config.cs2_path
            || config.cs2_path.chars().any(char::is_control))
    {
        return Err(ApiError::invalid(
            "CS2 path must be a normalized absolute path",
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

fn llm_credential_scope_changed(current: &AppConfig, updated: &AppConfig) -> bool {
    current.llm.provider.trim() != updated.llm.provider.trim()
        || canonical_origin(&current.llm.base_url) != canonical_origin(&updated.llm.base_url)
}

fn merge_llm_api_key(
    current: &AppConfig,
    updated: &mut AppConfig,
    clear_requested: bool,
) -> ApiResult<()> {
    if clear_requested {
        updated.llm.api_key.clear();
        return Ok(());
    }
    if !is_secret_placeholder(&updated.llm.api_key) {
        return Ok(());
    }
    if !current.llm.api_key.is_empty() && llm_credential_scope_changed(current, updated) {
        return Err(crate::ApiError::invalid(
            "changing the AI provider or endpoint requires re-entering its API key",
        ));
    }
    updated.llm.api_key.clone_from(&current.llm.api_key);
    Ok(())
}

fn canonical_origin(value: &str) -> Option<String> {
    let url = Url::parse(value.trim()).ok()?;
    let host = url.host_str()?.to_ascii_lowercase();
    let port = url.port_or_known_default()?;
    Some(format!(
        "{}://{host}:{port}",
        url.scheme().to_ascii_lowercase()
    ))
}

async fn setup_status(State(state): State<AppState>) -> ApiResult<Json<SetupStatus>> {
    let config = state.storage.get_config().await?.unwrap_or_default();
    let discovery_config = config.clone();
    let paths = tokio::task::spawn_blocking(move || discover_paths(&discovery_config))
        .await
        .map_err(|error| {
            ApiError::new(
                axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                "path_discovery_failed",
                format!("dependency discovery task failed: {error}"),
            )
        })?;
    let dependencies = dependency_statuses(&config, &paths);
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
    let discovery_config = config.clone();
    let paths = tokio::task::spawn_blocking(move || discover_paths(&discovery_config))
        .await
        .map_err(|error| {
            ApiError::new(
                axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                "path_discovery_failed",
                format!("dependency discovery task failed: {error}"),
            )
        })?;
    let checks = build_quick_checks(&paths);
    Ok(Json(QuickCheckResponse {
        checks,
        checked_at: Utc::now(),
    }))
}

fn build_quick_checks(paths: &vibe_cs_integrations::DiscoveredPaths) -> Vec<DependencyCheck> {
    vec![check_discovered_path(
        "game",
        "Counter-Strike 2",
        paths.cs2.as_deref(),
        Some("/settings"),
    )]
}

fn check_discovered_path(
    kind: &'static str,
    label: &'static str,
    path: Option<&Path>,
    action_path: Option<&'static str>,
) -> DependencyCheck {
    DependencyCheck {
        kind,
        state: if path.is_some() { "ready" } else { "missing" },
        label,
        detail: path.map_or_else(
            || format!("{label} was not found"),
            |path| path.to_string_lossy().into_owned(),
        ),
        action_path,
    }
}

fn dependency_statuses(
    config: &AppConfig,
    paths: &vibe_cs_integrations::DiscoveredPaths,
) -> Vec<DependencyStatus> {
    vec![
        dependency("game", paths.cs2.as_deref()),
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

fn dependency(name: &str, path: Option<&Path>) -> DependencyStatus {
    let available = path.is_some_and(Path::is_file);
    DependencyStatus {
        name: name.to_owned(),
        available,
        version: None,
        path: path.map(|path| path.to_string_lossy().into_owned()),
        message: (!available).then(|| format!("{name} executable was not found")),
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
    fn public_config_uses_only_canonical_current_fields() {
        let config = AppConfig {
            locale: "en-US".to_owned(),
            cs2_path: "C:/Game/game.exe".to_owned(),
            ..AppConfig::default()
        };
        let dto = ConfigDto::from(config);
        assert_eq!(dto.locale, "en-US");
        assert_eq!(dto.cs2_path, "C:/Game/game.exe");
        let json = serde_json::to_string(&dto).expect("serialize public config");
        for retired in [
            "language",
            "game_path",
            "output_directory",
            "analysis_mode",
            "obs",
            "ffmpeg_path",
            "ffprobe_path",
            "preferred_encoder",
            "hlae_path",
        ] {
            assert!(!json.contains(&format!("\"{retired}\"")));
        }
    }

    #[test]
    fn config_response_exposes_only_native_hlae_recording_controls() {
        let response = serde_json::to_value(ConfigDto::from(AppConfig::default()))
            .expect("serialize public configuration");
        let recording = response["recording"]
            .as_object()
            .expect("recording configuration object");
        let mut fields = recording.keys().map(String::as_str).collect::<Vec<_>>();
        fields.sort_unstable();

        assert_eq!(
            fields,
            [
                "camera_fov",
                "flash_alpha",
                "fps",
                "isolate_target_voice",
                "mute_voice",
                "post_roll_seconds",
                "pre_roll_seconds",
                "resolution",
                "show_hud",
                "show_radar",
                "viewmodel_fov",
            ]
        );
    }

    #[test]
    fn workspace_readiness_contains_only_the_user_supplied_cs2_dependency() {
        let checks = build_quick_checks(&vibe_cs_integrations::DiscoveredPaths::default());

        assert_eq!(
            checks.iter().map(|check| check.kind).collect::<Vec<_>>(),
            vec!["game"]
        );
    }

    #[cfg(windows)]
    #[test]
    fn hlae_status_requires_the_managed_installation() {
        let temporary = tempfile::tempdir().unwrap();
        let cs2 = temporary.path().join("cs2.exe");
        std::fs::write(&cs2, b"fixture").unwrap();
        let config = AppConfig {
            cs2_path: cs2.to_string_lossy().into_owned(),
            ..AppConfig::default()
        };

        let status = build_hlae_status(
            &config,
            temporary.path(),
            &temporary.path().join("managed-hlae"),
        );

        assert!(!status.available);
        assert!(!status.launch_profile_ready);
        assert!(!status.automatic_launch_enabled);
        assert!(status.source.is_none());
        assert!(status.insecure_mode_required);
        assert!(status.vac_servers_prohibited);
        assert!(status.demo_playback_only);
    }

    #[test]
    fn public_hlae_status_omits_retired_discovery_contracts() {
        let temporary = tempfile::tempdir().expect("temporary directory");
        let status = build_hlae_status(
            &AppConfig::default(),
            temporary.path(),
            &temporary.path().join("managed-hlae"),
        );
        let value = serde_json::to_value(ManagedHlaeStatusDto::from(status))
            .expect("serialize managed HLAE status");
        let object = value.as_object().expect("status object");

        assert!(!object.contains_key("configured_path"));
        assert!(!object.contains_key("checked_locations"));
        assert!(!object.contains_key("insecure_mode_required"));
        assert!(object.contains_key("managed_release"));
        assert_eq!(
            value["safety_boundary"],
            serde_json::json!({
                "insecure_mode_required": true,
                "vac_servers_prohibited": true,
                "demo_playback_only": true
            })
        );
    }

    #[test]
    fn serialized_config_never_contains_credentials() {
        let mut config = AppConfig::default();
        config.llm.api_key = "llm-private-value".to_owned();
        config.steam.web_api_key = "steam-api-private-value".to_owned();
        config.steam.authentication_code = "steam-auth-private-value".to_owned();
        config.steam.known_share_code = "steam-share-private-value".to_owned();
        let dto = ConfigDto::from(config);
        let json = serde_json::to_string(&dto).expect("serialize config response");
        assert!(!json.contains("\"obs\""));
        assert!(!json.contains("obs_host"));
        assert!(!json.contains("obs_port"));
        assert!(!json.contains("obs_has_password"));
        assert!(!json.contains("ffmpeg_path"));
        assert!(!json.contains("ffprobe_path"));
        assert!(!json.contains("preferred_encoder"));
        assert!(!json.contains("hlae_path"));
        assert!(!json.contains("llm-private-value"));
        assert!(!json.contains("steam-api-private-value"));
        assert!(!json.contains("steam-auth-private-value"));
        assert!(!json.contains("steam-share-private-value"));
        assert!(json.contains("\"llm_has_api_key\":true"));
        assert!(json.contains("\"steam_has_web_api_key\":true"));
        assert!(json.contains("\"steam_has_authentication_code\":true"));
        assert!(json.contains("\"steam_has_share_code\":true"));
        assert!(json.contains("\"clear_llm_api_key\":false"));
    }

    #[tokio::test]
    async fn retired_configuration_fields_are_rejected() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let storage = vibe_cs_storage::Storage::open_in_memory()
            .await
            .expect("storage");
        let state = AppState::new(storage, directory.path().to_path_buf());
        let canonical = serde_json::to_value(ConfigDto::from(AppConfig::default()))
            .expect("serialize public configuration");
        for (path, value) in [
            ("obs", serde_json::json!({ "host": "127.0.0.1" })),
            ("ffmpeg_path", serde_json::json!("C:\\Tools\\ffmpeg.exe")),
            ("ffprobe_path", serde_json::json!("C:\\Tools\\ffprobe.exe")),
            ("preferred_encoder", serde_json::json!("h264_nvenc")),
            ("hlae_path", serde_json::json!("C:\\Tools\\HLAE.exe")),
        ] {
            let mut payload = canonical.clone();
            payload[path] = value;
            assert!(
                put_config(State(state.clone()), ApiJson(payload))
                    .await
                    .is_err()
            );
        }
        let mut recording_payload = canonical;
        recording_payload["recording"]["capture_delay_ms"] = serde_json::json!(250);
        assert!(
            put_config(State(state), ApiJson(recording_payload))
                .await
                .is_err()
        );
    }

    #[tokio::test]
    async fn detected_paths_only_exposes_user_managed_game_paths() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let storage = vibe_cs_storage::Storage::open_in_memory()
            .await
            .expect("storage");
        let state = AppState::new(storage, directory.path().to_path_buf());
        let response = detect_paths(State(state)).await.expect("detected paths");
        let value = serde_json::to_value(response.0).expect("serialize detected paths");
        let object = value.as_object().expect("detected paths object");

        assert_eq!(
            object.keys().map(String::as_str).collect::<Vec<_>>(),
            ["cs2_path", "steam_path"]
        );
    }

    #[test]
    fn llm_key_can_be_preserved_replaced_or_explicitly_cleared() {
        let mut current = AppConfig::default();
        current.llm.provider = "openai-compatible".to_owned();
        current.llm.base_url = "https://provider.example/v1".to_owned();
        current.llm.api_key = "saved-secret".to_owned();

        let mut preserved = current.clone();
        preserved.llm.api_key.clear();
        merge_llm_api_key(&current, &mut preserved, false).expect("preserve secret");
        assert_eq!(preserved.llm.api_key, "saved-secret");

        let mut replaced = current.clone();
        replaced.llm.base_url = "https://new-provider.example/v1".to_owned();
        replaced.llm.api_key = "new-secret".to_owned();
        merge_llm_api_key(&current, &mut replaced, false).expect("replace secret");
        assert_eq!(replaced.llm.api_key, "new-secret");

        let mut cleared = current.clone();
        cleared.llm.base_url = "https://new-provider.example/v1".to_owned();
        cleared.llm.api_key.clear();
        merge_llm_api_key(&current, &mut cleared, true).expect("clear secret");
        assert!(cleared.llm.api_key.is_empty());
    }

    #[test]
    fn llm_scope_change_never_reuses_a_redacted_key() {
        let mut current = AppConfig::default();
        current.llm.provider = "openai-compatible".to_owned();
        current.llm.base_url = "https://provider.example/v1".to_owned();
        current.llm.api_key = "saved-secret".to_owned();
        let mut updated = current.clone();
        updated.llm.base_url = "https://new-provider.example/v1".to_owned();
        updated.llm.api_key.clear();

        assert!(merge_llm_api_key(&current, &mut updated, false).is_err());
        assert!(updated.llm.api_key.is_empty());
    }

    #[test]
    fn native_hlae_recording_controls_are_validated_at_the_configuration_boundary() {
        let mut config = AppConfig::default();
        assert!(validate_config(&config).is_ok());
        config.recording.pre_roll_seconds = -1.0;
        assert!(validate_config(&config).is_err());
        config.recording.pre_roll_seconds = 3.0;
        config.recording.fps = 144;
        assert!(validate_config(&config).is_err());
        config.recording.fps = 60;
        config.recording.camera_fov = 200.0;
        assert!(validate_config(&config).is_err());
        config.recording.camera_fov = 90.0;
        config.recording.viewmodel_fov = 40.0;
        assert!(validate_config(&config).is_err());
        config.recording.viewmodel_fov = 68.0;
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
