use std::{
    collections::BTreeSet,
    fs::{self, File, OpenOptions},
    io::{BufReader, Cursor, Write as _},
    path::{Component, Path, PathBuf},
};

use serde::{Deserialize, Serialize};
use sha2::{Digest as _, Sha256};
use tempfile::Builder;
use zip::ZipArchive;

use crate::{HlaeError, HlaeInstallation, installation_from_executable};

pub const HLAE_MANAGED_RELEASE_VERSION: &str = "v2.191.1";
pub const HLAE_MANAGED_ARCHIVE_URL: &str =
    "https://github.com/advancedfx/advancedfx/releases/download/v2.191.1/hlae_2_191_1.zip";
pub const HLAE_MANAGED_ARCHIVE_SIZE: u64 = 8_957_941;
pub const HLAE_MANAGED_ARCHIVE_SHA256: &str =
    "307ba9170b151a7df9b7e5604b335c2d8b8df5bf5cb8d6700ae3fd01069da514";
/// Full fingerprint of the release signing key independently reviewed for this release.
pub const HLAE_MANAGED_SIGNING_FINGERPRINT: &str = "7707F41879766E341A2499D360C1592755AE313F";

const MAXIMUM_ARCHIVE_ENTRIES: usize = 512;
const MAXIMUM_EXTRACTED_BYTES: u64 = 64 * 1024 * 1024;
const MAXIMUM_ENTRY_NAME_BYTES: usize = 200;
const MANAGED_ARCHIVE_FILE: &str = "vibe_cs_hlae_source.zip";

/// Immutable metadata for the HLAE release reviewed by Vibe CS.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ManagedHlaeRelease {
    pub version: String,
    pub archive_url: String,
    pub archive_size: u64,
    pub archive_sha256: String,
    pub signing_fingerprint: String,
}

impl ManagedHlaeRelease {
    #[must_use]
    pub fn current() -> Self {
        Self {
            version: HLAE_MANAGED_RELEASE_VERSION.to_owned(),
            archive_url: HLAE_MANAGED_ARCHIVE_URL.to_owned(),
            archive_size: HLAE_MANAGED_ARCHIVE_SIZE,
            archive_sha256: HLAE_MANAGED_ARCHIVE_SHA256.to_owned(),
            signing_fingerprint: HLAE_MANAGED_SIGNING_FINGERPRINT.to_owned(),
        }
    }
}

/// Returns the immutable directory reserved for the reviewed managed release.
#[must_use]
pub fn managed_hlae_release_directory(managed_root: &Path) -> PathBuf {
    managed_root.join(HLAE_MANAGED_RELEASE_VERSION)
}

/// Validates and atomically publishes the reviewed portable HLAE archive.
///
/// The archive bytes must exactly match the pinned size and SHA-256. Extraction
/// rejects links, absolute/traversal/ADS-style paths, duplicate Windows paths,
/// excessive entries and decompressed-size expansion. The completed version is
/// immutable and is never overwritten.
///
/// # Errors
///
/// Returns [`HlaeError`] when integrity, archive shape, required files or the
/// no-clobber publication contract cannot be proven.
pub fn install_managed_hlae_archive(
    archive_bytes: &[u8],
    managed_root: &Path,
) -> Result<HlaeInstallation, HlaeError> {
    install_release_archive(archive_bytes, managed_root, &ManagedHlaeRelease::current())
}

