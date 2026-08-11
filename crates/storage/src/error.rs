use thiserror::Error;
use uuid::Uuid;

#[derive(Debug, Error)]
pub enum StorageError {
    #[error("database operation failed: {0}")]
    Database(#[from] rusqlite::Error),
    #[error("stored document is invalid: {0}")]
    Serialization(#[from] serde_json::Error),
    #[error("stored editor data is invalid: {0}")]
    Domain(#[from] vibe_cs_domain::DomainError),
    #[error("managed file transaction failed: {0}")]
    ManagedFile(String),
    #[error("database worker failed: {0}")]
    Worker(#[from] tokio::task::JoinError),
    #[error("database lock was poisoned")]
    LockPoisoned,
    #[error("editor project {0} revision cannot be incremented")]
    EditorProjectRevisionOverflow(Uuid),
    #[error("editor project {0} already exists")]
    EditorProjectAlreadyExists(Uuid),
    #[error("media asset {0} already exists")]
    MediaAssetAlreadyExists(Uuid),
    #[error("editor preset {0} revision cannot be incremented")]
    EditorPresetRevisionOverflow(Uuid),
    #[error("integer {0} cannot be represented by SQLite")]
    IntegerOutOfRange(u64),
}

pub type Result<T> = std::result::Result<T, StorageError>;
