use axum::{Json, Router, extract::State, routing::get};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use vibe_cs_domain::{
    DemoRecord, DemoStatus, JobStatus, MatchDownloadJob, MatchDownloadStatus, RecordingJob,
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
    Router::new().route("/api/activities", get(list_activities))
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
        let item = match source {
            ActivitySource::Recording { job, retryable } => recording_activity(&job, retryable),
            ActivitySource::Export(record) => export_activity(record),
            ActivitySource::Download {
                job,
                retryable,
                owner_steam_id,
            } => {
                let retryable = retryable
                    && retry_account
                        .is_some_and(|steam_id| owner_steam_id.as_deref() == Some(steam_id));
                download_activity(job, retryable)
            }
            ActivitySource::Analysis(demo) => analysis_activity(demo),
        };
        items.push(item);
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

fn analysis_activity(demo: DemoRecord) -> ActivityItem {
    let available_actions = match demo.status {
        DemoStatus::Failed => vec!["retry_analysis", "open_library"],
        DemoStatus::Ready => vec!["open_analysis", "open_library"],
        _ => vec!["open_library"],
    };
    ActivityItem {
        id: format!("analysis:{}", demo.id),
        kind: "analysis",
        subtype: None,
        job_id: None,
        context_id: Some(demo.id.to_string()),
        subject: Some(demo.display_name),
        status: demo_status(demo.status),
        stage: None,
        progress_percent: None,
        completed_units: None,
        total_units: None,
        unit: None,
        // DemoRecord currently persists only the failure state, not the parser error text.
        error: None,
        created_at: demo.created_at,
        updated_at: demo.updated_at,
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

const fn demo_status(status: DemoStatus) -> &'static str {
    match status {
        DemoStatus::Discovered => "discovered",
        DemoStatus::Indexing => "indexing",
        DemoStatus::Ready => "completed",
        DemoStatus::Analyzing => "analyzing",
        DemoStatus::Failed => "failed",
        DemoStatus::Missing => "missing",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use uuid::Uuid;

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
}
