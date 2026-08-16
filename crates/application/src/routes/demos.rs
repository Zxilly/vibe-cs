use std::path::{Path, PathBuf};
use ts_rs::TS;

use axum::{
    Json, Router,
    body::Body,
    extract::{DefaultBodyLimit, Path as AxumPath, State},
    http::{Response, StatusCode, header},
    routing::{get, patch, post},
};
use chrono::{DateTime, Utc};
use rust_xlsxwriter::{Color, Format, FormatAlign, Workbook};
use serde::{Deserialize, Serialize};
use serde_json::json;
use uuid::Uuid;
use vibe_cs_demo::{
    ArchiveLimits, ParseCancellation, ValidatedDemo, ValidationLimits, extract_demo_zip_atomic,
    validate_demo,
};
use vibe_cs_domain::{
    DEMO_MAX_PAGE, DEMO_MAX_PAGE_SIZE, DemoMatchSource, DemoMetadata, DemoMetadataBatchUpdate,
    DemoMetadataUpdate, DemoPatch, DemoQuery, DemoRecord, DemoSort, DemoStatus, MatchAnalysis,
    Page, ReviewMetadataUpdate, ReviewTag, ReviewTagCreate, RoundReviewMetadata, ScanResult,
};
use vibe_cs_storage::{DemoContentIdentity, DemoContentRecovery};

use crate::{
    ApiError, ApiJson, ApiMultipart, ApiQuery, ApiResult, AppState, DemoWatchStatus,
    extract::{multipart_error, persist_multipart_field},
};

const MAXIMUM_DEMO_UPLOAD_FILES: usize = 32;
const MAXIMUM_DEMO_UPLOAD_BATCH_BYTES: u64 = 2 * 1024 * 1024 * 1024;
const MAXIMUM_DEMO_UPLOAD_REQUEST_BYTES: usize = 2 * 1024 * 1024 * 1024 + 8 * 1024 * 1024;
const MAXIMUM_EXPANDED_UPLOAD_BYTES: u64 = 4 * 1024 * 1024 * 1024;
const MAXIMUM_EXPANDED_UPLOAD_DEMOS: usize = 256;
const MAXIMUM_PLAYBACK_REQUEST_BYTES: usize = 1024;
const MAXIMUM_DEMO_EXPORT_ROWS: u32 = 10_000;
const MAXIMUM_BINARY_REPLAY_BYTES: usize = 128 * 1024 * 1024;
const MAXIMUM_REPLAY_FRAMES: usize = 20_000;
const MAXIMUM_REPLAY_PLAYERS_PER_FRAME: usize = 64;
const MAXIMUM_REPLAY_EFFECTS_PER_FRAME: usize = 512;
const MAXIMUM_REPLAY_PLAYER_RECORDS: usize = 200_000;
const MAXIMUM_REPLAY_EFFECT_RECORDS: usize = 100_000;

pub(crate) fn router() -> Router<AppState> {
    Router::new()
        .route("/api/demos/compact", get(list_demos))
        .route("/api/demos/import", post(import_paths))
        .route("/api/demos/scan", post(scan_demos))
        .route("/api/demos/watch/status", get(watch_status))
        .route("/api/demos/watch/rescan", post(watch_rescan))
        .route(
            "/api/demo/upload-multiple",
            post(upload_multiple).layer(DefaultBodyLimit::max(MAXIMUM_DEMO_UPLOAD_REQUEST_BYTES)),
        )
        .route(
            "/api/demos/{id}",
            get(get_demo).patch(patch_demo).delete(delete_demo),
        )
        .route(
            "/api/demos/{id}/metadata",
            get(get_demo_metadata).put(update_demo_metadata),
        )
        .route(
            "/api/demos/{id}/rounds/{round}/metadata",
            get(get_round_review_metadata).put(update_round_review_metadata),
        )
        .route(
            "/api/demos/metadata/batch",
            post(update_demo_metadata_batch),
        )
        .route("/api/demos/export", get(export_demos))
        .route(
            "/api/review-tags",
            get(list_review_tags).post(create_review_tag),
        )
        .route(
            "/api/review-tags/{id}",
            patch(update_review_tag).delete(delete_review_tag),
        )
        .route("/api/demos/{id}/analysis", get(get_analysis))
        .route("/api/demos/{id}/replay.bin", get(get_replay_binary))
        .route(
            "/api/replay-cache",
            get(get_replay_cache_status).delete(clear_replay_cache),
        )
        .route("/api/demos/{id}/heatmap", get(get_heatmap))
        .route(
            "/api/demos/{id}/playback/preflight",
            post(preflight_demo).layer(DefaultBodyLimit::max(MAXIMUM_PLAYBACK_REQUEST_BYTES)),
        )
        .route(
            "/api/demos/{id}/play",
            post(play_demo).layer(DefaultBodyLimit::max(MAXIMUM_PLAYBACK_REQUEST_BYTES)),
        )
        .route(
            "/api/playback/stop",
            post(stop_playback).layer(DefaultBodyLimit::max(MAXIMUM_PLAYBACK_REQUEST_BYTES)),
        )
}

async fn watch_status(State(state): State<AppState>) -> Json<DemoWatchStatus> {
    Json(state.demo_watch.status().await)
}

async fn watch_rescan(State(state): State<AppState>) -> ApiResult<Json<DemoWatchStatus>> {
    Ok(Json(state.demo_watch.rescan().await?))
}

#[derive(Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
struct DemoListQuery {
    search: Option<String>,
    source: Option<String>,
    match_source: Option<String>,
    tag_id: Option<String>,
    map_name: Option<String>,
    status: Option<String>,
    sort: Option<String>,
    page: Option<u32>,
    page_size: Option<u32>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct DemoExportQuery {
    format: String,
    search: Option<String>,
    source: Option<String>,
    match_source: Option<String>,
    tag_id: Option<String>,
    map_name: Option<String>,
    status: Option<String>,
    sort: Option<String>,
}

#[derive(Debug, Serialize)]
struct DemoExportDocument {
    schema_version: u32,
    exported_at: DateTime<Utc>,
    total: usize,
    demos: Vec<DemoExportRow>,
}

#[derive(Debug, Serialize)]
struct DemoExportRow {
    demo: DemoRecord,
    metadata: DemoMetadata,
}

#[derive(Debug, Serialize, TS)]
#[ts(export)]
struct DemoSummaryDto {
    id: Uuid,
    file_name: String,
    path: String,
    display_name: String,
    map_name: Option<String>,
    match_date: Option<DateTime<Utc>>,
    duration_seconds: Option<f64>,
    total_rounds: Option<u32>,
    team_a_name: Option<String>,
    team_b_name: Option<String>,
    team_a_score: Option<u32>,
    team_b_score: Option<u32>,
    status: DemoStatus,
    players: Vec<String>,
    source: String,
    remark: String,
    content_sha256: Option<String>,
    file_size: u64,
    created_at: DateTime<Utc>,
    updated_at: DateTime<Utc>,
}

impl From<DemoRecord> for DemoSummaryDto {
    fn from(demo: DemoRecord) -> Self {
        Self {
            id: demo.id,
            file_name: demo.file_name,
            path: demo.path,
            display_name: demo.display_name,
            map_name: demo.map_name,
            match_date: demo.match_date,
            duration_seconds: demo.duration_seconds,
            total_rounds: demo.total_rounds,
            team_a_name: demo.team_a_name,
            team_b_name: demo.team_b_name,
            team_a_score: demo.team_a_score,
            team_b_score: demo.team_b_score,
            status: demo.status,
            players: demo.player_names,
            source: demo.source,
            remark: demo.remark,
            content_sha256: demo.content_sha256,
            file_size: demo.file_size,
            created_at: demo.created_at,
            updated_at: demo.updated_at,
        }
    }
}

async fn list_demos(
    State(state): State<AppState>,
    ApiQuery(query): ApiQuery<DemoListQuery>,
) -> ApiResult<Json<Page<DemoSummaryDto>>> {
    validate_demo_window(query.page, query.page_size)?;
    let status = query.status.as_deref().map(parse_status).transpose()?;
    let match_source = query
        .match_source
        .as_deref()
        .map(parse_match_source)
        .transpose()?;
    let tag_id = query.tag_id.as_deref().map(parse_id).transpose()?;
    let sort = parse_demo_sort(query.sort.as_deref())?;
    let page = state
        .storage
        .list_demos(DemoQuery {
            search: query.search,
            source: query.source,
            match_source,
            tag_id,
            map_name: query.map_name,
            status,
            sort,
            page: query.page,
            page_size: query.page_size,
        })
        .await?;
    Ok(Json(Page {
        items: page.items.into_iter().map(Into::into).collect(),
        total: page.total,
        page: page.page,
        page_size: page.page_size,
    }))
}

async fn export_demos(
    State(state): State<AppState>,
    ApiQuery(query): ApiQuery<DemoExportQuery>,
) -> ApiResult<Response<Body>> {
    if !matches!(query.format.as_str(), "json" | "xlsx") {
        return Err(ApiError::invalid("demo export format must be json or xlsx"));
    }
    let status = query.status.as_deref().map(parse_status).transpose()?;
    let match_source = query
        .match_source
        .as_deref()
        .map(parse_match_source)
        .transpose()?;
    let tag_id = query.tag_id.as_deref().map(parse_id).transpose()?;
    let sort = parse_demo_sort(query.sort.as_deref())?;
    let rows = state
        .storage
        .list_demo_metadata_export(
            DemoQuery {
                search: query.search,
                source: query.source,
                match_source,
                tag_id,
                map_name: query.map_name,
                status,
                sort,
                page: None,
                page_size: None,
            },
            MAXIMUM_DEMO_EXPORT_ROWS,
        )
        .await?;
    let exported_at = Utc::now();
    let (content_type, extension, bytes) = if query.format == "json" {
        let document = DemoExportDocument {
            schema_version: 1,
            exported_at,
            total: rows.len(),
            demos: rows
                .into_iter()
                .map(|(demo, metadata)| DemoExportRow { demo, metadata })
                .collect(),
        };
        (
            "application/json; charset=utf-8",
            "json",
            serde_json::to_vec_pretty(&document).map_err(|error| {
                ApiError::new(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "demo_export_failed",
                    error.to_string(),
                )
            })?,
        )
    } else {
        (
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            "xlsx",
            build_demo_export_workbook(&rows, exported_at).map_err(|error| {
                ApiError::new(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "demo_export_failed",
                    error.to_string(),
                )
            })?,
        )
    };
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, content_type)
        .header(
            header::CONTENT_DISPOSITION,
            format!(
                "attachment; filename=\"vibe-cs-demos-{}.{}\"",
                exported_at.format("%Y%m%d-%H%M%S"),
                extension
            ),
        )
        .body(Body::from(bytes))
        .map_err(|error| {
            ApiError::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                "demo_export_failed",
                error.to_string(),
            )
        })
}

