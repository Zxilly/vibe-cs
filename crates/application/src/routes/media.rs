use std::{
    collections::{HashMap, HashSet},
    io::{Read, SeekFrom, Write},
    path::{Component, Path as FsPath, PathBuf},
};

use axum::{
    Json, Router,
    body::Body,
    extract::{DefaultBodyLimit, Path, State},
    http::{HeaderMap, Response, StatusCode, header},
    routing::{get, post},
};
use bytes::Bytes;
use chrono::{DateTime, Utc};
use futures_util::{StreamExt, stream};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use tokio::io::{AsyncReadExt, AsyncSeekExt};
use uuid::Uuid;
use vibe_cs_domain::{
    EditorAudioSeparation, EditorPackageAsset, EditorPackageManifest, EditorPresetDocument,
    EditorProject, EditorProjectSnapshot, JobStatus, MediaAsset, MediaMetadataStatus,
    MediaProxyStatus, MontageClip, MontageProject, MontageSettings, Page, RecordedClip, TrackKind,
};
use vibe_cs_storage::{
    EditorAudioSeparationUpdate, EditorProjectDeletion, EditorProjectRevision, EditorProjectUpdate,
    ExportJobRecord, ManagedFileQuarantine, ManagedFileStaging, MediaAssetUpdate, PresetApply,
    PresetDelete, PresetRecord, PresetUpdate,
};
use zip::{CompressionMethod, ZipArchive, ZipWriter, write::SimpleFileOptions};

use crate::{
    ApiError, ApiJson, ApiMultipart, ApiQuery, ApiResult, AppState,
    extract::{multipart_error, persist_multipart_field, read_multipart_text},
};

const MAXIMUM_ASSET_UPLOAD_FILES: usize = 64;
const MAXIMUM_ASSET_UPLOAD_BATCH_BYTES: u64 = 4 * 1024 * 1024 * 1024;
const MAXIMUM_ASSET_UPLOAD_REQUEST_BYTES: usize = 4 * 1024 * 1024 * 1024 + 8 * 1024 * 1024;
const WAVEFORM_CACHE_BUCKETS: usize = 2_000;
const PORTABLE_PACKAGE_FORMAT: &str = "vibe-cs-editor";
const PORTABLE_PACKAGE_VERSION: u32 = 1;
const MAXIMUM_PACKAGE_ASSETS: usize = 128;
const MAXIMUM_PACKAGE_ENTRIES: usize = MAXIMUM_PACKAGE_ASSETS + 2;
const MAXIMUM_PACKAGE_BYTES: u64 = 4 * 1024 * 1024 * 1024;
const MAXIMUM_PACKAGE_ASSET_BYTES: u64 = 2 * 1024 * 1024 * 1024;
const MAXIMUM_PACKAGE_DOCUMENT_BYTES: u64 = 2 * 1024 * 1024;
const MAXIMUM_PACKAGE_UPLOAD_BYTES: usize = 4 * 1024 * 1024 * 1024 + 1024 * 1024;

pub(crate) fn router() -> Router<AppState> {
    Router::new()
        .route("/api/v1/recorded-clips", get(list_clips).post(create_clip))
        .route(
            "/api/v1/recorded-clips/{id}",
            get(get_clip).patch(patch_clip).delete(delete_clip),
        )
        .route(
            "/api/v1/recorded-clips/{id}/stream",
            get(stream_clip).head(head_clip),
        )
        .route(
            "/api/v1/recorded-clips/{id}/waveform",
            get(recorded_clip_waveform),
        )
        .route(
            "/api/v1/montage/projects",
            get(list_montages).post(create_montage),
        )
        .route(
            "/api/v1/montage/projects/{id}",
            get(get_montage).put(put_montage).delete(delete_montage),
        )
        .route("/api/v1/montage/projects/{id}/export", post(export_montage))
        .route("/api/v1/montage/export", post(export_compatible_montage))
        .route(
            "/api/v1/editor/projects",
            get(list_editor_projects).post(create_editor_project),
        )
        .route(
            "/api/v1/editor/projects/delete-batch",
            post(delete_editor_projects_batch),
        )
        .route(
            "/api/v1/editor/projects/{id}",
            get(get_editor_project)
                .put(save_editor_project)
                .patch(save_editor_project)
                .delete(delete_editor_project),
        )
        .route(
            "/api/v1/editor/projects/{id}/export",
            post(export_editor_project),
        )
        .route(
            "/api/v1/editor/projects/{id}/duplicate",
            post(duplicate_editor_project),
        )
        .route(
            "/api/v1/editor/projects/{id}/snapshots",
            get(list_editor_snapshots),
        )
        .route(
            "/api/v1/editor/projects/{id}/snapshots/{snapshot_id}/restore",
            post(restore_editor_snapshot),
        )
        .route(
            "/api/v1/editor/projects/{project_id}/clips/{clip_id}/apply-preset",
            post(apply_editor_preset),
        )
        .route(
            "/api/v1/editor/projects/{project_id}/clips/{clip_id}/separate-audio",
            post(separate_editor_clip_audio),
        )
        .route(
            "/api/v1/editor/projects/{id}/package",
            post(export_editor_package),
        )
        .route(
            "/api/v1/editor/packages/import",
            post(import_editor_package_path),
        )
        .route(
            "/api/v1/editor/packages/upload",
            post(upload_editor_package).layer(DefaultBodyLimit::max(MAXIMUM_PACKAGE_UPLOAD_BYTES)),
        )
        .route(
            "/api/v1/editor/packages/{id}/download",
            get(download_editor_package).head(head_editor_package),
        )
        .route(
            "/api/v1/editor/export/start",
            post(export_editor_compatible),
        )
        .route(
            "/api/v1/media/assets",
            get(list_assets)
                .post(upload_assets)
                .layer(DefaultBodyLimit::max(MAXIMUM_ASSET_UPLOAD_REQUEST_BYTES)),
        )
        .route("/api/v1/media/assets/import", post(import_asset))
        .route(
            "/api/v1/media/assets/{id}",
            get(get_asset).put(put_asset).delete(delete_asset),
        )
        .route("/api/v1/media/assets/{id}/relink", post(relink_asset_path))
        .route(
            "/api/v1/media/assets/{id}/replace",
            post(replace_asset_upload)
                .layer(DefaultBodyLimit::max(MAXIMUM_ASSET_UPLOAD_REQUEST_BYTES)),
        )
        .route(
            "/api/v1/media/assets/{id}/proxy",
            post(generate_asset_proxy),
        )
        .route(
            "/api/v1/media/assets/{id}/proxy/stream",
            get(stream_asset_proxy).head(head_asset_proxy),
        )
        .route("/api/v1/media/proxies/cleanup", post(cleanup_asset_proxies))
        .route(
            "/api/v1/media/assets/{id}/stream",
            get(stream_asset).head(head_asset),
        )
        .route("/api/v1/media/assets/{id}/waveform", get(asset_waveform))
        .route(
            "/api/v1/media/assets/{id}/extract-audio",
            post(extract_asset_audio),
        )
        .route(
            "/api/v1/editor/presets",
            get(list_presets).post(create_preset),
        )
        .route(
            "/api/v1/editor/presets/{id}",
            get(get_preset).put(put_preset).delete(delete_preset),
        )
        .route("/api/v1/exports", get(list_export_jobs))
        .route("/api/v1/exports/{id}", get(get_export_job))
        .route("/api/v1/exports/{id}/cancel", post(cancel_export_job))
}

#[derive(Debug, Serialize)]
struct ItemList<T> {
    items: Vec<T>,
}

#[derive(Debug, Serialize)]
struct RecordedClipDto {
    id: Uuid,
    title: String,
    path: String,
    player_name: Option<String>,
    map_name: String,
    duration_seconds: f64,
    created_at: DateTime<Utc>,
    stream_url: String,
    demo_id: Option<Uuid>,
    category: String,
    tags: Vec<String>,
    metadata: Value,
}

impl From<RecordedClip> for RecordedClipDto {
    fn from(clip: RecordedClip) -> Self {
        let map_name = clip
            .metadata
            .get("map_name")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned();
        Self {
            id: clip.id,
            title: clip.title,
            path: clip.path,
            player_name: clip.player_name,
            map_name,
            duration_seconds: clip.duration_seconds,
            created_at: clip.created_at,
            stream_url: format!("/api/v1/recorded-clips/{}/stream", clip.id),
            demo_id: clip.demo_id,
            category: clip.category,
            tags: clip.tags,
            metadata: clip.metadata,
        }
    }
}

#[derive(Debug, Default, Deserialize)]
struct ClipListQuery {
    page: Option<u32>,
    page_size: Option<u32>,
}

async fn list_clips(
    State(state): State<AppState>,
    ApiQuery(query): ApiQuery<ClipListQuery>,
) -> ApiResult<Json<Page<RecordedClipDto>>> {
    let page = query.page.unwrap_or(1).max(1);
    let page_size = query.page_size.unwrap_or(50).clamp(1, 200);
    let clips = state.storage.list_recorded_clips().await?;
    let total = u64::try_from(clips.len()).unwrap_or(u64::MAX);
    let skip = usize::try_from(u64::from(page - 1) * u64::from(page_size)).unwrap_or(usize::MAX);
    let items = clips
        .into_iter()
        .skip(skip)
        .take(page_size as usize)
        .map(Into::into)
        .collect();
    Ok(Json(Page {
        items,
        total,
        page,
        page_size,
    }))
}

async fn get_clip(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> ApiResult<Json<RecordedClipDto>> {
    state
        .storage
        .get_recorded_clip(parse_id(&id)?)
        .await?
        .map(|clip| Json(clip.into()))
        .ok_or_else(|| ApiError::not_found("recorded clip"))
}

#[derive(Debug, Deserialize)]
struct CreateClipRequest {
    path: String,
    title: String,
    duration_seconds: f64,
    demo_id: Option<Uuid>,
    player_name: Option<String>,
    #[serde(default = "default_category")]
    category: String,
    #[serde(default)]
    tags: Vec<String>,
    #[serde(default)]
    metadata: Value,
}

fn default_category() -> String {
    "highlight".to_owned()
}

async fn create_clip(
    State(state): State<AppState>,
    ApiJson(request): ApiJson<CreateClipRequest>,
) -> ApiResult<(StatusCode, Json<RecordedClipDto>)> {
    validate_media_path(&request.path).await?;
    if !request.duration_seconds.is_finite() || request.duration_seconds < 0.0 {
        return Err(ApiError::invalid(
            "duration_seconds must be finite and non-negative",
        ));
    }
    let clip = RecordedClip {
        id: Uuid::new_v4(),
        path: request.path,
        title: request.title,
        duration_seconds: request.duration_seconds,
        demo_id: request.demo_id,
        player_name: request.player_name,
        category: request.category,
        tags: request.tags,
        metadata: request.metadata,
        created_at: Utc::now(),
    };
    let clip = state.storage.put_recorded_clip(clip).await?;
    state
        .events
        .publish("recorded_clip", "created", Some(clip.id));
    Ok((StatusCode::CREATED, Json(clip.into())))
}

#[derive(Debug, Deserialize)]
struct ClipPatch {
    title: Option<String>,
    player_name: Option<String>,
    category: Option<String>,
    tags: Option<Vec<String>>,
    metadata: Option<Value>,
}

async fn patch_clip(
    State(state): State<AppState>,
    Path(id): Path<String>,
    ApiJson(patch): ApiJson<ClipPatch>,
) -> ApiResult<Json<RecordedClipDto>> {
    let id = parse_id(&id)?;
    let mut clip = state
        .storage
        .get_recorded_clip(id)
        .await?
        .ok_or_else(|| ApiError::not_found("recorded clip"))?;
    if let Some(title) = patch.title {
        clip.title = title;
    }
    if let Some(player_name) = patch.player_name {
        clip.player_name = Some(player_name);
    }
    if let Some(category) = patch.category {
        clip.category = category;
    }
    if let Some(tags) = patch.tags {
        clip.tags = tags;
    }
    if let Some(metadata) = patch.metadata {
        clip.metadata = metadata;
    }
    let clip = state.storage.put_recorded_clip(clip).await?;
    state.events.publish("recorded_clip", "updated", Some(id));
    Ok(Json(clip.into()))
}

async fn delete_clip(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> ApiResult<StatusCode> {
    let id = parse_id(&id)?;
    if !state.storage.delete_recorded_clip(id).await? {
        return Err(ApiError::not_found("recorded clip"));
    }
    state.events.publish("recorded_clip", "deleted", Some(id));
    Ok(StatusCode::NO_CONTENT)
}

async fn stream_clip(
    State(state): State<AppState>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> ApiResult<Response<Body>> {
    let clip = state
        .storage
        .get_recorded_clip(parse_id(&id)?)
        .await?
        .ok_or_else(|| ApiError::not_found("recorded clip"))?;
    stream_media_file(&clip.path, headers, false, "recorded clip file").await
}

async fn head_clip(
    State(state): State<AppState>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> ApiResult<Response<Body>> {
    let clip = state
        .storage
        .get_recorded_clip(parse_id(&id)?)
        .await?
        .ok_or_else(|| ApiError::not_found("recorded clip"))?;
    stream_media_file(&clip.path, headers, true, "recorded clip file").await
}

#[derive(Debug, Deserialize)]
struct WaveformQuery {
    #[serde(default = "default_waveform_buckets")]
    buckets: usize,
}

const fn default_waveform_buckets() -> usize {
    1_000
}

#[derive(Debug, Serialize)]
struct WaveformResponse {
    waveform: Vec<f32>,
    cached: bool,
}

async fn recorded_clip_waveform(
    State(state): State<AppState>,
    Path(id): Path<String>,
    ApiQuery(query): ApiQuery<WaveformQuery>,
) -> ApiResult<Json<WaveformResponse>> {
    validate_waveform_buckets(query.buckets)?;
    let id = parse_id(&id)?;
    let mut clip = state
        .storage
        .get_recorded_clip(id)
        .await?
        .ok_or_else(|| ApiError::not_found("recorded clip"))?;
    if let Some(cached) = cached_recorded_waveform(&clip.metadata) {
        return Ok(Json(WaveformResponse {
            waveform: rebucket_peaks(&cached, query.buckets),
            cached: true,
        }));
    }
    let waveform = generate_waveform(&state, &clip.path).await?;
    let metadata = clip
        .metadata
        .as_object_mut()
        .map_or_else(serde_json::Map::new, |metadata| metadata.clone());
    let mut metadata = metadata;
    metadata.insert(
        "waveform".to_owned(),
        serde_json::to_value(&waveform).map_err(|error| {
            ApiError::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                "waveform_serialization_failed",
                error.to_string(),
            )
        })?,
    );
    clip.metadata = Value::Object(metadata);
    state.storage.put_recorded_clip(clip).await?;
    state.events.publish("recorded_clip", "updated", Some(id));
    Ok(Json(WaveformResponse {
        waveform: rebucket_peaks(&waveform, query.buckets),
        cached: false,
    }))
}

async fn stream_media_file(
    path: &str,
    headers: HeaderMap,
    head_only: bool,
    missing_resource: &'static str,
) -> ApiResult<Response<Body>> {
    let mut file = tokio::fs::File::open(path).await.map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            ApiError::not_found(missing_resource)
        } else {
            error.into()
        }
    })?;
    let length = file.metadata().await?.len();
    let range = headers
        .get(header::RANGE)
        .map(|value| {
            value
                .to_str()
                .map_err(|_| ApiError::invalid("Range header is not ASCII"))
        })
        .transpose()?
        .map(|value| parse_byte_range(value, length))
        .transpose()?;
    let (start, end, status) = range.map_or(
        (0, length.saturating_sub(1), StatusCode::OK),
        |(start, end)| (start, end, StatusCode::PARTIAL_CONTENT),
    );
    if start > 0 {
        file.seek(SeekFrom::Start(start)).await?;
    }
    let remaining = if length == 0 { 0 } else { end - start + 1 };
    let stream = stream::try_unfold((file, remaining), |(mut file, remaining)| async move {
        if remaining == 0 {
            return Ok(None);
        }
        let capacity = usize::try_from(remaining.min(64 * 1024)).unwrap_or(64 * 1024);
        let mut buffer = vec![0_u8; capacity];
        let read = file.read(&mut buffer).await?;
        if read == 0 {
            return Ok(None);
        }
        buffer.truncate(read);
        Ok::<_, std::io::Error>(Some((
            Bytes::from(buffer),
            (file, remaining.saturating_sub(read as u64)),
        )))
    });
    let mut builder = Response::builder()
        .status(status)
        .header(header::ACCEPT_RANGES, "bytes")
        .header(header::CONTENT_LENGTH, remaining)
        .header(
            header::CONTENT_TYPE,
            mime_guess::from_path(path).first_or_octet_stream().as_ref(),
        );
    if status == StatusCode::PARTIAL_CONTENT {
        builder = builder.header(
            header::CONTENT_RANGE,
            format!("bytes {start}-{end}/{length}"),
        );
    }
    let body = if head_only {
        Body::empty()
    } else {
        Body::from_stream(stream)
    };
    builder.body(body).map_err(|error| {
        ApiError::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            "response_build_failed",
            error.to_string(),
        )
    })
}

fn parse_byte_range(value: &str, length: u64) -> ApiResult<(u64, u64)> {
    let value = value
        .strip_prefix("bytes=")
        .ok_or_else(|| ApiError::invalid("Range must use bytes"))?;
    if value.contains(',') || length == 0 {
        return Err(ApiError::new(
            StatusCode::RANGE_NOT_SATISFIABLE,
            "invalid_range",
            "Requested byte range is not satisfiable",
        ));
    }
    let (start, end) = value
        .split_once('-')
        .ok_or_else(|| ApiError::invalid("Range must contain '-'"))?;
    let (start, end) = if start.is_empty() {
        let suffix = end
            .parse::<u64>()
            .map_err(|_| ApiError::invalid("Range suffix is invalid"))?;
        if suffix == 0 {
            return Err(ApiError::invalid("Range suffix must be positive"));
        }
        (length.saturating_sub(suffix.min(length)), length - 1)
    } else {
        let start = start
            .parse::<u64>()
            .map_err(|_| ApiError::invalid("Range start is invalid"))?;
        let end = if end.is_empty() {
            length - 1
        } else {
            end.parse::<u64>()
                .map_err(|_| ApiError::invalid("Range end is invalid"))?
                .min(length - 1)
        };
        (start, end)
    };
    if start >= length || start > end {
        return Err(ApiError::new(
            StatusCode::RANGE_NOT_SATISFIABLE,
            "invalid_range",
            "Requested byte range is not satisfiable",
        ));
    }
    Ok((start, end))
}

async fn list_montages(State(state): State<AppState>) -> ApiResult<Json<ItemList<MontageProject>>> {
    Ok(Json(ItemList {
        items: state.storage.list_montage_projects().await?,
    }))
}

#[derive(Debug, Deserialize)]
struct CreateMontageRequest {
    name: String,
    #[serde(default)]
    clips: Vec<MontageClip>,
    #[serde(default)]
    settings: MontageSettings,
}

async fn create_montage(
    State(state): State<AppState>,
    ApiJson(request): ApiJson<CreateMontageRequest>,
) -> ApiResult<(StatusCode, Json<MontageProject>)> {
    let now = Utc::now();
    let project = MontageProject {
        id: Uuid::new_v4(),
        name: request.name,
        clips: request.clips,
        settings: request.settings,
        created_at: now,
        updated_at: now,
    };
    validate_montage_project(&state, &project).await?;
    let project = state.storage.put_montage_project(project).await?;
    state
        .events
        .publish("montage_project", "created", Some(project.id));
    Ok((StatusCode::CREATED, Json(project)))
}

