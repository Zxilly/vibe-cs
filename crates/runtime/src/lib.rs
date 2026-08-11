//! Concrete runtime adapters and application composition.

mod analysis;
mod avatar_cache;
mod cosmetics;
mod demo_watch;
mod export;
mod integration;
mod llm_review;
mod log_retention;
mod media;
mod obs_tuning;
mod player;
mod recording;
mod replay_cache;
mod source_assets;

use std::{path::PathBuf, sync::Arc};

use tokio::sync::RwLock;
use vibe_cs_integrations::GsiState;

pub use analysis::RuntimeAnalysisPort;
pub use cosmetics::RuntimeCosmeticsPort;
pub use demo_watch::RuntimeDemoWatchPort;
pub use export::RuntimeExportPort;
pub use integration::RuntimeIntegrationPort;
pub use llm_review::RuntimeReviewPort;
pub use log_retention::prune_daily_logs;
pub use media::RuntimeMediaPort;
pub use obs_tuning::RuntimeObsTuningPort;
pub use player::RuntimePlayerPort;
pub use recording::{
    PreparedRecording, RecordingBackend, RecordingCancellation, RuntimeRecordingPort,
    SystemRecordingBackend,
};
pub use source_assets::RuntimeSourceAssetPort;

/// Composes the concrete local adapters used by desktop and standalone hosts.
pub async fn build_app_state(
    storage: vibe_cs_storage::Storage,
    data_dir: PathBuf,
    web_dist: Option<PathBuf>,
) -> vibe_cs_api::AppState {
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

    let config = storage
        .get_config()
        .await
        .ok()
        .flatten()
        .unwrap_or_default();
    let analysis = Arc::new(RuntimeAnalysisPort::new(
        storage.clone(),
        data_dir.join("worker-tasks"),
        data_dir.join("replay-cache"),
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
    let obs_tuning = Arc::new(RuntimeObsTuningPort::new(storage.clone(), data_dir.clone()));
    let recording = Arc::new(RuntimeRecordingPort::new(
        storage.clone(),
        Arc::new(SystemRecordingBackend::new(data_dir.clone(), gsi_state)),
    ));
    recording.recover_orphaned_jobs().await;

    let state = vibe_cs_api::AppState::new(storage.clone(), data_dir);
    let demo_watch = Arc::new(
        RuntimeDemoWatchPort::start(storage, state.event_hub(), config.demo_watch_paths).await,
    );
    state
        .with_analysis(analysis)
        .with_review(review)
        .with_cosmetics(cosmetics)
        .with_exports(exports)
        .with_media(media)
        .with_players(players)
        .with_source_assets(source_assets)
        .with_integrations(integrations)
        .with_obs_tuning(obs_tuning)
        .with_recording(recording)
        .with_demo_watch(demo_watch)
        .with_web_dist(web_dist)
}