fn install_release_archive(
    archive_bytes: &[u8],
    managed_root: &Path,
    release: &ManagedHlaeRelease,
) -> Result<HlaeInstallation, HlaeError> {
    validate_release_archive(archive_bytes, release)?;
    fs::create_dir_all(managed_root)
        .map_err(|error| artifact_io("create managed HLAE root", &error))?;
    let root_metadata = fs::symlink_metadata(managed_root)
        .map_err(|error| artifact_io("inspect managed HLAE root", &error))?;
    if !root_metadata.is_dir()
        || root_metadata.file_type().is_symlink()
        || is_reparse_point(&root_metadata)
    {
        return Err(HlaeError::InvalidInstallation(
            "managed HLAE root must be a regular directory".to_owned(),
        ));
    }

    let destination = managed_root.join(&release.version);
    if destination
        .try_exists()
        .map_err(|error| artifact_io("check managed HLAE destination", &error))?
    {
        return Err(HlaeError::ArtifactBundleExists(destination));
    }

    let staging = Builder::new()
        .prefix(".hlae-staging-")
        .tempdir_in(managed_root)
        .map_err(|error| artifact_io("create managed HLAE staging directory", &error))?;
    extract_archive(archive_bytes, staging.path())?;
    write_cached_archive(archive_bytes, staging.path())?;
    verify_release_directory(staging.path(), release)?;

    fs::rename(staging.path(), &destination)
        .map_err(|error| artifact_io("publish managed HLAE release", &error))?;
    verify_release_directory(&destination, release)
}

/// Revalidates the pinned archive and every extracted regular file before a
/// managed HLAE installation may be used.
///
/// # Errors
///
/// Returns [`HlaeError`] when the immutable archive, an extracted artifact or
/// the directory shape has drifted since preparation.
pub fn verify_managed_hlae_installation(
    managed_root: &Path,
) -> Result<HlaeInstallation, HlaeError> {
    verify_release_directory(
        &managed_hlae_release_directory(managed_root),
        &ManagedHlaeRelease::current(),
    )
}

fn validate_release_archive(
    archive_bytes: &[u8],
    release: &ManagedHlaeRelease,
) -> Result<(), HlaeError> {
    let actual_size = u64::try_from(archive_bytes.len()).unwrap_or(u64::MAX);
    if actual_size != release.archive_size {
        return Err(HlaeError::InvalidInstallation(format!(
            "managed HLAE archive size mismatch: expected {}, received {actual_size}",
            release.archive_size
        )));
    }
    let actual_hash = hex::encode(Sha256::digest(archive_bytes));
    if actual_hash != release.archive_sha256 {
        return Err(HlaeError::InvalidInstallation(
            "managed HLAE archive SHA-256 mismatch".to_owned(),
        ));
    }
    Ok(())
}

fn extract_archive(archive_bytes: &[u8], staging: &Path) -> Result<(), HlaeError> {
    let mut archive = ZipArchive::new(Cursor::new(archive_bytes))
        .map_err(|error| archive_error("open managed HLAE archive", &error))?;
    if archive.len() > MAXIMUM_ARCHIVE_ENTRIES {
        return Err(HlaeError::InvalidInstallation(format!(
            "managed HLAE archive contains more than {MAXIMUM_ARCHIVE_ENTRIES} entries"
        )));
    }
    let mut total_bytes = 0_u64;
    let mut paths = BTreeSet::new();
    for index in 0..archive.len() {
        let mut entry = archive
            .by_index(index)
            .map_err(|error| archive_error("read managed HLAE archive entry", &error))?;
        let relative = safe_archive_path(entry.name())?;
        let windows_key = windows_path_key(&relative);
        if !paths.insert(windows_key) {
            return Err(HlaeError::InvalidInstallation(
                "managed HLAE archive contains duplicate Windows paths".to_owned(),
            ));
        }
        if entry
            .unix_mode()
            .is_some_and(|mode| mode & 0o170_000 == 0o120_000)
        {
            return Err(HlaeError::InvalidInstallation(
                "managed HLAE archive contains a symbolic link".to_owned(),
            ));
        }
        total_bytes = total_bytes.checked_add(entry.size()).ok_or_else(|| {
            HlaeError::InvalidInstallation("managed HLAE archive size overflow".to_owned())
        })?;
        if total_bytes > MAXIMUM_EXTRACTED_BYTES {
            return Err(HlaeError::InvalidInstallation(format!(
                "managed HLAE archive expands beyond {MAXIMUM_EXTRACTED_BYTES} bytes"
            )));
        }

        let output = staging.join(relative);
        if entry.is_dir() {
            fs::create_dir_all(&output)
                .map_err(|error| artifact_io("create managed HLAE directory", &error))?;
            continue;
        }
        if let Some(parent) = output.parent() {
            fs::create_dir_all(parent)
                .map_err(|error| artifact_io("create managed HLAE parent directory", &error))?;
        }
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&output)
            .map_err(|error| artifact_io("create managed HLAE file", &error))?;
        let copied = std::io::copy(&mut entry, &mut file)
            .map_err(|error| artifact_io("extract managed HLAE file", &error))?;
        if copied != entry.size() {
            return Err(HlaeError::InvalidInstallation(
                "managed HLAE archive entry size changed during extraction".to_owned(),
            ));
        }
        file.flush()
            .map_err(|error| artifact_io("flush managed HLAE file", &error))?;
        file.sync_all()
            .map_err(|error| artifact_io("synchronize managed HLAE file", &error))?;
    }
    Ok(())
}

