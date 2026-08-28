use ts_rs::TS;

use axum::{
    Json, Router,
    extract::{Path, State},
    http::StatusCode,
    routing::{get, post},
};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest as _, Sha256};
use tokio::time::{Duration, MissedTickBehavior};
use uuid::Uuid;
use vibe_cs_domain::{
    DirectorPlan, DirectorShotKind, HlaeCameraStyle, JobStatus, MatchAnalysis, MediaAsset,
    MediaMetadataStatus, MediaProxyStatus, ProjectChangeAuthor, ProjectEditOperation, ProjectPatch,
    ProjectPatchScope, RecordingJob, RecordingRequest, TimelineClipMaterial,
};
use vibe_cs_recording::{DirectorPolicy, build_director_plan};

use crate::{
    ApiError, ApiJson, ApiResult, AppState,
    state::{RecordingPlanLease, RecordingPlanLeaseState},
};

const ACTIVE_JOB_POLL_INTERVAL: Duration = Duration::from_millis(400);
const ACTIVE_JOB_MISSING_POLL_LIMIT: u32 = 15;
const RECORDING_PLAN_TTL: chrono::Duration = chrono::Duration::minutes(5);
const RECORDING_PLAN_TTL_DURATION: Duration = Duration::from_secs(5 * 60);
const MAXIMUM_RECORDING_PLAN_LEASES: usize = 32;

pub(crate) fn router() -> Router<AppState> {
    Router::new()
        .route(
            "/api/projects/{project_id}/recording-plans/{id}/execute",
            post(execute_plan),
        )
        .route("/api/recording/jobs/{id}", get(get_job))
        .route("/api/recording/jobs/{id}/retry-plan", post(retry_plan))
        .route("/api/recording/jobs/{id}/cancel", post(cancel_job))
        .route("/api/recording/abort", post(abort_active))
}

#[derive(Debug, Clone, Copy, Serialize)]
pub(crate) struct ProjectRecordingSource {
    pub(crate) project_id: Uuid,
}

/// The single recording-plan contract. It is `pub(super)` rather than private
/// because [`create_recording_plan`] is also the entry point the Agent plan
/// route uses; both paths must answer with the same document.
#[derive(Debug, Clone, Serialize, TS)]
#[ts(export)]
pub(crate) struct RecordingPlanResponse {
    plan_id: Uuid,
    expires_at: chrono::DateTime<Utc>,
    active_items: usize,
    disabled_items: usize,
    estimated_seconds: Option<f64>,
    warnings: Vec<String>,
    items: Vec<RecordingRequest>,
    director: DirectorPlan,
}

