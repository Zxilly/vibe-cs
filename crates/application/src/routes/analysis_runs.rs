use std::sync::Arc;

use async_trait::async_trait;
use axum::{
    Json, Router,
    body::Body,
    extract::{Path as AxumPath, State},
    http::{HeaderValue, StatusCode, header},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use uuid::Uuid;
use vibe_cs_domain::{
    AnalysisInputFingerprint, AnalysisRun, AnalysisRunDetail, AnalysisRunStatus, DomainError,
    MatchAnalysis,
};

use crate::{
    AnalysisCancellation, AnalysisProgressReporter, ApiError, ApiResult, AppState,
    analysis_tasks::{AnalysisTaskError, AnalysisTaskOwner},
};

pub(crate) fn router() -> Router<AppState> {
    Router::new()
        .route("/api/demos/{id}/analysis-runs", post(start_analysis_run))
        .route(
            "/api/demos/{id}/analysis-runs/active",
            get(get_active_analysis_run),
        )
        .route("/api/analysis-runs/{id}", get(get_analysis_run))
        .route("/api/analysis-runs/{id}/cancel", post(cancel_analysis_run))
        .route(
            "/api/analysis-runs/{id}/result",
            get(get_analysis_run_result),
        )
        .route(
            "/api/analysis-runs/{id}/replay/rounds/{round}/replay.bin",
            get(get_analysis_run_round_replay),
        )
}

#[derive(Debug)]
struct PersistedAnalysisProgress {
    storage: vibe_cs_storage::Storage,
    run_id: Uuid,
}

#[async_trait]
impl AnalysisProgressReporter for PersistedAnalysisProgress {
    async fn parser_started(&self) -> Result<(), DomainError> {
        self.storage
            .mark_analysis_parser_started(self.run_id)
            .await
            .map(|_| ())
            .map_err(|error| DomainError::Internal(error.to_string()))
    }
}

async fn start_analysis_run(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
) -> ApiResult<impl IntoResponse> {
    let demo_id = parse_id(&id, "demo id")?;
    let (accepted_sender, accepted_receiver) = tokio::sync::oneshot::channel();
    tokio::spawn(supervise_analysis_start(state, demo_id, accepted_sender));
    let run = accepted_receiver.await.map_err(|_| {
        ApiError::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            "analysis_start_failed",
            "The analysis owner stopped before accepting the run",
        )
    })??;
    Ok((StatusCode::ACCEPTED, Json(run)))
}

async fn supervise_analysis_start(
    state: AppState,
    demo_id: Uuid,
    accepted: tokio::sync::oneshot::Sender<Result<AnalysisRun, ApiError>>,
) {
    let claim = match state.storage.start_analysis_run(demo_id).await {
        Ok(claim) => claim,
        Err(error) => {
            let _ = accepted.send(Err(error.into()));
            return;
        }
    };
    let run = claim.run.clone();
    let created = claim.created;
    if !created {
        let response = if state.analysis_tasks.has_owner(run.id) {
            Ok(run)
        } else {
            Err(ApiError::new(
                StatusCode::CONFLICT,
                "analysis_owner_unavailable",
                "The active analysis run has no live owner",
            ))
        };
        let _ = accepted.send(response);
        return;
    }
    let Ok(owner) = state.analysis_tasks.register(run.id) else {
        let _ = accepted.send(Err(ApiError::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            "analysis_owner_registration_failed",
            "The analysis owner could not be registered",
        )));
        return;
    };
    let _ = accepted.send(Ok(run.clone()));

    let cancellation = owner.cancellation();
    let worker_state = state.clone();
    let worker =
        tokio::spawn(async move { run_analysis(&worker_state, claim, cancellation).await });
    let prepared = match worker.await {
        Ok(result) => result,
        Err(error) => Err(DomainError::CleanupFailed(format!(
            "analysis background task stopped without a cleanup acknowledgement: {error}"
        ))),
    };
    settle_analysis_run(&state, run.id, owner, prepared).await;
}

async fn settle_analysis_run(
    state: &AppState,
    run_id: Uuid,
    owner: AnalysisTaskOwner,
    prepared: Result<(MatchAnalysis, AnalysisInputFingerprint), DomainError>,
) {
    match owner.try_begin_commit() {
        Err(AnalysisTaskError::CancellationRequested) => {
            if let Err(DomainError::CleanupFailed(error)) = &prepared {
                terminalize_owner_failure(
                    state,
                    run_id,
                    format!("analysis cancellation cleanup failed: {error}"),
                )
                .await;
                owner.finish_cancellation_cleanup_failed();
                return;
            }
            match terminalize_owner_cancellation(state, run_id).await {
                Ok(run) => {
                    owner.finish_cancelled(run);
                    state.events.publish("analysis", "cancelled", Some(run_id));
                }
                Err(error) => {
                    tracing::warn!(%run_id, %error, "analysis cancellation could not be terminalized");
                }
            }
        }
        Ok(()) => {
            match prepared {
                Ok((analysis, observed_source_fingerprint_after_parse)) => {
                    match state
                        .storage
                        .complete_analysis_run(
                            run_id,
                            analysis,
                            observed_source_fingerprint_after_parse,
                        )
                        .await
                    {
                        Ok(_) => {
                            state.events.publish("analysis", "completed", Some(run_id));
                        }
                        Err(error) => {
                            terminalize_owner_failure(state, run_id, error.to_string()).await;
                        }
                    }
                }
                Err(error) => {
                    terminalize_owner_failure(state, run_id, error.to_string()).await;
                }
            }
            owner.finish_terminal();
        }
        Err(error) => {
            tracing::warn!(%run_id, ?error, "analysis owner lost terminal arbitration");
        }
    }
}

async fn terminalize_owner_cancellation(
    state: &AppState,
    run_id: Uuid,
) -> Result<AnalysisRun, DomainError> {
    const INITIAL_RETRY_DELAY: std::time::Duration = std::time::Duration::from_millis(100);
    const MAX_RETRY_DELAY: std::time::Duration = std::time::Duration::from_secs(5);
    let mut retry_delay = INITIAL_RETRY_DELAY;
    loop {
        match state.storage.get_analysis_run(run_id).await {
            Ok(Some(detail)) if detail.run.status == AnalysisRunStatus::Cancelled => {
                return Ok(detail.run);
            }
            Ok(Some(detail)) if detail.run.status.is_terminal() => {
                return Err(DomainError::Conflict(
                    "analysis run reached another terminal state before cancellation".to_owned(),
                ));
            }
            Ok(Some(_)) => {}
            Ok(None) => return Err(DomainError::NotFound("analysis run".to_owned())),
            Err(error) if !error.is_transient() => {
                return Err(DomainError::Internal(format!(
                    "analysis cancellation persistence is permanently unavailable: {error}"
                )));
            }
            Err(error) => {
                tracing::warn!(
                    %run_id,
                    %error,
                    retry_delay_ms = retry_delay.as_millis(),
                    "retrying analysis cancellation inspection"
                );
                tokio::time::sleep(retry_delay).await;
                retry_delay = retry_delay.saturating_mul(2).min(MAX_RETRY_DELAY);
                continue;
            }
        }
        match state.storage.cancel_analysis_run(run_id).await {
            Ok(run) => return Ok(run),
            Err(vibe_cs_storage::StorageError::Domain(error)) => return Err(error),
            Err(error) if !error.is_transient() => {
                return Err(DomainError::Internal(format!(
                    "analysis cancellation persistence is permanently unavailable: {error}"
                )));
            }
            Err(error) => {
                tracing::warn!(
                    %run_id,
                    %error,
                    retry_delay_ms = retry_delay.as_millis(),
                    "retrying analysis cancellation persistence"
                );
            }
        }
        tokio::time::sleep(retry_delay).await;
        retry_delay = retry_delay.saturating_mul(2).min(MAX_RETRY_DELAY);
    }
}

