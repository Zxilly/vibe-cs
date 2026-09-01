use std::{
    collections::HashSet,
    future::Future,
    path::{Component, Path as FilePath, PathBuf},
};

use axum::{
    Json, Router,
    extract::{Path, State},
    http::StatusCode,
    routing::{get, patch, post},
};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use tokio::fs;
use uuid::Uuid;
use vibe_cs_domain::{JobStatus, RecordedClip};
use vibe_cs_storage::ExportJobRecord;

use crate::{ApiError, ApiJson, ApiQuery, ApiResult, AppState};
use ts_rs::TS;

const MAXIMUM_BATCH_SIZE: usize = 200;
const MAXIMUM_OUTPUT_SCAN_PER_KIND: u32 = 2_000;
const MAXIMUM_STAGED_CLEANUP: usize = 200;
const RECORDINGS_DIRECTORY: &str = "recordings";
const EXPORTS_DIRECTORY: &str = "exports";
const TRASH_DIRECTORY: &str = ".output-trash";

pub(crate) fn router() -> Router<AppState> {
    Router::new()
        .route("/api/outputs", get(list_outputs))
        .route(
            "/api/outputs/{kind}/{id}",
            patch(rename_output).delete(delete_output),
        )
        .route(
            "/api/outputs/{kind}/{id}/stream",
            get(stream_output).head(head_output),
        )
        .route("/api/outputs/batch-delete", post(batch_delete_outputs))
        .route(
            "/api/outputs/cleanup-missing",
            post(cleanup_missing_outputs),
        )
        .route("/api/outputs/cleanup-staged", post(cleanup_staged_outputs))
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq, Hash, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
enum OutputKind {
    Recording,
    Export,
}

impl OutputKind {
    fn parse(value: &str) -> ApiResult<Self> {
        match value {
            "recording" => Ok(Self::Recording),
            "export" => Ok(Self::Export),
            _ => Err(ApiError::invalid("output kind must be recording or export")),
        }
    }
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
enum OutputAvailability {
    Present,
    Missing,
    Unsafe,
}

/// What the artboard prints under an output's name: 「42 秒 · 60 fps · 186 MB ·
/// H.264 / AAC」 and the 「1920×1080」 plate beside it.
///
/// Every field is optional and for one reason each, not as a blanket hedge: a
/// still image has no duration or frame rate, an audio-only export has no
/// resolution, a file that has gone missing cannot be probed at all, and a
/// container the linked `FFmpeg` cannot open answers nothing rather than
/// guessing from the extension.
#[derive(Debug, Clone, Serialize, TS)]
#[ts(export)]
pub(crate) struct OutputMediaInfo {
    width: Option<u32>,
    height: Option<u32>,
    duration_seconds: Option<f64>,
    /// Exact, as a reduced rational string — `"60"`, `"30000/1001"`. A 29.97
    /// printed as a float stops being distinguishable from 30.
    frame_rate: Option<String>,
    video_codec: Option<String>,
    audio_codec: Option<String>,
}

#[derive(Debug, Clone, Serialize, TS)]
#[ts(export)]
struct OutputItemDto {
    id: Uuid,
    output_kind: OutputKind,
    media_kind: String,
    title: String,
    status: JobStatus,
    progress: f64,
    path: String,
    file_name: String,
    availability: OutputAvailability,
    managed: bool,
    mutable: bool,
    size_bytes: Option<u64>,
    /// Probed from the file, and `None` whenever it could not be — see
    /// [`OutputMediaInfo`]. Filled for the current page only: probing every
    /// output in the library to render twenty rows would open several hundred
    /// containers per keystroke in the search box.
    media: Option<OutputMediaInfo>,
    project_id: Option<Uuid>,
    project_revision: Option<u64>,
    demo_id: Option<Uuid>,
    error: Option<String>,
    created_at: DateTime<Utc>,
    updated_at: DateTime<Utc>,
}

#[derive(Debug, Default, Deserialize, TS)]
#[serde(deny_unknown_fields)]
#[ts(export)]
struct OutputListQuery {
    #[ts(optional)]
    page: Option<u32>,
    #[ts(optional)]
    page_size: Option<u32>,
    #[ts(optional)]
    kind: Option<OutputKind>,
    #[ts(optional)]
    status: Option<JobStatus>,
    #[ts(optional)]
    availability: Option<OutputAvailability>,
    #[ts(optional)]
    search: Option<String>,
}

#[derive(Debug, Serialize, TS)]
#[ts(export)]
struct OutputPageDto {
    items: Vec<OutputItemDto>,
    total: u64,
    page: u32,
    page_size: u32,
    scan_limited: bool,
}

#[derive(Debug)]
struct ManagedRoots {
    data: PathBuf,
    output_directories: Vec<PathBuf>,
}

impl ManagedRoots {
    async fn discover(data_dir: &FilePath) -> ApiResult<Self> {
        let data = fs::canonicalize(data_dir).await.map_err(|error| {
            tracing::error!(%error, path = %data_dir.display(), "unable to resolve data directory");
            ApiError::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                "data_directory_unavailable",
                "The managed data directory is unavailable",
            )
        })?;
        let mut output_directories = Vec::with_capacity(2);
        for name in [RECORDINGS_DIRECTORY, EXPORTS_DIRECTORY] {
            let directory = data_dir.join(name);
            match fs::canonicalize(&directory).await {
                Ok(directory) if directory.starts_with(&data) => output_directories.push(directory),
                Ok(directory) => {
                    tracing::warn!(path = %directory.display(), "managed output directory escaped data root");
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => {
                    tracing::warn!(%error, path = %directory.display(), "unable to inspect managed output directory");
                }
            }
        }
        Ok(Self {
            data,
            output_directories,
        })
    }

    fn contains(&self, path: &FilePath) -> bool {
        self.output_directories
            .iter()
            .any(|directory| path.starts_with(directory) && path != directory)
    }
}

#[derive(Debug)]
struct OutputPathState {
    availability: OutputAvailability,
    managed: bool,
    canonical_path: Option<PathBuf>,
    size_bytes: Option<u64>,
}

impl OutputPathState {
    fn mutable(&self) -> bool {
        self.availability == OutputAvailability::Present
            && self.managed
            && self.canonical_path.is_some()
    }
}

async fn inspect_output_path(path: &str, roots: &ManagedRoots) -> OutputPathState {
    let requested = PathBuf::from(path);
    if path.trim().is_empty() || !requested.is_absolute() {
        return OutputPathState {
            availability: if path.trim().is_empty() {
                OutputAvailability::Missing
            } else {
                OutputAvailability::Unsafe
            },
            managed: false,
            canonical_path: None,
            size_bytes: None,
        };
    }

    match fs::symlink_metadata(&requested).await {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_file() => {
            OutputPathState {
                availability: OutputAvailability::Unsafe,
                managed: false,
                canonical_path: None,
                size_bytes: None,
            }
        }
        Ok(metadata) => match fs::canonicalize(&requested).await {
            Ok(canonical_path) => OutputPathState {
                availability: OutputAvailability::Present,
                managed: roots.contains(&canonical_path),
                canonical_path: Some(canonical_path),
                size_bytes: Some(metadata.len()),
            },
            Err(error) => {
                tracing::warn!(%error, path = %requested.display(), "unable to resolve output file");
                OutputPathState {
                    availability: OutputAvailability::Unsafe,
                    managed: false,
                    canonical_path: None,
                    size_bytes: None,
                }
            }
        },
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            let managed = requested.parent().is_some_and(|parent| {
                std::fs::canonicalize(parent)
                    .is_ok_and(|parent| roots.contains(&parent.join("missing-output-placeholder")))
            });
            OutputPathState {
                availability: OutputAvailability::Missing,
                managed,
                canonical_path: None,
                size_bytes: None,
            }
        }
        Err(error) => {
            tracing::warn!(%error, path = %requested.display(), "unable to inspect output file");
            OutputPathState {
                availability: OutputAvailability::Unsafe,
                managed: false,
                canonical_path: None,
                size_bytes: None,
            }
        }
    }
}

#[derive(Debug, Clone)]
enum StoredOutput {
    Recording(RecordedClip),
    Export(ExportJobRecord),
}

impl StoredOutput {
    fn id(&self) -> Uuid {
        match self {
            Self::Recording(clip) => clip.id,
            Self::Export(record) => record.job.id,
        }
    }

    fn kind(&self) -> OutputKind {
        match self {
            Self::Recording(_) => OutputKind::Recording,
            Self::Export(_) => OutputKind::Export,
        }
    }

    fn path(&self) -> &str {
        match self {
            Self::Recording(clip) => &clip.path,
            Self::Export(record) => &record.job.output_path,
        }
    }

    fn status(&self) -> JobStatus {
        match self {
            Self::Recording(_) => JobStatus::Completed,
            Self::Export(record) => record.job.status,
        }
    }

    fn is_terminal(&self) -> bool {
        matches!(self, Self::Recording(_)) || self.status().is_terminal()
    }

    fn set_path(&mut self, path: String) {
        match self {
            Self::Recording(clip) => clip.path = path,
            Self::Export(record) => {
                record.job.output_path = path;
                record.job.updated_at = Utc::now();
            }
        }
    }

    async fn into_dto(self, roots: &ManagedRoots) -> OutputItemDto {
        let path_state = inspect_output_path(self.path(), roots).await;
        let path = self.path().to_owned();
        let file_name = FilePath::new(&path)
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or_default()
            .to_owned();
        match self {
            Self::Recording(clip) => OutputItemDto {
                id: clip.id,
                output_kind: OutputKind::Recording,
                media_kind: clip.category,
                title: clip.title,
                status: JobStatus::Completed,
                progress: 1.0,
                path,
                file_name,
                availability: path_state.availability,
                managed: path_state.managed,
                mutable: path_state.mutable(),
                size_bytes: path_state.size_bytes,
                media: None,
                project_id: None,
                project_revision: None,
                demo_id: clip.demo_id,
                error: None,
                created_at: clip.created_at,
                updated_at: clip.created_at,
            },
            Self::Export(record) => {
                let mutable = record.job.status.is_terminal() && path_state.mutable();
                let title = if file_name.is_empty() {
                    format!("{} export", record.kind)
                } else {
                    file_name.clone()
                };
                OutputItemDto {
                    id: record.job.id,
                    output_kind: OutputKind::Export,
                    media_kind: record.kind,
                    title,
                    status: record.job.status,
                    progress: record.job.progress,
                    path,
                    file_name,
                    availability: path_state.availability,
                    managed: path_state.managed,
                    mutable,
                    size_bytes: path_state.size_bytes,
                    media: None,
                    project_id: Some(record.job.project_id),
                    project_revision: Some(record.job.project_revision),
                    demo_id: None,
                    error: record.job.error,
                    created_at: record.job.created_at,
                    updated_at: record.job.updated_at,
                }
            }
        }
    }
}

async fn load_output(state: &AppState, kind: OutputKind, id: Uuid) -> ApiResult<StoredOutput> {
    match kind {
        OutputKind::Recording => state
            .storage
            .get_recorded_clip(id)
            .await?
            .map(StoredOutput::Recording)
            .ok_or_else(|| ApiError::not_found("recorded output")),
        OutputKind::Export => state
            .storage
            .get_export_job(id)
            .await?
            .map(StoredOutput::Export)
            .ok_or_else(|| ApiError::not_found("export output")),
    }
}

async fn list_all_outputs(
    state: &AppState,
    roots: &ManagedRoots,
    kind: Option<OutputKind>,
) -> ApiResult<(Vec<OutputItemDto>, bool)> {
    let fetch_limit = MAXIMUM_OUTPUT_SCAN_PER_KIND.saturating_add(1);
    let (clips, exports) = tokio::try_join!(
        async {
            if kind.is_none_or(|kind| kind == OutputKind::Recording) {
                state.storage.list_recorded_clips_limited(fetch_limit).await
            } else {
                Ok(Vec::new())
            }
        },
        async {
            if kind.is_none_or(|kind| kind == OutputKind::Export) {
                state
                    .storage
                    .list_export_jobs_limited(None, fetch_limit)
                    .await
            } else {
                Ok(Vec::new())
            }
        }
    )?;
    let scan_limited = clips.len() > MAXIMUM_OUTPUT_SCAN_PER_KIND as usize
        || exports.len() > MAXIMUM_OUTPUT_SCAN_PER_KIND as usize;
    let mut items = Vec::with_capacity(clips.len() + exports.len());
    for clip in clips
        .into_iter()
        .take(MAXIMUM_OUTPUT_SCAN_PER_KIND as usize)
    {
        items.push(StoredOutput::Recording(clip).into_dto(roots).await);
    }
    for export in exports
        .into_iter()
        .take(MAXIMUM_OUTPUT_SCAN_PER_KIND as usize)
    {
        items.push(StoredOutput::Export(export).into_dto(roots).await);
    }
    items.sort_by_key(|item| std::cmp::Reverse(item.updated_at));
    Ok((items, scan_limited))
}

async fn list_outputs(
    State(state): State<AppState>,
    ApiQuery(query): ApiQuery<OutputListQuery>,
) -> ApiResult<Json<OutputPageDto>> {
    let page = query.page.unwrap_or(1).max(1);
    let page_size = query.page_size.unwrap_or(50).clamp(1, 200);
    let search = query
        .search
        .map(|search| search.trim().to_lowercase())
        .filter(|search| !search.is_empty());
    let roots = ManagedRoots::discover(state.data_dir()).await?;
    let (items, scan_limited) = list_all_outputs(&state, &roots, query.kind).await?;
    let filtered = items
        .into_iter()
        .filter(|item| query.status.is_none_or(|status| item.status == status))
        .filter(|item| {
            query
                .availability
                .is_none_or(|availability| item.availability == availability)
        })
        .filter(|item| {
            search.as_ref().is_none_or(|search| {
                format!(
                    "{} {} {} {}",
                    item.title, item.file_name, item.media_kind, item.path
                )
                .to_lowercase()
                .contains(search)
            })
        })
        .collect::<Vec<_>>();
    let total = u64::try_from(filtered.len()).unwrap_or(u64::MAX);
    let skip = usize::try_from(u64::from(page - 1) * u64::from(page_size)).unwrap_or(usize::MAX);
    let mut items: Vec<OutputItemDto> = filtered
        .into_iter()
        .skip(skip)
        .take(page_size as usize)
        .collect();
    attach_media_info(&state, &mut items).await;
    Ok(Json(OutputPageDto {
        items,
        total,
        page,
        page_size,
        scan_limited,
    }))
}

/// The artboard's 「播放」 button on an output row.
///
/// It is a route of its own rather than a reuse of the recorded-clip stream
/// because an output is not always a recorded clip — an export has an
/// `ExportJob` id and a path, and no clip record to look it up by. Both kinds
/// resolve to a file here, and the same range-serving helper answers both, so
/// the two do not drift on seeking or on `Content-Type`.
///
/// A file that is missing or outside the managed roots is refused rather than
/// served: `availability` already told the page it could not be played, and a
/// stream route that reached past that check would be a way to read any path
/// the process can open.
async fn resolve_output_path(state: &AppState, kind: &str, id: &str) -> ApiResult<String> {
    let kind = OutputKind::parse(kind)?;
    let id = parse_id(id)?;
    let roots = ManagedRoots::discover(state.data_dir()).await?;
    let (items, _) = list_all_outputs(state, &roots, Some(kind)).await?;
    let item = items
        .into_iter()
        .find(|item| item.id == id)
        .ok_or_else(|| ApiError::not_found("output"))?;
    if item.availability != OutputAvailability::Present {
        return Err(ApiError::not_found("output file"));
    }
    Ok(item.path)
}

async fn stream_output(
    State(state): State<AppState>,
    Path((kind, id)): Path<(String, String)>,
    headers: axum::http::HeaderMap,
) -> ApiResult<axum::response::Response<axum::body::Body>> {
    let path = resolve_output_path(&state, &kind, &id).await?;
    super::media::stream_media_file(&path, headers, false, "output file").await
}

async fn head_output(
    State(state): State<AppState>,
    Path((kind, id)): Path<(String, String)>,
    headers: axum::http::HeaderMap,
) -> ApiResult<axum::response::Response<axum::body::Body>> {
    let path = resolve_output_path(&state, &kind, &id).await?;
    super::media::stream_media_file(&path, headers, true, "output file").await
}

/// Fills in [`OutputMediaInfo`] for the rows about to be rendered.
///
/// ── why this is here and not in `into_dto` ────────────────────────────────
///
/// `into_dto` runs for *every* output in the library, before filtering and
/// paging. Probing there would open one container per output per request — a
/// few hundred, on every keystroke in the search box — to render twenty rows.
/// Probing after the page is cut opens exactly as many as are shown.
///
/// ── the cache ─────────────────────────────────────────────────────────────
///
/// Keyed on path *and size*, so a file replaced in place is re-probed rather
/// than serving the previous file's resolution. It is bounded and dropped
/// wholesale when it grows past the bound: an LRU would be more precise and
/// this is a cache of a millisecond-scale operation, where the eviction policy
/// matters less than the bound existing at all.
///
/// A file that cannot be probed caches its failure, so a container `FFmpeg` does
/// not understand is not re-opened on every page turn.
async fn attach_media_info(state: &AppState, items: &mut [OutputItemDto]) {
    for item in items.iter_mut() {
        // A missing file has nothing to probe, and an unsafe path is one this
        // service has already decided not to touch.
        if item.availability != OutputAvailability::Present {
            continue;
        }
        let key = (item.path.clone(), item.size_bytes);
        if let Some(cached) = state.output_media_cache.lock().await.get(&key) {
            item.media.clone_from(cached);
            continue;
        }
        let probed = state
            .media
            .probe(PathBuf::from(&item.path))
            .await
            .ok()
            .map(|probe| OutputMediaInfo {
                width: probe.width,
                height: probe.height,
                duration_seconds: probe.duration_seconds,
                frame_rate: probe.frame_rate,
                video_codec: probe.video_codec,
                audio_codec: probe.audio_codec,
            });
        let mut cache = state.output_media_cache.lock().await;
        if cache.len() >= MAXIMUM_MEDIA_CACHE_ENTRIES {
            cache.clear();
        }
        cache.insert(key, probed.clone());
        item.media = probed;
    }
}

/// Enough for several pages of a large library. Each entry is a handful of
/// small options, so the bound is about not growing without limit rather than
/// about memory pressure.
const MAXIMUM_MEDIA_CACHE_ENTRIES: usize = 512;

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RenameOutputRequest {
    file_name: String,
}

async fn rename_output(
    State(state): State<AppState>,
    Path((kind, id)): Path<(String, String)>,
    ApiJson(request): ApiJson<RenameOutputRequest>,
) -> ApiResult<Json<OutputItemDto>> {
    let kind = OutputKind::parse(&kind)?;
    let id = parse_id(&id)?;
    let _mutation = state.output_mutations.lock().await;
    let mut output = load_output(&state, kind, id).await?;
    if !output.is_terminal() {
        return Err(conflict("An active export cannot be renamed"));
    }
    validate_output_file_name(&request.file_name)?;
    let roots = ManagedRoots::discover(state.data_dir()).await?;
    let source_state = inspect_output_path(output.path(), &roots).await;
    if !source_state.mutable() {
        return Err(conflict(
            "Only an existing regular file in the managed output directory can be renamed",
        ));
    }
    let source = source_state.canonical_path.ok_or_else(|| {
        conflict("Only an existing regular file in the managed output directory can be renamed")
    })?;
    validate_preserved_extension(&source, &request.file_name)?;
    if source
        .file_name()
        .is_some_and(|name| name == request.file_name.as_str())
    {
        return Ok(Json(output.into_dto(&roots).await));
    }
    let destination = source
        .parent()
        .ok_or_else(|| ApiError::invalid("output file has no parent directory"))?
        .join(&request.file_name);
    move_file_without_overwrite(&source, &destination).await?;
    output.set_path(destination.to_string_lossy().into_owned());
    if let Err(error) = persist_output(&state, output.clone()).await {
        if !restore_file_after_failed_change(&destination, &source).await {
            return Err(ApiError::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                "output_rollback_failed",
                "The output rename could not be persisted or rolled back",
            ));
        }
        return Err(error);
    }
    publish_output_change(&state, kind, id, "renamed");
    Ok(Json(output.into_dto(&roots).await))
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct DeleteOutputQuery {
    delete_file: bool,
}

#[derive(Debug, Clone, Serialize, TS)]
#[ts(export)]
struct DeleteOutputResult {
    id: Uuid,
    output_kind: OutputKind,
    record_deleted: bool,
    file_deleted: bool,
    file_action: &'static str,
    warning: Option<String>,
}

async fn delete_output(
    State(state): State<AppState>,
    Path((kind, id)): Path<(String, String)>,
    ApiQuery(query): ApiQuery<DeleteOutputQuery>,
) -> ApiResult<Json<DeleteOutputResult>> {
    let kind = OutputKind::parse(&kind)?;
    let id = parse_id(&id)?;
    Ok(Json(
        delete_stored_output(&state, kind, id, query.delete_file).await?,
    ))
}

async fn delete_stored_output(
    state: &AppState,
    kind: OutputKind,
    id: Uuid,
    delete_file: bool,
) -> ApiResult<DeleteOutputResult> {
    let _mutation = state.output_mutations.lock().await;
    let output = load_output(state, kind, id).await?;
    if !output.is_terminal() {
        return Err(conflict("An active export cannot be deleted"));
    }
    if !delete_file {
        delete_output_record(state, &output).await?;
        publish_output_change(state, kind, id, "deleted");
        return Ok(DeleteOutputResult {
            id,
            output_kind: kind,
            record_deleted: true,
            file_deleted: false,
            file_action: "record_only",
            warning: None,
        });
    }

    let roots = ManagedRoots::discover(state.data_dir()).await?;
    let path_state = inspect_output_path(output.path(), &roots).await;
    match path_state.availability {
        OutputAvailability::Missing => {
            delete_output_record(state, &output).await?;
            publish_output_change(state, kind, id, "deleted");
            Ok(DeleteOutputResult {
                id,
                output_kind: kind,
                record_deleted: true,
                file_deleted: false,
                file_action: "missing_record_removed",
                warning: None,
            })
        }
        OutputAvailability::Present if !path_state.managed => {
            delete_output_record(state, &output).await?;
            publish_output_change(state, kind, id, "deleted");
            Ok(DeleteOutputResult {
                id,
                output_kind: kind,
                record_deleted: true,
                file_deleted: false,
                file_action: "external_file_preserved",
                warning: None,
            })
        }
        OutputAvailability::Present => {
            let source = path_state.canonical_path.ok_or_else(|| {
                ApiError::new(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "invalid_output_state",
                    "The managed output path could not be resolved",
                )
            })?;
            let deletion = delete_managed_file_with_rollback(state, &roots, &source, || {
                delete_output_record(state, &output)
            })
            .await?;
            publish_output_change(state, kind, id, "deleted");
            Ok(DeleteOutputResult {
                id,
                output_kind: kind,
                record_deleted: true,
                file_deleted: deletion.file_deleted,
                file_action: deletion.file_action,
                warning: deletion.warning,
            })
        }
        OutputAvailability::Unsafe => Err(conflict(
            "The output path is a symbolic link or non-regular file; delete the record without deleting the file",
        )),
    }
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct BatchDeleteRequest {
    items: Vec<OutputReference>,
    delete_files: bool,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq, Hash, TS)]
#[serde(deny_unknown_fields)]
#[ts(export)]
struct OutputReference {
    kind: OutputKind,
    id: Uuid,
}

#[derive(Debug, Serialize, TS)]
#[ts(export)]
struct BatchDeleteItemResult {
    kind: OutputKind,
    id: Uuid,
    result: Option<DeleteOutputResult>,
    error: Option<String>,
}

#[derive(Debug, Serialize, TS)]
#[ts(export)]
struct BatchDeleteResponse {
    requested: usize,
    deleted: usize,
    failed: usize,
    items: Vec<BatchDeleteItemResult>,
}

async fn batch_delete_outputs(
    State(state): State<AppState>,
    ApiJson(request): ApiJson<BatchDeleteRequest>,
) -> ApiResult<Json<BatchDeleteResponse>> {
    if request.items.is_empty() || request.items.len() > MAXIMUM_BATCH_SIZE {
        return Err(ApiError::invalid(format!(
            "items must contain between 1 and {MAXIMUM_BATCH_SIZE} outputs"
        )));
    }
    let unique = request.items.iter().copied().collect::<HashSet<_>>();
    if unique.len() != request.items.len() {
        return Err(ApiError::invalid("items must not contain duplicates"));
    }

    let requested = request.items.len();
    let mut items = Vec::with_capacity(requested);
    for reference in request.items {
        match delete_stored_output(&state, reference.kind, reference.id, request.delete_files).await
        {
            Ok(result) => items.push(BatchDeleteItemResult {
                kind: reference.kind,
                id: reference.id,
                result: Some(result),
                error: None,
            }),
            Err(error) => items.push(BatchDeleteItemResult {
                kind: reference.kind,
                id: reference.id,
                result: None,
                error: Some(error.to_string()),
            }),
        }
    }
    let deleted = items.iter().filter(|item| item.result.is_some()).count();
    Ok(Json(BatchDeleteResponse {
        requested,
        deleted,
        failed: requested - deleted,
        items,
    }))
}

#[derive(Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
struct CleanupMissingRequest {
    kind: Option<OutputKind>,
}

#[derive(Debug, Serialize, TS)]
#[ts(export)]
struct CleanupMissingResponse {
    inspected: usize,
    deleted: usize,
    scan_limited: bool,
}

async fn cleanup_missing_outputs(
    State(state): State<AppState>,
    ApiJson(request): ApiJson<CleanupMissingRequest>,
) -> ApiResult<Json<CleanupMissingResponse>> {
    let _mutation = state.output_mutations.lock().await;
    let roots = ManagedRoots::discover(state.data_dir()).await?;
    let fetch_limit = MAXIMUM_OUTPUT_SCAN_PER_KIND.saturating_add(1);
    let (mut clips, mut exports) = tokio::try_join!(
        state.storage.list_recorded_clips_limited(fetch_limit),
        state.storage.list_export_jobs_limited(None, fetch_limit)
    )?;
    let scan_limited = clips.len() > MAXIMUM_OUTPUT_SCAN_PER_KIND as usize
        || exports.len() > MAXIMUM_OUTPUT_SCAN_PER_KIND as usize;
    clips.truncate(MAXIMUM_OUTPUT_SCAN_PER_KIND as usize);
    exports.truncate(MAXIMUM_OUTPUT_SCAN_PER_KIND as usize);
    let mut outputs = Vec::with_capacity(clips.len() + exports.len());
    if request
        .kind
        .is_none_or(|kind| kind == OutputKind::Recording)
    {
        outputs.extend(clips.into_iter().map(StoredOutput::Recording));
    }
    if request.kind.is_none_or(|kind| kind == OutputKind::Export) {
        outputs.extend(
            exports
                .into_iter()
                .filter(|record| record.job.status.is_terminal())
                .map(StoredOutput::Export),
        );
    }
    let inspected = outputs.len();
    let mut deleted = 0;
    for output in outputs {
        if inspect_output_path(output.path(), &roots)
            .await
            .availability
            != OutputAvailability::Missing
        {
            continue;
        }
        if delete_output_record(&state, &output).await? {
            deleted += 1;
            publish_output_change(&state, output.kind(), output.id(), "deleted");
        }
    }
    Ok(Json(CleanupMissingResponse {
        inspected,
        deleted,
        scan_limited,
    }))
}

#[derive(Debug, Serialize, TS)]
#[ts(export)]
struct CleanupStagedResponse {
    inspected: usize,
    deleted: usize,
    failed: usize,
    scan_limited: bool,
}

async fn cleanup_staged_outputs(
    State(state): State<AppState>,
) -> ApiResult<Json<CleanupStagedResponse>> {
    let _mutation = state.output_mutations.lock().await;
    let roots = ManagedRoots::discover(state.data_dir()).await?;
    let Some(trash) = managed_trash_directory(&state, &roots, false).await? else {
        return Ok(Json(CleanupStagedResponse {
            inspected: 0,
            deleted: 0,
            failed: 0,
            scan_limited: false,
        }));
    };
    let mut directory = fs::read_dir(&trash).await?;
    let mut inspected = 0;
    let mut deleted = 0;
    let mut failed = 0;
    let mut scan_limited = false;
    while let Some(entry) = directory.next_entry().await? {
        if inspected == MAXIMUM_STAGED_CLEANUP {
            scan_limited = true;
            break;
        }
        inspected += 1;
        let path = entry.path();
        let metadata = fs::symlink_metadata(&path).await?;
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            failed += 1;
            continue;
        }
        match fs::remove_file(&path).await {
            Ok(()) => deleted += 1,
            Err(error) => {
                failed += 1;
                tracing::warn!(%error, path = %path.display(), "staged output cleanup failed");
            }
        }
    }
    Ok(Json(CleanupStagedResponse {
        inspected,
        deleted,
        failed,
        scan_limited,
    }))
}