async fn retry_plan(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> ApiResult<Json<RecordingPlanResponse>> {
    let parent_id = parse_id(&id)?;
    let parent = retryable_recording_parent(&state, parent_id).await?;
    let items = parent.retryable_suffix()?.to_vec();
    let project_source = state
        .storage
        .get_project_recording_run(parent_id)
        .await?
        .map(|project_id| ProjectRecordingSource { project_id });
    create_recording_plan(&state, items, Some(parent_id), project_source).await
}

/// Turns an assembled queue into a leased, preflighted recording plan.
///
/// Every route that produces a recording plan goes through this one function -
/// `/api/recording/plan`, the retry plan, and the Agent plan route in
/// [`super::agent_sessions`]. The director orchestration, the duration
/// estimate, the plan lease and its TTL all live here, so a second caller that
/// reimplemented them would be a second, silently diverging behaviour.
pub(super) async fn create_recording_plan(
    state: &AppState,
    active_items: Vec<RecordingRequest>,
    retry_of: Option<Uuid>,
    project_source: Option<ProjectRecordingSource>,
) -> ApiResult<Json<RecordingPlanResponse>> {
    let mut warnings = Vec::new();
    if active_items.is_empty() {
        return Err(ApiError::invalid(
            "recording queue must contain at least one executable item",
        ));
    }
    let disabled_items = 0;
    let analyses = load_analyses(state, &active_items).await?;
    let director = build_director_plan(&active_items, &analyses, DirectorPolicy::default());
    if retry_of.is_none() && director.unresolved_victim_requests > 0 {
        return Err(ApiError::invalid(
            "the director plan cannot satisfy every requested victim reaction from persisted analysis evidence",
        ));
    }
    // Agent plans already contain the user-visible shot order and identities.
    // Re-directing them here would replace each shot id with a transient queue
    // id, so the resulting Take could no longer bind back to its composition
    // slot. The director remains authoritative for the generic recording queue.
    let executable_items = if retry_of.is_some() || project_source.is_some() {
        active_items.clone()
    } else {
        executable_director_requests(&active_items, &director)
    };
    if executable_items.is_empty() {
        return Err(ApiError::invalid(
            "the director plan did not produce an executable recording shot",
        ));
    }
    let estimated_seconds = estimated_recording_seconds(&executable_items, &analyses);
    if estimated_seconds.is_none() {
        warnings.push(
            "duration unavailable until every Demo has a persisted, valid analyzed tick rate"
                .to_owned(),
        );
    }
    let binding_before_preflight =
        recording_plan_binding(state, &executable_items, retry_of, project_source).await?;
    state.recording.preflight(&executable_items).await?;
    let binding_sha256 =
        recording_plan_binding(state, &executable_items, retry_of, project_source).await?;
    if binding_sha256 != binding_before_preflight {
        return Err(ApiError::new(
            StatusCode::CONFLICT,
            "recording_plan_changed_during_preflight",
            "Recording inputs changed during preflight; create the plan again",
        ));
    }
    let plan_id = Uuid::new_v4();
    let expires_at = Utc::now() + RECORDING_PLAN_TTL;
    let deadline = tokio::time::Instant::now() + RECORDING_PLAN_TTL_DURATION;
    let (transitions, _) = tokio::sync::watch::channel(RecordingPlanLeaseState::Ready);
    // Built once and shared: the lease keeps it so a reload answers the same
    // document, and the caller gets a clone of that same value rather than a
    // second one assembled from the same inputs.
    let response = RecordingPlanResponse {
        plan_id,
        expires_at,
        active_items: active_items.len(),
        disabled_items,
        estimated_seconds,
        warnings,
        items: executable_items.clone(),
        director,
    };
    {
        let mut leases = state.recording_plans.lock().await;
        let now = Utc::now();
        let now_deadline = tokio::time::Instant::now();
        leases.retain(|_, lease| {
            matches!(lease.state, RecordingPlanLeaseState::Starting { .. })
                || (lease.expires_at > now && lease.deadline > now_deadline)
        });
        if leases.len() >= MAXIMUM_RECORDING_PLAN_LEASES {
            return Err(ApiError::new(
                StatusCode::TOO_MANY_REQUESTS,
                "recording_plan_capacity_exhausted",
                "Too many recording plans are active; retry after an existing plan expires",
            ));
        }
        leases.insert(
            plan_id,
            RecordingPlanLease {
                items: executable_items,
                retry_of,
                project_source,
                binding_sha256,
                expires_at,
                deadline,
                state: RecordingPlanLeaseState::Ready,
                transitions,
            },
        );
    }
    Ok(Json(response))
}

#[derive(Serialize)]
struct RecordingPlanDemoBinding {
    demo_id: Uuid,
    path: String,
    content_sha256: Option<String>,
    file_size: u64,
    analysis: Option<MatchAnalysis>,
}

#[derive(Serialize)]
struct RecordingPlanBinding<'a> {
    items: &'a [RecordingRequest],
    recording: &'a vibe_cs_domain::RecordingDefaults,
    cs2_path: &'a str,
    steam_path: &'a str,
    demos: Vec<RecordingPlanDemoBinding>,
    retry: Option<RecordingRetryPlanBinding>,
    project_source: Option<ProjectRecordingSource>,
}

#[derive(Serialize)]
struct RecordingRetryPlanBinding {
    parent_id: Uuid,
    parent_updated_at: chrono::DateTime<Utc>,
    eligible_suffix_sha256: String,
}

