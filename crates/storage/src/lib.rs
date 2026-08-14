//! `SQLite` persistence with serialized access and one current schema.

mod error;
mod repository;
mod schema;

pub use error::{Result, StorageError};
pub use repository::{
    ActivityKind, ActivityPage, ActivityQuery, ActivitySource, ActivityState, ActivitySummary,
    AnalysisReplaySource, AnalysisRunClaim, BeatAlignmentUpdate, ContentAddressedDemoPut,
    DemoCatalogIdentity, DemoContentIdentity, DemoContentRecovery, EDITOR_PROJECT_SNAPSHOT_LIMIT,
    EditorAudioSeparationResult, EditorAudioSeparationUpdate, EditorProjectDeletion,
    EditorProjectDeletionResult, EditorProjectRevision, EditorProjectUpdate,
    EvidenceAnnotationCreate, ExportJobRecord, HighlightEditUpdate, LineupDirectoryItem,
    LineupDirectoryPage, LineupDirectoryQuery, LineupMapItem, LineupMapPage,
    LineupProjectionCoverage, ManagedFileQuarantine, ManagedFileQuarantineEntry,
    ManagedFileStaging, MatchDownloadClaim, MediaAssetUpdate, MediaProxyCleanupPlan,
    PlayerAggregateStats, PlayerComparisonProjection, PlayerDirectoryPage, PlayerDirectoryQuery,
    PlayerDirectorySort, PlayerHeatmapKind, PlayerHeatmapProjection, PlayerHeatmapQuery,
    PlayerMapPage, PlayerMapQuery, PlayerMatchPage, PlayerMatchQuery, PlayerProfile,
    PlayerProjectionCoverage, PlayerSortDirection, PresetApply, PresetDelete, PresetRecord,
    PresetUpdate, ProjectedPlayer, ProjectedPlayerHeatPoint, ProjectedPlayerMap,
    ProjectedPlayerMatch, Storage,
};