async fn persist_output(state: &AppState, output: StoredOutput) -> ApiResult<()> {
    match output {
        StoredOutput::Recording(clip) => {
            state.storage.put_recorded_clip(clip).await?;
        }
        StoredOutput::Export(record) => {
            state.storage.put_export_job(record).await?;
        }
    }
    Ok(())
}

async fn delete_output_record(state: &AppState, output: &StoredOutput) -> ApiResult<bool> {
    let deleted = match output {
        StoredOutput::Recording(clip) => state.storage.delete_recorded_clip(clip.id).await?,
        StoredOutput::Export(record) => state.storage.delete_export_job(record.job.id).await?,
    };
    if deleted {
        Ok(true)
    } else {
        Err(ApiError::not_found("output record"))
    }
}

fn publish_output_change(state: &AppState, kind: OutputKind, id: Uuid, action: &str) {
    let topic = match kind {
        OutputKind::Recording => "recorded_clip",
        OutputKind::Export => "export_job",
    };
    state.events.publish(topic, action, Some(id));
}

async fn stage_managed_file(
    state: &AppState,
    roots: &ManagedRoots,
    source: &FilePath,
) -> ApiResult<PathBuf> {
    let trash = managed_trash_directory(state, roots, true)
        .await?
        .ok_or_else(|| conflict("The output quarantine directory is unavailable"))?;
    let staged = trash.join(format!("{}.pending-delete", Uuid::new_v4()));
    move_file_without_overwrite(source, &staged).await?;
    Ok(staged)
}