fn build_demo_export_workbook(
    rows: &[(DemoRecord, DemoMetadata)],
    exported_at: DateTime<Utc>,
) -> Result<Vec<u8>, rust_xlsxwriter::XlsxError> {
    let mut workbook = Workbook::new();
    let title = Format::new()
        .set_bold()
        .set_font_size(16)
        .set_font_color(Color::White)
        .set_background_color(Color::RGB(0x0017_3F5F));
    let header_format = Format::new()
        .set_bold()
        .set_font_color(Color::White)
        .set_background_color(Color::RGB(0x0020_639B))
        .set_align(FormatAlign::Center);
    let wrap_format = Format::new().set_text_wrap().set_align(FormatAlign::Top);

    let summary = workbook.add_worksheet().set_name("Export Info")?;
    summary.set_column_width(0, 24)?;
    summary.set_column_width(1, 48)?;
    summary.merge_range(0, 0, 0, 1, "Vibe CS Demo Library Export", &title)?;
    summary.write_string_with_format(2, 0, "Schema version", &header_format)?;
    summary.write_number(2, 1, 1)?;
    summary.write_string_with_format(3, 0, "Exported at (UTC)", &header_format)?;
    summary.write_string(3, 1, exported_at.to_rfc3339())?;
    summary.write_string_with_format(4, 0, "Rows", &header_format)?;
    summary.write_number(4, 1, u32::try_from(rows.len()).unwrap_or(u32::MAX))?;
    summary.merge_range(
        6,
        0,
        6,
        1,
        "Match source is provider metadata. Import source remains separate.",
        &wrap_format,
    )?;

    let worksheet = workbook.add_worksheet().set_name("Demos")?;
    let headers = [
        "Demo ID",
        "Name",
        "File",
        "Path",
        "Lifecycle",
        "Import source",
        "Match source",
        "Map",
        "Match date",
        "Cataloged at",
        "Duration seconds",
        "Rounds",
        "Team A",
        "Team B",
        "Score A",
        "Score B",
        "Players",
        "Comment",
        "Tags",
        "SHA-256",
        "Bytes",
    ];
    for (column, value) in headers.iter().enumerate() {
        worksheet.write_string_with_format(
            0,
            u16::try_from(column).unwrap_or(0),
            *value,
            &header_format,
        )?;
    }
    worksheet.set_freeze_panes(1, 0)?;
    if !rows.is_empty() {
        worksheet.autofilter(
            0,
            0,
            u32::try_from(rows.len()).unwrap_or(u32::MAX),
            u16::try_from(headers.len() - 1).unwrap_or(0),
        )?;
    }
    for (index, (demo, metadata)) in rows.iter().enumerate() {
        let row = u32::try_from(index + 1).unwrap_or(u32::MAX);
        let text_values = [
            demo.id.to_string(),
            demo.display_name.clone(),
            demo.file_name.clone(),
            demo.path.clone(),
            json_enum(&demo.status),
            demo.source.clone(),
            metadata
                .match_source
                .as_ref()
                .map(json_enum)
                .unwrap_or_default(),
            demo.map_name.clone().unwrap_or_default(),
            demo.match_date
                .map(|value| value.to_rfc3339())
                .unwrap_or_default(),
            demo.created_at.to_rfc3339(),
        ];
        for (column, value) in text_values.iter().enumerate() {
            worksheet.write_string_with_format(
                row,
                u16::try_from(column).unwrap_or(0),
                value,
                &wrap_format,
            )?;
        }
        if let Some(value) = demo.duration_seconds {
            worksheet.write_number(row, 10, value)?;
        }
        if let Some(value) = demo.total_rounds {
            worksheet.write_number(row, 11, value)?;
        }
        worksheet.write_string_with_format(
            row,
            12,
            demo.team_a_name.as_deref().unwrap_or_default(),
            &wrap_format,
        )?;
        worksheet.write_string_with_format(
            row,
            13,
            demo.team_b_name.as_deref().unwrap_or_default(),
            &wrap_format,
        )?;
        if let Some(value) = demo.team_a_score {
            worksheet.write_number(row, 14, value)?;
        }
        if let Some(value) = demo.team_b_score {
            worksheet.write_number(row, 15, value)?;
        }
        worksheet.write_string_with_format(row, 16, demo.player_names.join("; "), &wrap_format)?;
        worksheet.write_string_with_format(row, 17, &metadata.comment, &wrap_format)?;
        worksheet.write_string_with_format(
            row,
            18,
            metadata
                .tags
                .iter()
                .map(|tag| tag.name.as_str())
                .collect::<Vec<_>>()
                .join("; "),
            &wrap_format,
        )?;
        worksheet.write_string_with_format(
            row,
            19,
            demo.content_sha256.as_deref().unwrap_or_default(),
            &wrap_format,
        )?;
        if let Ok(value) = u32::try_from(demo.file_size) {
            worksheet.write_number(row, 20, value)?;
        } else {
            worksheet.write_string(row, 20, demo.file_size.to_string())?;
        }
    }
    for (column, width) in [
        38.0, 24.0, 24.0, 48.0, 14.0, 14.0, 16.0, 14.0, 22.0, 22.0, 16.0, 10.0, 18.0, 18.0, 10.0,
        10.0, 42.0, 42.0, 28.0, 68.0, 14.0,
    ]
    .into_iter()
    .enumerate()
    {
        worksheet.set_column_width(u16::try_from(column).unwrap_or(0), width)?;
    }
    workbook.save_to_buffer()
}

fn json_enum(value: &impl Serialize) -> String {
    serde_json::to_value(value)
        .ok()
        .and_then(|value| value.as_str().map(ToOwned::to_owned))
        .unwrap_or_default()
}

fn parse_match_source(value: &str) -> ApiResult<DemoMatchSource> {
    match value {
        "challengermode" => Ok(DemoMatchSource::Challengermode),
        "ebot" => Ok(DemoMatchSource::Ebot),
        "esl" => Ok(DemoMatchSource::Esl),
        "esplay" => Ok(DemoMatchSource::Esplay),
        "esportal" => Ok(DemoMatchSource::Esportal),
        "esportligaen" => Ok(DemoMatchSource::Esportligaen),
        "faceit" => Ok(DemoMatchSource::Faceit),
        "fastcup" => Ok(DemoMatchSource::Fastcup),
        "five_eplay" => Ok(DemoMatchSource::FiveEplay),
        "matchzy" => Ok(DemoMatchSource::Matchzy),
        "perfect_world" => Ok(DemoMatchSource::PerfectWorld),
        "pracc" => Ok(DemoMatchSource::Pracc),
        "renown" => Ok(DemoMatchSource::Renown),
        "valve" => Ok(DemoMatchSource::Valve),
        _ => Err(ApiError::invalid("unsupported demo match_source")),
    }
}

async fn get_demo(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
) -> ApiResult<Json<DemoSummaryDto>> {
    let id = parse_id(&id)?;
    state
        .storage
        .get_demo(id)
        .await?
        .map(|demo| Json(demo.into()))
        .ok_or_else(|| ApiError::not_found("demo"))
}

async fn patch_demo(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
    ApiJson(patch): ApiJson<DemoPatch>,
) -> ApiResult<Json<DemoSummaryDto>> {
    let id = parse_id(&id)?;
    let demo = state
        .storage
        .patch_demo(id, patch)
        .await?
        .ok_or_else(|| ApiError::not_found("demo"))?;
    state.events.publish("demo", "updated", Some(id));
    Ok(Json(demo.into()))
}

async fn get_demo_metadata(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
) -> ApiResult<Json<DemoMetadata>> {
    let id = parse_id(&id)?;
    state
        .storage
        .get_demo_metadata(id)
        .await?
        .map(Json)
        .ok_or_else(|| ApiError::not_found("demo"))
}

async fn update_demo_metadata(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
    ApiJson(update): ApiJson<DemoMetadataUpdate>,
) -> ApiResult<Json<DemoMetadata>> {
    let id = parse_id(&id)?;
    let metadata = state
        .storage
        .update_demo_metadata(id, update)
        .await?
        .ok_or_else(|| ApiError::not_found("demo"))?;
    state.events.publish("demo", "metadata_updated", Some(id));
    Ok(Json(metadata))
}

async fn update_demo_metadata_batch(
    State(state): State<AppState>,
    ApiJson(update): ApiJson<DemoMetadataBatchUpdate>,
) -> ApiResult<Json<Vec<DemoMetadata>>> {
    let metadata = state.storage.update_demo_metadata_batch(update).await?;
    for item in &metadata {
        state
            .events
            .publish("demo", "metadata_updated", Some(item.demo_id));
    }
    Ok(Json(metadata))
}

async fn list_review_tags(State(state): State<AppState>) -> ApiResult<Json<Vec<ReviewTag>>> {
    Ok(Json(state.storage.list_review_tags().await?))
}

async fn create_review_tag(
    State(state): State<AppState>,
    ApiJson(input): ApiJson<ReviewTagCreate>,
) -> ApiResult<(StatusCode, Json<ReviewTag>)> {
    let tag = state.storage.create_review_tag(input).await?;
    state.events.publish("review_tag", "created", Some(tag.id));
    Ok((StatusCode::CREATED, Json(tag)))
}

async fn update_review_tag(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
    ApiJson(input): ApiJson<ReviewTagCreate>,
) -> ApiResult<Json<ReviewTag>> {
    let id = parse_id(&id)?;
    let tag = state
        .storage
        .update_review_tag(id, input)
        .await?
        .ok_or_else(|| ApiError::not_found("review tag"))?;
    state.events.publish("review_tag", "updated", Some(id));
    Ok(Json(tag))
}

async fn delete_review_tag(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
) -> ApiResult<StatusCode> {
    let id = parse_id(&id)?;
    if !state.storage.delete_review_tag(id).await? {
        return Err(ApiError::not_found("review tag"));
    }
    state.events.publish("review_tag", "deleted", Some(id));
    Ok(StatusCode::NO_CONTENT)
}

async fn get_round_review_metadata(
    State(state): State<AppState>,
    AxumPath((id, round)): AxumPath<(String, u32)>,
) -> ApiResult<Json<RoundReviewMetadata>> {
    let id = parse_id(&id)?;
    state
        .storage
        .get_round_review_metadata(id, round)
        .await?
        .map(Json)
        .ok_or_else(|| ApiError::not_found("round"))
}

async fn update_round_review_metadata(
    State(state): State<AppState>,
    AxumPath((id, round)): AxumPath<(String, u32)>,
    ApiJson(update): ApiJson<ReviewMetadataUpdate>,
) -> ApiResult<Json<RoundReviewMetadata>> {
    let id = parse_id(&id)?;
    let metadata = state
        .storage
        .update_round_review_metadata(id, round, update)
        .await?
        .ok_or_else(|| ApiError::not_found("round"))?;
    state
        .events
        .publish("round", "review_metadata_updated", Some(id));
    Ok(Json(metadata))
}

