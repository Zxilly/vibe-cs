use axum::{Json, Router, extract::State, routing::get};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use vibe_cs_domain::{
    DemoRecord, DemoStatus, JobStatus, MatchDownloadJob, MatchDownloadStatus, RecordingJob,
};
use vibe_cs_storage::ExportJobRecord;

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
    let mut items = state
        .storage
        .list_recording_jobs()
        .await?
        .into_iter()
        .map(|job| recording_activity(&job))
        .collect::<Vec<_>>();
    items.extend(
        state
            .storage
            .list_export_jobs(None)
            .await?
            .into_iter()
            .map(export_activity),
    );
    items.extend(
        state
            .storage
            .list_match_download_jobs()
            .await?
            .into_iter()
            .map(download_activity),
    );
    items.extend(
        state
            .storage
            .list_analysis_activity_demos()
            .await?
            .into_iter()
            .map(analysis_activity),
    );
    items.sort_by(|left, right| {
        right
            .updated_at
            .cmp(&left.updated_at)
            .then_with(|| left.id.cmp(&right.id))
    });
    let summary = ActivitySummary {
        total: u64::try_from(items.len()).unwrap_or(u64::MAX),
        active: count_items(&items, |item| !is_terminal_activity(item.status)),
        failed: count_items(&items, |item| item.status == "failed"),
        completed: count_items(&items, |item| item.status == "completed"),
    };
    items.retain(|item| query.matches(item));
    let total = u64::try_from(items.len()).unwrap_or(u64::MAX);
    let offset_u64 = u64::from(page.saturating_sub(1)) * u64::from(page_size);
    let offset = usize::try_from(offset_u64).unwrap_or(usize::MAX);
    let items = items
        .into_iter()
        .skip(offset)
        .take(usize::try_from(page_size).unwrap_or(usize::MAX))
        .collect();
    Ok(Json(ActivityFeed {
        items,
        total,
        page,
        page_size,
        summary,
    }))
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

impl ActivityQuery {
    fn matches(&self, item: &ActivityItem) -> bool {
        if self.kind.is_some_and(|kind| !kind.matches(item.kind)) {
            return false;
        }
        if self.state.is_some_and(|state| !state.matches(item.status)) {
            return false;
        }
        let Some(search) = self
            .search
            .as_deref()
            .map(str::trim)
            .filter(|search| !search.is_empty())
        else {
            return true;
        };
        let search = search.to_lowercase();
        [
            Some(item.id.as_str()),
            Some(item.kind),
            item.subtype.as_deref(),
            item.job_id.as_deref(),
            item.context_id.as_deref(),
            item.subject.as_deref(),
            Some(item.status),
            item.stage.as_deref(),
            item.error.as_deref(),
        ]
        .into_iter()
        .flatten()
        .any(|value| value.to_lowercase().contains(&search))
    }
}

impl ActivityKindFilter {
    fn matches(self, kind: &str) -> bool {
        matches!(
            (self, kind),
            (Self::Recording, "recording")
                | (Self::Export, "export")
                | (Self::Download, "download")
                | (Self::Analysis, "analysis")
        )
    }
}

impl ActivityStateFilter {
    fn matches(self, status: &str) -> bool {
        match self {
            Self::Active => !is_terminal_activity(status),
            Self::Failed => status == "failed",
            Self::Completed => status == "completed",
        }
    }
}

fn count_items(items: &[ActivityItem], predicate: impl Fn(&ActivityItem) -> bool) -> u64 {
    u64::try_from(items.iter().filter(|item| predicate(item)).count()).unwrap_or(u64::MAX)
}

fn is_terminal_activity(status: &str) -> bool {
    matches!(status, "completed" | "failed" | "cancelled")
}

fn recording_activity(job: &RecordingJob) -> ActivityItem {
    let message = (!job.message.trim().is_empty()).then(|| job.message.trim().to_owned());
    let completed_units = message.as_deref().and_then(recording_stage_ordinal);
    let error = (job.status == JobStatus::Failed)
        .then(|| message.clone())
        .flatten();
    let mut available_actions = Vec::with_capacity(2);
    if !job.status.is_terminal() {
        available_actions.push("cancel");
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

fn download_activity(job: MatchDownloadJob) -> ActivityItem {
    let mut available_actions = Vec::with_capacity(2);
    if !job.status.is_terminal() {
        available_actions.push("cancel");
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