async fn managed_trash_directory(
    state: &AppState,
    roots: &ManagedRoots,
    create: bool,
) -> ApiResult<Option<PathBuf>> {
    let requested = state.data_dir().join(TRASH_DIRECTORY);
    if create {
        match fs::create_dir(&requested).await {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(error) => return Err(error.into()),
        }
    }
    let metadata = match fs::symlink_metadata(&requested).await {
        Ok(metadata) => metadata,
        Err(error) if !create && error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(conflict("The output quarantine directory is unsafe"));
    }
    let trash = fs::canonicalize(&requested).await?;
    if !trash.starts_with(&roots.data) || trash == roots.data {
        return Err(conflict("The output quarantine directory is unsafe"));
    }
    Ok(Some(trash))
}

#[derive(Debug)]
struct ManagedFileDeletion {
    file_deleted: bool,
    file_action: &'static str,
    warning: Option<String>,
}

async fn delete_managed_file_with_rollback<F, Fut>(
    state: &AppState,
    roots: &ManagedRoots,
    source: &FilePath,
    delete_record: F,
) -> ApiResult<ManagedFileDeletion>
where
    F: FnOnce() -> Fut,
    Fut: Future<Output = ApiResult<bool>>,
{
    let staged = stage_managed_file(state, roots, source).await?;
    if let Err(error) = delete_record().await {
        if !restore_file_after_failed_change(&staged, source).await {
            return Err(ApiError::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                "output_rollback_failed",
                "The output record change failed and the file could not be restored",
            ));
        }
        return Err(error);
    }
    match fs::remove_file(&staged).await {
        Ok(()) => Ok(ManagedFileDeletion {
            file_deleted: true,
            file_action: "managed_file_deleted",
            warning: None,
        }),
        Err(error) => {
            tracing::warn!(%error, path = %staged.display(), "output remains staged for retry cleanup");
            Ok(ManagedFileDeletion {
                file_deleted: false,
                file_action: "managed_file_pending_cleanup",
                warning: Some(
                    "The record was removed, but the staged file is still using disk space; retry staged cleanup"
                        .to_owned(),
                ),
            })
        }
    }
}