async fn delete_demo(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
) -> ApiResult<StatusCode> {
    let id = parse_id(&id)?;
    if !state.storage.delete_demo(id).await? {
        return Err(ApiError::not_found("demo"));
    }
    state.events.publish("demo", "deleted", Some(id));
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ImportRequest {
    paths: Vec<String>,
    source: String,
}

async fn import_paths(
    State(state): State<AppState>,
    ApiJson(request): ApiJson<ImportRequest>,
) -> ApiResult<Json<ScanResult>> {
    if request.paths.is_empty() || request.paths.len() > 256 {
        return Err(ApiError::invalid(
            "demo import requires between 1 and 256 paths",
        ));
    }
    if !matches!(request.source.as_str(), "local" | "watch" | "download") {
        return Err(ApiError::invalid("unsupported demo import source"));
    }
    if request.source == "local"
        && request
            .paths
            .iter()
            .any(|path| is_zip_path(Path::new(path)))
    {
        return Ok(Json(import_local_bundle(&state, request.paths).await?));
    }
    let result = import_candidates(&state, request.paths, &request.source).await?;
    Ok(Json(result))
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ScanBody {
    paths: Vec<String>,
    recursive: bool,
}

async fn scan_demos(
    State(state): State<AppState>,
    ApiJson(mut request): ApiJson<ScanBody>,
) -> ApiResult<Json<ScanResult>> {
    if request.paths.is_empty() {
        request.paths = state
            .storage
            .get_config()
            .await?
            .unwrap_or_default()
            .demo_watch_paths;
    }
    if request.paths.is_empty() || request.paths.len() > 64 {
        return Err(ApiError::invalid(
            "demo scan requires between 1 and 64 root paths",
        ));
    }
    if request
        .paths
        .iter()
        .any(|path| !Path::new(path).is_absolute())
    {
        return Err(ApiError::invalid("demo scan roots must be absolute paths"));
    }
    let recursive = request.recursive;
    let roots = request.paths;
    let reconciliation_roots = roots.clone();
    let (candidates, scan_errors) =
        tokio::task::spawn_blocking(move || discover_demos(&roots, recursive))
            .await
            .map_err(|error| {
                tracing::error!(%error, "demo scan worker failed");
                ApiError::new(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "scan_failed",
                    "Demo scan worker failed",
                )
            })?;
    let discovered = candidates.len() as u64;
    let mut result = import_candidates(&state, candidates, "watch").await?;
    result.discovered = discovered;
    result.errors.splice(0..0, scan_errors);
    result.updated = result
        .updated
        .saturating_add(reconcile_missing_demos(&state, &reconciliation_roots).await?);
    Ok(Json(result))
}

async fn upload_multiple(
    State(state): State<AppState>,
    ApiMultipart(mut multipart): ApiMultipart,
) -> ApiResult<Json<ScanResult>> {
    let upload_dir = state.data_dir().join("uploads").join("demos");
    tokio::fs::create_dir_all(&upload_dir).await?;
    let batch_id = Uuid::new_v4();
    let intake_dir = upload_dir.join(format!(".intake-{batch_id}"));
    let staging_dir = upload_dir.join(format!(".batch-{batch_id}.staging"));
    let final_dir = upload_dir.join(format!("batch-{batch_id}"));
    tokio::fs::create_dir(&intake_dir).await?;
    let mut inputs = Vec::new();
    if let Err(error) = receive_demo_uploads(&mut multipart, &intake_dir, &mut inputs).await {
        remove_directory(&intake_dir).await;
        return Err(error);
    }
    if inputs.is_empty() {
        remove_directory(&intake_dir).await;
        return Err(ApiError::invalid(
            "upload requires at least one .dem or .zip file",
        ));
    }

    let prepared_task = tokio::task::spawn_blocking({
        let staging_dir = staging_dir.clone();
        move || prepare_upload_batch(&inputs, &staging_dir, true)
    })
    .await;
    remove_directory(&intake_dir).await;
    let prepared = match prepared_task {
        Ok(Ok(prepared)) => prepared,
        Ok(Err(error)) => {
            remove_directory(&staging_dir).await;
            state.events.publish("demo_import", "failed", None);
            return Err(ApiError::invalid(error));
        }
        Err(error) => {
            remove_directory(&staging_dir).await;
            state.events.publish("demo_import", "failed", None);
            return Err(ApiError::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                "upload_worker_failed",
                format!("Demo upload worker failed: {error}"),
            ));
        }
    };

    publish_prepared_batch(&state, prepared, &staging_dir, &final_dir, "upload").await
}

async fn import_local_bundle(state: &AppState, paths: Vec<String>) -> ApiResult<ScanResult> {
    if paths.len() > MAXIMUM_DEMO_UPLOAD_FILES {
        return Err(ApiError::invalid(format!(
            "a local archive batch may contain at most {MAXIMUM_DEMO_UPLOAD_FILES} files"
        )));
    }
    let mut inputs = Vec::with_capacity(paths.len());
    for raw in paths {
        let path = PathBuf::from(raw);
        if !path.is_absolute() || !is_upload_path(&path) {
            return Err(ApiError::invalid(
                "local archive imports require absolute .dem or .zip paths",
            ));
        }
        let metadata = tokio::fs::symlink_metadata(&path).await.map_err(|error| {
            ApiError::invalid(format!("unable to inspect {}: {error}", path.display()))
        })?;
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            return Err(ApiError::invalid(format!(
                "local import is not a regular file: {}",
                path.display()
            )));
        }
        inputs.push(path);
    }

    let upload_dir = state.data_dir().join("uploads").join("demos");
    tokio::fs::create_dir_all(&upload_dir).await?;
    let batch_id = Uuid::new_v4();
    let staging_dir = upload_dir.join(format!(".batch-{batch_id}.staging"));
    let final_dir = upload_dir.join(format!("batch-{batch_id}"));
    let prepared = tokio::task::spawn_blocking({
        let staging_dir = staging_dir.clone();
        move || prepare_upload_batch(&inputs, &staging_dir, false)
    })
    .await;
    let prepared = match prepared {
        Ok(Ok(prepared)) => prepared,
        Ok(Err(error)) => {
            remove_directory(&staging_dir).await;
            state.events.publish("demo_import", "failed", None);
            return Err(ApiError::invalid(error));
        }
        Err(error) => {
            remove_directory(&staging_dir).await;
            state.events.publish("demo_import", "failed", None);
            return Err(ApiError::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                "upload_worker_failed",
                format!("Local archive worker failed: {error}"),
            ));
        }
    };
    let Json(result) =
        publish_prepared_batch(state, prepared, &staging_dir, &final_dir, "local").await?;
    Ok(result)
}

async fn publish_prepared_batch(
    state: &AppState,
    prepared: PreparedUploadBatch,
    staging_dir: &Path,
    final_dir: &Path,
    source: &str,
) -> ApiResult<Json<ScanResult>> {
    if let Err(error) = tokio::fs::rename(staging_dir, final_dir).await {
        remove_directory(staging_dir).await;
        state.events.publish("demo_import", "failed", None);
        return Err(error.into());
    }
    let records = match prepared
        .demos
        .iter()
        .map(|demo| {
            let final_path = final_dir.join(&demo.relative_path);
            record_from_validated(
                ValidatedDemo {
                    path: std::fs::canonicalize(&final_path)
                        .map_err(|error| format!("{}: {error}", final_path.display()))?,
                    size: demo.size,
                    sha256: demo.sha256.clone(),
                },
                source,
            )
        })
        .collect::<Result<Vec<_>, String>>()
    {
        Ok(records) => records,
        Err(error) => {
            remove_directory(final_dir).await;
            state.events.publish("demo_import", "failed", None);
            return Err(ApiError::invalid(error));
        }
    };
    let (inserted, duplicates) = match state.storage.put_unique_demos(records).await {
        Ok(result) => result,
        Err(error) => {
            remove_directory(final_dir).await;
            state.events.publish("demo_import", "failed", None);
            return Err(error.into());
        }
    };
    let mut recovered = Vec::new();
    let mut skipped_duplicates = 0_u64;
    for duplicate in duplicates {
        let Some(hash) = duplicate.content_sha256.clone() else {
            return Err(ApiError::invalid(
                "validated upload lost its content fingerprint",
            ));
        };
        let owner = state
            .storage
            .get_demo_by_hash(hash)
            .await?
            .ok_or_else(|| ApiError::not_found("cataloged Demo"))?;
        if demo_file_matches_catalog(&owner).await {
            remove_uploaded_paths(std::slice::from_ref(&duplicate.path)).await;
            skipped_duplicates = skipped_duplicates.saturating_add(1);
        } else {
            let demo = recover_verified_demo_copy(&state.storage, owner, duplicate)
                .await?
                .ok_or_else(|| ApiError::not_found("cataloged Demo"))?;
            recovered.push(demo);
        }
    }
    if inserted.is_empty() && recovered.is_empty() {
        remove_directory(final_dir).await;
    }
    for demo in inserted.iter().chain(&recovered) {
        state.events.publish("demo", "changed", Some(demo.id));
    }
    state.events.publish("demo_import", "completed", None);
    Ok(Json(ScanResult {
        discovered: prepared.discovered,
        imported: inserted.len() as u64,
        updated: recovered.len() as u64,
        skipped: prepared.skipped.saturating_add(skipped_duplicates),
        errors: Vec::new(),
    }))
}

async fn receive_demo_uploads(
    multipart: &mut axum::extract::Multipart,
    upload_dir: &Path,
    paths: &mut Vec<PathBuf>,
) -> ApiResult<()> {
    let mut uploaded_bytes = 0_u64;
    while let Some(mut field) = multipart
        .next_field()
        .await
        .map_err(|error| multipart_error(&error))?
    {
        if field.name() != Some("files") {
            continue;
        }
        if paths.len() >= MAXIMUM_DEMO_UPLOAD_FILES {
            return Err(ApiError::invalid(format!(
                "a demo upload may contain at most {MAXIMUM_DEMO_UPLOAD_FILES} files"
            )));
        }
        let Some(file_name) = field.file_name().and_then(safe_file_name) else {
            continue;
        };
        if !is_upload_path(Path::new(&file_name)) {
            return Err(ApiError::invalid(format!(
                "unsupported upload file: {file_name}; expected .dem or .zip"
            )));
        }
        let item_directory = upload_dir.join(format!("item-{}", paths.len()));
        tokio::fs::create_dir(&item_directory).await?;
        let destination = item_directory.join(file_name);
        let remaining = MAXIMUM_DEMO_UPLOAD_BATCH_BYTES.saturating_sub(uploaded_bytes);
        if remaining == 0 {
            return Err(ApiError::invalid(format!(
                "demo upload exceeds the {MAXIMUM_DEMO_UPLOAD_BATCH_BYTES} byte batch limit"
            )));
        }
        let written = persist_multipart_field(&mut field, &destination, remaining).await?;
        uploaded_bytes = uploaded_bytes.saturating_add(written);
        paths.push(destination);
    }
    Ok(())
}

#[derive(Debug)]
struct PreparedUploadDemo {
    relative_path: PathBuf,
    size: u64,
    sha256: String,
}

#[derive(Debug)]
struct PreparedUploadBatch {
    demos: Vec<PreparedUploadDemo>,
    discovered: u64,
    skipped: u64,
}

fn prepare_upload_batch(
    inputs: &[PathBuf],
    staging_dir: &Path,
    move_direct_files: bool,
) -> Result<PreparedUploadBatch, String> {
    std::fs::create_dir(staging_dir).map_err(|error| error.to_string())?;
    let cancellation = ParseCancellation::default();
    let demo_limits = ValidationLimits::default();
    let mut expanded_bytes = 0_u64;
    let mut validated = Vec::new();
    for (index, input) in inputs.iter().enumerate() {
        let remaining_bytes = MAXIMUM_EXPANDED_UPLOAD_BYTES.saturating_sub(expanded_bytes);
        let remaining_demos = MAXIMUM_EXPANDED_UPLOAD_DEMOS.saturating_sub(validated.len());
        if remaining_bytes == 0 || remaining_demos == 0 {
            return Err("expanded upload exhausted its batch limits".to_owned());
        }
        if is_zip_path(input) {
            let destination = staging_dir.join(format!("archive-{index}"));
            let report = extract_demo_zip_atomic(
                input,
                &destination,
                ArchiveLimits {
                    maximum_demo_files: remaining_demos,
                    maximum_expanded_bytes: remaining_bytes,
                    ..ArchiveLimits::default()
                },
                demo_limits,
                &cancellation,
            )
            .map_err(|error| format!("{}: {error}", input.display()))?;
            expanded_bytes = expanded_bytes
                .checked_add(report.expanded_bytes)
                .ok_or_else(|| "expanded upload size overflowed".to_owned())?;
            validated.extend(report.demos);
        } else {
            let file_name = input
                .file_name()
                .ok_or_else(|| format!("{} has no file name", input.display()))?;
            let destination_dir = staging_dir.join(format!("file-{index}"));
            std::fs::create_dir(&destination_dir).map_err(|error| error.to_string())?;
            let destination = destination_dir.join(file_name);
            let input_size = std::fs::metadata(input)
                .map_err(|error| error.to_string())?
                .len();
            if input_size > remaining_bytes {
                return Err(format!(
                    "expanded upload exceeds the {MAXIMUM_EXPANDED_UPLOAD_BYTES} byte batch limit"
                ));
            }
            if move_direct_files {
                std::fs::rename(input, &destination).map_err(|error| error.to_string())?;
            } else {
                std::fs::copy(input, &destination).map_err(|error| error.to_string())?;
            }
            let demo = validate_demo(&destination, demo_limits, &cancellation)
                .map_err(|error| format!("{}: {error}", destination.display()))?;
            expanded_bytes = expanded_bytes
                .checked_add(demo.size)
                .ok_or_else(|| "expanded upload size overflowed".to_owned())?;
            validated.push(demo);
        }
        if expanded_bytes > MAXIMUM_EXPANDED_UPLOAD_BYTES {
            return Err(format!(
                "expanded upload exceeds the {MAXIMUM_EXPANDED_UPLOAD_BYTES} byte batch limit"
            ));
        }
        if validated.len() > MAXIMUM_EXPANDED_UPLOAD_DEMOS {
            return Err(format!(
                "expanded upload contains more than {MAXIMUM_EXPANDED_UPLOAD_DEMOS} demos"
            ));
        }
    }

    let discovered = validated.len() as u64;
    let mut seen_hashes = std::collections::HashSet::new();
    let mut demos = Vec::with_capacity(validated.len());
    let mut skipped = 0_u64;
    for demo in validated {
        let relative_path = demo
            .path
            .strip_prefix(staging_dir)
            .map_err(|_| "prepared demo escaped the upload staging directory".to_owned())?
            .to_path_buf();
        if seen_hashes.insert(demo.sha256.clone()) {
            demos.push(PreparedUploadDemo {
                relative_path,
                size: demo.size,
                sha256: demo.sha256,
            });
        } else {
            std::fs::remove_file(&demo.path).map_err(|error| error.to_string())?;
            skipped = skipped.saturating_add(1);
        }
    }
    Ok(PreparedUploadBatch {
        demos,
        discovered,
        skipped,
    })
}