async fn terminalize_owner_failure(state: &AppState, run_id: Uuid, message: String) {
    const INITIAL_RETRY_DELAY: std::time::Duration = std::time::Duration::from_millis(100);
    const MAX_RETRY_DELAY: std::time::Duration = std::time::Duration::from_secs(5);
    let mut attempt = 0_u64;
    let mut retry_delay = INITIAL_RETRY_DELAY;
    loop {
        attempt = attempt.saturating_add(1);
        match state.storage.get_analysis_run(run_id).await {
            Ok(Some(detail)) if detail.run.status.is_terminal() => return,
            Ok(Some(_)) => {}
            Ok(None) => {
                tracing::warn!(%run_id, "analysis run disappeared before failure reconciliation");
                return;
            }
            Err(error) if !error.is_transient() => {
                tracing::error!(
                    %run_id,
                    %error,
                    "analysis failure reconciliation stopped at a permanent storage health boundary"
                );
                return;
            }
            Err(error) => {
                tracing::warn!(
                    %run_id,
                    %error,
                    attempt,
                    retry_delay_ms = retry_delay.as_millis(),
                    "unable to inspect analysis run before failure reconciliation"
                );
                tokio::time::sleep(retry_delay).await;
                retry_delay = retry_delay.saturating_mul(2).min(MAX_RETRY_DELAY);
                continue;
            }
        }
        match state
            .storage
            .fail_analysis_run(run_id, message.clone())
            .await
        {
            Ok(_) => {
                state.events.publish("analysis", "failed", Some(run_id));
                return;
            }
            Err(error) if !error.is_transient() => {
                tracing::error!(
                    %run_id,
                    %error,
                    "analysis failure persistence stopped at a permanent storage health boundary"
                );
                return;
            }
            Err(error) => {
                tracing::warn!(
                    %run_id,
                    %error,
                    attempt,
                    retry_delay_ms = retry_delay.as_millis(),
                    "retrying analysis failure persistence"
                );
            }
        }
        tokio::time::sleep(retry_delay).await;
        retry_delay = retry_delay.saturating_mul(2).min(MAX_RETRY_DELAY);
    }
}

async fn run_analysis(
    state: &AppState,
    claim: vibe_cs_storage::AnalysisRunClaim,
    cancellation: AnalysisCancellation,
) -> Result<(MatchAnalysis, AnalysisInputFingerprint), DomainError> {
    let run_id = claim.run.id;
    ensure_not_cancelled(&cancellation)?;
    let initial = state
        .analysis
        .validate_input(claim.demo.clone(), cancellation.clone())
        .await?;
    ensure_not_cancelled(&cancellation)?;
    state
        .storage
        .bind_analysis_run_input(run_id, initial)
        .await
        .map_err(storage_domain_error)?;
    ensure_not_cancelled(&cancellation)?;
    let progress: Arc<dyn AnalysisProgressReporter> = Arc::new(PersistedAnalysisProgress {
        storage: state.storage.clone(),
        run_id,
    });
    let analysis = state
        .analysis
        .analyze(claim.demo.clone(), progress, cancellation.clone())
        .await?;
    ensure_not_cancelled(&cancellation)?;
    state
        .storage
        .mark_analysis_input_revalidation_started(run_id)
        .await
        .map_err(storage_domain_error)?;
    ensure_not_cancelled(&cancellation)?;
    let observed_source_fingerprint_after_parse = state
        .analysis
        .validate_input(claim.demo, cancellation.clone())
        .await?;
    ensure_not_cancelled(&cancellation)?;
    state
        .storage
        .mark_analysis_projection_started(run_id)
        .await
        .map_err(storage_domain_error)?;
    ensure_not_cancelled(&cancellation)?;
    Ok((analysis, observed_source_fingerprint_after_parse))
}

fn ensure_not_cancelled(cancellation: &AnalysisCancellation) -> Result<(), DomainError> {
    if cancellation.is_cancelled() {
        Err(DomainError::Conflict(
            "analysis_cancelled_by_user".to_owned(),
        ))
    } else {
        Ok(())
    }
}

async fn cancel_analysis_run(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
) -> ApiResult<Json<AnalysisRunDetail>> {
    let run_id = parse_id(&id, "analysis run id")?;
    let detail = state
        .storage
        .get_analysis_run(run_id)
        .await?
        .ok_or_else(|| ApiError::not_found("analysis run"))?;
    if detail.run.status == AnalysisRunStatus::Cancelled {
        return Ok(Json(detail));
    }
    if detail.run.status.is_terminal() {
        return Err(ApiError::new(
            StatusCode::CONFLICT,
            "analysis_run_not_cancellable",
            "The analysis run is already terminal",
        ));
    }
    let waiter = state
        .analysis_tasks
        .request_cancel(run_id)
        .map_err(|error| {
            let (code, message) = match error {
                AnalysisTaskError::CommitInProgress => (
                    "analysis_commit_in_progress",
                    "The analysis result is already being committed",
                ),
                _ => (
                    "analysis_owner_unavailable",
                    "The active analysis run has no live owner",
                ),
            };
            ApiError::new(StatusCode::CONFLICT, code, message)
        })?;
    waiter.wait().await.map_err(|error| match error {
        AnalysisTaskError::CancellationCleanupFailed => ApiError::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            "analysis_cancellation_cleanup_failed",
            "The analysis worker stopped with unresolved cleanup debt",
        ),
        _ => ApiError::new(
            StatusCode::CONFLICT,
            "analysis_owner_unavailable",
            "The analysis owner stopped before cancellation completed",
        ),
    })?;
    state
        .storage
        .get_analysis_run(run_id)
        .await?
        .map(Json)
        .ok_or_else(|| ApiError::not_found("analysis run"))
}

async fn get_analysis_run(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
) -> ApiResult<Json<AnalysisRunDetail>> {
    let run_id = parse_id(&id, "analysis run id")?;
    state
        .storage
        .get_analysis_run(run_id)
        .await?
        .map(Json)
        .ok_or_else(|| ApiError::not_found("analysis run"))
}

async fn get_active_analysis_run(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
) -> ApiResult<Json<AnalysisRunDetail>> {
    let demo_id = parse_id(&id, "demo id")?;
    state
        .storage
        .get_active_analysis_run(demo_id)
        .await?
        .map(Json)
        .ok_or_else(|| ApiError::not_found("active analysis run"))
}

async fn get_analysis_run_result(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
) -> ApiResult<Json<vibe_cs_domain::MatchAnalysis>> {
    let run_id = parse_id(&id, "analysis run id")?;
    state
        .storage
        .get_analysis_for_run(run_id)
        .await?
        .map(Json)
        .ok_or_else(|| ApiError::not_found("analysis run result"))
}

async fn get_analysis_run_round_replay(
    State(state): State<AppState>,
    AxumPath((id, round)): AxumPath<(String, String)>,
) -> ApiResult<Response> {
    const MAXIMUM_ROUND_REPLAY_BYTES: usize = 128 * 1024 * 1024;
    let run_id = parse_id(&id, "analysis run id")?;
    let round = round.parse::<u32>().map_err(|_| {
        ApiError::invalid("analysis replay round must be a positive integer".to_owned())
    })?;
    if round == 0 {
        return Err(ApiError::invalid(
            "analysis replay round must be a positive integer".to_owned(),
        ));
    }
    let artifact = state.analysis.replay_round(run_id, round).await?;
    let payload = serde_json::to_vec(&artifact).map_err(|error| {
        ApiError::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            "round_replay_serialization_failed",
            error.to_string(),
        )
    })?;
    if payload.len() > MAXIMUM_ROUND_REPLAY_BYTES {
        return Err(ApiError::new(
            StatusCode::PAYLOAD_TOO_LARGE,
            "round_replay_too_large",
            "The selected-round replay exceeds the response budget",
        ));
    }
    let payload_len = u32::try_from(payload.len()).map_err(|_| {
        ApiError::new(
            StatusCode::PAYLOAD_TOO_LARGE,
            "round_replay_too_large",
            "The selected-round replay exceeds the response budget",
        )
    })?;
    let mut body = Vec::with_capacity(12 + payload.len());
    body.extend_from_slice(b"RRPL");
    body.extend_from_slice(&1_u16.to_le_bytes());
    body.extend_from_slice(&0_u16.to_le_bytes());
    body.extend_from_slice(&payload_len.to_le_bytes());
    body.extend_from_slice(&payload);
    let mut response = Response::new(Body::from(body));
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/vnd.vibe-cs.round-replay"),
    );
    Ok(response)
}

fn parse_id(value: &str, label: &str) -> ApiResult<Uuid> {
    Uuid::parse_str(value).map_err(|_| ApiError::invalid(format!("{label} must be a UUID")))
}

