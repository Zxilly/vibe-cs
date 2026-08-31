use axum::{
    Json, Router,
    extract::{Path, State},
    routing::get,
};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;
use vibe_cs_domain::{
    AnalysisRun, AnalysisRunStatus, JobFailureCode, JobStatus, MatchDownloadJob,
    MatchDownloadStatus, RecordingJob, SteamConfig,
};
use vibe_cs_integrations::is_steam_id;
use vibe_cs_storage::{
    ActivityKind as StoredActivityKind, ActivityQuery as StoredActivityQuery, ActivitySource,
    ActivityState as StoredActivityState, ExportJobRecord,
};

use crate::{ApiError, ApiQuery, ApiResult, AppState};
use ts_rs::TS;

const DEFAULT_PAGE_SIZE: u32 = 50;
const MAXIMUM_PAGE_SIZE: u32 = 100;
const MAXIMUM_PAGE: u32 = 10_000;

pub(crate) fn router() -> Router<AppState> {
    Router::new()
        .route("/api/activities", get(list_activities))
        .route("/api/activities/{kind}/{id}", get(get_activity))
}

#[derive(Debug, Serialize, TS)]
#[ts(export)]
struct ActivityFeed {
    items: Vec<ActivityItem>,
    total: u64,
    page: u32,
    page_size: u32,
    summary: ActivitySummary,
}

#[derive(Debug, Serialize, TS)]
#[ts(export)]
struct ActivitySummary {
    total: u64,
    active: u64,
    failed: u64,
    completed: u64,
    cancelled: u64,
}

#[derive(Debug, Default, Deserialize, TS)]
#[serde(deny_unknown_fields)]
#[ts(export)]
struct ActivityQuery {
    #[ts(optional)]
    search: Option<String>,
    #[ts(optional)]
    kind: Option<ActivityKindFilter>,
    #[ts(optional)]
    state: Option<ActivityStateFilter>,
    #[ts(optional)]
    page: Option<u32>,
    #[ts(optional)]
    page_size: Option<u32>,
}

#[derive(Clone, Copy, Debug, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
enum ActivityKindFilter {
    Recording,
    Export,
    Download,
    Analysis,
}

#[derive(Clone, Copy, Debug, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
enum ActivityStateFilter {
    Active,
    Failed,
    Completed,
    Cancelled,
}

/* ── response discriminators ──────────────────────────────────────────────────
 *
 * These four were `&'static str` written by `match` arms, so the generated
 * bindings said `string` and the web app kept its own union beside them with a
 * note that the server did not guarantee it. That note was accurate: adding an
 * arm here could not fail any check, and the client would have compared against
 * a set that no longer matched.
 *
 * The query side (`ActivityKindFilter`, `ActivityStateFilter`) was already
 * enums, which is the shape this brings the response side up to.
 */

/// Which pipeline produced the row.
///
/// The same four values as `ActivityKindFilter`, kept separate because that one
/// is the query and this is the answer: a filter may gain "all" without the
/// response gaining a kind.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
enum ActivityKind {
    Recording,
    Export,
    Download,
    Analysis,
}

/// The row's state, flattened from the three pipelines' own status enums.
///
/// A superset: `queued` / `running` / `completed` / `failed` / `cancelled` are
/// shared, `preparing` and `cancelling` come from jobs, and the three transfer
/// states come from downloads. `AnalysisRunStatus::Interrupted` deliberately
/// arrives as `failed` — an interrupted run is a failed one from here, and the
/// distinction belongs to the analysis page.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
enum ActivityStatus {
    Queued,
    Preparing,
    Running,
    Cancelling,
    Completed,
    Failed,
    Cancelled,
    Downloading,
    Decompressing,
    Importing,
}

/// What `completed_units` / `total_units` are counting on this row.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
enum ActivityUnit {
    Stages,
    Bytes,
}

/// What the row offers, in the order it is offered.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
enum ActivityAction {
    Cancel,
    RetryRecording,
    RetryDownload,
    RetryAnalysis,
    OpenOutputs,
    OpenMatchHistory,
    OpenAnalysis,
    OpenLibrary,
}

