use std::{
    collections::{HashMap, HashSet},
    io::{Read as _, Write as _},
    path::{Path as FilePath, PathBuf},
    sync::Arc,
};
use ts_rs::TS;

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
    DemoRecord, DirectorPlan, DirectorShotKind, HlaeCameraStyle, JobStatus, MatchAnalysis,
    RECORDING_PREFLIGHT_MAX_AFFECTED_ITEMS, RECORDING_PREFLIGHT_MAX_DETAIL_CHARS, RecordingJob,
    RecordingPreflight, RecordingPreflightCheck, RecordingPreflightCode, RecordingPreflightState,
    RecordingPresentation, RecordingRequest,
};
use vibe_cs_hlae::{CaptureLayers, CaptureSettings, estimate_hlae_capture_span_resources};
use vibe_cs_platform_windows::{
    HlaeSequenceEncoderCapabilityReport, probe_hlae_sequence_encoder_capabilities,
    recommended_hlae_staging_safety_reserve,
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
        .route("/api/recording/plans/{id}", get(get_plan))
        .route("/api/recording/plans/{id}/execute", post(execute_plan))
        .route("/api/recording/plans/{id}/preflight", post(preflight_plan))
        .route("/api/recording/jobs/{id}", get(get_job))
        .route("/api/recording/jobs/{id}/retry-plan", post(retry_plan))
        .route("/api/recording/jobs/{id}/cancel", post(cancel_job))
        .route("/api/recording/abort", post(abort_active))
}

#[derive(Debug, Clone, Deserialize, TS)]
#[serde(deny_unknown_fields)]
#[ts(export)]
struct RecordingQueueRequest {
    items: Vec<RecordingQueueItem>,
}

#[derive(Debug, Clone, Deserialize, TS)]
#[serde(deny_unknown_fields)]
#[ts(export)]
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
    #[serde(default)]
    camera_style: HlaeCameraStyle,
    /// `None` keeps the global `AppConfig.recording` defaults for this shot.
    #[serde(default)]
    #[ts(optional = nullable)]
    presentation: Option<RecordingPresentation>,
}

#[derive(Debug, Clone, Copy, Serialize)]
pub(crate) struct AgentRecordingSource {
    pub(crate) plan_id: Uuid,
    pub(crate) composition_id: Uuid,
}

fn deserialize_required_nullable<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(deserializer)
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

async fn plan(
    State(state): State<AppState>,
    ApiJson(request): ApiJson<RecordingQueueRequest>,
) -> ApiResult<Json<RecordingPlanResponse>> {
    let mut active_items = Vec::new();
    for (index, item) in request.items.into_iter().enumerate() {
        let item = convert_item(item)
            .map_err(|error| ApiError::invalid(format!("item {}: {error}", index + 1)))?;
        active_items.push(item);
    }
    create_recording_plan(&state, active_items, None, None).await
}

async fn retry_plan(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> ApiResult<Json<RecordingPlanResponse>> {
    let parent_id = parse_id(&id)?;
    let parent = retryable_recording_parent(&state, parent_id).await?;
    let items = parent.retryable_suffix()?.to_vec();
    let agent_source =
        state
            .storage
            .get_agent_recording_run(parent_id)
            .await?
            .map(|(plan_id, composition_id)| AgentRecordingSource {
                plan_id,
                composition_id,
            });
    create_recording_plan(&state, items, Some(parent_id), agent_source).await
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
    agent_source: Option<AgentRecordingSource>,
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
    let executable_items = if retry_of.is_some() || agent_source.is_some() {
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
        recording_plan_binding(state, &executable_items, retry_of, agent_source).await?;
    state.recording.preflight(&executable_items).await?;
    let binding_sha256 =
        recording_plan_binding(state, &executable_items, retry_of, agent_source).await?;
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
    let response = Arc::new(RecordingPlanResponse {
        plan_id,
        expires_at,
        active_items: active_items.len(),
        disabled_items,
        estimated_seconds,
        warnings,
        items: executable_items.clone(),
        director,
    });
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
                agent_source,
                response: Arc::clone(&response),
                binding_sha256,
                expires_at,
                deadline,
                state: RecordingPlanLeaseState::Ready,
                transitions,
            },
        );
    }
    Ok(Json((*response).clone()))
}

