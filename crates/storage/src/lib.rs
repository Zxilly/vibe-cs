//! `SQLite` persistence with serialized access and one current schema.

mod error;
mod repository;
mod schema;

pub use error::{Result, StorageError};
pub use repository::{
    BeatAlignmentUpdate, EDITOR_PROJECT_SNAPSHOT_LIMIT, EditorAudioSeparationResult,
    EditorAudioSeparationUpdate, EditorProjectDeletion, EditorProjectDeletionResult,
    EditorProjectRevision, EditorProjectUpdate, ExportJobRecord, HighlightEditUpdate,
    ManagedFileQuarantine, ManagedFileQuarantineEntry, ManagedFileStaging, MediaAssetUpdate,
    MediaProxyCleanupPlan, PresetApply, PresetDelete, PresetRecord, PresetUpdate, Storage,
};
