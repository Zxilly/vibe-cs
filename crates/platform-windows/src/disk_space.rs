use std::{fs, io, path::Path, path::PathBuf};

use thiserror::Error;

const GIBIBYTE: u64 = 1_024 * 1_024 * 1_024;

/// Minimum free space left untouched by a managed HLAE capture.
pub const HLAE_STAGING_MINIMUM_SAFETY_RESERVE_BYTES: u64 = GIBIBYTE;
/// Hard upper bound accepted from the HLAE staging resource estimator.
pub const HLAE_STAGING_MAXIMUM_BYTES: u64 = 512 * GIBIBYTE;

/// Failure to validate or satisfy an HLAE staging disk-space requirement.
#[derive(Debug, Error)]
pub enum HlaeDiskSpacePreflightError {
    #[error("invalid HLAE staging disk-space request: {0}")]
    InvalidRequest(String),
    #[error(
        "insufficient disk space for HLAE staging: {available_bytes} bytes available, {required_bytes} bytes required"
    )]
    Insufficient {
        available_bytes: u64,
        required_bytes: u64,
    },
    #[error("could not resolve HLAE staging directory {path}: {source}")]
    DirectoryUnavailable {
        path: PathBuf,
        #[source]
        source: io::Error,
    },
    #[error("could not query available space for HLAE staging directory {path}: {source}")]
    QueryFailed {
        path: PathBuf,
        #[source]
        source: io::Error,
    },
}

/// Evidence captured by a successful HLAE staging disk-space preflight.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct HlaeDiskSpaceEvidence {
    pub available_bytes: u64,
    pub required_bytes: u64,
    pub staging_bytes: u64,
    pub safety_reserve_bytes: u64,
}

/// Computes the default free-space margin for an HLAE staging estimate.
///
/// The reserve is the larger of one GiB and ten percent of the estimate,
/// rounded up to the next whole byte.
///
/// # Errors
///
/// Returns [`HlaeDiskSpacePreflightError::InvalidRequest`] when the estimate is
/// zero or exceeds [`HLAE_STAGING_MAXIMUM_BYTES`].
pub fn recommended_hlae_staging_safety_reserve(
    staging_bytes: u64,
) -> Result<u64, HlaeDiskSpacePreflightError> {
    validate_staging_bytes(staging_bytes)?;
    let ten_percent = staging_bytes
        .checked_add(9)
        .ok_or_else(|| invalid_request("staging byte count overflowed"))?
        / 10;
    Ok(ten_percent.max(HLAE_STAGING_MINIMUM_SAFETY_RESERVE_BYTES))
}

/// Assesses a known free-space reading against a bounded HLAE staging estimate.
///
/// # Errors
///
/// Returns [`HlaeDiskSpacePreflightError::InvalidRequest`] for an invalid
/// staging estimate and [`HlaeDiskSpacePreflightError::Insufficient`] unless
/// available space covers both staging and the recommended safety reserve.
pub fn assess_hlae_staging_disk_space(
    available_bytes: u64,
    staging_bytes: u64,
) -> Result<HlaeDiskSpaceEvidence, HlaeDiskSpacePreflightError> {
    let safety_reserve_bytes = recommended_hlae_staging_safety_reserve(staging_bytes)?;
    let required_bytes = staging_bytes
        .checked_add(safety_reserve_bytes)
        .ok_or_else(|| invalid_request("staging requirement overflowed"))?;
    if available_bytes < required_bytes {
        return Err(HlaeDiskSpacePreflightError::Insufficient {
            available_bytes,
            required_bytes,
        });
    }
    Ok(HlaeDiskSpaceEvidence {
        available_bytes,
        required_bytes,
        staging_bytes,
        safety_reserve_bytes,
    })
}

/// Queries the volume containing an existing absolute staging directory and
/// verifies that an HLAE capture can fit without consuming its safety reserve.
///
/// This is a read-only point-in-time preflight. It reports evidence but does
/// not reserve or allocate disk space, so callers should run it immediately
/// before starting capture.
///
/// # Errors
///
/// Rejects relative, missing, or non-directory paths and invalid staging byte
/// counts. Returns [`HlaeDiskSpacePreflightError::Insufficient`] if the current
/// available space is below the staging estimate plus recommended reserve.
pub fn preflight_hlae_staging_disk_space(
    staging_directory: &Path,
    staging_bytes: u64,
) -> Result<HlaeDiskSpaceEvidence, HlaeDiskSpacePreflightError> {
    validate_staging_bytes(staging_bytes)?;
    if !staging_directory.is_absolute() {
        return Err(invalid_request(
            "staging directory must be an absolute path",
        ));
    }
    let resolved = fs::canonicalize(staging_directory).map_err(|source| {
        HlaeDiskSpacePreflightError::DirectoryUnavailable {
            path: staging_directory.to_path_buf(),
            source,
        }
    })?;
    let metadata = fs::metadata(&resolved).map_err(|source| {
        HlaeDiskSpacePreflightError::DirectoryUnavailable {
            path: resolved.clone(),
            source,
        }
    })?;
    if !metadata.is_dir() {
        return Err(invalid_request(
            "staging path must resolve to an existing directory",
        ));
    }
    let available_bytes = fs4::available_space(&resolved).map_err(|source| {
        HlaeDiskSpacePreflightError::QueryFailed {
            path: resolved,
            source,
        }
    })?;
    assess_hlae_staging_disk_space(available_bytes, staging_bytes)
}

fn validate_staging_bytes(staging_bytes: u64) -> Result<(), HlaeDiskSpacePreflightError> {
    if staging_bytes == 0 || staging_bytes > HLAE_STAGING_MAXIMUM_BYTES {
        return Err(invalid_request(format!(
            "staging bytes must be in 1..={HLAE_STAGING_MAXIMUM_BYTES}"
        )));
    }
    Ok(())
}

fn invalid_request(message: impl Into<String>) -> HlaeDiskSpacePreflightError {
    HlaeDiskSpacePreflightError::InvalidRequest(message.into())
}