fn write_cached_archive(archive_bytes: &[u8], staging: &Path) -> Result<(), HlaeError> {
    let path = staging.join(MANAGED_ARCHIVE_FILE);
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(|error| artifact_io("create managed HLAE source archive", &error))?;
    file.write_all(archive_bytes)
        .and_then(|()| file.flush())
        .and_then(|()| file.sync_all())
        .map_err(|error| artifact_io("write managed HLAE source archive", &error))
}

fn verify_release_directory(
    directory: &Path,
    release: &ManagedHlaeRelease,
) -> Result<HlaeInstallation, HlaeError> {
    let metadata = fs::symlink_metadata(directory)
        .map_err(|error| artifact_io("inspect managed HLAE release directory", &error))?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() || is_reparse_point(&metadata) {
        return Err(HlaeError::InvalidInstallation(
            "managed HLAE release must be a regular directory".to_owned(),
        ));
    }
    let archive_path = directory.join(MANAGED_ARCHIVE_FILE);
    let archive_metadata = fs::symlink_metadata(&archive_path)
        .map_err(|error| artifact_io("inspect managed HLAE source archive", &error))?;
    if !archive_metadata.is_file()
        || archive_metadata.file_type().is_symlink()
        || is_reparse_point(&archive_metadata)
        || archive_metadata.len() != release.archive_size
    {
        return Err(HlaeError::InvalidInstallation(
            "managed HLAE source archive is missing or has drifted".to_owned(),
        ));
    }
    let archive_bytes = fs::read(&archive_path)
        .map_err(|error| artifact_io("read managed HLAE source archive", &error))?;
    validate_release_archive(&archive_bytes, release)?;
    verify_extracted_files(&archive_bytes, directory)?;
    installation_from_executable(&directory.join("HLAE.exe"))
}

