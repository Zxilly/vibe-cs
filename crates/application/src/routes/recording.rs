use axum::{
    Json, Router,
    extract::{Path, State},
    http::StatusCode,
    routing::{get, post},
};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use tokio::time::{Duration, MissedTickBehavior};
use uuid::Uuid;
use vibe_cs_domain::{
    CaptureLatencyCalibration, CaptureLatencySample, DirectorPlan, DirectorShotKind, JobStatus,
    MatchAnalysis, RecordingJob, RecordingRequest,
};
use vibe_cs_recording::{DirectorPolicy, build_director_plan, calibrate_capture_latency};

use crate::{ApiError, ApiJson, ApiResult, AppState};

const ACTIVE_JOB_POLL_INTERVAL: Duration = Duration::from_millis(400);
const ACTIVE_JOB_MISSING_POLL_LIMIT: u32 = 15;

pub(crate) fn router() -> Router<AppState> {
    Router::new()
        .route("/api/v1/recording/plan", post(plan))
        .route("/api/v1/recording/queue", post(queue))
        .route("/api/v1/recording/execute", post(execute_existing))
        .route("/api/v1/recording/jobs/{id}", get(get_job))
        .route("/api/v1/recording/jobs/{id}/cancel", post(cancel_job))
        .route("/api/v1/recording/abort", post(abort_active))
        .route("/api/v1/recording/calibration", post(calibrate_latency))
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct CalibrationRequest {
    samples: Vec<CaptureLatencySample>,
}

async fn calibrate_latency(
    ApiJson(request): ApiJson<CalibrationRequest>,
) -> ApiResult<Json<CaptureLatencyCalibration>> {
    calibrate_capture_latency(&request.samples)
        .map(Json)
        .map_err(|error| ApiError::invalid(error.to_string()))
}

#[derive(Debug, Clone, Deserialize)]
struct RecordingQueueRequest {
    items: Vec<RecordingQueueItem>,
}

#[derive(Debug, Clone, Deserialize)]
struct RecordingQueueItem {
    #[serde(default)]
    client_id: Option<String>,
    #[serde(default)]
    id: Option<String>,
    demo_id: String,
    #[serde(default)]
    demo_name: Option<String>,
    #[serde(default)]
    player_name: Option<String>,
    #[serde(default)]
    player_id: Option<String>,
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    highlight_id: Option<String>,
    start_tick: u64,
    end_tick: u64,
    #[serde(default)]
    playback_speed: Option<f64>,
    #[serde(default)]
    pre_roll_seconds: f64,
    #[serde(default)]
    post_roll_seconds: f64,
    #[serde(default)]
    perspective: Option<String>,
    #[serde(default)]
    victim_pov: Option<bool>,
    #[serde(default)]
    show_keyboard: Option<bool>,
    #[serde(default)]
    show_kill_fx: Option<bool>,
    #[serde(default)]
    fade: Option<bool>,
}

#[derive(Debug, Serialize)]
struct RecordingPlanResponse {
    active_items: usize,
    disabled_items: usize,
    estimated_seconds: f64,
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
        match convert_item(item) {
            Ok(item) => active_items.push(item),
            Err(error) => warnings.push(format!("item {}: {error}", index + 1)),
        }
    }
    let disabled_items = warnings.len();
    let estimated_seconds = active_items
        .iter()
        .map(|item| {
            (f64::from(
                u32::try_from(item.end_tick.saturating_sub(item.start_tick)).unwrap_or(u32::MAX),
            ) / 64.0
                / item.playback_speed)
                + item.pre_roll_seconds
                + item.post_roll_seconds
        })
        .sum();
    let analyses = load_analyses(&state, &active_items).await?;
    let director = build_director_plan(&active_items, &analyses, DirectorPolicy::default());
    Ok(Json(RecordingPlanResponse {
        active_items: active_items.len(),
        disabled_items,
        estimated_seconds,
        warnings,
        items: active_items,
        director,
    }))
}

#[derive(Debug, Serialize)]
struct RecordingExecutionResponse {
    job_id: Uuid,
    status: &'static str,
}

