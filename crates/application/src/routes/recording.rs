use axum::{
    Json, Router,
    extract::{Path, State},
    http::StatusCode,
    routing::{get, post},
};
use chrono::Utc;
use serde::{Deserialize, Deserializer, Serialize};
use sha2::{Digest as _, Sha256};
use tokio::time::{Duration, MissedTickBehavior};
use uuid::Uuid;
use vibe_cs_domain::{
    DirectorPlan, DirectorShotKind, JobStatus, MatchAnalysis, RecordingJob, RecordingRequest,
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
        .route("/api/recording/plan", post(plan))
        .route("/api/recording/plans/{id}/execute", post(execute_plan))
        .route("/api/recording/jobs/{id}", get(get_job))
        .route("/api/recording/jobs/{id}/cancel", post(cancel_job))
        .route("/api/recording/abort", post(abort_active))
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
struct RecordingQueueRequest {
    items: Vec<RecordingQueueItem>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
struct RecordingQueueItem {
    id: String,
    demo_id: String,
    player_id: String,
    title: String,
    #[serde(deserialize_with = "deserialize_required_nullable")]
    highlight_id: Option<String>,
    start_tick: u64,
    end_tick: u64,
    pre_roll_seconds: f64,
    post_roll_seconds: f64,
    victim_pov: bool,
}

fn deserialize_required_nullable<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(deserializer)
}

#[derive(Debug, Serialize)]
struct RecordingPlanResponse {
    plan_id: Uuid,
    expires_at: chrono::DateTime<Utc>,
    active_items: usize,
    disabled_items: usize,
    estimated_seconds: Option<f64>,
    warnings: Vec<String>,
    items: Vec<RecordingRequest>,
    director: DirectorPlan,
}

async fn plan(
    State(state): State<AppState>,
    ApiJson(request): ApiJson<RecordingQueueRequest>,
) -> ApiResult<Json<RecordingPlanResponse>> {
    let mut active_items = Vec::new();
    let mut warnings = Vec::new();
    for (index, item) in request.items.into_iter().enumerate() {
        let item = convert_item(item)
            .map_err(|error| ApiError::invalid(format!("item {}: {error}", index + 1)))?;
        active_items.push(item);
    }
    if active_items.is_empty() {
        return Err(ApiError::invalid(
            "recording queue must contain at least one executable item",
        ));
    }
    let disabled_items = 0;
    let analyses = load_analyses(&state, &active_items).await?;
    let director = build_director_plan(&active_items, &analyses, DirectorPolicy::default());
    if director.unresolved_victim_requests > 0 {
        return Err(ApiError::invalid(
            "the director plan cannot satisfy every requested victim reaction from persisted analysis evidence",
        ));
    }
    let executable_items = executable_director_requests(&active_items, &director);
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
    let binding_before_preflight = recording_plan_binding(&state, &executable_items).await?;
    state.recording.preflight(&executable_items).await?;
    let binding_sha256 = recording_plan_binding(&state, &executable_items).await?;
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
                items: executable_items.clone(),
                binding_sha256,
                expires_at,
                deadline,
                state: RecordingPlanLeaseState::Ready,
                transitions,
            },
        );
    }
    Ok(Json(RecordingPlanResponse {
        plan_id,
        expires_at,
        active_items: active_items.len(),
        disabled_items,
        estimated_seconds,
        warnings,
        items: executable_items,
        director,
    }))
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
}

