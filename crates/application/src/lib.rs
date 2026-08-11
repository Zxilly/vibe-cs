//! In-process application command dispatcher used by the Tauri desktop host.

mod error;
mod extract;
mod player;
mod ports;
mod routes;
mod state;

pub(crate) use extract::{ApiJson, ApiMultipart, ApiQuery};

use axum::Router;

pub use error::{ApiError, ApiResult};
pub use player::*;
pub use ports::{
    AnalysisPort, CosmeticCatalogDto, CosmeticCatalogItemDto, CosmeticImageOutput,
    CosmeticPaintKitDto, CosmeticRewriteOutput, CosmeticsPort, DemoWatchPort, DemoWatchRootStatus,
    DemoWatchStatus, DisabledAnalysisPort, DisabledCosmeticsPort, DisabledDemoWatchPort,
    DisabledExportPort, DisabledIntegrationPort, DisabledMediaPort, DisabledObsTuningPort,
    DisabledRecordingPort, DisabledReviewPort, DisabledSourceAssetPort, ExportPort,
    IntegrationPort, LlmReviewRequest, LlmReviewResult, MediaPort, MediaProxyRequest,
    ObsTuningPort, ObsVideoApplyRequest, ObsVideoApplyResult, ObsVideoBackup,
    ObsVideoBackupDeleteResult, ObsVideoBackupReason, ObsVideoField, ObsVideoFieldDiff,
    ObsVideoRestoreRequest, ObsVideoRestoreResult, ObsVideoSettingsSnapshot, ObsVideoTuningPlan,
    ProbedMediaMetadata, RadarImageData, RadarOverviewData, RadarTransformData, RecordingPort,
    ReplayCacheCleanup, ReplayCacheMetadata, ReplayCacheState, ReplayCacheStatus, ReplayPayload,
    ReviewPort, ReviewScope, ReviewTone, SourceAssetPort,
};
pub use state::{AppState, ChangedEvent, EventHub};

/// Builds the private command dispatcher hosted inside the desktop process.
pub fn build_dispatcher(state: AppState) -> Router {
    routes::router()
        .fallback(routes::not_found)
        .with_state(state)
}

/// Builds the loopback-only receiver required by the CS2 GSI protocol.
///
/// This router intentionally exposes only the authenticated GSI ingestion route. Product and UI
/// commands remain available exclusively through Tauri IPC.
pub fn build_gsi_receiver(state: AppState) -> Router {
    routes::gsi_router()
        .fallback(routes::not_found)
        .with_state(state)
}
