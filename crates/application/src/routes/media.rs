use std::{
    collections::HashSet,
    io::SeekFrom,
    path::{Path as FsPath, PathBuf},
};
use ts_rs::TS;

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
use tokio::io::{AsyncReadExt, AsyncSeekExt};
use uuid::Uuid;
use vibe_cs_domain::{
    AudioAnalysis, AudioAnalysisOptions, BeatAlignmentDraft, BeatAlignmentRequest, MediaAsset,
    MediaMetadataStatus, MediaProxyStatus, Page, RecordedClip,
};
use vibe_cs_storage::{ExportJobRecord, MediaAssetUpdate};

use crate::{
    ApiError, ApiJson, ApiMultipart, ApiQuery, ApiResult, AppState,
    extract::{multipart_error, persist_multipart_field, read_multipart_text},
};

const MAXIMUM_ASSET_UPLOAD_FILES: usize = 64;
const MAXIMUM_ASSET_UPLOAD_BATCH_BYTES: u64 = 4 * 1024 * 1024 * 1024;
const MAXIMUM_ASSET_UPLOAD_REQUEST_BYTES: usize = 4 * 1024 * 1024 * 1024 + 8 * 1024 * 1024;
const WAVEFORM_CACHE_BUCKETS: usize = 2_000;

pub(crate) fn router() -> Router<AppState> {
    Router::new()
        .route("/api/recorded-clips", get(list_clips))
        .route(
            "/api/recorded-clips/{id}",
            get(get_clip).patch(patch_clip).delete(delete_clip),
        )
        .route(
            "/api/recorded-clips/{id}/stream",
            get(stream_clip).head(head_clip),
        )
        .route(
            "/api/recorded-clips/{id}/waveform",
            get(recorded_clip_waveform),
        )
        .route(
            "/api/media/assets",
            get(list_assets)
                .post(upload_assets)
                .layer(DefaultBodyLimit::max(MAXIMUM_ASSET_UPLOAD_REQUEST_BYTES)),
        )
        .route("/api/media/assets/import", post(import_asset))
        .route(
            "/api/media/assets/{id}",
            get(get_asset).put(put_asset).delete(delete_asset),
        )
        .route("/api/media/assets/{id}/relink", post(relink_asset_path))
        .route(
            "/api/media/assets/{id}/replace",
            post(replace_asset_upload)
                .layer(DefaultBodyLimit::max(MAXIMUM_ASSET_UPLOAD_REQUEST_BYTES)),
        )
        .route("/api/media/assets/{id}/proxy", post(generate_asset_proxy))
        .route(
            "/api/media/assets/{id}/proxy/stream",
            get(stream_asset_proxy).head(head_asset_proxy),
        )
        .route("/api/media/proxies/cleanup", post(cleanup_asset_proxies))
        .route(
            "/api/media/assets/{id}/stream",
            get(stream_asset).head(head_asset),
        )
        .route("/api/media/assets/{id}/waveform", get(asset_waveform))
        .route(
            "/api/media/assets/{id}/audio-analysis",
            get(asset_audio_analysis),
        )
        .route("/api/media/audio/align-clips", post(align_clips_to_beats))
        .route(
            "/api/media/assets/{id}/extract-audio",
            post(extract_asset_audio),
        )
        .route("/api/exports", get(list_export_jobs))
        .route("/api/exports/{id}", get(get_export_job))
        .route("/api/exports/{id}/cancel", post(cancel_export_job))
}

#[derive(Debug, Serialize)]
struct ItemList<T> {
    items: Vec<T>,
}

#[derive(Debug, Serialize, TS)]
#[ts(export)]
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
            stream_url: format!("/api/recorded-clips/{}/stream", clip.id),
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
#[serde(deny_unknown_fields)]
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

fn validate_waveform_buckets(buckets: usize) -> ApiResult<()> {
    if !(1..=WAVEFORM_CACHE_BUCKETS).contains(&buckets) {
        return Err(ApiError::invalid(format!(
            "waveform buckets must be between 1 and {WAVEFORM_CACHE_BUCKETS}"
        )));
    }
    Ok(())
}

