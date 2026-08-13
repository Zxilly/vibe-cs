use std::sync::Arc;

use async_trait::async_trait;
use axum::{
    Json, Router,
    extract::{Path as AxumPath, State},
    http::StatusCode,
    response::IntoResponse,
    routing::{get, post},
};
use uuid::Uuid;
use vibe_cs_domain::{AnalysisRun, AnalysisRunDetail, DomainError};

use crate::{AnalysisProgressReporter, ApiError, ApiResult, AppState};

pub(crate) fn router() -> Router<AppState> {
    Router::new()
        .route("/api/demos/{id}/analysis-runs", post(start_analysis_run))
        .route(
            "/api/demos/{id}/analysis-runs/active",
            get(get_active_analysis_run),
        )
        .route("/api/analysis-runs/{id}", get(get_analysis_run))
        .route(
            "/api/analysis-runs/{id}/result",
            get(get_analysis_run_result),
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
    let _ = accepted.send(Ok(run.clone()));
    if !created {
        return;
    }

    let owner_state = state.clone();
    let owner = tokio::spawn(async move { own_analysis_run(owner_state, claim).await });
    match owner.await {
        Ok(Ok(())) => {}
        Ok(Err(error)) => {
            terminalize_owner_failure(&state, run.id, error.to_string()).await;
        }
        Err(error) => {
            terminalize_owner_failure(
                &state,
                run.id,
                format!("analysis background task failed: {error}"),
            )
            .await;
        }
    }
}

async fn own_analysis_run(
    state: AppState,
    claim: vibe_cs_storage::AnalysisRunClaim,
) -> Result<(), DomainError> {
    let run_id = claim.run.id;
    run_analysis(&state, claim).await?;
    state.events.publish("analysis", "completed", Some(run_id));
    Ok(())
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
) -> Result<(), DomainError> {
    let run_id = claim.run.id;
    let initial = state.analysis.validate_input(claim.demo.clone()).await?;
    state
        .storage
        .bind_analysis_run_input(run_id, initial)
        .await
        .map_err(storage_domain_error)?;
    let progress: Arc<dyn AnalysisProgressReporter> = Arc::new(PersistedAnalysisProgress {
        storage: state.storage.clone(),
        run_id,
    });
    let analysis = state.analysis.analyze(claim.demo.clone(), progress).await?;
    state
        .storage
        .mark_analysis_input_revalidation_started(run_id)
        .await
        .map_err(storage_domain_error)?;
    let observed_source_fingerprint_after_parse = state.analysis.validate_input(claim.demo).await?;
    state
        .storage
        .mark_analysis_projection_started(run_id)
        .await
        .map_err(storage_domain_error)?;
    state
        .storage
        .complete_analysis_run(run_id, analysis, observed_source_fingerprint_after_parse)
        .await
        .map_err(storage_domain_error)?;
    Ok(())
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
        ) -> Result<AnalysisInputFingerprint, DomainError> {
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
        ) -> Result<MatchAnalysis, DomainError> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            progress.parser_started().await?;
            self.entered.notify_one();
            self.release.notified().await;
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

    #[derive(Debug, Default)]
    struct PanickingAnalysis;

    #[async_trait]
    impl crate::AnalysisPort for PanickingAnalysis {
        async fn validate_input(
            &self,
            demo: DemoRecord,
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
                .contains("background task failed")
        );
        assert!(storage.get_analysis(demo_id).await.unwrap().is_none());
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
