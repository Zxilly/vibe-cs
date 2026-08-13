use axum::{
    Json, Router,
    extract::{Path, State},
    routing::get,
};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;
use vibe_cs_domain::{
    AnalysisRun, AnalysisRunStatus, JobStatus, MatchDownloadJob, MatchDownloadStatus, RecordingJob,
    SteamConfig,
};
use vibe_cs_integrations::is_steam_id;
use vibe_cs_storage::{
    ActivityKind as StoredActivityKind, ActivityQuery as StoredActivityQuery, ActivitySource,
    ActivityState as StoredActivityState, ExportJobRecord,
};

use crate::{ApiError, ApiQuery, ApiResult, AppState};

const DEFAULT_PAGE_SIZE: u32 = 50;
const MAXIMUM_PAGE_SIZE: u32 = 100;
const MAXIMUM_PAGE: u32 = 10_000;

pub(crate) fn router() -> Router<AppState> {
    Router::new()
        .route("/api/activities", get(list_activities))
        .route("/api/activities/{kind}/{id}", get(get_activity))
}

#[derive(Debug, Serialize)]
struct ActivityFeed {
    items: Vec<ActivityItem>,
    total: u64,
    page: u32,
    page_size: u32,
    summary: ActivitySummary,
}

#[derive(Debug, Serialize)]
struct ActivitySummary {
    total: u64,
    active: u64,
    failed: u64,
    completed: u64,
}

#[derive(Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
struct ActivityQuery {
    search: Option<String>,
    kind: Option<ActivityKindFilter>,
    state: Option<ActivityStateFilter>,
    page: Option<u32>,
    page_size: Option<u32>,
}

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
enum ActivityKindFilter {
    Recording,
    Export,
    Download,
    Analysis,
}

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
enum ActivityStateFilter {
    Active,
    Failed,
    Completed,
}

#[derive(Debug, Serialize)]
struct ActivityItem {
    id: String,
    kind: &'static str,
    subtype: Option<String>,
    job_id: Option<String>,
    context_id: Option<String>,
    subject: Option<String>,
    status: &'static str,
    stage: Option<String>,
    progress_percent: Option<u8>,
    completed_units: Option<u64>,
    total_units: Option<u64>,
    unit: Option<&'static str>,
    error: Option<String>,
    created_at: DateTime<Utc>,
    updated_at: DateTime<Utc>,
    available_actions: Vec<&'static str>,
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
        available_actions.push("cancel");
    } else if retryable {
        available_actions.push("retry_recording");
    }
    available_actions.push("open_outputs");
    ActivityItem {
        id: format!("recording:{}", job.id),
        kind: "recording",
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
        unit: completed_units.map(|_| "stages"),
        error,
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
        available_actions.push("cancel");
    }
    available_actions.push("open_outputs");
    ActivityItem {
        id: format!("export:{}", job.id),
        kind: "export",
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
        error: job.error,
        created_at: job.created_at,
        updated_at: job.updated_at,
        available_actions,
    }
}

fn download_activity(job: MatchDownloadJob, retryable: bool) -> ActivityItem {
    let mut available_actions = Vec::with_capacity(2);
    if !job.status.is_terminal() {
        available_actions.push("cancel");
    } else if retryable
        && matches!(
            job.status,
            MatchDownloadStatus::Failed | MatchDownloadStatus::Cancelled
        )
    {
        available_actions.push("retry_download");
    }
    available_actions.push("open_match_history");
    let progress_percent = job
        .total_bytes
        .filter(|total| *total > 0)
        .and_then(|total| rounded_integer_percent(job.downloaded_bytes.min(total), total));
    ActivityItem {
        id: format!("download:{}", job.id),
        kind: "download",
        subtype: None,
        job_id: Some(job.id.to_string()),
        context_id: Some(job.match_record_id.clone()),
        subject: Some(job.match_record_id),
        status: match_download_status(job.status),
        stage: None,
        progress_percent,
        completed_units: Some(job.downloaded_bytes),
        total_units: job.total_bytes,
        unit: Some("bytes"),
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
    if retryable {
        available_actions.push("retry_analysis");
    } else if run.status == AnalysisRunStatus::Completed && result_available {
        available_actions.push("open_analysis");
    }
    available_actions.push("open_library");
    ActivityItem {
        id: format!("analysis:{}", run.id),
        kind: "analysis",
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

const fn job_status(status: JobStatus) -> &'static str {
    match status {
        JobStatus::Queued => "queued",
        JobStatus::Preparing => "preparing",
        JobStatus::Running => "running",
        JobStatus::Cancelling => "cancelling",
        JobStatus::Completed => "completed",
        JobStatus::Failed => "failed",
        JobStatus::Cancelled => "cancelled",
    }
}

const fn match_download_status(status: MatchDownloadStatus) -> &'static str {
    match status {
        MatchDownloadStatus::Queued => "queued",
        MatchDownloadStatus::Downloading => "downloading",
        MatchDownloadStatus::Decompressing => "decompressing",
        MatchDownloadStatus::Importing => "importing",
        MatchDownloadStatus::Completed => "completed",
        MatchDownloadStatus::Cancelling => "cancelling",
        MatchDownloadStatus::Cancelled => "cancelled",
        MatchDownloadStatus::Failed => "failed",
    }
}

const fn analysis_run_status(status: AnalysisRunStatus) -> &'static str {
    match status {
        AnalysisRunStatus::Queued => "queued",
        AnalysisRunStatus::Running => "running",
        AnalysisRunStatus::Completed => "completed",
        AnalysisRunStatus::Failed | AnalysisRunStatus::Interrupted => "failed",
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
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::response::IntoResponse as _;

    #[tokio::test]
    async fn exact_activity_route_returns_the_requested_authoritative_row() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let storage = vibe_cs_storage::Storage::open_in_memory()
            .await
            .expect("storage");
        let now = Utc::now();
        let job_id = Uuid::new_v4();
        storage
            .put_export_job(ExportJobRecord {
                kind: "editor".to_owned(),
                job: vibe_cs_domain::ExportJob {
                    id: job_id,
                    project_id: Uuid::new_v4(),
                    status: JobStatus::Completed,
                    progress: 1.0,
                    output_path: "C:/exports/exact.mp4".to_owned(),
                    error: None,
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
            }],
            current_index: 0,
            progress: 0.0,
            message: "capture interrupted".to_owned(),
            outputs: Vec::new(),
            created_at: now,
            updated_at: now,
        };

        let retryable = recording_activity(&job, true);
        let superseded = recording_activity(&job, false);

        assert_eq!(
            retryable.available_actions,
            vec!["retry_recording", "open_outputs"]
        );
        assert_eq!(superseded.available_actions, vec!["open_outputs"]);
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
            ["open_analysis", "open_library"]
        );
        assert_eq!(without_result.available_actions, ["open_library"]);

        let interrupted = analysis_activity(
            analysis_run(
                AnalysisRunStatus::Interrupted,
                vibe_cs_domain::AnalysisRunStage::Interrupted,
            ),
            "Demo".to_owned(),
            true,
            false,
        );
        assert_eq!(interrupted.status, "failed");
        assert_eq!(interrupted.stage.as_deref(), Some("interrupted"));
        assert_eq!(
            interrupted.available_actions,
            ["retry_analysis", "open_library"]
        );
    }
}
