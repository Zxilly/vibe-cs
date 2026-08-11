use std::path::PathBuf;

#[derive(Debug, thiserror::Error)]
pub enum PlatformError {
    #[error("Windows platform capability is unsupported on this operating system")]
    Unsupported,
    #[error("invalid input: {0}")]
    InvalidInput(String),
    #[error("required process was not found: {0}")]
    ProcessNotFound(String),
    #[error("foreground window belongs to process {actual}, expected {expected}")]
    ForegroundMismatch { expected: u32, actual: u32 },
    #[error("operation was cancelled after process {process_id:?} was started")]
    Cancelled { process_id: Option<u32> },
    #[error("managed recovery is already pending")]
    RecoveryPending,
    #[error("managed recovery is not pending")]
    RecoveryNotPending,
    #[error("backup integrity validation failed for {path}: {reason}")]
    BackupIntegrity { path: PathBuf, reason: String },
    #[error("recovery cannot safely modify {path}: {reason}")]
    RecoveryConflict { path: PathBuf, reason: String },
    #[error("Win32 operation failed: {0}")]
    Windows(String),
    #[error("I/O error while {operation} {path}: {source}")]
    Io {
        operation: &'static str,
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("JSON error: {0}")]
    Json(#[from] serde_json::Error),
    #[error("URL error: {0}")]
    Url(#[from] url::ParseError),
}

pub type PlatformResult<T> = Result<T, PlatformError>;

pub(crate) fn io_error(
    operation: &'static str,
    path: impl Into<PathBuf>,
    source: std::io::Error,
) -> PlatformError {
    PlatformError::Io {
        operation,
        path: path.into(),
        source,
    }
}