async fn move_file_without_overwrite(source: &FilePath, destination: &FilePath) -> ApiResult<()> {
    match fs::hard_link(source, destination).await {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            return Err(conflict("A file with that name already exists"));
        }
        Err(error) => return Err(error.into()),
    }
    if let Err(error) = fs::remove_file(source).await {
        if let Err(cleanup_error) = fs::remove_file(destination).await {
            tracing::error!(
                %cleanup_error,
                path = %destination.display(),
                "unable to roll back output link after source removal failed"
            );
        }
        return Err(error.into());
    }
    Ok(())
}

async fn restore_file_after_failed_change(staged: &FilePath, original: &FilePath) -> bool {
    if let Err(error) = move_file_without_overwrite(staged, original).await {
        tracing::error!(
            %error,
            staged = %staged.display(),
            original = %original.display(),
            "unable to roll back output filesystem change"
        );
        return false;
    }
    true
}

fn validate_output_file_name(file_name: &str) -> ApiResult<()> {
    let file_name = file_name.trim();
    let mut components = FilePath::new(file_name).components();
    if file_name.is_empty()
        || file_name.chars().count() > 180
        || !matches!(components.next(), Some(Component::Normal(_)))
        || components.next().is_some()
        || file_name.ends_with(['.', ' '])
        || file_name.chars().any(|character| {
            character.is_control()
                || matches!(
                    character,
                    '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*'
                )
        })
    {
        return Err(ApiError::invalid(
            "file_name must be a safe local file name of at most 180 characters",
        ));
    }
    let stem = file_name
        .split('.')
        .next()
        .unwrap_or_default()
        .to_ascii_uppercase();
    if matches!(
        stem.as_str(),
        "CON"
            | "PRN"
            | "AUX"
            | "NUL"
            | "COM1"
            | "COM2"
            | "COM3"
            | "COM4"
            | "COM5"
            | "COM6"
            | "COM7"
            | "COM8"
            | "COM9"
            | "LPT1"
            | "LPT2"
            | "LPT3"
            | "LPT4"
            | "LPT5"
            | "LPT6"
            | "LPT7"
            | "LPT8"
            | "LPT9"
    ) {
        return Err(ApiError::invalid(
            "file_name is reserved by the operating system",
        ));
    }
    Ok(())
}

