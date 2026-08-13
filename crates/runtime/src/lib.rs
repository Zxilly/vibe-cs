//! Concrete runtime adapters and application composition.

mod analysis;
mod avatar_cache;
mod cosmetics;
mod demo_watch;
mod export;
mod hlae;
mod hlae_bridge_listener;
mod hlae_recording;
mod hlae_session;
mod integration;
mod llm_review;
mod log_retention;
mod media;
mod player;
mod proposal_execution;
mod recording;
mod recording_progress;
mod replay_cache;
mod source_assets;

use std::{path::PathBuf, sync::Arc};

use tokio::sync::RwLock;
use vibe_cs_integrations::GsiState;

pub use analysis::{DemoWorkerSidecar, RuntimeAnalysisPort};
pub use cosmetics::RuntimeCosmeticsPort;
pub use demo_watch::RuntimeDemoWatchPort;
pub use export::RuntimeExportPort;
pub use hlae::{
    HlaeTakeMp4EncodeError, HlaeTakeMp4EncodeEvidence, HlaeTakeMp4EncodeRequest,
    HlaeTakeStabilityError, HlaeTakeStabilityPolicy, RuntimeHlaePort, RuntimeHlaeSequenceEncoder,
    RuntimeManagedHlaeProcess, wait_for_stable_hlae_take,
};
pub use hlae_bridge_listener::{
    RuntimeHlaeBridgeConnection, RuntimeHlaeBridgeError, RuntimeHlaeBridgeListener,
};
pub use hlae_recording::HlaeRecordingBackend;
pub use hlae_session::{
    RuntimeHlaeCaptureProgram, RuntimeHlaeSessionError, RuntimeHlaeSessionEvidence,
    RuntimeHlaeSessionOrchestrator, RuntimeHlaeSessionRequest, RuntimeHlaeSessionTimeouts,
};
pub use integration::RuntimeIntegrationPort;
pub use llm_review::RuntimeReviewPort;
pub use log_retention::prune_daily_logs;
pub use media::RuntimeMediaPort;
pub use player::RuntimePlayerPort;
pub use proposal_execution::RuntimeProposalExecutionPort;
pub use recording::{
    OrphanedRecordingRecovery, PreparedRecording, RecordingBackend, RecordingCancellation,
    RuntimeRecordingPort,
};
pub use recording_progress::{RecordingProgressSink, RecordingStage};
pub use source_assets::RuntimeSourceAssetPort;

/// Composes the concrete local adapters used by the desktop host.
///
/// # Errors
///
/// Returns a storage error when durable analysis recovery cannot be completed.
pub async fn build_app_state(
    storage: vibe_cs_storage::Storage,
    data_dir: PathBuf,
) -> vibe_cs_storage::Result<vibe_cs_application::AppState> {
    build_app_state_with_demo_worker(storage, data_dir, None).await
}