async fn retryable_recording_parent(state: &AppState, parent_id: Uuid) -> ApiResult<RecordingJob> {
    state
        .storage
        .get_retryable_recording_job(parent_id)
        .await?
        .ok_or_else(|| {
            ApiError::new(
                StatusCode::CONFLICT,
                "recording_job_not_retryable",
                "Recording job has no unclaimed, identity-proven suffix to retry",
            )
        })
}

async fn recording_plan_binding(
    state: &AppState,
    items: &[RecordingRequest],
    retry_of: Option<Uuid>,
    project_source: Option<ProjectRecordingSource>,
) -> ApiResult<String> {
    let config = state.storage.get_config().await?.unwrap_or_default();
    let mut demo_ids = items.iter().map(|item| item.demo_id).collect::<Vec<_>>();
    demo_ids.sort_unstable();
    demo_ids.dedup();
    let mut demos = Vec::with_capacity(demo_ids.len());
    for demo_id in demo_ids {
        let demo = state
            .storage
            .get_demo(demo_id)
            .await?
            .ok_or_else(|| ApiError::not_found("recording demo"))?;
        let analysis = state.storage.get_analysis(demo_id).await?;
        demos.push(RecordingPlanDemoBinding {
            demo_id,
            path: demo.path,
            content_sha256: demo.content_sha256,
            file_size: demo.file_size,
            analysis,
        });
    }
    let retry = if let Some(parent_id) = retry_of {
        let parent = retryable_recording_parent(state, parent_id).await?;
        let suffix = parent.retryable_suffix()?;
        if suffix != items {
            return Err(ApiError::new(
                StatusCode::CONFLICT,
                "recording_retry_suffix_changed",
                "Recording retry suffix changed; create the retry plan again",
            ));
        }
        let suffix_bytes = serde_json::to_vec(suffix).map_err(|error| {
            ApiError::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                "recording_retry_binding_failed",
                format!("Recording retry binding failed: {error}"),
            )
        })?;
        Some(RecordingRetryPlanBinding {
            parent_id,
            parent_updated_at: parent.updated_at,
            eligible_suffix_sha256: hex::encode(Sha256::digest(suffix_bytes)),
        })
    } else {
        None
    };
    let bytes = serde_json::to_vec(&RecordingPlanBinding {
        items,
        recording: &config.recording,
        cs2_path: &config.cs2_path,
        steam_path: &config.steam_path,
        demos,
        retry,
        project_source,
    })
    .map_err(|error| {
        ApiError::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            "recording_plan_binding_failed",
            format!("Recording plan binding failed: {error}"),
        )
    })?;
    Ok(hex::encode(Sha256::digest(bytes)))
}

fn estimated_recording_seconds(
    items: &[RecordingRequest],
    analyses: &[MatchAnalysis],
) -> Option<f64> {
    let tick_rates = analyses
        .iter()
        .map(|analysis| (analysis.demo_id, analysis.tick_rate))
        .collect::<std::collections::HashMap<_, _>>();
    items.iter().try_fold(0.0, |total, item| {
        let tick_rate = tick_rates.get(&item.demo_id).copied()?;
        if !tick_rate.is_finite() || !(1.0..=256.0).contains(&tick_rate) {
            return None;
        }
        let tick_span = item.end_tick.saturating_sub(item.start_tick);
        let tick_span = u32::try_from(tick_span).ok()?;
        Some(
            total
                + f64::from(tick_span) / tick_rate
                + item.pre_roll_seconds
                + item.post_roll_seconds,
        )
    })
}

#[derive(Debug, Serialize, TS)]
#[ts(export)]
struct RecordingExecutionResponse {
    job_id: Uuid,
    status: &'static str,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ExecuteRecordingPlanRequest {
    offline_insecure_acknowledged: bool,
}