async fn get_montage(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> ApiResult<Json<MontageProject>> {
    state
        .storage
        .get_montage_project(parse_id(&id)?)
        .await?
        .map(Json)
        .ok_or_else(|| ApiError::not_found("montage project"))
}

async fn put_montage(
    State(state): State<AppState>,
    Path(id): Path<String>,
    ApiJson(mut project): ApiJson<MontageProject>,
) -> ApiResult<Json<MontageProject>> {
    let id = parse_id(&id)?;
    if project.id != id {
        return Err(ApiError::invalid("path id and project id must match"));
    }
    if state.storage.get_montage_project(id).await?.is_none() {
        return Err(ApiError::not_found("montage project"));
    }
    validate_montage_project(&state, &project).await?;
    project.updated_at = Utc::now();
    let project = state.storage.put_montage_project(project).await?;
    state.events.publish("montage_project", "updated", Some(id));
    Ok(Json(project))
}

async fn validate_montage_project(state: &AppState, project: &MontageProject) -> ApiResult<()> {
    if project.name.trim().is_empty() || project.name.chars().count() > 200 {
        return Err(ApiError::invalid(
            "montage name must contain between 1 and 200 characters",
        ));
    }
    let settings = &project.settings;
    if settings.width == 0
        || settings.height == 0
        || settings.width > 16_384
        || settings.height > 16_384
        || !(1..=240).contains(&settings.fps)
        || settings.quality > 100
    {
        return Err(ApiError::invalid(
            "montage dimensions, frame rate, or quality are invalid",
        ));
    }
    for (value, minimum, maximum, name) in [
        (settings.music_volume, 0.0, 2.0, "music_volume"),
        (settings.transition_seconds, 0.05, 5.0, "transition_seconds"),
        (
            settings.intro_duration_seconds,
            0.0,
            30.0,
            "intro_duration_seconds",
        ),
        (
            settings.name_card_duration_seconds,
            0.1,
            15.0,
            "name_card_duration_seconds",
        ),
        (
            settings.outro_duration_seconds,
            0.0,
            30.0,
            "outro_duration_seconds",
        ),
    ] {
        if !value.is_finite() || !(minimum..=maximum).contains(&value) {
            return Err(ApiError::invalid(format!(
                "{name} must be between {minimum} and {maximum}"
            )));
        }
    }
    if !matches!(
        settings.encoder.trim().to_ascii_lowercase().as_str(),
        "" | "auto"
            | "libopenh264"
            | "h264_mf"
            | "h264_nvenc"
            | "hevc_nvenc"
            | "h264_amf"
            | "h264_qsv"
    ) {
        return Err(ApiError::invalid("unsupported montage encoder"));
    }
    if settings.intro_duration_seconds > 0.0
        && settings
            .intro_title
            .as_deref()
            .is_none_or(|title| title.trim().is_empty())
    {
        return Err(ApiError::invalid(
            "intro_title is required when the intro duration is positive",
        ));
    }
    if settings.outro_duration_seconds > 0.0
        && settings
            .outro_title
            .as_deref()
            .is_none_or(|title| title.trim().is_empty())
    {
        return Err(ApiError::invalid(
            "outro_title is required when the outro duration is positive",
        ));
    }
    if let Some(path) = settings.background_music.as_deref() {
        validate_media_path(path).await?;
    }
    let mut orders = std::collections::HashSet::new();
    for clip in &project.clips {
        if !orders.insert(clip.order) {
            return Err(ApiError::invalid("montage clip orders must be unique"));
        }
        if !clip.trim_start.is_finite()
            || clip.trim_start < 0.0
            || clip
                .trim_end
                .is_some_and(|end| !end.is_finite() || end <= clip.trim_start)
        {
            return Err(ApiError::invalid("montage clip trim range is invalid"));
        }
        if !matches!(
            clip.transition.trim().to_ascii_lowercase().as_str(),
            "" | "none"
                | "cut"
                | "fade"
                | "dissolve"
                | "flash"
                | "dip"
                | "zoom"
                | "wipe"
                | "whip"
                | "slide"
                | "slideleft"
                | "blur"
                | "glitch"
                | "spin"
        ) {
            return Err(ApiError::invalid(format!(
                "unsupported montage transition: {}",
                clip.transition
            )));
        }
        let recorded = state
            .storage
            .get_recorded_clip(clip.clip_id)
            .await?
            .ok_or_else(|| ApiError::not_found(format!("recorded clip {}", clip.clip_id)))?;
        if clip
            .trim_end
            .is_some_and(|end| end > recorded.duration_seconds + 0.001)
            || clip.trim_start >= recorded.duration_seconds
        {
            return Err(ApiError::invalid(format!(
                "montage clip {} trim exceeds its source duration",
                clip.clip_id
            )));
        }
        if let Some(avatar_id) = clip.avatar_asset_id {
            let avatar = state
                .storage
                .get_asset(avatar_id)
                .await?
                .ok_or_else(|| ApiError::not_found(format!("avatar asset {avatar_id}")))?;
            if !avatar.kind.starts_with("image/") && avatar.kind != "image" {
                return Err(ApiError::invalid(format!(
                    "avatar asset {avatar_id} must be an image"
                )));
            }
        }
    }
    Ok(())
}

async fn delete_montage(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> ApiResult<StatusCode> {
    let id = parse_id(&id)?;
    if !state.storage.delete_montage_project(id).await? {
        return Err(ApiError::not_found("montage project"));
    }
    state.events.publish("montage_project", "deleted", Some(id));
    Ok(StatusCode::NO_CONTENT)
}

async fn export_montage(
    State(state): State<AppState>,
    Path(id): Path<String>,
    ApiJson(request): ApiJson<Value>,
) -> ApiResult<Json<JobAccepted>> {
    let id = parse_id(&id)?;
    if state.storage.get_montage_project(id).await?.is_none() {
        return Err(ApiError::not_found("montage project"));
    }
    start_export(&state, "montage", id, request).await
}

#[derive(Debug, Deserialize, Serialize)]
struct CompatibleMontageExport {
    name: String,
    clip_ids: Vec<Uuid>,
    transition: String,
    resolution: String,
    fps: u32,
    include_name_cards: bool,
    #[serde(default)]
    background_music: Option<String>,
    #[serde(default = "default_music_volume")]
    music_volume: f64,
    #[serde(default = "default_transition_seconds")]
    transition_seconds: f64,
    #[serde(default)]
    intro_title: Option<String>,
    #[serde(default)]
    intro_duration_seconds: f64,
}

const fn default_music_volume() -> f64 {
    0.25
}

const fn default_transition_seconds() -> f64 {
    0.35
}

async fn export_compatible_montage(
    State(state): State<AppState>,
    ApiJson(request): ApiJson<CompatibleMontageExport>,
) -> ApiResult<Json<JobAccepted>> {
    if request.clip_ids.is_empty() {
        return Err(ApiError::invalid("clip_ids must not be empty"));
    }
    let mut recorded_clips = Vec::with_capacity(request.clip_ids.len());
    for id in &request.clip_ids {
        recorded_clips.push(
            state
                .storage
                .get_recorded_clip(*id)
                .await?
                .ok_or_else(|| ApiError::not_found(format!("recorded clip {id}")))?,
        );
    }
    let (width, height) = resolution_dimensions(&request.resolution)?;
    let now = Utc::now();
    let project = MontageProject {
        id: Uuid::new_v4(),
        name: request.name.clone(),
        clips: request
            .clip_ids
            .iter()
            .enumerate()
            .zip(&recorded_clips)
            .map(|((order, id), recorded)| MontageClip {
                clip_id: *id,
                order: u32::try_from(order).unwrap_or(u32::MAX),
                trim_start: 0.0,
                trim_end: None,
                transition: request.transition.clone(),
                title: request.include_name_cards.then(|| recorded.title.clone()),
                avatar_asset_id: None,
            })
            .collect(),
        settings: MontageSettings {
            width,
            height,
            fps: request.fps,
            background_music: request.background_music.clone(),
            music_volume: request.music_volume,
            transition_seconds: request.transition_seconds,
            intro_title: request.intro_title.clone(),
            intro_duration_seconds: request.intro_duration_seconds,
            include_name_cards: request.include_name_cards,
            ..MontageSettings::default()
        },
        created_at: now,
        updated_at: now,
    };
    validate_montage_project(&state, &project).await?;
    state.storage.put_montage_project(project.clone()).await?;
    start_export(
        &state,
        "montage",
        project.id,
        serde_json::to_value(request).map_err(|error| ApiError::invalid(error.to_string()))?,
    )
    .await
}

async fn list_editor_projects(
    State(state): State<AppState>,
) -> ApiResult<Json<ItemList<EditorProject>>> {
    Ok(Json(ItemList {
        items: state.storage.list_editor_projects().await?,
    }))
}

#[derive(Debug, Deserialize)]
#[serde(untagged)]
enum CreateEditorRequest {
    Full(Box<EditorProject>),
    Minimal(MinimalEditorRequest),
}

#[derive(Debug, Deserialize)]
struct MinimalEditorRequest {
    name: String,
    #[serde(default = "default_width")]
    width: u32,
    #[serde(default = "default_height")]
    height: u32,
    #[serde(default = "default_fps")]
    fps: u32,
}

const fn default_width() -> u32 {
    1920
}
const fn default_height() -> u32 {
    1080
}
const fn default_fps() -> u32 {
    60
}

async fn create_editor_project(
    State(state): State<AppState>,
    ApiJson(request): ApiJson<CreateEditorRequest>,
) -> ApiResult<(StatusCode, Json<EditorProject>)> {
    let now = Utc::now();
    let project = match request {
        CreateEditorRequest::Full(project) => EditorProject {
            revision: 1,
            created_at: now,
            updated_at: now,
            ..*project
        },
        CreateEditorRequest::Minimal(request) => EditorProject {
            id: Uuid::new_v4(),
            name: request.name,
            width: request.width,
            height: request.height,
            fps: request.fps,
            duration_seconds: 0.0,
            tracks: Vec::new(),
            markers: Vec::new(),
            settings: Value::Object(serde_json::Map::new()),
            revision: 1,
            created_at: now,
            updated_at: now,
        },
    };
    if state
        .storage
        .get_editor_project(project.id)
        .await?
        .is_some()
    {
        return Err(ApiError::new(
            StatusCode::CONFLICT,
            "project_exists",
            "Editor project id already exists",
        ));
    }
    validate_editor_project(&project)?;
    let project = state.storage.put_editor_project(project).await?;
    state
        .events
        .publish("editor_project", "created", Some(project.id));
    Ok((StatusCode::CREATED, Json(project)))
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct DuplicateEditorProjectRequest {
    name: String,
    #[serde(default)]
    as_template: bool,
}

async fn duplicate_editor_project(
    State(state): State<AppState>,
    Path(id): Path<String>,
    ApiJson(request): ApiJson<DuplicateEditorProjectRequest>,
) -> ApiResult<(StatusCode, Json<EditorProject>)> {
    let source = state
        .storage
        .get_editor_project(parse_id(&id)?)
        .await?
        .ok_or_else(|| ApiError::not_found("editor project"))?;
    let name = request.name.trim();
    if name.is_empty() || name.chars().count() > 200 {
        return Err(ApiError::invalid(
            "duplicated project name must contain between 1 and 200 characters",
        ));
    }
    let project = clone_editor_document(&source, name, request.as_template);
    validate_editor_project(&project)?;
    let project = state.storage.put_editor_project(project).await?;
    state
        .events
        .publish("editor_project", "duplicated", Some(project.id));
    Ok((StatusCode::CREATED, Json(project)))
}

fn clone_editor_document(source: &EditorProject, name: &str, as_template: bool) -> EditorProject {
    let now = Utc::now();
    let mut project = source.clone();
    project.id = Uuid::new_v4();
    name.clone_into(&mut project.name);
    project.revision = 1;
    project.created_at = now;
    project.updated_at = now;
    if !project.settings.is_object() {
        project.settings = Value::Object(serde_json::Map::new());
    }
    let settings = project
        .settings
        .as_object_mut()
        .expect("settings was normalized to an object");
    settings.insert("is_template".to_owned(), Value::Bool(as_template));
    settings.insert(
        "source_project_id".to_owned(),
        Value::String(source.id.to_string()),
    );

    let mut group_ids = HashMap::new();
    let mut link_ids = HashMap::new();
    for track in &mut project.tracks {
        track.id = Uuid::new_v4();
        for clip in &mut track.clips {
            clip.id = Uuid::new_v4();
            if let Some(group_id) = clip.group_id {
                clip.group_id = Some(*group_ids.entry(group_id).or_insert_with(Uuid::new_v4));
            }
            if let Some(link_id) = clip.link_group_id {
                clip.link_group_id = Some(*link_ids.entry(link_id).or_insert_with(Uuid::new_v4));
            }
            for keyframe in &mut clip.keyframes {
                keyframe.id = Uuid::new_v4();
            }
            for segment in &mut clip.speed_segments {
                segment.id = Uuid::new_v4();
            }
        }
    }
    for marker in &mut project.markers {
        marker.id = Uuid::new_v4();
    }
    project
}

async fn get_editor_project(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> ApiResult<Json<EditorProject>> {
    state
        .storage
        .get_editor_project(parse_id(&id)?)
        .await?
        .map(Json)
        .ok_or_else(|| ApiError::not_found("editor project"))
}

async fn save_editor_project(
    State(state): State<AppState>,
    Path(id): Path<String>,
    ApiJson(project): ApiJson<EditorProject>,
) -> ApiResult<Json<EditorProject>> {
    let id = parse_id(&id)?;
    if project.id != id {
        return Err(ApiError::invalid("path id and project id must match"));
    }
    validate_editor_project(&project)?;
    let expected_revision = project.revision;
    match state
        .storage
        .update_editor_project(project, expected_revision)
        .await?
    {
        EditorProjectUpdate::Updated(project) => {
            state.events.publish("editor_project", "updated", Some(id));
            Ok(Json(project))
        }
        EditorProjectUpdate::NotFound => Err(ApiError::not_found("editor project")),
        EditorProjectUpdate::Conflict { current_revision } => Err(ApiError::new(
            StatusCode::CONFLICT,
            "revision_conflict",
            format!(
                "Editor project was modified by another request (current revision {current_revision})"
            ),
        )),
    }
}

fn validate_editor_project(project: &EditorProject) -> ApiResult<()> {
    if !project.duration_seconds.is_finite() || project.duration_seconds < 0.0 {
        return Err(ApiError::invalid(
            "duration_seconds must be finite and non-negative",
        ));
    }
    project.validate()?;
    Ok(())
}

async fn delete_editor_project(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> ApiResult<Json<EditorProjectDeletionResponse>> {
    let id = parse_id(&id)?;
    let project = state
        .storage
        .get_editor_project(id)
        .await?
        .ok_or_else(|| ApiError::not_found("editor project"))?;
    delete_editor_projects(
        &state,
        vec![EditorProjectRevision {
            id,
            expected_revision: project.revision,
        }],
    )
    .await
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct DeleteEditorProjectsRequest {
    items: Vec<DeleteEditorProjectItem>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct DeleteEditorProjectItem {
    id: Uuid,
    expected_revision: u64,
}

#[derive(Debug, Serialize)]
struct EditorProjectDeletionResponse {
    deleted_project_ids: Vec<Uuid>,
    deleted_asset_ids: Vec<Uuid>,
    preserved_shared_asset_ids: Vec<Uuid>,
    removed_files: usize,
    preserved_external_files: usize,
    failed_files: Vec<String>,
}

async fn delete_editor_projects_batch(
    State(state): State<AppState>,
    ApiJson(request): ApiJson<DeleteEditorProjectsRequest>,
) -> ApiResult<Json<EditorProjectDeletionResponse>> {
    if request.items.is_empty() || request.items.len() > 100 {
        return Err(ApiError::invalid(
            "project deletion requires between 1 and 100 items",
        ));
    }
    let mut ids = HashSet::new();
    if request.items.iter().any(|item| !ids.insert(item.id)) {
        return Err(ApiError::invalid(
            "project deletion contains duplicate project ids",
        ));
    }
    delete_editor_projects(
        &state,
        request
            .items
            .into_iter()
            .map(|item| EditorProjectRevision {
                id: item.id,
                expected_revision: item.expected_revision,
            })
            .collect(),
    )
    .await
}

async fn delete_editor_projects(
    state: &AppState,
    revisions: Vec<EditorProjectRevision>,
) -> ApiResult<Json<EditorProjectDeletionResponse>> {
    let _ = recover_editor_project_quarantines(state).await;
    let deletion = state
        .storage
        .delete_editor_projects_staged(revisions, editor_file_staging(state))
        .await?;
    let result = match deletion {
        EditorProjectDeletion::Deleted(result) => result,
        EditorProjectDeletion::NotFound { id } => {
            return Err(ApiError::not_found(format!("editor project {id}")));
        }
        EditorProjectDeletion::Conflict {
            id,
            current_revision,
        } => {
            return Err(ApiError::new(
                StatusCode::CONFLICT,
                "revision_conflict",
                format!("Editor project {id} is at revision {current_revision}"),
            ));
        }
        EditorProjectDeletion::ActiveExport { id } => {
            return Err(ApiError::new(
                StatusCode::CONFLICT,
                "project_export_active",
                format!("Editor project {id} has an active export"),
            ));
        }
        EditorProjectDeletion::BusyAsset {
            project_id,
            asset_id,
        } => {
            return Err(ApiError::new(
                StatusCode::CONFLICT,
                "project_asset_busy",
                format!("Editor project {project_id} is generating proxy {asset_id}"),
            ));
        }
    };
    let deleted_asset_ids = result
        .deleted_assets
        .iter()
        .map(|asset| asset.id)
        .collect::<Vec<_>>();
    let (removed_files, failed_files) = match result.file_quarantine.as_ref() {
        Some(quarantine) => finalize_editor_project_quarantine(state, quarantine).await,
        None => (0, Vec::new()),
    };
    for id in &result.project_ids {
        state.events.publish("editor_project", "deleted", Some(*id));
    }
    for id in &deleted_asset_ids {
        state.events.publish("media_asset", "deleted", Some(*id));
    }
    Ok(Json(EditorProjectDeletionResponse {
        deleted_project_ids: result.project_ids,
        deleted_asset_ids,
        preserved_shared_asset_ids: result.preserved_shared_asset_ids,
        removed_files,
        preserved_external_files: result.preserved_external_files,
        failed_files,
    }))
}

fn editor_managed_roots(state: &AppState) -> Vec<PathBuf> {
    vec![
        state.data_dir().join("uploads").join("assets"),
        state.data_dir().join("portable-assets"),
        state.data_dir().join("proxies"),
    ]
}

fn editor_quarantine_root(state: &AppState) -> PathBuf {
    editor_cleanup_root(state).join("editor-projects")
}

fn editor_cleanup_root(state: &AppState) -> PathBuf {
    state.data_dir().join("cleanup")
}

fn editor_file_staging(state: &AppState) -> ManagedFileStaging {
    ManagedFileStaging {
        managed_roots: editor_managed_roots(state),
        cleanup_root: editor_cleanup_root(state),
        quarantine_root: editor_quarantine_root(state),
    }
}

async fn finalize_editor_project_quarantine(
    state: &AppState,
    quarantine: &ManagedFileQuarantine,
) -> (usize, Vec<String>) {
    match state
        .storage
        .finalize_editor_project_quarantine(editor_file_staging(state), quarantine.clone())
        .await
    {
        Ok(result) => result,
        Err(error) => {
            tracing::warn!(%error, "project quarantine finalization will retry");
            (0, vec!["cleanup-journal".to_owned()])
        }
    }
}

async fn recover_editor_project_quarantines(state: &AppState) -> (usize, Vec<String>) {
    match state
        .storage
        .recover_editor_project_quarantines(editor_file_staging(state))
        .await
    {
        Ok(result) => result,
        Err(error) => {
            tracing::warn!(%error, "project quarantine recovery will retry");
            (0, vec!["cleanup-journal".to_owned()])
        }
    }
}
async fn list_editor_snapshots(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> ApiResult<Json<ItemList<EditorProjectSnapshot>>> {
    let id = parse_id(&id)?;
    if state.storage.get_editor_project(id).await?.is_none() {
        return Err(ApiError::not_found("editor project"));
    }
    Ok(Json(ItemList {
        items: state.storage.list_editor_project_snapshots(id).await?,
    }))
}

async fn restore_editor_snapshot(
    State(state): State<AppState>,
    Path((id, snapshot_id)): Path<(String, String)>,
) -> ApiResult<Json<EditorProject>> {
    let id = parse_id(&id)?;
    let snapshot_id = parse_id(&snapshot_id)?;
    let project = state
        .storage
        .restore_editor_project_snapshot(id, snapshot_id)
        .await?
        .ok_or_else(|| ApiError::not_found("editor project snapshot"))?;
    state.events.publish("editor_project", "restored", Some(id));
    Ok(Json(project))
}

#[derive(Debug, Default, Deserialize)]
struct ExportEditorPackageRequest {
    output_path: Option<String>,
}

#[derive(Debug, Serialize)]
struct EditorPackageExportResponse {
    package_id: Uuid,
    name: String,
    path: String,
    size: u64,
    sha256: String,
    download_url: Option<String>,
}

#[derive(Debug, Serialize)]
struct EditorPackageImportResponse {
    project: EditorProject,
    assets: Vec<MediaAsset>,
}

#[derive(Debug, Deserialize)]
struct ImportEditorPackageRequest {
    path: String,
}

#[derive(Debug, Clone)]
struct EditorPackageSource {
    source_asset_id: Uuid,
    path: PathBuf,
    name: String,
    kind: String,
}

#[derive(Debug)]
struct BuiltEditorPackage {
    size: u64,
    sha256: String,
}

#[derive(Debug)]
struct ValidatedEditorPackage {
    project: EditorProject,
    manifest: EditorPackageManifest,
}

async fn export_editor_package(
    State(state): State<AppState>,
    Path(id): Path<String>,
    ApiJson(request): ApiJson<ExportEditorPackageRequest>,
) -> ApiResult<Json<EditorPackageExportResponse>> {
    let id = parse_id(&id)?;
    let project = state
        .storage
        .get_editor_project(id)
        .await?
        .ok_or_else(|| ApiError::not_found("editor project"))?;
    let source_ids = referenced_editor_asset_ids(&project);
    if source_ids.len() > MAXIMUM_PACKAGE_ASSETS {
        return Err(ApiError::invalid(format!(
            "portable projects support at most {MAXIMUM_PACKAGE_ASSETS} referenced assets"
        )));
    }
    let mut sources = Vec::with_capacity(source_ids.len());
    for source_id in source_ids {
        if let Some(asset) = state.storage.get_asset(source_id).await? {
            sources.push(EditorPackageSource {
                source_asset_id: source_id,
                path: PathBuf::from(asset.path),
                name: asset.name,
                kind: asset.kind,
            });
            continue;
        }
        let clip = state
            .storage
            .get_recorded_clip(source_id)
            .await?
            .ok_or_else(|| ApiError::not_found(format!("editor source {source_id}")))?;
        sources.push(EditorPackageSource {
            source_asset_id: source_id,
            path: PathBuf::from(clip.path),
            name: clip.title,
            kind: "video/mp4".to_owned(),
        });
    }

    let package_id = Uuid::new_v4();
    let (output, download_url) =
        editor_package_output_path(&state, package_id, request.output_path).await?;
    let build_output = output.clone();
    let built = tokio::task::spawn_blocking(move || {
        build_editor_package_archive(&build_output, &project, &sources)
    })
    .await
    .map_err(|error| {
        ApiError::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            "package_worker_failed",
            format!("Portable project worker failed: {error}"),
        )
    })??;
    let name = output
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("editor-project.vcep")
        .to_owned();
    state.events.publish("editor_project", "packaged", Some(id));
    Ok(Json(EditorPackageExportResponse {
        package_id,
        name,
        path: output.to_string_lossy().into_owned(),
        size: built.size,
        sha256: built.sha256,
        download_url,
    }))
}

async fn editor_package_output_path(
    state: &AppState,
    package_id: Uuid,
    requested: Option<String>,
) -> ApiResult<(PathBuf, Option<String>)> {
    if let Some(requested) = requested.filter(|path| !path.trim().is_empty()) {
        let requested = PathBuf::from(requested);
        if !requested.is_absolute()
            || requested.extension().and_then(|value| value.to_str()) != Some("vcep")
        {
            return Err(ApiError::invalid(
                "portable project output must be an absolute .vcep path",
            ));
        }
        let file_name = requested
            .file_name()
            .and_then(|name| name.to_str())
            .and_then(safe_file_name)
            .ok_or_else(|| ApiError::invalid("portable project output has an unsafe file name"))?;
        let parent = requested
            .parent()
            .ok_or_else(|| ApiError::invalid("portable project output has no parent directory"))?;
        let parent = tokio::fs::canonicalize(parent).await?;
        let output = parent.join(file_name);
        if tokio::fs::try_exists(&output).await? {
            return Err(ApiError::new(
                StatusCode::CONFLICT,
                "package_output_exists",
                "Portable project output already exists",
            ));
        }
        return Ok((output, None));
    }

    let directory = state.data_dir().join("packages");
    tokio::fs::create_dir_all(&directory).await?;
    Ok((
        directory.join(format!("{package_id}.vcep")),
        Some(format!("/api/v1/editor/packages/{package_id}/download")),
    ))
}

async fn download_editor_package(
    State(state): State<AppState>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> ApiResult<Response<Body>> {
    download_editor_package_response(&state, &id, headers, false).await
}

async fn head_editor_package(
    State(state): State<AppState>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> ApiResult<Response<Body>> {
    download_editor_package_response(&state, &id, headers, true).await
}

async fn download_editor_package_response(
    state: &AppState,
    id: &str,
    headers: HeaderMap,
    head_only: bool,
) -> ApiResult<Response<Body>> {
    let id = parse_id(id)?;
    let path = state.data_dir().join("packages").join(format!("{id}.vcep"));
    let mut response = stream_media_file(
        path.to_string_lossy().as_ref(),
        headers,
        head_only,
        "portable editor package",
    )
    .await?;
    response.headers_mut().insert(
        header::CONTENT_DISPOSITION,
        format!("attachment; filename=\"editor-{id}.vcep\"")
            .parse()
            .map_err(|_| {
                ApiError::new(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "invalid_package_header",
                    "Unable to create portable package download header",
                )
            })?,
    );
    Ok(response)
}

async fn import_editor_package_path(
    State(state): State<AppState>,
    ApiJson(request): ApiJson<ImportEditorPackageRequest>,
) -> ApiResult<(StatusCode, Json<EditorPackageImportResponse>)> {
    let path = tokio::fs::canonicalize(&request.path)
        .await
        .map_err(|error| {
            if error.kind() == std::io::ErrorKind::NotFound {
                ApiError::not_found("portable editor package")
            } else {
                error.into()
            }
        })?;
    let imported = import_editor_package(&state, path).await?;
    Ok((StatusCode::CREATED, Json(imported)))
}

async fn upload_editor_package(
    State(state): State<AppState>,
    ApiMultipart(mut multipart): ApiMultipart,
) -> ApiResult<(StatusCode, Json<EditorPackageImportResponse>)> {
    let upload_dir = state.data_dir().join("package-uploads");
    tokio::fs::create_dir_all(&upload_dir).await?;
    let mut uploaded = None;
    while let Some(mut field) = multipart
        .next_field()
        .await
        .map_err(|error| multipart_error(&error))?
    {
        if field.name() != Some("file") {
            continue;
        }
        if uploaded.is_some() {
            if let Some(path) = uploaded.as_ref() {
                remove_uploaded_assets(std::slice::from_ref(path)).await;
            }
            return Err(ApiError::invalid(
                "portable project import accepts exactly one file",
            ));
        }
        let original_name = field
            .file_name()
            .and_then(safe_file_name)
            .ok_or_else(|| ApiError::invalid("portable project requires a safe file name"))?;
        if !original_name.to_ascii_lowercase().ends_with(".vcep") {
            return Err(ApiError::invalid(
                "portable project upload must use the .vcep extension",
            ));
        }
        let destination = upload_dir.join(format!("{}.vcep", Uuid::new_v4()));
        persist_multipart_field(&mut field, &destination, MAXIMUM_PACKAGE_BYTES).await?;
        uploaded = Some(destination);
    }
    let uploaded =
        uploaded.ok_or_else(|| ApiError::invalid("portable project file is required"))?;
    let result = import_editor_package(&state, uploaded.clone()).await;
    remove_uploaded_assets(std::slice::from_ref(&uploaded)).await;
    Ok((StatusCode::CREATED, Json(result?)))
}

async fn import_editor_package(
    state: &AppState,
    package: PathBuf,
) -> ApiResult<EditorPackageImportResponse> {
    let metadata = tokio::fs::metadata(&package).await?;
    if !metadata.is_file() || metadata.len() > MAXIMUM_PACKAGE_BYTES {
        return Err(ApiError::invalid(
            "portable project is not a file or exceeds the package size limit",
        ));
    }
    let import_root = state.data_dir().join("portable-assets");
    tokio::fs::create_dir_all(&import_root).await?;
    let project_id = Uuid::new_v4();
    let staging = import_root.join(format!(".staging-{project_id}"));
    tokio::fs::create_dir(&staging).await?;
    let package_for_worker = package.clone();
    let staging_for_worker = staging.clone();
    let validated = match tokio::task::spawn_blocking(move || {
        extract_editor_package_archive(&package_for_worker, &staging_for_worker)
    })
    .await
    {
        Ok(Ok(validated)) => validated,
        Ok(Err(error)) => {
            let _ = tokio::fs::remove_dir_all(&staging).await;
            return Err(error.into());
        }
        Err(error) => {
            let _ = tokio::fs::remove_dir_all(&staging).await;
            return Err(ApiError::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                "package_worker_failed",
                format!("Portable project worker failed: {error}"),
            ));
        }
    };

    let destination = import_root.join(project_id.to_string());
    if let Err(error) = tokio::fs::rename(&staging, &destination).await {
        let _ = tokio::fs::remove_dir_all(&staging).await;
        return Err(error.into());
    }

    let now = Utc::now();
    let mut project = validated.project;
    project.id = project_id;
    project.name = format!("{}（导入）", project.name.trim());
    project.revision = 1;
    project.created_at = now;
    project.updated_at = now;
    let mut id_map = HashMap::new();
    let mut assets = Vec::with_capacity(validated.manifest.assets.len());
    for packaged in validated.manifest.assets {
        let new_id = Uuid::new_v4();
        id_map.insert(packaged.source_asset_id, new_id);
        let path = destination.join(&packaged.archive_path);
        let mut asset = match asset_from_path(
            state,
            path,
            Some(project_id),
            Some(packaged.name),
            Some(packaged.kind),
        )
        .await
        {
            Ok(asset) => asset,
            Err(error) => {
                let _ = tokio::fs::remove_dir_all(&destination).await;
                return Err(error);
            }
        };
        asset.id = new_id;
        assets.push(asset);
    }
    for clip in project
        .tracks
        .iter_mut()
        .flat_map(|track| track.clips.iter_mut())
    {
        if let Some(source_id) = clip.asset_id {
            clip.asset_id = Some(*id_map.get(&source_id).ok_or_else(|| {
                ApiError::invalid(format!(
                    "portable project is missing source metadata for {source_id}"
                ))
            })?);
        }
    }
    if let Err(error) = project.validate() {
        let _ = tokio::fs::remove_dir_all(&destination).await;
        return Err(error.into());
    }
    let (project, assets) = match state
        .storage
        .import_editor_project_package(project, assets)
        .await
    {
        Ok(imported) => imported,
        Err(error) => {
            let _ = tokio::fs::remove_dir_all(&destination).await;
            return Err(error.into());
        }
    };
    state
        .events
        .publish("editor_project", "imported", Some(project.id));
    for asset in &assets {
        state
            .events
            .publish("media_asset", "created", Some(asset.id));
    }
    Ok(EditorPackageImportResponse { project, assets })
}

fn referenced_editor_asset_ids(project: &EditorProject) -> Vec<Uuid> {
    let mut seen = HashSet::new();
    project
        .tracks
        .iter()
        .flat_map(|track| track.clips.iter())
        .flat_map(|clip| {
            [
                clip.asset_id,
                clip.text.as_ref().and_then(|text| text.font_asset_id),
            ]
            .into_iter()
            .flatten()
        })
        .filter(|id| seen.insert(*id))
        .collect()
}

fn build_editor_package_archive(
    output: &FsPath,
    project: &EditorProject,
    sources: &[EditorPackageSource],
) -> Result<BuiltEditorPackage, vibe_cs_domain::DomainError> {
    if output.exists() {
        return Err(vibe_cs_domain::DomainError::Conflict(
            "portable project output already exists".to_owned(),
        ));
    }
    let parent = output.parent().ok_or_else(|| {
        vibe_cs_domain::DomainError::InvalidInput(
            "portable project output has no parent directory".to_owned(),
        )
    })?;
    if !parent.is_dir() {
        return Err(vibe_cs_domain::DomainError::InvalidInput(
            "portable project output directory does not exist".to_owned(),
        ));
    }
    let project_bytes = serde_json::to_vec_pretty(project).map_err(|error| {
        vibe_cs_domain::DomainError::Internal(format!(
            "unable to serialize portable project: {error}"
        ))
    })?;
    if u64::try_from(project_bytes.len()).unwrap_or(u64::MAX) > MAXIMUM_PACKAGE_DOCUMENT_BYTES {
        return Err(vibe_cs_domain::DomainError::InvalidInput(
            "editor project document exceeds the portable package limit".to_owned(),
        ));
    }
    let project_sha256 = sha256_bytes(&project_bytes);
    let mut manifest_assets = Vec::with_capacity(sources.len());
    let mut total_size = u64::try_from(project_bytes.len()).unwrap_or(u64::MAX);
    for (index, source) in sources.iter().enumerate() {
        let metadata = std::fs::metadata(&source.path)
            .map_err(|error| package_io_error("inspect portable project source", &error))?;
        if !metadata.is_file() || metadata.len() > MAXIMUM_PACKAGE_ASSET_BYTES {
            return Err(vibe_cs_domain::DomainError::InvalidInput(format!(
                "source {} is not a regular file or exceeds the per-asset limit",
                source.source_asset_id
            )));
        }
        total_size = total_size.checked_add(metadata.len()).ok_or_else(|| {
            vibe_cs_domain::DomainError::InvalidInput(
                "portable project asset size overflow".to_owned(),
            )
        })?;
        if total_size > MAXIMUM_PACKAGE_BYTES {
            return Err(vibe_cs_domain::DomainError::InvalidInput(
                "portable project exceeds the total asset size limit".to_owned(),
            ));
        }
        let (sha256, size) = sha256_file(&source.path, MAXIMUM_PACKAGE_ASSET_BYTES)?;
        let archive_path = portable_asset_archive_path(index, &source.path);
        manifest_assets.push(EditorPackageAsset {
            source_asset_id: source.source_asset_id,
            archive_path,
            name: source.name.chars().take(500).collect(),
            kind: source.kind.chars().take(100).collect(),
            size,
            sha256,
        });
    }
    let manifest = EditorPackageManifest {
        format: PORTABLE_PACKAGE_FORMAT.to_owned(),
        version: PORTABLE_PACKAGE_VERSION,
        created_at: Utc::now(),
        project_sha256,
        assets: manifest_assets,
    };
    let manifest_bytes = serde_json::to_vec_pretty(&manifest).map_err(|error| {
        vibe_cs_domain::DomainError::Internal(format!(
            "unable to serialize portable package manifest: {error}"
        ))
    })?;
    if u64::try_from(manifest_bytes.len()).unwrap_or(u64::MAX) > MAXIMUM_PACKAGE_DOCUMENT_BYTES {
        return Err(vibe_cs_domain::DomainError::InvalidInput(
            "portable package manifest exceeds its size limit".to_owned(),
        ));
    }

    let output_name = output
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("project.vcep");
    let temporary = parent.join(format!(".{output_name}.partial.{}", Uuid::new_v4()));
    let result = (|| {
        let file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .map_err(|error| package_io_error("create portable project", &error))?;
        let mut archive = ZipWriter::new(file);
        let options = SimpleFileOptions::default()
            .compression_method(CompressionMethod::Deflated)
            .unix_permissions(0o600);
        archive
            .start_file("manifest.json", options)
            .map_err(package_zip_error)?;
        archive
            .write_all(&manifest_bytes)
            .map_err(|error| package_io_error("write package manifest", &error))?;
        archive
            .start_file("project.json", options)
            .map_err(package_zip_error)?;
        archive
            .write_all(&project_bytes)
            .map_err(|error| package_io_error("write package project", &error))?;
        for (source, packaged) in sources.iter().zip(&manifest.assets) {
            archive
                .start_file(&packaged.archive_path, options)
                .map_err(package_zip_error)?;
            let mut input = std::fs::File::open(&source.path)
                .map_err(|error| package_io_error("open package source", &error))?;
            let mut hasher = Sha256::new();
            let mut written = 0_u64;
            let mut buffer = vec![0_u8; 64 * 1024].into_boxed_slice();
            loop {
                let read = input
                    .read(&mut buffer)
                    .map_err(|error| package_io_error("read package source", &error))?;
                if read == 0 {
                    break;
                }
                written = written
                    .checked_add(u64::try_from(read).unwrap_or(u64::MAX))
                    .ok_or_else(|| {
                        vibe_cs_domain::DomainError::InvalidInput(
                            "portable source size overflow".to_owned(),
                        )
                    })?;
                if written > packaged.size {
                    return Err(vibe_cs_domain::DomainError::Conflict(format!(
                        "source {} changed while it was packaged",
                        source.source_asset_id
                    )));
                }
                hasher.update(&buffer[..read]);
                archive
                    .write_all(&buffer[..read])
                    .map_err(|error| package_io_error("write package source", &error))?;
            }
            if written != packaged.size
                || digest_hex(hasher.finalize().as_slice()) != packaged.sha256
            {
                return Err(vibe_cs_domain::DomainError::Conflict(format!(
                    "source {} changed while it was packaged",
                    source.source_asset_id
                )));
            }
        }
        let file = archive.finish().map_err(package_zip_error)?;
        file.sync_all()
            .map_err(|error| package_io_error("sync portable project", &error))?;
        let (sha256, size) = sha256_file(&temporary, MAXIMUM_PACKAGE_BYTES)?;
        publish_file_without_overwrite(&temporary, output)?;
        Ok(BuiltEditorPackage { size, sha256 })
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&temporary);
    }
    result
}

fn extract_editor_package_archive(
    package: &FsPath,
    staging: &FsPath,
) -> Result<ValidatedEditorPackage, vibe_cs_domain::DomainError> {
    let input = std::fs::File::open(package)
        .map_err(|error| package_io_error("open portable project", &error))?;
    let mut archive = ZipArchive::new(input).map_err(package_zip_error)?;
    if archive.len() > MAXIMUM_PACKAGE_ENTRIES {
        return Err(vibe_cs_domain::DomainError::InvalidInput(format!(
            "portable project contains more than {MAXIMUM_PACKAGE_ENTRIES} entries"
        )));
    }
    let mut names = HashSet::new();
    let mut extracted_assets = HashSet::new();
    let mut total_size = 0_u64;
    let mut extracted_size = 0_u64;
    for index in 0..archive.len() {
        let mut entry = archive.by_index(index).map_err(package_zip_error)?;
        let entry_name = entry.name().to_owned();
        let enclosed = safe_package_entry(&entry_name)?;
        if !names.insert(entry_name.clone()) {
            return Err(vibe_cs_domain::DomainError::InvalidInput(
                "portable project contains duplicate archive paths".to_owned(),
            ));
        }
        if entry.is_dir() {
            return Err(vibe_cs_domain::DomainError::InvalidInput(
                "portable project must not contain directory entries".to_owned(),
            ));
        }
        if entry
            .unix_mode()
            .is_some_and(|mode| mode & 0o170_000 == 0o120_000)
        {
            return Err(vibe_cs_domain::DomainError::InvalidInput(
                "portable project must not contain symbolic links".to_owned(),
            ));
        }
        let is_document = matches!(entry_name.as_str(), "manifest.json" | "project.json");
        let is_asset = entry_name.starts_with("assets/")
            && enclosed.components().count() == 2
            && matches!(enclosed.components().next(), Some(Component::Normal(value)) if value == "assets");
        if !is_document && !is_asset {
            return Err(vibe_cs_domain::DomainError::InvalidInput(format!(
                "portable project contains an unexpected entry: {entry_name}"
            )));
        }
        let maximum = if is_document {
            MAXIMUM_PACKAGE_DOCUMENT_BYTES
        } else {
            MAXIMUM_PACKAGE_ASSET_BYTES
        };
        if entry.size() > maximum {
            return Err(vibe_cs_domain::DomainError::InvalidInput(format!(
                "portable package entry exceeds its size limit: {entry_name}"
            )));
        }
        total_size = total_size.checked_add(entry.size()).ok_or_else(|| {
            vibe_cs_domain::DomainError::InvalidInput(
                "portable project expanded size overflow".to_owned(),
            )
        })?;
        if total_size > MAXIMUM_PACKAGE_BYTES {
            return Err(vibe_cs_domain::DomainError::InvalidInput(
                "portable project exceeds the expanded size limit".to_owned(),
            ));
        }
        let destination = staging.join(&enclosed);
        if let Some(parent) = destination.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|error| package_io_error("create package staging directory", &error))?;
        }
        let mut output = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&destination)
            .map_err(|error| package_io_error("create staged package entry", &error))?;
        let expected = entry.size();
        let remaining = MAXIMUM_PACKAGE_BYTES.saturating_sub(extracted_size);
        let copy_limit = maximum.min(remaining).saturating_add(1);
        let written = std::io::copy(&mut entry.by_ref().take(copy_limit), &mut output)
            .map_err(|error| package_io_error("extract portable package entry", &error))?;
        extracted_size = extracted_size.checked_add(written).ok_or_else(|| {
            vibe_cs_domain::DomainError::InvalidInput(
                "portable project extracted size overflow".to_owned(),
            )
        })?;
        if extracted_size > MAXIMUM_PACKAGE_BYTES {
            return Err(vibe_cs_domain::DomainError::InvalidInput(
                "portable project exceeds the extracted size limit".to_owned(),
            ));
        }
        output
            .sync_all()
            .map_err(|error| package_io_error("sync staged package entry", &error))?;
        if written != expected {
            return Err(vibe_cs_domain::DomainError::InvalidInput(format!(
                "portable package entry size mismatch: {entry_name}"
            )));
        }
        if is_asset {
            extracted_assets.insert(entry_name);
        }
    }

    let manifest_bytes = read_bounded_file(
        &staging.join("manifest.json"),
        MAXIMUM_PACKAGE_DOCUMENT_BYTES,
        "portable package manifest",
    )?;
    let project_bytes = read_bounded_file(
        &staging.join("project.json"),
        MAXIMUM_PACKAGE_DOCUMENT_BYTES,
        "portable project document",
    )?;
    let manifest: EditorPackageManifest =
        serde_json::from_slice(&manifest_bytes).map_err(|error| {
            vibe_cs_domain::DomainError::InvalidInput(format!(
                "portable package manifest is invalid: {error}"
            ))
        })?;
    if manifest.format != PORTABLE_PACKAGE_FORMAT || manifest.version != PORTABLE_PACKAGE_VERSION {
        return Err(vibe_cs_domain::DomainError::InvalidInput(
            "portable package format or version is unsupported".to_owned(),
        ));
    }
    if manifest.assets.len() > MAXIMUM_PACKAGE_ASSETS {
        return Err(vibe_cs_domain::DomainError::InvalidInput(
            "portable package contains too many assets".to_owned(),
        ));
    }
    if !valid_sha256(&manifest.project_sha256)
        || sha256_bytes(&project_bytes) != manifest.project_sha256
    {
        return Err(vibe_cs_domain::DomainError::InvalidInput(
            "portable project document hash does not match its manifest".to_owned(),
        ));
    }
    let project: EditorProject = serde_json::from_slice(&project_bytes).map_err(|error| {
        vibe_cs_domain::DomainError::InvalidInput(format!(
            "portable project document is invalid: {error}"
        ))
    })?;
    project.validate()?;

    let mut source_ids = HashSet::new();
    let mut manifest_paths = HashSet::new();
    for asset in &manifest.assets {
        if !source_ids.insert(asset.source_asset_id)
            || !manifest_paths.insert(asset.archive_path.clone())
        {
            return Err(vibe_cs_domain::DomainError::InvalidInput(
                "portable package contains duplicate asset metadata".to_owned(),
            ));
        }
        let enclosed = safe_package_entry(&asset.archive_path)?;
        if !asset.archive_path.starts_with("assets/") || enclosed.components().count() != 2 {
            return Err(vibe_cs_domain::DomainError::InvalidInput(
                "portable package asset path is invalid".to_owned(),
            ));
        }
        if asset.size > MAXIMUM_PACKAGE_ASSET_BYTES || !valid_sha256(&asset.sha256) {
            return Err(vibe_cs_domain::DomainError::InvalidInput(
                "portable package asset integrity metadata is invalid".to_owned(),
            ));
        }
        let (sha256, size) = sha256_file(&staging.join(enclosed), MAXIMUM_PACKAGE_ASSET_BYTES)?;
        if size != asset.size || sha256 != asset.sha256 {
            return Err(vibe_cs_domain::DomainError::InvalidInput(format!(
                "portable package asset failed integrity verification: {}",
                asset.archive_path
            )));
        }
    }
    if manifest_paths != extracted_assets {
        return Err(vibe_cs_domain::DomainError::InvalidInput(
            "portable package asset files do not match the manifest".to_owned(),
        ));
    }
    let referenced = referenced_editor_asset_ids(&project)
        .into_iter()
        .collect::<HashSet<_>>();
    if referenced != source_ids {
        return Err(vibe_cs_domain::DomainError::InvalidInput(
            "portable project references do not match its packaged assets".to_owned(),
        ));
    }
    Ok(ValidatedEditorPackage { project, manifest })
}

fn safe_package_entry(value: &str) -> Result<PathBuf, vibe_cs_domain::DomainError> {
    if value.is_empty()
        || value.len() > 512
        || value.contains(['\0', '\\'])
        || value.starts_with('/')
    {
        return Err(vibe_cs_domain::DomainError::InvalidInput(
            "portable package contains an unsafe archive path".to_owned(),
        ));
    }
    let path = PathBuf::from(value);
    if !path
        .components()
        .all(|component| matches!(component, Component::Normal(_)))
    {
        return Err(vibe_cs_domain::DomainError::InvalidInput(
            "portable package contains path traversal".to_owned(),
        ));
    }
    Ok(path)
}

fn portable_asset_archive_path(index: usize, path: &FsPath) -> String {
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .filter(|value| {
            !value.is_empty()
                && value.len() <= 10
                && value.bytes().all(|byte| byte.is_ascii_alphanumeric())
        })
        .map(|value| format!(".{}", value.to_ascii_lowercase()))
        .unwrap_or_default();
    format!("assets/{index:03}-source{extension}")
}

fn read_bounded_file(
    path: &FsPath,
    maximum: u64,
    description: &str,
) -> Result<Vec<u8>, vibe_cs_domain::DomainError> {
    let metadata = std::fs::metadata(path).map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            vibe_cs_domain::DomainError::InvalidInput(format!("{description} is missing"))
        } else {
            package_io_error(&format!("read {description}"), &error)
        }
    })?;
    if !metadata.is_file() || metadata.len() > maximum {
        return Err(vibe_cs_domain::DomainError::InvalidInput(format!(
            "{description} is missing or too large"
        )));
    }
    let mut bytes = Vec::with_capacity(usize::try_from(metadata.len()).unwrap_or(0));
    std::fs::File::open(path)
        .map_err(|error| package_io_error(&format!("open {description}"), &error))?
        .take(maximum + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| package_io_error(&format!("read {description}"), &error))?;
    if u64::try_from(bytes.len()).unwrap_or(u64::MAX) > maximum {
        return Err(vibe_cs_domain::DomainError::InvalidInput(format!(
            "{description} exceeds its size limit"
        )));
    }
    Ok(bytes)
}

fn sha256_file(path: &FsPath, maximum: u64) -> Result<(String, u64), vibe_cs_domain::DomainError> {
    let metadata = std::fs::metadata(path)
        .map_err(|error| package_io_error("inspect file for hashing", &error))?;
    if !metadata.is_file() || metadata.len() > maximum {
        return Err(vibe_cs_domain::DomainError::InvalidInput(
            "file exceeds its integrity-check limit".to_owned(),
        ));
    }
    let mut file = std::fs::File::open(path)
        .map_err(|error| package_io_error("open file for hashing", &error))?;
    let mut hasher = Sha256::new();
    let mut length = 0_u64;
    let mut buffer = vec![0_u8; 64 * 1024].into_boxed_slice();
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|error| package_io_error("read file for hashing", &error))?;
        if read == 0 {
            break;
        }
        length = length
            .checked_add(u64::try_from(read).unwrap_or(u64::MAX))
            .ok_or_else(|| {
                vibe_cs_domain::DomainError::InvalidInput("hashed file size overflow".to_owned())
            })?;
        if length > maximum {
            return Err(vibe_cs_domain::DomainError::InvalidInput(
                "file exceeds its integrity-check limit".to_owned(),
            ));
        }
        hasher.update(&buffer[..read]);
    }
    Ok((digest_hex(hasher.finalize().as_slice()), length))
}

