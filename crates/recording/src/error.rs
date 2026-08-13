use std::path::PathBuf;

#[derive(Debug, thiserror::Error)]
pub enum RecordingError {
    #[error("invalid recording input: {0}")]
    InvalidInput(String),
    #[error("recording preflight failed: {0}")]
    Preflight(String),
    #[error("recording was cancelled during {stage}")]
    Cancelled { stage: &'static str },
    #[error("timed out while waiting for {stage}")]
    Timeout { stage: &'static str },
    #[error("the capture backend is already active")]
    CaptureBusy,
    #[error("configuration recovery is pending and must be resolved before recording")]
    RecoveryPending,
    #[error("expected observer {expected}, but playback reported {actual}")]
    ObserverMismatch { expected: String, actual: String },
    #[error("the capture backend did not return an output artifact")]
    OutputMissing,
    #[error("recording output {path} is invalid: {reason}")]
    OutputInvalid { path: PathBuf, reason: String },
    #[error("recording operation failed: {primary}; cleanup also failed: {cleanup}")]
    Cleanup { primary: Box<Self>, cleanup: String },
    #[error("recording session cleanup failed: {0}")]
    CleanupFailed(String),
    #[error("platform error: {0}")]
    Platform(#[from] vibe_cs_platform_windows::PlatformError),
    #[error("integration error: {0}")]
    Integration(#[from] vibe_cs_integrations::IntegrationError),
    #[error("domain error: {0}")]
    Domain(#[from] vibe_cs_domain::DomainError),
    #[error("I/O error while {operation} {path}: {source}")]
    Io {
        operation: &'static str,
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("blocking recording task failed: {0}")]
    Task(String),
}

pub type RecordingResult<T> = Result<T, RecordingError>;

impl RecordingError {
    /// Creates the backend-neutral busy error.
    #[must_use]
    pub const fn capture_busy() -> Self {
        Self::CaptureBusy
    }

    /// Reports whether capture could not start because the backend was active.
    #[must_use]
    pub const fn is_capture_busy(&self) -> bool {
        matches!(self, Self::CaptureBusy)
    }
}

pub(crate) fn io_error(
    operation: &'static str,
    path: impl Into<PathBuf>,
    source: std::io::Error,
) -> RecordingError {
    RecordingError::Io {
        operation,
        path: path.into(),
        source,
    }
}
