//! `SQLite` persistence with serialized access and one current schema.

mod error;
mod repository;
mod schema;

pub use error::{Result, StorageError};
pub use repository::{
    ActivityKind, ActivityPage, ActivityQuery, ActivitySource, ActivityState, ActivitySummary,
    AnalysisReplaySource, AnalysisRunClaim, ContentAddressedDemoPut, DemoCatalogIdentity,
    DemoContentIdentity, DemoContentRecovery, EvidenceAnnotationCreate, ExportJobRecord,
    LineupDirectoryItem, LineupDirectoryPage, LineupDirectoryQuery, LineupMapItem, LineupMapPage,
    LineupProjectionCoverage, MatchDownloadClaim, MediaAssetUpdate, MediaProxyCleanupPlan,
    PlayerAggregateStats, PlayerComparisonProjection, PlayerDirectoryPage, PlayerDirectoryQuery,
    PlayerDirectorySort, PlayerHeatmapKind, PlayerHeatmapProjection, PlayerHeatmapQuery,
    PlayerMapPage, PlayerMapQuery, PlayerMatchPage, PlayerMatchQuery, PlayerProfile,
    PlayerProjectionCoverage, PlayerSortDirection, ProjectLeaseAcquire, ProjectedPlayer,
    ProjectedPlayerHeatPoint, ProjectedPlayerMap, ProjectedPlayerMatch, Storage,
};
