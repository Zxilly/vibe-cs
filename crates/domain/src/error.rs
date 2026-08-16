use serde::{Deserialize, Serialize};
use thiserror::Error;
use ts_rs::TS;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, TS)]
#[ts(export)]
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

/// Why a background job ended in failure, as a closed set the UI can act on.
///
/// §10 gap: 「11 输出与任务记录」 draws 「失败 · 磁盘空间不足」 and, under it,
/// 「释放 4.2 GB 后可重试」. A free-text `error` cannot drive either — it cannot
/// be translated, and it cannot tell the page whether to offer 重试 or 定位文件.
///
/// The set is deliberately small and every member is a *distinct recovery*.
/// `DiskFull` and `PermissionDenied` are both "the write failed", and they are
/// separate because one is fixed by deleting files and the other is not. What
/// is *not* here is a member per subsystem: an `FFmpeg` failure and an HLAE
/// failure are both `DependencyFailed` as far as the user's next action goes.
///
/// `Unknown` is a real answer, not a fallback to be ashamed of: it means the
/// failure was not one this classification recognises, and the page still has
/// `error` to print. Guessing a code from message text would be worse than
/// saying so.
#[derive(
    Debug, Clone, Copy, PartialEq, Eq, Hash, serde::Serialize, serde::Deserialize, ts_rs::TS,
)]
#[serde(rename_all = "snake_case")]
#[ts(export)]
pub enum JobFailureCode {
    /// The user asked for it to stop.
    Cancelled,
    /// The service restarted while the job was running.
    Interrupted,
    /// The volume ran out of room.
    DiskFull,
    /// An input the job needed is no longer where it was.
    InputMissing,
    /// The process could not read or write where it was told to.
    PermissionDenied,
    /// A required executable or runtime is not installed.
    DependencyMissing,
    /// A dependency ran and failed.
    DependencyFailed,
    /// The request itself was not valid.
    InvalidInput,
    /// The job outlived its time limit.
    Timeout,
    /// Not one of the above. `error` still carries what the service said.
    Unknown,
}

impl JobFailureCode {
    /// Whether running the same job again could plausibly succeed *without the
    /// user doing anything first*.
    ///
    /// `DiskFull` is deliberately not retryable: the retry would fail the same
    /// way, and offering it would be the interface saying "try again" when it
    /// knows the answer. The artboard's own sentence is 「释放 4.2 GB 后可重试」
    /// — an instruction, then a retry.
    #[must_use]
    pub const fn retryable(self) -> bool {
        match self {
            Self::Cancelled | Self::Interrupted | Self::DependencyFailed | Self::Timeout => true,
            Self::DiskFull
            | Self::InputMissing
            | Self::PermissionDenied
            | Self::DependencyMissing
            | Self::InvalidInput
            | Self::Unknown => false,
        }
    }

    /// The code for an `std::io::Error`, which is where most of the
    /// distinguishable failures actually come from.
    #[must_use]
    pub fn from_io(kind: std::io::ErrorKind) -> Self {
        match kind {
            std::io::ErrorKind::StorageFull | std::io::ErrorKind::QuotaExceeded => Self::DiskFull,
            std::io::ErrorKind::NotFound => Self::InputMissing,
            std::io::ErrorKind::PermissionDenied => Self::PermissionDenied,
            std::io::ErrorKind::TimedOut => Self::Timeout,
            _ => Self::Unknown,
        }
    }
}

impl From<&DomainError> for JobFailureCode {
    fn from(error: &DomainError) -> Self {
        match error {
            DomainError::NotFound(_) => Self::InputMissing,
            DomainError::InvalidInput(_) => Self::InvalidInput,
            DomainError::DependencyUnavailable(_) => Self::DependencyMissing,
            // A conflict, a failed cleanup and an internal error all mean the
            // same thing to the person looking at the row: it broke, and the
            // message is the only thing that says how.
            DomainError::Conflict(_) | DomainError::CleanupFailed(_) | DomainError::Internal(_) => {
                Self::Unknown
            }
        }
    }
}