async fn execute_plan(
    State(state): State<AppState>,
    Path((project_id, id)): Path<(Uuid, String)>,
    ApiJson(request): ApiJson<ExecuteRecordingPlanRequest>,
) -> ApiResult<Json<RecordingExecutionResponse>> {
    if !request.offline_insecure_acknowledged {
        return Err(ApiError::new(
            StatusCode::PRECONDITION_REQUIRED,
            "hlae_offline_insecure_acknowledgement_required",
            "Managed HLAE starts a new CS2 process with -insecure for offline Demo playback only; acknowledge this boundary before recording",
        ));
    }
    let plan_id = parse_id(&id)?;
    loop {
        let (job_id, lease, waiter) = {
            let mut leases = state.recording_plans.lock().await;
            let Some(lease) = leases.get(&plan_id) else {
                return Err(ApiError::new(
                    StatusCode::CONFLICT,
                    "recording_plan_unavailable",
                    "Recording plan is missing or no longer available",
                ));
            };
            if lease.project_source.map(|source| source.project_id) != Some(project_id) {
                return Err(ApiError::new(
                    StatusCode::CONFLICT,
                    "recording_plan_project_mismatch",
                    "Recording plan does not belong to this Project",
                ));
            }
            let lease_state = lease.state;
            let expired =
                lease.expires_at <= Utc::now() || lease.deadline <= tokio::time::Instant::now();
            if expired && !matches!(lease_state, RecordingPlanLeaseState::Starting { .. }) {
                leases.remove(&plan_id);
                return Err(ApiError::new(
                    StatusCode::CONFLICT,
                    "recording_plan_expired",
                    "Recording plan expired; create a new plan before recording",
                ));
            }
            let lease = leases
                .get_mut(&plan_id)
                .expect("recording plan existence was checked while holding its lock");
            match lease_state {
                RecordingPlanLeaseState::Ready => {
                    let job_id = Uuid::new_v4();
                    let state = RecordingPlanLeaseState::Starting { job_id };
                    lease.state = state;
                    lease.transitions.send_replace(state);
                    (job_id, Some(lease.clone()), None)
                }
                RecordingPlanLeaseState::Starting { job_id } => {
                    (job_id, None, Some(lease.transitions.subscribe()))
                }
                RecordingPlanLeaseState::Started { job_id } => (job_id, None, None),
            }
        };
        if let Some(mut waiter) = waiter {
            let _ = waiter.changed().await;
            continue;
        }
        let Some(lease) = lease else {
            return existing_recording_execution(&state, job_id).await;
        };
        let mut plan_start = RecordingPlanStartReservation::new(state.clone(), plan_id, job_id);
        let current_binding = match recording_plan_binding(
            &state,
            &lease.items,
            lease.retry_of,
            lease.project_source,
        )
        .await
        {
            Ok(binding) => binding,
            Err(error) => {
                restore_recording_plan(&state, plan_id, job_id).await;
                plan_start.disarm();
                return Err(error);
            }
        };
        if current_binding != lease.binding_sha256 {
            remove_recording_plan(&state, plan_id, job_id).await;
            plan_start.disarm();
            return Err(ApiError::new(
                StatusCode::CONFLICT,
                "recording_plan_stale",
                "Recording plan inputs changed; create a new plan before recording",
            ));
        }
        if lease.deadline <= tokio::time::Instant::now() {
            remove_recording_plan(&state, plan_id, job_id).await;
            plan_start.disarm();
            return Err(ApiError::new(
                StatusCode::CONFLICT,
                "recording_plan_expired",
                "Recording plan expired; create a new plan before recording",
            ));
        }
        let execution = start_recording_job(
            &state,
            job_id,
            lease.items,
            lease.retry_of,
            lease.project_source,
        )
        .await;
        let response = match execution {
            Ok(response) => {
                mark_recording_plan_started(&state, plan_id, job_id).await;
                Ok(response)
            }
            Err(error) => {
                restore_recording_plan(&state, plan_id, job_id).await;
                Err(error)
            }
        };
        plan_start.disarm();
        return response;
    }
}