async fn remove_directory(path: &Path) {
    match tokio::fs::remove_dir_all(path).await {
        Err(error) if error.kind() != std::io::ErrorKind::NotFound => {
            tracing::warn!(%error, path = %path.display(), "unable to remove upload directory");
        }
        _ => {}
    }
}

async fn remove_uploaded_paths(paths: &[String]) {
    for path in paths {
        match tokio::fs::remove_file(path).await {
            Err(error) if error.kind() != std::io::ErrorKind::NotFound => {
                tracing::warn!(%error, %path, "unable to remove rolled-back demo upload");
            }
            _ => {}
        }
    }
}

async fn import_candidates(
    state: &AppState,
    paths: Vec<String>,
    source: &str,
) -> ApiResult<ScanResult> {
    let mut result = ScanResult {
        discovered: paths.len() as u64,
        imported: 0,
        updated: 0,
        skipped: 0,
        errors: Vec::new(),
    };
    for path in paths {
        match build_demo_record(&path, source).await {
            Ok(mut record) => {
                if let Some(existing) = state.storage.get_demo_by_path(record.path.clone()).await? {
                    let content_changed = existing.file_size != record.file_size
                        || existing
                            .content_sha256
                            .as_ref()
                            .is_some_and(|hash| record.content_sha256.as_ref() != Some(hash));
                    record.id = existing.id;
                    record.created_at = existing.created_at;
                    record.display_name = existing.display_name;
                    record.remark = existing.remark;
                    if content_changed {
                        record.status = DemoStatus::Discovered;
                    } else {
                        record.map_name = existing.map_name;
                        record.match_date = existing.match_date;
                        record.duration_seconds = existing.duration_seconds;
                        record.total_rounds = existing.total_rounds;
                        record.team_a_name = existing.team_a_name;
                        record.team_b_name = existing.team_b_name;
                        record.team_a_score = existing.team_a_score;
                        record.team_b_score = existing.team_b_score;
                        record.player_names = existing.player_names;
                        record.status = if existing.status == DemoStatus::Missing {
                            DemoStatus::Discovered
                        } else {
                            existing.status
                        };
                    }
                    if content_changed {
                        state.storage.replace_demo_content(record.clone()).await?;
                    } else {
                        state.storage.put_demo(record.clone()).await?;
                    }
                    result.updated += 1;
                } else {
                    let outcome = state
                        .storage
                        .put_content_addressed_demo(record.clone())
                        .await?;
                    if outcome.was_inserted() {
                        result.imported += 1;
                    } else if outcome.demo().path == record.path {
                        record = outcome.into_demo();
                        result.updated += 1;
                    } else {
                        let existing = outcome.into_demo();
                        if demo_file_matches_catalog(&existing).await {
                            if source == "upload" {
                                remove_uploaded_paths(std::slice::from_ref(&path)).await;
                            }
                            result.skipped += 1;
                            continue;
                        }
                        record = recover_verified_demo_copy(&state.storage, existing, record)
                            .await?
                            .ok_or_else(|| ApiError::not_found("cataloged Demo"))?;
                        result.updated += 1;
                    }
                }
                state.events.publish("demo", "changed", Some(record.id));
            }
            Err(error) => {
                if source == "upload" {
                    match tokio::fs::remove_file(&path).await {
                        Err(cleanup_error)
                            if cleanup_error.kind() != std::io::ErrorKind::NotFound =>
                        {
                            tracing::warn!(
                                %cleanup_error,
                                %path,
                                "unable to remove rejected demo upload"
                            );
                        }
                        _ => {}
                    }
                }
                result.skipped += 1;
                result.errors.push(format!("{path}: {error}"));
            }
        }
    }
    Ok(result)
}

async fn demo_file_matches_catalog(demo: &DemoRecord) -> bool {
    if demo.status == DemoStatus::Missing {
        return false;
    }
    let Some(expected_hash) = demo.content_sha256.clone() else {
        return false;
    };
    let expected_size = demo.file_size;
    let path = PathBuf::from(&demo.path);
    tokio::task::spawn_blocking(move || {
        validate_demo(
            &path,
            ValidationLimits::default(),
            &ParseCancellation::default(),
        )
        .is_ok_and(|validated| validated.size == expected_size && validated.sha256 == expected_hash)
    })
    .await
    .unwrap_or(false)
}

async fn recover_verified_demo_copy(
    storage: &vibe_cs_storage::Storage,
    existing: DemoRecord,
    incoming: DemoRecord,
) -> Result<Option<DemoRecord>, vibe_cs_storage::StorageError> {
    storage
        .recover_content_addressed_demo(DemoContentRecovery {
            expected: DemoContentIdentity {
                id: existing.id,
                path: existing.path,
                status: existing.status,
                content_sha256: existing.content_sha256.unwrap_or_default(),
                file_size: existing.file_size,
            },
            verified_path: incoming.path,
            verified_file_name: incoming.file_name,
            verified_size: incoming.file_size,
            verified_sha256: incoming.content_sha256.unwrap_or_default(),
        })
        .await
}

async fn reconcile_missing_demos(state: &AppState, roots: &[String]) -> ApiResult<u64> {
    let scopes = roots
        .iter()
        .map(PathBuf::from)
        .filter_map(|requested| {
            if requested.is_file() {
                std::fs::canonicalize(requested).ok().map(ScanScope::File)
            } else if requested.is_dir() {
                std::fs::canonicalize(requested)
                    .ok()
                    .map(ScanScope::Directory)
            } else if is_demo_path(&requested) {
                Some(ScanScope::File(requested))
            } else {
                None
            }
        })
        .collect::<Vec<_>>();
    if scopes.is_empty() {
        return Ok(0);
    }

    let mut demos = Vec::new();
    let mut page_number = 1;
    loop {
        let page = state
            .storage
            .list_demos(DemoQuery {
                source: Some("watch".to_owned()),
                page: Some(page_number),
                page_size: Some(200),
                ..DemoQuery::default()
            })
            .await?;
        if page.items.is_empty() {
            break;
        }
        demos.extend(page.items);
        if u64::from(page_number) * u64::from(page.page_size) >= page.total {
            break;
        }
        page_number = page_number.saturating_add(1);
    }

    let mut changed = 0_u64;
    for demo in demos {
        if demo.status == DemoStatus::Missing {
            continue;
        }
        let path = Path::new(&demo.path);
        if scopes.iter().any(|scope| scope.contains(path)) {
            match tokio::fs::try_exists(path).await {
                Ok(false) => {
                    state
                        .storage
                        .set_demo_status(demo.id, DemoStatus::Missing)
                        .await?;
                    state.events.publish("demo", "missing", Some(demo.id));
                    changed = changed.saturating_add(1);
                }
                Ok(true) => {}
                Err(error) => {
                    tracing::warn!(%error, path = %path.display(), "unable to check demo presence");
                }
            }
        }
    }
    Ok(changed)
}

enum ScanScope {
    File(PathBuf),
    Directory(PathBuf),
}

impl ScanScope {
    fn contains(&self, path: &Path) -> bool {
        match self {
            Self::File(file) => path == file,
            Self::Directory(directory) => path.starts_with(directory),
        }
    }
}

async fn build_demo_record(path: &str, source: &str) -> Result<DemoRecord, String> {
    let path = tokio::fs::canonicalize(path)
        .await
        .map_err(|error| error.to_string())?;
    let validation_path = path.clone();
    let validated = tokio::task::spawn_blocking(move || {
        validate_demo(
            &validation_path,
            ValidationLimits::default(),
            &ParseCancellation::default(),
        )
    })
    .await
    .map_err(|error| format!("demo validation task failed: {error}"))?
    .map_err(|error| error.to_string())?;
    record_from_validated(validated, source)
}

fn record_from_validated(validated: ValidatedDemo, source: &str) -> Result<DemoRecord, String> {
    let file_name = validated
        .path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "file name is not valid UTF-8".to_owned())?
        .to_owned();
    let display_name = validated
        .path
        .file_stem()
        .and_then(|name| name.to_str())
        .unwrap_or(&file_name)
        .to_owned();
    let now = Utc::now();
    Ok(DemoRecord {
        id: Uuid::new_v4(),
        path: validated.path.to_string_lossy().into_owned(),
        file_name,
        display_name,
        source: source.to_owned(),
        status: DemoStatus::Discovered,
        map_name: None,
        match_date: None,
        duration_seconds: None,
        total_rounds: None,
        team_a_name: None,
        team_b_name: None,
        team_a_score: None,
        team_b_score: None,
        player_names: Vec::new(),
        remark: String::new(),
        content_sha256: Some(validated.sha256),
        file_size: validated.size,
        created_at: now,
        updated_at: now,
    })
}

fn discover_demos(roots: &[String], recursive: bool) -> (Vec<String>, Vec<String>) {
    const MAXIMUM_DISCOVERED_DEMOS: usize = 10_000;
    let mut paths = Vec::new();
    let mut errors = Vec::new();
    for root in roots {
        if paths.len() >= MAXIMUM_DISCOVERED_DEMOS {
            errors.push(format!(
                "discovery stopped after {MAXIMUM_DISCOVERED_DEMOS} demo files"
            ));
            break;
        }
        match vibe_cs_demo::discover_demos(
            root,
            vibe_cs_demo::DiscoveryOptions {
                recursive,
                maximum_files: MAXIMUM_DISCOVERED_DEMOS - paths.len(),
            },
        ) {
            Ok(report) => {
                paths.extend(
                    report
                        .demos
                        .into_iter()
                        .map(|path| path.to_string_lossy().into_owned()),
                );
                errors.extend(
                    report
                        .errors
                        .into_iter()
                        .map(|error| format!("{root}: {error}")),
                );
            }
            Err(error) => {
                errors.push(format!("{root}: {error}"));
            }
        }
    }
    paths.sort_unstable();
    paths.dedup();
    (paths, errors)
}

fn is_demo_path(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("dem"))
}

fn is_zip_path(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("zip"))
}

fn is_upload_path(path: &Path) -> bool {
    is_demo_path(path) || is_zip_path(path)
}

fn safe_file_name(file_name: &str) -> Option<String> {
    file_name
        .rsplit(['/', '\\'])
        .next()
        .filter(|name| {
            !name.is_empty()
                && !matches!(*name, "." | "..")
                && !name.contains(':')
                && !name.chars().any(char::is_control)
        })
        .map(ToOwned::to_owned)
}

async fn get_analysis(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
) -> ApiResult<Json<MatchAnalysis>> {
    let id = parse_id(&id)?;
    state
        .storage
        .get_analysis(id)
        .await?
        .map(Json)
        .ok_or_else(|| ApiError::not_found("analysis"))
}

async fn get_replay_binary(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
) -> ApiResult<Response<Body>> {
    let demo = get_demo_record(&state, &id).await?;
    let payload = state.analysis.replay(demo).await?;
    let bytes = encode_binary_replay(&payload)?;
    Response::builder()
        .header(header::CONTENT_TYPE, "application/vnd.vibe-cs.replay")
        .header(header::CONTENT_LENGTH, bytes.len())
        .header(header::CACHE_CONTROL, "private, no-store")
        .body(Body::from(bytes))
        .map_err(|error| {
            ApiError::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                "response_error",
                error.to_string(),
            )
        })
}

struct ReplayEncoder {
    bytes: Vec<u8>,
}

impl ReplayEncoder {
    fn push(&mut self, value: &[u8]) -> ApiResult<()> {
        let length = self
            .bytes
            .len()
            .checked_add(value.len())
            .ok_or_else(|| ApiError::invalid("binary replay length overflow"))?;
        if length > MAXIMUM_BINARY_REPLAY_BYTES {
            return Err(ApiError::new(
                StatusCode::PAYLOAD_TOO_LARGE,
                "replay_too_large",
                "binary replay exceeds the 128 MiB response limit",
            ));
        }
        self.bytes.extend_from_slice(value);
        Ok(())
    }

