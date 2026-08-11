use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
};

use sha2::{Digest, Sha256};
use uuid::Uuid;
use vibe_cs_platform_windows::ProcessCancellation;

use crate::{RecordingError, RecordingResult, io_error};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PublishedClip {
    pub path: PathBuf,
    pub bytes: u64,
    pub sha256: String,
}

/// Copies a verified OBS output into a same-directory temporary file and
/// atomically publishes it without replacing an existing managed output.
///
/// # Errors
///
/// Rejects missing, empty, oversized, symlink, relative, or existing paths;
/// also returns cancellation and filesystem errors.
pub async fn publish_obs_output(
    source: &Path,
    destination: &Path,
    maximum_bytes: u64,
    cancellation: &ProcessCancellation,
) -> RecordingResult<PublishedClip> {
    let source = source.to_path_buf();
    let destination = destination.to_path_buf();
    let cancellation = cancellation.clone();
    tokio::task::spawn_blocking(move || {
        publish_blocking(&source, &destination, maximum_bytes, &cancellation)
    })
    .await
    .map_err(|error| RecordingError::Task(error.to_string()))?
}

fn publish_blocking(
    source: &Path,
    destination: &Path,
    maximum_bytes: u64,
    cancellation: &ProcessCancellation,
) -> RecordingResult<PublishedClip> {
    if maximum_bytes == 0 || !source.is_absolute() || !destination.is_absolute() {
        return Err(RecordingError::InvalidInput(
            "recording paths must be absolute and the output limit positive".to_owned(),
        ));
    }
    if source == destination {
        return Err(RecordingError::OutputInvalid {
            path: source.to_path_buf(),
            reason: "OBS source and managed destination must differ".to_owned(),
        });
    }
    let metadata = fs::symlink_metadata(source)
        .map_err(|error| io_error("reading OBS output metadata", source, error))?;
    if metadata.file_type().is_symlink()
        || !metadata.file_type().is_file()
        || metadata.len() == 0
        || metadata.len() > maximum_bytes
    {
        return Err(RecordingError::OutputInvalid {
            path: source.to_path_buf(),
            reason: format!(
                "output must be a regular non-empty file no larger than {maximum_bytes} bytes"
            ),
        });
    }
    let parent = destination
        .parent()
        .ok_or_else(|| RecordingError::OutputInvalid {
            path: destination.to_path_buf(),
            reason: "managed output has no parent directory".to_owned(),
        })?;
    if !parent.is_dir() || destination.file_name().is_none() {
        return Err(RecordingError::OutputInvalid {
            path: destination.to_path_buf(),
            reason: "managed output parent must be an existing directory".to_owned(),
        });
    }
    if destination
        .try_exists()
        .map_err(|error| io_error("checking managed output", destination, error))?
    {
        return Err(RecordingError::OutputInvalid {
            path: destination.to_path_buf(),
            reason: "managed output already exists".to_owned(),
        });
    }
    if cancellation.is_cancelled() {
        return Err(RecordingError::Cancelled {
            stage: "recording output publication",
        });
    }
    let file_name = destination
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| RecordingError::OutputInvalid {
            path: destination.to_path_buf(),
            reason: "managed output file name is not valid Unicode".to_owned(),
        })?;
    let temporary =
        destination.with_file_name(format!(".{file_name}.{}.recording.tmp", Uuid::new_v4()));
    let result = (|| {
        let mut input =
            File::open(source).map_err(|error| io_error("opening OBS output", source, error))?;
        let mut output = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temporary)
            .map_err(|error| {
                io_error("creating managed output temporary file", &temporary, error)
            })?;
        let mut digest = Sha256::new();
        let mut copied = 0_u64;
        let mut buffer = vec![0_u8; 1024 * 1024];
        loop {
            if cancellation.is_cancelled() {
                return Err(RecordingError::Cancelled {
                    stage: "recording output publication",
                });
            }
            let read = input
                .read(&mut buffer)
                .map_err(|error| io_error("reading OBS output", source, error))?;
            if read == 0 {
                break;
            }
            copied = copied
                .checked_add(u64::try_from(read).unwrap_or(u64::MAX))
                .ok_or_else(|| RecordingError::OutputInvalid {
                    path: source.to_path_buf(),
                    reason: "recording size overflow".to_owned(),
                })?;
            if copied > maximum_bytes {
                return Err(RecordingError::OutputInvalid {
                    path: source.to_path_buf(),
                    reason: format!("recording exceeds the {maximum_bytes}-byte limit"),
                });
            }
            output
                .write_all(&buffer[..read])
                .map_err(|error| io_error("writing managed output", &temporary, error))?;
            digest.update(&buffer[..read]);
        }
        if copied == 0 {
            return Err(RecordingError::OutputInvalid {
                path: source.to_path_buf(),
                reason: "recording output is empty".to_owned(),
            });
        }
        output
            .flush()
            .and_then(|()| output.sync_all())
            .map_err(|error| io_error("synchronizing managed output", &temporary, error))?;
        drop(output);
        fs::hard_link(&temporary, destination).map_err(|error| {
            io_error("atomically publishing managed output", destination, error)
        })?;
        // Publication is committed once the create-new hard link succeeds.
        let _ = fs::remove_file(&temporary);
        sync_parent(destination)?;
        Ok(PublishedClip {
            path: destination.to_path_buf(),
            bytes: copied,
            sha256: hex::encode(digest.finalize()),
        })
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

#[cfg(windows)]
fn sync_parent(path: &Path) -> RecordingResult<()> {
    path.parent().map_or_else(
        || {
            Err(RecordingError::InvalidInput(
                "managed output has no parent directory".to_owned(),
            ))
        },
        |_| Ok(()),
    )
}

#[cfg(not(windows))]
fn sync_parent(path: &Path) -> RecordingResult<()> {
    let parent = path.parent().ok_or_else(|| {
        RecordingError::InvalidInput("managed output has no parent directory".to_owned())
    })?;
    File::open(parent)
        .and_then(|directory| directory.sync_all())
        .map_err(|error| io_error("synchronizing output directory", parent, error))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn atomically_publishes_non_empty_output_without_overwrite() {
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("obs.mkv");
        let destination = root.path().join("managed.mkv");
        fs::write(&source, b"video").unwrap();
        let published =
            publish_obs_output(&source, &destination, 1024, &ProcessCancellation::default())
                .await
                .unwrap();
        assert_eq!(published.bytes, 5);
        assert_eq!(fs::read(&destination).unwrap(), b"video");
        assert!(
            publish_obs_output(&source, &destination, 1024, &ProcessCancellation::default())
                .await
                .is_err()
        );
        assert_eq!(fs::read(destination).unwrap(), b"video");
    }

    #[tokio::test]
    async fn rejects_empty_obs_output() {
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("obs.mkv");
        fs::write(&source, []).unwrap();
        assert!(matches!(
            publish_obs_output(
                &source,
                &root.path().join("managed.mkv"),
                1024,
                &ProcessCancellation::default()
            )
            .await,
            Err(RecordingError::OutputInvalid { .. })
        ));
    }
}