fn sha256_bytes(bytes: &[u8]) -> String {
    digest_hex(Sha256::digest(bytes).as_slice())
}

fn digest_hex(bytes: &[u8]) -> String {
    use std::fmt::Write as _;

    bytes.iter().fold(
        String::with_capacity(bytes.len() * 2),
        |mut output, byte| {
            let _ = write!(output, "{byte:02x}");
            output
        },
    )
}

fn valid_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn package_io_error(action: &str, error: &std::io::Error) -> vibe_cs_domain::DomainError {
    vibe_cs_domain::DomainError::Internal(format!("{action} failed: {error}"))
}

fn package_zip_error(error: zip::result::ZipError) -> vibe_cs_domain::DomainError {
    let message = error.to_string();
    drop(error);
    vibe_cs_domain::DomainError::InvalidInput(format!("portable package ZIP is invalid: {message}"))
}

fn publish_file_without_overwrite(
    temporary: &FsPath,
    output: &FsPath,
) -> Result<(), vibe_cs_domain::DomainError> {
    // Both paths share a parent, so creating a hard link publishes the fully
    // synced file atomically while preserving create-new/no-clobber semantics
    // on every supported platform. A plain rename can overwrite on Unix.
    match std::fs::hard_link(temporary, output) {
        Ok(()) => {
            if let Err(error) = std::fs::remove_file(temporary) {
                tracing::warn!(
                    %error,
                    path = %temporary.display(),
                    "portable project was published but its staging link could not be removed"
                );
            }
            Ok(())
        }
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            Err(vibe_cs_domain::DomainError::Conflict(
                "portable project output already exists".to_owned(),
            ))
        }
        Err(error) => Err(package_io_error("publish portable project", &error)),
    }
}

