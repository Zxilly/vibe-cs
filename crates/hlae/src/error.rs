use std::path::PathBuf;

use thiserror::Error;

/// Failures raised before any HLAE artifact is emitted.
#[derive(Debug, Clone, Error, PartialEq, Eq)]
pub enum HlaeError {
    #[error("HLAE is only supported on Windows")]
    UnsupportedPlatform,
    #[error("invalid HLAE installation: {0}")]
    InvalidInstallation(String),
    #[error("invalid HLAE plan: {0}")]
    InvalidPlan(String),
    #[error("unsafe path rejected for {field}: {reason}")]
    UnsafePath {
        field: &'static str,
        reason: &'static str,
    },
    #[error("HLAE artifact bundle already exists: {0}")]
    ArtifactBundleExists(PathBuf),
    #[error("HLAE artifact bundle cannot be resumed at {path}: {reason}")]
    ArtifactBundleConflict { path: PathBuf, reason: String },
    #[error("unable to {operation}: {message}")]
    ArtifactIo {
        operation: &'static str,
        message: String,
    },
}
