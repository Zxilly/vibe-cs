use std::{
    fs::{self, File, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
};

use uuid::Uuid;

use crate::{PlatformError, PlatformResult, io_error};

pub(crate) fn write_new_synced(path: &Path, bytes: &[u8]) -> PlatformResult<()> {
    ensure_file_parent(path)?;
    let mut file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(path)
        .map_err(|error| io_error("creating file", path, error))?;
    if let Err(error) = write_and_sync(&mut file, bytes) {
        drop(file);
        let _ = fs::remove_file(path);
        return Err(io_error("writing file", path, error));
    }
    sync_parent(path)
}

pub(crate) fn atomic_write(path: &Path, bytes: &[u8]) -> PlatformResult<()> {
    atomic_write_with_mode(path, bytes, PublishMode::Replace)
}

pub(crate) fn atomic_write_new(path: &Path, bytes: &[u8]) -> PlatformResult<()> {
    if path.exists() {
        return Err(PlatformError::RecoveryPending);
    }
    atomic_write_with_mode(path, bytes, PublishMode::CreateNew)
}

fn atomic_write_with_mode(path: &Path, bytes: &[u8], mode: PublishMode) -> PlatformResult<()> {
    ensure_file_parent(path)?;
    let temporary = temporary_path(path)?;
    let result = (|| {
        let mut file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temporary)
            .map_err(|error| io_error("creating temporary file", &temporary, error))?;
        write_and_sync(&mut file, bytes)
            .map_err(|error| io_error("writing temporary file", &temporary, error))?;
        drop(file);
        publish_file(&temporary, path, mode)?;
        sync_parent(path)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

#[derive(Debug, Clone, Copy)]
enum PublishMode {
    CreateNew,
    Replace,
}

pub(crate) fn remove_file_synced(path: &Path) -> PlatformResult<()> {
    fs::remove_file(path).map_err(|error| io_error("removing file", path, error))?;
    sync_parent(path)
}

fn write_and_sync(file: &mut File, bytes: &[u8]) -> std::io::Result<()> {
    file.write_all(bytes)?;
    file.flush()?;
    file.sync_all()
}

fn ensure_file_parent(path: &Path) -> PlatformResult<()> {
    if !path.is_absolute() || path.file_name().is_none() {
        return Err(PlatformError::InvalidInput(
            "managed file path must be absolute and have a file name".to_owned(),
        ));
    }
    let parent = path.parent().ok_or_else(|| {
        PlatformError::InvalidInput("managed file path has no parent directory".to_owned())
    })?;
    if !parent.is_dir() {
        return Err(PlatformError::InvalidInput(
            "managed file parent must be an existing directory".to_owned(),
        ));
    }
    Ok(())
}

fn temporary_path(path: &Path) -> PlatformResult<PathBuf> {
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| PlatformError::InvalidInput("file name is not valid Unicode".to_owned()))?;
    Ok(path.with_file_name(format!(".{file_name}.{}.tmp", Uuid::new_v4())))
}

#[cfg(windows)]
fn publish_file(source: &Path, destination: &Path, mode: PublishMode) -> PlatformResult<()> {
    use std::os::windows::ffi::OsStrExt;

    use windows::{
        Win32::Storage::FileSystem::{
            MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH, MoveFileExW,
        },
        core::PCWSTR,
    };

    fn wide(path: &Path) -> Vec<u16> {
        path.as_os_str().encode_wide().chain(Some(0)).collect()
    }

    let source = wide(source);
    let destination = wide(destination);
    // SAFETY: both buffers are NUL-terminated and remain alive for the call.
    let flags = match mode {
        PublishMode::CreateNew => MOVEFILE_WRITE_THROUGH,
        PublishMode::Replace => MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
    };
    unsafe { MoveFileExW(PCWSTR(source.as_ptr()), PCWSTR(destination.as_ptr()), flags) }
        .map_err(|error| PlatformError::Windows(format!("atomically publishing file: {error}")))
}

#[cfg(not(windows))]
fn publish_file(source: &Path, destination: &Path, mode: PublishMode) -> PlatformResult<()> {
    let publication = match mode {
        PublishMode::Replace => fs::rename(source, destination),
        PublishMode::CreateNew => fs::hard_link(source, destination).map(|()| {
            // Once the hard link exists, publication is committed. A failure to
            // remove the uniquely named temporary file may leave an orphan but
            // must not report that the durable destination was not published.
            let _ = fs::remove_file(source);
        }),
    };
    publication.map_err(|error| io_error("atomically publishing file", destination, error))
}

#[cfg(windows)]
fn sync_parent(path: &Path) -> PlatformResult<()> {
    // MOVEFILE_WRITE_THROUGH covers the publish operation. Opening directories
    // for sync requires additional privileges and is not portable on Windows.
    path.parent().map_or_else(
        || {
            Err(PlatformError::InvalidInput(
                "managed file path has no parent directory".to_owned(),
            ))
        },
        |_| Ok(()),
    )
}

#[cfg(not(windows))]
fn sync_parent(path: &Path) -> PlatformResult<()> {
    let parent = path.parent().ok_or_else(|| {
        PlatformError::InvalidInput("managed file path has no parent directory".to_owned())
    })?;
    File::open(parent)
        .and_then(|directory| directory.sync_all())
        .map_err(|error| io_error("synchronizing parent directory", parent, error))
}