#[derive(Debug, Serialize, TS)]
#[ts(export)]
struct ActivityItem {
    id: String,
    kind: ActivityKind,
    subtype: Option<String>,
    job_id: Option<String>,
    context_id: Option<String>,
    subject: Option<String>,
    status: ActivityStatus,
    stage: Option<String>,
    progress_percent: Option<u8>,
    completed_units: Option<u64>,
    total_units: Option<u64>,
    unit: Option<ActivityUnit>,
    error: Option<String>,
    /// The classified failure, when the service could classify it.
    ///
    /// `error` stays beside it and is still the only thing that carries the
    /// specifics — the code says 「磁盘空间不足」 and whether 重试 is worth
    /// offering, the message says which volume and how much was needed. A code
    /// without the message would be a row that cannot be acted on; a message
    /// without the code is what this page had before, and it could not be
    /// translated or grouped.
    failure: Option<ActivityFailure>,
    created_at: DateTime<Utc>,
    updated_at: DateTime<Utc>,
    available_actions: Vec<ActivityAction>,
}

#[derive(Debug, Serialize, TS)]
#[ts(export)]
struct ActivityFailure {
    code: JobFailureCode,
    /// Whether re-running could succeed without the user changing something
    /// first. `DiskFull` is false — see [`JobFailureCode::retryable`].
    retryable: bool,
}

impl ActivityFailure {
    fn of(code: Option<JobFailureCode>) -> Option<Self> {
        code.map(|code| Self {
            code,
            retryable: code.retryable(),
        })
    }
}

async fn list_activities(
    State(state): State<AppState>,
    ApiQuery(query): ApiQuery<ActivityQuery>,
) -> ApiResult<Json<ActivityFeed>> {
    let page = query.page.unwrap_or(1);
    let page_size = query.page_size.unwrap_or(DEFAULT_PAGE_SIZE);
    validate_activity_query(&query, page, page_size)?;
    let page_result = state
        .storage
        .query_activities(StoredActivityQuery {
            search: query.search,
            kind: query.kind.map(ActivityKindFilter::stored),
            state: query.state.map(ActivityStateFilter::stored),
            page,
            page_size,
        })
        .await?;
    let config = state.storage.get_config().await?.unwrap_or_default();
    let retry_account = valid_steam_download_account(&config.steam);
    let mut items = Vec::with_capacity(page_result.items.len());
    for source in page_result.items {
        items.push(activity_item(source, retry_account));
    }
    let summary = ActivitySummary {
        total: page_result.summary.total,
        active: page_result.summary.active,
        failed: page_result.summary.failed,
        completed: page_result.summary.completed,
        cancelled: page_result.summary.cancelled,
    };
    Ok(Json(ActivityFeed {
        items,
        total: page_result.total,
        page,
        page_size,
        summary,
    }))
}

async fn get_activity(
    State(state): State<AppState>,
    Path((kind, id)): Path<(String, String)>,
) -> ApiResult<Json<ActivityItem>> {
    let kind = parse_activity_kind(&kind)?;
    let parsed_id =
        Uuid::parse_str(&id).map_err(|_| ApiError::invalid("activity job id must be a UUID"))?;
    if parsed_id.to_string() != id {
        return Err(ApiError::invalid(
            "activity job id must be a canonical lowercase UUID",
        ));
    }
    let source = state
        .storage
        .get_activity(kind, parsed_id)
        .await?
        .ok_or_else(|| ApiError::not_found("activity"))?;
    if matches!(
        &source,
        ActivitySource::Recording { job, .. } if job.status.is_terminal()
    ) {
        super::recording::reconcile_project_recording(&state, parsed_id).await?;
    }
    let config = state.storage.get_config().await?.unwrap_or_default();
    Ok(Json(activity_item(
        source,
        valid_steam_download_account(&config.steam),
    )))
}

fn parse_activity_kind(value: &str) -> ApiResult<StoredActivityKind> {
    match value {
        "recording" => Ok(StoredActivityKind::Recording),
        "export" => Ok(StoredActivityKind::Export),
        "download" => Ok(StoredActivityKind::Download),
        "analysis" => Ok(StoredActivityKind::Analysis),
        _ => Err(ApiError::invalid("activity kind is invalid")),
    }
}

fn activity_item(source: ActivitySource, retry_account: Option<&str>) -> ActivityItem {
    match source {
        ActivitySource::Recording { job, retryable } => recording_activity(&job, retryable),
        ActivitySource::Export(record) => export_activity(record),
        ActivitySource::Download {
            job,
            retryable,
            owner_steam_id,
        } => download_activity(
            job,
            retryable
                && retry_account
                    .is_some_and(|steam_id| owner_steam_id.as_deref() == Some(steam_id)),
        ),
        ActivitySource::Analysis {
            run,
            demo,
            retryable,
            result_available,
        } => analysis_activity(run, demo.display_name, retryable, result_available),
    }
}

