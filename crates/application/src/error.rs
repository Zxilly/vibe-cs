use axum::{Json, http::StatusCode, response::IntoResponse};
use thiserror::Error;
use vibe_cs_domain::{DomainError, ErrorBody};

#[derive(Debug, Error)]
#[error("{body}", body = .body.message)]
pub struct ApiError {
    status: StatusCode,
    body: ErrorBody,
}

pub type ApiResult<T> = Result<T, ApiError>;

impl ApiError {
    pub fn new(status: StatusCode, code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            status,
            body: ErrorBody {
                code: code.into(),
                message: message.into(),
                detail: None,
            },
        }
    }

    pub fn invalid(message: impl Into<String>) -> Self {
        Self::new(StatusCode::BAD_REQUEST, "invalid_input", message)
    }

    pub fn not_found(resource: impl Into<String>) -> Self {
        Self::new(
            StatusCode::NOT_FOUND,
            "not_found",
            format!("{} was not found", resource.into()),
        )
    }

    pub fn dependency(name: impl Into<String>) -> Self {
        Self::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "dependency_unavailable",
            format!("{} is not configured or available", name.into()),
        )
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> axum::response::Response {
        (self.status, Json(self.body)).into_response()
    }
}

impl From<vibe_cs_storage::StorageError> for ApiError {
    fn from(error: vibe_cs_storage::StorageError) -> Self {
        tracing::error!(%error, "storage operation failed");
        Self::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            "storage_error",
            "The local database operation failed",
        )
    }
}

impl From<std::io::Error> for ApiError {
    fn from(error: std::io::Error) -> Self {
        tracing::error!(%error, "filesystem operation failed");
        Self::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            "filesystem_error",
            "The local filesystem operation failed",
        )
    }
}

impl From<DomainError> for ApiError {
    fn from(error: DomainError) -> Self {
        let status = match error {
            DomainError::NotFound(_) => StatusCode::NOT_FOUND,
            DomainError::InvalidInput(_) => StatusCode::BAD_REQUEST,
            DomainError::Conflict(_) => StatusCode::CONFLICT,
            DomainError::DependencyUnavailable(_) => StatusCode::SERVICE_UNAVAILABLE,
            DomainError::CleanupFailed(_) | DomainError::Internal(_) => {
                StatusCode::INTERNAL_SERVER_ERROR
            }
        };
        Self {
            status,
            body: error.body(),
        }
    }
}
