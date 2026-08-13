use serde::{Deserialize, Serialize};
use thiserror::Error;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ErrorBody {
    pub code: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

#[derive(Debug, Error)]
pub enum DomainError {
    #[error("{0} was not found")]
    NotFound(String),
    #[error("invalid input: {0}")]
    InvalidInput(String),
    #[error("operation conflicts with current state: {0}")]
    Conflict(String),
    #[error("external dependency is unavailable: {0}")]
    DependencyUnavailable(String),
    #[error("artifact cleanup failed: {0}")]
    CleanupFailed(String),
    #[error("internal operation failed: {0}")]
    Internal(String),
}

impl DomainError {
    #[must_use]
    pub fn body(&self) -> ErrorBody {
        let code = match self {
            Self::NotFound(_) => "not_found",
            Self::InvalidInput(_) => "invalid_input",
            Self::Conflict(_) => "conflict",
            Self::DependencyUnavailable(_) => "dependency_unavailable",
            Self::CleanupFailed(_) | Self::Internal(_) => "internal_error",
        };
        ErrorBody {
            code: code.to_owned(),
            message: self.to_string(),
            detail: None,
        }
    }
}