async fn start_recording_job(
    state: &AppState,
    job_id: Uuid,
    items: Vec<RecordingRequest>,
    retry_of: Option<Uuid>,
    project_source: Option<ProjectRecordingSource>,
) -> ApiResult<Json<RecordingExecutionResponse>> {
    let now = Utc::now();
    let job = RecordingJob {
        id: job_id,
        retry_of,
        status: JobStatus::Queued,
        items,
        current_index: 0,
        progress: 0.0,
        message: "Queued".to_owned(),
        outputs: Vec::new(),
        error_code: None,
        created_at: now,
        updated_at: now,
    };
    let mut reservation = reserve_active_job(state, job.id).await?;

    if let Some(source) = project_source {
        state
            .storage
            .bind_project_recording_run(job.id, source.project_id)
            .await?;
    }

    let job_id = job.id;
    let job = match state.recording.execute(job).await {
        Ok(job) => job,
        Err(error) => {
            clear_active_job(state, job_id).await;
            reservation.disarm();
            return Err(error.into());
        }
    };
    let status = execution_status(job.status);
    if job.status.is_terminal() {
        reconcile_project_recording(state, job.id).await?;
        clear_active_job(state, job.id).await;
    } else {
        spawn_active_job_monitor(state.clone(), job.id);
    }
    reservation.disarm();
    state
        .events
        .publish("recording_job", "changed", Some(job.id));
    Ok(Json(RecordingExecutionResponse {
        job_id: job.id,
        status,
    }))
}

async fn existing_recording_execution(
    state: &AppState,
    job_id: Uuid,
) -> ApiResult<Json<RecordingExecutionResponse>> {
    let job = state
        .storage
        .get_recording_job(job_id)
        .await?
        .ok_or_else(|| {
            ApiError::new(
                StatusCode::SERVICE_UNAVAILABLE,
                "recording_job_not_registered",
                "Recording runtime did not durably register the started job",
            )
        })?;
    let status = execution_status(job.status);
    Ok(Json(RecordingExecutionResponse { job_id, status }))
}

struct RecordingPlanStartReservation {
    state: AppState,
    plan_id: Uuid,
    job_id: Uuid,
    armed: bool,
}

impl RecordingPlanStartReservation {
    fn new(state: AppState, plan_id: Uuid, job_id: Uuid) -> Self {
        Self {
            state,
            plan_id,
            job_id,
            armed: true,
        }
    }

    fn disarm(&mut self) {
        self.armed = false;
    }
}

impl Drop for RecordingPlanStartReservation {
    fn drop(&mut self) {
        if !self.armed {
            return;
        }
        let state = self.state.clone();
        let plan_id = self.plan_id;
        let job_id = self.job_id;
        let Ok(runtime) = tokio::runtime::Handle::try_current() else {
            tracing::error!(%plan_id, %job_id, "unable to reconcile an abandoned recording plan start outside a Tokio runtime");
            return;
        };
        runtime.spawn(async move {
            reconcile_abandoned_recording_plan_start(&state, plan_id, job_id).await;
        });
    }
}

async fn reconcile_abandoned_recording_plan_start(state: &AppState, plan_id: Uuid, job_id: Uuid) {
    match state.storage.get_recording_job(job_id).await {
        Ok(Some(_)) => mark_recording_plan_started(state, plan_id, job_id).await,
        Ok(None) => {
            clear_active_job(state, job_id).await;
            restore_recording_plan(state, plan_id, job_id).await;
        }
        Err(error) => {
            tracing::error!(%error, %plan_id, %job_id, "unable to reconcile an abandoned recording plan start");
            remove_recording_plan(state, plan_id, job_id).await;
        }
    }
}

async fn mark_recording_plan_started(state: &AppState, plan_id: Uuid, job_id: Uuid) {
    let mut leases = state.recording_plans.lock().await;
    if let Some(lease) = leases.get_mut(&plan_id)
        && lease.state == (RecordingPlanLeaseState::Starting { job_id })
    {
        let state = RecordingPlanLeaseState::Started { job_id };
        lease.state = state;
        lease.transitions.send_replace(state);
    }
}