async fn export_editor_project(
    State(state): State<AppState>,
    Path(id): Path<String>,
    ApiJson(request): ApiJson<Value>,
) -> ApiResult<Json<JobAccepted>> {
    let id = parse_id(&id)?;
    if state.storage.get_editor_project(id).await?.is_none() {
        return Err(ApiError::not_found("editor project"));
    }
    start_export(&state, "editor", id, request).await
}

#[derive(Debug, Deserialize)]
struct CompatibleEditorExport {
    project_id: String,
    #[serde(default)]
    options: Value,
}

async fn export_editor_compatible(
    State(state): State<AppState>,
    ApiJson(request): ApiJson<CompatibleEditorExport>,
) -> ApiResult<Json<JobAccepted>> {
    let id = parse_id(&request.project_id)?;
    if state.storage.get_editor_project(id).await?.is_none() {
        return Err(ApiError::not_found("editor project"));
    }
    start_export(&state, "editor", id, request.options).await
}

#[derive(Debug, Default, Deserialize)]
struct AssetQuery {
    project_id: Option<Uuid>,
}

async fn list_assets(
    State(state): State<AppState>,
    ApiQuery(query): ApiQuery<AssetQuery>,
) -> ApiResult<Json<ItemList<MediaAsset>>> {
    Ok(Json(ItemList {
        items: state.storage.list_assets(query.project_id).await?,
    }))
}

