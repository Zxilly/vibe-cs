use std::{io, path::PathBuf};

use thiserror::Error;

#[derive(Debug, Error)]
pub enum SourceAssetError {
    #[error("I/O operation failed for {path}: {source}")]
    Io {
        path: PathBuf,
        #[source]
        source: io::Error,
    },
    #[error("{path} is not a VPK version 2 directory archive")]
    InvalidVpkSignature { path: PathBuf },
    #[error("unsupported VPK version {version} in {path}")]
    UnsupportedVpkVersion { path: PathBuf, version: u32 },
    #[error("declared VPK sections require {declared} bytes but {path} contains {actual}")]
    InvalidVpkLength {
        path: PathBuf,
        declared: u64,
        actual: u64,
    },
    #[error("{kind} size {actual} exceeds the configured limit {limit}")]
    LimitExceeded {
        kind: &'static str,
        actual: u64,
        limit: u64,
    },
    #[error("invalid VPK directory tree at byte {offset}: {message}")]
    InvalidDirectoryTree { offset: usize, message: String },
    #[error("unsafe VPK path {path:?}: {reason}")]
    UnsafeVirtualPath { path: String, reason: &'static str },
    #[error("duplicate VPK entry {0:?}")]
    DuplicateEntry(String),
    #[error("VPK archive index {index} exceeds the configured limit {limit}")]
    ArchiveIndexLimit { index: u16, limit: u16 },
    #[error("entry {path:?} points outside its declared data section")]
    EntryOutOfBounds { path: String },
    #[error("entry {0:?} was not found")]
    EntryNotFound(String),
    #[error("archive chunk for entry {entry:?} escapes the VPK directory")]
    ArchiveOutsideDirectory { entry: String },
    #[error("resource path {0} escapes the CS2 content directory")]
    ResourceOutsideContent(PathBuf),
    #[error("CRC32 mismatch for {path:?}: expected {expected:08x}, calculated {actual:08x}")]
    CrcMismatch {
        path: String,
        expected: u32,
        actual: u32,
    },
    #[error("no CS2 content directory was found below {0}")]
    Cs2ContentNotFound(PathBuf),
    #[error("invalid map name {0:?}")]
    InvalidMapName(String),
    #[error("no radar overview resources were found for map {0:?}")]
    RadarOverviewNotFound(String),
    #[error("radar overview text is invalid at offset {offset}: {message}")]
    InvalidOverviewText { offset: usize, message: String },
    #[error("radar overview is missing required field {0}")]
    MissingOverviewField(&'static str),
    #[error("radar overview field {field} has invalid value {value:?}")]
    InvalidOverviewField { field: &'static str, value: String },
    #[error("radar overview text was not extracted for map {0:?}")]
    OverviewTextNotFound(String),
    #[error("compiled texture is invalid at offset {offset}: {message}")]
    InvalidCompiledTexture { offset: usize, message: String },
    #[error("compiled texture format {0} is not supported for radar images")]
    UnsupportedCompiledTextureFormat(u8),
    #[error("compiled texture decompression failed: {0}")]
    TextureDecompression(String),
    #[error("PNG encoding failed: {0}")]
    PngEncoding(String),
    #[error("cosmetic catalog is invalid at offset {offset}: {message}")]
    InvalidCosmeticCatalog { offset: usize, message: String },
    #[error("cosmetic image path {0:?} is outside the allowed inventory namespaces")]
    InvalidCosmeticImagePath(String),
    #[error("integer overflow while computing {0}")]
    ArithmeticOverflow(&'static str),
}

impl SourceAssetError {
    pub(crate) fn io(path: impl Into<PathBuf>, source: io::Error) -> Self {
        Self::Io {
            path: path.into(),
            source,
        }
    }
}

pub type Result<T> = std::result::Result<T, SourceAssetError>;