/// §10.8 gaps 1 and 2, both of which are the same gap: a recording plan could
/// only ever be read once, at the moment it was created.
///
/// The consequences were a page that lost its plan on reload — the lease was
/// still alive on the service, the browser simply had no way to ask for it —
/// and 「重试录制」 in 「11 输出与任务记录」 handing `/recording/<id>` a *lease*
/// id that the page had no route to resolve. One route fixes both.
///
/// A plan that has expired answers `410 Gone` rather than `404`. They are
/// different facts and the page says different things about them: a plan that
/// expired can be recreated from the same queue, and one that never existed
/// cannot.
async fn get_plan(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> ApiResult<Json<RecordingPlanResponse>> {
    let plan_id = parse_id(&id)?;
    let leases = state.recording_plans.lock().await;
    let lease = leases
        .get(&plan_id)
        .ok_or_else(|| ApiError::not_found("recording plan"))?;
    // A lease mid-launch is not expired however old its clock says it is —
    // `execute_plan` holds it across the handoff to the recorder, and the page
    // watching that job still needs to read the plan it is running.
    let starting = matches!(lease.state, RecordingPlanLeaseState::Starting { .. });
    if !starting
        && (lease.expires_at <= Utc::now() || lease.deadline <= tokio::time::Instant::now())
    {
        return Err(ApiError::new(
            StatusCode::GONE,
            "recording_plan_expired",
            "This recording plan has expired; create it again from the queue",
        ));
    }
    Ok(Json((*lease.response).clone()))
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
    agent_source: Option<AgentRecordingSource>,
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
    agent_source: Option<AgentRecordingSource>,
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
        agent_source,
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
        let current_binding =
            match recording_plan_binding(&state, &lease.items, lease.retry_of, lease.agent_source)
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
            lease.agent_source,
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
    agent_source: Option<AgentRecordingSource>,
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

    if let Some(source) = agent_source {
        state
            .storage
            .bind_agent_recording_run(job.id, source.plan_id, source.composition_id)
            .await?;
    }

    let job_id = job.id;
    let job = match state.recording.execute(job).await {
        Ok(job) => job,
        Err(error) => {
            if agent_source.is_some() {
                state.storage.delete_agent_recording_run(job_id).await?;
            }
            clear_active_job(state, job_id).await;
            reservation.disarm();
            return Err(error.into());
        }
    };
    let status = execution_status(job.status);
    reconcile_agent_job(state, job.id).await?;
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
    reconcile_agent_job(&state, job.id).await?;
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
    reconcile_agent_job(&state, job.id).await?;
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
    reconcile_agent_job(&state, job.id).await?;
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
                if let Err(error) = reconcile_agent_job(&state, job.id).await {
                    tracing::error!(%error, job_id = %job.id, "unable to register Agent recording takes");
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

pub(super) async fn reconcile_agent_job(state: &AppState, job_id: Uuid) -> ApiResult<()> {
    let Some((plan_id, _)) = state.storage.get_agent_recording_run(job_id).await? else {
        return Ok(());
    };
    let settings = state.storage.get_agent_workspace_settings().await?;
    state
        .storage
        .reconcile_agent_recording_takes(job_id, settings.take_limit)
        .await?;
    if let Some(composition) = state.storage.get_agent_composition(plan_id).await?
        && composition.status == vibe_cs_domain::CompositionStatus::Confirmed
        && composition.export_job_id.is_none()
        && !state.exports.encoders().await.is_empty()
        && let Err(error) = super::agent_sessions::export_confirmed_composition(
            state,
            composition.plan_id,
            serde_json::json!({}),
        )
        .await
    {
        tracing::error!(%error, composition_id = %composition.id, "unable to auto-export Agent composition");
    }
    state.events.publish("agent_composition", "changed", None);
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
const RECORDING_OUTPUT_DIRECTORY: &str = "recordings";
/// Largest Demo the capture pipeline will open. Mirrors runtime's
/// `MAXIMUM_RECORDING_DEMO_BYTES`.
const MAXIMUM_PREFLIGHT_DEMO_BYTES: u64 = 8 * 1_024 * 1_024 * 1_024;
/// Ticks the capture scheduler may overshoot past the requested end. Mirrors
/// runtime's `CAPTURE_SCHEDULER_OVERSHOOT_TICKS`; the staging estimate is taken
/// over the same span the session actually captures.
const PREFLIGHT_CAPTURE_OVERSHOOT_TICKS: u32 = 8;

/// Runs the closed pre-recording check list for one leased plan.
///
/// # Why this hangs off a plan id
///
/// Half of the checks are statements about *these shots*: whether this Demo
/// still hashes to what was analyzed, whether this shot's tick window fits
/// inside the Demo, whether this player-POV shot has a parser-observed
/// spectator slot. A parameterless environment probe could not answer any of
/// them, and could not fill [`RecordingPreflightCheck::affected_item_ids`].
/// The plan id is the same [`RecordingPlanLease`] `execute` consumes, so the
/// rows describe exactly the shots the next `execute` would run.
///
/// # Why POST
///
/// Each call discovers the CS2 executable, verifies the managed HLAE
/// installation, hashes every Demo the plan references, creates and write-probes
/// the managed output directory, queries free space and probes the Media
/// Foundation encoder inventory. None of that is cacheable and all of it is a
/// point-in-time measurement, so it is a POST, not a GET a proxy may replay.
/// Unlike `execute` it is read-only with respect to the lease: it never claims,
/// starts, or evicts a plan, so the check list can be re-run as often as the
/// user presses the button.
///
/// # Relationship to `RecordingPlanResponse.warnings`
///
/// `warnings` stays what it always was: free text noticed while a plan was
/// being built, printable but not renderable as a row with a state. This is the
/// closed, per-row list. The one overlap today is the single warning
/// `create_recording_plan` pushes when no Demo has a usable analyzed tick rate;
/// [`RecordingPreflightCode::TickRangeWithinDemo`] reports that same missing
/// evidence as a blocking row, so that warning is the first candidate for
/// removal once clients read this list. Nothing is removed in this change.
async fn preflight_plan(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> ApiResult<Json<RecordingPreflight>> {
    let plan_id = parse_id(&id)?;
    let items = leased_plan_items(&state, plan_id).await?;
    let facts = recording_preflight_facts(&state, &items).await?;
    Ok(Json(build_recording_preflight(&facts)?))
}

/// Reads a live plan lease's shots without consuming it.
///
/// The two failure codes are `execute`'s, deliberately: a client that already
/// handles a lost or expired plan there needs no second vocabulary here. Unlike
/// `execute` this never removes the expired entry, so a later `execute` still
/// answers `recording_plan_expired` rather than `recording_plan_unavailable`.
async fn leased_plan_items(state: &AppState, plan_id: Uuid) -> ApiResult<Vec<RecordingRequest>> {
    let leases = state.recording_plans.lock().await;
    let Some(lease) = leases.get(&plan_id) else {
        return Err(ApiError::new(
            StatusCode::CONFLICT,
            "recording_plan_unavailable",
            "Recording plan is missing or no longer available",
        ));
    };
    let expired = lease.expires_at <= Utc::now() || lease.deadline <= tokio::time::Instant::now();
    if expired && !matches!(lease.state, RecordingPlanLeaseState::Starting { .. }) {
        return Err(ApiError::new(
            StatusCode::CONFLICT,
            "recording_plan_expired",
            "Recording plan expired; create a new plan before recording",
        ));
    }
    Ok(lease.items.clone())
}

/// Everything the check list is computed from, measured once per request.
#[derive(Debug)]
struct RecordingPreflightFacts {
    /// The discovered CS2 executable, the same fact `/api/status/setup` reports.
    game_executable: Option<String>,
    capture_component: CaptureComponentFacts,
    encoder: HlaeSequenceEncoderCapabilityReport,
    output: OutputRootFacts,
    /// One entry per distinct Demo the plan references.
    demos: Vec<DemoContentFacts>,
    /// One entry per plan item, in plan order.
    items: Vec<PlanItemFacts>,
}

#[derive(Debug)]
struct CaptureComponentFacts {
    prepared: bool,
    available: bool,
    launch_profile_ready: bool,
    version: String,
    messages: Vec<String>,
}

#[derive(Debug)]
struct OutputRootFacts {
    path: String,
    /// Why the directory could not be created or written to, when it could not.
    unwritable: Option<String>,
    available_bytes: u64,
    /// What one take of this plan stages at its worst case, plus the free-space
    /// reserve the capture session keeps. `None` when the plan carries no
    /// estimable span - the tick rows report that same evidence gap.
    required_bytes: Option<u64>,
}

#[derive(Debug)]
struct DemoContentFacts {
    /// Why this Demo no longer matches what was analyzed, when it does not.
    mismatch: Option<String>,
    /// The plan items that record from this Demo.
    item_ids: Vec<Uuid>,
}

#[derive(Debug)]
struct PlanItemFacts {
    id: Option<Uuid>,
    /// True for a camera-path shot: the shots whose coordinates the HLAE plan
    /// validator refuses to check against map geometry. Player-POV shots carry
    /// no invented coordinates.
    observer_shot: bool,
    /// Why this player-POV shot has no parser-observed spectator slot, when it
    /// has none. Always `None` for a camera-path shot, which needs no slot.
    missing_spectator_evidence: Option<String>,
    /// Why this shot's tick window is not provably inside the Demo, when it is
    /// not.
    tick_window_problem: Option<String>,
}

fn build_recording_preflight(
    facts: &RecordingPreflightFacts,
) -> Result<RecordingPreflight, vibe_cs_domain::DomainError> {
    RecordingPreflight::new(vec![
        game_ready_check(facts),
        capture_component_check(facts),
        demo_content_check(facts),
        output_directory_check(facts),
        spectator_evidence_check(facts),
        encoder_check(facts),
        tick_range_check(facts),
        camera_collision_check(facts),
    ])
}

fn game_ready_check(facts: &RecordingPreflightFacts) -> RecordingPreflightCheck {
    facts.game_executable.as_ref().map_or_else(
        || {
            preflight_row(
                RecordingPreflightCode::GameReady,
                RecordingPreflightState::Blocked,
                "no CS2 executable was discovered",
                Vec::new(),
            )
        },
        |path| {
            preflight_row(
                RecordingPreflightCode::GameReady,
                RecordingPreflightState::Ok,
                &format!("CS2 executable: {path}"),
                Vec::new(),
            )
        },
    )
}

fn capture_component_check(facts: &RecordingPreflightFacts) -> RecordingPreflightCheck {
    let component = &facts.capture_component;
    let version = &component.version;
    if component.prepared && component.available && component.launch_profile_ready {
        return preflight_row(
            RecordingPreflightCode::CaptureComponentReady,
            RecordingPreflightState::Ok,
            &format!("managed HLAE {version} is prepared and its launch profile is complete"),
            Vec::new(),
        );
    }
    let messages = component.messages.join("; ");
    preflight_row(
        RecordingPreflightCode::CaptureComponentReady,
        RecordingPreflightState::Blocked,
        &format!(
            "managed HLAE {version}: prepared={}, installation verified={}, launch profile ready={}. {messages}",
            component.prepared, component.available, component.launch_profile_ready
        ),
        Vec::new(),
    )
}

fn demo_content_check(facts: &RecordingPreflightFacts) -> RecordingPreflightCheck {
    let mismatches = facts
        .demos
        .iter()
        .filter(|demo| demo.mismatch.is_some())
        .collect::<Vec<_>>();
    if mismatches.is_empty() {
        return preflight_row(
            RecordingPreflightCode::DemoContentMatches,
            RecordingPreflightState::Ok,
            &format!(
                "{} Demo file(s) still hash to the content that was analyzed",
                facts.demos.len()
            ),
            Vec::new(),
        );
    }
    let detail = mismatches
        .iter()
        .filter_map(|demo| demo.mismatch.clone())
        .collect::<Vec<_>>()
        .join("; ");
    let affected = mismatches
        .iter()
        .flat_map(|demo| demo.item_ids.iter().copied())
        .collect::<Vec<_>>();
    preflight_row(
        RecordingPreflightCode::DemoContentMatches,
        RecordingPreflightState::Blocked,
        &detail,
        affected,
    )
}

fn output_directory_check(facts: &RecordingPreflightFacts) -> RecordingPreflightCheck {
    let output = &facts.output;
    let path = &output.path;
    if let Some(reason) = &output.unwritable {
        return preflight_row(
            RecordingPreflightCode::OutputDirectoryWritable,
            RecordingPreflightState::Blocked,
            &format!("{path}: {reason}"),
            Vec::new(),
        );
    }
    let available = describe_bytes(output.available_bytes);
    let Some(required_bytes) = output.required_bytes else {
        return preflight_row(
            RecordingPreflightCode::OutputDirectoryWritable,
            RecordingPreflightState::Ok,
            &format!("{path}: writable, {available} free; the staging estimate is unavailable"),
            Vec::new(),
        );
    };
    let required = describe_bytes(required_bytes);
    if output.available_bytes < required_bytes {
        return preflight_row(
            RecordingPreflightCode::OutputDirectoryWritable,
            RecordingPreflightState::Blocked,
            &format!("{path}: {available} free, {required} required by the longest shot"),
            Vec::new(),
        );
    }
    preflight_row(
        RecordingPreflightCode::OutputDirectoryWritable,
        RecordingPreflightState::Ok,
        &format!("{path}: writable, {available} free, {required} required by the longest shot"),
        Vec::new(),
    )
}

fn spectator_evidence_check(facts: &RecordingPreflightFacts) -> RecordingPreflightCheck {
    let pov_items = facts
        .items
        .iter()
        .filter(|item| !item.observer_shot)
        .count();
    if pov_items == 0 {
        return preflight_row(
            RecordingPreflightCode::SpectatorEvidenceComplete,
            RecordingPreflightState::Ok,
            "the plan contains no player-POV shot",
            Vec::new(),
        );
    }
    let missing = facts
        .items
        .iter()
        .filter(|item| item.missing_spectator_evidence.is_some())
        .collect::<Vec<_>>();
    if missing.is_empty() {
        return preflight_row(
            RecordingPreflightCode::SpectatorEvidenceComplete,
            RecordingPreflightState::Ok,
            &format!("{pov_items} player-POV shot(s) have a parser-observed CS2 spectator slot"),
            Vec::new(),
        );
    }
    let detail = missing
        .iter()
        .filter_map(|item| item.missing_spectator_evidence.clone())
        .collect::<Vec<_>>()
        .join("; ");
    preflight_row(
        RecordingPreflightCode::SpectatorEvidenceComplete,
        RecordingPreflightState::Blocked,
        &detail,
        missing.iter().filter_map(|item| item.id).collect(),
    )
}

fn encoder_check(facts: &RecordingPreflightFacts) -> RecordingPreflightCheck {
    let report = &facts.encoder;
    let counts = format!(
        "H.264 encoders: {}, AAC encoders: {}",
        report.registered_h264_encoder_count, report.registered_aac_encoder_count
    );
    // The same rule runtime's `verify_native_encoder_candidates` applies before
    // a capture, with `require_audio` true: managed capture always records WAV.
    let blocked = !report.media_foundation_started
        || report.registered_h264_encoder_count == 0
        || report.registered_aac_encoder_count == 0;
    if blocked {
        return preflight_row(
            RecordingPreflightCode::EncoderAvailable,
            RecordingPreflightState::Blocked,
            &format!("{counts}. {}", report.detail),
            Vec::new(),
        );
    }
    preflight_row(
        RecordingPreflightCode::EncoderAvailable,
        RecordingPreflightState::Ok,
        &counts,
        Vec::new(),
    )
}

fn tick_range_check(facts: &RecordingPreflightFacts) -> RecordingPreflightCheck {
    let outside = facts
        .items
        .iter()
        .filter(|item| item.tick_window_problem.is_some())
        .collect::<Vec<_>>();
    if outside.is_empty() {
        return preflight_row(
            RecordingPreflightCode::TickRangeWithinDemo,
            RecordingPreflightState::Ok,
            &format!(
                "{} shot(s) lie inside their Demo's parser-verified tick count",
                facts.items.len()
            ),
            Vec::new(),
        );
    }
    let detail = outside
        .iter()
        .filter_map(|item| item.tick_window_problem.clone())
        .collect::<Vec<_>>()
        .join("; ");
    preflight_row(
        RecordingPreflightCode::TickRangeWithinDemo,
        RecordingPreflightState::Blocked,
        &detail,
        outside.iter().filter_map(|item| item.id).collect(),
    )
}

fn camera_collision_check(facts: &RecordingPreflightFacts) -> RecordingPreflightCheck {
    let observer_items = facts
        .items
        .iter()
        .filter(|item| item.observer_shot)
        .collect::<Vec<_>>();
    if observer_items.is_empty() {
        return preflight_row(
            RecordingPreflightCode::CameraCollisionUnverified,
            RecordingPreflightState::Ok,
            "the plan contains no camera-path shot",
            Vec::new(),
        );
    }
    preflight_row(
        RecordingPreflightCode::CameraCollisionUnverified,
        RecordingPreflightState::Warning,
        &format!(
            "{} camera-path shot(s): camera coordinates cannot be checked against map geometry before HLAE preview",
            observer_items.len()
        ),
        observer_items.iter().filter_map(|item| item.id).collect(),
    )
}

/// Builds one row, keeping both bounded fields inside the domain's limits.
///
/// The caller composes facts, not lengths: a Windows path plus several Demo
/// names can outgrow [`RECORDING_PREFLIGHT_MAX_DETAIL_CHARS`], and a plan can
/// carry more shots than [`RECORDING_PREFLIGHT_MAX_AFFECTED_ITEMS`]. Truncating
/// here keeps an oversized measurement from turning the whole check list into an
/// error - the count in `detail` still states how many shots there really are.
fn preflight_row(
    code: RecordingPreflightCode,
    state: RecordingPreflightState,
    detail: &str,
    affected_item_ids: Vec<Uuid>,
) -> RecordingPreflightCheck {
    RecordingPreflightCheck {
        code,
        state,
        detail: bounded_detail(detail),
        affected_item_ids: bounded_affected_items(affected_item_ids),
    }
}

fn bounded_detail(detail: &str) -> String {
    let detail = detail.trim();
    if detail.chars().count() <= RECORDING_PREFLIGHT_MAX_DETAIL_CHARS {
        return detail.to_owned();
    }
    let mut bounded = detail
        .chars()
        .take(RECORDING_PREFLIGHT_MAX_DETAIL_CHARS - 3)
        .collect::<String>();
    bounded.push_str("...");
    bounded
}

fn bounded_affected_items(ids: Vec<Uuid>) -> Vec<Uuid> {
    let mut seen = HashSet::with_capacity(ids.len());
    ids.into_iter()
        .filter(|id| seen.insert(*id))
        .take(RECORDING_PREFLIGHT_MAX_AFFECTED_ITEMS)
        .collect()
}

/// Formats a measured byte count as both a rounded figure and the exact count.
fn describe_bytes(bytes: u64) -> String {
    const UNITS: [(&str, u64); 4] = [
        ("TB", 1_000_000_000_000),
        ("GB", 1_000_000_000),
        ("MB", 1_000_000),
        ("kB", 1_000),
    ];
    for (unit, divisor) in UNITS {
        if bytes >= divisor {
            let whole = bytes / divisor;
            let tenth = bytes % divisor * 10 / divisor;
            return format!("{whole}.{tenth} {unit} ({bytes} bytes)");
        }
    }
    format!("{bytes} bytes")
}

async fn recording_preflight_facts(
    state: &AppState,
    items: &[RecordingRequest],
) -> ApiResult<RecordingPreflightFacts> {
    let config = state.storage.get_config().await?.unwrap_or_default();
    let hlae = super::system::current_hlae_status(state).await?;
    let discovery_config = config.clone();
    let game_executable = tokio::task::spawn_blocking(move || {
        vibe_cs_integrations::discover_paths(&discovery_config)
            .cs2
            .filter(|path| path.is_file())
            .map(|path| path.to_string_lossy().into_owned())
    })
    .await
    .map_err(|error| preflight_task_error("path discovery", &error))?;
    let encoder = tokio::task::spawn_blocking(probe_hlae_sequence_encoder_capabilities)
        .await
        .map_err(|error| preflight_task_error("encoder capability probe", &error))?;

    let mut demo_ids = items.iter().map(|item| item.demo_id).collect::<Vec<_>>();
    demo_ids.sort_unstable();
    demo_ids.dedup();
    let mut demos = Vec::with_capacity(demo_ids.len());
    let mut analysis_by_demo = HashMap::with_capacity(demo_ids.len());
    for demo_id in demo_ids {
        let record = state.storage.get_demo(demo_id).await?;
        if let Some(analysis) = state.storage.get_analysis(demo_id).await? {
            analysis_by_demo.insert(demo_id, analysis);
        }
        let item_ids = items
            .iter()
            .filter(|item| item.demo_id == demo_id)
            .filter_map(|item| item.id)
            .collect::<Vec<_>>();
        let mismatch = match record {
            Some(record) => tokio::task::spawn_blocking(move || demo_content_mismatch(&record))
                .await
                .map_err(|error| preflight_task_error("Demo content verification", &error))?,
            None => Some(format!(
                "Demo {demo_id} is no longer in the library and cannot be verified"
            )),
        };
        demos.push(DemoContentFacts { mismatch, item_ids });
    }

    let capture = capture_settings(&config);
    let mut item_facts = Vec::with_capacity(items.len());
    let mut staging_bytes = 0_u64;
    for item in items {
        let analysis = analysis_by_demo.get(&item.demo_id);
        let observer_shot = item.camera_style != HlaeCameraStyle::Pov;
        let window = capture_tick_window(item, analysis, observer_shot);
        if let (Ok(window), Some(capture)) = (&window, capture.as_ref()) {
            staging_bytes = staging_bytes.max(
                estimate_hlae_capture_span_resources(
                    window.first_tick,
                    window.allowed_last_tick,
                    window.tick_rate,
                    capture,
                )
                .map_or(0, |estimate| estimate.total_bytes),
            );
        }
        item_facts.push(PlanItemFacts {
            id: item.id,
            observer_shot,
            missing_spectator_evidence: if observer_shot {
                None
            } else {
                missing_spectator_evidence(item, analysis)
            },
            tick_window_problem: window.err(),
        });
    }
    let required_bytes = (staging_bytes > 0)
        .then(|| {
            recommended_hlae_staging_safety_reserve(staging_bytes)
                .ok()
                .and_then(|reserve| staging_bytes.checked_add(reserve))
        })
        .flatten();

    let output_root = state.data_dir().join(RECORDING_OUTPUT_DIRECTORY);
    let output =
        tokio::task::spawn_blocking(move || probe_output_root(&output_root, required_bytes))
            .await
            .map_err(|error| preflight_task_error("output directory probe", &error))?;

    Ok(RecordingPreflightFacts {
        game_executable,
        capture_component: CaptureComponentFacts {
            prepared: hlae.managed_release.prepared,
            available: hlae.available,
            launch_profile_ready: hlae.launch_profile_ready,
            version: hlae.managed_release.version,
            messages: hlae.messages,
        },
        encoder,
        output,
        demos,
        items: item_facts,
    })
}

fn preflight_task_error(what: &str, error: &tokio::task::JoinError) -> ApiError {
    ApiError::new(
        StatusCode::INTERNAL_SERVER_ERROR,
        "recording_preflight_failed",
        format!("Recording preflight {what} task failed: {error}"),
    )
}

/// The capture settings runtime derives from the same configuration. `None`
/// when the configured resolution or frame rate is outside the native MP4
/// contract, which leaves the staging estimate unavailable rather than guessed.
fn capture_settings(config: &vibe_cs_domain::AppConfig) -> Option<CaptureSettings> {
    let (width, height) = config.recording.resolution.trim().split_once('x')?;
    let width = width.parse::<u32>().ok()?;
    let height = height.parse::<u32>().ok()?;
    if !(320..=4_096).contains(&width)
        || !(240..=2_304).contains(&height)
        || !width.is_multiple_of(2)
        || !height.is_multiple_of(2)
        || !matches!(config.recording.fps, 30 | 60)
    {
        return None;
    }
    Some(CaptureSettings {
        fps: config.recording.fps,
        width,
        height,
        record_wav: true,
        layers: CaptureLayers::default(),
    })
}

/// The tick span one shot actually captures.
#[derive(Debug)]
struct CaptureTickWindow {
    first_tick: u32,
    allowed_last_tick: u32,
    tick_rate: f64,
}

/// Re-derives the window runtime's `build_segment_plan` computes and checks it
/// against the parser-verified Demo length.
///
/// The `Err` string is the row's `detail`: it names the shot's title so a list
/// of several problems stays readable.
fn capture_tick_window(
    item: &RecordingRequest,
    analysis: Option<&MatchAnalysis>,
    observer_shot: bool,
) -> Result<CaptureTickWindow, String> {
    let title = item.title.trim();
    let Some(analysis) = analysis else {
        return Err(format!("{title}: the Demo has no persisted analysis"));
    };
    let tick_rate = analysis.tick_rate;
    if !tick_rate.is_finite() || !(1.0..=256.0).contains(&tick_rate) {
        return Err(format!("{title}: the Demo has no analyzed tick rate"));
    }
    let Some(verified_total_ticks) = analysis.verified_total_ticks.filter(|ticks| *ticks > 0)
    else {
        return Err(format!(
            "{title}: the Demo has no parser-verified total tick count"
        ));
    };
    let pre_roll_ticks = roll_ticks(item.pre_roll_seconds, tick_rate)
        .ok_or_else(|| format!("{title}: the pre-roll is outside the supported tick range"))?;
    let post_roll_ticks = roll_ticks(item.post_roll_seconds, tick_rate)
        .ok_or_else(|| format!("{title}: the post-roll is outside the supported tick range"))?;
    let first_tick = item.start_tick.saturating_sub(pre_roll_ticks);
    let last_tick = item
        .end_tick
        .checked_add(post_roll_ticks)
        .ok_or_else(|| format!("{title}: the post-roll exceeds the tick range"))?;
    if last_tick <= first_tick {
        return Err(format!("{title}: the tick window is empty"));
    }
    if last_tick > u64::from(verified_total_ticks) {
        return Err(format!(
            "{title}: ticks {first_tick}-{last_tick} exceed the Demo's {verified_total_ticks} verified ticks"
        ));
    }
    // `build_player_pov_plan` seeks one tick before the window and refuses to
    // start a POV capture below tick 3.
    if !observer_shot && first_tick < 3 {
        return Err(format!(
            "{title}: player-POV capture starts at tick {first_tick}, before the Demo's tick 3"
        ));
    }
    let first_tick = u32::try_from(first_tick)
        .map_err(|_| format!("{title}: the start tick is outside the capture range"))?;
    let last_tick = u32::try_from(last_tick)
        .map_err(|_| format!("{title}: the end tick is outside the capture range"))?;
    Ok(CaptureTickWindow {
        first_tick,
        allowed_last_tick: last_tick.saturating_add(
            verified_total_ticks
                .saturating_sub(last_tick)
                .min(PREFLIGHT_CAPTURE_OVERSHOOT_TICKS),
        ),
        tick_rate,
    })
}

fn roll_ticks(seconds: f64, tick_rate: f64) -> Option<u64> {
    let ticks = seconds * tick_rate;
    if !ticks.is_finite() || ticks < 0.0 || ticks > 2_f64.powi(53) {
        return None;
    }
    #[allow(
        clippy::cast_possible_truncation,
        clippy::cast_sign_loss,
        reason = "the value was just proven finite, non-negative and below 2^53"
    )]
    Some(ticks.ceil() as u64)
}

/// Mirrors runtime's `resolve_camera_player` and `resolved_spectator_slot`:
/// the slot must come from the parser, name exactly one player, and be the only
/// player holding it.
///
/// Every path that cannot produce a slot returns a reason. A missing analysis or
/// an unresolvable victim is exactly the "no parser-observed slot" this check
/// reports - answering `None` there would turn an unanswered question into a
/// green row.
fn missing_spectator_evidence(
    item: &RecordingRequest,
    analysis: Option<&MatchAnalysis>,
) -> Option<String> {
    let title = item.title.trim();
    let Some(analysis) = analysis else {
        return Some(format!("{title}: the Demo has no persisted analysis"));
    };
    let camera_player = if item.victim_pov {
        let Some(highlight_id) = item.highlight_id.as_deref() else {
            return Some(format!(
                "{title}: a victim-reaction shot needs a highlight id before its victim can be named"
            ));
        };
        let Some(highlight) = analysis
            .highlights
            .iter()
            .find(|highlight| highlight.id == highlight_id)
        else {
            return Some(format!(
                "{title}: highlight {highlight_id} is not in the persisted analysis"
            ));
        };
        let Some(victim) = highlight.victims.iter().find(|victim| {
            analysis
                .players
                .iter()
                .any(|player| player.steam_id == victim.as_str())
        }) else {
            return Some(format!(
                "{title}: highlight {highlight_id} names no victim the analysis knows"
            ));
        };
        victim.clone()
    } else {
        item.player_id.clone()
    };
    let mut named = analysis
        .players
        .iter()
        .filter(|player| player.steam_id == camera_player);
    let Some(player) = named.next() else {
        return Some(format!(
            "{title}: the analysis does not list player {camera_player}"
        ));
    };
    if named.next().is_some() {
        return Some(format!(
            "{title}: the analysis lists {camera_player} more than once, so no spectator slot is unambiguous"
        ));
    }
    let Some(slot) = player.spectator_slot.filter(|slot| (1..=64).contains(slot)) else {
        return Some(format!(
            "{title}: the analysis records no CS2 spectator slot for {camera_player}"
        ));
    };
    if analysis
        .players
        .iter()
        .filter(|player| player.spectator_slot == Some(slot))
        .count()
        == 1
    {
        None
    } else {
        Some(format!(
            "{title}: spectator slot {slot} is claimed by more than one player"
        ))
    }
}

/// Re-checks the Demo the way runtime's `verify_recording_demo_content` does
/// before every take: the file must still be a bounded regular non-link file
/// whose bytes hash to the fingerprint the analysis was bound to.
fn demo_content_mismatch(demo: &DemoRecord) -> Option<String> {
    let name = demo.file_name.trim();
    let Some(expected) = demo
        .content_sha256
        .as_deref()
        .filter(|value| value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit()))
    else {
        return Some(format!(
            "{name}: no analyzed content hash is stored; reimport it before recording"
        ));
    };
    let path = FilePath::new(&demo.path);
    let metadata = match std::fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) => return Some(format!("{name}: {error}")),
    };
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Some(format!("{name}: is not a regular file"));
    }
    if metadata.len() > MAXIMUM_PREFLIGHT_DEMO_BYTES {
        return Some(format!(
            "{name}: {} exceeds the {MAXIMUM_PREFLIGHT_DEMO_BYTES} byte recording limit",
            metadata.len()
        ));
    }
    if metadata.len() != demo.file_size {
        return Some(format!(
            "{name}: {} bytes on disk, {} bytes when analyzed",
            metadata.len(),
            demo.file_size
        ));
    }
    match hash_file(path) {
        Ok(actual) if actual.eq_ignore_ascii_case(expected) => None,
        Ok(_) => Some(format!(
            "{name}: content no longer matches the SHA-256 the analysis was bound to"
        )),
        Err(error) => Some(format!("{name}: {error}")),
    }
}