async fn get_asset(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> ApiResult<Json<MediaAsset>> {
    state
        .storage
        .get_asset(parse_id(&id)?)
        .await?
        .map(Json)
        .ok_or_else(|| ApiError::not_found("media asset"))
}

async fn stream_asset(
    State(state): State<AppState>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> ApiResult<Response<Body>> {
    let asset = state
        .storage
        .get_asset(parse_id(&id)?)
        .await?
        .ok_or_else(|| ApiError::not_found("media asset"))?;
    stream_media_file(&asset.path, headers, false, "media asset file").await
}

async fn head_asset(
    State(state): State<AppState>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> ApiResult<Response<Body>> {
    let asset = state
        .storage
        .get_asset(parse_id(&id)?)
        .await?
        .ok_or_else(|| ApiError::not_found("media asset"))?;
    stream_media_file(&asset.path, headers, true, "media asset file").await
}

async fn stream_asset_proxy(
    State(state): State<AppState>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> ApiResult<Response<Body>> {
    stream_asset_proxy_response(&state, &id, headers, false).await
}

async fn head_asset_proxy(
    State(state): State<AppState>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> ApiResult<Response<Body>> {
    stream_asset_proxy_response(&state, &id, headers, true).await
}

async fn stream_asset_proxy_response(
    state: &AppState,
    id: &str,
    headers: HeaderMap,
    head_only: bool,
) -> ApiResult<Response<Body>> {
    let asset = state
        .storage
        .get_asset(parse_id(id)?)
        .await?
        .ok_or_else(|| ApiError::not_found("media asset"))?;
    if !matches!(&asset.proxy_status, MediaProxyStatus::Ready { .. }) {
        return Err(ApiError::not_found("media asset proxy"));
    }
    let path = asset
        .proxy_path
        .as_deref()
        .ok_or_else(|| ApiError::not_found("media asset proxy"))?;
    stream_media_file(path, headers, head_only, "media asset proxy").await
}

#[derive(Debug, Deserialize)]
struct RelinkAssetRequest {
    path: String,
}

async fn relink_asset_path(
    State(state): State<AppState>,
    Path(id): Path<String>,
    ApiJson(request): ApiJson<RelinkAssetRequest>,
) -> ApiResult<Json<MediaAsset>> {
    let id = parse_id(&id)?;
    let existing = state
        .storage
        .get_asset(id)
        .await?
        .ok_or_else(|| ApiError::not_found("media asset"))?;
    let path = tokio::fs::canonicalize(&request.path)
        .await
        .map_err(|error| {
            if error.kind() == std::io::ErrorKind::NotFound {
                ApiError::not_found("replacement media file")
            } else {
                error.into()
            }
        })?;
    let replacement = asset_from_path(
        &state,
        path,
        existing.project_id,
        Some(existing.name.clone()),
        None,
    )
    .await?;
    commit_asset_relink(&state, existing, replacement)
        .await
        .map(Json)
}

async fn replace_asset_upload(
    State(state): State<AppState>,
    Path(id): Path<String>,
    ApiMultipart(mut multipart): ApiMultipart,
) -> ApiResult<Json<MediaAsset>> {
    let id = parse_id(&id)?;
    let existing = state
        .storage
        .get_asset(id)
        .await?
        .ok_or_else(|| ApiError::not_found("media asset"))?;
    let upload_dir = state.data_dir().join("uploads").join("assets");
    tokio::fs::create_dir_all(&upload_dir).await?;
    let mut uploaded = None;
    while let Some(mut field) = multipart
        .next_field()
        .await
        .map_err(|error| multipart_error(&error))?
    {
        if field.name() != Some("file") && field.name() != Some("files") {
            continue;
        }
        if uploaded.is_some() {
            if let Some(path) = uploaded.as_ref() {
                remove_uploaded_assets(std::slice::from_ref(path)).await;
            }
            return Err(ApiError::invalid(
                "asset replacement accepts exactly one file",
            ));
        }
        let file_name = field
            .file_name()
            .and_then(safe_file_name)
            .ok_or_else(|| ApiError::invalid("replacement requires a safe file name"))?;
        let destination = upload_dir.join(format!("{}-{file_name}", Uuid::new_v4()));
        persist_multipart_field(&mut field, &destination, MAXIMUM_ASSET_UPLOAD_BATCH_BYTES).await?;
        uploaded = Some(destination);
    }
    let uploaded = uploaded.ok_or_else(|| ApiError::invalid("replacement file is required"))?;
    let replacement = match asset_from_path(
        &state,
        uploaded.clone(),
        existing.project_id,
        Some(existing.name.clone()),
        None,
    )
    .await
    {
        Ok(asset) => asset,
        Err(error) => {
            remove_uploaded_assets(std::slice::from_ref(&uploaded)).await;
            return Err(error);
        }
    };
    match commit_asset_relink(&state, existing, replacement).await {
        Ok(asset) => Ok(Json(asset)),
        Err(error) => {
            remove_uploaded_assets(std::slice::from_ref(&uploaded)).await;
            Err(error)
        }
    }
}

async fn commit_asset_relink(
    state: &AppState,
    existing: MediaAsset,
    replacement: MediaAsset,
) -> ApiResult<MediaAsset> {
    let old_proxy = existing.proxy_path.clone();
    let expected_path = existing.path.clone();
    match state
        .storage
        .relink_media_asset(existing.id, expected_path, replacement)
        .await?
    {
        MediaAssetUpdate::Updated(asset) => {
            state
                .events
                .publish("media_asset", "relinked", Some(asset.id));
            remove_managed_proxy(state, old_proxy.as_deref()).await;
            Ok(*asset)
        }
        MediaAssetUpdate::NotFound => Err(ApiError::not_found("media asset")),
        MediaAssetUpdate::Busy => Err(ApiError::new(
            StatusCode::CONFLICT,
            "proxy_generation_in_progress",
            "Media cannot be relinked while its proxy is being generated",
        )),
        MediaAssetUpdate::Conflict => Err(ApiError::new(
            StatusCode::CONFLICT,
            "asset_changed",
            "Media was relinked by another request",
        )),
    }
}

async fn generate_asset_proxy(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> ApiResult<Json<MediaAsset>> {
    let id = parse_id(&id)?;
    recover_expired_proxy_leases(&state).await?;
    let existing = state
        .storage
        .get_asset(id)
        .await?
        .ok_or_else(|| ApiError::not_found("media asset"))?;
    if !existing.kind.starts_with("video") {
        return Err(ApiError::invalid(
            "editing proxies are supported for video assets only",
        ));
    }
    let duration_seconds = existing
        .duration_seconds
        .filter(|duration| duration.is_finite() && *duration > 0.0)
        .ok_or_else(|| ApiError::invalid("video duration is unavailable; relink or re-import the asset after configuring ffprobe"))?;
    let started_at = Utc::now();
    let lease_id = Uuid::new_v4();
    let expires_at = started_at + chrono::Duration::hours(6);
    let mut asset = match state
        .storage
        .begin_media_proxy_generation(id, lease_id, started_at, expires_at)
        .await?
    {
        MediaAssetUpdate::Updated(asset) => *asset,
        MediaAssetUpdate::NotFound => return Err(ApiError::not_found("media asset")),
        MediaAssetUpdate::Busy => {
            return Err(ApiError::new(
                StatusCode::CONFLICT,
                "proxy_generation_in_progress",
                "A proxy is already being generated for this asset",
            ));
        }
        MediaAssetUpdate::Conflict => {
            return Err(ApiError::new(
                StatusCode::CONFLICT,
                "asset_changed",
                "Media changed before proxy generation could start",
            ));
        }
    };
    let previous_proxy = asset.proxy_path.clone();
    let proxy_dir = state.data_dir().join("proxies");
    if let Err(error) = tokio::fs::create_dir_all(&proxy_dir).await {
        persist_proxy_failure(
            &state,
            asset,
            lease_id,
            format!("cannot create proxy directory: {error}"),
        )
        .await;
        return Err(error.into());
    }
    let output = proxy_dir.join(format!("{id}-{lease_id}.mp4"));
    let request = crate::MediaProxyRequest {
        duration_seconds,
        width: 1280,
        height: 720,
        fps: 30,
        has_audio: asset.has_audio,
    };

    if let Err(error) = state
        .media
        .generate_proxy(PathBuf::from(&asset.path), output.clone(), request)
        .await
    {
        persist_proxy_failure(&state, asset, lease_id, error.to_string()).await;
        let _ = tokio::fs::remove_file(&output).await;
        return Err(error.into());
    }

    let proxy_metadata = tokio::fs::metadata(&output).await;
    if !matches!(proxy_metadata, Ok(ref metadata) if metadata.is_file() && metadata.len() > 0) {
        persist_proxy_failure(
            &state,
            asset,
            lease_id,
            "proxy adapter did not publish a non-empty file".to_owned(),
        )
        .await;
        let _ = tokio::fs::remove_file(&output).await;
        return Err(ApiError::new(
            StatusCode::BAD_GATEWAY,
            "invalid_adapter_response",
            "Proxy adapter did not publish a non-empty file",
        ));
    }

    asset.proxy_path = Some(output.to_string_lossy().into_owned());
    asset.proxy_status = MediaProxyStatus::Ready {
        generated_at: Utc::now(),
    };
    let asset = match state
        .storage
        .finish_media_proxy_generation(asset, lease_id)
        .await?
    {
        MediaAssetUpdate::Updated(asset) => *asset,
        MediaAssetUpdate::NotFound => {
            let _ = tokio::fs::remove_file(&output).await;
            return Err(ApiError::not_found("media asset"));
        }
        MediaAssetUpdate::Busy | MediaAssetUpdate::Conflict => {
            let _ = tokio::fs::remove_file(&output).await;
            return Err(ApiError::new(
                StatusCode::CONFLICT,
                "proxy_generation_superseded",
                "Proxy result was superseded by a newer media operation",
            ));
        }
    };
    state
        .events
        .publish("media_asset", "proxy_ready", Some(asset.id));
    remove_managed_proxy(&state, previous_proxy.as_deref()).await;
    Ok(Json(asset))
}

async fn persist_proxy_failure(
    state: &AppState,
    mut asset: MediaAsset,
    lease_id: Uuid,
    message: String,
) {
    asset.proxy_status = MediaProxyStatus::Failed {
        message: message.chars().take(500).collect(),
        failed_at: Utc::now(),
    };
    if matches!(
        state
            .storage
            .finish_media_proxy_generation(asset.clone(), lease_id)
            .await,
        Ok(MediaAssetUpdate::Updated(_))
    ) {
        state
            .events
            .publish("media_asset", "proxy_failed", Some(asset.id));
    }
}

async fn recover_expired_proxy_leases(state: &AppState) -> ApiResult<usize> {
    let recovered = state
        .storage
        .recover_expired_media_proxy_generations(Utc::now())
        .await?;
    for asset in &recovered {
        state
            .events
            .publish("media_asset", "proxy_expired", Some(asset.id));
    }
    Ok(recovered.len())
}

async fn remove_managed_proxy(state: &AppState, path: Option<&str>) {
    let Some(path) = path else {
        return;
    };
    let proxy_root = state.data_dir().join("proxies");
    let candidate = PathBuf::from(path);
    if candidate.parent() == Some(proxy_root.as_path()) {
        match tokio::fs::remove_file(&candidate).await {
            Err(error) if error.kind() != std::io::ErrorKind::NotFound => {
                tracing::warn!(%error, path = %candidate.display(), "unable to remove superseded proxy");
            }
            _ => {}
        }
    }
}

#[derive(Debug, Serialize)]
struct ProxyCleanupResponse {
    removed_files: usize,
    freed_bytes: u64,
    failed_files: Vec<String>,
    skipped_generating: usize,
}

async fn cleanup_asset_proxies(
    State(state): State<AppState>,
) -> ApiResult<Json<ProxyCleanupResponse>> {
    let _ = recover_expired_proxy_leases(&state).await?;
    let (quarantine_removed, quarantine_failures) =
        recover_editor_project_quarantines(&state).await;
    let plan = state.storage.prepare_media_proxy_cleanup().await?;
    let proxy_root = state.data_dir().join("proxies");
    let mut generating = plan
        .generating_asset_ids
        .iter()
        .map(Uuid::to_string)
        .collect::<Vec<_>>();
    let mut candidates = HashSet::new();
    for path in plan.detached_paths {
        let path = PathBuf::from(path);
        if path.parent() == Some(proxy_root.as_path()) {
            candidates.insert(path);
        }
    }
    match tokio::fs::read_dir(&proxy_root).await {
        Ok(mut entries) => {
            while let Some(entry) = entries.next_entry().await? {
                let file_name = entry.file_name().to_string_lossy().into_owned();
                if file_name.starts_with('.')
                    || !FsPath::new(&file_name)
                        .extension()
                        .is_some_and(|extension| extension.eq_ignore_ascii_case("mp4"))
                    || generating
                        .iter()
                        .any(|asset_id| file_name.starts_with(&format!("{asset_id}-")))
                {
                    continue;
                }
                if entry.file_type().await?.is_file() {
                    candidates.insert(entry.path());
                }
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
    }

    // Generation can start after prepare_media_proxy_cleanup commits. Take a
    // second ownership snapshot after directory enumeration: files created by
    // an overlapping generation are then either protected by its asset ID or
    // by the newly-persisted ready path. A generation that starts after this
    // snapshot cannot have appeared in the completed enumeration.
    let current_assets = state.storage.list_assets(None).await?;
    let protected_paths = current_assets
        .iter()
        .filter_map(|asset| asset.proxy_path.as_deref())
        .map(PathBuf::from)
        .collect::<HashSet<_>>();
    for asset in current_assets {
        if matches!(asset.proxy_status, MediaProxyStatus::Generating { .. }) {
            let id = asset.id.to_string();
            if !generating.contains(&id) {
                generating.push(id);
            }
        }
    }
    candidates.retain(|path| {
        if protected_paths.contains(path) {
            return false;
        }
        let file_name = path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or_default();
        !generating
            .iter()
            .any(|asset_id| file_name.starts_with(&format!("{asset_id}-")))
    });

    let mut response = ProxyCleanupResponse {
        removed_files: quarantine_removed,
        freed_bytes: 0,
        failed_files: quarantine_failures,
        skipped_generating: generating.len(),
    };
    for path in candidates {
        let size = tokio::fs::symlink_metadata(&path)
            .await
            .map_or(0, |metadata| metadata.len());
        match tokio::fs::remove_file(&path).await {
            Ok(()) => {
                response.removed_files += 1;
                response.freed_bytes = response.freed_bytes.saturating_add(size);
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                tracing::warn!(%error, path = %path.display(), "proxy cleanup will retry this file later");
                response.failed_files.push(
                    path.file_name()
                        .and_then(|name| name.to_str())
                        .unwrap_or("unknown-proxy")
                        .to_owned(),
                );
            }
        }
    }
    state.events.publish("media_proxy", "cleaned", None);
    Ok(Json(response))
}

async fn asset_waveform(
    State(state): State<AppState>,
    Path(id): Path<String>,
    ApiQuery(query): ApiQuery<WaveformQuery>,
) -> ApiResult<Json<WaveformResponse>> {
    validate_waveform_buckets(query.buckets)?;
    let id = parse_id(&id)?;
    let mut asset = state
        .storage
        .get_asset(id)
        .await?
        .ok_or_else(|| ApiError::not_found("media asset"))?;
    if let Some(cached) = asset.waveform.as_deref().filter(|points| {
        !points.is_empty()
            && points.len() <= WAVEFORM_CACHE_BUCKETS
            && points
                .iter()
                .all(|point| point.is_finite() && (0.0..=1.0).contains(point))
    }) {
        return Ok(Json(WaveformResponse {
            waveform: rebucket_peaks(cached, query.buckets),
            cached: true,
        }));
    }
    let waveform = generate_waveform(&state, &asset.path).await?;
    asset.waveform = Some(waveform.clone());
    state.storage.put_asset(asset).await?;
    state.events.publish("media_asset", "updated", Some(id));
    Ok(Json(WaveformResponse {
        waveform: rebucket_peaks(&waveform, query.buckets),
        cached: false,
    }))
}

async fn extract_asset_audio(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> ApiResult<(StatusCode, Json<MediaAsset>)> {
    let source = state
        .storage
        .get_asset(parse_id(&id)?)
        .await?
        .ok_or_else(|| ApiError::not_found("media asset"))?;
    if !source.kind.starts_with("video") || !source.has_audio {
        return Err(ApiError::invalid(
            "audio extraction requires a video asset with an audio stream",
        ));
    }
    let duration = source
        .duration_seconds
        .filter(|duration| duration.is_finite() && *duration > 0.0)
        .ok_or_else(|| ApiError::invalid("source duration is unavailable"))?;
    let upload_dir = state.data_dir().join("uploads").join("assets");
    tokio::fs::create_dir_all(&upload_dir).await?;
    let output = upload_dir.join(format!("{}-audio.m4a", Uuid::new_v4()));
    if let Err(error) = state
        .media
        .extract_audio(PathBuf::from(&source.path), output.clone(), duration)
        .await
    {
        let _ = tokio::fs::remove_file(&output).await;
        return Err(error.into());
    }
    let asset = match asset_from_path(
        &state,
        output.clone(),
        source.project_id,
        Some(format!("{} · 独立音轨", source.name)),
        Some("audio/mp4".to_owned()),
    )
    .await
    {
        Ok(asset) => asset,
        Err(error) => {
            let _ = tokio::fs::remove_file(&output).await;
            return Err(error);
        }
    };
    let asset = match state.storage.put_asset(asset).await {
        Ok(asset) => asset,
        Err(error) => {
            let _ = tokio::fs::remove_file(&output).await;
            return Err(error.into());
        }
    };
    state
        .events
        .publish("media_asset", "audio_extracted", Some(asset.id));
    Ok((StatusCode::CREATED, Json(asset)))
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct SeparateEditorAudioRequest {
    expected_revision: u64,
    #[serde(default = "default_true")]
    mute_source: bool,
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Serialize)]
struct SeparateEditorAudioResponse {
    project: EditorProject,
    asset: MediaAsset,
}

struct PendingGeneratedAsset {
    path: PathBuf,
    armed: bool,
}

impl PendingGeneratedAsset {
    fn new(path: PathBuf) -> Self {
        Self { path, armed: true }
    }

    fn disarm(&mut self) {
        self.armed = false;
    }
}

impl Drop for PendingGeneratedAsset {
    fn drop(&mut self) {
        if !self.armed {
            return;
        }
        match std::fs::remove_file(&self.path) {
            Err(error) if error.kind() != std::io::ErrorKind::NotFound => {
                tracing::warn!(
                    %error,
                    path = %self.path.display(),
                    "unable to remove uncommitted extracted audio"
                );
            }
            _ => {}
        }
    }
}

async fn separate_editor_clip_audio(
    State(state): State<AppState>,
    Path((project_id, clip_id)): Path<(String, String)>,
    ApiJson(request): ApiJson<SeparateEditorAudioRequest>,
) -> ApiResult<(StatusCode, Json<SeparateEditorAudioResponse>)> {
    let project_id = parse_id(&project_id)?;
    let clip_id = parse_id(&clip_id)?;
    let project = state
        .storage
        .get_editor_project(project_id)
        .await?
        .ok_or_else(|| ApiError::not_found("editor project"))?;
    if let Some(audio_clip_id) = project.separated_audio_clip_id(clip_id) {
        return Err(audio_already_separated(audio_clip_id));
    }
    if project.revision != request.expected_revision {
        return Err(ApiError::new(
            StatusCode::CONFLICT,
            "revision_conflict",
            format!("Editor project is at revision {}", project.revision),
        ));
    }
    let (track, clip) = project
        .tracks
        .iter()
        .find_map(|track| {
            track
                .clips
                .iter()
                .find(|clip| clip.id == clip_id)
                .map(|clip| (track, clip))
        })
        .ok_or_else(|| ApiError::not_found("editor clip"))?;
    if track.kind != TrackKind::Video || clip.text.is_some() {
        return Err(ApiError::invalid(
            "audio can only be separated from a video clip",
        ));
    }
    if track.locked {
        return Err(ApiError::invalid("source video track is locked"));
    }
    let source_asset_id = clip
        .asset_id
        .ok_or_else(|| ApiError::invalid("source video clip has no media asset"))?;
    let source = state
        .storage
        .get_asset(source_asset_id)
        .await?
        .ok_or_else(|| ApiError::not_found("media asset"))?;
    if !source.kind.starts_with("video") || !source.has_audio {
        return Err(ApiError::invalid(
            "audio separation requires a video asset with an audio stream",
        ));
    }
    let duration = source
        .duration_seconds
        .filter(|duration| duration.is_finite() && *duration > 0.0)
        .ok_or_else(|| ApiError::invalid("source duration is unavailable"))?;
    let upload_dir = state.data_dir().join("uploads").join("assets");
    tokio::fs::create_dir_all(&upload_dir).await?;
    let audio_asset_id = Uuid::new_v4();
    let output = upload_dir.join(format!("{audio_asset_id}-audio.m4a"));
    let mut cleanup = PendingGeneratedAsset::new(output.clone());
    state
        .media
        .extract_audio(PathBuf::from(&source.path), output.clone(), duration)
        .await?;
    let mut asset = asset_from_path(
        &state,
        output,
        Some(project_id),
        Some(format!("{} · 独立音轨", source.name)),
        Some("audio/mp4".to_owned()),
    )
    .await?;
    asset.id = audio_asset_id;
    asset.project_id = Some(project_id);
    let separation = EditorAudioSeparation {
        source_clip_id: clip_id,
        source_asset_id,
        audio_asset_id,
        audio_clip_id: Uuid::new_v4(),
        audio_track_id: Uuid::new_v4(),
        link_group_id: Uuid::new_v4(),
        audio_name: asset.name.clone(),
        mute_source: request.mute_source,
    };
    match state
        .storage
        .separate_editor_audio(project_id, request.expected_revision, separation, asset)
        .await?
    {
        EditorAudioSeparationUpdate::Applied(result) => {
            cleanup.disarm();
            state
                .events
                .publish("editor_project", "audio_separated", Some(result.project.id));
            state
                .events
                .publish("media_asset", "audio_extracted", Some(result.asset.id));
            Ok((
                StatusCode::CREATED,
                Json(SeparateEditorAudioResponse {
                    project: result.project,
                    asset: result.asset,
                }),
            ))
        }
        EditorAudioSeparationUpdate::ProjectNotFound => Err(ApiError::not_found("editor project")),
        EditorAudioSeparationUpdate::ClipNotFound => Err(ApiError::not_found("editor clip")),
        EditorAudioSeparationUpdate::AssetAlreadyExists => Err(ApiError::new(
            StatusCode::CONFLICT,
            "asset_conflict",
            "Generated audio asset identifier is already in use",
        )),
        EditorAudioSeparationUpdate::AlreadySeparated { audio_clip_id } => {
            Err(audio_already_separated(audio_clip_id))
        }
        EditorAudioSeparationUpdate::Conflict { current_revision } => Err(ApiError::new(
            StatusCode::CONFLICT,
            "revision_conflict",
            format!("Editor project is at revision {current_revision}"),
        )),
    }
}

fn audio_already_separated(audio_clip_id: Uuid) -> ApiError {
    ApiError::new(
        StatusCode::CONFLICT,
        "audio_already_separated",
        format!("Source clip already has separated audio clip {audio_clip_id}"),
    )
}

fn validate_waveform_buckets(buckets: usize) -> ApiResult<()> {
    if (16..=WAVEFORM_CACHE_BUCKETS).contains(&buckets) {
        Ok(())
    } else {
        Err(ApiError::invalid(format!(
            "buckets must be between 16 and {WAVEFORM_CACHE_BUCKETS}"
        )))
    }
}

async fn generate_waveform(state: &AppState, path: &str) -> ApiResult<Vec<f32>> {
    let waveform = state
        .media
        .waveform(std::path::PathBuf::from(path), WAVEFORM_CACHE_BUCKETS)
        .await?;
    if waveform.is_empty()
        || waveform.len() > WAVEFORM_CACHE_BUCKETS
        || waveform
            .iter()
            .any(|point| !point.is_finite() || !(0.0..=1.0).contains(point))
    {
        return Err(ApiError::new(
            StatusCode::BAD_GATEWAY,
            "invalid_adapter_response",
            "Waveform adapter returned invalid peak data",
        ));
    }
    Ok(waveform)
}

fn cached_recorded_waveform(metadata: &Value) -> Option<Vec<f32>> {
    let value = metadata.get("waveform")?;
    let values = value.as_array()?;
    if values.is_empty() || values.len() > WAVEFORM_CACHE_BUCKETS {
        return None;
    }
    serde_json::from_value::<Vec<f32>>(value.clone())
        .ok()
        .filter(|points| {
            points
                .iter()
                .all(|point| point.is_finite() && (0.0..=1.0).contains(point))
        })
}

fn rebucket_peaks(points: &[f32], buckets: usize) -> Vec<f32> {
    let count = buckets.min(points.len());
    (0..count)
        .map(|bucket| {
            let start = bucket * points.len() / count;
            let end = ((bucket + 1) * points.len() / count).max(start + 1);
            points[start..end].iter().copied().fold(0.0_f32, f32::max)
        })
        .collect()
}

#[derive(Debug, Deserialize)]
struct ImportAssetRequest {
    project_id: Option<Uuid>,
    path: String,
    name: Option<String>,
    kind: Option<String>,
}

async fn import_asset(
    State(state): State<AppState>,
    ApiJson(request): ApiJson<ImportAssetRequest>,
) -> ApiResult<(StatusCode, Json<MediaAsset>)> {
    let path = tokio::fs::canonicalize(&request.path)
        .await
        .map_err(|error| {
            if error.kind() == std::io::ErrorKind::NotFound {
                ApiError::not_found("media file")
            } else {
                error.into()
            }
        })?;
    let asset =
        asset_from_path(&state, path, request.project_id, request.name, request.kind).await?;
    let asset = state.storage.put_asset(asset).await?;
    state
        .events
        .publish("media_asset", "created", Some(asset.id));
    Ok((StatusCode::CREATED, Json(asset)))
}

async fn upload_assets(
    State(state): State<AppState>,
    ApiMultipart(mut multipart): ApiMultipart,
) -> ApiResult<(StatusCode, Json<ItemList<MediaAsset>>)> {
    let upload_dir = state.data_dir().join("uploads").join("assets");
    tokio::fs::create_dir_all(&upload_dir).await?;
    let mut project_id = None;
    let mut uploaded = Vec::new();
    if let Err(error) =
        receive_asset_uploads(&mut multipart, &upload_dir, &mut project_id, &mut uploaded).await
    {
        remove_uploaded_assets(&uploaded).await;
        return Err(error);
    }

    let probed = stream::iter(
        uploaded
            .iter()
            .cloned()
            .map(|path| asset_from_path(&state, path, project_id, None, None)),
    )
    .buffered(4)
    .collect::<Vec<_>>()
    .await;
    let mut staged = Vec::with_capacity(probed.len());
    for result in probed {
        match result {
            Ok(asset) => staged.push(asset),
            Err(error) => {
                remove_uploaded_assets(&uploaded).await;
                return Err(error);
            }
        }
    }
    let mut items = Vec::with_capacity(staged.len());
    for asset in staged {
        match state.storage.put_asset(asset).await {
            Ok(asset) => items.push(asset),
            Err(error) => {
                rollback_asset_import(&state, &uploaded, &items).await;
                return Err(error.into());
            }
        }
    }
    for asset in &items {
        state
            .events
            .publish("media_asset", "created", Some(asset.id));
    }
    Ok((StatusCode::CREATED, Json(ItemList { items })))
}

async fn receive_asset_uploads(
    multipart: &mut axum::extract::Multipart,
    upload_dir: &FsPath,
    project_id: &mut Option<Uuid>,
    uploaded: &mut Vec<std::path::PathBuf>,
) -> ApiResult<()> {
    let mut uploaded_bytes = 0_u64;
    while let Some(mut field) = multipart
        .next_field()
        .await
        .map_err(|error| multipart_error(&error))?
    {
        if field.name() == Some("project_id") {
            let value = read_multipart_text(&mut field, 128).await?;
            *project_id = Some(parse_id(&value)?);
            continue;
        }
        if field.name() != Some("files") && field.name() != Some("file") {
            continue;
        }
        if uploaded.len() >= MAXIMUM_ASSET_UPLOAD_FILES {
            return Err(ApiError::invalid(format!(
                "an asset upload may contain at most {MAXIMUM_ASSET_UPLOAD_FILES} files"
            )));
        }
        let file_name = field
            .file_name()
            .and_then(safe_file_name)
            .ok_or_else(|| ApiError::invalid("uploaded asset requires a safe file name"))?;
        let destination = upload_dir.join(format!("{}-{file_name}", Uuid::new_v4()));
        let remaining = MAXIMUM_ASSET_UPLOAD_BATCH_BYTES.saturating_sub(uploaded_bytes);
        if remaining == 0 {
            return Err(ApiError::invalid(format!(
                "asset upload exceeds the {MAXIMUM_ASSET_UPLOAD_BATCH_BYTES} byte batch limit"
            )));
        }
        let written = persist_multipart_field(&mut field, &destination, remaining).await?;
        uploaded_bytes = uploaded_bytes.saturating_add(written);
        uploaded.push(destination);
    }
    Ok(())
}

async fn remove_uploaded_assets(paths: &[std::path::PathBuf]) {
    for path in paths {
        match tokio::fs::remove_file(path).await {
            Err(error) if error.kind() != std::io::ErrorKind::NotFound => {
                tracing::warn!(%error, path = %path.display(), "unable to remove rolled-back asset upload");
            }
            _ => {}
        }
    }
}

async fn rollback_asset_import(
    state: &AppState,
    paths: &[std::path::PathBuf],
    persisted: &[MediaAsset],
) {
    let mut database_rolled_back = true;
    for asset in persisted {
        if let Err(error) = state.storage.delete_asset(asset.id).await {
            database_rolled_back = false;
            tracing::error!(%error, asset_id = %asset.id, "unable to roll back imported asset");
        }
    }
    if database_rolled_back {
        remove_uploaded_assets(paths).await;
    } else {
        tracing::error!(
            "asset database rollback was incomplete; uploaded files were preserved to avoid broken records"
        );
    }
}

async fn put_asset(
    State(state): State<AppState>,
    Path(id): Path<String>,
    ApiJson(asset): ApiJson<MediaAsset>,
) -> ApiResult<Json<MediaAsset>> {
    let id = parse_id(&id)?;
    if asset.id != id {
        return Err(ApiError::invalid("path id and asset id must match"));
    }
    if state.storage.get_asset(id).await?.is_none() {
        return Err(ApiError::not_found("media asset"));
    }
    validate_media_path(&asset.path).await?;
    let asset = state.storage.put_asset(asset).await?;
    state.events.publish("media_asset", "updated", Some(id));
    Ok(Json(asset))
}

async fn delete_asset(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> ApiResult<StatusCode> {
    let id = parse_id(&id)?;
    if !state.storage.delete_asset(id).await? {
        return Err(ApiError::not_found("media asset"));
    }
    state.events.publish("media_asset", "deleted", Some(id));
    Ok(StatusCode::NO_CONTENT)
}

async fn asset_from_path(
    state: &AppState,
    path: std::path::PathBuf,
    project_id: Option<Uuid>,
    name: Option<String>,
    kind: Option<String>,
) -> ApiResult<MediaAsset> {
    let metadata = tokio::fs::metadata(&path).await?;
    if !metadata.is_file() {
        return Err(ApiError::invalid("asset path must be a file"));
    }
    let fallback_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("asset")
        .to_owned();
    let inferred_kind = mime_guess::from_path(&path)
        .first()
        .map_or_else(|| "binary".to_owned(), |mime| mime.type_().to_string());
    let (duration_seconds, width, height, has_audio, metadata_status) =
        match state.media.probe(path.clone()).await {
            Ok(probe) => (
                probe.duration_seconds,
                probe.width,
                probe.height,
                probe.has_audio,
                MediaMetadataStatus::Ready,
            ),
            Err(error) => {
                let message = error.to_string().chars().take(500).collect::<String>();
                tracing::warn!(%error, path = %path.display(), "media metadata probe unavailable");
                (
                    None,
                    None,
                    None,
                    false,
                    MediaMetadataStatus::Unavailable { message },
                )
            }
        };
    Ok(MediaAsset {
        id: Uuid::new_v4(),
        project_id,
        path: path.to_string_lossy().into_owned(),
        name: name.unwrap_or(fallback_name),
        kind: kind.unwrap_or(inferred_kind),
        duration_seconds,
        width,
        height,
        file_size: metadata.len(),
        has_audio,
        proxy_path: None,
        proxy_status: MediaProxyStatus::NotRequested,
        waveform: None,
        metadata_status,
        created_at: Utc::now(),
    })
}

async fn list_presets(State(state): State<AppState>) -> ApiResult<Json<ItemList<PresetRecord>>> {
    Ok(Json(ItemList {
        items: state.storage.list_presets().await?,
    }))
}

async fn get_preset(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> ApiResult<Json<PresetRecord>> {
    state
        .storage
        .get_preset(parse_id(&id)?)
        .await?
        .map(Json)
        .ok_or_else(|| ApiError::not_found("editor preset"))
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct CreatePresetRequest {
    name: String,
    document: EditorPresetDocument,
}

fn validate_preset(name: &str, document: &EditorPresetDocument) -> ApiResult<()> {
    let length = name.trim().chars().count();
    if !(1..=100).contains(&length) {
        return Err(ApiError::invalid(
            "editor preset name must contain between 1 and 100 characters",
        ));
    }
    document.validate()?;
    Ok(())
}

async fn create_preset(
    State(state): State<AppState>,
    ApiJson(request): ApiJson<CreatePresetRequest>,
) -> ApiResult<(StatusCode, Json<PresetRecord>)> {
    validate_preset(&request.name, &request.document)?;
    let now = Utc::now();
    let preset = PresetRecord {
        id: Uuid::new_v4(),
        name: request.name.trim().to_owned(),
        revision: 1,
        document: request.document,
        created_at: now,
        updated_at: now,
    };
    let preset = state.storage.create_preset(preset).await?;
    state
        .events
        .publish("editor_preset", "created", Some(preset.id));
    Ok((StatusCode::CREATED, Json(preset)))
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct UpdatePresetRequest {
    name: String,
    expected_revision: u64,
    document: EditorPresetDocument,
}

async fn put_preset(
    State(state): State<AppState>,
    Path(id): Path<String>,
    ApiJson(request): ApiJson<UpdatePresetRequest>,
) -> ApiResult<Json<PresetRecord>> {
    let id = parse_id(&id)?;
    validate_preset(&request.name, &request.document)?;
    let now = Utc::now();
    let preset = PresetRecord {
        id,
        name: request.name.trim().to_owned(),
        revision: request.expected_revision,
        document: request.document,
        created_at: now,
        updated_at: now,
    };
    match state
        .storage
        .update_preset(preset, request.expected_revision)
        .await?
    {
        PresetUpdate::Updated(preset) => {
            state.events.publish("editor_preset", "updated", Some(id));
            Ok(Json(preset))
        }
        PresetUpdate::NotFound => Err(ApiError::not_found("editor preset")),
        PresetUpdate::Conflict { current_revision } => Err(ApiError::new(
            StatusCode::CONFLICT,
            "preset_revision_conflict",
            format!("Editor preset is at revision {current_revision}"),
        )),
    }
}

#[derive(Debug, Deserialize)]
struct DeletePresetQuery {
    expected_revision: u64,
}

async fn delete_preset(
    State(state): State<AppState>,
    Path(id): Path<String>,
    ApiQuery(query): ApiQuery<DeletePresetQuery>,
) -> ApiResult<StatusCode> {
    let id = parse_id(&id)?;
    match state
        .storage
        .delete_preset(id, query.expected_revision)
        .await?
    {
        PresetDelete::Deleted(_) => {
            state.events.publish("editor_preset", "deleted", Some(id));
            Ok(StatusCode::NO_CONTENT)
        }
        PresetDelete::NotFound => Err(ApiError::not_found("editor preset")),
        PresetDelete::Conflict { current_revision } => Err(ApiError::new(
            StatusCode::CONFLICT,
            "preset_revision_conflict",
            format!("Editor preset is at revision {current_revision}"),
        )),
    }
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ApplyPresetRequest {
    preset_id: Uuid,
    expected_project_revision: u64,
    expected_preset_revision: u64,
}

async fn apply_editor_preset(
    State(state): State<AppState>,
    Path((project_id, clip_id)): Path<(String, String)>,
    ApiJson(request): ApiJson<ApplyPresetRequest>,
) -> ApiResult<Json<EditorProject>> {
    let project_id = parse_id(&project_id)?;
    let clip_id = parse_id(&clip_id)?;
    match state
        .storage
        .apply_editor_preset(
            project_id,
            clip_id,
            request.preset_id,
            request.expected_project_revision,
            request.expected_preset_revision,
        )
        .await?
    {
        PresetApply::Applied(project) => {
            state
                .events
                .publish("editor_project", "preset_applied", Some(project_id));
            Ok(Json(project))
        }
        PresetApply::ProjectNotFound => Err(ApiError::not_found("editor project")),
        PresetApply::PresetNotFound => Err(ApiError::not_found("editor preset")),
        PresetApply::ClipNotFound => Err(ApiError::not_found("editor clip")),
        PresetApply::ProjectConflict { current_revision } => Err(ApiError::new(
            StatusCode::CONFLICT,
            "revision_conflict",
            format!("Editor project is at revision {current_revision}"),
        )),
        PresetApply::PresetConflict { current_revision } => Err(ApiError::new(
            StatusCode::CONFLICT,
            "preset_revision_conflict",
            format!("Editor preset is at revision {current_revision}"),
        )),
    }
}

#[derive(Debug, Serialize)]
struct JobAccepted {
    job_id: Uuid,
    status: &'static str,
}

async fn start_export(
    state: &AppState,
    kind: &str,
    project_id: Uuid,
    request: Value,
) -> ApiResult<Json<JobAccepted>> {
    let job = state.exports.start(kind, project_id, request).await?;
    let status = accepted_status(job.status)?;
    state.events.publish("export_job", "changed", Some(job.id));
    Ok(Json(JobAccepted {
        job_id: job.id,
        status,
    }))
}

async fn get_export_job(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> ApiResult<Json<ExportJobRecord>> {
    state
        .storage
        .get_export_job(parse_id(&id)?)
        .await?
        .map(Json)
        .ok_or_else(|| ApiError::not_found("export job"))
}

#[derive(Debug, Default, Deserialize)]
struct ExportListQuery {
    project_id: Option<Uuid>,
}

async fn list_export_jobs(
    State(state): State<AppState>,
    ApiQuery(query): ApiQuery<ExportListQuery>,
) -> ApiResult<Json<ItemList<ExportJobRecord>>> {
    Ok(Json(ItemList {
        items: state.storage.list_export_jobs(query.project_id).await?,
    }))
}

async fn cancel_export_job(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> ApiResult<Json<ExportJobRecord>> {
    let id = parse_id(&id)?;
    state.exports.cancel(id).await?;
    let record = state
        .storage
        .get_export_job(id)
        .await?
        .ok_or_else(|| ApiError::not_found("export job"))?;
    state.events.publish("export_job", "changed", Some(id));
    Ok(Json(record))
}

fn accepted_status(status: JobStatus) -> ApiResult<&'static str> {
    match status {
        JobStatus::Queued | JobStatus::Preparing => Ok("queued"),
        JobStatus::Running => Ok("running"),
        _ => Err(ApiError::new(
            StatusCode::BAD_GATEWAY,
            "invalid_adapter_response",
            "Export adapter did not return an accepted job",
        )),
    }
}

fn resolution_dimensions(resolution: &str) -> ApiResult<(u32, u32)> {
    match resolution {
        "1080p" => Ok((1920, 1080)),
        "1440p" => Ok((2560, 1440)),
        "2160p" => Ok((3840, 2160)),
        _ => Err(ApiError::invalid("unsupported montage resolution")),
    }
}

fn safe_file_name(file_name: &str) -> Option<String> {
    FsPath::new(file_name)
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty())
        .map(ToOwned::to_owned)
}

async fn validate_media_path(path: &str) -> ApiResult<()> {
    let metadata = tokio::fs::metadata(path).await.map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            ApiError::not_found("media file")
        } else {
            error.into()
        }
    })?;
    if !metadata.is_file() {
        return Err(ApiError::invalid("media path must be a file"));
    }
    Ok(())
}

fn parse_id(id: &str) -> ApiResult<Uuid> {
    Uuid::parse_str(id).map_err(|_| ApiError::invalid("id must be a UUID"))
}

#[cfg(test)]
mod tests {
    use std::{
        path::PathBuf,
        sync::{
            Arc,
            atomic::{AtomicUsize, Ordering},
        },
    };

    use axum::{
        body::{Body, to_bytes},
        extract::{FromRequest, Multipart},
        http::{Request, header},
        response::IntoResponse,
    };

    use super::*;

    #[cfg(unix)]
    fn create_directory_symlink(target: &FsPath, link: &FsPath) -> std::io::Result<()> {
        std::os::unix::fs::symlink(target, link)
    }

    #[cfg(windows)]
    fn create_directory_symlink(target: &FsPath, link: &FsPath) -> std::io::Result<()> {
        std::os::windows::fs::symlink_dir(target, link)
    }

    #[derive(Debug)]
    struct FailingMedia;

    #[derive(Debug, Default)]
    struct WaveformMedia {
        calls: AtomicUsize,
    }

    #[derive(Debug, Default)]
    struct RetryProxyMedia {
        calls: AtomicUsize,
    }

    #[derive(Debug, Default)]
    struct BlockingProxyMedia {
        started: tokio::sync::Notify,
    }

    #[derive(Debug, Default)]
    struct ExtractAudioMedia {
        calls: AtomicUsize,
    }

    #[derive(Debug, Default)]
    struct BlockingExtractAudioMedia {
        started: tokio::sync::Notify,
        release: tokio::sync::Notify,
    }

    #[async_trait::async_trait]
    impl crate::MediaPort for FailingMedia {
        async fn probe(
            &self,
            _path: PathBuf,
        ) -> Result<crate::ProbedMediaMetadata, vibe_cs_domain::DomainError> {
            Err(vibe_cs_domain::DomainError::DependencyUnavailable(
                "ffprobe".to_owned(),
            ))
        }

        async fn waveform(
            &self,
            _path: PathBuf,
            _buckets: usize,
        ) -> Result<Vec<f32>, vibe_cs_domain::DomainError> {
            Err(vibe_cs_domain::DomainError::DependencyUnavailable(
                "ffmpeg".to_owned(),
            ))
        }
    }

    #[async_trait::async_trait]
    impl crate::MediaPort for WaveformMedia {
        async fn probe(
            &self,
            _path: PathBuf,
        ) -> Result<crate::ProbedMediaMetadata, vibe_cs_domain::DomainError> {
            Ok(crate::ProbedMediaMetadata::default())
        }

        async fn waveform(
            &self,
            _path: PathBuf,
            buckets: usize,
        ) -> Result<Vec<f32>, vibe_cs_domain::DomainError> {
            self.calls.fetch_add(1, Ordering::Relaxed);
            Ok(vec![0.25; buckets])
        }
    }

    #[async_trait::async_trait]
    impl crate::MediaPort for RetryProxyMedia {
        async fn probe(
            &self,
            _path: PathBuf,
        ) -> Result<crate::ProbedMediaMetadata, vibe_cs_domain::DomainError> {
            self.calls.fetch_add(1, Ordering::Relaxed);
            Ok(crate::ProbedMediaMetadata {
                duration_seconds: Some(2.0),
                width: Some(1920),
                height: Some(1080),
                has_audio: true,
            })
        }

        async fn waveform(
            &self,
            _path: PathBuf,
            _buckets: usize,
        ) -> Result<Vec<f32>, vibe_cs_domain::DomainError> {
            Ok(Vec::new())
        }

        async fn generate_proxy(
            &self,
            _source: PathBuf,
            output: PathBuf,
            _request: crate::MediaProxyRequest,
        ) -> Result<(), vibe_cs_domain::DomainError> {
            if self.calls.fetch_add(1, Ordering::Relaxed) == 0 {
                return Err(vibe_cs_domain::DomainError::Internal(
                    "simulated encoder failure".to_owned(),
                ));
            }
            tokio::fs::write(output, b"proxy-bytes")
                .await
                .map_err(|error| vibe_cs_domain::DomainError::Internal(error.to_string()))
        }
    }

    #[async_trait::async_trait]
    impl crate::MediaPort for BlockingProxyMedia {
        async fn probe(
            &self,
            _path: PathBuf,
        ) -> Result<crate::ProbedMediaMetadata, vibe_cs_domain::DomainError> {
            Ok(crate::ProbedMediaMetadata::default())
        }

        async fn waveform(
            &self,
            _path: PathBuf,
            _buckets: usize,
        ) -> Result<Vec<f32>, vibe_cs_domain::DomainError> {
            Ok(Vec::new())
        }

        async fn generate_proxy(
            &self,
            _source: PathBuf,
            _output: PathBuf,
            _request: crate::MediaProxyRequest,
        ) -> Result<(), vibe_cs_domain::DomainError> {
            self.started.notify_one();
            std::future::pending().await
        }
    }

    #[async_trait::async_trait]
    impl crate::MediaPort for ExtractAudioMedia {
        async fn probe(
            &self,
            _path: PathBuf,
        ) -> Result<crate::ProbedMediaMetadata, vibe_cs_domain::DomainError> {
            Ok(crate::ProbedMediaMetadata {
                duration_seconds: Some(2.0),
                width: None,
                height: None,
                has_audio: true,
            })
        }

        async fn waveform(
            &self,
            _path: PathBuf,
            _buckets: usize,
        ) -> Result<Vec<f32>, vibe_cs_domain::DomainError> {
            Ok(Vec::new())
        }

        async fn extract_audio(
            &self,
            _source: PathBuf,
            output: PathBuf,
            _duration_seconds: f64,
        ) -> Result<(), vibe_cs_domain::DomainError> {
            self.calls.fetch_add(1, Ordering::Relaxed);
            tokio::fs::write(output, b"audio")
                .await
                .map_err(|error| vibe_cs_domain::DomainError::Internal(error.to_string()))
        }
    }

    #[async_trait::async_trait]
    impl crate::MediaPort for BlockingExtractAudioMedia {
        async fn probe(
            &self,
            _path: PathBuf,
        ) -> Result<crate::ProbedMediaMetadata, vibe_cs_domain::DomainError> {
            Ok(crate::ProbedMediaMetadata {
                duration_seconds: Some(2.0),
                width: None,
                height: None,
                has_audio: true,
            })
        }

        async fn waveform(
            &self,
            _path: PathBuf,
            _buckets: usize,
        ) -> Result<Vec<f32>, vibe_cs_domain::DomainError> {
            Ok(Vec::new())
        }

        async fn extract_audio(
            &self,
            _source: PathBuf,
            output: PathBuf,
            _duration_seconds: f64,
        ) -> Result<(), vibe_cs_domain::DomainError> {
            tokio::fs::write(output, b"audio")
                .await
                .map_err(|error| vibe_cs_domain::DomainError::Internal(error.to_string()))?;
            self.started.notify_one();
            self.release.notified().await;
            Ok(())
        }
    }

    fn editor_project_with_source(source_id: Uuid) -> EditorProject {
        let now = Utc::now();
        EditorProject {
            id: Uuid::new_v4(),
            name: "Portable round trip".to_owned(),
            width: 1920,
            height: 1080,
            fps: 60,
            duration_seconds: 2.0,
            tracks: vec![vibe_cs_domain::EditorTrack {
                id: Uuid::new_v4(),
                name: "Video".to_owned(),
                kind: vibe_cs_domain::TrackKind::Video,
                order: 0,
                muted: false,
                locked: false,
                hidden: false,
                clips: vec![vibe_cs_domain::EditorClip {
                    id: Uuid::new_v4(),
                    asset_id: Some(source_id),
                    name: "Source".to_owned(),
                    start: 0.0,
                    duration: 2.0,
                    source_in: 0.0,
                    source_out: 2.0,
                    speed: 1.0,
                    volume: 1.0,
                    transform: vibe_cs_domain::Transform::default(),
                    effects: Vec::new(),
                    transition_in: None,
                    transition_out: None,
                    text: None,
                    metadata: Value::Null,
                    group_id: None,
                    link_group_id: None,
                    keyframes: Vec::new(),
                    speed_segments: Vec::new(),
                }],
            }],
            markers: vec![vibe_cs_domain::EditorMarker {
                id: Uuid::new_v4(),
                time: 1.0,
                label: "Middle".to_owned(),
                color: "#F59E0B".to_owned(),
            }],
            settings: Value::Null,
            revision: 1,
            created_at: now,
            updated_at: now,
        }
    }

    #[test]
    fn editor_clone_rekeys_nested_identity_and_marks_templates() {
        let source = editor_project_with_source(Uuid::new_v4());
        let copy = clone_editor_document(&source, "Reusable", true);
        assert_ne!(copy.id, source.id);
        assert_ne!(copy.tracks[0].id, source.tracks[0].id);
        assert_ne!(copy.tracks[0].clips[0].id, source.tracks[0].clips[0].id);
        assert_ne!(copy.markers[0].id, source.markers[0].id);
        assert_eq!(copy.settings["is_template"], true);
        assert_eq!(copy.settings["source_project_id"], source.id.to_string());
        copy.validate().expect("cloned project remains valid");
    }

    #[tokio::test]
    async fn video_audio_extraction_creates_a_managed_audio_asset() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let source_path = directory.path().join("source.mp4");
        tokio::fs::write(&source_path, b"video")
            .await
            .expect("source");
        let storage = vibe_cs_storage::Storage::open_in_memory()
            .await
            .expect("storage");
        let source = MediaAsset {
            id: Uuid::new_v4(),
            project_id: None,
            path: source_path.to_string_lossy().into_owned(),
            name: "Capture".to_owned(),
            kind: "video/mp4".to_owned(),
            duration_seconds: Some(2.0),
            width: Some(1280),
            height: Some(720),
            file_size: 5,
            has_audio: true,
            proxy_path: None,
            proxy_status: MediaProxyStatus::NotRequested,
            waveform: None,
            metadata_status: MediaMetadataStatus::Ready,
            created_at: Utc::now(),
        };
        storage
            .put_asset(source.clone())
            .await
            .expect("source asset");
        let state = AppState::new(storage.clone(), directory.path().to_path_buf())
            .with_media(Arc::new(ExtractAudioMedia::default()));

        let (status, Json(extracted)) =
            extract_asset_audio(State(state), Path(source.id.to_string()))
                .await
                .expect("extract audio");

        assert_eq!(status, StatusCode::CREATED);
        assert_eq!(extracted.kind, "audio/mp4");
        assert!(PathBuf::from(&extracted.path).starts_with(directory.path().join("uploads")));
        assert_eq!(tokio::fs::read(&extracted.path).await.unwrap(), b"audio");
        assert!(storage.get_asset(extracted.id).await.unwrap().is_some());
    }

    #[tokio::test]
    async fn separated_audio_atomically_updates_project_asset_and_timeline() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let source_path = directory.path().join("source.mp4");
        tokio::fs::write(&source_path, b"video")
            .await
            .expect("source");
        let storage = vibe_cs_storage::Storage::open_in_memory()
            .await
            .expect("storage");
        let source_id = Uuid::new_v4();
        let project = editor_project_with_source(source_id);
        let clip_id = project.tracks[0].clips[0].id;
        let source = MediaAsset {
            id: source_id,
            project_id: Some(project.id),
            path: source_path.to_string_lossy().into_owned(),
            name: "Capture".to_owned(),
            kind: "video/mp4".to_owned(),
            duration_seconds: Some(2.0),
            width: Some(1280),
            height: Some(720),
            file_size: 5,
            has_audio: true,
            proxy_path: None,
            proxy_status: MediaProxyStatus::NotRequested,
            waveform: None,
            metadata_status: MediaMetadataStatus::Ready,
            created_at: Utc::now(),
        };
        storage
            .put_editor_project(project.clone())
            .await
            .expect("project");
        storage.put_asset(source).await.expect("source asset");
        let state = AppState::new(storage.clone(), directory.path().to_path_buf())
            .with_media(Arc::new(ExtractAudioMedia::default()));

        let (status, Json(separated)) = separate_editor_clip_audio(
            State(state),
            Path((project.id.to_string(), clip_id.to_string())),
            ApiJson(SeparateEditorAudioRequest {
                expected_revision: 1,
                mute_source: true,
            }),
        )
        .await
        .expect("separate audio");

        assert_eq!(status, StatusCode::CREATED);
        assert_eq!(separated.project.revision, 2);
        assert!(separated.project.tracks[0].clips[0].volume.abs() < f64::EPSILON);
        let audio_clip = separated
            .project
            .tracks
            .iter()
            .find(|track| track.kind == TrackKind::Audio)
            .and_then(|track| track.clips.first())
            .expect("audio clip");
        assert!((audio_clip.start - project.tracks[0].clips[0].start).abs() < f64::EPSILON);
        assert!((audio_clip.duration - project.tracks[0].clips[0].duration).abs() < f64::EPSILON);
        assert_eq!(audio_clip.asset_id, Some(separated.asset.id));
        assert_eq!(separated.asset.project_id, Some(project.id));
        assert!(
            storage
                .get_asset(separated.asset.id)
                .await
                .unwrap()
                .is_some()
        );
        assert_eq!(
            storage
                .list_editor_project_snapshots(project.id)
                .await
                .expect("snapshots")
                .len(),
            1
        );

        let duplicate_media = Arc::new(ExtractAudioMedia::default());
        let duplicate_state = AppState::new(storage.clone(), directory.path().to_path_buf())
            .with_media(duplicate_media.clone());
        let duplicate = separate_editor_clip_audio(
            State(duplicate_state),
            Path((project.id.to_string(), clip_id.to_string())),
            ApiJson(SeparateEditorAudioRequest {
                expected_revision: separated.project.revision,
                mute_source: true,
            }),
        )
        .await
        .expect_err("duplicate separation");
        let response = duplicate.into_response();
        assert_eq!(response.status(), StatusCode::CONFLICT);
        let body = to_bytes(response.into_body(), 64 * 1024)
            .await
            .expect("conflict body");
        let problem: vibe_cs_domain::ErrorBody =
            serde_json::from_slice(&body).expect("conflict problem");
        assert_eq!(problem.code, "audio_already_separated");
        assert_eq!(duplicate_media.calls.load(Ordering::Relaxed), 0);
        assert_eq!(
            storage
                .list_assets(Some(project.id))
                .await
                .expect("project assets")
                .len(),
            2
        );
        assert_eq!(
            std::fs::read_dir(directory.path().join("uploads").join("assets"))
                .expect("upload directory")
                .count(),
            1
        );
    }

    #[tokio::test]
    async fn revision_conflict_after_encoding_removes_uncommitted_audio() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let source_path = directory.path().join("source.mp4");
        tokio::fs::write(&source_path, b"video")
            .await
            .expect("source");
        let storage = vibe_cs_storage::Storage::open_in_memory()
            .await
            .expect("storage");
        let source_id = Uuid::new_v4();
        let project = editor_project_with_source(source_id);
        let clip_id = project.tracks[0].clips[0].id;
        storage
            .put_editor_project(project.clone())
            .await
            .expect("project");
        storage
            .put_asset(MediaAsset {
                id: source_id,
                project_id: Some(project.id),
                path: source_path.to_string_lossy().into_owned(),
                name: "Capture".to_owned(),
                kind: "video/mp4".to_owned(),
                duration_seconds: Some(2.0),
                width: Some(1280),
                height: Some(720),
                file_size: 5,
                has_audio: true,
                proxy_path: None,
                proxy_status: MediaProxyStatus::NotRequested,
                waveform: None,
                metadata_status: MediaMetadataStatus::Ready,
                created_at: Utc::now(),
            })
            .await
            .expect("source asset");
        let media = Arc::new(BlockingExtractAudioMedia::default());
        let state = AppState::new(storage.clone(), directory.path().to_path_buf())
            .with_media(media.clone());
        let request = tokio::spawn(separate_editor_clip_audio(
            State(state),
            Path((project.id.to_string(), clip_id.to_string())),
            ApiJson(SeparateEditorAudioRequest {
                expected_revision: 1,
                mute_source: true,
            }),
        ));
        media.started.notified().await;
        let mut concurrent = project.clone();
        concurrent.name = "Concurrent update".to_owned();
        assert!(matches!(
            storage
                .update_editor_project(concurrent, 1)
                .await
                .expect("concurrent update"),
            EditorProjectUpdate::Updated(_)
        ));
        media.release.notify_one();
        let error = request
            .await
            .expect("request task")
            .expect_err("revision conflict");
        assert_eq!(error.into_response().status(), StatusCode::CONFLICT);
        assert_eq!(
            storage
                .list_assets(Some(project.id))
                .await
                .expect("assets")
                .len(),
            1
        );
        let upload_dir = directory.path().join("uploads").join("assets");
        assert!(
            std::fs::read_dir(upload_dir)
                .expect("upload directory")
                .next()
                .is_none()
        );
    }

    #[test]
    fn parses_bounded_and_suffix_ranges() {
        assert_eq!(
            parse_byte_range("bytes=10-19", 100).expect("bounded"),
            (10, 19)
        );
        assert_eq!(
            parse_byte_range("bytes=-10", 100).expect("suffix"),
            (90, 99)
        );
        assert!(parse_byte_range("bytes=100-", 100).is_err());
    }

    #[test]
    fn maps_supported_resolutions() {
        assert_eq!(
            resolution_dimensions("1440p").expect("resolution"),
            (2560, 1440)
        );
    }

    #[tokio::test]
    async fn montage_project_persists_rendered_packaging_controls() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let source = directory.path().join("clip.mp4");
        let music = directory.path().join("music.wav");
        tokio::fs::write(&source, b"video").await.expect("clip");
        tokio::fs::write(&music, b"audio").await.expect("music");
        let storage = vibe_cs_storage::Storage::open_in_memory()
            .await
            .expect("storage");
        let clip_id = Uuid::new_v4();
        storage
            .put_recorded_clip(RecordedClip {
                id: clip_id,
                path: source.to_string_lossy().into_owned(),
                title: "Ace".to_owned(),
                duration_seconds: 4.0,
                demo_id: None,
                player_name: Some("Player".to_owned()),
                category: "highlight".to_owned(),
                tags: Vec::new(),
                metadata: Value::Null,
                created_at: Utc::now(),
            })
            .await
            .expect("clip");
        let state = AppState::new(storage, directory.path().to_path_buf());
        let settings = MontageSettings {
            width: 1280,
            height: 720,
            fps: 30,
            background_music: Some(music.to_string_lossy().into_owned()),
            music_volume: 0.3,
            transition_seconds: 0.4,
            intro_title: Some("Match night".to_owned()),
            intro_duration_seconds: 1.5,
            include_name_cards: true,
            ..MontageSettings::default()
        };
        let created = create_montage(
            State(state),
            ApiJson(CreateMontageRequest {
                name: "Highlights".to_owned(),
                clips: vec![MontageClip {
                    clip_id,
                    order: 0,
                    trim_start: 0.5,
                    trim_end: Some(3.5),
                    transition: "cut".to_owned(),
                    title: Some("Ace".to_owned()),
                    avatar_asset_id: None,
                }],
                settings,
            }),
        )
        .await
        .expect("create montage")
        .1
        .0;

        assert!(created.settings.include_name_cards);
        assert_eq!(created.settings.intro_title.as_deref(), Some("Match night"));
        assert!((created.settings.music_volume - 0.3).abs() < f64::EPSILON);
        assert_eq!(created.clips[0].transition, "cut");
    }

    #[tokio::test]
    async fn asset_stream_supports_range_and_head() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let path = directory.path().join("clip.mp4");
        tokio::fs::write(&path, b"0123456789").await.expect("media");
        let storage = vibe_cs_storage::Storage::open_in_memory()
            .await
            .expect("storage");
        let id = Uuid::new_v4();
        storage
            .put_asset(MediaAsset {
                id,
                project_id: None,
                path: path.to_string_lossy().into_owned(),
                name: "clip.mp4".to_owned(),
                kind: "video".to_owned(),
                duration_seconds: None,
                width: None,
                height: None,
                file_size: 10,
                has_audio: false,
                proxy_path: None,
                proxy_status: MediaProxyStatus::NotRequested,
                waveform: None,
                metadata_status: MediaMetadataStatus::Pending,
                created_at: Utc::now(),
            })
            .await
            .expect("asset");
        let state = AppState::new(storage, directory.path().to_path_buf());
        let mut headers = HeaderMap::new();
        headers.insert(header::RANGE, "bytes=2-5".parse().expect("range"));

        let response = stream_asset(State(state.clone()), Path(id.to_string()), headers.clone())
            .await
            .expect("range response");
        assert_eq!(response.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(response.headers()[header::CONTENT_RANGE], "bytes 2-5/10");
        assert_eq!(response.headers()[header::CONTENT_TYPE], "video/mp4");
        assert_eq!(
            to_bytes(response.into_body(), 16).await.expect("body"),
            Bytes::from_static(b"2345")
        );

        let response = head_asset(State(state), Path(id.to_string()), HeaderMap::new())
            .await
            .expect("head response");
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.headers()[header::CONTENT_LENGTH], "10");
        assert!(
            to_bytes(response.into_body(), 1)
                .await
                .expect("head body")
                .is_empty()
        );
    }

    #[tokio::test]
    async fn probe_failure_keeps_asset_with_honest_metadata_status() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let path = directory.path().join("unknown.mp4");
        tokio::fs::write(&path, b"not media").await.expect("media");
        let storage = vibe_cs_storage::Storage::open_in_memory()
            .await
            .expect("storage");
        let state = AppState::new(storage, directory.path().to_path_buf())
            .with_media(Arc::new(FailingMedia));

        let asset = asset_from_path(&state, path.clone(), None, None, None)
            .await
            .expect("probe failure does not reject the file");

        assert!(path.is_file());
        assert_eq!(asset.duration_seconds, None);
        assert_eq!(asset.width, None);
        assert_eq!(asset.height, None);
        assert!(matches!(
            asset.metadata_status,
            MediaMetadataStatus::Unavailable { ref message } if message.contains("ffprobe")
        ));
    }

    #[tokio::test]
    async fn asset_waveform_is_generated_once_and_then_served_from_cache() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let path = directory.path().join("audio.wav");
        tokio::fs::write(&path, b"audio").await.expect("media");
        let storage = vibe_cs_storage::Storage::open_in_memory()
            .await
            .expect("storage");
        let id = Uuid::new_v4();
        storage
            .put_asset(MediaAsset {
                id,
                project_id: None,
                path: path.to_string_lossy().into_owned(),
                name: "audio.wav".to_owned(),
                kind: "audio".to_owned(),
                duration_seconds: None,
                width: None,
                height: None,
                file_size: 5,
                has_audio: true,
                proxy_path: None,
                proxy_status: MediaProxyStatus::NotRequested,
                waveform: None,
                metadata_status: MediaMetadataStatus::Pending,
                created_at: Utc::now(),
            })
            .await
            .expect("asset");
        let media = Arc::new(WaveformMedia::default());
        let state = AppState::new(storage.clone(), directory.path().to_path_buf())
            .with_media(media.clone());

        let first = asset_waveform(
            State(state.clone()),
            Path(id.to_string()),
            ApiQuery(WaveformQuery { buckets: 32 }),
        )
        .await
        .expect("generated")
        .0;
        let second = asset_waveform(
            State(state),
            Path(id.to_string()),
            ApiQuery(WaveformQuery { buckets: 32 }),
        )
        .await
        .expect("cached")
        .0;

        assert!(!first.cached);
        assert!(second.cached);
        assert_eq!(first.waveform.len(), 32);
        assert_eq!(media.calls.load(Ordering::Relaxed), 1);
        assert_eq!(
            storage
                .get_asset(id)
                .await
                .expect("storage")
                .expect("asset")
                .waveform
                .expect("cache")
                .len(),
            WAVEFORM_CACHE_BUCKETS
        );
    }

    #[tokio::test]
    async fn portable_editor_package_round_trips_real_files_with_new_ids() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let source = directory.path().join("source.mp4");
        tokio::fs::write(&source, b"real-source-bytes")
            .await
            .expect("source file");
        let storage = vibe_cs_storage::Storage::open_in_memory()
            .await
            .expect("storage");
        let source_id = Uuid::new_v4();
        storage
            .put_asset(MediaAsset {
                id: source_id,
                project_id: None,
                path: source.to_string_lossy().into_owned(),
                name: "source.mp4".to_owned(),
                kind: "video/mp4".to_owned(),
                duration_seconds: Some(2.0),
                width: Some(1920),
                height: Some(1080),
                file_size: 17,
                has_audio: false,
                proxy_path: None,
                proxy_status: MediaProxyStatus::NotRequested,
                waveform: None,
                metadata_status: MediaMetadataStatus::Ready,
                created_at: Utc::now(),
            })
            .await
            .expect("asset");
        let project = editor_project_with_source(source_id);
        storage
            .put_editor_project(project.clone())
            .await
            .expect("project");
        let state = AppState::new(storage.clone(), directory.path().to_path_buf());

        let exported = export_editor_package(
            State(state.clone()),
            Path(project.id.to_string()),
            ApiJson(ExportEditorPackageRequest::default()),
        )
        .await
        .expect("export package")
        .0;
        assert_eq!(exported.sha256.len(), 64);
        assert!(PathBuf::from(&exported.path).is_file());

        let imported = import_editor_package(&state, PathBuf::from(&exported.path))
            .await
            .expect("import package");
        assert_ne!(imported.project.id, project.id);
        assert_eq!(imported.project.revision, 1);
        assert_eq!(imported.assets.len(), 1);
        assert_ne!(imported.assets[0].id, source_id);
        assert_eq!(
            imported.project.tracks[0].clips[0].asset_id,
            Some(imported.assets[0].id)
        );
        assert_eq!(
            tokio::fs::read(&imported.assets[0].path)
                .await
                .expect("imported bytes"),
            b"real-source-bytes"
        );
        assert_eq!(
            storage
                .get_editor_project(imported.project.id)
                .await
                .expect("stored imported project"),
            Some(imported.project)
        );
    }

    #[tokio::test]
    async fn editor_save_returns_one_conflict_for_two_writers_on_the_same_revision() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let storage = vibe_cs_storage::Storage::open_in_memory()
            .await
            .expect("storage");
        let mut project = editor_project_with_source(Uuid::new_v4());
        project.tracks[0].clips[0].asset_id = None;
        storage
            .put_editor_project(project.clone())
            .await
            .expect("project");
        let state = AppState::new(storage.clone(), directory.path().to_path_buf());
        let mut first = project.clone();
        first.name = "First".to_owned();
        let mut second = project.clone();
        second.name = "Second".to_owned();

        let (first, second) = tokio::join!(
            save_editor_project(
                State(state.clone()),
                Path(project.id.to_string()),
                ApiJson(first),
            ),
            save_editor_project(State(state), Path(project.id.to_string()), ApiJson(second),),
        );
        let responses = [first, second];
        assert_eq!(responses.iter().filter(|result| result.is_ok()).count(), 1);
        let conflict = responses
            .into_iter()
            .find_map(Result::err)
            .expect("one conflict");
        assert_eq!(conflict.into_response().status(), StatusCode::CONFLICT);
        assert_eq!(
            storage
                .get_editor_project(project.id)
                .await
                .expect("stored")
                .expect("project")
                .revision,
            2
        );
    }

    #[tokio::test]
    async fn cleanup_retries_a_committed_project_file_quarantine_after_interruption() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let managed_root = directory.path().join("uploads").join("assets");
        tokio::fs::create_dir_all(&managed_root)
            .await
            .expect("managed root");
        let source_id = Uuid::new_v4();
        let source = managed_root.join("owned.mp4");
        tokio::fs::write(&source, b"managed")
            .await
            .expect("managed source");
        let storage = vibe_cs_storage::Storage::open_in_memory()
            .await
            .expect("storage");
        let project = editor_project_with_source(source_id);
        storage
            .put_editor_project(project.clone())
            .await
            .expect("project");
        storage
            .put_asset(MediaAsset {
                id: source_id,
                project_id: Some(project.id),
                path: source.to_string_lossy().into_owned(),
                name: "owned.mp4".to_owned(),
                kind: "video/mp4".to_owned(),
                duration_seconds: Some(2.0),
                width: Some(1920),
                height: Some(1080),
                file_size: 7,
                has_audio: true,
                proxy_path: None,
                proxy_status: MediaProxyStatus::NotRequested,
                waveform: None,
                metadata_status: MediaMetadataStatus::Ready,
                created_at: Utc::now(),
            })
            .await
            .expect("asset");
        let state = AppState::new(storage.clone(), directory.path().to_path_buf());
        let deleted = storage
            .delete_editor_projects_staged(
                vec![EditorProjectRevision {
                    id: project.id,
                    expected_revision: project.revision,
                }],
                editor_file_staging(&state),
            )
            .await
            .expect("staged delete");
        let EditorProjectDeletion::Deleted(deleted) = deleted else {
            panic!("project should be deleted");
        };
        let quarantine = deleted.file_quarantine.expect("durable journal");
        assert!(!source.exists());
        assert!(quarantine.journal_path.is_file());
        assert!(quarantine.entries[0].staged_path.is_file());

        let (removed, failed) = recover_editor_project_quarantines(&state).await;
        assert_eq!(removed, 1);
        assert!(failed.is_empty());
        assert!(!quarantine.journal_path.exists());
        assert!(!quarantine.entries[0].staged_path.exists());
        assert!(
            storage
                .get_editor_project(project.id)
                .await
                .expect("project")
                .is_none()
        );
        assert!(storage.get_asset(source_id).await.expect("asset").is_none());
    }

    #[cfg(any(unix, windows))]
    #[tokio::test]
    async fn cleanup_rejects_a_linked_quarantine_root_without_scanning_its_target() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let cleanup_root = directory.path().join("cleanup");
        let outside = directory.path().join("outside");
        std::fs::create_dir(&cleanup_root).expect("cleanup root");
        std::fs::create_dir(&outside).expect("outside root");
        let sentinel = outside.join("sentinel.json");
        std::fs::write(&sentinel, b"must-not-be-read-or-removed").expect("sentinel");
        if let Err(error) =
            create_directory_symlink(&outside, &cleanup_root.join("editor-projects"))
        {
            if cfg!(windows) && error.kind() == std::io::ErrorKind::PermissionDenied {
                return;
            }
            panic!("create quarantine link: {error}");
        }
        let storage = vibe_cs_storage::Storage::open_in_memory()
            .await
            .expect("storage");
        let state = AppState::new(storage, directory.path().to_path_buf());

        let (removed, failed) = recover_editor_project_quarantines(&state).await;

        assert_eq!(removed, 0);
        assert_eq!(failed, vec!["unsafe-cleanup-root"]);
        assert_eq!(
            std::fs::read(&sentinel).expect("sentinel remains"),
            b"must-not-be-read-or-removed"
        );
    }

    #[cfg(any(unix, windows))]
    #[tokio::test]
    async fn cleanup_rejects_a_linked_uuid_directory_without_reading_its_journal() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let cleanup_root = directory.path().join("cleanup");
        let quarantine_root = cleanup_root.join("editor-projects");
        let outside = directory.path().join("outside");
        std::fs::create_dir_all(&quarantine_root).expect("quarantine root");
        std::fs::create_dir(&outside).expect("outside root");
        let sentinel = outside.join("journal.json");
        std::fs::write(&sentinel, b"must-not-be-read-or-removed").expect("sentinel");
        let linked_directory = quarantine_root.join(Uuid::new_v4().to_string());
        if let Err(error) = create_directory_symlink(&outside, &linked_directory) {
            if cfg!(windows) && error.kind() == std::io::ErrorKind::PermissionDenied {
                return;
            }
            panic!("create UUID directory link: {error}");
        }
        let storage = vibe_cs_storage::Storage::open_in_memory()
            .await
            .expect("storage");
        let state = AppState::new(storage, directory.path().to_path_buf());

        let (removed, failed) = recover_editor_project_quarantines(&state).await;

        assert_eq!(removed, 0);
        assert_eq!(failed, vec!["unsafe-cleanup-entry"]);
        assert_eq!(
            std::fs::read(&sentinel).expect("sentinel remains"),
            b"must-not-be-read-or-removed"
        );
    }

    #[tokio::test]
    async fn portable_editor_package_rejects_zip_slip_and_removes_staging() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let package = directory.path().join("unsafe.vcep");
        let file = std::fs::File::create(&package).expect("package");
        let mut writer = ZipWriter::new(file);
        writer
            .start_file("../escape.txt", SimpleFileOptions::default())
            .expect("entry");
        writer.write_all(b"escape").expect("entry bytes");
        writer.finish().expect("finish package");
        let storage = vibe_cs_storage::Storage::open_in_memory()
            .await
            .expect("storage");
        let state = AppState::new(storage, directory.path().to_path_buf());

        let error = import_editor_package(&state, package)
            .await
            .expect_err("zip slip must fail");
        assert_eq!(error.into_response().status(), StatusCode::BAD_REQUEST);
        assert!(!directory.path().join("escape.txt").exists());
        let import_root = directory.path().join("portable-assets");
        let entries = std::fs::read_dir(import_root)
            .expect("import root")
            .collect::<Result<Vec<_>, _>>()
            .expect("entries");
        assert!(entries.is_empty());
    }

    #[tokio::test]
    async fn portable_editor_package_rejects_a_tampered_project_document() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let package = directory.path().join("tampered.vcep");
        let mut project = editor_project_with_source(Uuid::new_v4());
        project.tracks[0].clips[0].asset_id = None;
        let manifest = EditorPackageManifest {
            format: PORTABLE_PACKAGE_FORMAT.to_owned(),
            version: PORTABLE_PACKAGE_VERSION,
            created_at: Utc::now(),
            project_sha256: "0".repeat(64),
            assets: Vec::new(),
        };
        let file = std::fs::File::create(&package).expect("package");
        let mut writer = ZipWriter::new(file);
        writer
            .start_file("manifest.json", SimpleFileOptions::default())
            .expect("manifest entry");
        writer
            .write_all(&serde_json::to_vec(&manifest).expect("manifest"))
            .expect("manifest bytes");
        writer
            .start_file("project.json", SimpleFileOptions::default())
            .expect("project entry");
        writer
            .write_all(&serde_json::to_vec(&project).expect("project"))
            .expect("project bytes");
        writer.finish().expect("finish package");
        let storage = vibe_cs_storage::Storage::open_in_memory()
            .await
            .expect("storage");
        let state = AppState::new(storage, directory.path().to_path_buf());

        let error = import_editor_package(&state, package)
            .await
            .expect_err("tampered hash must fail");
        assert_eq!(error.into_response().status(), StatusCode::BAD_REQUEST);
        assert!(
            std::fs::read_dir(directory.path().join("portable-assets"))
                .expect("import root")
                .next()
                .is_none()
        );
    }

    #[tokio::test]
    async fn proxy_failure_is_persisted_and_retry_publishes_a_real_file() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let source = directory.path().join("source.mp4");
        tokio::fs::write(&source, b"source").await.expect("source");
        let storage = vibe_cs_storage::Storage::open_in_memory()
            .await
            .expect("storage");
        let id = Uuid::new_v4();
        storage
            .put_asset(MediaAsset {
                id,
                project_id: None,
                path: source.to_string_lossy().into_owned(),
                name: "source.mp4".to_owned(),
                kind: "video/mp4".to_owned(),
                duration_seconds: Some(2.0),
                width: Some(1920),
                height: Some(1080),
                file_size: 6,
                has_audio: false,
                proxy_path: None,
                proxy_status: MediaProxyStatus::NotRequested,
                waveform: None,
                metadata_status: MediaMetadataStatus::Ready,
                created_at: Utc::now(),
            })
            .await
            .expect("asset");
        let media = Arc::new(RetryProxyMedia::default());
        let state = AppState::new(storage.clone(), directory.path().to_path_buf())
            .with_media(media.clone());

        generate_asset_proxy(State(state.clone()), Path(id.to_string()))
            .await
            .expect_err("first generation fails");
        assert!(matches!(
            storage
                .get_asset(id)
                .await
                .expect("asset")
                .expect("stored")
                .proxy_status,
            MediaProxyStatus::Failed { .. }
        ));

        let retried = generate_asset_proxy(State(state), Path(id.to_string()))
            .await
            .expect("retry succeeds")
            .0;
        assert!(matches!(
            retried.proxy_status,
            MediaProxyStatus::Ready { .. }
        ));
        let proxy = retried.proxy_path.expect("proxy path");
        assert_eq!(
            tokio::fs::read(proxy).await.expect("proxy bytes"),
            b"proxy-bytes"
        );
        assert_eq!(media.calls.load(Ordering::Relaxed), 2);
    }

    #[tokio::test]
    async fn cancelled_proxy_request_leaves_only_an_expiring_retryable_lease() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let source = directory.path().join("source.mp4");
        tokio::fs::write(&source, b"source").await.expect("source");
        let storage = vibe_cs_storage::Storage::open_in_memory()
            .await
            .expect("storage");
        let id = Uuid::new_v4();
        storage
            .put_asset(MediaAsset {
                id,
                project_id: None,
                path: source.to_string_lossy().into_owned(),
                name: "source.mp4".to_owned(),
                kind: "video/mp4".to_owned(),
                duration_seconds: Some(2.0),
                width: Some(1920),
                height: Some(1080),
                file_size: 6,
                has_audio: false,
                proxy_path: None,
                proxy_status: MediaProxyStatus::NotRequested,
                waveform: None,
                metadata_status: MediaMetadataStatus::Ready,
                created_at: Utc::now(),
            })
            .await
            .expect("asset");
        let media = Arc::new(BlockingProxyMedia::default());
        let state = AppState::new(storage.clone(), directory.path().to_path_buf())
            .with_media(media.clone());
        let task = tokio::spawn(generate_asset_proxy(State(state), Path(id.to_string())));
        tokio::time::timeout(std::time::Duration::from_secs(2), media.started.notified())
            .await
            .expect("proxy adapter started");
        task.abort();
        let _ = task.await;

        let generating = storage
            .get_asset(id)
            .await
            .expect("asset")
            .expect("stored asset");
        let MediaProxyStatus::Generating { expires_at, .. } = generating.proxy_status else {
            panic!("cancelled request should retain a bounded lease");
        };
        assert_eq!(
            storage
                .recover_expired_media_proxy_generations(
                    expires_at + chrono::Duration::milliseconds(1),
                )
                .await
                .expect("recover lease")
                .len(),
            1
        );
        assert!(matches!(
            storage
                .get_asset(id)
                .await
                .expect("asset")
                .expect("stored asset")
                .proxy_status,
            MediaProxyStatus::Failed { .. }
        ));
    }

    #[tokio::test]
    async fn proxy_directory_failure_is_persisted_instead_of_leaving_a_busy_asset() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let source = directory.path().join("source.mp4");
        tokio::fs::write(&source, b"source").await.expect("source");
        tokio::fs::write(directory.path().join("proxies"), b"blocks-directory")
            .await
            .expect("blocking file");
        let storage = vibe_cs_storage::Storage::open_in_memory()
            .await
            .expect("storage");
        let id = Uuid::new_v4();
        storage
            .put_asset(MediaAsset {
                id,
                project_id: None,
                path: source.to_string_lossy().into_owned(),
                name: "source.mp4".to_owned(),
                kind: "video/mp4".to_owned(),
                duration_seconds: Some(2.0),
                width: Some(1920),
                height: Some(1080),
                file_size: 6,
                has_audio: false,
                proxy_path: None,
                proxy_status: MediaProxyStatus::NotRequested,
                waveform: None,
                metadata_status: MediaMetadataStatus::Ready,
                created_at: Utc::now(),
            })
            .await
            .expect("asset");
        let state = AppState::new(storage.clone(), directory.path().to_path_buf());
        generate_asset_proxy(State(state), Path(id.to_string()))
            .await
            .expect_err("proxy directory is blocked");
        assert!(matches!(
            storage
                .get_asset(id)
                .await
                .expect("asset")
                .expect("stored asset")
                .proxy_status,
            MediaProxyStatus::Failed { .. }
        ));
    }

    #[tokio::test]
    async fn desktop_and_browser_relink_keep_identity_only_after_real_file_validation() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let old_source = directory.path().join("old.mp4");
        let local_replacement = directory.path().join("local.mp4");
        tokio::fs::write(&old_source, b"old")
            .await
            .expect("old source");
        tokio::fs::write(&local_replacement, b"local")
            .await
            .expect("local replacement");
        let storage = vibe_cs_storage::Storage::open_in_memory()
            .await
            .expect("storage");
        let id = Uuid::new_v4();
        storage
            .put_asset(MediaAsset {
                id,
                project_id: Some(Uuid::new_v4()),
                path: old_source.to_string_lossy().into_owned(),
                name: "Stable name".to_owned(),
                kind: "video/mp4".to_owned(),
                duration_seconds: Some(1.0),
                width: Some(1280),
                height: Some(720),
                file_size: 3,
                has_audio: false,
                proxy_path: None,
                proxy_status: MediaProxyStatus::NotRequested,
                waveform: None,
                metadata_status: MediaMetadataStatus::Ready,
                created_at: Utc::now(),
            })
            .await
            .expect("asset");
        let state = AppState::new(storage.clone(), directory.path().to_path_buf())
            .with_media(Arc::new(FailingMedia));

        let local = relink_asset_path(
            State(state.clone()),
            Path(id.to_string()),
            ApiJson(RelinkAssetRequest {
                path: local_replacement.to_string_lossy().into_owned(),
            }),
        )
        .await
        .expect("local relink")
        .0;
        assert_eq!(local.id, id);
        assert_eq!(local.name, "Stable name");
        assert_eq!(
            PathBuf::from(&local.path),
            std::fs::canonicalize(&local_replacement).expect("canonical replacement")
        );

        let body = b"--replace-boundary\r\nContent-Disposition: form-data; name=\"file\"; filename=\"browser.mp4\"\r\nContent-Type: video/mp4\r\n\r\nbrowser-bytes\r\n--replace-boundary--\r\n";
        let request = Request::builder()
            .header(
                header::CONTENT_TYPE,
                "multipart/form-data; boundary=replace-boundary",
            )
            .body(Body::from(body.as_slice()))
            .expect("request");
        let multipart = Multipart::from_request(request, &())
            .await
            .expect("multipart");
        let browser =
            replace_asset_upload(State(state), Path(id.to_string()), ApiMultipart(multipart))
                .await
                .expect("browser replacement")
                .0;
        assert_eq!(browser.id, id);
        assert_eq!(browser.name, "Stable name");
        assert_eq!(
            tokio::fs::read(&browser.path)
                .await
                .expect("uploaded replacement"),
            b"browser-bytes"
        );
        assert_eq!(
            storage.get_asset(id).await.expect("stored asset"),
            Some(browser)
        );
    }

    #[tokio::test]
    async fn proxy_cleanup_detaches_ready_files_and_skips_generating_assets() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let proxy_dir = directory.path().join("proxies");
        tokio::fs::create_dir_all(&proxy_dir)
            .await
            .expect("proxy dir");
        let storage = vibe_cs_storage::Storage::open_in_memory()
            .await
            .expect("storage");
        let ready_id = Uuid::new_v4();
        let generating_id = Uuid::new_v4();
        let ready_path = proxy_dir.join(format!("{ready_id}-{}.mp4", Uuid::new_v4()));
        let generating_path = proxy_dir.join(format!("{generating_id}-{}.mp4", Uuid::new_v4()));
        tokio::fs::write(&ready_path, b"ready")
            .await
            .expect("ready proxy");
        tokio::fs::write(&generating_path, b"active")
            .await
            .expect("active proxy");
        for (id, path, status) in [
            (
                ready_id,
                &ready_path,
                MediaProxyStatus::Ready {
                    generated_at: Utc::now(),
                },
            ),
            (
                generating_id,
                &generating_path,
                MediaProxyStatus::Generating {
                    started_at: Utc::now(),
                    lease_id: Uuid::new_v4(),
                    expires_at: Utc::now() + chrono::Duration::hours(1),
                },
            ),
        ] {
            storage
                .put_asset(MediaAsset {
                    id,
                    project_id: None,
                    path: source_path_for_test(directory.path(), id),
                    name: "source.mp4".to_owned(),
                    kind: "video/mp4".to_owned(),
                    duration_seconds: Some(1.0),
                    width: Some(1280),
                    height: Some(720),
                    file_size: 1,
                    has_audio: false,
                    proxy_path: Some(path.to_string_lossy().into_owned()),
                    proxy_status: status,
                    waveform: None,
                    metadata_status: MediaMetadataStatus::Ready,
                    created_at: Utc::now(),
                })
                .await
                .expect("asset");
        }
        let state = AppState::new(storage.clone(), directory.path().to_path_buf());
        let cleaned = cleanup_asset_proxies(State(state))
            .await
            .expect("cleanup")
            .0;

        assert_eq!(cleaned.removed_files, 1);
        assert_eq!(cleaned.skipped_generating, 1);
        assert!(!ready_path.exists());
        assert!(generating_path.exists());
        let ready = storage
            .get_asset(ready_id)
            .await
            .expect("ready asset")
            .expect("stored");
        assert_eq!(ready.proxy_path, None);
        assert_eq!(ready.proxy_status, MediaProxyStatus::NotRequested);
    }

    fn source_path_for_test(root: &FsPath, id: Uuid) -> String {
        root.join(format!("source-{id}.mp4"))
            .to_string_lossy()
            .into_owned()
    }

    #[tokio::test]
    async fn late_invalid_project_id_rolls_back_uploaded_files() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let storage = vibe_cs_storage::Storage::open_in_memory()
            .await
            .expect("storage");
        let state = AppState::new(storage.clone(), directory.path().to_path_buf());
        let body = b"--asset-boundary\r\nContent-Disposition: form-data; name=\"files\"; filename=\"clip.mp4\"\r\nContent-Type: video/mp4\r\n\r\nvideo\r\n--asset-boundary\r\nContent-Disposition: form-data; name=\"project_id\"\r\n\r\nnot-a-uuid\r\n--asset-boundary--\r\n";
        let request = Request::builder()
            .header(
                header::CONTENT_TYPE,
                "multipart/form-data; boundary=asset-boundary",
            )
            .body(Body::from(body.as_slice()))
            .expect("request");
        let multipart = Multipart::from_request(request, &())
            .await
            .expect("multipart");

        let error = upload_assets(State(state), ApiMultipart(multipart))
            .await
            .expect_err("invalid late field must fail");

        assert_eq!(error.into_response().status(), StatusCode::BAD_REQUEST);
        let upload_dir = directory.path().join("uploads/assets");
        let entries = std::fs::read_dir(upload_dir)
            .expect("upload directory")
            .collect::<Result<Vec<_>, _>>()
            .expect("entries");
        assert!(entries.is_empty());
        assert!(storage.list_assets(None).await.expect("assets").is_empty());
    }
}