#[derive(Debug, Serialize, TS)]
#[ts(export)]
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

pub(super) async fn stream_media_file(
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

fn deserialize_required_nullable<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(deserializer)
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
#[serde(deny_unknown_fields)]
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
    reject_shorter_relink(&existing, &replacement)?;
    commit_asset_relink(&state, existing, replacement)
        .await
        .map(Json)
}

/// Refuses a relink whose replacement is shorter than the file it replaces.
///
/// Relinking keeps the asset id, and clips reference the asset by id, so every
/// clip follows the new file automatically — including the ones whose
/// `source_out` now runs past the end of it. Nothing downstream catches that:
/// `EditorProject::validate` cannot see the asset, and the export's own
/// `validate_editor_clip` only checks `source_out > source_in`. The render then
/// asks `FFmpeg` to read past the end of the file, and what comes out is a short
/// clip or black frames rather than an error anyone can point at.
///
/// 「重新定位」 means *the same file moved*. A genuinely different take is
/// `replace_asset_upload`, which is not held to this and does not pretend the
/// clips are unaffected.
///
/// Only refuses when both lengths are known: an asset whose probe has not
/// landed yet has no duration, and blocking on 「不知道」 would make the repair
/// unavailable exactly when the file is hardest to reason about.
fn reject_shorter_relink(existing: &MediaAsset, replacement: &MediaAsset) -> ApiResult<()> {
    let (Some(current), Some(next)) = (existing.duration_seconds, replacement.duration_seconds)
    else {
        return Ok(());
    };
    // A frame of tolerance at 60 fps: two encodes of one source disagree in the
    // last decimal, and refusing over 4 milliseconds would be refusing noise.
    if next + 0.017 >= current {
        return Ok(());
    }
    Err(ApiError::new(
        StatusCode::CONFLICT,
        "replacement_is_shorter",
        format!(
            "the replacement is {:.1}s shorter than the file it replaces ({:.1}s vs {:.1}s);              clips cut from the original would run past its end",
            current - next,
            next,
            current
        ),
    ))
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
        .ok_or_else(|| {
            ApiError::invalid(
                "video duration is unavailable; relink or re-import the asset so the bundled metadata probe can inspect it",
            )
        })?;
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

#[derive(Debug, Serialize, TS)]
#[ts(export)]
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
        removed_files: 0,
        freed_bytes: 0,
        failed_files: Vec::new(),
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

async fn asset_audio_analysis(
    State(state): State<AppState>,
    Path(id): Path<String>,
    ApiQuery(options): ApiQuery<AudioAnalysisOptions>,
) -> ApiResult<Json<AudioAnalysis>> {
    let asset = state
        .storage
        .get_asset(parse_id(&id)?)
        .await?
        .ok_or_else(|| ApiError::not_found("media asset"))?;
    if !asset.has_audio && !asset.kind.starts_with("audio") {
        return Err(ApiError::invalid(
            "audio analysis requires a media asset with an audio stream",
        ));
    }
    state
        .media
        .analyze_audio(PathBuf::from(asset.path), options)
        .await
        .map(Json)
        .map_err(Into::into)
}

async fn align_clips_to_beats(
    State(state): State<AppState>,
    ApiJson(request): ApiJson<BeatAlignmentRequest>,
) -> ApiResult<Json<BeatAlignmentDraft>> {
    state
        .media
        .align_clips_to_beats(request)
        .await
        .map(Json)
        .map_err(Into::into)
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
#[serde(deny_unknown_fields)]
struct ImportAssetRequest {
    #[serde(deserialize_with = "deserialize_required_nullable")]
    project_id: Option<Uuid>,
    path: String,
    #[serde(deserialize_with = "deserialize_required_nullable")]
    name: Option<String>,
    #[serde(deserialize_with = "deserialize_required_nullable")]
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