async fn queue(
    State(state): State<AppState>,
    ApiJson(request): ApiJson<RecordingQueueRequest>,
) -> ApiResult<Json<RecordingExecutionResponse>> {
    if request.items.is_empty() {
        return Err(ApiError::invalid(
            "recording queue must contain at least one item",
        ));
    }
    let mut items = Vec::with_capacity(request.items.len());
    for item in request.items {
        let converted = convert_item(item).map_err(ApiError::invalid)?;
        if state.storage.get_demo(converted.demo_id).await?.is_none() {
            return Err(ApiError::not_found("recording demo"));
        }
        items.push(converted);
    }
    let analyses = load_analyses(&state, &items).await?;
    let director = build_director_plan(&items, &analyses, DirectorPolicy::default());
    if director.unresolved_victim_requests > 0 {
        return Err(ApiError::invalid(
            "the director plan cannot satisfy every requested victim reaction from persisted analysis evidence",
        ));
    }
    items = executable_director_requests(&items, &director);
    if items.is_empty() {
        return Err(ApiError::invalid(
            "the director plan did not produce an executable recording shot",
        ));
    }

    let now = Utc::now();
    let job = RecordingJob {
        id: Uuid::new_v4(),
        status: JobStatus::Queued,
        items,
        current_index: 0,
        progress: 0.0,
        message: "Queued".to_owned(),
        outputs: Vec::new(),
        created_at: now,
        updated_at: now,
    };
    let mut reservation = reserve_active_job(&state, job.id).await?;

    let job_id = job.id;
    let job = match state.recording.execute(job).await {
        Ok(job) => job,
        Err(error) => {
            clear_active_job(&state, job_id).await;
            reservation.disarm();
            return Err(error.into());
        }
    };
    let status = compatible_job_status(job.status);
    if job.status.is_terminal() {
        clear_active_job(&state, job.id).await;
    } else {
        spawn_active_job_monitor(state.clone(), job.id);
    }
    reservation.disarm();
    state.storage.put_recording_job(job.clone()).await?;
    state
        .events
        .publish("recording_job", "changed", Some(job.id));
    Ok(Json(RecordingExecutionResponse {
        job_id: job.id,
        status,
    }))
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

#[derive(Debug, Deserialize)]
struct ExecuteRequest {
    job_id: String,
}

async fn execute_existing(
    State(state): State<AppState>,
    ApiJson(request): ApiJson<ExecuteRequest>,
) -> ApiResult<Json<RecordingJob>> {
    let id = parse_id(&request.job_id)?;
    let job = state
        .storage
        .get_recording_job(id)
        .await?
        .ok_or_else(|| ApiError::not_found("recording job"))?;
    if matches!(
        job.status,
        JobStatus::Running | JobStatus::Cancelling | JobStatus::Completed | JobStatus::Cancelled
    ) {
        return Err(ApiError::new(
            StatusCode::CONFLICT,
            "job_not_executable",
            "Recording job cannot be executed from its current state",
        ));
    }
    let mut reservation = reserve_active_job(&state, id).await?;
    let job = match state.recording.execute(job).await {
        Ok(job) => job,
        Err(error) => {
            clear_active_job(&state, id).await;
            reservation.disarm();
            return Err(error.into());
        }
    };
    if job.status.is_terminal() {
        clear_active_job(&state, id).await;
    } else {
        spawn_active_job_monitor(state.clone(), id);
    }
    reservation.disarm();
    state.storage.put_recording_job(job.clone()).await?;
    state.events.publish("recording_job", "changed", Some(id));
    Ok(Json(job))
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
    let player_id = item
        .player_id
        .or(item.player_name)
        .ok_or_else(|| "player_id is required".to_owned())?;
    let title = item.title.unwrap_or_else(|| {
        item.demo_name.map_or_else(
            || player_id.clone(),
            |demo_name| format!("{demo_name} · {player_id}"),
        )
    });
    let request = RecordingRequest {
        id: Some(
            item.id
                .or(item.client_id)
                .and_then(|id| Uuid::parse_str(&id).ok())
                .unwrap_or_else(Uuid::new_v4),
        ),
        demo_id,
        highlight_id: item.highlight_id,
        player_id,
        title,
        start_tick: item.start_tick,
        end_tick: item.end_tick,
        playback_speed: item.playback_speed.unwrap_or(1.0),
        pre_roll_seconds: item.pre_roll_seconds,
        post_roll_seconds: item.post_roll_seconds,
        victim_pov: item.victim_pov.unwrap_or(matches!(
            item.perspective.as_deref(),
            Some("victim" | "victim_pov")
        )),
        show_keyboard: item.show_keyboard.unwrap_or(false),
        show_kill_fx: item.show_kill_fx.unwrap_or(true),
        fade: item.fade.unwrap_or(true),
    };
    request.validate().map_err(|error| error.to_string())?;
    Ok(request)
}

fn parse_id(id: &str) -> ApiResult<Uuid> {
    Uuid::parse_str(id).map_err(|_| ApiError::invalid("id must be a UUID"))
}

const fn compatible_job_status(status: JobStatus) -> &'static str {
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
        atomic::{AtomicUsize, Ordering},
    };

    use async_trait::async_trait;
    use axum::response::IntoResponse;
    use vibe_cs_domain::DomainError;

    use super::*;
    use crate::RecordingPort;

    #[derive(Debug, Default)]
    struct CountingRecordingPort {
        executions: AtomicUsize,
    }

    #[async_trait]
    impl RecordingPort for CountingRecordingPort {
        async fn execute(&self, job: RecordingJob) -> Result<RecordingJob, DomainError> {
            self.executions.fetch_add(1, Ordering::Relaxed);
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
        let state =
            AppState::new(storage, directory.path().to_path_buf()).with_recording(recording);
        (directory, state)
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
    fn plan_rejects_inverted_ticks() {
        let item = RecordingQueueItem {
            client_id: None,
            id: None,
            demo_id: Uuid::new_v4().to_string(),
            demo_name: None,
            player_name: Some("Player".to_owned()),
            player_id: None,
            title: None,
            highlight_id: None,
            start_tick: 20,
            end_tick: 10,
            playback_speed: None,
            pre_roll_seconds: 0.0,
            post_roll_seconds: 0.0,
            perspective: Some("pov".to_owned()),
            victim_pov: None,
            show_keyboard: None,
            show_kill_fx: None,
            fade: None,
        };
        assert!(convert_item(item).is_err());
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
            playback_speed: 1.0,
            pre_roll_seconds: 3.0,
            post_roll_seconds: 2.0,
            victim_pov: true,
            show_keyboard: true,
            show_kill_fx: true,
            fade: true,
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

    #[tokio::test]
    async fn plan_scales_tick_duration_by_playback_speed() {
        let recording = Arc::new(CountingRecordingPort::default());
        let (_directory, state) = state_with_recording(recording).await;
        let response = plan(
            State(state),
            ApiJson(RecordingQueueRequest {
                items: vec![RecordingQueueItem {
                    client_id: None,
                    id: None,
                    demo_id: Uuid::new_v4().to_string(),
                    demo_name: None,
                    player_name: Some("Player".to_owned()),
                    player_id: None,
                    title: None,
                    highlight_id: None,
                    start_tick: 0,
                    end_tick: 640,
                    playback_speed: Some(2.0),
                    pre_roll_seconds: 1.0,
                    post_roll_seconds: 2.0,
                    perspective: Some("pov".to_owned()),
                    victim_pov: None,
                    show_keyboard: None,
                    show_kill_fx: None,
                    fade: None,
                }],
            }),
        )
        .await
        .expect("valid plan")
        .0;

        assert_eq!(response.active_items, 1);
        assert!((response.estimated_seconds - 8.0).abs() < f64::EPSILON);
    }

    #[tokio::test]
    async fn duplicate_execute_does_not_call_runtime_or_clear_active_job() {
        let recording = Arc::new(CountingRecordingPort::default());
        let (_directory, state) = state_with_recording(Arc::clone(&recording)).await;
        let id = Uuid::new_v4();
        state
            .storage
            .put_recording_job(recording_job(id, JobStatus::Queued))
            .await
            .expect("job");
        *state.active_recording.lock().await = Some(id);

        let error = execute_existing(
            State(state.clone()),
            ApiJson(ExecuteRequest {
                job_id: id.to_string(),
            }),
        )
        .await
        .expect_err("duplicate execution must fail");
        assert_eq!(error.into_response().status(), StatusCode::CONFLICT);
        assert_eq!(recording.executions.load(Ordering::Relaxed), 0);
        assert_eq!(*state.active_recording.lock().await, Some(id));
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
