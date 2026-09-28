//! Directory capabilities shared by the replay and map-geometry caches.
use cap_std::{
    ambient_authority,
    fs::{Dir, File as CapabilityFile, OpenOptions as CapabilityOpenOptions},
};
use std::{
    fs,
    io::{ErrorKind, Write},
    path::{Path, PathBuf},
};
use uuid::Uuid;
use vibe_cs_domain::DomainError;

pub(crate) fn initialize_cache_directory(root: &Path) -> Result<(PathBuf, Dir), DomainError> {
    fs::create_dir_all(root).map_err(|error| cache_io_error("create directory", &error))?;
    let metadata =
        fs::symlink_metadata(root).map_err(|error| cache_io_error("inspect directory", &error))?;
    if !metadata.is_dir()
        || metadata.file_type().is_symlink()
        || ambient_metadata_is_reparse(&metadata)
    {
        return Err(DomainError::Conflict(
            "managed cache root is not a plain directory".to_owned(),
        ));
    }
    let canonical =
        fs::canonicalize(root).map_err(|error| cache_io_error("canonicalize directory", &error))?;
    let directory = Dir::open_ambient_dir(&canonical, ambient_authority())
        .map_err(|error| cache_io_error("bind directory capability", &error))?;
    let capability_metadata = directory
        .dir_metadata()
        .map_err(|error| cache_io_error("inspect directory capability", &error))?;
    if !capability_metadata.is_dir() || capability_metadata_is_reparse(&capability_metadata) {
        return Err(DomainError::Conflict(
            "managed cache capability is not a plain directory".to_owned(),
        ));
    }
    ensure_cache_directory_mapping(&directory, &canonical)?;
    Ok((canonical, directory))
}

pub(crate) fn ensure_cache_directory_mapping(
    directory: &Dir,
    path: &Path,
) -> Result<(), DomainError> {
    let metadata = fs::symlink_metadata(path)
        .map_err(|error| cache_io_error("inspect ambient directory", &error))?;
    if !metadata.is_dir()
        || metadata.file_type().is_symlink()
        || ambient_metadata_is_reparse(&metadata)
    {
        return Err(DomainError::Conflict(
            "managed cache path is no longer a plain directory".to_owned(),
        ));
    }
    let ambient = Dir::open_ambient_dir(path, ambient_authority())
        .map_err(|error| cache_io_error("open ambient directory", &error))?;
    if !capability_directories_are_same(directory, &ambient)? {
        return Err(DomainError::Conflict(
            "managed cache directory identity changed".to_owned(),
        ));
    }
    Ok(())
}

fn capability_directories_are_same(first: &Dir, second: &Dir) -> Result<bool, DomainError> {
    let first = same_file::Handle::from_file(
        first
            .try_clone()
            .map_err(|error| cache_io_error("clone directory capability", &error))?
            .into_std_file(),
    )
    .map_err(|error| cache_io_error("identify directory capability", &error))?;
    let second = same_file::Handle::from_file(
        second
            .try_clone()
            .map_err(|error| cache_io_error("clone ambient directory", &error))?
            .into_std_file(),
    )
    .map_err(|error| cache_io_error("identify ambient directory", &error))?;
    Ok(first == second)
}

pub(crate) fn open_verified_plain_file(
    directory: &Dir,
    name: impl AsRef<Path>,
) -> std::io::Result<(CapabilityFile, cap_std::fs::Metadata)> {
    let name = name.as_ref();
    let metadata = directory.symlink_metadata(name)?;
    if !metadata.is_file() || metadata.is_symlink() || capability_metadata_is_reparse(&metadata) {
        return Err(std::io::Error::new(
            ErrorKind::InvalidData,
            "managed cache entry is not a plain file",
        ));
    }
    let mut options = CapabilityOpenOptions::new();
    options.read(true);
    let file = directory.open_with(name, &options)?;
    let opened = file.metadata()?;
    if !opened.is_file()
        || capability_metadata_is_reparse(&opened)
        || !capability_file_matches_name(directory, name, &file)?
    {
        return Err(std::io::Error::new(
            ErrorKind::InvalidData,
            "managed cache entry changed while opening",
        ));
    }
    Ok((file, opened))
}

pub(crate) fn capability_file_matches_name(
    directory: &Dir,
    name: impl AsRef<Path>,
    file: &CapabilityFile,
) -> std::io::Result<bool> {
    let name = name.as_ref();
    let metadata = directory.symlink_metadata(name)?;
    if !metadata.is_file() || metadata.is_symlink() || capability_metadata_is_reparse(&metadata) {
        return Ok(false);
    }
    let named = directory.open(name)?;
    let opened_handle = same_file::Handle::from_file(file.try_clone()?.into_std())?;
    let named_handle = same_file::Handle::from_file(named.into_std())?;
    Ok(opened_handle == named_handle)
}

pub(crate) fn remove_verified_file(
    directory: &Dir,
    name: impl AsRef<Path>,
    file: &CapabilityFile,
) -> std::io::Result<()> {
    let name = name.as_ref();
    if !capability_file_matches_name(directory, name, file)? {
        return Err(std::io::Error::new(
            ErrorKind::InvalidData,
            "managed cache entry changed before deletion",
        ));
    }
    directory.remove_file(name)
}

#[cfg(windows)]
pub(crate) fn capability_metadata_is_reparse(metadata: &cap_std::fs::Metadata) -> bool {
    use cap_std::fs::MetadataExt as _;

    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
    metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
}

#[cfg(not(windows))]
pub(crate) fn capability_metadata_is_reparse(_metadata: &cap_std::fs::Metadata) -> bool {
    false
}

#[cfg(windows)]
fn ambient_metadata_is_reparse(metadata: &fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt as _;

    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
    metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
}

#[cfg(not(windows))]
fn ambient_metadata_is_reparse(_metadata: &fs::Metadata) -> bool {
    false
}

pub(crate) fn write_atomic(
    directory: &Dir,
    destination: &str,
    key: &str,
    bytes: &[u8],
) -> Result<(), DomainError> {
    let temporary = format!(".{key}.{}.tmp", Uuid::new_v4());
    let mut options = CapabilityOpenOptions::new();
    options.read(true).write(true).create_new(true);
    let mut file = directory
        .open_with(&temporary, &options)
        .map_err(|error| cache_io_error("create staging entry", &error))?;
    let result = (|| {
        file.write_all(bytes)
            .map_err(|error| cache_io_error("write staging entry", &error))?;
        file.flush()
            .map_err(|error| cache_io_error("flush staging entry", &error))?;
        file.sync_all()
            .map_err(|error| cache_io_error("persist staging entry", &error))?;
        if !capability_file_matches_name(directory, &temporary, &file)
            .map_err(|error| cache_io_error("verify staging entry", &error))?
        {
            return Err(DomainError::Conflict(
                "managed cache staging entry changed before publication".to_owned(),
            ));
        }
        drop(file);
        directory
            .rename(&temporary, directory, destination)
            .map_err(|error| cache_io_error("publish staging entry", &error))
    })();
    if result.is_err() {
        let _ = directory.remove_file(&temporary);
    }
    result
}

fn cache_io_error(action: &str, error: &std::io::Error) -> DomainError {
    DomainError::Internal(format!("managed cache I/O failed to {action}: {error}"))
}