async fn restore_recording_plan(state: &AppState, plan_id: Uuid, job_id: Uuid) {
    let mut leases = state.recording_plans.lock().await;
    if let Some(lease) = leases.get_mut(&plan_id)
        && lease.state == (RecordingPlanLeaseState::Starting { job_id })
    {
        lease.state = RecordingPlanLeaseState::Ready;
        lease
            .transitions
            .send_replace(RecordingPlanLeaseState::Ready);
    }
}

async fn remove_recording_plan(state: &AppState, plan_id: Uuid, job_id: Uuid) {
    let mut leases = state.recording_plans.lock().await;
    if leases
        .get(&plan_id)
        .is_some_and(|lease| lease.state == (RecordingPlanLeaseState::Starting { job_id }))
    {
        leases.remove(&plan_id);
    }
}

async fn load_analyses(
    state: &AppState,
    items: &[RecordingRequest],
) -> ApiResult<Vec<MatchAnalysis>> {
    let mut analyses = Vec::new();
    for demo_id in items
        .iter()
        .map(|item| item.demo_id)
        .collect::<std::collections::HashSet<_>>()
    {
        if let Some(analysis) = state.storage.get_analysis(demo_id).await? {
            analyses.push(analysis);
        }
    }
    Ok(analyses)
}

fn executable_director_requests(
    source: &[RecordingRequest],
    plan: &DirectorPlan,
) -> Vec<RecordingRequest> {
    plan.shots
        .iter()
        .filter_map(|shot| {
            let matching = source.iter().filter(|item| {
                item.demo_id == shot.demo_id
                    && item.start_tick <= shot.end_tick
                    && item.end_tick >= shot.start_tick
                    && (shot.kind == DirectorShotKind::VictimReaction
                        || item.player_id == shot.player_id)
            });
            let mut matching = matching.peekable();
            let first = matching.next()?;
            let mut request = first.clone();
            request.id = Some(Uuid::new_v4());
            request.player_id.clone_from(&shot.player_id);
            request.start_tick = shot.start_tick;
            request.end_tick = shot.end_tick;
            request.victim_pov = false;
            if shot.kind == DirectorShotKind::VictimReaction {
                request.player_id.clone_from(&first.player_id);
                request.victim_pov = true;
                request.camera_style = HlaeCameraStyle::Pov;
                request.title = format!("{} · 受害者反应", request.title);
                request.pre_roll_seconds = 0.0;
                request.post_roll_seconds = 0.0;
            } else if shot.source_item_ids.len() > 1 {
                request.title = format!("{} · 合并镜头", request.title);
            }
            Some(request)
        })
        .collect()
}