fn valid_steam_download_account(config: &SteamConfig) -> Option<&str> {
    let valid_web_api_key = config.web_api_key.len() == 32
        && config
            .web_api_key
            .bytes()
            .all(|character| character.is_ascii_hexdigit());
    (is_steam_id(&config.steam_id) && valid_web_api_key).then_some(config.steam_id.as_str())
}

fn validate_activity_query(query: &ActivityQuery, page: u32, page_size: u32) -> ApiResult<()> {
    if !(1..=MAXIMUM_PAGE).contains(&page) {
        return Err(ApiError::invalid(format!(
            "activity page must be between 1 and {MAXIMUM_PAGE}"
        )));
    }
    if !(1..=MAXIMUM_PAGE_SIZE).contains(&page_size) {
        return Err(ApiError::invalid(format!(
            "activity page_size must be between 1 and {MAXIMUM_PAGE_SIZE}"
        )));
    }
    if query
        .search
        .as_deref()
        .is_some_and(|search| search.chars().count() > 128)
    {
        return Err(ApiError::invalid(
            "activity search must contain at most 128 characters",
        ));
    }
    Ok(())
}

impl ActivityKindFilter {
    const fn stored(self) -> StoredActivityKind {
        match self {
            Self::Recording => StoredActivityKind::Recording,
            Self::Export => StoredActivityKind::Export,
            Self::Download => StoredActivityKind::Download,
            Self::Analysis => StoredActivityKind::Analysis,
        }
    }
}

impl ActivityStateFilter {
    const fn stored(self) -> StoredActivityState {
        match self {
            Self::Active => StoredActivityState::Active,
            Self::Failed => StoredActivityState::Failed,
            Self::Completed => StoredActivityState::Completed,
            Self::Cancelled => StoredActivityState::Cancelled,
        }
    }
}

fn recording_activity(job: &RecordingJob, retryable: bool) -> ActivityItem {
    let message = (!job.message.trim().is_empty()).then(|| job.message.trim().to_owned());
    let completed_units = message.as_deref().and_then(recording_stage_ordinal);
    let error = (job.status == JobStatus::Failed)
        .then(|| message.clone())
        .flatten();
    let mut available_actions = Vec::with_capacity(2);
    if !job.status.is_terminal() {
        available_actions.push(ActivityAction::Cancel);
    } else if retryable {
        available_actions.push(ActivityAction::RetryRecording);
    }
    available_actions.push(ActivityAction::OpenOutputs);
    ActivityItem {
        id: format!("recording:{}", job.id),
        kind: ActivityKind::Recording,
        subtype: None,
        job_id: Some(job.id.to_string()),
        context_id: job.items.first().map(|item| item.demo_id.to_string()),
        subject: job.items.first().map(|item| item.title.clone()),
        status: job_status(job.status),
        stage: message,
        // Recording progress is a verified five-stage ordinal. It is not an
        // elapsed-time percentage and must not be rendered as one.
        progress_percent: None,
        completed_units,
        total_units: completed_units.map(|_| 5),
        unit: completed_units.map(|_| ActivityUnit::Stages),
        error,
        failure: ActivityFailure::of(job.error_code),
        created_at: job.created_at,
        updated_at: job.updated_at,
        available_actions,
    }
}

fn recording_stage_ordinal(stage: &str) -> Option<u64> {
    match stage {
        "recording.stage.launching" => Some(1),
        "recording.stage.seeking" => Some(2),
        "recording.stage.capturing" => Some(3),
        "recording.stage.stabilizing" => Some(4),
        "recording.stage.encoding" => Some(5),
        _ => None,
    }
}

fn export_activity(record: ExportJobRecord) -> ActivityItem {
    let job = record.job;
    let mut available_actions = Vec::with_capacity(2);
    if !job.status.is_terminal() {
        available_actions.push(ActivityAction::Cancel);
    }
    available_actions.push(ActivityAction::OpenOutputs);
    ActivityItem {
        id: format!("export:{}", job.id),
        kind: ActivityKind::Export,
        subtype: Some(record.kind),
        job_id: Some(job.id.to_string()),
        context_id: Some(job.project_id.to_string()),
        subject: (!job.output_path.trim().is_empty()).then(|| job.output_path.clone()),
        status: job_status(job.status),
        stage: None,
        progress_percent: trustworthy_percent(job.progress),
        completed_units: None,
        total_units: None,
        unit: None,
        failure: ActivityFailure::of(job.error_code),
        error: job.error,
        created_at: job.created_at,
        updated_at: job.updated_at,
        available_actions,
    }
}

