use std::path::PathBuf;

/// Failures are explicit: callers never receive synthetic analysis data.
#[derive(Debug, thiserror::Error)]
pub enum DemoError {
    #[error("demo path does not exist: {0}")]
    NotFound(PathBuf),
    #[error("demo path is not a regular file: {0}")]
    NotAFile(PathBuf),
    #[error("unsupported demo extension: {0}")]
    UnsupportedExtension(PathBuf),
    #[error("demo is too small ({actual} bytes, minimum {minimum})")]
    TooSmall { actual: u64, minimum: u64 },
    #[error("demo exceeds the configured limit ({actual} bytes, maximum {maximum})")]
    TooLarge { actual: u64, maximum: u64 },
    #[error("invalid Source 2 demo magic")]
    InvalidMagic,
    #[error("operation cancelled")]
    Cancelled,
    #[error("demo contains more than {limit} supported events")]
    EventLimitExceeded { limit: usize },
    #[error("unsafe archive entry path: {0}")]
    UnsafeArchivePath(String),
    #[error("archive contains too many entries (maximum {0})")]
    ArchiveEntryLimit(usize),
    #[error("archive's expanded size exceeds {0} bytes")]
    ArchiveSizeLimit(u64),
    #[error("archive contains too many demo files (maximum {0})")]
    ArchiveDemoLimit(usize),
    #[error("archive contains a duplicate or ambiguous entry path: {0}")]
    DuplicateArchivePath(String),
    #[error("archive entry has an unsafe file type: {0}")]
    UnsafeArchiveFileType(String),
    #[error("archive entry exceeds the maximum compression ratio: {0}")]
    ArchiveCompressionRatio(String),
    #[error("archive does not contain a demo file")]
    EmptyDemoArchive,
    #[error("required metadata is missing or invalid: {0}")]
    MetadataUnavailable(&'static str),
    #[error("{capability} is unavailable: {reason}")]
    Unavailable {
        capability: &'static str,
        reason: String,
    },
    #[error("demo parser failed: {0}")]
    Parse(String),
    #[error("demo parser panicked while handling malformed input")]
    ParserPanicked,
    #[error("background parse task failed: {0}")]
    Join(String),
    #[error("I/O error for {path}: {source}")]
    Io {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("zip error: {0}")]
    Zip(#[from] zip::result::ZipError),
    #[error("directory walk failed: {0}")]
    Walk(String),
}

pub type DemoResult<T> = Result<T, DemoError>;

pub(crate) fn io_error(path: impl Into<PathBuf>, source: std::io::Error) -> DemoError {
    DemoError::Io {
        path: path.into(),
        source,
    }
}