async fn get_job(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> ApiResult<Json<RecordingJob>> {
    let job = state
        .storage
        .get_recording_job(parse_id(&id)?)
        .await?
        .ok_or_else(|| ApiError::not_found("recording job"))?;
    if job.status.is_terminal() {
        reconcile_project_recording(&state, job.id).await?;
    }
    Ok(Json(job))
}

async fn cancel_job(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> ApiResult<Json<RecordingJob>> {
    let id = parse_id(&id)?;
    let job = state
        .storage
        .get_recording_job(id)
        .await?
        .ok_or_else(|| ApiError::not_found("recording job"))?;
    if matches!(
        job.status,
        JobStatus::Completed | JobStatus::Failed | JobStatus::Cancelled
    ) {
        clear_active_job(&state, id).await;
        return Err(ApiError::new(
            StatusCode::CONFLICT,
            "job_not_cancellable",
            "Recording job is already terminal",
        ));
    }
    let mut reservation = claim_active_job(&state, id).await?;
    let job = match state.recording.cancel(job).await {
        Ok(job) => job,
        Err(error) => {
            if let Some(reservation) = &mut reservation {
                clear_active_job(&state, id).await;
                reservation.disarm();
            }
            return Err(error.into());
        }
    };
    if job.status.is_terminal() {
        clear_active_job(&state, id).await;
    } else {
        spawn_active_job_monitor(state.clone(), id);
    }
    if let Some(reservation) = &mut reservation {
        reservation.disarm();
    }
    state.storage.put_recording_job(job.clone()).await?;
    if job.status.is_terminal() {
        reconcile_project_recording(&state, job.id).await?;
    }
    state.events.publish("recording_job", "changed", Some(id));
    Ok(Json(job))
}

async fn abort_active(State(state): State<AppState>) -> ApiResult<StatusCode> {
    let id = (*state.active_recording.lock().await).ok_or_else(|| {
        ApiError::new(
            StatusCode::CONFLICT,
            "no_active_job",
            "No recording job is active",
        )
    })?;
    let Some(job) = state.storage.get_recording_job(id).await? else {
        return Err(ApiError::new(
            StatusCode::CONFLICT,
            "recording_job_starting",
            "The active recording job has not started yet",
        ));
    };
    if job.status.is_terminal() {
        clear_active_job(&state, id).await;
        return Err(ApiError::new(
            StatusCode::CONFLICT,
            "job_not_cancellable",
            "Recording job is already terminal",
        ));
    }
    let job = state.recording.cancel(job).await?;
    if job.status.is_terminal() {
        clear_active_job(&state, id).await;
    } else {
        spawn_active_job_monitor(state.clone(), id);
    }
    state.storage.put_recording_job(job.clone()).await?;
    if job.status.is_terminal() {
        reconcile_project_recording(&state, job.id).await?;
    }
    state.events.publish("recording_job", "cancelled", Some(id));
    Ok(StatusCode::NO_CONTENT)
}

fn spawn_active_job_monitor(state: AppState, id: Uuid) {
    tokio::spawn(async move {
        monitor_active_job(
            state,
            id,
            ACTIVE_JOB_POLL_INTERVAL,
            ACTIVE_JOB_MISSING_POLL_LIMIT,
        )
        .await;
    });
}

async fn monitor_active_job(
    state: AppState,
    id: Uuid,
    poll_interval: Duration,
    missing_poll_limit: u32,
) {
    {
        let mut monitors = state.recording_monitors.lock().await;
        if !monitors.insert(id) {
            return;
        }
    }
    let mut interval = tokio::time::interval(poll_interval);
    interval.set_missed_tick_behavior(MissedTickBehavior::Skip);
    let mut missing_polls = 0_u32;
    loop {
        interval.tick().await;
        if *state.active_recording.lock().await != Some(id) {
            break;
        }
        match state.storage.get_recording_job(id).await {
            Ok(Some(job)) if job.status.is_terminal() => {
                if let Err(error) = reconcile_project_recording(&state, job.id).await {
                    tracing::error!(%error, job_id = %job.id, "unable to attach recorded media to Project");
                }
                clear_active_job(&state, id).await;
                state.events.publish("recording_job", "finished", Some(id));
                break;
            }
            Ok(Some(_)) => missing_polls = 0,
            Ok(None) => {
                missing_polls = missing_polls.saturating_add(1);
                if missing_polls >= missing_poll_limit.max(1) {
                    tracing::warn!(%id, "active recording job disappeared from storage");
                    clear_active_job(&state, id).await;
                    break;
                }
            }
            Err(error) => {
                tracing::warn!(%error, %id, "unable to refresh active recording job");
            }
        }
    }
    state.recording_monitors.lock().await.remove(&id);
}

async fn reconcile_project_recording(state: &AppState, job_id: Uuid) -> ApiResult<()> {
    let Some(project_id) = state.storage.get_project_recording_run(job_id).await? else {
        return Ok(());
    };
    let job = state
        .storage
        .get_recording_job(job_id)
        .await?
        .ok_or_else(|| ApiError::not_found("recording job"))?;
    let project = state
        .storage
        .get_project(project_id)
        .await?
        .ok_or_else(|| ApiError::not_found("project"))?;
    let mut replacements = Vec::new();
    for output in &job.outputs {
        let Some(clip_id) = output
            .metadata
            .get("request_id")
            .and_then(Value::as_str)
            .and_then(|value| Uuid::parse_str(value).ok())
        else {
            continue;
        };
        let Some(clip) = project
            .document
            .tracks
            .iter()
            .flat_map(|track| &track.clips)
            .find(|clip| clip.id == clip_id)
        else {
            continue;
        };
        if matches!(clip.material, TimelineClipMaterial::Take { take_id, .. } if take_id == output.id)
        {
            continue;
        }
        let intent = clip
            .capture_intent
            .as_ref()
            .ok_or_else(|| ApiError::invalid(format!("clip {clip_id} lost its Capture Intent")))?;
        let metadata = tokio::fs::metadata(&output.path).await.map_err(|error| {
            ApiError::invalid(format!(
                "recorded media {} is unavailable: {error}",
                output.path
            ))
        })?;
        let asset_id = output.id;
        state
            .storage
            .put_asset(MediaAsset {
                id: asset_id,
                project_id: Some(project.id),
                path: output.path.clone(),
                name: output.title.clone(),
                kind: "video".to_owned(),
                duration_seconds: Some(output.duration_seconds),
                width: None,
                height: None,
                file_size: metadata.len(),
                has_audio: true,
                proxy_path: None,
                proxy_status: MediaProxyStatus::NotRequested,
                waveform: None,
                metadata_status: MediaMetadataStatus::Ready,
                created_at: output.created_at,
            })
            .await?;
        let mut recorded = clip.clone();
        recorded.material = TimelineClipMaterial::Take {
            take_id: output.id,
            asset_id,
            capture_fingerprint: intent.fingerprint()?,
            media_duration_seconds: output.duration_seconds,
        };
        replacements.push(ProjectEditOperation::ReplaceClip {
            clip_id,
            clip: Box::new(recorded),
        });
    }
    if replacements.is_empty() {
        return Ok(());
    }
    state
        .storage
        .apply_project_patch(
            ProjectPatch {
                project_id,
                base_revision: project.revision,
                scope: ProjectPatchScope::Project,
                author: ProjectChangeAuthor::System {
                    operation_id: job_id,
                },
                reverts_change_group_id: None,
                summary: format!("Attach {} recorded Take(s)", replacements.len()),
                operations: replacements,
            },
            Uuid::new_v4(),
            Utc::now(),
        )
        .await?;
    state.events.publish("project", "edited", Some(project_id));
    Ok(())
}

async fn reserve_active_job(state: &AppState, id: Uuid) -> ApiResult<ActiveJobReservation> {
    state.reserve_recording_session(id, false).await?;
    Ok(ActiveJobReservation::new(state.clone(), id))
}

async fn claim_active_job(state: &AppState, id: Uuid) -> ApiResult<Option<ActiveJobReservation>> {
    let acquired = state.reserve_recording_session(id, true).await?;
    Ok(acquired.then(|| ActiveJobReservation::new(state.clone(), id)))
}

struct ActiveJobReservation {
    state: AppState,
    id: Uuid,
    armed: bool,
}

impl ActiveJobReservation {
    fn new(state: AppState, id: Uuid) -> Self {
        Self {
            state,
            id,
            armed: true,
        }
    }

    fn disarm(&mut self) {
        self.armed = false;
    }
}

impl Drop for ActiveJobReservation {
    fn drop(&mut self) {
        if self.armed {
            spawn_active_job_monitor(self.state.clone(), self.id);
        }
    }
}

async fn clear_active_job(state: &AppState, id: Uuid) {
    state.release_recording_session(id).await;
}

// ---------------------------------------------------------------------------
// Pre-recording checks
// ---------------------------------------------------------------------------

/// The managed recordings directory. Mirrors runtime's
/// `RECORDED_CLIP_DIRECTORY`: every published clip is a direct child of
/// `<data dir>/recordings`, and the capture stages its frames on the same
/// volume.
fn parse_id(id: &str) -> ApiResult<Uuid> {
    Uuid::parse_str(id).map_err(|_| ApiError::invalid("id must be a UUID"))
}

const fn execution_status(status: JobStatus) -> &'static str {
    match status {
        JobStatus::Queued | JobStatus::Preparing => "queued",
        JobStatus::Running | JobStatus::Cancelling => "running",
        JobStatus::Completed => "completed",
        JobStatus::Failed => "failed",
        JobStatus::Cancelled => "cancelled",
    }
}
