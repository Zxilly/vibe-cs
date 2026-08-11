use std::fmt::Debug;
use std::io::{Read, Seek, Write};

use crate::{BackendError, BackendReport, RewriteLimits, RewriteRequest};

/// Read/seek capability passed to an injected demo backend.
pub trait ReadSeek: Read + Seek + Send {}

impl<T> ReadSeek for T where T: Read + Seek + Send + ?Sized {}

/// Write/seek capability passed to an injected demo backend.
pub trait WriteSeek: Write + Seek + Send {}

impl<T> WriteSeek for T where T: Write + Seek + Send + ?Sized {}

/// Injectable stream rewrite boundary used by safe file publication.
pub trait DemoRewriteBackend: Debug + Send + Sync {
    /// Rewrites one already validated input handle into a newly-created,
    /// bounded staging output.
    ///
    /// # Errors
    ///
    /// Returns [`BackendError`] when parsing, encoding, bounded I/O, or a
    /// backend-controlled counter fails.
    fn rewrite(
        &self,
        input: &mut dyn ReadSeek,
        output: &mut dyn WriteSeek,
        request: &RewriteRequest,
        limits: &RewriteLimits,
    ) -> Result<BackendReport, BackendError>;
}