    fn u8(&mut self, value: u8) -> ApiResult<()> {
        self.push(&[value])
    }
    fn u16(&mut self, value: u16) -> ApiResult<()> {
        self.push(&value.to_le_bytes())
    }
    fn u32(&mut self, value: u32) -> ApiResult<()> {
        self.push(&value.to_le_bytes())
    }
    fn u64(&mut self, value: u64) -> ApiResult<()> {
        self.push(&value.to_le_bytes())
    }
    fn f64(&mut self, value: f64) -> ApiResult<()> {
        self.push(&value.to_le_bytes())
    }
    fn finite_f64(&mut self, value: f64) -> ApiResult<()> {
        if !value.is_finite() {
            return Err(ApiError::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                "invalid_replay",
                "replay contains a non-finite numeric field",
            ));
        }
        self.f64(value)
    }
    fn text(&mut self, value: &str) -> ApiResult<()> {
        let length = u16::try_from(value.len())
            .map_err(|_| ApiError::invalid("binary replay text field is too long"))?;
        self.u16(length)?;
        self.push(value.as_bytes())
    }
    fn optional_text(&mut self, value: Option<&str>) -> ApiResult<()> {
        if let Some(value) = value {
            self.text(value)
        } else {
            self.u16(u16::MAX)
        }
    }
}

fn encode_binary_replay(payload: &crate::ReplayPayload) -> ApiResult<Vec<u8>> {
    if payload.frames.len() > MAXIMUM_REPLAY_FRAMES
        || payload.fidelity.frame_count != u64::try_from(payload.frames.len()).unwrap_or(u64::MAX)
        || !payload.fidelity.tick_rate.is_finite()
        || !(8.0..=1024.0).contains(&payload.fidelity.tick_rate)
        || payload.fidelity.positioned_event_count
            > u64::try_from(MAXIMUM_REPLAY_EFFECT_RECORDS).unwrap_or(u64::MAX)
        || payload.frames.first().map_or(0, |frame| frame.tick) != payload.fidelity.start_tick
        || payload.frames.last().map_or(0, |frame| frame.tick) != payload.fidelity.end_tick
    {
        return Err(ApiError::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            "invalid_replay",
            "replay fidelity, frame bounds, or strictly increasing ticks are invalid",
        ));
    }
    let mut player_records = 0_usize;
    let mut effect_records = 0_usize;
    let mut previous_tick = None;
    for frame in &payload.frames {
        if previous_tick.is_some_and(|tick| frame.tick <= tick) {
            return Err(ApiError::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                "invalid_replay",
                "replay ticks must be strictly increasing",
            ));
        }
        previous_tick = Some(frame.tick);
        if frame.players.len() > MAXIMUM_REPLAY_PLAYERS_PER_FRAME
            || frame.projectiles.len() > MAXIMUM_REPLAY_EFFECTS_PER_FRAME
        {
            return Err(ApiError::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                "invalid_replay",
                "replay frame exceeds player or effect limits",
            ));
        }
        player_records = player_records
            .checked_add(frame.players.len())
            .ok_or_else(|| {
                ApiError::new(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "invalid_replay",
                    "replay player record count overflow",
                )
            })?;
        if player_records > MAXIMUM_REPLAY_PLAYER_RECORDS {
            return Err(ApiError::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                "invalid_replay",
                "replay exceeds the aggregate player record limit",
            ));
        }
        effect_records = effect_records
            .checked_add(frame.projectiles.len())
            .ok_or_else(|| {
                ApiError::new(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "invalid_replay",
                    "replay effect record count overflow",
                )
            })?;
        if effect_records > MAXIMUM_REPLAY_EFFECT_RECORDS {
            return Err(ApiError::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                "invalid_replay",
                "replay exceeds the aggregate effect record limit",
            ));
        }
    }
    let mut output = ReplayEncoder { bytes: Vec::new() };
    output.push(b"ARPL")?;
    let cache = serde_json::to_vec(&payload.cache).map_err(|error| {
        ApiError::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            "replay_encode",
            error.to_string(),
        )
    })?;
    output.u32(
        u32::try_from(cache.len()).map_err(|_| ApiError::invalid("cache metadata is too large"))?,
    )?;
    output.push(&cache)?;
    let fidelity = serde_json::to_vec(&payload.fidelity).map_err(|error| {
        ApiError::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            "replay_encode",
            error.to_string(),
        )
    })?;
    output.u32(
        u32::try_from(fidelity.len())
            .map_err(|_| ApiError::invalid("replay fidelity metadata is too large"))?,
    )?;
    output.push(&fidelity)?;
    output.u32(
        u32::try_from(payload.frames.len())
            .map_err(|_| ApiError::invalid("too many replay frames"))?,
    )?;
    for frame in &payload.frames {
        output.u64(frame.tick)?;
        output.u16(
            u16::try_from(frame.players.len())
                .map_err(|_| ApiError::invalid("too many replay players"))?,
        )?;
        for player in &frame.players {
            if !matches!(player.team.as_str(), "A" | "B") {
                return Err(ApiError::new(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "invalid_replay",
                    "replay player team is not a canonical Team A/B identity",
                ));
            }
            output.text(&player.id)?;
            output.text(&player.name)?;
            output.text(&player.team)?;
            for coordinate in player.position {
                output.finite_f64(coordinate)?;
            }
            output.finite_f64(player.yaw)?;
            output.u32(player.health)?;
            output.u32(player.armor)?;
            output.u8(u8::from(player.alive))?;
            output.text(&player.weapon)?;
            let input = player.input.map_or(u16::MAX, |input| {
                u16::from(input.forward)
                    | (u16::from(input.left) << 1)
                    | (u16::from(input.backward) << 2)
                    | (u16::from(input.right) << 3)
                    | (u16::from(input.jump) << 4)
                    | (u16::from(input.crouch) << 5)
                    | (u16::from(input.walk) << 6)
                    | (u16::from(input.reload) << 7)
                    | (u16::from(input.fire) << 8)
                    | (u16::from(input.secondary_fire) << 9)
            });
            output.u16(input)?;
        }
        output.u16(
            u16::try_from(frame.projectiles.len())
                .map_err(|_| ApiError::invalid("too many replay effects"))?,
        )?;
        for effect in &frame.projectiles {
            output.text(&effect.kind)?;
            for coordinate in effect.position {
                output.finite_f64(coordinate)?;
            }
            output.u8(u8::from(effect.active))?;
            if let Some(radius) = effect.radius {
                output.finite_f64(radius)?;
            } else {
                output.f64(f64::NAN)?;
            }
            output.u8(u8::from(effect.masks_vision))?;
        }
        output.u8(u8::from(frame.bomb.is_some()))?;
        if let Some(bomb) = &frame.bomb {
            for coordinate in bomb.position {
                output.finite_f64(coordinate)?;
            }
            output.text(&bomb.state)?;
            output.optional_text(bomb.carrier_id.as_deref())?;
        }
    }
    Ok(output.bytes)
}

async fn get_replay_cache_status(
    State(state): State<AppState>,
) -> ApiResult<Json<crate::ReplayCacheStatus>> {
    Ok(Json(state.analysis.replay_cache_status().await?))
}

async fn clear_replay_cache(
    State(state): State<AppState>,
) -> ApiResult<Json<crate::ReplayCacheCleanup>> {
    Ok(Json(state.analysis.clear_replay_cache().await?))
}

async fn get_heatmap(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
) -> ApiResult<Json<Vec<vibe_cs_domain::HeatPoint>>> {
    let demo = get_demo_record(&state, &id).await?;
    Ok(Json(state.analysis.heatmap(demo).await?))
}

#[derive(Debug, Default, Deserialize, TS)]
#[serde(deny_unknown_fields)]
#[ts(export)]
struct DemoPlaybackRequest {
    #[ts(optional)]
    start_tick: Option<u64>,
    #[ts(optional)]
    player: Option<String>,
    #[ts(optional)]
    timescale: Option<f64>,
}

async fn preflight_demo(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
    ApiJson(request): ApiJson<DemoPlaybackRequest>,
) -> ApiResult<Json<serde_json::Value>> {
    let demo = get_demo_record(&state, &id).await?;
    ensure_demo_playable(&demo)?;
    Ok(Json(
        state
            .integrations
            .request("demo_playback_preflight", playback_request(&demo, &request))
            .await?,
    ))
}

async fn play_demo(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
    ApiJson(request): ApiJson<DemoPlaybackRequest>,
) -> ApiResult<Json<serde_json::Value>> {
    let mut reservation = state.reserve_playback_session().await?;
    let session_token = reservation.token();
    let demo = get_demo_record(&state, &id).await?;
    ensure_demo_playable(&demo)?;
    let mut launch_request = playback_request(&demo, &request);
    launch_request
        .as_object_mut()
        .expect("playback request is always an object")
        .insert(
            "session_token".to_owned(),
            serde_json::Value::String(session_token.to_string()),
        );
    reservation.begin_runtime_launch();
    let response = state
        .integrations
        .request("demo_play", launch_request)
        .await?;
    if !reservation.mark_active().await {
        return Err(ApiError::new(
            StatusCode::CONFLICT,
            "playback_session_changed",
            "Playback launched after its session changed and is being stopped",
        ));
    }
    Ok(Json(response))
}

#[derive(Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
struct StopPlaybackRequest {}

async fn stop_playback(
    State(state): State<AppState>,
    ApiJson(_request): ApiJson<StopPlaybackRequest>,
) -> ApiResult<Json<serde_json::Value>> {
    let reservation = state.begin_playback_stop().await?;
    let token = reservation.token();
    let response = state
        .integrations
        .request("demo_stop", json!({ "session_token": token }))
        .await?;
    if response.get("stopped").and_then(serde_json::Value::as_bool) != Some(true) {
        return Err(ApiError::new(
            StatusCode::BAD_GATEWAY,
            "playback_stop_unverified",
            "The runtime did not confirm that demo playback stopped",
        ));
    }
    reservation.complete().await;
    Ok(Json(response))
}

fn ensure_demo_playable(demo: &DemoRecord) -> ApiResult<()> {
    if demo.status == DemoStatus::Missing {
        Err(ApiError::not_found("demo file"))
    } else {
        Ok(())
    }
}

fn playback_request(demo: &DemoRecord, request: &DemoPlaybackRequest) -> serde_json::Value {
    json!({
        "demo_id": demo.id,
        "path": demo.path,
        "expected_sha256": demo.content_sha256,
        "start_tick": request.start_tick,
        "player": request.player,
        "timescale": request.timescale,
    })
}

async fn get_demo_record(state: &AppState, id: &str) -> ApiResult<DemoRecord> {
    state
        .storage
        .get_demo(parse_id(id)?)
        .await?
        .ok_or_else(|| ApiError::not_found("demo"))
}

fn parse_id(id: &str) -> ApiResult<Uuid> {
    Uuid::parse_str(id).map_err(|_| ApiError::invalid("id must be a UUID"))
}

fn parse_status(status: &str) -> ApiResult<DemoStatus> {
    match status {
        "discovered" => Ok(DemoStatus::Discovered),
        "indexing" => Ok(DemoStatus::Indexing),
        "analyzing" => Ok(DemoStatus::Analyzing),
        "ready" => Ok(DemoStatus::Ready),
        "failed" => Ok(DemoStatus::Failed),
        "missing" => Ok(DemoStatus::Missing),
        _ => Err(ApiError::invalid("unknown demo status")),
    }
}

fn parse_demo_sort(sort: Option<&str>) -> ApiResult<Option<DemoSort>> {
    sort.map(|sort| match sort {
        "updated_desc" => Ok(DemoSort::UpdatedDesc),
        "updated_asc" => Ok(DemoSort::UpdatedAsc),
        "file_asc" => Ok(DemoSort::FileAsc),
        "file_desc" => Ok(DemoSort::FileDesc),
        "status_asc" => Ok(DemoSort::StatusAsc),
        "status_desc" => Ok(DemoSort::StatusDesc),
        "map_asc" => Ok(DemoSort::MapAsc),
        "map_desc" => Ok(DemoSort::MapDesc),
        "score_asc" => Ok(DemoSort::ScoreAsc),
        "score_desc" => Ok(DemoSort::ScoreDesc),
        "duration_asc" => Ok(DemoSort::DurationAsc),
        "duration_desc" => Ok(DemoSort::DurationDesc),
        "rounds_asc" => Ok(DemoSort::RoundsAsc),
        "rounds_desc" => Ok(DemoSort::RoundsDesc),
        _ => Err(ApiError::invalid("unknown demo sort")),
    })
    .transpose()
}