fn hash_file(path: &FilePath) -> std::io::Result<String> {
    let mut file = std::fs::File::open(path)?;
    let mut hash = Sha256::new();
    let mut buffer = vec![0_u8; 64 * 1_024].into_boxed_slice();
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hash.update(&buffer[..read]);
    }
    Ok(hex::encode(hash.finalize()))
}

/// Creates, write-probes and measures the managed output directory.
fn probe_output_root(path: &FilePath, required_bytes: Option<u64>) -> OutputRootFacts {
    let display = path.display().to_string();
    match write_probe_output_root(path) {
        Ok(available_bytes) => OutputRootFacts {
            path: display,
            unwritable: None,
            available_bytes,
            required_bytes,
        },
        Err(error) => OutputRootFacts {
            path: display,
            unwritable: Some(error.to_string()),
            available_bytes: 0,
            required_bytes,
        },
    }
}

fn write_probe_output_root(path: &FilePath) -> std::io::Result<u64> {
    std::fs::create_dir_all(path)?;
    let probe: PathBuf = path.join(format!(".recording-preflight-{}.tmp", Uuid::new_v4()));
    let written = (|| -> std::io::Result<()> {
        let mut file = std::fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&probe)?;
        file.write_all(b"preflight")?;
        file.flush()?;
        file.sync_all()
    })();
    let removed = std::fs::remove_file(&probe);
    written?;
    removed?;
    fs4::available_space(path)
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
        camera_style: item.camera_style,
        presentation: item.presentation,
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
            .set_demo_status(demo.id, vibe_cs_domain::DemoStatus::Discovered)
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
        persist_completed_analysis(
            &state.storage,
            MatchAnalysis {
                demo_id,
                map_name: "de_mirage".to_owned(),
                tick_rate: 64.0,
                duration_seconds: 10.0,
                verified_total_ticks: Some(640),
                teams: Vec::new(),
                players: Vec::new(),
                rounds: Vec::new(),
                highlights: Vec::new(),
            },
        )
        .await;
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
            camera_style: HlaeCameraStyle::default(),
            presentation: None,
        }
    }

    async fn persist_retryable_parent(state: &AppState) -> RecordingJob {
        let demo_id = Uuid::new_v4();
        persist_plan_demo(state, demo_id).await;
        let request = convert_item(plan_queue_item(demo_id)).expect("retry request");
        let now = Utc::now();
        let parent = RecordingJob {
            id: Uuid::new_v4(),
            retry_of: None,
            status: JobStatus::Failed,
            items: vec![request],
            current_index: 0,
            progress: 0.0,
            error_code: None,
            message: "capture interrupted".to_owned(),
            outputs: Vec::new(),
            created_at: now,
            updated_at: now,
        };
        state
            .storage
            .put_recording_job(parent.clone())
            .await
            .expect("retryable parent");
        parent
    }

    fn recording_job(id: Uuid, status: JobStatus) -> RecordingJob {
        let now = Utc::now();
        RecordingJob {
            id,
            retry_of: None,
            status,
            items: Vec::new(),
            current_index: 0,
            progress: 0.0,
            message: "test".to_owned(),
            outputs: Vec::new(),
            error_code: None,
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
            "victim_pov": false,
            "camera_style": "pov"
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

        let mut legacy = current.clone();
        legacy
            .as_object_mut()
            .expect("recording item object")
            .remove("camera_style");
        assert_eq!(
            serde_json::from_value::<RecordingQueueItem>(legacy)
                .expect("legacy queue item")
                .camera_style,
            HlaeCameraStyle::Pov
        );

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
            camera_style: HlaeCameraStyle::default(),
            presentation: None,
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
            camera_style: HlaeCameraStyle::default(),
            presentation: None,
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
            camera_style: HlaeCameraStyle::default(),
            presentation: None,
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
            camera_style: HlaeCameraStyle::default(),
            presentation: None,
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
            camera_style: HlaeCameraStyle::default(),
            presentation: None,
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
    async fn recording_retry_executes_only_the_proven_suffix_as_a_new_durable_job() {
        let recording = Arc::new(CountingRecordingPort::default());
        let (_directory, state) = state_with_recording(Arc::clone(&recording)).await;
        let demo_id = Uuid::new_v4();
        persist_plan_demo(&state, demo_id).await;
        let first = convert_item(plan_queue_item(demo_id)).expect("first request");
        let second = convert_item(plan_queue_item(demo_id)).expect("second request");
        let first_request_id = first.id.expect("first request id");
        let now = Utc::now();
        let parent = RecordingJob {
            id: Uuid::new_v4(),
            retry_of: None,
            status: JobStatus::Failed,
            items: vec![first, second.clone()],
            current_index: 1,
            progress: 0.5,
            error_code: None,
            message: "capture interrupted".to_owned(),
            outputs: vec![vibe_cs_domain::RecordedClip {
                id: Uuid::new_v4(),
                path: "C:/recordings/first.mp4".to_owned(),
                title: "First capture".to_owned(),
                duration_seconds: 2.0,
                demo_id: Some(demo_id),
                player_name: Some("Player".to_owned()),
                category: "custom".to_owned(),
                tags: Vec::new(),
                metadata: serde_json::json!({ "request_id": first_request_id }),
                created_at: now,
            }],
            created_at: now,
            updated_at: now,
        };
        state
            .storage
            .put_recording_job(parent.clone())
            .await
            .expect("parent job");

        let planned = retry_plan(State(state.clone()), Path(parent.id.to_string()))
            .await
            .expect("retry plan");

        assert_eq!(planned.0.items, vec![second.clone()]);
        assert_eq!(recording.preflight_items.load(Ordering::Relaxed), 1);

        let execution = execute_plan(
            State(state.clone()),
            Path(planned.0.plan_id.to_string()),
            ApiJson(ExecuteRecordingPlanRequest {
                offline_insecure_acknowledged: true,
            }),
        )
        .await
        .expect("execute retry plan");
        let child = state
            .storage
            .get_recording_job(execution.0.job_id)
            .await
            .expect("child lookup")
            .expect("durable child");

        assert_eq!(child.retry_of, Some(parent.id));
        assert_eq!(child.items, vec![second]);
        assert_eq!(
            state
                .storage
                .get_recording_job(parent.id)
                .await
                .expect("parent lookup"),
            Some(parent),
        );
    }

    #[tokio::test]
    async fn recording_retry_plan_rejects_a_changed_parent_before_execution() {
        let recording = Arc::new(CountingRecordingPort::default());
        let (_directory, state) = state_with_recording(Arc::clone(&recording)).await;
        let mut parent = persist_retryable_parent(&state).await;
        let planned = retry_plan(State(state.clone()), Path(parent.id.to_string()))
            .await
            .expect("retry plan");
        parent.message = "failure evidence was updated".to_owned();
        parent.updated_at += chrono::Duration::seconds(1);
        state
            .storage
            .put_recording_job(parent.clone())
            .await
            .expect("updated parent");

        let error = execute_plan(
            State(state.clone()),
            Path(planned.0.plan_id.to_string()),
            ApiJson(ExecuteRecordingPlanRequest {
                offline_insecure_acknowledged: true,
            }),
        )
        .await
        .expect_err("changed retry parent invalidates its lease");

        assert_eq!(error.into_response().status(), StatusCode::CONFLICT);
        assert_eq!(recording.executions.load(Ordering::Relaxed), 0);
        assert_eq!(
            state
                .storage
                .list_recording_jobs()
                .await
                .expect("recording jobs"),
            vec![parent]
        );
    }

    #[tokio::test]
    async fn unacknowledged_recording_retry_does_not_create_a_child() {
        let recording = Arc::new(CountingRecordingPort::default());
        let (_directory, state) = state_with_recording(Arc::clone(&recording)).await;
        let parent = persist_retryable_parent(&state).await;
        let planned = retry_plan(State(state.clone()), Path(parent.id.to_string()))
            .await
            .expect("retry plan");

        let error = execute_plan(
            State(state.clone()),
            Path(planned.0.plan_id.to_string()),
            ApiJson(ExecuteRecordingPlanRequest {
                offline_insecure_acknowledged: false,
            }),
        )
        .await
        .expect_err("offline insecure acknowledgement is required");

        assert_eq!(
            error.into_response().status(),
            StatusCode::PRECONDITION_REQUIRED
        );
        assert_eq!(recording.executions.load(Ordering::Relaxed), 0);
        assert_eq!(
            state
                .storage
                .list_recording_jobs()
                .await
                .expect("recording jobs"),
            vec![parent]
        );
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
                    camera_style: HlaeCameraStyle::default(),
                    presentation: None,
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
    async fn a_plan_can_be_read_back_and_is_the_same_document() {
        // §10.8 gaps 1 and 2: a plan could only ever be read once, at the
        // moment it was created. Reloading the recording page lost it, and
        // 「重试录制」 handed `/recording/<id>` a lease id nothing could resolve.
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

        let reread = get_plan(State(state.clone()), Path(planned.0.plan_id.to_string()))
            .await
            .expect("plan is readable")
            .0;

        // The *same* document, not one recomputed from the same inputs: the
        // director plan and the estimate come from analyses that can move.
        assert_eq!(reread.plan_id, planned.0.plan_id);
        assert_eq!(reread.expires_at, planned.0.expires_at);
        assert_eq!(reread.items.len(), planned.0.items.len());
        assert_eq!(
            serde_json::to_value(&reread.director).expect("director"),
            serde_json::to_value(&planned.0.director).expect("director")
        );

        // Reading it does not consume it — that is `execute_plan`'s job.
        assert!(
            state
                .recording_plans
                .lock()
                .await
                .contains_key(&planned.0.plan_id)
        );

        let missing = get_plan(State(state.clone()), Path(Uuid::new_v4().to_string()))
            .await
            .expect_err("an unknown plan is not found");
        assert_eq!(missing.into_response().status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn an_expired_plan_is_gone_rather_than_missing() {
        // Different facts, and the page says different things about them: an
        // expired plan can be recreated from the same queue, one that never
        // existed cannot.
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

        {
            let mut leases = state.recording_plans.lock().await;
            let lease = leases.get_mut(&planned.0.plan_id).expect("lease");
            lease.expires_at = Utc::now() - chrono::Duration::seconds(1);
            lease.deadline = tokio::time::Instant::now();
        }

        let expired = get_plan(State(state), Path(planned.0.plan_id.to_string()))
            .await
            .expect_err("an expired plan is gone");
        assert_eq!(expired.into_response().status(), StatusCode::GONE);
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
                    camera_style: HlaeCameraStyle::default(),
                    presentation: None,
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
            camera_style: HlaeCameraStyle::default(),
            presentation: None,
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
    async fn plan_rejects_a_field_of_view_an_observer_shot_would_never_apply() {
        let recording = Arc::new(CountingRecordingPort::default());
        let (_directory, state) = state_with_recording(recording).await;
        let mut item = plan_queue_item(Uuid::new_v4());
        item.camera_style = HlaeCameraStyle::Tracking;
        item.presentation = Some(RecordingPresentation {
            camera_fov: 120.0,
            ..RecordingPresentation::default()
        });

        let error = plan(
            State(state),
            ApiJson(RecordingQueueRequest { items: vec![item] }),
        )
        .await
        .expect_err("an observer shot takes its field of view from the camera path");

        let message = error.to_string();
        assert!(
            message.contains("camera_fov") && message.contains("camera path"),
            "the rejection must name the field and the reason: {message}"
        );
        assert_eq!(error.into_response().status(), StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn plan_accepts_the_scene_controls_that_do_apply_to_an_observer_shot() {
        let recording = Arc::new(CountingRecordingPort::default());
        let (_directory, state) = state_with_recording(Arc::clone(&recording)).await;
        let demo_id = Uuid::new_v4();
        persist_plan_demo(&state, demo_id).await;
        let mut item = plan_queue_item(demo_id);
        item.camera_style = HlaeCameraStyle::Tracking;
        item.presentation = Some(RecordingPresentation {
            show_hud: false,
            show_radar: false,
            flash_alpha: 102,
            voice: vibe_cs_domain::RecordingVoicePolicy::TargetOnly,
            ..RecordingPresentation::default()
        });
        let expected = item.presentation;

        let response = plan(
            State(state),
            ApiJson(RecordingQueueRequest { items: vec![item] }),
        )
        .await
        .expect("HUD, radar, flash and voice are meaningful for an observer shot");

        assert_eq!(response.0.items[0].presentation, expected);
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

    // -----------------------------------------------------------------------
    // Pre-recording checks
    // -----------------------------------------------------------------------

    async fn error_code(error: ApiError) -> (StatusCode, String) {
        let response = error.into_response();
        let status = response.status();
        let body = axum::body::to_bytes(response.into_body(), 4 * 1024)
            .await
            .expect("error body");
        let problem: vibe_cs_domain::ErrorBody =
            serde_json::from_slice(&body).expect("error payload");
        (status, problem.code)
    }

    fn preflight_check(
        preflight: &RecordingPreflight,
        code: RecordingPreflightCode,
    ) -> &RecordingPreflightCheck {
        preflight
            .checks
            .iter()
            .find(|check| check.code == code)
            .unwrap_or_else(|| panic!("the list must report {}", code.as_str()))
    }

    fn registered_encoders() -> HlaeSequenceEncoderCapabilityReport {
        HlaeSequenceEncoderCapabilityReport {
            status: vibe_cs_platform_windows::HlaeSequenceEncoderProbeStatus::EncoderCandidatesRegistered,
            media_foundation_started: true,
            registered_h264_encoder_count: 1,
            registered_hardware_h264_encoder_count: 0,
            registered_aac_encoder_count: 1,
            end_to_end_mp4_encode_verified: false,
            detail: "deterministic test inventory".to_owned(),
        }
    }

    fn satisfied_pov_item(id: Uuid) -> PlanItemFacts {
        PlanItemFacts {
            id: Some(id),
            observer_shot: false,
            missing_spectator_evidence: None,
            tick_window_problem: None,
        }
    }

    /// Facts in which every observable condition holds.
    fn satisfied_facts(item_id: Uuid) -> RecordingPreflightFacts {
        RecordingPreflightFacts {
            game_executable: Some("C:/Games/csgo/game/bin/win64/cs2.exe".to_owned()),
            capture_component: CaptureComponentFacts {
                prepared: true,
                available: true,
                launch_profile_ready: true,
                version: "2.150".to_owned(),
                messages: Vec::new(),
            },
            encoder: registered_encoders(),
            output: OutputRootFacts {
                path: "C:/vibe-cs/recordings".to_owned(),
                unwritable: None,
                available_bytes: 218_400_000_000,
                required_bytes: Some(3_100_000_000),
            },
            demos: vec![DemoContentFacts {
                mismatch: None,
                item_ids: vec![item_id],
            }],
            items: vec![satisfied_pov_item(item_id)],
        }
    }

    fn analysis_with_players(
        demo_id: Uuid,
        players: Vec<vibe_cs_domain::PlayerStats>,
    ) -> MatchAnalysis {
        MatchAnalysis {
            demo_id,
            map_name: "de_mirage".to_owned(),
            tick_rate: 64.0,
            duration_seconds: 10.0,
            verified_total_ticks: Some(640),
            teams: Vec::new(),
            players,
            rounds: Vec::new(),
            highlights: Vec::new(),
        }
    }

    fn player(steam_id: &str, spectator_slot: Option<u8>) -> vibe_cs_domain::PlayerStats {
        vibe_cs_domain::PlayerStats {
            steam_id: steam_id.to_owned(),
            spectator_slot,
            name: "Player".to_owned(),
            team: "T".to_owned(),
            kills: 1,
            deaths: 0,
            assists: 0,
            headshots: 1,
            damage: 100,
            adr: 100.0,
            kill_death_ratio: 1.0,
            score: 2,
        }
    }

    #[test]
    fn a_satisfied_plan_reports_every_code_and_blocks_nothing() {
        let item_id = Uuid::new_v4();
        let preflight =
            build_recording_preflight(&satisfied_facts(item_id)).expect("a well-formed check list");

        assert_eq!(preflight.checks.len(), RecordingPreflightCode::all().len());
        for code in RecordingPreflightCode::all() {
            assert_eq!(
                preflight_check(&preflight, code).state,
                RecordingPreflightState::Ok,
                "{} must hold",
                code.as_str()
            );
        }
        assert_eq!(preflight.blocking, 0);
        assert!(!preflight.is_blocked());
        preflight.validate().expect("self-consistent document");
        let output = preflight_check(&preflight, RecordingPreflightCode::OutputDirectoryWritable);
        assert!(
            output.detail.contains("218.4 GB (218400000000 bytes)"),
            "the row must carry the measured byte count: {}",
            output.detail
        );
    }

    #[test]
    fn blocking_counts_only_the_rows_that_stop_a_capture() {
        let item_id = Uuid::new_v4();
        let observer_id = Uuid::new_v4();
        let mut facts = satisfied_facts(item_id);
        facts.output.unwritable = Some("Access is denied. (os error 5)".to_owned());
        facts.demos[0].mismatch =
            Some("match.dem: 12 bytes on disk, 34 bytes when analyzed".to_owned());
        facts.items.push(PlanItemFacts {
            id: Some(observer_id),
            observer_shot: true,
            missing_spectator_evidence: None,
            tick_window_problem: None,
        });

        let preflight = build_recording_preflight(&facts).expect("a well-formed check list");

        assert_eq!(preflight.blocking, 2);
        assert!(preflight.is_blocked());
        assert_eq!(
            preflight_check(&preflight, RecordingPreflightCode::OutputDirectoryWritable).state,
            RecordingPreflightState::Blocked
        );
        assert_eq!(
            preflight_check(&preflight, RecordingPreflightCode::DemoContentMatches).state,
            RecordingPreflightState::Blocked
        );
        assert_eq!(
            preflight_check(
                &preflight,
                RecordingPreflightCode::CameraCollisionUnverified
            )
            .state,
            RecordingPreflightState::Warning,
            "a preview limitation is never counted as blocking"
        );
    }

    #[test]
    fn a_check_names_only_the_shots_it_speaks_about() {
        let pov_id = Uuid::new_v4();
        let observer_id = Uuid::new_v4();
        let mut facts = satisfied_facts(pov_id);
        facts.items[0].missing_spectator_evidence = Some(
            "Ace: the analysis records no CS2 spectator slot for 76561198000000001".to_owned(),
        );
        facts.items.push(PlanItemFacts {
            id: Some(observer_id),
            observer_shot: true,
            missing_spectator_evidence: None,
            tick_window_problem: Some(
                "Flyby: ticks 0-900 exceed the Demo's 640 verified ticks".to_owned(),
            ),
        });

        let preflight = build_recording_preflight(&facts).expect("a well-formed check list");

        assert_eq!(
            preflight_check(
                &preflight,
                RecordingPreflightCode::SpectatorEvidenceComplete
            )
            .affected_item_ids,
            vec![pov_id],
            "the camera-path shot needs no spectator slot"
        );
        assert_eq!(
            preflight_check(&preflight, RecordingPreflightCode::TickRangeWithinDemo)
                .affected_item_ids,
            vec![observer_id]
        );
        assert_eq!(
            preflight_check(
                &preflight,
                RecordingPreflightCode::CameraCollisionUnverified
            )
            .affected_item_ids,
            vec![observer_id]
        );
        assert!(
            preflight_check(&preflight, RecordingPreflightCode::EncoderAvailable)
                .affected_item_ids
                .is_empty(),
            "a whole-plan check names no shot"
        );
    }

    #[test]
    fn an_oversized_measurement_never_invalidates_the_check_list() {
        let mut facts = satisfied_facts(Uuid::new_v4());
        facts.items = (0..=RECORDING_PREFLIGHT_MAX_AFFECTED_ITEMS)
            .map(|index| PlanItemFacts {
                id: Some(Uuid::new_v4()),
                observer_shot: true,
                missing_spectator_evidence: None,
                tick_window_problem: Some(format!("shot {index}: no persisted analysis")),
            })
            .collect();

        let preflight = build_recording_preflight(&facts).expect("a bounded check list");

        let ticks = preflight_check(&preflight, RecordingPreflightCode::TickRangeWithinDemo);
        assert_eq!(
            ticks.affected_item_ids.len(),
            RECORDING_PREFLIGHT_MAX_AFFECTED_ITEMS
        );
        assert!(ticks.detail.chars().count() <= RECORDING_PREFLIGHT_MAX_DETAIL_CHARS);
        assert!(ticks.detail.ends_with("..."));
    }

    #[test]
    fn demo_content_is_compared_against_the_analyzed_fingerprint() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let path = directory.path().join("match.dem");
        std::fs::write(&path, b"demo bytes").expect("demo fixture");
        let now = Utc::now();
        let demo = DemoRecord {
            id: Uuid::new_v4(),
            path: path.to_string_lossy().into_owned(),
            file_name: "match.dem".to_owned(),
            display_name: "Fixture".to_owned(),
            source: "test".to_owned(),
            status: vibe_cs_domain::DemoStatus::Ready,
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
            content_sha256: Some(hex::encode(Sha256::digest(b"demo bytes"))),
            file_size: 10,
            created_at: now,
            updated_at: now,
        };

        assert_eq!(demo_content_mismatch(&demo), None);

        let mut without_hash = demo.clone();
        without_hash.content_sha256 = None;
        assert!(
            demo_content_mismatch(&without_hash)
                .expect("an unbound Demo cannot be verified")
                .contains("no analyzed content hash")
        );

        let mut resized = demo.clone();
        resized.file_size = 11;
        assert!(
            demo_content_mismatch(&resized)
                .expect("a resized Demo is a mismatch")
                .contains("10 bytes on disk, 11 bytes when analyzed")
        );

        std::fs::write(&path, b"other bytes").expect("rewritten fixture");
        let mut rewritten = demo;
        rewritten.file_size = 11;
        assert!(
            demo_content_mismatch(&rewritten)
                .expect("rewritten content is a mismatch")
                .contains("SHA-256")
        );
    }

    #[test]
    fn the_tick_window_is_the_one_the_capture_actually_records() {
        let demo_id = Uuid::new_v4();
        let analysis = analysis_with_players(demo_id, Vec::new());
        let mut item = RecordingRequest {
            id: Some(Uuid::new_v4()),
            demo_id,
            highlight_id: None,
            player_id: "76561198000000001".to_owned(),
            title: "Ace".to_owned(),
            start_tick: 200,
            end_tick: 400,
            pre_roll_seconds: 1.0,
            post_roll_seconds: 1.0,
            victim_pov: false,
            camera_style: HlaeCameraStyle::Pov,
            presentation: None,
        };

        let window =
            capture_tick_window(&item, Some(&analysis), false).expect("a window inside the Demo");
        assert_eq!(window.first_tick, 136);
        assert_eq!(window.allowed_last_tick, 472);

        item.end_tick = 639;
        let outside = capture_tick_window(&item, Some(&analysis), false)
            .expect_err("the post-roll leaves the verified Demo length");
        assert!(outside.contains("640 verified ticks"), "{outside}");

        item.end_tick = 400;
        item.start_tick = 1;
        item.pre_roll_seconds = 0.0;
        assert!(
            capture_tick_window(&item, Some(&analysis), false)
                .expect_err("POV capture cannot start below tick 3")
                .contains("tick 3")
        );
        capture_tick_window(&item, Some(&analysis), true)
            .expect("a camera-path shot carries no observer seek floor");

        assert!(
            capture_tick_window(&item, None, false)
                .expect_err("an unanalyzed Demo proves nothing")
                .contains("no persisted analysis")
        );

        let mut unverified = analysis;
        unverified.verified_total_ticks = None;
        assert!(
            capture_tick_window(&item, Some(&unverified), false)
                .expect_err("an estimated tick count is not evidence")
                .contains("parser-verified")
        );
    }

    #[test]
    fn spectator_evidence_comes_from_the_parser_or_not_at_all() {
        let demo_id = Uuid::new_v4();
        let item = RecordingRequest {
            id: Some(Uuid::new_v4()),
            demo_id,
            highlight_id: None,
            player_id: "76561198000000001".to_owned(),
            title: "Ace".to_owned(),
            start_tick: 200,
            end_tick: 400,
            pre_roll_seconds: 0.0,
            post_roll_seconds: 0.0,
            victim_pov: false,
            camera_style: HlaeCameraStyle::Pov,
            presentation: None,
        };

        let resolved = analysis_with_players(demo_id, vec![player("76561198000000001", Some(7))]);
        assert_eq!(missing_spectator_evidence(&item, Some(&resolved)), None);

        let unslotted = analysis_with_players(demo_id, vec![player("76561198000000001", None)]);
        assert!(
            missing_spectator_evidence(&item, Some(&unslotted))
                .expect("a slotless player has no evidence")
                .contains("no CS2 spectator slot")
        );

        let ambiguous = analysis_with_players(
            demo_id,
            vec![
                player("76561198000000001", Some(7)),
                player("76561198000000002", Some(7)),
            ],
        );
        assert!(
            missing_spectator_evidence(&item, Some(&ambiguous))
                .expect("a shared slot is not evidence")
                .contains("more than one player")
        );

        assert!(
            missing_spectator_evidence(&item, None)
                .expect("an unanalyzed Demo has no slot")
                .contains("no persisted analysis"),
            "a missing analysis must never read as a satisfied check"
        );
    }

    #[tokio::test]
    async fn preflight_rejects_a_missing_or_expired_plan_exactly_like_execution() {
        let recording = Arc::new(CountingRecordingPort::default());
        let (_directory, state) = state_with_recording(Arc::clone(&recording)).await;
        let demo_id = Uuid::new_v4();
        persist_plan_demo(&state, demo_id).await;

        let (status, code) = error_code(
            preflight_plan(State(state.clone()), Path(Uuid::new_v4().to_string()))
                .await
                .expect_err("an unknown plan cannot be checked"),
        )
        .await;
        assert_eq!(status, StatusCode::CONFLICT);
        assert_eq!(code, "recording_plan_unavailable");

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

        let (status, code) = error_code(
            preflight_plan(State(state.clone()), Path(planned.0.plan_id.to_string()))
                .await
                .expect_err("an expired plan cannot be checked"),
        )
        .await;
        assert_eq!(status, StatusCode::CONFLICT);
        assert_eq!(code, "recording_plan_expired");
        let (execute_status, execute_code) = error_code(
            execute_plan(
                State(state),
                Path(planned.0.plan_id.to_string()),
                ApiJson(ExecuteRecordingPlanRequest {
                    offline_insecure_acknowledged: true,
                }),
            )
            .await
            .expect_err("the same lease is expired for execution"),
        )
        .await;
        assert_eq!((execute_status, execute_code), (status, code));
        assert_eq!(recording.executions.load(Ordering::Relaxed), 0);
    }

    #[tokio::test]
    async fn preflight_measures_the_leased_shots_without_consuming_the_plan() {
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
        let item_id = planned.0.items[0].id.expect("a server-assigned shot id");

        let preflight = preflight_plan(State(state.clone()), Path(planned.0.plan_id.to_string()))
            .await
            .expect("the leased plan can be checked")
            .0;

        assert_eq!(
            preflight
                .checks
                .iter()
                .map(|check| check.code)
                .collect::<Vec<_>>(),
            RecordingPreflightCode::all().to_vec(),
            "every code is reported once, in list order"
        );
        preflight.validate().expect("self-consistent document");
        // The fixture Demo record points at a path that does not exist, so the
        // content row is blocking and names the one shot that reads it. Rows
        // that depend on the host machine are deliberately not asserted here.
        let content = preflight_check(&preflight, RecordingPreflightCode::DemoContentMatches);
        assert_eq!(content.state, RecordingPreflightState::Blocked);
        assert_eq!(content.affected_item_ids, vec![item_id]);
        let output = preflight_check(&preflight, RecordingPreflightCode::OutputDirectoryWritable);
        assert_eq!(
            output.state,
            RecordingPreflightState::Ok,
            "the managed output root is created and write-probed: {}",
            output.detail
        );
        assert_eq!(
            preflight_check(
                &preflight,
                RecordingPreflightCode::CameraCollisionUnverified
            )
            .state,
            RecordingPreflightState::Ok,
            "a player-POV plan carries no unverifiable camera coordinates"
        );

        assert!(
            state
                .recording_plans
                .lock()
                .await
                .contains_key(&planned.0.plan_id),
            "checking a plan must never consume its lease"
        );
        let recheck = preflight_plan(State(state), Path(planned.0.plan_id.to_string()))
            .await
            .expect("the check list can be re-run")
            .0;
        assert_eq!(recheck.blocking, preflight.blocking);
    }
}
