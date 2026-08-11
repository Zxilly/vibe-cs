//! `SQLite` persistence with serialized access and versioned migrations.

mod error;
mod legacy;
mod migrations;
mod repository;

pub use error::{Result, StorageError};
pub use legacy::{PreviousDataImport, PreviousDataImportError, import_previous_data_directory};
pub use repository::{
    EDITOR_PROJECT_SNAPSHOT_LIMIT, EditorAudioSeparationResult, EditorAudioSeparationUpdate,
    EditorProjectDeletion, EditorProjectDeletionResult, EditorProjectRevision, EditorProjectUpdate,
    ExportJobRecord, ManagedFileQuarantine, ManagedFileQuarantineEntry, ManagedFileStaging,
    MediaAssetUpdate, MediaProxyCleanupPlan, PresetApply, PresetDelete, PresetRecord, PresetUpdate,
    Storage,
};