/// Composes the desktop runtime with an optional integrity-pinned analysis worker.
///
/// # Errors
///
/// Returns a storage error when durable analysis recovery cannot be completed. The host must not
/// accept requests while a persisted active attempt has no recovered owner.
pub async fn build_app_state_with_demo_worker(
    storage: vibe_cs_storage::Storage,
    data_dir: PathBuf,
    demo_worker: Option<DemoWorkerSidecar>,
) -> vibe_cs_storage::Result<vibe_cs_application::AppState> {
    if let Err(error) = tokio::fs::create_dir_all(&data_dir).await {
        tracing::error!(%error, path = %data_dir.display(), "unable to create runtime data directory");
    }
    match storage.get_config().await {
        Ok(None) => {
            let config = vibe_cs_domain::AppConfig {
                data_dir: data_dir.to_string_lossy().into_owned(),
                ..vibe_cs_domain::AppConfig::default()
            };
            if let Err(error) = storage.put_config(config).await {
                tracing::error!(%error, "unable to initialize application configuration");
            }
        }
        Ok(Some(_)) => {}
        Err(error) => tracing::error!(%error, "unable to load application configuration"),
    }
    match storage.recover_orphaned_analysis_runs().await? {
        0 => {}
        recovered => tracing::warn!(
            recovered,
            "recovered interrupted analysis runs with durable terminal events"
        ),
    }
    match storage.recover_orphaned_demo_processing().await? {
        0 => {}
        recovered => tracing::warn!(
            recovered,
            "recovered demo processing without a durable owner"
        ),
    }
    let config = storage
        .get_config()
        .await
        .ok()
        .flatten()
        .unwrap_or_default();
    let analysis = Arc::new(RuntimeAnalysisPort::new_with_worker(
        storage.clone(),
        data_dir.join("worker-tasks"),
        data_dir.join("replay-cache"),
        demo_worker,
    ));
    let review = Arc::new(RuntimeReviewPort::new(storage.clone()));
    let cosmetics = Arc::new(RuntimeCosmeticsPort::new(storage.clone(), data_dir.clone()));
    let exports = Arc::new(RuntimeExportPort::new(storage.clone(), data_dir.clone()));
    exports.recover_orphaned_jobs().await;
    let media = Arc::new(RuntimeMediaPort::new(storage.clone()));
    let players = Arc::new(RuntimePlayerPort::new(
        storage.clone(),
        data_dir.join("avatar-cache"),
    ));
    let source_assets = Arc::new(RuntimeSourceAssetPort::new(storage.clone()));
    let gsi_state = Arc::new(RwLock::new(GsiState::default()));
    let integrations = Arc::new(RuntimeIntegrationPort::new_with_state(
        storage.clone(),
        data_dir.clone(),
        Arc::clone(&gsi_state),
    ));
    integrations.recover_orphaned_downloads().await;
    let recording = Arc::new(RuntimeRecordingPort::new(
        storage.clone(),
        Arc::new(HlaeRecordingBackend::new(data_dir.clone())),
    ));
    recording.recover_orphaned_jobs().await;
    let proposal_execution: Arc<dyn vibe_cs_application::ProposalExecutionPort> =
        match RuntimeProposalExecutionPort::new(&data_dir) {
            Ok(port) => Arc::new(port),
            Err(error) => {
                tracing::error!(%error, "unable to initialize proposal confirmation adapter");
                Arc::new(vibe_cs_application::DisabledProposalExecutionPort)
            }
        };

    let state = vibe_cs_application::AppState::new(storage.clone(), data_dir);
    let demo_watch = Arc::new(
        RuntimeDemoWatchPort::start(storage, state.event_hub(), config.demo_watch_paths).await,
    );
    Ok(state
        .with_analysis(analysis)
        .with_review(review)
        .with_cosmetics(cosmetics)
        .with_exports(exports)
        .with_media(media)
        .with_players(players)
        .with_source_assets(source_assets)
        .with_integrations(integrations)
        .with_recording(recording)
        .with_proposal_execution(proposal_execution)
        .with_demo_watch(demo_watch))
}

#[cfg(test)]
mod tests {
    use chrono::Utc;
    use uuid::Uuid;
    use vibe_cs_domain::{DemoRecord, DemoStatus};

    use super::*;

    #[tokio::test]
    async fn startup_fails_closed_when_durable_analysis_recovery_cannot_be_read() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let database_path = directory.path().join("runtime.sqlite");
        let storage = vibe_cs_storage::Storage::open(&database_path)
            .await
            .expect("storage");
        let now = Utc::now();
        let demo_id = Uuid::new_v4();
        storage
            .put_demo(DemoRecord {
                id: demo_id,
                path: directory
                    .path()
                    .join("current.dem")
                    .to_string_lossy()
                    .into_owned(),
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
            })
            .await
            .expect("demo");
        let run_id = storage
            .start_analysis_run(demo_id)
            .await
            .expect("analysis run")
            .run
            .id;
        rusqlite::Connection::open(&database_path)
            .expect("inspection connection")
            .execute(
                "UPDATE analysis_runs SET document_json = '{' WHERE id = ?1",
                [run_id.to_string()],
            )
            .expect("corrupt active run fixture");

        let result = build_app_state(storage, directory.path().join("data")).await;
        assert!(
            matches!(result, Err(vibe_cs_storage::StorageError::Serialization(_))),
            "startup must not serve an active run whose recovery failed"
        );
    }
}