fn validate_preserved_extension(source: &FilePath, file_name: &str) -> ApiResult<()> {
    let source_extension = source
        .extension()
        .and_then(|extension| extension.to_str())
        .map(str::to_ascii_lowercase);
    let destination_extension = FilePath::new(file_name)
        .extension()
        .and_then(|extension| extension.to_str())
        .map(str::to_ascii_lowercase);
    if source_extension != destination_extension {
        return Err(ApiError::invalid(
            "file_name must preserve the original file extension",
        ));
    }
    Ok(())
}

fn parse_id(id: &str) -> ApiResult<Uuid> {
    Uuid::parse_str(id).map_err(|_| ApiError::invalid("invalid output id"))
}

fn conflict(message: impl Into<String>) -> ApiError {
    ApiError::new(StatusCode::CONFLICT, "output_conflict", message)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;
    use vibe_cs_domain::ExportJob;

    #[test]
    fn output_requests_reject_fields_outside_the_current_contract() {
        assert!(
            serde_json::from_value::<RenameOutputRequest>(serde_json::json!({
                "file_name": "renamed.mp4",
                "unexpected": true
            }))
            .is_err()
        );
        assert!(
            serde_json::from_value::<OutputListQuery>(serde_json::json!({
                "page": 1,
                "unexpected": true
            }))
            .is_err()
        );
        assert!(
            serde_json::from_value::<DeleteOutputQuery>(serde_json::json!({
                "delete_file": true,
                "unexpected": true
            }))
            .is_err()
        );
        assert!(serde_json::from_value::<DeleteOutputQuery>(serde_json::json!({})).is_err());
        assert!(
            serde_json::from_value::<BatchDeleteRequest>(serde_json::json!({
                "items": [],
                "delete_files": false,
                "unexpected": true
            }))
            .is_err()
        );
        assert!(
            serde_json::from_value::<BatchDeleteRequest>(serde_json::json!({
                "items": []
            }))
            .is_err()
        );
        assert!(
            serde_json::from_value::<CleanupMissingRequest>(serde_json::json!({
                "kind": null,
                "unexpected": true
            }))
            .is_err()
        );
    }

    #[test]
    fn output_file_names_reject_escape_and_reserved_names() {
        for unsafe_name in [
            "../round.mp4",
            "folder/round.mp4",
            r"folder\round.mp4",
            "CON.mp4",
            "round.mp4.",
            "round?.mp4",
        ] {
            assert!(
                validate_output_file_name(unsafe_name).is_err(),
                "{unsafe_name}"
            );
        }
        assert!(validate_output_file_name("round-12 ace.mp4").is_ok());
    }

    #[tokio::test]
    async fn managed_rename_updates_file_and_record() {
        let fixture = Fixture::new().await;
        let clip = fixture.recorded_clip("opening.mp4").await;
        let roots = ManagedRoots::discover(fixture.root.path())
            .await
            .expect("managed roots");
        let mut output = load_output(&fixture.state, OutputKind::Recording, clip.id)
            .await
            .expect("load output");
        let source = inspect_output_path(output.path(), &roots)
            .await
            .canonical_path
            .expect("source path");
        let destination = source.parent().expect("parent").join("renamed.mp4");
        move_file_without_overwrite(&source, &destination)
            .await
            .expect("rename file");
        output.set_path(destination.to_string_lossy().into_owned());
        persist_output(&fixture.state, output)
            .await
            .expect("persist rename");

        assert!(!source.exists());
        assert_eq!(
            std::fs::read(&destination).expect("renamed bytes"),
            b"video"
        );
        let stored = fixture
            .state
            .storage
            .get_recorded_clip(clip.id)
            .await
            .expect("storage")
            .expect("stored clip");
        assert_eq!(PathBuf::from(stored.path), destination);
    }

    #[tokio::test]
    async fn physical_delete_preserves_external_files_and_removes_their_records() {
        let fixture = Fixture::new().await;
        let external = fixture.root.path().join("external.mp4");
        fs::write(&external, b"source")
            .await
            .expect("external file");
        let clip = fixture
            .put_clip(external.to_string_lossy().into_owned(), "External")
            .await;

        let result = delete_stored_output(&fixture.state, OutputKind::Recording, clip.id, true)
            .await
            .expect("delete record");

        assert_eq!(result.file_action, "external_file_preserved");
        assert!(external.exists());
        assert!(
            fixture
                .state
                .storage
                .get_recorded_clip(clip.id)
                .await
                .expect("storage")
                .is_none()
        );
    }

    #[tokio::test]
    async fn physical_delete_removes_only_a_managed_regular_file() {
        let fixture = Fixture::new().await;
        let clip = fixture.recorded_clip("managed.mp4").await;
        let path = PathBuf::from(&clip.path);

        let result = delete_stored_output(&fixture.state, OutputKind::Recording, clip.id, true)
            .await
            .expect("delete managed output");

        assert!(result.file_deleted);
        assert_eq!(result.file_action, "managed_file_deleted");
        assert!(!path.exists());
        assert!(
            fixture
                .state
                .storage
                .get_recorded_clip(clip.id)
                .await
                .expect("storage")
                .is_none()
        );
    }

    #[tokio::test]
    async fn rename_refuses_overwrite_and_preserves_both_files() {
        let fixture = Fixture::new().await;
        let clip = fixture.recorded_clip("source.mp4").await;
        let source = PathBuf::from(&clip.path);
        let destination = source.parent().expect("parent").join("existing.mp4");
        fs::write(&destination, b"existing")
            .await
            .expect("existing file");

        assert!(
            move_file_without_overwrite(&source, &destination)
                .await
                .is_err()
        );
        assert_eq!(std::fs::read(source).expect("source bytes"), b"video");
        assert_eq!(
            std::fs::read(destination).expect("destination bytes"),
            b"existing"
        );
    }

    #[tokio::test]
    async fn managed_delete_restores_the_file_when_record_deletion_fails() {
        let fixture = Fixture::new().await;
        let clip = fixture.recorded_clip("rollback.mp4").await;
        let source = PathBuf::from(&clip.path);
        let roots = ManagedRoots::discover(fixture.root.path())
            .await
            .expect("managed roots");

        let result = delete_managed_file_with_rollback(&fixture.state, &roots, &source, || async {
            Err(ApiError::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                "injected",
                "failure",
            ))
        })
        .await;

        assert!(result.is_err());
        assert_eq!(std::fs::read(&source).expect("restored bytes"), b"video");
        assert!(
            fixture
                .state
                .storage
                .get_recorded_clip(clip.id)
                .await
                .expect("storage")
                .is_some()
        );
    }

    #[tokio::test]
    async fn concurrent_rename_and_delete_cannot_resurrect_an_output() {
        let fixture = Fixture::new().await;
        let clip = fixture.recorded_clip("concurrent.mp4").await;
        let source = PathBuf::from(&clip.path);
        let renamed = source.parent().expect("parent").join("renamed.mp4");
        let barrier = std::sync::Arc::new(tokio::sync::Barrier::new(3));

        let rename_state = fixture.state.clone();
        let rename_barrier = barrier.clone();
        let rename_id = clip.id;
        let rename = tokio::spawn(async move {
            rename_barrier.wait().await;
            rename_output(
                State(rename_state),
                Path(("recording".to_owned(), rename_id.to_string())),
                ApiJson(RenameOutputRequest {
                    file_name: "renamed.mp4".to_owned(),
                }),
            )
            .await
        });

        let delete_state = fixture.state.clone();
        let delete_barrier = barrier.clone();
        let delete_id = clip.id;
        let delete = tokio::spawn(async move {
            delete_barrier.wait().await;
            delete_stored_output(&delete_state, OutputKind::Recording, delete_id, true).await
        });

        barrier.wait().await;
        let _rename_result = rename.await.expect("rename task");
        delete.await.expect("delete task").expect("delete output");

        assert!(
            fixture
                .state
                .storage
                .get_recorded_clip(clip.id)
                .await
                .expect("storage")
                .is_none()
        );
        assert!(!source.exists());
        assert!(!renamed.exists());
    }

    #[tokio::test]
    async fn cleanup_keeps_active_missing_exports() {
        let fixture = Fixture::new().await;
        let now = Utc::now();
        let id = Uuid::new_v4();
        let project_id = fixture.project().await;
        fixture
            .state
            .storage
            .put_export_job(ExportJobRecord {
                kind: "project".to_owned(),
                job: ExportJob {
                    id,
                    project_id,
                    project_revision: 1,
                    status: JobStatus::Running,
                    progress: 0.5,
                    output_path: fixture
                        .root
                        .path()
                        .join(EXPORTS_DIRECTORY)
                        .join("pending.mp4")
                        .to_string_lossy()
                        .into_owned(),
                    error: None,
                    error_code: None,
                    created_at: now,
                    updated_at: now,
                },
            })
            .await
            .expect("put export");
        let roots = ManagedRoots::discover(fixture.root.path())
            .await
            .expect("managed roots");
        let (items, scan_limited) = list_all_outputs(&fixture.state, &roots, None)
            .await
            .expect("list outputs");

        assert!(!scan_limited);
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].availability, OutputAvailability::Missing);
        assert_eq!(items[0].project_revision, Some(1));
        assert!(!items[0].mutable);
        assert!(
            fixture
                .state
                .storage
                .get_export_job(id)
                .await
                .expect("storage")
                .is_some()
        );
    }

    struct Fixture {
        root: TempDir,
        state: AppState,
    }

    impl Fixture {
        async fn new() -> Self {
            let root = tempfile::tempdir().expect("temporary directory");
            fs::create_dir_all(root.path().join(RECORDINGS_DIRECTORY))
                .await
                .expect("recordings directory");
            fs::create_dir_all(root.path().join(EXPORTS_DIRECTORY))
                .await
                .expect("exports directory");
            let storage = vibe_cs_storage::Storage::open_in_memory()
                .await
                .expect("storage");
            let state = AppState::new(storage, root.path().to_path_buf());
            Self { root, state }
        }

        async fn recorded_clip(&self, file_name: &str) -> RecordedClip {
            let path = self.root.path().join(RECORDINGS_DIRECTORY).join(file_name);
            fs::write(&path, b"video").await.expect("recorded file");
            self.put_clip(path.to_string_lossy().into_owned(), "Opening")
                .await
        }

        async fn put_clip(&self, path: String, title: &str) -> RecordedClip {
            let clip = RecordedClip {
                id: Uuid::new_v4(),
                path,
                title: title.to_owned(),
                duration_seconds: 5.0,
                demo_id: None,
                player_name: None,
                category: "highlight".to_owned(),
                tags: Vec::new(),
                metadata: serde_json::Value::Null,
                created_at: Utc::now(),
            };
            self.state
                .storage
                .put_recorded_clip(clip.clone())
                .await
                .expect("put clip");
            clip
        }

        async fn project(&self) -> Uuid {
            let now = Utc::now();
            let id = Uuid::new_v4();
            let track_id = Uuid::new_v4();
            self.state
                .storage
                .create_project(vibe_cs_domain::Project {
                    id,
                    name: "Output owner".to_owned(),
                    revision: 1,
                    document: vibe_cs_domain::EditingDocument {
                        width: 1920,
                        height: 1080,
                        fps: 60,
                        duration_seconds: 0.0,
                        story_track_id: track_id,
                        tracks: vec![vibe_cs_domain::TimelineTrack {
                            id: track_id,
                            name: "Story".to_owned(),
                            kind: vibe_cs_domain::TrackKind::Video,
                            order: 0,
                            muted: false,
                            solo: false,
                            volume: 1.0,
                            pan: 0.0,
                            keyframes: Vec::new(),
                            locked: false,
                            hidden: false,
                            clips: Vec::new(),
                        }],
                        markers: Vec::new(),
                        settings: vibe_cs_domain::EditingDocumentSettings::default(),
                    },
                    created_at: now,
                    updated_at: now,
                })
                .await
                .expect("output Project");
            id
        }
    }
}
