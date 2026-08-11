use std::path::PathBuf;

#[derive(Debug, thiserror::Error)]
pub enum IntegrationError {
    #[error("{integration} is not configured: {message}")]
    NotConfigured {
        integration: &'static str,
        message: String,
    },
    #[error("invalid configuration: {0}")]
    InvalidConfiguration(String),
    #[error("invalid input: {0}")]
    InvalidInput(String),
    #[error("{integration} is unavailable: {message}")]
    Unavailable {
        integration: &'static str,
        message: String,
    },
    #[error("protocol error: {0}")]
    Protocol(String),
    #[error("remote service returned HTTP {status}: {message}")]
    HttpStatus { status: u16, message: String },
    #[error("response exceeded the configured limit of {0} bytes")]
    ResponseLimit(usize),
    #[error("operation was cancelled")]
    Cancelled,
    #[error("I/O error for {path}: {source}")]
    Io {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("HTTP error: {0}")]
    Http(#[from] reqwest::Error),
    #[error("URL error: {0}")]
    Url(#[from] url::ParseError),
    #[error("JSON error: {0}")]
    Json(#[from] serde_json::Error),
}

pub type IntegrationResult<T> = Result<T, IntegrationError>;