fn download_activity(job: MatchDownloadJob, retryable: bool) -> ActivityItem {
    let mut available_actions = Vec::with_capacity(2);
    if !job.status.is_terminal() {
        available_actions.push(ActivityAction::Cancel);
    } else if retryable
        && matches!(
            job.status,
            MatchDownloadStatus::Failed | MatchDownloadStatus::Cancelled
        )
    {
        available_actions.push(ActivityAction::RetryDownload);
    }
    available_actions.push(ActivityAction::OpenMatchHistory);
    let progress_percent = job
        .total_bytes
        .filter(|total| *total > 0)
        .and_then(|total| rounded_integer_percent(job.downloaded_bytes.min(total), total));
    ActivityItem {
        id: format!("download:{}", job.id),
        kind: ActivityKind::Download,
        subtype: None,
        job_id: Some(job.id.to_string()),
        context_id: Some(job.match_record_id.clone()),
        subject: Some(job.match_record_id),
        status: match_download_status(job.status),
        stage: None,
        progress_percent,
        completed_units: Some(job.downloaded_bytes),
        total_units: job.total_bytes,
        unit: Some(ActivityUnit::Bytes),
        failure: ActivityFailure::of(job.error_code),
        error: job.error,
        created_at: job.created_at,
        updated_at: job.updated_at,
        available_actions,
    }
}

fn analysis_activity(
    run: AnalysisRun,
    subject: String,
    retryable: bool,
    result_available: bool,
) -> ActivityItem {
    let mut available_actions = Vec::with_capacity(2);
    if !run.status.is_terminal() {
        available_actions.push(ActivityAction::Cancel);
    } else if retryable {
        available_actions.push(ActivityAction::RetryAnalysis);
    } else if run.status == AnalysisRunStatus::Completed && result_available {
        available_actions.push(ActivityAction::OpenAnalysis);
    }
    available_actions.push(ActivityAction::OpenLibrary);
    ActivityItem {
        id: format!("analysis:{}", run.id),
        kind: ActivityKind::Analysis,
        subtype: None,
        job_id: Some(run.id.to_string()),
        context_id: Some(run.demo_id.to_string()),
        subject: Some(subject),
        status: analysis_run_status(run.status),
        stage: Some(analysis_run_stage(run.stage).to_owned()),
        progress_percent: None,
        completed_units: None,
        total_units: None,
        unit: None,
        failure: ActivityFailure::of(run.error_code),
        error: run.error,
        created_at: run.created_at,
        updated_at: run.updated_at,
        available_actions,
    }
}

fn trustworthy_percent(progress: f64) -> Option<u8> {
    if !progress.is_finite() || !(0.0..=1.0).contains(&progress) {
        return None;
    }
    let rounded = (progress * 100.0).round();
    (0_u8..=100).find(|percent| (f64::from(*percent) - rounded).abs() < f64::EPSILON)
}

fn rounded_integer_percent(completed: u64, total: u64) -> Option<u8> {
    let total = u128::from(total);
    let rounded = (u128::from(completed) * 100 + total / 2) / total;
    u8::try_from(rounded).ok()
}

const fn job_status(status: JobStatus) -> ActivityStatus {
    match status {
        JobStatus::Queued => ActivityStatus::Queued,
        JobStatus::Preparing => ActivityStatus::Preparing,
        JobStatus::Running => ActivityStatus::Running,
        JobStatus::Cancelling => ActivityStatus::Cancelling,
        JobStatus::Completed => ActivityStatus::Completed,
        JobStatus::Failed => ActivityStatus::Failed,
        JobStatus::Cancelled => ActivityStatus::Cancelled,
    }
}

const fn match_download_status(status: MatchDownloadStatus) -> ActivityStatus {
    match status {
        MatchDownloadStatus::Queued => ActivityStatus::Queued,
        MatchDownloadStatus::Downloading => ActivityStatus::Downloading,
        MatchDownloadStatus::Decompressing => ActivityStatus::Decompressing,
        MatchDownloadStatus::Importing => ActivityStatus::Importing,
        MatchDownloadStatus::Completed => ActivityStatus::Completed,
        MatchDownloadStatus::Cancelling => ActivityStatus::Cancelling,
        MatchDownloadStatus::Cancelled => ActivityStatus::Cancelled,
        MatchDownloadStatus::Failed => ActivityStatus::Failed,
    }
}

