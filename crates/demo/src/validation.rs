use std::{
    fs::File,
    io::{BufReader, Read},
    path::{Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
};

use sha2::{Digest, Sha256};

use crate::{DemoError, DemoResult, io_error};

pub const SOURCE2_DEMO_MAGIC: &[u8; 8] = b"PBDEMS2\0";

#[derive(Debug, Clone, Copy)]
pub struct ValidationLimits {
    pub minimum_bytes: u64,
    pub maximum_bytes: u64,
}

impl Default for ValidationLimits {
    fn default() -> Self {
        Self {
            minimum_bytes: 16,
            maximum_bytes: 2 * 1024 * 1024 * 1024,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ValidatedDemo {
    pub path: PathBuf,
    pub size: u64,
    pub sha256: String,
}

#[derive(Debug, Clone, Default)]
pub struct ParseCancellation(Arc<AtomicBool>);

impl ParseCancellation {
    pub fn cancel(&self) {
        self.0.store(true, Ordering::Release);
    }

    #[must_use]
    pub fn is_cancelled(&self) -> bool {
        self.0.load(Ordering::Acquire)
    }

    pub(crate) fn check(&self) -> DemoResult<()> {
        if self.is_cancelled() {
            Err(DemoError::Cancelled)
        } else {
            Ok(())
        }
    }
}

/// Validates extension, file type, size, magic, and content hash.
///
/// # Errors
///
/// Returns an error when the file is invalid, outside the configured limits,
/// unreadable, or the operation is cancelled.
pub fn validate_demo(
    path: impl AsRef<Path>,
    limits: ValidationLimits,
    cancellation: &ParseCancellation,
) -> DemoResult<ValidatedDemo> {
    let path = path.as_ref();
    cancellation.check()?;
    if path
        .extension()
        .and_then(|value| value.to_str())
        .is_none_or(|value| !value.eq_ignore_ascii_case("dem"))
    {
        return Err(DemoError::UnsupportedExtension(path.to_path_buf()));
    }
    let file = File::open(path).map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            DemoError::NotFound(path.to_path_buf())
        } else {
            io_error(path, error)
        }
    })?;
    let metadata = file.metadata().map_err(|error| io_error(path, error))?;
    if !metadata.is_file() {
        return Err(DemoError::NotAFile(path.to_path_buf()));
    }
    if metadata.len() < limits.minimum_bytes {
        return Err(DemoError::TooSmall {
            actual: metadata.len(),
            minimum: limits.minimum_bytes,
        });
    }
    if metadata.len() > limits.maximum_bytes {
        return Err(DemoError::TooLarge {
            actual: metadata.len(),
            maximum: limits.maximum_bytes,
        });
    }

    let initial_size = metadata.len();
    let initial_modified = metadata.modified().ok();
    let mut reader = BufReader::new(file);
    let mut magic = [0_u8; 8];
    reader
        .read_exact(&mut magic)
        .map_err(|error| io_error(path, error))?;
    if &magic != SOURCE2_DEMO_MAGIC {
        return Err(DemoError::InvalidMagic);
    }

    let mut hasher = Sha256::new();
    hasher.update(magic);
    let mut buffer = vec![0_u8; 64 * 1024];
    let mut bytes_read = u64::try_from(magic.len()).unwrap_or(u64::MAX);
    loop {
        cancellation.check()?;
        let remaining = limits
            .maximum_bytes
            .saturating_sub(bytes_read)
            .saturating_add(1);
        let read_limit = usize::try_from(remaining)
            .unwrap_or(usize::MAX)
            .min(buffer.len());
        let count = reader
            .read(&mut buffer[..read_limit])
            .map_err(|error| io_error(path, error))?;
        if count == 0 {
            break;
        }
        bytes_read = bytes_read
            .checked_add(u64::try_from(count).unwrap_or(u64::MAX))
            .ok_or(DemoError::MetadataUnavailable(
                "demo byte count overflowed while hashing",
            ))?;
        if bytes_read > limits.maximum_bytes {
            return Err(DemoError::TooLarge {
                actual: bytes_read,
                maximum: limits.maximum_bytes,
            });
        }
        hasher.update(&buffer[..count]);
    }
    cancellation.check()?;
    let final_metadata = reader
        .get_ref()
        .metadata()
        .map_err(|error| io_error(path, error))?;
    let modified_changed = initial_modified
        .zip(final_metadata.modified().ok())
        .is_some_and(|(initial, final_value)| initial != final_value);
    if bytes_read != initial_size || final_metadata.len() != initial_size || modified_changed {
        return Err(DemoError::MetadataUnavailable(
            "demo changed while it was being hashed",
        ));
    }

    Ok(ValidatedDemo {
        path: path.to_path_buf(),
        size: bytes_read,
        sha256: format!("{:x}", hasher.finalize()),
    })
}

#[cfg(test)]
mod tests {
    use std::io::Write;

    use tempfile::NamedTempFile;

    use super::*;

    #[test]
    fn validates_magic_and_hash() {
        let mut file = tempfile::Builder::new().suffix(".dem").tempfile().unwrap();
        file.write_all(b"PBDEMS2\0abcdefgh").unwrap();
        let result = validate_demo(
            file.path(),
            ValidationLimits::default(),
            &ParseCancellation::default(),
        )
        .unwrap();
        assert_eq!(result.size, 16);
        assert_eq!(result.sha256.len(), 64);
    }

    #[test]
    fn rejects_wrong_magic() {
        let mut file = tempfile::Builder::new().suffix(".dem").tempfile().unwrap();
        file.write_all(b"NOTADEMOabcdefgh").unwrap();
        assert!(matches!(
            validate_demo(
                file.path(),
                ValidationLimits::default(),
                &ParseCancellation::default()
            ),
            Err(DemoError::InvalidMagic)
        ));
    }

    #[test]
    fn cancellation_stops_validation() {
        let file = NamedTempFile::new().unwrap();
        let cancellation = ParseCancellation::default();
        cancellation.cancel();
        assert!(matches!(
            validate_demo(file.path(), ValidationLimits::default(), &cancellation),
            Err(DemoError::Cancelled)
        ));
    }
}