fn verify_extracted_files(archive_bytes: &[u8], directory: &Path) -> Result<(), HlaeError> {
    let mut archive = ZipArchive::new(Cursor::new(archive_bytes))
        .map_err(|error| archive_error("open cached managed HLAE archive", &error))?;
    let mut expected_files = BTreeSet::new();
    for index in 0..archive.len() {
        let mut entry = archive
            .by_index(index)
            .map_err(|error| archive_error("read cached managed HLAE entry", &error))?;
        let relative = safe_archive_path(entry.name())?;
        if entry.is_dir() {
            continue;
        }
        let key = windows_path_key(&relative);
        if !expected_files.insert(key) {
            return Err(HlaeError::InvalidInstallation(
                "managed HLAE archive contains duplicate Windows paths".to_owned(),
            ));
        }
        let extracted = directory.join(&relative);
        let metadata = fs::symlink_metadata(&extracted)
            .map_err(|error| artifact_io("inspect managed HLAE artifact", &error))?;
        if !metadata.is_file()
            || metadata.file_type().is_symlink()
            || is_reparse_point(&metadata)
            || metadata.len() != entry.size()
        {
            return Err(HlaeError::InvalidInstallation(format!(
                "managed HLAE artifact {} is missing or has drifted",
                relative.display()
            )));
        }
        let actual_hash = hash_reader(
            BufReader::new(
                File::open(&extracted)
                    .map_err(|error| artifact_io("open managed HLAE artifact", &error))?,
            ),
            "hash managed HLAE artifact",
        )?;
        let expected_hash = hash_reader(&mut entry, "hash cached managed HLAE entry")?;
        if actual_hash != expected_hash {
            return Err(HlaeError::InvalidInstallation(format!(
                "managed HLAE artifact {} failed integrity verification",
                relative.display()
            )));
        }
    }

    let mut actual_files = BTreeSet::new();
    let mut pending = vec![directory.to_path_buf()];
    while let Some(parent) = pending.pop() {
        for entry in fs::read_dir(&parent)
            .map_err(|error| artifact_io("enumerate managed HLAE release", &error))?
        {
            let entry = entry.map_err(|error| artifact_io("read managed HLAE entry", &error))?;
            let path = entry.path();
            let metadata = fs::symlink_metadata(&path)
                .map_err(|error| artifact_io("inspect managed HLAE entry", &error))?;
            if metadata.file_type().is_symlink() || is_reparse_point(&metadata) {
                return Err(HlaeError::InvalidInstallation(
                    "managed HLAE release contains a link or reparse point".to_owned(),
                ));
            }
            if metadata.is_dir() {
                pending.push(path);
            } else if metadata.is_file() {
                let relative = path.strip_prefix(directory).map_err(|_| {
                    HlaeError::InvalidInstallation(
                        "managed HLAE artifact escaped its release directory".to_owned(),
                    )
                })?;
                let key = windows_path_key(relative);
                if key != MANAGED_ARCHIVE_FILE {
                    actual_files.insert(key);
                }
            } else {
                return Err(HlaeError::InvalidInstallation(
                    "managed HLAE release contains a non-regular entry".to_owned(),
                ));
            }
        }
    }
    if actual_files != expected_files {
        let missing = expected_files
            .difference(&actual_files)
            .take(3)
            .cloned()
            .collect::<Vec<_>>();
        let unexpected = actual_files
            .difference(&expected_files)
            .take(3)
            .cloned()
            .collect::<Vec<_>>();
        return Err(HlaeError::InvalidInstallation(format!(
            "managed HLAE release contains missing {missing:?} or unexpected {unexpected:?} files"
        )));
    }
    Ok(())
}

fn hash_reader(
    mut reader: impl std::io::Read,
    operation: &'static str,
) -> Result<[u8; 32], HlaeError> {
    let mut hasher = Sha256::new();
    let mut buffer = vec![0_u8; 64 * 1024];
    loop {
        let read = reader
            .read(&mut buffer)
            .map_err(|error| artifact_io(operation, &error))?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(hasher.finalize().into())
}

fn safe_archive_path(name: &str) -> Result<PathBuf, HlaeError> {
    if name.is_empty()
        || name.len() > MAXIMUM_ENTRY_NAME_BYTES
        || !name.is_ascii()
        || name.contains(['\\', ':'])
        || name.bytes().any(|byte| byte.is_ascii_control())
    {
        return Err(HlaeError::InvalidInstallation(
            "managed HLAE archive contains an unsafe entry name".to_owned(),
        ));
    }
    let path = Path::new(name);
    if path.is_absolute()
        || path
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err(HlaeError::InvalidInstallation(
            "managed HLAE archive contains a traversal path".to_owned(),
        ));
    }
    Ok(path.to_path_buf())
}

fn windows_path_key(path: &Path) -> String {
    path.to_string_lossy()
        .replace('\\', "/")
        .to_ascii_lowercase()
}

fn artifact_io(operation: &'static str, error: &std::io::Error) -> HlaeError {
    HlaeError::ArtifactIo {
        operation,
        message: error.to_string(),
    }
}

fn archive_error(operation: &'static str, error: &zip::result::ZipError) -> HlaeError {
    HlaeError::ArtifactIo {
        operation,
        message: error.to_string(),
    }
}

#[cfg(windows)]
fn is_reparse_point(metadata: &fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt as _;
    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0400;
    metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
}

#[cfg(not(windows))]
const fn is_reparse_point(_metadata: &fs::Metadata) -> bool {
    false
}

