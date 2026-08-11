use std::path::PathBuf;

use thiserror::Error;

use crate::LimitKind;

/// Errors returned by an injected stream rewrite backend.
#[derive(Debug, Error)]
pub enum BackendError {
    /// The demo parser or encoder rejected the stream.
    #[error("demo stream rewrite failed: {0}")]
    Stream(String),
    /// An input or output operation failed inside the backend.
    #[error("demo stream I/O failed: {0}")]
    Io(String),
    /// A bounded parser counter exceeded its configured limit.
    #[error("{kind:?} limit {limit} exceeded (observed {observed})")]
    LimitExceeded {
        /// Counter that exceeded the limit.
        kind: LimitKind,
        /// Configured maximum.
        limit: u64,
        /// First observed value beyond the maximum.
        observed: u64,
    },
}

/// Failure from request validation, stream inspection, rewrite, or publication.
#[derive(Debug, Error)]
pub enum RewriteError {
    /// A request or limit is internally inconsistent.
    #[error("invalid rewrite request: {reason}")]
    InvalidRequest {
        /// Human-readable validation detail.
        reason: String,
    },
    /// Input and output must be absolute paths.
    #[error("{role} path must be absolute: {path}")]
    PathNotAbsolute {
        /// Whether the path was the input or output.
        role: &'static str,
        /// Rejected path.
        path: PathBuf,
    },
    /// A path must end in `.dem`.
    #[error("{role} path must use the .dem extension: {path}")]
    InvalidExtension {
        /// Whether the path was the input or output.
        role: &'static str,
        /// Rejected path.
        path: PathBuf,
    },
    /// The output points to the input file.
    #[error("input and output must be different files: {path}")]
    SameInputAndOutput {
        /// Resolved colliding path.
        path: PathBuf,
    },
    /// Safe publication never overwrites an existing file.
    #[error("output already exists: {path}")]
    OutputAlreadyExists {
        /// Existing output path.
        path: PathBuf,
    },
    /// The input does not start with the Source 2 demo signature.
    #[error("input is not a PBDEMS2 demo: {path}")]
    InvalidMagic {
        /// Rejected input path.
        path: PathBuf,
    },
    /// The outer demo message envelope is truncated or malformed.
    #[error("malformed demo envelope at byte {offset}: {reason}")]
    MalformedEnvelope {
        /// Byte offset at which validation failed.
        offset: u64,
        /// Validation detail.
        reason: String,
    },
    /// A configured resource bound was exceeded.
    #[error("{kind:?} limit {limit} exceeded (observed {observed})")]
    LimitExceeded {
        /// Counter that exceeded the limit.
        kind: LimitKind,
        /// Configured maximum.
        limit: u64,
        /// First observed value beyond the maximum.
        observed: u64,
    },
    /// No recognized, existing field matched the request.
    #[error("no existing cosmetic field matched the requested stable identity and item filter")]
    NoMatchingFields,
    /// Filesystem operation failed before publication completed.
    #[error("{operation} failed for {path}: {source}")]
    Io {
        /// Operation being attempted.
        operation: &'static str,
        /// Path associated with the failure.
        path: PathBuf,
        /// Underlying I/O error.
        #[source]
        source: std::io::Error,
    },
    /// The stream backend failed.
    #[error(transparent)]
    Backend(#[from] BackendError),
}

impl RewriteError {
    pub(crate) fn invalid(reason: impl Into<String>) -> Self {
        Self::InvalidRequest {
            reason: reason.into(),
        }
    }

    pub(crate) fn io(
        operation: &'static str,
        path: impl Into<PathBuf>,
        source: std::io::Error,
    ) -> Self {
        Self::Io {
            operation,
            path: path.into(),
            source,
        }
    }
}