async fn recording_plan_binding(state: &AppState, items: &[RecordingRequest]) -> ApiResult<String> {
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
    let bytes = serde_json::to_vec(&RecordingPlanBinding {
        items,
        recording: &config.recording,
        cs2_path: &config.cs2_path,
        steam_path: &config.steam_path,
        demos,
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

#[derive(Debug, Serialize)]
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
    Path(id): Path<String>,
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
        let current_binding = match recording_plan_binding(&state, &lease.items).await {
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
        let execution = start_recording_job(&state, job_id, lease.items).await;
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
) -> ApiResult<Json<RecordingExecutionResponse>> {
    let now = Utc::now();
    let job = RecordingJob {
        id: job_id,
        status: JobStatus::Queued,
        items,
        current_index: 0,
        progress: 0.0,
        message: "Queued".to_owned(),
        outputs: Vec::new(),
        created_at: now,
        updated_at: now,
    };
    let mut reservation = reserve_active_job(state, job.id).await?;

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
    state
        .storage
        .get_recording_job(parse_id(&id)?)
        .await?
        .map(Json)
        .ok_or_else(|| ApiError::not_found("recording job"))
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

fn convert_item(item: RecordingQueueItem) -> Result<RecordingRequest, String> {
    let demo_id = Uuid::parse_str(&item.demo_id).map_err(|_| "demo_id must be a UUID")?;
    let request = RecordingRequest {
        id: Some(Uuid::parse_str(&item.id).map_err(|_| "id must be a UUID")?),
        demo_id,
        highlight_id: item.highlight_id,
        player_id: item.player_id,
        title: item.title,
        start_tick: item.start_tick,
        end_tick: item.end_tick,
        pre_roll_seconds: item.pre_roll_seconds,
        post_roll_seconds: item.post_roll_seconds,
        victim_pov: item.victim_pov,
    };
    request.validate().map_err(|error| error.to_string())?;
    Ok(request)
}

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

#[cfg(test)]
mod tests {
    use std::sync::{
        Arc,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    };

    use async_trait::async_trait;
    use axum::response::IntoResponse;
    use vibe_cs_domain::DomainError;

    use super::*;
    use crate::RecordingPort;

    #[derive(Debug, Default)]
    struct CountingRecordingPort {
        preflights: AtomicUsize,
        preflight_items: AtomicUsize,
        fail_preflight: AtomicBool,
        fail_execute: AtomicBool,
        executions: AtomicUsize,
        storage: tokio::sync::Mutex<Option<vibe_cs_storage::Storage>>,
    }

    #[async_trait]
    impl RecordingPort for CountingRecordingPort {
        async fn preflight(&self, items: &[RecordingRequest]) -> Result<(), DomainError> {
            self.preflights.fetch_add(1, Ordering::Relaxed);
            self.preflight_items.store(items.len(), Ordering::Relaxed);
            if self.fail_preflight.load(Ordering::Relaxed) {
                return Err(DomainError::DependencyUnavailable(
                    "managed HLAE is unavailable".to_owned(),
                ));
            }
            Ok(())
        }

        async fn execute(&self, job: RecordingJob) -> Result<RecordingJob, DomainError> {
            self.executions.fetch_add(1, Ordering::Relaxed);
            if self.fail_execute.load(Ordering::Relaxed) {
                return Err(DomainError::DependencyUnavailable(
                    "managed HLAE launch failed".to_owned(),
                ));
            }
            let storage = self.storage.lock().await.clone().ok_or_else(|| {
                DomainError::Internal("test recording storage is not configured".to_owned())
            })?;
            storage
                .put_recording_job(job.clone())
                .await
                .map_err(|error| DomainError::Internal(error.to_string()))?;
            Ok(job)
        }

        async fn cancel(&self, job: RecordingJob) -> Result<RecordingJob, DomainError> {
            Ok(job)
        }
    }

    #[derive(Debug)]
    struct ConfigMutatingPreflightPort {
        storage: vibe_cs_storage::Storage,
    }

    #[async_trait]
    impl RecordingPort for ConfigMutatingPreflightPort {
        async fn preflight(&self, _items: &[RecordingRequest]) -> Result<(), DomainError> {
            let mut config = self
                .storage
                .get_config()
                .await
                .map_err(|error| DomainError::Internal(error.to_string()))?
                .unwrap_or_default();
            config.recording.fps = 30;
            self.storage
                .put_config(config)
                .await
                .map_err(|error| DomainError::Internal(error.to_string()))?;
            Ok(())
        }

        async fn execute(&self, job: RecordingJob) -> Result<RecordingJob, DomainError> {
            Ok(job)
        }

        async fn cancel(&self, job: RecordingJob) -> Result<RecordingJob, DomainError> {
            Ok(job)
        }
    }

    #[derive(Debug)]
    struct FastTerminalRecordingPort {
        storage: vibe_cs_storage::Storage,
    }

    #[async_trait]
    impl RecordingPort for FastTerminalRecordingPort {
        async fn preflight(&self, _items: &[RecordingRequest]) -> Result<(), DomainError> {
            Ok(())
        }

        async fn execute(&self, mut job: RecordingJob) -> Result<RecordingJob, DomainError> {
            let mut persisted = job.clone();
            persisted.status = JobStatus::Completed;
            persisted.progress = 1.0;
            persisted.message = "Completed".to_owned();
            self.storage
                .put_recording_job(persisted)
                .await
                .map_err(|error| DomainError::Internal(error.to_string()))?;
            job.status = JobStatus::Running;
            Ok(job)
        }

        async fn cancel(&self, job: RecordingJob) -> Result<RecordingJob, DomainError> {
            Ok(job)
        }
    }

    #[derive(Debug)]
    struct FirstStartFailsRecordingPort {
        storage: vibe_cs_storage::Storage,
        executions: AtomicUsize,
        first_started: tokio::sync::Notify,
        release_first: tokio::sync::Notify,
    }

    #[async_trait]
    impl RecordingPort for FirstStartFailsRecordingPort {
        async fn preflight(&self, _items: &[RecordingRequest]) -> Result<(), DomainError> {
            Ok(())
        }

        async fn execute(&self, job: RecordingJob) -> Result<RecordingJob, DomainError> {
            if self.executions.fetch_add(1, Ordering::Relaxed) == 0 {
                self.first_started.notify_one();
                self.release_first.notified().await;
                return Err(DomainError::DependencyUnavailable(
                    "first managed HLAE launch failed".to_owned(),
                ));
            }
            self.storage
                .put_recording_job(job.clone())
                .await
                .map_err(|error| DomainError::Internal(error.to_string()))?;
            Ok(job)
        }

        async fn cancel(&self, job: RecordingJob) -> Result<RecordingJob, DomainError> {
            Ok(job)
        }
    }

    #[derive(Debug)]
    struct FirstStartBlocksRecordingPort {
        storage: vibe_cs_storage::Storage,
        executions: AtomicUsize,
        first_started: tokio::sync::Notify,
        release_first: tokio::sync::Notify,
    }

    #[async_trait]
    impl RecordingPort for FirstStartBlocksRecordingPort {
        async fn preflight(&self, _items: &[RecordingRequest]) -> Result<(), DomainError> {
            Ok(())
        }

        async fn execute(&self, job: RecordingJob) -> Result<RecordingJob, DomainError> {
            if self.executions.fetch_add(1, Ordering::Relaxed) == 0 {
                self.first_started.notify_one();
                self.release_first.notified().await;
            }
            self.storage
                .put_recording_job(job.clone())
                .await
                .map_err(|error| DomainError::Internal(error.to_string()))?;
            Ok(job)
        }

        async fn cancel(&self, job: RecordingJob) -> Result<RecordingJob, DomainError> {
            Ok(job)
        }
    }

    async fn state_with_recording(
        recording: Arc<CountingRecordingPort>,
    ) -> (tempfile::TempDir, AppState) {
        let directory = tempfile::tempdir().expect("temporary directory");
        let storage = vibe_cs_storage::Storage::open_in_memory()
            .await
            .expect("storage");
        *recording.storage.lock().await = Some(storage.clone());
        let state = AppState::new(storage, directory.path().to_path_buf())
            .with_recording(recording as Arc<dyn RecordingPort>);
        (directory, state)
    }

    async fn persist_plan_demo(state: &AppState, demo_id: Uuid) {
        let now = Utc::now();
        state
            .storage
            .put_demo(vibe_cs_domain::DemoRecord {
                id: demo_id,
                path: format!("C:/demos/{demo_id}.dem"),
                file_name: format!("{demo_id}.dem"),
                display_name: "Plan fixture".to_owned(),
                source: "test".to_owned(),
                status: vibe_cs_domain::DemoStatus::Ready,
                map_name: Some("de_mirage".to_owned()),
                match_date: None,
                duration_seconds: Some(10.0),
                total_rounds: Some(1),
                team_a_name: None,
                team_b_name: None,
                team_a_score: None,
                team_b_score: None,
                player_names: vec!["Player".to_owned()],
                remark: String::new(),
                content_sha256: Some("ab".repeat(32)),
                file_size: 1_024,
                created_at: now,
                updated_at: now,
            })
            .await
            .expect("plan demo");
        state
            .storage
            .put_analysis(MatchAnalysis {
                demo_id,
                map_name: "de_mirage".to_owned(),
                tick_rate: 64.0,
                duration_seconds: 10.0,
                verified_total_ticks: Some(640),
                teams: Vec::new(),
                players: Vec::new(),
                rounds: Vec::new(),
                highlights: Vec::new(),
            })
            .await
            .expect("plan analysis");
    }

    fn plan_queue_item(demo_id: Uuid) -> RecordingQueueItem {
        RecordingQueueItem {
            id: Uuid::new_v4().to_string(),
            demo_id: demo_id.to_string(),
            player_id: "76561197960690195".to_owned(),
            title: "Planned capture".to_owned(),
            highlight_id: None,
            start_tick: 100,
            end_tick: 200,
            pre_roll_seconds: 0.0,
            post_roll_seconds: 0.0,
            victim_pov: false,
        }
    }

    fn recording_job(id: Uuid, status: JobStatus) -> RecordingJob {
        let now = Utc::now();
        RecordingJob {
            id,
            status,
            items: Vec::new(),
            current_index: 0,
            progress: 0.0,
            message: "test".to_owned(),
            outputs: Vec::new(),
            created_at: now,
            updated_at: now,
        }
    }

    #[test]
    fn recording_queue_items_accept_only_the_current_native_shape() {
        let current = serde_json::json!({
            "id": Uuid::new_v4(),
            "demo_id": Uuid::new_v4(),
            "highlight_id": null,
            "player_id": "76561197960690195",
            "title": "Native capture",
            "start_tick": 100,
            "end_tick": 200,
            "pre_roll_seconds": 1.0,
            "post_roll_seconds": 2.0,
            "victim_pov": false
        });
        serde_json::from_value::<RecordingQueueItem>(current.clone())
            .expect("current recording queue item");

        for required in [
            "id",
            "highlight_id",
            "player_id",
            "title",
            "pre_roll_seconds",
            "post_roll_seconds",
            "victim_pov",
        ] {
            let mut incomplete = current.clone();
            incomplete
                .as_object_mut()
                .expect("recording item object")
                .remove(required);
            assert!(
                serde_json::from_value::<RecordingQueueItem>(incomplete).is_err(),
                "missing {required} must be rejected"
            );
        }

        for retired in ["client_id", "demo_name", "player_name", "perspective"] {
            let mut invalid = current.clone();
            invalid[retired] = serde_json::json!("retired");
            assert!(
                serde_json::from_value::<RecordingQueueItem>(invalid).is_err(),
                "retired field {retired} must be rejected"
            );
        }
    }

    #[test]
    fn plan_rejects_inverted_ticks() {
        let item = RecordingQueueItem {
            id: Uuid::new_v4().to_string(),
            demo_id: Uuid::new_v4().to_string(),
            player_id: "Player".to_owned(),
            title: "Player".to_owned(),
            highlight_id: None,
            start_tick: 20,
            end_tick: 10,
            pre_roll_seconds: 0.0,
            post_roll_seconds: 0.0,
            victim_pov: false,
        };
        assert!(convert_item(item).is_err());
    }

    #[test]
    fn converted_native_capture_item_has_no_retired_feature_fields() {
        let request = convert_item(RecordingQueueItem {
            id: Uuid::new_v4().to_string(),
            demo_id: Uuid::new_v4().to_string(),
            player_id: "76561197960690195".to_owned(),
            title: "Native capture".to_owned(),
            highlight_id: None,
            start_tick: 100,
            end_tick: 200,
            pre_roll_seconds: 0.0,
            post_roll_seconds: 0.0,
            victim_pov: false,
        })
        .expect("current native contract");

        let wire = serde_json::to_value(request).expect("recording response wire");
        for retired in ["playback_speed", "show_keyboard", "show_kill_fx", "fade"] {
            assert!(wire.get(retired).is_none());
        }
    }

    #[test]
    fn executable_director_plan_merges_main_shots_and_materializes_victim_target() {
        let demo_id = Uuid::new_v4();
        let source_id = Uuid::new_v4();
        let source = RecordingRequest {
            id: Some(source_id),
            demo_id,
            highlight_id: Some("h1".to_owned()),
            player_id: "76561198000000000".to_owned(),
            title: "multi kill".to_owned(),
            start_tick: 100,
            end_tick: 300,
            pre_roll_seconds: 3.0,
            post_roll_seconds: 2.0,
            victim_pov: true,
        };
        let plan = DirectorPlan {
            shots: vec![
                vibe_cs_domain::DirectorShot {
                    demo_id,
                    source_item_ids: vec![source_id, Uuid::new_v4()],
                    player_id: source.player_id.clone(),
                    kind: DirectorShotKind::Player,
                    start_tick: 100,
                    end_tick: 300,
                    score: 0.9,
                    evidence: vec!["h1".to_owned()],
                    explanation: "merged".to_owned(),
                },
                vibe_cs_domain::DirectorShot {
                    demo_id,
                    source_item_ids: vec![source_id],
                    player_id: "76561198000000001".to_owned(),
                    kind: DirectorShotKind::VictimReaction,
                    start_tick: 240,
                    end_tick: 300,
                    score: 0.9,
                    evidence: vec!["victim".to_owned()],
                    explanation: "reaction".to_owned(),
                },
            ],
            warnings: Vec::new(),
            source_item_count: 1,
            merged_item_count: 1,
            victim_reaction_count: 1,
            unresolved_victim_requests: 0,
        };
        let requests = executable_director_requests(&[source], &plan);
        assert_eq!(requests.len(), 2);
        assert_eq!(requests[0].player_id, "76561198000000000");
        assert!(requests[0].title.contains("合并镜头"));
        assert_eq!(requests[1].player_id, "76561198000000000");
        assert!(requests[1].victim_pov);
        assert!(requests[1].pre_roll_seconds.abs() < f64::EPSILON);
    }

    #[test]
    fn plan_uses_the_persisted_demo_tick_rate_for_its_duration() {
        let demo_id = Uuid::new_v4();
        let request = RecordingRequest {
            id: None,
            demo_id,
            highlight_id: None,
            player_id: "76561197960690195".to_owned(),
            title: "Player".to_owned(),
            start_tick: 0,
            end_tick: 640,
            pre_roll_seconds: 1.0,
            post_roll_seconds: 2.0,
            victim_pov: false,
        };
        let analysis = MatchAnalysis {
            demo_id,
            map_name: "de_mirage".to_owned(),
            tick_rate: 128.0,
            duration_seconds: 10.0,
            verified_total_ticks: Some(1_280),
            teams: Vec::new(),
            players: Vec::new(),
            rounds: Vec::new(),
            highlights: Vec::new(),
        };

        let estimated = estimated_recording_seconds(&[request], &[analysis])
            .expect("valid persisted tick rate");
        assert!((estimated - 8.0).abs() < f64::EPSILON);
    }

    #[tokio::test]
    async fn plan_preflights_the_director_normalized_shots() {
        let recording = Arc::new(CountingRecordingPort::default());
        let (_directory, state) = state_with_recording(Arc::clone(&recording)).await;
        let demo_uuid = Uuid::new_v4();
        persist_plan_demo(&state, demo_uuid).await;
        let demo_id = demo_uuid.to_string();
        let first = RecordingQueueItem {
            id: Uuid::new_v4().to_string(),
            demo_id: demo_id.clone(),
            player_id: "76561197960690195".to_owned(),
            title: "First".to_owned(),
            highlight_id: None,
            start_tick: 100,
            end_tick: 200,
            pre_roll_seconds: 0.0,
            post_roll_seconds: 0.0,
            victim_pov: false,
        };
        let mut second = first.clone();
        second.id = Uuid::new_v4().to_string();
        second.title = "Second".to_owned();
        second.start_tick = 220;
        second.end_tick = 300;

        let response = plan(
            State(state.clone()),
            ApiJson(RecordingQueueRequest {
                items: vec![first, second],
            }),
        )
        .await
        .expect("director-normalized plan");

        assert_eq!(recording.preflights.load(Ordering::Relaxed), 1);
        assert_eq!(recording.preflight_items.load(Ordering::Relaxed), 1);
        assert_eq!(response.0.items.len(), 1);
        assert!(
            state
                .recording_plans
                .lock()
                .await
                .contains_key(&response.0.plan_id)
        );
    }

    #[tokio::test]
    async fn concurrent_execution_attempts_share_one_job_identity() {
        let recording = Arc::new(CountingRecordingPort::default());
        let (_directory, state) = state_with_recording(Arc::clone(&recording)).await;
        let demo_id = Uuid::new_v4();
        persist_plan_demo(&state, demo_id).await;
        let planned = plan(
            State(state.clone()),
            ApiJson(RecordingQueueRequest {
                items: vec![plan_queue_item(demo_id)],
            }),
        )
        .await
        .expect("recording plan");
        let plan_id = planned.0.plan_id.to_string();

        let (first, second) = tokio::join!(
            execute_plan(
                State(state.clone()),
                Path(plan_id.clone()),
                ApiJson(ExecuteRecordingPlanRequest {
                    offline_insecure_acknowledged: true,
                }),
            ),
            execute_plan(
                State(state),
                Path(plan_id),
                ApiJson(ExecuteRecordingPlanRequest {
                    offline_insecure_acknowledged: true,
                }),
            ),
        );

        let first = first.expect("first execution");
        let second = second.expect("idempotent concurrent execution");
        assert_eq!(first.0.job_id, second.0.job_id);
        assert_eq!(recording.executions.load(Ordering::Relaxed), 1);
    }

    #[tokio::test]
    async fn plan_capacity_never_evicts_a_starting_lease() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let storage = vibe_cs_storage::Storage::open_in_memory()
            .await
            .expect("storage");
        let recording = Arc::new(FirstStartBlocksRecordingPort {
            storage: storage.clone(),
            executions: AtomicUsize::new(0),
            first_started: tokio::sync::Notify::new(),
            release_first: tokio::sync::Notify::new(),
        });
        let state = AppState::new(storage, directory.path().to_path_buf())
            .with_recording(Arc::clone(&recording) as Arc<dyn RecordingPort>);
        let demo_id = Uuid::new_v4();
        persist_plan_demo(&state, demo_id).await;
        let first_plan = plan(
            State(state.clone()),
            ApiJson(RecordingQueueRequest {
                items: vec![plan_queue_item(demo_id)],
            }),
        )
        .await
        .expect("first recording plan");
        let first_plan_id = first_plan.0.plan_id.to_string();

        let first_state = state.clone();
        let first_execute_plan_id = first_plan_id.clone();
        let first_execution = tokio::spawn(async move {
            execute_plan(
                State(first_state),
                Path(first_execute_plan_id),
                ApiJson(ExecuteRecordingPlanRequest {
                    offline_insecure_acknowledged: true,
                }),
            )
            .await
        });
        recording.first_started.notified().await;

        for _ in 1..MAXIMUM_RECORDING_PLAN_LEASES {
            let _ = plan(
                State(state.clone()),
                ApiJson(RecordingQueueRequest {
                    items: vec![plan_queue_item(demo_id)],
                }),
            )
            .await
            .expect("capacity fixture plan");
        }
        let error = plan(
            State(state.clone()),
            ApiJson(RecordingQueueRequest {
                items: vec![plan_queue_item(demo_id)],
            }),
        )
        .await
        .expect_err("a full lease table must reject a new plan");
        let response = error.into_response();
        assert_eq!(response.status(), StatusCode::TOO_MANY_REQUESTS);
        let body = axum::body::to_bytes(response.into_body(), 4 * 1024)
            .await
            .expect("capacity error body");
        let problem: vibe_cs_domain::ErrorBody =
            serde_json::from_slice(&body).expect("capacity error payload");
        assert_eq!(problem.code, "recording_plan_capacity_exhausted");

        recording.release_first.notify_one();
        let first_execution = tokio::time::timeout(Duration::from_secs(1), first_execution)
            .await
            .expect("first execution completes")
            .expect("first execution task")
            .expect("first execution response");
        let replay = execute_plan(
            State(state),
            Path(first_plan_id),
            ApiJson(ExecuteRecordingPlanRequest {
                offline_insecure_acknowledged: true,
            }),
        )
        .await
        .expect("the retained starting lease remains idempotent");

        assert_eq!(replay.0.job_id, first_execution.0.job_id);
        assert_eq!(recording.executions.load(Ordering::Relaxed), 1);
    }

    #[tokio::test]
    async fn concurrent_caller_waits_for_failed_start_then_retries_the_ready_plan() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let storage = vibe_cs_storage::Storage::open_in_memory()
            .await
            .expect("storage");
        let recording = Arc::new(FirstStartFailsRecordingPort {
            storage: storage.clone(),
            executions: AtomicUsize::new(0),
            first_started: tokio::sync::Notify::new(),
            release_first: tokio::sync::Notify::new(),
        });
        let state = AppState::new(storage, directory.path().to_path_buf())
            .with_recording(Arc::clone(&recording) as Arc<dyn RecordingPort>);
        let demo_id = Uuid::new_v4();
        persist_plan_demo(&state, demo_id).await;
        let planned = plan(
            State(state.clone()),
            ApiJson(RecordingQueueRequest {
                items: vec![plan_queue_item(demo_id)],
            }),
        )
        .await
        .expect("recording plan");
        let plan_id = planned.0.plan_id.to_string();

        let first_state = state.clone();
        let first_plan_id = plan_id.clone();
        let first = tokio::spawn(async move {
            execute_plan(
                State(first_state),
                Path(first_plan_id),
                ApiJson(ExecuteRecordingPlanRequest {
                    offline_insecure_acknowledged: true,
                }),
            )
            .await
        });
        recording.first_started.notified().await;

        let second_state = state.clone();
        let mut second = tokio::spawn(async move {
            execute_plan(
                State(second_state),
                Path(plan_id),
                ApiJson(ExecuteRecordingPlanRequest {
                    offline_insecure_acknowledged: true,
                }),
            )
            .await
        });
        tokio::select! {
            result = &mut second => {
                panic!("the concurrent caller returned before the first start resolved: {result:?}");
            }
            () = tokio::time::sleep(Duration::from_millis(25)) => {}
        }

        recording.release_first.notify_one();
        first
            .await
            .expect("first execution task")
            .expect_err("the first start fails");
        let retried = tokio::time::timeout(Duration::from_secs(1), second)
            .await
            .expect("the waiting caller is notified")
            .expect("second execution task")
            .expect("the waiting caller retries the ready plan");
        let persisted = state
            .storage
            .get_recording_job(retried.0.job_id)
            .await
            .expect("stored job")
            .expect("the retry returned a real durable job");

        assert_eq!(persisted.id, retried.0.job_id);
        assert_eq!(recording.executions.load(Ordering::Relaxed), 2);
    }

    #[tokio::test]
    async fn dropped_starter_without_a_durable_job_restores_the_plan_and_wakes_waiters() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let storage = vibe_cs_storage::Storage::open_in_memory()
            .await
            .expect("storage");
        let recording = Arc::new(FirstStartFailsRecordingPort {
            storage: storage.clone(),
            executions: AtomicUsize::new(0),
            first_started: tokio::sync::Notify::new(),
            release_first: tokio::sync::Notify::new(),
        });
        let state = AppState::new(storage, directory.path().to_path_buf())
            .with_recording(Arc::clone(&recording) as Arc<dyn RecordingPort>);
        let demo_id = Uuid::new_v4();
        persist_plan_demo(&state, demo_id).await;
        let planned = plan(
            State(state.clone()),
            ApiJson(RecordingQueueRequest {
                items: vec![plan_queue_item(demo_id)],
            }),
        )
        .await
        .expect("recording plan");
        let plan_id = planned.0.plan_id.to_string();

        let first_state = state.clone();
        let first_plan_id = plan_id.clone();
        let first = tokio::spawn(async move {
            execute_plan(
                State(first_state),
                Path(first_plan_id),
                ApiJson(ExecuteRecordingPlanRequest {
                    offline_insecure_acknowledged: true,
                }),
            )
            .await
        });
        recording.first_started.notified().await;

        let second_state = state.clone();
        let mut second = tokio::spawn(async move {
            execute_plan(
                State(second_state),
                Path(plan_id),
                ApiJson(ExecuteRecordingPlanRequest {
                    offline_insecure_acknowledged: true,
                }),
            )
            .await
        });
        tokio::select! {
            result = &mut second => {
                panic!("the waiter returned before the starter was dropped: {result:?}");
            }
            () = tokio::time::sleep(Duration::from_millis(25)) => {}
        }

        first.abort();
        assert!(
            first
                .await
                .expect_err("the first handler is cancelled")
                .is_cancelled(),
            "the first handler should be dropped at its pending runtime start"
        );
        let Ok(result) = tokio::time::timeout(Duration::from_secs(1), &mut second).await else {
            second.abort();
            let _ = second.await;
            panic!("the waiting caller was never released from the abandoned start");
        };
        let retried = result
            .expect("waiting execution task")
            .expect("waiting caller retries the restored plan");
        let persisted = state
            .storage
            .get_recording_job(retried.0.job_id)
            .await
            .expect("stored job")
            .expect("retry returned a durable job");

        assert_eq!(persisted.id, retried.0.job_id);
        assert_eq!(recording.executions.load(Ordering::Relaxed), 2);
    }

    #[tokio::test]
    async fn plan_does_not_report_success_when_runtime_preflight_fails() {
        let recording = Arc::new(CountingRecordingPort::default());
        recording.fail_preflight.store(true, Ordering::Relaxed);
        let (_directory, state) = state_with_recording(Arc::clone(&recording)).await;
        let demo_id = Uuid::new_v4();
        persist_plan_demo(&state, demo_id).await;

        let error = plan(
            State(state),
            ApiJson(RecordingQueueRequest {
                items: vec![RecordingQueueItem {
                    id: Uuid::new_v4().to_string(),
                    demo_id: demo_id.to_string(),
                    player_id: "76561197960690195".to_owned(),
                    title: "Unavailable capture".to_owned(),
                    highlight_id: None,
                    start_tick: 100,
                    end_tick: 200,
                    pre_roll_seconds: 0.0,
                    post_roll_seconds: 0.0,
                    victim_pov: false,
                }],
            }),
        )
        .await
        .expect_err("failed runtime preflight must fail the plan request");

        assert_eq!(
            error.into_response().status(),
            StatusCode::SERVICE_UNAVAILABLE
        );
        assert_eq!(recording.preflights.load(Ordering::Relaxed), 1);
        assert_eq!(recording.executions.load(Ordering::Relaxed), 0);
    }

    #[tokio::test]
    async fn plan_rejects_inputs_that_change_during_preflight() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let storage = vibe_cs_storage::Storage::open_in_memory()
            .await
            .expect("storage");
        let recording = Arc::new(ConfigMutatingPreflightPort {
            storage: storage.clone(),
        });
        let state =
            AppState::new(storage, directory.path().to_path_buf()).with_recording(recording);
        let demo_id = Uuid::new_v4();
        persist_plan_demo(&state, demo_id).await;

        let error = plan(
            State(state.clone()),
            ApiJson(RecordingQueueRequest {
                items: vec![plan_queue_item(demo_id)],
            }),
        )
        .await
        .expect_err("a plan must bind the same inputs it preflighted");

        assert_eq!(error.into_response().status(), StatusCode::CONFLICT);
        assert!(state.recording_plans.lock().await.is_empty());
    }

    #[tokio::test]
    async fn planned_execution_is_idempotent_for_the_server_normalized_lease() {
        let recording = Arc::new(CountingRecordingPort::default());
        let (_directory, state) = state_with_recording(Arc::clone(&recording)).await;
        let demo_id = Uuid::new_v4();
        persist_plan_demo(&state, demo_id).await;
        let planned = plan(
            State(state.clone()),
            ApiJson(RecordingQueueRequest {
                items: vec![plan_queue_item(demo_id)],
            }),
        )
        .await
        .expect("recording plan");

        let executed = execute_plan(
            State(state.clone()),
            Path(planned.0.plan_id.to_string()),
            ApiJson(ExecuteRecordingPlanRequest {
                offline_insecure_acknowledged: true,
            }),
        )
        .await
        .expect("leased execution");
        assert_eq!(executed.0.status, "queued");
        assert_eq!(recording.executions.load(Ordering::Relaxed), 1);
        assert_eq!(
            recording.preflights.load(Ordering::Relaxed),
            1,
            "the runtime execute boundary owns authoritative revalidation"
        );

        let replay = execute_plan(
            State(state),
            Path(planned.0.plan_id.to_string()),
            ApiJson(ExecuteRecordingPlanRequest {
                offline_insecure_acknowledged: true,
            }),
        )
        .await
        .expect("a started plan returns its original job identity");
        assert_eq!(replay.0.job_id, executed.0.job_id);
        assert_eq!(recording.executions.load(Ordering::Relaxed), 1);
    }

    #[tokio::test]
    async fn failed_start_restores_the_plan_for_a_retry() {
        let recording = Arc::new(CountingRecordingPort::default());
        let (_directory, state) = state_with_recording(Arc::clone(&recording)).await;
        let demo_id = Uuid::new_v4();
        persist_plan_demo(&state, demo_id).await;
        let planned = plan(
            State(state.clone()),
            ApiJson(RecordingQueueRequest {
                items: vec![plan_queue_item(demo_id)],
            }),
        )
        .await
        .expect("recording plan");
        recording.fail_execute.store(true, Ordering::Relaxed);

        execute_plan(
            State(state.clone()),
            Path(planned.0.plan_id.to_string()),
            ApiJson(ExecuteRecordingPlanRequest {
                offline_insecure_acknowledged: true,
            }),
        )
        .await
        .expect_err("the first launch fails before recording starts");
        recording.fail_execute.store(false, Ordering::Relaxed);

        let retried = execute_plan(
            State(state),
            Path(planned.0.plan_id.to_string()),
            ApiJson(ExecuteRecordingPlanRequest {
                offline_insecure_acknowledged: true,
            }),
        )
        .await
        .expect("the same plan can retry a failed start");
        assert_eq!(retried.0.status, "queued");
        assert_eq!(recording.executions.load(Ordering::Relaxed), 2);
    }

    #[tokio::test]
    async fn application_does_not_overwrite_a_fast_runtime_terminal_state() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let storage = vibe_cs_storage::Storage::open_in_memory()
            .await
            .expect("storage");
        let recording = Arc::new(FastTerminalRecordingPort {
            storage: storage.clone(),
        });
        let state =
            AppState::new(storage, directory.path().to_path_buf()).with_recording(recording);
        let demo_id = Uuid::new_v4();
        persist_plan_demo(&state, demo_id).await;
        let planned = plan(
            State(state.clone()),
            ApiJson(RecordingQueueRequest {
                items: vec![plan_queue_item(demo_id)],
            }),
        )
        .await
        .expect("recording plan");

        let execution = execute_plan(
            State(state.clone()),
            Path(planned.0.plan_id.to_string()),
            ApiJson(ExecuteRecordingPlanRequest {
                offline_insecure_acknowledged: true,
            }),
        )
        .await
        .expect("recording execution");
        let persisted = state
            .storage
            .get_recording_job(execution.0.job_id)
            .await
            .expect("stored job")
            .expect("durably registered job");

        assert_eq!(persisted.status, JobStatus::Completed);
        assert!((persisted.progress - 1.0).abs() < f64::EPSILON);
    }

    #[tokio::test]
    async fn planned_execution_rejects_changed_recording_configuration() {
        let recording = Arc::new(CountingRecordingPort::default());
        let (_directory, state) = state_with_recording(Arc::clone(&recording)).await;
        let demo_id = Uuid::new_v4();
        persist_plan_demo(&state, demo_id).await;
        let planned = plan(
            State(state.clone()),
            ApiJson(RecordingQueueRequest {
                items: vec![plan_queue_item(demo_id)],
            }),
        )
        .await
        .expect("recording plan");
        let mut config = state
            .storage
            .get_config()
            .await
            .expect("config")
            .unwrap_or_default();
        config.recording.fps = 30;
        state
            .storage
            .put_config(config)
            .await
            .expect("changed config");

        let error = execute_plan(
            State(state),
            Path(planned.0.plan_id.to_string()),
            ApiJson(ExecuteRecordingPlanRequest {
                offline_insecure_acknowledged: true,
            }),
        )
        .await
        .expect_err("stale plan must not execute");
        assert_eq!(error.into_response().status(), StatusCode::CONFLICT);
        assert_eq!(recording.executions.load(Ordering::Relaxed), 0);
    }

    #[tokio::test]
    async fn planned_execution_uses_a_monotonic_deadline_and_removes_expired_plans() {
        let recording = Arc::new(CountingRecordingPort::default());
        let (_directory, state) = state_with_recording(Arc::clone(&recording)).await;
        let demo_id = Uuid::new_v4();
        persist_plan_demo(&state, demo_id).await;
        let planned = plan(
            State(state.clone()),
            ApiJson(RecordingQueueRequest {
                items: vec![plan_queue_item(demo_id)],
            }),
        )
        .await
        .expect("recording plan");
        state
            .recording_plans
            .lock()
            .await
            .get_mut(&planned.0.plan_id)
            .expect("plan lease")
            .deadline = tokio::time::Instant::now() - Duration::from_millis(1);

        let error = execute_plan(
            State(state.clone()),
            Path(planned.0.plan_id.to_string()),
            ApiJson(ExecuteRecordingPlanRequest {
                offline_insecure_acknowledged: true,
            }),
        )
        .await
        .expect_err("an expired monotonic lease must not launch recording");

        assert_eq!(error.into_response().status(), StatusCode::CONFLICT);
        assert_eq!(recording.executions.load(Ordering::Relaxed), 0);
        assert!(
            !state
                .recording_plans
                .lock()
                .await
                .contains_key(&planned.0.plan_id)
        );
    }

    #[tokio::test]
    async fn planned_execution_requires_explicit_offline_insecure_acknowledgement() {
        let recording = Arc::new(CountingRecordingPort::default());
        let (_directory, state) = state_with_recording(Arc::clone(&recording)).await;
        let demo_id = Uuid::new_v4();
        persist_plan_demo(&state, demo_id).await;
        let planned = plan(
            State(state.clone()),
            ApiJson(RecordingQueueRequest {
                items: vec![plan_queue_item(demo_id)],
            }),
        )
        .await
        .expect("recording plan");

        let error = execute_plan(
            State(state.clone()),
            Path(planned.0.plan_id.to_string()),
            ApiJson(ExecuteRecordingPlanRequest {
                offline_insecure_acknowledged: false,
            }),
        )
        .await
        .expect_err("launching HLAE must require an explicit acknowledgement");
        assert_eq!(
            error.into_response().status(),
            StatusCode::PRECONDITION_REQUIRED
        );
        assert_eq!(recording.executions.load(Ordering::Relaxed), 0);
        assert!(
            state
                .recording_plans
                .lock()
                .await
                .contains_key(&planned.0.plan_id),
            "declining the warning must not consume the one-shot plan"
        );
    }

    #[tokio::test]
    async fn plan_fails_explicitly_when_recording_runtime_is_disabled() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let storage = vibe_cs_storage::Storage::open_in_memory()
            .await
            .expect("storage");
        let state = AppState::new(storage, directory.path().to_path_buf());
        let demo_id = Uuid::new_v4();
        persist_plan_demo(&state, demo_id).await;

        let error = plan(
            State(state),
            ApiJson(RecordingQueueRequest {
                items: vec![RecordingQueueItem {
                    id: Uuid::new_v4().to_string(),
                    demo_id: demo_id.to_string(),
                    player_id: "76561197960690195".to_owned(),
                    title: "Disabled runtime".to_owned(),
                    highlight_id: None,
                    start_tick: 100,
                    end_tick: 200,
                    pre_roll_seconds: 0.0,
                    post_roll_seconds: 0.0,
                    victim_pov: false,
                }],
            }),
        )
        .await
        .expect_err("disabled runtime must never report a valid recording plan");

        assert_eq!(
            error.into_response().status(),
            StatusCode::SERVICE_UNAVAILABLE
        );
    }

    #[tokio::test]
    async fn plan_rejects_the_whole_request_when_any_enabled_item_is_invalid() {
        let recording = Arc::new(CountingRecordingPort::default());
        let (_directory, state) = state_with_recording(recording).await;
        let valid = RecordingQueueItem {
            id: Uuid::new_v4().to_string(),
            demo_id: Uuid::new_v4().to_string(),
            player_id: "76561197960690195".to_owned(),
            title: "Valid".to_owned(),
            highlight_id: None,
            start_tick: 100,
            end_tick: 200,
            pre_roll_seconds: 0.0,
            post_roll_seconds: 0.0,
            victim_pov: false,
        };
        let mut invalid = valid.clone();
        invalid.end_tick = invalid.start_tick.saturating_sub(1);

        let error = plan(
            State(state),
            ApiJson(RecordingQueueRequest {
                items: vec![valid, invalid],
            }),
        )
        .await
        .expect_err("plan must never hide an invalid enabled item as a warning");
        assert_eq!(error.into_response().status(), StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn monitor_deduplicates_and_clears_a_terminal_job_once() {
        let recording = Arc::new(CountingRecordingPort::default());
        let (_directory, state) = state_with_recording(recording).await;
        let id = Uuid::new_v4();
        state
            .storage
            .put_recording_job(recording_job(id, JobStatus::Completed))
            .await
            .expect("job");
        *state.active_recording.lock().await = Some(id);
        let mut events = state.events.subscribe();

        tokio::join!(
            monitor_active_job(state.clone(), id, Duration::from_millis(1), 2),
            monitor_active_job(state.clone(), id, Duration::from_millis(1), 2),
        );

        assert_eq!(*state.active_recording.lock().await, None);
        assert!(state.recording_monitors.lock().await.is_empty());
        let event = events.try_recv().expect("finished event");
        assert_eq!(event.action, "finished");
        assert!(events.try_recv().is_err());
    }

    #[tokio::test]
    async fn monitor_clears_a_missing_job_only_after_its_grace_period() {
        let recording = Arc::new(CountingRecordingPort::default());
        let (_directory, state) = state_with_recording(recording).await;
        let id = Uuid::new_v4();
        *state.active_recording.lock().await = Some(id);

        monitor_active_job(state.clone(), id, Duration::from_millis(1), 3).await;

        assert_eq!(*state.active_recording.lock().await, None);
        assert!(state.recording_monitors.lock().await.is_empty());
    }
}
