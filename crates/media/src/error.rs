use std::path::PathBuf;

#[derive(Debug, thiserror::Error)]
pub enum MediaError {
    #[error("required executable was not found: {0}")]
    ExecutableNotFound(String),
    #[error("invalid media input: {0}")]
    InvalidInput(String),
    #[error("process was cancelled")]
    Cancelled,
    #[error("process output exceeded {limit} bytes")]
    OutputLimit { limit: usize },
    #[error("process failed with status {status}: {message}")]
    ProcessFailed { status: i32, message: String },
    #[error("unable to decode tool output: {0}")]
    InvalidToolOutput(String),
    #[error("native FFmpeg operation failed: {0}")]
    NativeFfmpeg(String),
    #[error("unsupported WAV encoding: {0}")]
    UnsupportedWave(String),
    #[error("temporary output is missing or empty: {0}")]
    EmptyOutput(PathBuf),
    #[error("refusing to replace an existing output: {0}")]
    OutputExists(PathBuf),
    #[error("I/O error for {path}: {source}")]
    Io {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("JSON error: {0}")]
    Json(#[from] serde_json::Error),
}

pub type MediaResult<T> = Result<T, MediaError>;

pub(crate) fn io_error(path: impl Into<PathBuf>, source: std::io::Error) -> MediaError {
    MediaError::Io {
        path: path.into(),
        source,
    }
}