#[cfg(test)]
mod tests {
    use std::io::Write as _;

    use zip::{ZipWriter, write::SimpleFileOptions};

    use super::*;
    use crate::HlaeDiscoverySource;

    fn archive(entries: &[(&str, &[u8])]) -> Vec<u8> {
        let mut bytes = Cursor::new(Vec::new());
        {
            let mut writer = ZipWriter::new(&mut bytes);
            for (name, contents) in entries {
                writer
                    .start_file(*name, SimpleFileOptions::default())
                    .unwrap();
                writer.write_all(contents).unwrap();
            }
            writer.finish().unwrap();
        }
        bytes.into_inner()
    }

    fn fixture_release(bytes: &[u8]) -> ManagedHlaeRelease {
        ManagedHlaeRelease {
            version: "v-test".to_owned(),
            archive_url: "https://example.invalid/hlae.zip".to_owned(),
            archive_size: u64::try_from(bytes.len()).unwrap(),
            archive_sha256: hex::encode(Sha256::digest(bytes)),
            signing_fingerprint: "test-only".to_owned(),
        }
    }

    #[test]
    fn verified_portable_archive_is_published_as_an_immutable_managed_release() {
        let root = tempfile::tempdir().unwrap();
        let bytes = archive(&[
            ("HLAE.exe", b"hlae"),
            ("x64/AfxHookSource2.dll", b"hook"),
            ("LICENSES/notice.txt", b"notice"),
        ]);

        let installed =
            install_release_archive(&bytes, root.path(), &fixture_release(&bytes)).unwrap();

        assert_eq!(installed.source, HlaeDiscoverySource::Managed);
        assert_eq!(installed.root, root.path().join("v-test"));
        assert_eq!(fs::read(&installed.source2_hook).unwrap(), b"hook");
        assert!(verify_release_directory(&installed.root, &fixture_release(&bytes)).is_ok());
        fs::write(&installed.source2_hook, b"evil").unwrap();
        assert!(verify_release_directory(&installed.root, &fixture_release(&bytes)).is_err());
        assert!(install_release_archive(&bytes, root.path(), &fixture_release(&bytes)).is_err());
    }

    #[test]
    fn rejects_archive_integrity_mismatch_before_creating_a_release() {
        let root = tempfile::tempdir().unwrap();
        let bytes = archive(&[("HLAE.exe", b"hlae"), ("x64/AfxHookSource2.dll", b"hook")]);
        let mut release = fixture_release(&bytes);
        release.archive_sha256 = "0".repeat(64);

        assert!(install_release_archive(&bytes, root.path(), &release).is_err());
        assert!(!root.path().join("v-test").exists());
    }

    #[test]
    fn rejects_traversal_and_windows_alias_paths() {
        for unsafe_name in ["../outside.txt", "nested\\outside.txt", "file:stream"] {
            let bytes = archive(&[
                ("HLAE.exe", b"hlae"),
                ("x64/AfxHookSource2.dll", b"hook"),
                (unsafe_name, b"unsafe"),
            ]);
            let root = tempfile::tempdir().unwrap();

            assert!(
                install_release_archive(&bytes, root.path(), &fixture_release(&bytes)).is_err()
            );
        }
    }

    #[test]
    #[ignore = "requires the independently downloaded official HLAE release archive"]
    fn installs_the_reviewed_official_portable_release() {
        let archive_path = std::env::var_os("VIBE_CS_HLAE_ARCHIVE")
            .expect("VIBE_CS_HLAE_ARCHIVE must point to the reviewed release ZIP");
        let bytes = fs::read(archive_path).unwrap();
        let root = tempfile::tempdir().unwrap();

        let installed = install_managed_hlae_archive(&bytes, root.path()).unwrap();

        assert_eq!(installed.source, HlaeDiscoverySource::Managed);
        assert_eq!(installed.root, managed_hlae_release_directory(root.path()));
        assert!(installed.executable.is_file());
        assert!(installed.source2_hook.is_file());
        let discovered = crate::discover_managed_hlae(root.path());
        assert_eq!(discovered.installation, Some(installed));
    }
}
