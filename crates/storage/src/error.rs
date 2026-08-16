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
    #[error("evidence search projection is invalid: {0}")]
    EvidenceProjection(String),
    #[error("activity projection is invalid: {0}")]
    ActivityProjection(String),
    #[error("player match projection is invalid: {0}")]
    PlayerProjection(String),
    #[error("local lineup projection is invalid: {0}")]
    LineupProjection(String),
    #[error(
        "database does not match the current unreleased product schema; start with a fresh data directory"
    )]
    CurrentSchemaRequired,
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
    #[error("recording retry for {0} was already claimed by another durable job")]
    RecordingRetryAlreadyClaimed(Uuid),
    #[error("recording job {0} retry lineage is immutable")]
    RecordingRetryLineageImmutable(Uuid),
    #[error("editor preset {0} revision cannot be incremented")]
    EditorPresetRevisionOverflow(Uuid),
    #[error("agent plan {0} revision cannot be incremented")]
    AgentPlanRevisionOverflow(Uuid),
    #[error("integer {0} cannot be represented by SQLite")]
    IntegerOutOfRange(u64),
    #[error("LLM API key could not be protected for secure persistence")]
    SecretProtection,
    #[error("LLM API key could not be recovered from secure persistence")]
    SecretRecovery,
    #[error(
        "persistent LLM API keys are unsupported on this operating system; use a process environment credential"
    )]
    SecretPersistenceUnsupported,
}

impl StorageError {
    /// Whether retrying the same authoritative operation may succeed without a data repair.
    #[must_use]
    pub fn is_transient(&self) -> bool {
        match self {
            Self::Database(rusqlite::Error::SqliteFailure(error, _)) => matches!(
                error.code,
                rusqlite::ErrorCode::DatabaseBusy
                    | rusqlite::ErrorCode::DatabaseLocked
                    | rusqlite::ErrorCode::OperationInterrupted
                    | rusqlite::ErrorCode::SystemIoFailure
                    | rusqlite::ErrorCode::CannotOpen
                    | rusqlite::ErrorCode::FileLockingProtocolFailed
            ),
            Self::Database(_)
            | Self::Worker(_)
            | Self::LockPoisoned
            | Self::Serialization(_)
            | Self::Domain(_)
            | Self::ManagedFile(_)
            | Self::EvidenceProjection(_)
            | Self::ActivityProjection(_)
            | Self::PlayerProjection(_)
            | Self::LineupProjection(_)
            | Self::CurrentSchemaRequired
            | Self::EditorProjectRevisionOverflow(_)
            | Self::EditorProjectAlreadyExists(_)
            | Self::MediaAssetAlreadyExists(_)
            | Self::RecordingRetryAlreadyClaimed(_)
            | Self::RecordingRetryLineageImmutable(_)
            | Self::EditorPresetRevisionOverflow(_)
            | Self::AgentPlanRevisionOverflow(_)
            | Self::IntegerOutOfRange(_)
            | Self::SecretProtection
            | Self::SecretRecovery
            | Self::SecretPersistenceUnsupported => false,
        }
    }

    /// How this failure should be classified on a job row.
    ///
    /// Coarse on purpose. The only distinctions worth making here are the ones
    /// that change what the user is offered: a full disk is not retryable and
    /// says so, a busy database is, and everything else is a defect in this
    /// program that no button on the activity page can fix.
    #[must_use]
    pub fn failure_code(&self) -> vibe_cs_domain::JobFailureCode {
        use vibe_cs_domain::JobFailureCode;
        match self {
            Self::Domain(error) => JobFailureCode::from(error),
            Self::Database(rusqlite::Error::SqliteFailure(error, _))
                if error.code == rusqlite::ErrorCode::DiskFull =>
            {
                JobFailureCode::DiskFull
            }
            _ if self.is_transient() => JobFailureCode::Timeout,
            _ => JobFailureCode::Unknown,
        }
    }
}

pub type Result<T> = std::result::Result<T, StorageError>;

#[cfg(test)]
mod tests {
    use rusqlite::{Error, ErrorCode, ffi};

    use super::StorageError;

    #[test]
    fn retry_classification_excludes_corruption_constraints_and_serialization() {
        let sqlite = |code| {
            StorageError::Database(Error::SqliteFailure(
                ffi::Error {
                    code,
                    extended_code: 0,
                },
                None,
            ))
        };

        assert!(sqlite(ErrorCode::DatabaseBusy).is_transient());
        assert!(sqlite(ErrorCode::DatabaseLocked).is_transient());
        assert!(sqlite(ErrorCode::SystemIoFailure).is_transient());
        assert!(!sqlite(ErrorCode::ConstraintViolation).is_transient());
        assert!(!sqlite(ErrorCode::DatabaseCorrupt).is_transient());
        assert!(!sqlite(ErrorCode::NotADatabase).is_transient());
        assert!(!sqlite(ErrorCode::SchemaChanged).is_transient());
        assert!(!StorageError::LockPoisoned.is_transient());
        assert!(!StorageError::Database(Error::InvalidQuery).is_transient());
        assert!(
            !StorageError::Serialization(
                serde_json::from_str::<serde_json::Value>("{").unwrap_err()
            )
            .is_transient()
        );
    }

    #[test]
    fn failure_classification_separates_a_full_disk_from_a_busy_one() {
        use vibe_cs_domain::JobFailureCode;

        let sqlite = |code| {
            StorageError::Database(Error::SqliteFailure(
                ffi::Error {
                    code,
                    extended_code: 0,
                },
                None,
            ))
        };

        // The distinction that matters on the activity row: a full disk is not
        // retryable and tells the user to free space, a busy database is.
        assert_eq!(
            sqlite(ErrorCode::DiskFull).failure_code(),
            JobFailureCode::DiskFull
        );
        assert!(!JobFailureCode::DiskFull.retryable());
        assert_eq!(
            sqlite(ErrorCode::DatabaseBusy).failure_code(),
            JobFailureCode::Timeout
        );
        assert!(JobFailureCode::Timeout.retryable());

        // A domain error keeps its own classification rather than being
        // flattened into "something went wrong in storage".
        assert_eq!(
            StorageError::Domain(vibe_cs_domain::DomainError::NotFound("demo".to_owned()))
                .failure_code(),
            JobFailureCode::InputMissing
        );

        // Corruption is a defect no button on the page can fix.
        assert_eq!(
            sqlite(ErrorCode::DatabaseCorrupt).failure_code(),
            JobFailureCode::Unknown
        );
    }
}