const fn analysis_run_status(status: AnalysisRunStatus) -> ActivityStatus {
    match status {
        AnalysisRunStatus::Queued => ActivityStatus::Queued,
        AnalysisRunStatus::Running => ActivityStatus::Running,
        AnalysisRunStatus::Completed => ActivityStatus::Completed,
        AnalysisRunStatus::Failed | AnalysisRunStatus::Interrupted => ActivityStatus::Failed,
        AnalysisRunStatus::Cancelled => ActivityStatus::Cancelled,
    }
}

const fn analysis_run_stage(stage: vibe_cs_domain::AnalysisRunStage) -> &'static str {
    match stage {
        vibe_cs_domain::AnalysisRunStage::ValidatingInput => "validating_input",
        vibe_cs_domain::AnalysisRunStage::ParserQueued => "parser_queued",
        vibe_cs_domain::AnalysisRunStage::ParserRunning => "parser_running",
        vibe_cs_domain::AnalysisRunStage::VerifyingInputAfterParse => "verifying_input_after_parse",
        vibe_cs_domain::AnalysisRunStage::Projecting => "projecting",
        vibe_cs_domain::AnalysisRunStage::Completed => "completed",
        vibe_cs_domain::AnalysisRunStage::Failed => "failed",
        vibe_cs_domain::AnalysisRunStage::Interrupted => "interrupted",
        vibe_cs_domain::AnalysisRunStage::Cancelled => "cancelled",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        body::{Body, to_bytes},
        http::Request,
        response::IntoResponse as _,
    };
    use tower::ServiceExt as _;

    async fn create_export_project(storage: &vibe_cs_storage::Storage) -> Uuid {
        let now = Utc::now();
        let id = Uuid::new_v4();
        let track_id = Uuid::new_v4();
        storage
            .create_project(vibe_cs_domain::Project {
                id,
                name: "Export owner".to_owned(),
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
            .expect("export Project");
        id
    }

    #[tokio::test]
    async fn exact_activity_route_returns_the_requested_authoritative_row() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let storage = vibe_cs_storage::Storage::open_in_memory()
            .await
            .expect("storage");
        let now = Utc::now();
        let job_id = Uuid::new_v4();
        let project_id = create_export_project(&storage).await;
        storage
            .put_export_job(ExportJobRecord {
                kind: "project".to_owned(),
                job: vibe_cs_domain::ExportJob {
                    id: job_id,
                    project_id,
                    project_revision: 1,
                    status: JobStatus::Completed,
                    progress: 1.0,
                    output_path: "C:/exports/exact.mp4".to_owned(),
                    error: None,
                    error_code: None,
                    created_at: now,
                    updated_at: now,
                },
            })
            .await
            .expect("export job");
        let state = AppState::new(storage, directory.path().to_path_buf());

        let exact = get_activity(
            State(state.clone()),
            Path(("export".to_owned(), job_id.to_string())),
        )
        .await
        .expect("exact activity")
        .0;
        assert_eq!(exact.id, format!("export:{job_id}"));
        assert_eq!(exact.job_id.as_deref(), Some(job_id.to_string().as_str()));

        let missing = get_activity(
            State(state),
            Path(("recording".to_owned(), job_id.to_string())),
        )
        .await
        .expect_err("same UUID in another kind must not match");
        assert_eq!(
            missing.into_response().status(),
            axum::http::StatusCode::NOT_FOUND
        );
    }

    #[tokio::test]
    async fn terminal_recording_activity_reconciles_project_before_returning() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let storage = vibe_cs_storage::Storage::open_in_memory()
            .await
            .expect("storage");
        let now = Utc::now();
        let project_id = Uuid::new_v4();
        let track_id = Uuid::new_v4();
        let clip_id = Uuid::new_v4();
        let demo_id = Uuid::new_v4();
        let job_id = Uuid::new_v4();
        let output_id = Uuid::new_v4();
        let output_path = directory.path().join("recorded.mp4");
        tokio::fs::write(&output_path, b"verified recording")
            .await
            .expect("recorded media");
        let intent = vibe_cs_domain::CaptureIntent {
            demo_id,
            highlight_id: None,
            player_id: "76561198041683378".to_owned(),
            start_tick: 100,
            end_tick: 164,
            pre_roll_seconds: 0.0,
            post_roll_seconds: 0.0,
            victim_pov: false,
            camera_style: vibe_cs_domain::HlaeCameraStyle::Pov,
            presentation: None,
        };
        storage
            .create_project(vibe_cs_domain::Project {
                id: project_id,
                name: "Recording owner".to_owned(),
                revision: 1,
                document: vibe_cs_domain::EditingDocument {
                    width: 1920,
                    height: 1080,
                    fps: 60,
                    duration_seconds: 1.0,
                    story_track_id: track_id,
                    tracks: vec![vibe_cs_domain::TimelineTrack {
                        id: track_id,
                        name: "Story".to_owned(),
                        kind: vibe_cs_domain::TrackKind::Video,
                        order: 0,
                        muted: false,
                        locked: false,
                        hidden: false,
                        clips: vec![vibe_cs_domain::TimelineClip {
                            id: clip_id,
                            name: "NiKo".to_owned(),
                            capture_intent: Some(intent.clone()),
                            material: vibe_cs_domain::TimelineClipMaterial::Planned,
                            placement: vibe_cs_domain::TimelinePlacement {
                                start: 0.0,
                                duration: 1.0,
                                source_in: 0.0,
                                source_out: 1.0,
                                speed: 1.0,
                                volume: 1.0,
                                enabled: true,
                            },
                            transform: vibe_cs_domain::Transform::default(),
                            effects: Vec::new(),
                            transitions: vibe_cs_domain::TimelineClipTransitions::default(),
                            text: None,
                            metadata: serde_json::json!({}),
                            group_id: None,
                            link_group_id: None,
                            keyframes: Vec::new(),
                            speed_segments: Vec::new(),
                        }],
                    }],
                    markers: Vec::new(),
                    settings: vibe_cs_domain::EditingDocumentSettings::default(),
                },
                created_at: now,
                updated_at: now,
            })
            .await
            .expect("Project");
        let request = intent.into_recording_request(clip_id, "NiKo");
        storage
            .put_recording_job(RecordingJob {
                id: job_id,
                retry_of: None,
                status: JobStatus::Completed,
                items: vec![request],
                current_index: 1,
                progress: 1.0,
                message: "Completed".to_owned(),
                outputs: vec![vibe_cs_domain::RecordedClip {
                    id: output_id,
                    path: output_path.to_string_lossy().into_owned(),
                    title: "NiKo".to_owned(),
                    duration_seconds: 1.0,
                    demo_id: Some(demo_id),
                    player_name: Some("NiKo".to_owned()),
                    category: "highlight".to_owned(),
                    tags: Vec::new(),
                    metadata: serde_json::json!({"request_id": clip_id}),
                    created_at: now,
                }],
                error_code: None,
                created_at: now,
                updated_at: now,
            })
            .await
            .expect("recording job");
        storage
            .bind_project_recording_run(job_id, project_id)
            .await
            .expect("Project recording binding");
        let state = AppState::new(storage.clone(), directory.path().to_path_buf());

        let _ = get_activity(
            State(state),
            Path(("recording".to_owned(), job_id.to_string())),
        )
        .await
        .expect("terminal recording activity");

        let project = storage
            .get_project(project_id)
            .await
            .expect("Project read")
            .expect("Project exists");
        assert_eq!(project.revision, 2);
        assert!(matches!(
            project.document.tracks[0].clips[0].material,
            vibe_cs_domain::TimelineClipMaterial::Take { take_id, .. } if take_id == output_id
        ));
    }

    #[tokio::test]
    async fn a_failed_job_carries_a_classified_reason_beside_its_message() {
        // §10 gap: 「11 输出与任务记录」 draws 「失败 · 磁盘空间不足」 and offers
        // 重试 only where a retry could work. Free text could drive neither.
        let directory = tempfile::tempdir().expect("temporary directory");
        let storage = vibe_cs_storage::Storage::open_in_memory()
            .await
            .expect("storage");
        let now = Utc::now();
        let job_id = Uuid::new_v4();
        let project_id = create_export_project(&storage).await;
        storage
            .put_export_job(ExportJobRecord {
                kind: "project".to_owned(),
                job: vibe_cs_domain::ExportJob {
                    id: job_id,
                    project_id,
                    project_revision: 1,
                    status: JobStatus::Failed,
                    progress: 0.4,
                    output_path: "C:/exports/full-disk.mp4".to_owned(),
                    error: Some("I/O error for C:/exports: no space left".to_owned()),
                    error_code: Some(JobFailureCode::DiskFull),
                    created_at: now,
                    updated_at: now,
                },
            })
            .await
            .expect("export job");
        let state = AppState::new(storage, directory.path().to_path_buf());

        let activity = get_activity(
            State(state),
            Path(("export".to_owned(), job_id.to_string())),
        )
        .await
        .expect("activity")
        .0;

        let failure = activity.failure.expect("classified failure");
        assert_eq!(failure.code, JobFailureCode::DiskFull);
        // Not retryable: the retry would fail the same way, and the artboard's
        // own sentence is 「释放 4.2 GB 后可重试」 — an instruction first.
        assert!(!failure.retryable);
        // The message survives beside it; the code does not replace it.
        assert!(
            activity
                .error
                .is_some_and(|error| error.contains("no space left"))
        );
    }

    #[tokio::test]
    async fn an_ordinary_completed_job_has_no_failure_at_all() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let storage = vibe_cs_storage::Storage::open_in_memory()
            .await
            .expect("storage");
        let now = Utc::now();
        let job_id = Uuid::new_v4();
        let project_id = create_export_project(&storage).await;
        storage
            .put_export_job(ExportJobRecord {
                kind: "project".to_owned(),
                job: vibe_cs_domain::ExportJob {
                    id: job_id,
                    project_id,
                    project_revision: 1,
                    status: JobStatus::Completed,
                    progress: 1.0,
                    output_path: "C:/exports/fine.mp4".to_owned(),
                    error: None,
                    error_code: None,
                    created_at: now,
                    updated_at: now,
                },
            })
            .await
            .expect("export job");
        let state = AppState::new(storage, directory.path().to_path_buf());

        let activity = get_activity(
            State(state),
            Path(("export".to_owned(), job_id.to_string())),
        )
        .await
        .expect("activity")
        .0;
        assert!(activity.failure.is_none());
    }

    #[tokio::test]
    async fn exact_activity_route_rejects_retired_or_malformed_locators() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let state = AppState::new(
            vibe_cs_storage::Storage::open_in_memory()
                .await
                .expect("storage"),
            directory.path().to_path_buf(),
        );

        for (kind, id) in [
            ("analyses", Uuid::new_v4().to_string()),
            ("analysis", "not-a-uuid".to_owned()),
            ("analysis", Uuid::new_v4().to_string().to_uppercase()),
            ("analysis", Uuid::new_v4().simple().to_string()),
        ] {
            let error = get_activity(State(state.clone()), Path((kind.to_owned(), id)))
                .await
                .expect_err("invalid locator must fail closed");
            assert_eq!(
                error.into_response().status(),
                axum::http::StatusCode::BAD_REQUEST
            );
        }
    }

    #[tokio::test]
    async fn cancelled_activity_filter_and_summary_are_exposed_by_http() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let storage = vibe_cs_storage::Storage::open_in_memory()
            .await
            .expect("storage");
        let demo_id = Uuid::new_v4();
        storage
            .put_demo(vibe_cs_domain::DemoRecord {
                id: demo_id,
                path: "C:/demos/cancelled.dem".to_owned(),
                file_name: "cancelled.dem".to_owned(),
                display_name: "Cancelled analysis".to_owned(),
                source: "local".to_owned(),
                status: vibe_cs_domain::DemoStatus::Discovered,
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
                content_sha256: Some("a".repeat(64)),
                file_size: 512,
                created_at: Utc::now(),
                updated_at: Utc::now(),
            })
            .await
            .expect("demo");
        let run_id = storage.start_analysis_run(demo_id).await.unwrap().run.id;
        storage.cancel_analysis_run(run_id).await.unwrap();
        let dispatcher =
            crate::build_dispatcher(AppState::new(storage, directory.path().to_path_buf()));

        let response = dispatcher
            .oneshot(
                Request::builder()
                    .uri("/api/activities?kind=analysis&state=cancelled")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), axum::http::StatusCode::OK);
        let body: serde_json::Value =
            serde_json::from_slice(&to_bytes(response.into_body(), 64 * 1024).await.unwrap())
                .unwrap();
        assert_eq!(body["total"], 1);
        assert_eq!(body["summary"]["cancelled"], 1);
        assert_eq!(
            body["summary"]["total"].as_u64().unwrap(),
            body["summary"]["active"].as_u64().unwrap()
                + body["summary"]["failed"].as_u64().unwrap()
                + body["summary"]["completed"].as_u64().unwrap()
                + body["summary"]["cancelled"].as_u64().unwrap()
        );
        assert_eq!(body["items"][0]["status"], "cancelled");
    }

    fn analysis_run(
        status: AnalysisRunStatus,
        stage: vibe_cs_domain::AnalysisRunStage,
    ) -> AnalysisRun {
        let now = Utc::now();
        AnalysisRun {
            id: Uuid::new_v4(),
            demo_id: Uuid::new_v4(),
            input_sha256: Some("a".repeat(64)),
            input_size: Some(512),
            status,
            stage,
            error: matches!(
                status,
                AnalysisRunStatus::Failed | AnalysisRunStatus::Interrupted
            )
            .then(|| "analysis stopped".to_owned()),
            error_code: None,
            created_at: now,
            updated_at: now,
        }
    }

    #[test]
    fn recording_retry_action_is_exposed_only_for_a_proven_latest_attempt() {
        let now = Utc::now();
        let job = RecordingJob {
            id: Uuid::new_v4(),
            retry_of: None,
            status: JobStatus::Failed,
            items: vec![vibe_cs_domain::RecordingRequest {
                id: Some(Uuid::new_v4()),
                demo_id: Uuid::new_v4(),
                highlight_id: None,
                player_id: "76561198000000000".to_owned(),
                title: "Retryable capture".to_owned(),
                start_tick: 100,
                end_tick: 200,
                pre_roll_seconds: 0.0,
                post_roll_seconds: 0.0,
                victim_pov: false,
                camera_style: vibe_cs_domain::HlaeCameraStyle::default(),
                presentation: None,
            }],
            current_index: 0,
            progress: 0.0,
            message: "capture interrupted".to_owned(),
            outputs: Vec::new(),
            error_code: None,
            created_at: now,
            updated_at: now,
        };

        let retryable = recording_activity(&job, true);
        let superseded = recording_activity(&job, false);

        assert_eq!(
            retryable.available_actions,
            vec![ActivityAction::RetryRecording, ActivityAction::OpenOutputs]
        );
        assert_eq!(
            superseded.available_actions,
            vec![ActivityAction::OpenOutputs]
        );
    }

    #[test]
    fn analysis_actions_and_public_status_follow_exact_attempt_truth() {
        let completed = analysis_run(
            AnalysisRunStatus::Completed,
            vibe_cs_domain::AnalysisRunStage::Completed,
        );
        let with_result = analysis_activity(completed.clone(), "Demo".to_owned(), false, true);
        let without_result = analysis_activity(completed, "Demo".to_owned(), false, false);
        assert_eq!(
            with_result.available_actions,
            [ActivityAction::OpenAnalysis, ActivityAction::OpenLibrary]
        );
        assert_eq!(
            without_result.available_actions,
            [ActivityAction::OpenLibrary]
        );

        let interrupted = analysis_activity(
            analysis_run(
                AnalysisRunStatus::Interrupted,
                vibe_cs_domain::AnalysisRunStage::Interrupted,
            ),
            "Demo".to_owned(),
            true,
            false,
        );
        assert_eq!(interrupted.status, ActivityStatus::Failed);
        assert_eq!(interrupted.stage.as_deref(), Some("interrupted"));
        assert_eq!(
            interrupted.available_actions,
            [ActivityAction::RetryAnalysis, ActivityAction::OpenLibrary]
        );
    }

    #[test]
    fn cancelled_analysis_activity_is_not_presented_as_a_failure() {
        let cancelled = analysis_activity(
            analysis_run(
                AnalysisRunStatus::Cancelled,
                vibe_cs_domain::AnalysisRunStage::Cancelled,
            ),
            "Demo".to_owned(),
            true,
            false,
        );

        assert_eq!(cancelled.status, ActivityStatus::Cancelled);
        assert_eq!(cancelled.stage.as_deref(), Some("cancelled"));
        assert_eq!(cancelled.error, None);
        assert_eq!(
            cancelled.available_actions,
            [ActivityAction::RetryAnalysis, ActivityAction::OpenLibrary]
        );
    }

    #[test]
    fn active_analysis_activity_exposes_exact_run_cancellation() {
        let active = analysis_activity(
            analysis_run(
                AnalysisRunStatus::Running,
                vibe_cs_domain::AnalysisRunStage::ParserRunning,
            ),
            "Demo".to_owned(),
            false,
            false,
        );

        assert_eq!(
            active.available_actions,
            [ActivityAction::Cancel, ActivityAction::OpenLibrary]
        );
    }
}