fn storage_domain_error(error: vibe_cs_storage::StorageError) -> DomainError {
    match error {
        vibe_cs_storage::StorageError::Domain(error) => error,
        other => DomainError::Internal(other.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use std::sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    };

    use async_trait::async_trait;
    use axum::{
        body::{Body, to_bytes},
        http::{Method, Request},
    };
    use chrono::Utc;
    use tower::ServiceExt as _;
    use vibe_cs_domain::{
        AnalysisInputFingerprint, AnalysisRunStage, AnalysisRunStatus, DemoRecord, DemoStatus,
        HeatPoint, MatchAnalysis,
    };

    use super::*;

    #[derive(Debug)]
    struct BlockingAnalysis {
        calls: AtomicUsize,
        validations: AtomicUsize,
        entered: tokio::sync::Notify,
        release: tokio::sync::Notify,
        fail_after_release: bool,
    }

    impl Default for BlockingAnalysis {
        fn default() -> Self {
            Self {
                calls: AtomicUsize::new(0),
                validations: AtomicUsize::new(0),
                entered: tokio::sync::Notify::new(),
                release: tokio::sync::Notify::new(),
                fail_after_release: false,
            }
        }
    }

    impl BlockingAnalysis {
        fn failing() -> Self {
            Self {
                fail_after_release: true,
                ..Self::default()
            }
        }
    }

    #[async_trait]
    impl crate::AnalysisPort for BlockingAnalysis {
        async fn validate_input(
            &self,
            demo: DemoRecord,
            cancellation: AnalysisCancellation,
        ) -> Result<AnalysisInputFingerprint, DomainError> {
            ensure_not_cancelled(&cancellation)?;
            self.validations.fetch_add(1, Ordering::SeqCst);
            Ok(AnalysisInputFingerprint {
                sha256: demo.content_sha256.unwrap(),
                size: demo.file_size,
            })
        }

        async fn analyze(
            &self,
            demo: DemoRecord,
            progress: Arc<dyn AnalysisProgressReporter>,
            cancellation: AnalysisCancellation,
        ) -> Result<MatchAnalysis, DomainError> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            progress.parser_started().await?;
            self.entered.notify_one();
            tokio::select! {
                () = self.release.notified() => {}
                () = cancellation.cancelled() => {
                    return Err(DomainError::Conflict("analysis_cancelled_by_user".to_owned()));
                }
            }
            if self.fail_after_release {
                return Err(DomainError::Internal(
                    "parser failed after acceptance".to_owned(),
                ));
            }
            Ok(MatchAnalysis {
                demo_id: demo.id,
                map_name: "de_mirage".to_owned(),
                tick_rate: 64.0,
                duration_seconds: 1.0,
                verified_total_ticks: None,
                teams: Vec::new(),
                players: Vec::new(),
                rounds: Vec::new(),
                highlights: Vec::new(),
            })
        }

        async fn replay(&self, _: DemoRecord) -> Result<crate::ReplayPayload, DomainError> {
            unreachable!()
        }
        async fn replay_round(
            &self,
            run_id: Uuid,
            round: u32,
        ) -> Result<vibe_cs_domain::RoundReplayArtifact, DomainError> {
            Ok(round_replay_artifact(run_id, round))
        }
        async fn heatmap(&self, _: DemoRecord) -> Result<Vec<HeatPoint>, DomainError> {
            unreachable!()
        }
        async fn replay_cache_status(&self) -> Result<crate::ReplayCacheStatus, DomainError> {
            unreachable!()
        }
        async fn clear_replay_cache(&self) -> Result<crate::ReplayCacheCleanup, DomainError> {
            unreachable!()
        }
    }

    fn demo() -> DemoRecord {
        let now = Utc::now();
        DemoRecord {
            id: Uuid::new_v4(),
            path: "C:/matches/current.dem".to_owned(),
            file_name: "current.dem".to_owned(),
            display_name: "Current".to_owned(),
            source: "local".to_owned(),
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
            content_sha256: Some("a".repeat(64)),
            file_size: 512,
            created_at: now,
            updated_at: now,
        }
    }

    fn round_replay_artifact(run_id: Uuid, round: u32) -> vibe_cs_domain::RoundReplayArtifact {
        vibe_cs_domain::RoundReplayArtifact {
            metadata: vibe_cs_domain::RoundReplayMetadata {
                producer_run_id: run_id,
                demo_id: Uuid::new_v4(),
                input_sha256: "a".repeat(64),
                input_size: 1,
                round,
                start_tick: 100,
                end_tick: 100,
                tick_rate: 64.0,
                sampling_contract_version: 1,
                sample_interval_ticks: 16,
                requested_tick_count: 1,
                accepted_tick_count: 1,
                event_tick_count: 0,
                players_per_frame: 10,
                fields: vibe_cs_domain::RoundReplayFields {
                    position: vibe_cs_domain::RoundReplayFieldAvailability::Required,
                    yaw: vibe_cs_domain::RoundReplayFieldAvailability::Required,
                    health: vibe_cs_domain::RoundReplayFieldAvailability::Required,
                    armor: vibe_cs_domain::RoundReplayFieldAvailability::Required,
                    life_state: vibe_cs_domain::RoundReplayFieldAvailability::Required,
                    active_weapon_name: vibe_cs_domain::RoundReplayFieldAvailability::Nullable,
                },
            },
            frames: vec![vibe_cs_domain::RoundReplayFrame {
                tick: 100,
                players: Vec::new(),
            }],
        }
    }

    async fn wait_for_terminal(
        storage: &vibe_cs_storage::Storage,
        run_id: Uuid,
    ) -> AnalysisRunDetail {
        tokio::time::timeout(std::time::Duration::from_secs(2), async {
            loop {
                let detail = storage.get_analysis_run(run_id).await.unwrap().unwrap();
                if detail.run.status.is_terminal() {
                    return detail;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("analysis terminal state")
    }

    #[tokio::test]
    async fn exact_run_round_replay_route_returns_the_versioned_bounded_envelope() {
        let storage = vibe_cs_storage::Storage::open_in_memory().await.unwrap();
        let directory = tempfile::TempDir::new().unwrap();
        let run_id = Uuid::new_v4();
        let response = crate::build_dispatcher(
            AppState::new(storage, directory.path().join("data"))
                .with_analysis(Arc::new(BlockingAnalysis::default())),
        )
        .oneshot(
            Request::builder()
                .uri(format!(
                    "/api/analysis-runs/{run_id}/replay/rounds/20/replay.bin"
                ))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            response.headers().get(header::CONTENT_TYPE).unwrap(),
            "application/vnd.vibe-cs.round-replay"
        );
        let bytes = to_bytes(response.into_body(), 1024 * 1024).await.unwrap();
        assert_eq!(&bytes[..4], b"RRPL");
        assert_eq!(u16::from_le_bytes(bytes[4..6].try_into().unwrap()), 1);
        assert_eq!(u16::from_le_bytes(bytes[6..8].try_into().unwrap()), 0);
        let length = u32::from_le_bytes(bytes[8..12].try_into().unwrap()) as usize;
        assert_eq!(length, bytes.len() - 12);
        let artifact: vibe_cs_domain::RoundReplayArtifact =
            serde_json::from_slice(&bytes[12..]).unwrap();
        assert_eq!(artifact.metadata.producer_run_id, run_id);
        assert_eq!(artifact.metadata.round, 20);
    }

    #[tokio::test]
    async fn accepted_request_does_not_own_or_cancel_the_background_analysis() {
        let storage = vibe_cs_storage::Storage::open_in_memory().await.unwrap();
        let demo = demo();
        let demo_id = demo.id;
        storage.put_demo(demo).await.unwrap();
        let analysis = Arc::new(BlockingAnalysis::default());
        let directory = tempfile::tempdir().unwrap();
        let state = AppState::new(storage.clone(), directory.path().join("data"))
            .with_analysis(analysis.clone());

        let response = start_analysis_run(State(state.clone()), AxumPath(demo_id.to_string()))
            .await
            .expect("accepted")
            .into_response();
        assert_eq!(response.status(), StatusCode::ACCEPTED);
        tokio::time::timeout(
            std::time::Duration::from_secs(2),
            analysis.entered.notified(),
        )
        .await
        .expect("analysis entered");
        let runs = storage.list_analysis_runs(demo_id).await.unwrap();
        assert_eq!(runs.len(), 1);
        assert_eq!(runs[0].stage, AnalysisRunStage::ParserRunning);

        let duplicate = start_analysis_run(State(state), AxumPath(demo_id.to_string()))
            .await
            .expect("duplicate accepted")
            .into_response();
        assert_eq!(duplicate.status(), StatusCode::ACCEPTED);
        assert_eq!(analysis.calls.load(Ordering::SeqCst), 1);

        analysis.release.notify_one();
        let detail = wait_for_terminal(&storage, runs[0].id).await;
        assert_eq!(detail.run.status, AnalysisRunStatus::Completed);
        assert!(detail.result_available);
        assert_eq!(analysis.validations.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn dispatcher_exposes_only_the_current_analysis_run_http_contract() {
        let storage = vibe_cs_storage::Storage::open_in_memory().await.unwrap();
        let demo = demo();
        let demo_id = demo.id;
        storage.put_demo(demo).await.unwrap();
        let analysis = Arc::new(BlockingAnalysis::default());
        let directory = tempfile::tempdir().unwrap();
        let dispatcher = crate::build_dispatcher(
            AppState::new(storage.clone(), directory.path().join("data"))
                .with_analysis(analysis.clone()),
        );

        let accepted = dispatcher
            .clone()
            .oneshot(
                Request::builder()
                    .method(Method::POST)
                    .uri(format!("/api/demos/{demo_id}/analysis-runs"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(accepted.status(), StatusCode::ACCEPTED);
        let accepted: AnalysisRun =
            serde_json::from_slice(&to_bytes(accepted.into_body(), 64 * 1024).await.unwrap())
                .unwrap();
        assert_eq!(accepted.demo_id, demo_id);
        assert_eq!(accepted.status, AnalysisRunStatus::Queued);
        assert_eq!(accepted.stage, AnalysisRunStage::ValidatingInput);
        assert_eq!(accepted.input_sha256, None);
        assert_eq!(accepted.input_size, None);

        tokio::time::timeout(
            std::time::Duration::from_secs(2),
            analysis.entered.notified(),
        )
        .await
        .expect("analysis entered");
        let active = dispatcher
            .clone()
            .oneshot(
                Request::builder()
                    .uri(format!("/api/demos/{demo_id}/analysis-runs/active"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(active.status(), StatusCode::OK);
        let active: AnalysisRunDetail =
            serde_json::from_slice(&to_bytes(active.into_body(), 64 * 1024).await.unwrap())
                .unwrap();
        assert_eq!(active.run.id, accepted.id);
        assert_eq!(active.run.stage, AnalysisRunStage::ParserRunning);
        assert_eq!(active.events.len(), 3);
        assert!(!active.result_available);

        let detail = dispatcher
            .clone()
            .oneshot(
                Request::builder()
                    .uri(format!("/api/analysis-runs/{}", accepted.id))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(detail.status(), StatusCode::OK);
        let detail: AnalysisRunDetail =
            serde_json::from_slice(&to_bytes(detail.into_body(), 64 * 1024).await.unwrap())
                .unwrap();
        assert_eq!(detail.run.id, accepted.id);

        let unavailable_result = dispatcher
            .clone()
            .oneshot(
                Request::builder()
                    .uri(format!("/api/analysis-runs/{}/result", accepted.id))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(unavailable_result.status(), StatusCode::NOT_FOUND);

        let invalid = dispatcher
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/api/analysis-runs/not-a-uuid")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(invalid.status(), StatusCode::BAD_REQUEST);

        let retired = dispatcher
            .oneshot(
                Request::builder()
                    .method(Method::POST)
                    .uri(format!("/api/demos/{demo_id}/analysis"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(retired.status(), StatusCode::METHOD_NOT_ALLOWED);

        analysis.release.notify_one();
        let terminal = wait_for_terminal(&storage, accepted.id).await;
        assert_eq!(terminal.run.status, AnalysisRunStatus::Completed);

        let result = crate::build_dispatcher(
            AppState::new(storage, directory.path().join("result-data")).with_analysis(analysis),
        )
        .oneshot(
            Request::builder()
                .uri(format!("/api/analysis-runs/{}/result", accepted.id))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
        assert_eq!(result.status(), StatusCode::OK);
        let result: MatchAnalysis =
            serde_json::from_slice(&to_bytes(result.into_body(), 64 * 1024).await.unwrap())
                .unwrap();
        assert_eq!(result.demo_id, demo_id);
    }

    #[tokio::test]
    async fn exact_cancel_waits_for_the_owner_and_persists_cancelled_without_a_result() {
        let storage = vibe_cs_storage::Storage::open_in_memory().await.unwrap();
        let demo = demo();
        let demo_id = demo.id;
        storage.put_demo(demo).await.unwrap();
        let analysis = Arc::new(BlockingAnalysis::default());
        let directory = tempfile::tempdir().unwrap();
        let dispatcher = crate::build_dispatcher(
            AppState::new(storage.clone(), directory.path().join("data"))
                .with_analysis(analysis.clone()),
        );
        let accepted = dispatcher
            .clone()
            .oneshot(
                Request::builder()
                    .method(Method::POST)
                    .uri(format!("/api/demos/{demo_id}/analysis-runs"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let accepted: AnalysisRun =
            serde_json::from_slice(&to_bytes(accepted.into_body(), 64 * 1024).await.unwrap())
                .unwrap();
        tokio::time::timeout(
            std::time::Duration::from_secs(2),
            analysis.entered.notified(),
        )
        .await
        .expect("parser entered");

        let cancelled = tokio::time::timeout(
            std::time::Duration::from_secs(2),
            dispatcher.clone().oneshot(
                Request::builder()
                    .method(Method::POST)
                    .uri(format!("/api/analysis-runs/{}/cancel", accepted.id))
                    .body(Body::empty())
                    .unwrap(),
            ),
        )
        .await
        .expect("cancel owner stopped")
        .unwrap();

        assert_eq!(cancelled.status(), StatusCode::OK);
        let cancelled: AnalysisRunDetail =
            serde_json::from_slice(&to_bytes(cancelled.into_body(), 64 * 1024).await.unwrap())
                .unwrap();
        assert_eq!(cancelled.run.id, accepted.id);
        assert_eq!(cancelled.run.status, AnalysisRunStatus::Cancelled);
        assert_eq!(cancelled.run.stage, AnalysisRunStage::Cancelled);
        assert_eq!(cancelled.run.error, None);
        assert!(!cancelled.result_available);
        assert_eq!(
            cancelled.events.last().unwrap().message_code,
            vibe_cs_domain::AnalysisRunEventCode::Cancelled
        );
        assert_eq!(
            cancelled.events.last().unwrap().detail.as_deref(),
            Some("analysis_cancelled_by_user")
        );
        assert!(
            storage
                .get_analysis_for_run(accepted.id)
                .await
                .unwrap()
                .is_none()
        );
        assert_eq!(
            storage.get_demo(demo_id).await.unwrap().unwrap().status,
            DemoStatus::Discovered
        );
    }

    #[tokio::test]
    async fn cancel_route_is_idempotent_only_for_cancelled_and_rejects_other_exact_states() {
        let storage = vibe_cs_storage::Storage::open_in_memory().await.unwrap();
        let mut records = (0..5)
            .map(|index| {
                let mut record = demo();
                record.id = Uuid::new_v4();
                record.path = format!("C:/matches/cancel-contract-{index}.dem");
                record.file_name = format!("cancel-contract-{index}.dem");
                record.content_sha256 = Some(format!("{:064x}", index + 1));
                record
            })
            .collect::<Vec<_>>();
        let cancelled_demo = records.remove(0);
        let failed_demo = records.remove(0);
        let interrupted_demo = records.remove(0);
        let completed_demo = records.remove(0);
        let active_demo = records.remove(0);
        storage
            .put_demos(vec![
                cancelled_demo.clone(),
                failed_demo.clone(),
                interrupted_demo.clone(),
                completed_demo.clone(),
                active_demo.clone(),
            ])
            .await
            .unwrap();

        let cancelled = storage
            .start_analysis_run(cancelled_demo.id)
            .await
            .unwrap()
            .run;
        storage.cancel_analysis_run(cancelled.id).await.unwrap();
        let failed = storage
            .start_analysis_run(failed_demo.id)
            .await
            .unwrap()
            .run;
        storage
            .fail_analysis_run(failed.id, "parser failed".to_owned())
            .await
            .unwrap();
        let interrupted = storage
            .start_analysis_run(interrupted_demo.id)
            .await
            .unwrap()
            .run;
        assert_eq!(storage.recover_orphaned_analysis_runs().await.unwrap(), 1);
        let completed = storage
            .start_analysis_run(completed_demo.id)
            .await
            .unwrap()
            .run;
        let fingerprint = AnalysisInputFingerprint {
            sha256: completed_demo.content_sha256.clone().unwrap(),
            size: completed_demo.file_size,
        };
        storage
            .bind_analysis_run_input(completed.id, fingerprint.clone())
            .await
            .unwrap();
        storage
            .mark_analysis_parser_started(completed.id)
            .await
            .unwrap();
        storage
            .mark_analysis_input_revalidation_started(completed.id)
            .await
            .unwrap();
        storage
            .mark_analysis_projection_started(completed.id)
            .await
            .unwrap();
        storage
            .complete_analysis_run(
                completed.id,
                MatchAnalysis {
                    demo_id: completed_demo.id,
                    map_name: "de_mirage".to_owned(),
                    tick_rate: 64.0,
                    duration_seconds: 1.0,
                    verified_total_ticks: None,
                    teams: Vec::new(),
                    players: Vec::new(),
                    rounds: Vec::new(),
                    highlights: Vec::new(),
                },
                fingerprint,
            )
            .await
            .unwrap();
        let active = storage
            .start_analysis_run(active_demo.id)
            .await
            .unwrap()
            .run;

        let directory = tempfile::tempdir().unwrap();
        let dispatcher =
            crate::build_dispatcher(AppState::new(storage, directory.path().join("data")));
        let cancelled_response = dispatcher
            .clone()
            .oneshot(
                Request::builder()
                    .method(Method::POST)
                    .uri(format!("/api/analysis-runs/{}/cancel", cancelled.id))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(cancelled_response.status(), StatusCode::OK);
        let detail: AnalysisRunDetail = serde_json::from_slice(
            &to_bytes(cancelled_response.into_body(), 64 * 1024)
                .await
                .unwrap(),
        )
        .unwrap();
        assert_eq!(detail.run.status, AnalysisRunStatus::Cancelled);
        assert!(!detail.result_available);

        for run_id in [failed.id, interrupted.id, completed.id, active.id] {
            let response = dispatcher
                .clone()
                .oneshot(
                    Request::builder()
                        .method(Method::POST)
                        .uri(format!("/api/analysis-runs/{run_id}/cancel"))
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::CONFLICT);
        }
    }

    #[derive(Debug, Default)]
    struct StoppingAnalysis {
        entered: tokio::sync::Notify,
        cancellation_seen: tokio::sync::Notify,
        allow_stop: tokio::sync::Notify,
    }

    #[async_trait]
    impl crate::AnalysisPort for StoppingAnalysis {
        async fn validate_input(
            &self,
            demo: DemoRecord,
            cancellation: AnalysisCancellation,
        ) -> Result<AnalysisInputFingerprint, DomainError> {
            ensure_not_cancelled(&cancellation)?;
            Ok(AnalysisInputFingerprint {
                sha256: demo.content_sha256.unwrap(),
                size: demo.file_size,
            })
        }

        async fn analyze(
            &self,
            _demo: DemoRecord,
            progress: Arc<dyn AnalysisProgressReporter>,
            cancellation: AnalysisCancellation,
        ) -> Result<MatchAnalysis, DomainError> {
            progress.parser_started().await?;
            self.entered.notify_one();
            cancellation.cancelled().await;
            self.cancellation_seen.notify_one();
            self.allow_stop.notified().await;
            Err(DomainError::Conflict(
                "analysis_cancelled_by_user".to_owned(),
            ))
        }

        async fn replay(&self, _: DemoRecord) -> Result<crate::ReplayPayload, DomainError> {
            unreachable!()
        }
        async fn heatmap(&self, _: DemoRecord) -> Result<Vec<HeatPoint>, DomainError> {
            unreachable!()
        }
        async fn replay_cache_status(&self) -> Result<crate::ReplayCacheStatus, DomainError> {
            unreachable!()
        }
        async fn clear_replay_cache(&self) -> Result<crate::ReplayCacheCleanup, DomainError> {
            unreachable!()
        }
    }

    #[derive(Debug, Default)]
    struct CancellationRacingParserFailure {
        entered: tokio::sync::Notify,
        cancellation_seen: tokio::sync::Notify,
        allow_failure: tokio::sync::Notify,
    }

    #[async_trait]
    impl crate::AnalysisPort for CancellationRacingParserFailure {
        async fn validate_input(
            &self,
            demo: DemoRecord,
            cancellation: AnalysisCancellation,
        ) -> Result<AnalysisInputFingerprint, DomainError> {
            ensure_not_cancelled(&cancellation)?;
            Ok(AnalysisInputFingerprint {
                sha256: demo.content_sha256.unwrap(),
                size: demo.file_size,
            })
        }

        async fn analyze(
            &self,
            _demo: DemoRecord,
            progress: Arc<dyn AnalysisProgressReporter>,
            cancellation: AnalysisCancellation,
        ) -> Result<MatchAnalysis, DomainError> {
            progress.parser_started().await?;
            self.entered.notify_one();
            cancellation.cancelled().await;
            self.cancellation_seen.notify_one();
            self.allow_failure.notified().await;
            Err(DomainError::Internal(
                "parser failed concurrently with cancellation".to_owned(),
            ))
        }

        async fn replay(&self, _: DemoRecord) -> Result<crate::ReplayPayload, DomainError> {
            unreachable!()
        }
        async fn heatmap(&self, _: DemoRecord) -> Result<Vec<HeatPoint>, DomainError> {
            unreachable!()
        }
        async fn replay_cache_status(&self) -> Result<crate::ReplayCacheStatus, DomainError> {
            unreachable!()
        }
        async fn clear_replay_cache(&self) -> Result<crate::ReplayCacheCleanup, DomainError> {
            unreachable!()
        }
    }

    #[tokio::test]
    async fn cancellation_claim_wins_over_a_parser_error_ready_before_settlement() {
        let storage = vibe_cs_storage::Storage::open_in_memory().await.unwrap();
        let demo = demo();
        let demo_id = demo.id;
        storage.put_demo(demo).await.unwrap();
        let analysis = Arc::new(CancellationRacingParserFailure::default());
        let directory = tempfile::tempdir().unwrap();
        let state = AppState::new(storage.clone(), directory.path().join("data"))
            .with_analysis(analysis.clone());
        let dispatcher = crate::build_dispatcher(state.clone());
        let accepted = dispatcher
            .clone()
            .oneshot(
                Request::builder()
                    .method(Method::POST)
                    .uri(format!("/api/demos/{demo_id}/analysis-runs"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let accepted: AnalysisRun =
            serde_json::from_slice(&to_bytes(accepted.into_body(), 64 * 1024).await.unwrap())
                .unwrap();
        tokio::time::timeout(
            std::time::Duration::from_secs(2),
            analysis.entered.notified(),
        )
        .await
        .expect("parser entered");

        let cancel_dispatcher = dispatcher.clone();
        let cancel = tokio::spawn(async move {
            cancel_dispatcher
                .oneshot(
                    Request::builder()
                        .method(Method::POST)
                        .uri(format!("/api/analysis-runs/{}/cancel", accepted.id))
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap()
        });
        tokio::time::timeout(
            std::time::Duration::from_secs(2),
            analysis.cancellation_seen.notified(),
        )
        .await
        .expect("cancellation won the registry phase");
        analysis.allow_failure.notify_one();

        let response = tokio::time::timeout(std::time::Duration::from_secs(2), cancel)
            .await
            .expect("shared waiter must receive the durable winner")
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let detail: AnalysisRunDetail =
            serde_json::from_slice(&to_bytes(response.into_body(), 64 * 1024).await.unwrap())
                .unwrap();
        assert_eq!(detail.run.status, AnalysisRunStatus::Cancelled);
        assert_eq!(
            detail
                .events
                .iter()
                .filter(|event| event.stage.is_terminal())
                .count(),
            1
        );
        assert!(!state.analysis_tasks.has_owner(accepted.id));
    }

    #[derive(Debug, Default)]
    struct CleanupFailingAnalysis {
        entered: tokio::sync::Notify,
    }

    #[async_trait]
    impl crate::AnalysisPort for CleanupFailingAnalysis {
        async fn validate_input(
            &self,
            demo: DemoRecord,
            cancellation: AnalysisCancellation,
        ) -> Result<AnalysisInputFingerprint, DomainError> {
            ensure_not_cancelled(&cancellation)?;
            Ok(AnalysisInputFingerprint {
                sha256: demo.content_sha256.unwrap(),
                size: demo.file_size,
            })
        }

        async fn analyze(
            &self,
            _demo: DemoRecord,
            progress: Arc<dyn AnalysisProgressReporter>,
            cancellation: AnalysisCancellation,
        ) -> Result<MatchAnalysis, DomainError> {
            progress.parser_started().await?;
            self.entered.notify_one();
            cancellation.cancelled().await;
            Err(DomainError::CleanupFailed(
                "exact worker request file is still locked".to_owned(),
            ))
        }

        async fn replay(&self, _: DemoRecord) -> Result<crate::ReplayPayload, DomainError> {
            unreachable!()
        }
        async fn heatmap(&self, _: DemoRecord) -> Result<Vec<HeatPoint>, DomainError> {
            unreachable!()
        }
        async fn replay_cache_status(&self) -> Result<crate::ReplayCacheStatus, DomainError> {
            unreachable!()
        }
        async fn clear_replay_cache(&self) -> Result<crate::ReplayCacheCleanup, DomainError> {
            unreachable!()
        }
    }

    #[tokio::test]
    async fn cancellation_cleanup_failure_is_durable_failed_and_never_claimed_cancelled() {
        let storage = vibe_cs_storage::Storage::open_in_memory().await.unwrap();
        let demo = demo();
        let demo_id = demo.id;
        storage.put_demo(demo).await.unwrap();
        let analysis = Arc::new(CleanupFailingAnalysis::default());
        let directory = tempfile::tempdir().unwrap();
        let state = AppState::new(storage.clone(), directory.path().join("data"))
            .with_analysis(analysis.clone());
        let dispatcher = crate::build_dispatcher(state.clone());
        let accepted = dispatcher
            .clone()
            .oneshot(
                Request::builder()
                    .method(Method::POST)
                    .uri(format!("/api/demos/{demo_id}/analysis-runs"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let accepted: AnalysisRun =
            serde_json::from_slice(&to_bytes(accepted.into_body(), 64 * 1024).await.unwrap())
                .unwrap();
        tokio::time::timeout(
            std::time::Duration::from_secs(2),
            analysis.entered.notified(),
        )
        .await
        .expect("parser entered");

        let response = dispatcher
            .oneshot(
                Request::builder()
                    .method(Method::POST)
                    .uri(format!("/api/analysis-runs/{}/cancel", accepted.id))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR);
        let detail = storage
            .get_analysis_run(accepted.id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(detail.run.status, AnalysisRunStatus::Failed);
        assert_eq!(detail.run.stage, AnalysisRunStage::Failed);
        assert!(
            detail
                .run
                .error
                .as_deref()
                .is_some_and(|error| error.contains("cancellation cleanup failed"))
        );
        assert_eq!(
            detail.events.last().unwrap().message_code,
            vibe_cs_domain::AnalysisRunEventCode::Failed
        );
        assert!(!state.analysis_tasks.has_owner(accepted.id));
    }

    #[tokio::test]
    async fn disappearing_run_during_runtime_stop_releases_cancel_waiters_without_fabrication() {
        let storage = vibe_cs_storage::Storage::open_in_memory().await.unwrap();
        let demo = demo();
        let demo_id = demo.id;
        storage.put_demo(demo).await.unwrap();
        let analysis = Arc::new(StoppingAnalysis::default());
        let directory = tempfile::tempdir().unwrap();
        let state = AppState::new(storage.clone(), directory.path().join("data"))
            .with_analysis(analysis.clone());
        let dispatcher = crate::build_dispatcher(state.clone());
        let accepted = dispatcher
            .clone()
            .oneshot(
                Request::builder()
                    .method(Method::POST)
                    .uri(format!("/api/demos/{demo_id}/analysis-runs"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let accepted: AnalysisRun =
            serde_json::from_slice(&to_bytes(accepted.into_body(), 64 * 1024).await.unwrap())
                .unwrap();
        tokio::time::timeout(
            std::time::Duration::from_secs(2),
            analysis.entered.notified(),
        )
        .await
        .expect("parser entered");

        let cancel_dispatcher = dispatcher.clone();
        let cancel = tokio::spawn(async move {
            cancel_dispatcher
                .oneshot(
                    Request::builder()
                        .method(Method::POST)
                        .uri(format!("/api/analysis-runs/{}/cancel", accepted.id))
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap()
        });
        tokio::time::timeout(
            std::time::Duration::from_secs(2),
            analysis.cancellation_seen.notified(),
        )
        .await
        .expect("runtime observed cancellation");
        assert!(storage.delete_demo(demo_id).await.unwrap());
        analysis.allow_stop.notify_one();

        let response = tokio::time::timeout(std::time::Duration::from_secs(2), cancel)
            .await
            .expect("cancel endpoint must not hang")
            .unwrap();
        assert!(!response.status().is_success());
        assert!(!state.analysis_tasks.has_owner(accepted.id));
        assert!(
            storage
                .get_analysis_run(accepted.id)
                .await
                .unwrap()
                .is_none()
        );
    }

    #[tokio::test]
    async fn cancellation_waiter_and_owner_survive_transient_storage_lock_until_durable_terminal() {
        let root = tempfile::tempdir().unwrap();
        let database_path = root.path().join("cancel-retry.sqlite");
        let storage = vibe_cs_storage::Storage::open(&database_path)
            .await
            .unwrap();
        let demo = demo();
        let demo_id = demo.id;
        storage.put_demo(demo).await.unwrap();
        let analysis = Arc::new(StoppingAnalysis::default());
        let state = AppState::new(storage.clone(), root.path().join("data"))
            .with_analysis(analysis.clone());
        let dispatcher = crate::build_dispatcher(state.clone());
        let accepted = dispatcher
            .clone()
            .oneshot(
                Request::builder()
                    .method(Method::POST)
                    .uri(format!("/api/demos/{demo_id}/analysis-runs"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let accepted: AnalysisRun =
            serde_json::from_slice(&to_bytes(accepted.into_body(), 64 * 1024).await.unwrap())
                .unwrap();
        tokio::time::timeout(
            std::time::Duration::from_secs(2),
            analysis.entered.notified(),
        )
        .await
        .expect("parser entered");

        let cancel_dispatcher = dispatcher.clone();
        let cancel = tokio::spawn(async move {
            cancel_dispatcher
                .oneshot(
                    Request::builder()
                        .method(Method::POST)
                        .uri(format!("/api/analysis-runs/{}/cancel", accepted.id))
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap()
        });
        tokio::time::timeout(
            std::time::Duration::from_secs(2),
            analysis.cancellation_seen.notified(),
        )
        .await
        .expect("runtime observed cancellation");

        let (locked_tx, locked_rx) = std::sync::mpsc::channel();
        let (unlock_tx, unlock_rx) = std::sync::mpsc::channel();
        let lock_path = database_path.clone();
        let connection_holder = tokio::task::spawn_blocking(move || {
            let connection = rusqlite::Connection::open(lock_path)?;
            connection.execute_batch("PRAGMA foreign_keys = ON; BEGIN EXCLUSIVE;")?;
            locked_tx.send(()).unwrap();
            unlock_rx.recv().unwrap();
            connection.execute_batch("ROLLBACK")?;
            Ok::<_, rusqlite::Error>(())
        });
        locked_rx.recv().unwrap();
        analysis.allow_stop.notify_one();

        tokio::time::sleep(std::time::Duration::from_secs(11)).await;
        assert!(
            !cancel.is_finished(),
            "waiter must span repeated busy timeouts"
        );
        assert!(
            state.analysis_tasks.has_owner(accepted.id),
            "owner must remain until Cancelled is durable"
        );

        unlock_tx.send(()).unwrap();
        connection_holder.await.unwrap().unwrap();
        let response = tokio::time::timeout(std::time::Duration::from_secs(7), cancel)
            .await
            .expect("cancel retry completion")
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let detail = storage
            .get_analysis_run(accepted.id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(detail.run.status, AnalysisRunStatus::Cancelled);
        assert!(!state.analysis_tasks.has_owner(accepted.id));
    }

    #[tokio::test]
    async fn permanent_storage_corruption_releases_owner_at_an_explicit_health_boundary() {
        let root = tempfile::tempdir().unwrap();
        let database_path = root.path().join("corrupt-cancel.sqlite");
        let storage = vibe_cs_storage::Storage::open(&database_path)
            .await
            .unwrap();
        let demo = demo();
        let demo_id = demo.id;
        storage.put_demo(demo).await.unwrap();
        let analysis = Arc::new(StoppingAnalysis::default());
        let state = AppState::new(storage.clone(), root.path().join("data"))
            .with_analysis(analysis.clone());
        let dispatcher = crate::build_dispatcher(state.clone());
        let accepted = dispatcher
            .clone()
            .oneshot(
                Request::builder()
                    .method(Method::POST)
                    .uri(format!("/api/demos/{demo_id}/analysis-runs"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let accepted: AnalysisRun =
            serde_json::from_slice(&to_bytes(accepted.into_body(), 64 * 1024).await.unwrap())
                .unwrap();
        tokio::time::timeout(
            std::time::Duration::from_secs(2),
            analysis.entered.notified(),
        )
        .await
        .expect("parser entered");
        let cancel_dispatcher = dispatcher.clone();
        let cancel = tokio::spawn(async move {
            cancel_dispatcher
                .oneshot(
                    Request::builder()
                        .method(Method::POST)
                        .uri(format!("/api/analysis-runs/{}/cancel", accepted.id))
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap()
        });
        tokio::time::timeout(
            std::time::Duration::from_secs(2),
            analysis.cancellation_seen.notified(),
        )
        .await
        .expect("runtime observed cancellation");
        rusqlite::Connection::open(&database_path)
            .unwrap()
            .execute(
                "UPDATE analysis_runs SET document_json = '{' WHERE id = ?1",
                [accepted.id.to_string()],
            )
            .unwrap();
        analysis.allow_stop.notify_one();

        let response = tokio::time::timeout(std::time::Duration::from_secs(2), cancel)
            .await
            .expect("permanent corruption must not hot-loop")
            .unwrap();
        assert!(!response.status().is_success());
        assert!(!state.analysis_tasks.has_owner(accepted.id));
        let raw_status: String = rusqlite::Connection::open(database_path)
            .unwrap()
            .query_row(
                "SELECT status FROM analysis_runs WHERE id = ?1",
                [accepted.id.to_string()],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(
            raw_status, "running",
            "corruption must not be fabricated away"
        );
    }

    #[derive(Debug, Default)]
    struct PanickingAnalysis;

    #[async_trait]
    impl crate::AnalysisPort for PanickingAnalysis {
        async fn validate_input(
            &self,
            demo: DemoRecord,
            _cancellation: AnalysisCancellation,
        ) -> Result<AnalysisInputFingerprint, DomainError> {
            Ok(AnalysisInputFingerprint {
                sha256: demo.content_sha256.unwrap(),
                size: demo.file_size,
            })
        }

        async fn analyze(
            &self,
            _demo: DemoRecord,
            progress: Arc<dyn AnalysisProgressReporter>,
            _cancellation: AnalysisCancellation,
        ) -> Result<MatchAnalysis, DomainError> {
            progress.parser_started().await?;
            panic!("parser task panic fixture")
        }

        async fn replay(&self, _: DemoRecord) -> Result<crate::ReplayPayload, DomainError> {
            unreachable!()
        }
        async fn heatmap(&self, _: DemoRecord) -> Result<Vec<HeatPoint>, DomainError> {
            unreachable!()
        }
        async fn replay_cache_status(&self) -> Result<crate::ReplayCacheStatus, DomainError> {
            unreachable!()
        }
        async fn clear_replay_cache(&self) -> Result<crate::ReplayCacheCleanup, DomainError> {
            unreachable!()
        }
    }

    #[tokio::test]
    async fn supervisor_terminalizes_an_inner_analysis_panic() {
        let storage = vibe_cs_storage::Storage::open_in_memory().await.unwrap();
        let demo = demo();
        let demo_id = demo.id;
        storage.put_demo(demo).await.unwrap();
        let directory = tempfile::tempdir().unwrap();
        let state = AppState::new(storage.clone(), directory.path().join("data"))
            .with_analysis(Arc::new(PanickingAnalysis));

        start_analysis_run(State(state), AxumPath(demo_id.to_string()))
            .await
            .expect("accepted");
        let run_id = storage.list_analysis_runs(demo_id).await.unwrap()[0].id;
        let detail = wait_for_terminal(&storage, run_id).await;
        assert_eq!(detail.run.status, AnalysisRunStatus::Failed);
        assert!(
            detail
                .run
                .error
                .as_deref()
                .unwrap()
                .contains("stopped without a cleanup acknowledgement")
        );
        assert!(storage.get_analysis(demo_id).await.unwrap().is_none());
    }

    #[derive(Debug, Default)]
    struct CancellationRacingPanicAnalysis {
        entered: tokio::sync::Notify,
        cancellation_seen: tokio::sync::Notify,
        allow_panic: tokio::sync::Notify,
    }

    #[async_trait]
    impl crate::AnalysisPort for CancellationRacingPanicAnalysis {
        async fn validate_input(
            &self,
            demo: DemoRecord,
            cancellation: AnalysisCancellation,
        ) -> Result<AnalysisInputFingerprint, DomainError> {
            ensure_not_cancelled(&cancellation)?;
            Ok(AnalysisInputFingerprint {
                sha256: demo.content_sha256.unwrap(),
                size: demo.file_size,
            })
        }

        async fn analyze(
            &self,
            _demo: DemoRecord,
            progress: Arc<dyn AnalysisProgressReporter>,
            cancellation: AnalysisCancellation,
        ) -> Result<MatchAnalysis, DomainError> {
            progress.parser_started().await?;
            self.entered.notify_one();
            cancellation.cancelled().await;
            self.cancellation_seen.notify_one();
            self.allow_panic.notified().await;
            panic!("parser panicked before cleanup acknowledgement")
        }

        async fn replay(&self, _: DemoRecord) -> Result<crate::ReplayPayload, DomainError> {
            unreachable!()
        }
        async fn heatmap(&self, _: DemoRecord) -> Result<Vec<HeatPoint>, DomainError> {
            unreachable!()
        }
        async fn replay_cache_status(&self) -> Result<crate::ReplayCacheStatus, DomainError> {
            unreachable!()
        }
        async fn clear_replay_cache(&self) -> Result<crate::ReplayCacheCleanup, DomainError> {
            unreachable!()
        }
    }

    #[tokio::test]
    async fn cancellation_concurrent_with_worker_panic_is_failed_never_cancelled() {
        let storage = vibe_cs_storage::Storage::open_in_memory().await.unwrap();
        let demo = demo();
        let demo_id = demo.id;
        storage.put_demo(demo).await.unwrap();
        let analysis = Arc::new(CancellationRacingPanicAnalysis::default());
        let directory = tempfile::tempdir().unwrap();
        let state = AppState::new(storage.clone(), directory.path().join("data"))
            .with_analysis(analysis.clone());
        let dispatcher = crate::build_dispatcher(state.clone());
        let accepted = dispatcher
            .clone()
            .oneshot(
                Request::builder()
                    .method(Method::POST)
                    .uri(format!("/api/demos/{demo_id}/analysis-runs"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let accepted: AnalysisRun =
            serde_json::from_slice(&to_bytes(accepted.into_body(), 64 * 1024).await.unwrap())
                .unwrap();
        tokio::time::timeout(
            std::time::Duration::from_secs(2),
            analysis.entered.notified(),
        )
        .await
        .expect("parser entered");
        let cancel_dispatcher = dispatcher.clone();
        let cancel = tokio::spawn(async move {
            cancel_dispatcher
                .oneshot(
                    Request::builder()
                        .method(Method::POST)
                        .uri(format!("/api/analysis-runs/{}/cancel", accepted.id))
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap()
        });
        tokio::time::timeout(
            std::time::Duration::from_secs(2),
            analysis.cancellation_seen.notified(),
        )
        .await
        .expect("cancellation reached the worker");
        analysis.allow_panic.notify_one();

        let response = tokio::time::timeout(std::time::Duration::from_secs(2), cancel)
            .await
            .expect("panic cleanup boundary")
            .unwrap();
        assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR);
        let detail = storage
            .get_analysis_run(accepted.id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(detail.run.status, AnalysisRunStatus::Failed);
        assert_eq!(
            detail.events.last().unwrap().message_code,
            vibe_cs_domain::AnalysisRunEventCode::Failed
        );
        assert!(!state.analysis_tasks.has_owner(accepted.id));
    }

    #[tokio::test]
    async fn terminal_failure_reconciliation_survives_more_than_two_database_lock_timeouts() {
        let root = tempfile::tempdir().unwrap();
        let database_path = root.path().join("analysis-terminal.sqlite");
        let storage = vibe_cs_storage::Storage::open(&database_path)
            .await
            .unwrap();
        let demo = demo();
        let demo_id = demo.id;
        storage.put_demo(demo).await.unwrap();
        let analysis = Arc::new(BlockingAnalysis::failing());
        let state = AppState::new(storage.clone(), root.path().join("data"))
            .with_analysis(analysis.clone());

        let accepted = start_analysis_run(State(state.clone()), AxumPath(demo_id.to_string()))
            .await
            .unwrap()
            .into_response();
        let accepted: AnalysisRun =
            serde_json::from_slice(&to_bytes(accepted.into_body(), 64 * 1024).await.unwrap())
                .unwrap();
        tokio::time::timeout(
            std::time::Duration::from_secs(2),
            analysis.entered.notified(),
        )
        .await
        .expect("analysis entered");

        let duplicate = start_analysis_run(State(state), AxumPath(demo_id.to_string()))
            .await
            .unwrap()
            .into_response();
        let duplicate: AnalysisRun =
            serde_json::from_slice(&to_bytes(duplicate.into_body(), 64 * 1024).await.unwrap())
                .unwrap();
        assert_eq!(duplicate.id, accepted.id);
        assert_eq!(analysis.calls.load(Ordering::SeqCst), 1);

        let (locked_tx, locked_rx) = std::sync::mpsc::channel();
        let (unlock_tx, unlock_rx) = std::sync::mpsc::channel();
        let lock_path = database_path.clone();
        let connection_holder = tokio::task::spawn_blocking(move || {
            let connection = rusqlite::Connection::open(lock_path)?;
            connection.execute_batch("PRAGMA foreign_keys = ON; BEGIN EXCLUSIVE;")?;
            locked_tx.send(()).unwrap();
            unlock_rx.recv().unwrap();
            connection.execute_batch("ROLLBACK")?;
            Ok::<_, rusqlite::Error>(())
        });
        locked_rx.recv().unwrap();
        analysis.release.notify_one();

        tokio::time::sleep(std::time::Duration::from_secs(11)).await;
        unlock_tx.send(()).unwrap();
        connection_holder.await.unwrap().unwrap();

        let detail = wait_for_terminal(&storage, accepted.id).await;
        assert_eq!(detail.run.status, AnalysisRunStatus::Failed);
        assert_eq!(analysis.calls.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn failed_analysis_keeps_its_owner_until_the_terminal_write_is_durable() {
        let root = tempfile::tempdir().unwrap();
        let database_path = root.path().join("owned-failure.sqlite");
        let storage = vibe_cs_storage::Storage::open(&database_path)
            .await
            .unwrap();
        let demo = demo();
        let demo_id = demo.id;
        storage.put_demo(demo).await.unwrap();
        let analysis = Arc::new(BlockingAnalysis::failing());
        let state = AppState::new(storage.clone(), root.path().join("data"))
            .with_analysis(analysis.clone());
        let accepted = start_analysis_run(State(state.clone()), AxumPath(demo_id.to_string()))
            .await
            .unwrap()
            .into_response();
        let accepted: AnalysisRun =
            serde_json::from_slice(&to_bytes(accepted.into_body(), 64 * 1024).await.unwrap())
                .unwrap();
        tokio::time::timeout(
            std::time::Duration::from_secs(2),
            analysis.entered.notified(),
        )
        .await
        .expect("analysis entered");

        let (locked_tx, locked_rx) = std::sync::mpsc::channel();
        let (unlock_tx, unlock_rx) = std::sync::mpsc::channel();
        let lock_path = database_path.clone();
        let connection_holder = tokio::task::spawn_blocking(move || {
            let connection = rusqlite::Connection::open(lock_path)?;
            connection.execute_batch("PRAGMA foreign_keys = ON; BEGIN EXCLUSIVE;")?;
            locked_tx.send(()).unwrap();
            unlock_rx.recv().unwrap();
            connection.execute_batch("ROLLBACK")?;
            Ok::<_, rusqlite::Error>(())
        });
        locked_rx.recv().unwrap();
        analysis.release.notify_one();
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;

        assert!(
            state.analysis_tasks.has_owner(accepted.id),
            "the unique owner must survive until Failed is durable"
        );
        assert_eq!(
            state
                .analysis_tasks
                .request_cancel(accepted.id)
                .unwrap_err(),
            AnalysisTaskError::CommitInProgress,
            "parser failure must atomically claim Committing before durable failure reconciliation"
        );

        unlock_tx.send(()).unwrap();
        connection_holder.await.unwrap().unwrap();
        let detail = wait_for_terminal(&storage, accepted.id).await;
        assert_eq!(detail.run.status, AnalysisRunStatus::Failed);
        assert!(!state.analysis_tasks.has_owner(accepted.id));
    }

    #[tokio::test]
    async fn aborting_the_http_waiter_while_claim_is_blocked_does_not_orphan_the_run() {
        let root = tempfile::tempdir().unwrap();
        let database_path = root.path().join("analysis.sqlite");
        let storage = vibe_cs_storage::Storage::open(&database_path)
            .await
            .unwrap();
        let demo = demo();
        let demo_id = demo.id;
        storage.put_demo(demo).await.unwrap();
        let analysis = Arc::new(BlockingAnalysis::default());
        let state = AppState::new(storage.clone(), root.path().join("data"))
            .with_analysis(analysis.clone());

        let (entered_tx, entered_rx) = std::sync::mpsc::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let lock_path = database_path.clone();
        let connection_holder = tokio::task::spawn_blocking(move || {
            let connection = rusqlite::Connection::open(lock_path)?;
            connection.execute_batch("PRAGMA foreign_keys = ON; BEGIN EXCLUSIVE;")?;
            entered_tx.send(()).unwrap();
            release_rx.recv().unwrap();
            connection.execute_batch("ROLLBACK")?;
            Ok::<_, rusqlite::Error>(())
        });
        entered_rx.recv().unwrap();

        let request_state = state.clone();
        let request = tokio::spawn(async move {
            start_analysis_run(State(request_state), AxumPath(demo_id.to_string())).await
        });
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        request.abort();
        let _ = request.await;
        release_tx.send(()).unwrap();
        connection_holder.await.unwrap().unwrap();

        tokio::time::timeout(
            std::time::Duration::from_secs(2),
            analysis.entered.notified(),
        )
        .await
        .expect("analysis entered after claim");
        let run_id = storage.list_analysis_runs(demo_id).await.unwrap()[0].id;
        analysis.release.notify_one();
        let detail = wait_for_terminal(&storage, run_id).await;
        assert_eq!(detail.run.status, AnalysisRunStatus::Completed);
        assert_eq!(analysis.calls.load(Ordering::SeqCst), 1);

        let duplicate = start_analysis_run(State(state), AxumPath(demo_id.to_string())).await;
        assert!(
            duplicate.is_err(),
            "completed analysis must not be started again"
        );
        assert_eq!(analysis.calls.load(Ordering::SeqCst), 1);
    }
}