fn validate_demo_window(page: Option<u32>, page_size: Option<u32>) -> ApiResult<()> {
    if page.is_some_and(|page| !(1..=DEMO_MAX_PAGE).contains(&page)) {
        return Err(ApiError::invalid(format!(
            "demo page must be between 1 and {DEMO_MAX_PAGE}"
        )));
    }
    if page_size.is_some_and(|page_size| !(1..=DEMO_MAX_PAGE_SIZE).contains(&page_size)) {
        return Err(ApiError::invalid(format!(
            "demo page_size must be between 1 and {DEMO_MAX_PAGE_SIZE}"
        )));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::{
        fmt::Write as _,
        io::Write as _,
        sync::{
            Arc,
            atomic::{AtomicUsize, Ordering},
        },
    };

    use async_trait::async_trait;
    use axum::{
        body::Body,
        extract::{FromRequest, Multipart},
        http::{Request, header},
        response::IntoResponse,
    };

    use super::*;

    async fn persist_completed_analysis(
        storage: &vibe_cs_storage::Storage,
        analysis: MatchAnalysis,
    ) {
        let demo = storage.get_demo(analysis.demo_id).await.unwrap().unwrap();
        let fingerprint = vibe_cs_domain::AnalysisInputFingerprint {
            sha256: demo.content_sha256.unwrap(),
            size: demo.file_size,
        };
        storage
            .set_demo_status(demo.id, DemoStatus::Discovered)
            .await
            .unwrap();
        let run_id = storage.start_analysis_run(demo.id).await.unwrap().run.id;
        storage
            .bind_analysis_run_input(run_id, fingerprint.clone())
            .await
            .unwrap();
        storage.mark_analysis_parser_started(run_id).await.unwrap();
        storage
            .mark_analysis_input_revalidation_started(run_id)
            .await
            .unwrap();
        storage
            .mark_analysis_projection_started(run_id)
            .await
            .unwrap();
        storage
            .complete_analysis_run(run_id, analysis, fingerprint)
            .await
            .unwrap();
    }

    #[test]
    fn binary_replay_has_the_current_bounded_envelope() {
        let payload = crate::ReplayPayload {
            frames: Vec::new(),
            fidelity: crate::ReplayFidelityMetadata {
                mode: crate::ReplayFidelityMode::EventSparse,
                tick_rate: 64.0,
                frame_count: 0,
                positioned_event_count: 0,
                start_tick: 0,
                end_tick: 0,
            },
            cache: crate::ReplayCacheMetadata {
                state: crate::ReplayCacheState::Bypassed,
                key: None,
                bytes: 0,
                generated_at: None,
                repaired: false,
                reason: Some("test".to_owned()),
            },
        };
        let encoded = encode_binary_replay(&payload).expect("encode replay");
        assert_eq!(&encoded[..4], b"ARPL");
        let cache_length = u32::from_le_bytes(encoded[4..8].try_into().unwrap()) as usize;
        let fidelity_length_offset = 8 + cache_length;
        let fidelity_length = u32::from_le_bytes(
            encoded[fidelity_length_offset..fidelity_length_offset + 4]
                .try_into()
                .unwrap(),
        ) as usize;
        let fidelity_offset = fidelity_length_offset + 4;
        let fidelity: crate::ReplayFidelityMetadata =
            serde_json::from_slice(&encoded[fidelity_offset..fidelity_offset + fidelity_length])
                .expect("fidelity metadata");
        assert_eq!(fidelity.mode, crate::ReplayFidelityMode::EventSparse);
        assert!((fidelity.tick_rate - 64.0).abs() < f64::EPSILON);
        assert!(encoded.len() < MAXIMUM_BINARY_REPLAY_BYTES);
    }

    #[test]
    fn binary_replay_rejects_duplicate_ticks_before_encoding() {
        let payload = crate::ReplayPayload {
            frames: vec![
                vibe_cs_domain::ReplayFrame {
                    tick: 7,
                    players: Vec::new(),
                    projectiles: Vec::new(),
                    bomb: None,
                },
                vibe_cs_domain::ReplayFrame {
                    tick: 7,
                    players: Vec::new(),
                    projectiles: Vec::new(),
                    bomb: None,
                },
            ],
            fidelity: crate::ReplayFidelityMetadata {
                mode: crate::ReplayFidelityMode::EventSparse,
                tick_rate: 64.0,
                frame_count: 2,
                positioned_event_count: 0,
                start_tick: 7,
                end_tick: 7,
            },
            cache: crate::ReplayCacheMetadata {
                state: crate::ReplayCacheState::Bypassed,
                key: None,
                bytes: 0,
                generated_at: None,
                repaired: false,
                reason: Some("test".to_owned()),
            },
        };

        let error = encode_binary_replay(&payload)
            .expect_err("duplicate ticks must be rejected before allocating the wire payload");

        assert!(error.to_string().contains("strictly increasing"));
    }

    #[test]
    fn binary_replay_rejects_more_than_two_hundred_thousand_player_records() {
        let player = vibe_cs_domain::ReplayPlayer {
            id: "1".to_owned(),
            name: "P".to_owned(),
            team: "A".to_owned(),
            position: [1.0, 2.0, 3.0],
            yaw: 0.0,
            health: 100,
            armor: 0,
            alive: true,
            weapon: String::new(),
            input: None,
        };
        let mut remaining = 200_001_usize;
        let mut frames = Vec::new();
        while remaining > 0 {
            let count = remaining.min(MAXIMUM_REPLAY_PLAYERS_PER_FRAME);
            frames.push(vibe_cs_domain::ReplayFrame {
                tick: u64::try_from(frames.len() + 1).unwrap(),
                players: vec![player.clone(); count],
                projectiles: Vec::new(),
                bomb: None,
            });
            remaining -= count;
        }
        let frame_count = u64::try_from(frames.len()).unwrap();
        let payload = crate::ReplayPayload {
            frames,
            fidelity: crate::ReplayFidelityMetadata {
                mode: crate::ReplayFidelityMode::EventSparse,
                tick_rate: 64.0,
                frame_count,
                positioned_event_count: 0,
                start_tick: 1,
                end_tick: frame_count,
            },
            cache: crate::ReplayCacheMetadata {
                state: crate::ReplayCacheState::Bypassed,
                key: None,
                bytes: 0,
                generated_at: None,
                repaired: false,
                reason: Some("test".to_owned()),
            },
        };

        assert!(
            encode_binary_replay(&payload).is_err(),
            "aggregate player records above the wire budget must be rejected"
        );
    }

    #[test]
    fn binary_replay_rejects_more_than_one_hundred_thousand_effect_records() {
        let effect = vibe_cs_domain::ReplayProjectile {
            kind: "smoke".to_owned(),
            position: [1.0, 2.0, 3.0],
            active: true,
            radius: Some(144.0),
            masks_vision: true,
        };
        let mut remaining = 100_001_usize;
        let mut frames = Vec::new();
        while remaining > 0 {
            let count = remaining.min(MAXIMUM_REPLAY_EFFECTS_PER_FRAME);
            frames.push(vibe_cs_domain::ReplayFrame {
                tick: u64::try_from(frames.len() + 1).unwrap(),
                players: Vec::new(),
                projectiles: vec![effect.clone(); count],
                bomb: None,
            });
            remaining -= count;
        }
        let frame_count = u64::try_from(frames.len()).unwrap();
        let payload = crate::ReplayPayload {
            frames,
            fidelity: crate::ReplayFidelityMetadata {
                mode: crate::ReplayFidelityMode::EventSparse,
                tick_rate: 64.0,
                frame_count,
                positioned_event_count: 0,
                start_tick: 1,
                end_tick: frame_count,
            },
            cache: crate::ReplayCacheMetadata {
                state: crate::ReplayCacheState::Bypassed,
                key: None,
                bytes: 0,
                generated_at: None,
                repaired: false,
                reason: Some("test".to_owned()),
            },
        };

        assert!(
            encode_binary_replay(&payload).is_err(),
            "aggregate effect records above the wire budget must be rejected"
        );
    }

    #[derive(Debug, Default)]
    struct EchoIntegrations;

    #[async_trait]
    impl crate::IntegrationPort for EchoIntegrations {
        async fn request(
            &self,
            capability: &str,
            request: serde_json::Value,
        ) -> Result<serde_json::Value, vibe_cs_domain::DomainError> {
            if capability == "demo_stop" {
                Ok(json!({
                    "stopped": true,
                    "process_id": 7,
                    "already_stopped": false,
                }))
            } else {
                Ok(json!({ "capability": capability, "request": request }))
            }
        }
    }

    #[derive(Debug, Default)]
    struct BlockingIntegrations {
        play_entered: tokio::sync::Notify,
        play_release: tokio::sync::Notify,
        stop_entered: tokio::sync::Notify,
        stop_release: tokio::sync::Notify,
    }

    #[derive(Debug, Default)]
    struct BlockingStopIntegrations {
        entered: tokio::sync::Notify,
        release: tokio::sync::Notify,
        completed: tokio::sync::Notify,
        calls: AtomicUsize,
    }

    #[async_trait]
    impl crate::IntegrationPort for BlockingStopIntegrations {
        async fn request(
            &self,
            capability: &str,
            request: serde_json::Value,
        ) -> Result<serde_json::Value, vibe_cs_domain::DomainError> {
            assert_eq!(capability, "demo_stop");
            self.calls.fetch_add(1, Ordering::SeqCst);
            assert!(
                request
                    .get("session_token")
                    .and_then(serde_json::Value::as_str)
                    .and_then(|value| Uuid::parse_str(value).ok())
                    .is_some()
            );
            self.entered.notify_one();
            self.release.notified().await;
            self.completed.notify_one();
            Ok(json!({
                "stopped": true,
                "process_id": 7,
                "already_stopped": false,
            }))
        }
    }

    #[async_trait]
    impl crate::IntegrationPort for BlockingIntegrations {
        async fn request(
            &self,
            capability: &str,
            request: serde_json::Value,
        ) -> Result<serde_json::Value, vibe_cs_domain::DomainError> {
            match capability {
                "demo_play" => {
                    self.play_entered.notify_one();
                    self.play_release.notified().await;
                    Ok(json!({ "capability": capability, "request": request }))
                }
                "demo_stop" => {
                    assert!(
                        request
                            .get("session_token")
                            .and_then(serde_json::Value::as_str)
                            .and_then(|value| Uuid::parse_str(value).ok())
                            .is_some()
                    );
                    self.stop_entered.notify_one();
                    self.stop_release.notified().await;
                    Ok(json!({
                        "stopped": true,
                        "process_id": 7,
                        "already_stopped": false,
                    }))
                }
                other => panic!("unexpected integration capability: {other}"),
            }
        }
    }

    fn demo_zip(entries: &[(&str, &[u8])]) -> Vec<u8> {
        let mut bytes = std::io::Cursor::new(Vec::new());
        {
            let mut writer = zip::ZipWriter::new(&mut bytes);
            for (name, content) in entries {
                writer
                    .start_file(*name, zip::write::SimpleFileOptions::default())
                    .expect("zip entry");
                writer.write_all(content).expect("zip content");
            }
            writer.finish().expect("finish zip");
        }
        bytes.into_inner()
    }

    async fn upload_multipart(file_name: &str, contents: &[u8]) -> Multipart {
        let boundary = "vibe-cs-upload-boundary";
        let mut body = format!(
            "--{boundary}\r\nContent-Disposition: form-data; name=\"files\"; filename=\"{file_name}\"\r\nContent-Type: application/octet-stream\r\n\r\n"
        )
        .into_bytes();
        body.extend_from_slice(contents);
        body.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());
        let request = Request::builder()
            .header(
                header::CONTENT_TYPE,
                format!("multipart/form-data; boundary={boundary}"),
            )
            .body(Body::from(body))
            .expect("request");
        Multipart::from_request(request, &())
            .await
            .expect("multipart")
    }

    #[test]
    fn demo_list_query_parses_exact_statuses_and_whitelisted_sorts() {
        assert!(
            serde_json::from_value::<DemoListQuery>(json!({ "map": "de_mirage" })).is_err(),
            "the retired map alias must not deserialize"
        );
        assert_eq!(
            parse_status("indexing").expect("indexing"),
            DemoStatus::Indexing
        );
        assert_eq!(
            parse_status("parsing")
                .expect_err("summary status alias must be rejected")
                .into_response()
                .status(),
            StatusCode::BAD_REQUEST
        );
        assert_eq!(
            parse_demo_sort(Some("map_desc")).expect("map sort"),
            Some(vibe_cs_domain::DemoSort::MapDesc)
        );
        for sort in [
            "updated_desc",
            "updated_asc",
            "file_asc",
            "file_desc",
            "status_asc",
            "status_desc",
            "map_asc",
            "map_desc",
            "score_asc",
            "score_desc",
            "duration_asc",
            "duration_desc",
            "rounds_asc",
            "rounds_desc",
        ] {
            assert!(
                parse_demo_sort(Some(sort))
                    .expect("canonical sort")
                    .is_some()
            );
        }
        assert_eq!(parse_demo_sort(None).expect("default sort"), None);
        assert_eq!(
            parse_demo_sort(Some("updated_at; DROP TABLE demos"))
                .expect_err("unknown sort must be rejected")
                .into_response()
                .status(),
            StatusCode::BAD_REQUEST
        );
        assert_eq!(
            parse_demo_sort(Some("newest"))
                .expect_err("retired sort alias must be rejected")
                .into_response()
                .status(),
            StatusCode::BAD_REQUEST
        );
        for (page, page_size) in [
            (Some(0), None),
            (Some(100_001), None),
            (None, Some(0)),
            (None, Some(201)),
        ] {
            assert_eq!(
                validate_demo_window(page, page_size)
                    .expect_err("invalid window must be rejected at the route boundary")
                    .into_response()
                    .status(),
                StatusCode::BAD_REQUEST
            );
        }
    }

    #[test]
    fn playback_request_rejects_unknown_control_fields() {
        assert!(
            serde_json::from_value::<DemoPlaybackRequest>(json!({
                "start_tick": 42,
                "console_command": "quit"
            }))
            .is_err()
        );
    }

    #[test]
    fn upload_file_name_drops_parent_components() {
        assert_eq!(
            safe_file_name("../unsafe/match.dem").as_deref(),
            Some("match.dem")
        );
        assert_eq!(
            safe_file_name(r"C:\unsafe\match.dem").as_deref(),
            Some("match.dem")
        );
        assert!(safe_file_name("../..").is_none());
    }

    #[tokio::test]
    async fn playback_preflight_forwards_the_indexed_content_identity() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let path = directory.path().join("playable.dem");
        std::fs::write(&path, b"PBDEMS2\0fixture!").expect("demo fixture");
        let mut demo = build_demo_record(&path.to_string_lossy(), "local")
            .await
            .expect("demo record");
        demo.status = DemoStatus::Ready;
        let expected_hash = demo.content_sha256.clone().expect("content hash");
        let demo_id = demo.id;
        let storage = vibe_cs_storage::Storage::open_in_memory()
            .await
            .expect("storage");
        storage.put_demo(demo).await.expect("persist demo");
        let state = AppState::new(storage, directory.path().join("data"))
            .with_integrations(Arc::new(EchoIntegrations));

        let Json(response) = preflight_demo(
            State(state),
            AxumPath(demo_id.to_string()),
            ApiJson(DemoPlaybackRequest {
                start_tick: Some(4_096),
                player: Some("Player One".to_owned()),
                timescale: Some(0.5),
            }),
        )
        .await
        .expect("preflight route");

        assert_eq!(response["capability"], "demo_playback_preflight");
        assert_eq!(response["request"]["demo_id"], demo_id.to_string());
        assert_eq!(response["request"]["expected_sha256"], expected_hash);
        assert_eq!(response["request"]["start_tick"], 4_096);
        assert_eq!(response["request"]["player"], "Player One");
        assert_eq!(response["request"]["timescale"], 0.5);
    }

    #[tokio::test]
    async fn playback_launch_is_rejected_while_recording_is_active() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let storage = vibe_cs_storage::Storage::open_in_memory()
            .await
            .expect("storage");
        let state = AppState::new(storage, directory.path().join("data"));
        *state.active_recording.lock().await = Some(Uuid::new_v4());

        let error = play_demo(
            State(state),
            AxumPath(Uuid::new_v4().to_string()),
            ApiJson(DemoPlaybackRequest::default()),
        )
        .await
        .expect_err("active recording must own the local game session");

        assert_eq!(error.into_response().status(), StatusCode::CONFLICT);
    }

    #[tokio::test]
    async fn playback_lookup_failure_releases_the_prelaunch_reservation() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let storage = vibe_cs_storage::Storage::open_in_memory()
            .await
            .expect("storage");
        let state = AppState::new(storage, directory.path().join("data"));

        let error = play_demo(
            State(state.clone()),
            AxumPath(Uuid::new_v4().to_string()),
            ApiJson(DemoPlaybackRequest::default()),
        )
        .await
        .expect_err("missing demo must fail before runtime launch");
        assert_eq!(error.into_response().status(), StatusCode::NOT_FOUND);

        tokio::time::timeout(std::time::Duration::from_secs(1), async {
            loop {
                if state.runtime_session_snapshot().await.0 == "idle" {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("prelaunch failure must release its session reservation");
        assert!(
            state
                .reserve_recording_session(Uuid::new_v4(), false)
                .await
                .is_ok()
        );
    }

    #[tokio::test]
    async fn playback_reservation_wins_a_concurrent_recording_race() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let path = directory.path().join("race.dem");
        std::fs::write(&path, b"PBDEMS2\0fixture!").expect("demo fixture");
        let mut demo = build_demo_record(&path.to_string_lossy(), "local")
            .await
            .expect("demo record");
        demo.status = DemoStatus::Ready;
        let demo_id = demo.id;
        let storage = vibe_cs_storage::Storage::open_in_memory()
            .await
            .expect("storage");
        storage.put_demo(demo).await.expect("persist demo");
        let blocking = Arc::new(BlockingIntegrations::default());
        let state = AppState::new(storage, directory.path().join("data"))
            .with_integrations(blocking.clone());
        let playback_state = state.clone();
        let playback = tokio::spawn(async move {
            play_demo(
                State(playback_state),
                AxumPath(demo_id.to_string()),
                ApiJson(DemoPlaybackRequest::default()),
            )
            .await
        });

        blocking.play_entered.notified().await;
        let error = state
            .reserve_recording_session(Uuid::new_v4(), false)
            .await
            .expect_err("playback must own the local game session before its await points");
        assert_eq!(error.into_response().status(), StatusCode::CONFLICT);
        blocking.play_release.notify_one();
        let _response = playback
            .await
            .expect("playback task")
            .expect("playback response");

        let error = state
            .reserve_recording_session(Uuid::new_v4(), false)
            .await
            .expect_err("the successful launch lease must remain reserved");
        assert_eq!(error.into_response().status(), StatusCode::CONFLICT);
    }

    #[tokio::test]
    async fn cancelled_playback_launch_is_stopped_before_the_session_is_released() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let path = directory.path().join("cancelled.dem");
        std::fs::write(&path, b"PBDEMS2\0fixture!").expect("demo fixture");
        let mut demo = build_demo_record(&path.to_string_lossy(), "local")
            .await
            .expect("demo record");
        demo.status = DemoStatus::Ready;
        let demo_id = demo.id;
        let storage = vibe_cs_storage::Storage::open_in_memory()
            .await
            .expect("storage");
        storage.put_demo(demo).await.expect("persist demo");
        let blocking = Arc::new(BlockingIntegrations::default());
        let state = AppState::new(storage, directory.path().join("data"))
            .with_integrations(blocking.clone());
        let playback_state = state.clone();
        let playback = tokio::spawn(async move {
            play_demo(
                State(playback_state),
                AxumPath(demo_id.to_string()),
                ApiJson(DemoPlaybackRequest::default()),
            )
            .await
        });

        blocking.play_entered.notified().await;
        playback.abort();
        assert!(
            playback
                .await
                .expect_err("the request task must be cancelled")
                .is_cancelled()
        );
        blocking.stop_entered.notified().await;
        assert_eq!(
            state.runtime_session_snapshot().await.0,
            "playback_stopping"
        );
        assert!(state.reserve_playback_session().await.is_err());
        assert!(
            state
                .reserve_recording_session(Uuid::new_v4(), false)
                .await
                .is_err()
        );

        blocking.stop_release.notify_one();
        tokio::time::timeout(std::time::Duration::from_secs(1), async {
            loop {
                if state.runtime_session_snapshot().await.0 == "idle" {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("cancel cleanup must release the stopped playback session");
    }

    #[tokio::test]
    async fn verified_stop_releases_only_the_active_playback_session() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let storage = vibe_cs_storage::Storage::open_in_memory()
            .await
            .expect("storage");
        let state = AppState::new(storage, directory.path().join("data"))
            .with_integrations(Arc::new(EchoIntegrations));
        assert!(
            state
                .reserve_playback_session()
                .await
                .expect("reservation")
                .mark_active()
                .await
        );

        let Json(response) = stop_playback(
            State(state.clone()),
            ApiJson(StopPlaybackRequest::default()),
        )
        .await
        .expect("verified stop");

        assert_eq!(response["stopped"], true);
        assert_eq!(state.runtime_session_snapshot().await.0, "idle");
        let error = stop_playback(State(state), ApiJson(StopPlaybackRequest::default()))
            .await
            .expect_err("a stale stop must not release a future session");
        assert_eq!(error.into_response().status(), StatusCode::CONFLICT);
    }

    #[tokio::test]
    async fn stop_is_serialized_and_cannot_claim_a_launching_session() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let storage = vibe_cs_storage::Storage::open_in_memory()
            .await
            .expect("storage");
        let blocking = Arc::new(BlockingStopIntegrations::default());
        let state = AppState::new(storage, directory.path().join("data"))
            .with_integrations(blocking.clone());
        let launching = state
            .reserve_playback_session()
            .await
            .expect("launching reservation");
        let error = stop_playback(
            State(state.clone()),
            ApiJson(StopPlaybackRequest::default()),
        )
        .await
        .expect_err("a launch without a process identity cannot be stopped");
        assert_eq!(error.into_response().status(), StatusCode::CONFLICT);
        assert!(launching.mark_active().await);

        let stop_state = state.clone();
        let stop = tokio::spawn(async move {
            stop_playback(State(stop_state), ApiJson(StopPlaybackRequest::default())).await
        });
        blocking.entered.notified().await;
        let error = stop_playback(
            State(state.clone()),
            ApiJson(StopPlaybackRequest::default()),
        )
        .await
        .expect_err("only one stop may own a playback token");
        assert_eq!(error.into_response().status(), StatusCode::CONFLICT);
        assert!(state.reserve_playback_session().await.is_err());
        assert!(
            state
                .reserve_recording_session(Uuid::new_v4(), false)
                .await
                .is_err()
        );

        blocking.release.notify_one();
        let _response = stop.await.expect("stop task").expect("verified stop");
        assert_eq!(state.runtime_session_snapshot().await.0, "idle");
        drop(
            state
                .reserve_playback_session()
                .await
                .expect("new playback after completed stop"),
        );
    }

    #[tokio::test]
    async fn cancelled_stop_after_runtime_completion_reconciles_to_idle() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let storage = vibe_cs_storage::Storage::open_in_memory()
            .await
            .expect("storage");
        let blocking = Arc::new(BlockingStopIntegrations::default());
        let state = AppState::new(storage, directory.path().join("data"))
            .with_integrations(blocking.clone());
        assert!(
            state
                .reserve_playback_session()
                .await
                .expect("playback reservation")
                .mark_active()
                .await
        );

        let stop_state = state.clone();
        let stop = tokio::spawn(async move {
            stop_playback(State(stop_state), ApiJson(StopPlaybackRequest::default())).await
        });
        blocking.entered.notified().await;
        let session_lock = state.lock_runtime_session_for_test().await;
        blocking.release.notify_one();
        blocking.completed.notified().await;
        tokio::task::yield_now().await;
        stop.abort();
        assert!(
            stop.await
                .expect_err("the stop handler must be cancelled before its state commit")
                .is_cancelled()
        );
        drop(session_lock);

        tokio::time::timeout(std::time::Duration::from_secs(1), async {
            loop {
                if blocking.calls.load(Ordering::SeqCst) >= 2 {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("the cancellation guard must retry the token-scoped stop");
        assert_eq!(
            state.runtime_session_snapshot().await.0,
            "playback_stopping"
        );
        blocking.release.notify_one();
        tokio::time::timeout(std::time::Duration::from_secs(1), async {
            loop {
                if state.runtime_session_snapshot().await.0 == "idle" {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("an idempotent runtime stop must complete API reconciliation");
    }

    #[tokio::test]
    async fn import_validates_magic_hashes_content_and_skips_duplicate_bytes() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let first = directory.path().join("first.dem");
        let second = directory.path().join("second.dem");
        std::fs::write(&first, b"PBDEMS2\0fixture!").expect("first demo");
        std::fs::write(&second, b"PBDEMS2\0fixture!").expect("second demo");
        let storage = vibe_cs_storage::Storage::open_in_memory()
            .await
            .expect("storage");
        let state = AppState::new(storage.clone(), directory.path().join("data"));

        let first_result =
            import_candidates(&state, vec![first.to_string_lossy().into_owned()], "local")
                .await
                .expect("first import");
        let duplicate_result =
            import_candidates(&state, vec![second.to_string_lossy().into_owned()], "local")
                .await
                .expect("duplicate import");

        assert_eq!(first_result.imported, 1);
        assert_eq!(duplicate_result.skipped, 1);
        let page = storage
            .list_demos(DemoQuery::default())
            .await
            .expect("demos");
        assert_eq!(page.total, 1);
        assert_eq!(
            page.items[0].content_sha256.as_deref().map(str::len),
            Some(64)
        );
    }

    #[tokio::test]
    async fn prepared_upload_recovers_missing_and_tampered_content_owners() {
        for stale_kind in ["missing", "tampered"] {
            let directory = tempfile::tempdir().expect("temporary directory");
            let stale_path = directory.path().join(format!("{stale_kind}-owner.dem"));
            let seed_path = directory.path().join("seed.dem");
            std::fs::write(&seed_path, b"PBDEMS2\0fixture!").expect("seed Demo");
            let validated = validate_demo(
                &seed_path,
                ValidationLimits::default(),
                &ParseCancellation::default(),
            )
            .expect("validated Demo");
            let mut owner =
                record_from_validated(validated.clone(), "local").expect("owner record");
            owner.path = stale_path.to_string_lossy().into_owned();
            owner.file_name = stale_path
                .file_name()
                .expect("file name")
                .to_string_lossy()
                .into_owned();
            if stale_kind == "missing" {
                owner.status = DemoStatus::Missing;
            } else {
                owner.status = DemoStatus::Ready;
                std::fs::write(&stale_path, b"PBDEMS2\0tampered")
                    .expect("same-size tampered owner");
            }
            let storage = vibe_cs_storage::Storage::open_in_memory()
                .await
                .expect("storage");
            storage.put_demo(owner.clone()).await.expect("owner Demo");
            let state = AppState::new(storage.clone(), directory.path().join("data"));
            let staging_dir = directory.path().join(format!("{stale_kind}.staging"));
            let relative_path = PathBuf::from("file-0/incoming.dem");
            let staged_path = staging_dir.join(&relative_path);
            std::fs::create_dir_all(staged_path.parent().expect("staged parent"))
                .expect("staged directory");
            std::fs::write(&staged_path, b"PBDEMS2\0fixture!").expect("incoming Demo");
            let incoming = validate_demo(
                &staged_path,
                ValidationLimits::default(),
                &ParseCancellation::default(),
            )
            .expect("validated incoming Demo");
            let final_dir = directory.path().join(format!("{stale_kind}.published"));

            let Json(result) = publish_prepared_batch(
                &state,
                PreparedUploadBatch {
                    demos: vec![PreparedUploadDemo {
                        relative_path,
                        size: incoming.size,
                        sha256: incoming.sha256.clone(),
                    }],
                    discovered: 1,
                    skipped: 0,
                },
                &staging_dir,
                &final_dir,
                "upload",
            )
            .await
            .expect("publish upload");

            assert_eq!(result.imported, 0);
            assert_eq!(result.updated, 1);
            assert_eq!(result.skipped, 0);
            let recovered = storage
                .get_demo(owner.id)
                .await
                .expect("Demo lookup")
                .expect("recovered Demo");
            assert_eq!(recovered.id, owner.id);
            assert_eq!(
                std::fs::canonicalize(
                    Path::new(&recovered.path)
                        .parent()
                        .and_then(Path::parent)
                        .expect("published batch parent"),
                )
                .expect("published batch canonical path"),
                std::fs::canonicalize(&final_dir).expect("expected batch canonical path")
            );
            assert_eq!(
                validate_demo(
                    Path::new(&recovered.path),
                    ValidationLimits::default(),
                    &ParseCancellation::default(),
                )
                .expect("recovered validation")
                .sha256,
                incoming.sha256
            );
        }
    }

    #[tokio::test]
    async fn changed_demo_content_invalidates_persisted_analysis() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let path = directory.path().join("changed.dem");
        std::fs::write(&path, b"PBDEMS2\0version1").expect("first version");
        let storage = vibe_cs_storage::Storage::open_in_memory()
            .await
            .expect("storage");
        let state = AppState::new(storage.clone(), directory.path().join("data"));
        import_candidates(&state, vec![path.to_string_lossy().into_owned()], "local")
            .await
            .expect("initial import");
        let record = storage
            .list_demos(DemoQuery::default())
            .await
            .expect("demos")
            .items
            .remove(0);
        persist_completed_analysis(
            &storage,
            MatchAnalysis {
                demo_id: record.id,
                map_name: "de_safe".to_owned(),
                tick_rate: 64.0,
                duration_seconds: 1.0,
                verified_total_ticks: None,
                teams: vec![],
                players: vec![],
                rounds: vec![],
                highlights: vec![],
            },
        )
        .await;
        std::fs::write(&path, b"PBDEMS2\0version2").expect("second version");

        import_candidates(&state, vec![path.to_string_lossy().into_owned()], "local")
            .await
            .expect("changed import");

        assert_eq!(
            storage
                .get_demo(record.id)
                .await
                .expect("demo")
                .expect("record")
                .status,
            DemoStatus::Discovered
        );
        assert!(
            storage
                .get_analysis(record.id)
                .await
                .expect("analysis")
                .is_none()
        );
    }

    #[tokio::test]
    async fn watched_file_disappearance_and_return_have_explicit_states() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let path = directory.path().join("watched.dem");
        std::fs::write(&path, b"PBDEMS2\0watched!").expect("watched demo");
        let storage = vibe_cs_storage::Storage::open_in_memory()
            .await
            .expect("storage");
        let state = AppState::new(storage.clone(), directory.path().join("data"));

        import_candidates(&state, vec![path.to_string_lossy().into_owned()], "watch")
            .await
            .expect("initial import");
        let mut record = storage
            .list_demos(DemoQuery::default())
            .await
            .expect("demos")
            .items
            .remove(0);
        record.status = DemoStatus::Ready;
        record.player_names = vec!["FalleN".to_owned(), "m0NESY".to_owned()];
        storage
            .put_demo(record.clone())
            .await
            .expect("ready summary");

        std::fs::remove_file(&path).expect("remove watched demo");
        let changed =
            reconcile_missing_demos(&state, &[directory.path().to_string_lossy().into_owned()])
                .await
                .expect("reconciliation");
        assert_eq!(changed, 1);
        assert_eq!(
            storage
                .get_demo(record.id)
                .await
                .expect("demo")
                .expect("record")
                .status,
            DemoStatus::Missing
        );

        std::fs::write(&path, b"PBDEMS2\0watched!").expect("restore watched demo");
        import_candidates(&state, vec![path.to_string_lossy().into_owned()], "watch")
            .await
            .expect("restored import");
        let restored = storage
            .get_demo(record.id)
            .await
            .expect("demo")
            .expect("record");
        assert_eq!(restored.status, DemoStatus::Discovered);
        assert_eq!(restored.player_names, vec!["FalleN", "m0NESY"]);
    }

    #[tokio::test]
    async fn file_count_failure_rolls_back_the_entire_received_batch() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let storage = vibe_cs_storage::Storage::open_in_memory()
            .await
            .expect("storage");
        let state = AppState::new(storage, directory.path().to_path_buf());
        let mut body = String::new();
        for index in 0..=MAXIMUM_DEMO_UPLOAD_FILES {
            write!(
                body,
                "--demo-boundary\r\nContent-Disposition: form-data; name=\"files\"; filename=\"match-{index}.dem\"\r\n\r\ndemo-{index}\r\n"
            )
            .expect("multipart body");
        }
        body.push_str("--demo-boundary--\r\n");
        let request = Request::builder()
            .header(
                header::CONTENT_TYPE,
                "multipart/form-data; boundary=demo-boundary",
            )
            .body(Body::from(body))
            .expect("request");
        let multipart = Multipart::from_request(request, &())
            .await
            .expect("multipart");

        let error = upload_multiple(State(state), ApiMultipart(multipart))
            .await
            .expect_err("too many files must fail");

        assert_eq!(error.into_response().status(), StatusCode::BAD_REQUEST);
        let entries = std::fs::read_dir(directory.path().join("uploads/demos"))
            .expect("upload directory")
            .collect::<Result<Vec<_>, _>>()
            .expect("entries");
        assert!(entries.is_empty());
    }

    #[tokio::test]
    async fn zip_upload_validates_hashes_and_deduplicates_demo_entries() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let storage = vibe_cs_storage::Storage::open_in_memory()
            .await
            .expect("storage");
        let state = AppState::new(storage.clone(), directory.path().to_path_buf());
        let archive = demo_zip(&[
            ("one.dem", b"PBDEMS2\0same!!!!"),
            ("nested/two.dem", b"PBDEMS2\0same!!!!"),
            ("notes.txt", b"not extracted"),
        ]);
        let multipart = upload_multipart("matches.zip", &archive).await;

        let Json(result) = upload_multiple(State(state), ApiMultipart(multipart))
            .await
            .expect("upload archive");

        assert_eq!(result.discovered, 2);
        assert_eq!(result.imported, 1);
        assert_eq!(result.skipped, 1);
        let page = storage
            .list_demos(DemoQuery::default())
            .await
            .expect("demos");
        assert_eq!(page.total, 1);
        let stored = &page.items[0];
        assert_eq!(stored.content_sha256.as_deref().map(str::len), Some(64));
        assert!(Path::new(&stored.path).is_file());
        assert!(!directory.path().join("uploads/demos/notes.txt").exists());
    }

    #[tokio::test]
    async fn invalid_zip_demo_rolls_back_files_and_database_batch() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let storage = vibe_cs_storage::Storage::open_in_memory()
            .await
            .expect("storage");
        let state = AppState::new(storage.clone(), directory.path().to_path_buf());
        let archive = demo_zip(&[
            ("valid.dem", b"PBDEMS2\0valid!!!"),
            ("invalid.dem", b"NOTADEMOinvalid!"),
        ]);
        let multipart = upload_multipart("invalid.zip", &archive).await;

        let error = upload_multiple(State(state), ApiMultipart(multipart))
            .await
            .expect_err("invalid archive must fail");

        assert_eq!(error.into_response().status(), StatusCode::BAD_REQUEST);
        assert_eq!(
            storage
                .list_demos(DemoQuery::default())
                .await
                .expect("demos")
                .total,
            0
        );
        let entries = std::fs::read_dir(directory.path().join("uploads/demos"))
            .expect("upload directory")
            .collect::<Result<Vec<_>, _>>()
            .expect("entries");
        assert!(entries.is_empty());
    }

    #[tokio::test]
    async fn desktop_archive_bundle_copies_sources_and_imports_atomically() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let direct = directory.path().join("direct.dem");
        std::fs::write(&direct, b"PBDEMS2\0direct!!").expect("direct demo");
        let archive_path = directory.path().join("bundle.zip");
        std::fs::write(
            &archive_path,
            demo_zip(&[("archive.dem", b"PBDEMS2\0archive!")]),
        )
        .expect("archive");
        let storage = vibe_cs_storage::Storage::open_in_memory()
            .await
            .expect("storage");
        let state = AppState::new(storage.clone(), directory.path().join("data"));

        let result = import_local_bundle(
            &state,
            vec![
                direct.to_string_lossy().into_owned(),
                archive_path.to_string_lossy().into_owned(),
            ],
        )
        .await
        .expect("import local bundle");

        assert_eq!(result.imported, 2);
        assert!(
            direct.is_file(),
            "the selected source demo must be preserved"
        );
        assert!(
            archive_path.is_file(),
            "the selected archive must be preserved"
        );
        let page = storage
            .list_demos(DemoQuery::default())
            .await
            .expect("demos");
        assert_eq!(page.total, 2);
        assert!(page.items.iter().all(|demo| demo.source == "local"));
        assert!(
            page.items
                .iter()
                .all(|demo| Path::new(&demo.path).is_file())
        );
        assert!(page.items.iter().all(|demo| demo.path.contains("uploads")));
    }
}
