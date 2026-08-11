use std::{
    fs,
    path::{Component, Path, PathBuf},
};

use serde::Deserialize;
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::{
    BackupManager, ManagedFile, PlatformError, PlatformResult, RecoveryStatus,
    fs_atomic::atomic_write, io_error,
};

const MANIFEST_NAME: &str = "hud-manifest.json";
const MAXIMUM_FILES: usize = 32;
const MAXIMUM_FILE_BYTES: u64 = 4 * 1024 * 1024;
const MAXIMUM_TOTAL_BYTES: u64 = 32 * 1024 * 1024;

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct HudManifest {
    license: String,
    files: Vec<HudManifestFile>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct HudManifestFile {
    name: String,
    sha256: String,
}

#[derive(Debug, Clone)]
pub struct FirstPersonHudInstaller {
    source_directory: PathBuf,
    target_directory: PathBuf,
    backup: BackupManager,
}

impl FirstPersonHudInstaller {
    /// Creates a transaction-scoped installer for explicitly supplied HUD files.
    /// The source must contain `hud-manifest.json` with a declared permissive or
    /// user-owned license and a SHA-256 for every file.
    ///
    /// # Errors
    ///
    /// Rejects non-absolute paths and an unsafe target directory. The source is
    /// resolved only during asset preflight so crash recovery still works if a
    /// removable user source has gone offline.
    pub fn new(
        source_directory: impl Into<PathBuf>,
        target_directory: impl Into<PathBuf>,
        recovery_directory: impl Into<PathBuf>,
    ) -> PlatformResult<Self> {
        let source_directory = source_directory.into();
        validate_absolute_directory_path(&source_directory, "HUD source")?;
        let requested_target = target_directory.into();
        validate_absolute_directory_path(&requested_target, "HUD target")?;
        fs::create_dir_all(&requested_target)
            .map_err(|error| io_error("creating HUD target directory", &requested_target, error))?;
        let target_directory = canonical_directory(&requested_target, "HUD target")?;
        Ok(Self {
            source_directory,
            target_directory,
            backup: BackupManager::with_maximum_file_bytes(recovery_directory, MAXIMUM_FILE_BYTES)?,
        })
    }

    /// Atomically journals and installs every validated manifest file.
    ///
    /// # Errors
    ///
    /// Refuses invalid assets, pending recovery, hash drift, or publication failure.
    pub fn install(&self) -> PlatformResult<Uuid> {
        let publications = self.publications()?;
        let managed = publications
            .iter()
            .map(|(target, bytes)| ManagedFile::for_bytes(target, bytes))
            .collect::<Vec<_>>();
        let transaction = self.backup.prepare(&managed)?;
        for (target, bytes) in publications {
            atomic_write(&target, &bytes)?;
        }
        Ok(transaction)
    }

    /// Validates license declarations, file identities and recovery readiness
    /// without changing any managed target.
    ///
    /// # Errors
    ///
    /// Refuses invalid assets, hashes, licenses, limits, or pending recovery.
    pub fn preflight(&self) -> PlatformResult<usize> {
        if !matches!(self.backup.status()?, RecoveryStatus::Clean) {
            return Err(PlatformError::RecoveryPending);
        }
        self.publications().map(|files| files.len())
    }

    fn publications(&self) -> PlatformResult<Vec<(PathBuf, Vec<u8>)>> {
        let source_directory = canonical_directory(&self.source_directory, "HUD source")?;
        let manifest_path = source_directory.join(MANIFEST_NAME);
        let manifest_bytes = read_bounded(&manifest_path, 256 * 1024)?;
        let manifest: HudManifest = serde_json::from_slice(&manifest_bytes)?;
        if !matches!(
            manifest.license.as_str(),
            "CC0-1.0" | "MIT" | "Apache-2.0" | "UserOwned"
        ) {
            return Err(PlatformError::InvalidInput(
                "HUD manifest must declare CC0-1.0, MIT, Apache-2.0, or UserOwned".to_owned(),
            ));
        }
        if manifest.files.is_empty() || manifest.files.len() > MAXIMUM_FILES {
            return Err(PlatformError::InvalidInput(format!(
                "HUD manifest must contain 1..={MAXIMUM_FILES} files"
            )));
        }
        let mut total = 0_u64;
        let mut publications = Vec::with_capacity(manifest.files.len());
        for entry in manifest.files {
            validate_file_name(&entry.name)?;
            let source = source_directory.join(&entry.name);
            let bytes = read_bounded(&source, MAXIMUM_FILE_BYTES)?;
            total = total.saturating_add(bytes.len() as u64);
            if total > MAXIMUM_TOTAL_BYTES || sha256(&bytes) != entry.sha256.to_ascii_lowercase() {
                return Err(PlatformError::InvalidInput(
                    "HUD assets exceed the total limit or fail their manifest hash".to_owned(),
                ));
            }
            publications.push((self.target_directory.join(&entry.name), bytes));
        }
        Ok(publications)
    }

    /// Restores all verified pre-install files as one recovery transaction.
    ///
    /// # Errors
    ///
    /// Refuses missing/tampered backups or externally modified managed targets.
    pub fn restore(&self) -> PlatformResult<()> {
        self.backup.restore()
    }

    /// Reports whether an interrupted HUD transaction requires recovery.
    ///
    /// # Errors
    ///
    /// Returns an error when the recovery journal cannot be verified.
    pub fn status(&self) -> PlatformResult<RecoveryStatus> {
        self.backup.status()
    }
}

fn canonical_directory(path: &Path, label: &str) -> PlatformResult<PathBuf> {
    validate_absolute_directory_path(path, label)?;
    let metadata =
        fs::symlink_metadata(path).map_err(|error| io_error("reading directory", path, error))?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(PlatformError::InvalidInput(format!(
            "{label} must be a regular directory"
        )));
    }
    fs::canonicalize(path).map_err(|error| io_error("canonicalizing directory", path, error))
}

fn validate_absolute_directory_path(path: &Path, label: &str) -> PlatformResult<()> {
    if !path.is_absolute()
        || path
            .components()
            .any(|component| matches!(component, Component::ParentDir))
    {
        return Err(PlatformError::InvalidInput(format!(
            "{label} must be an absolute normalized path"
        )));
    }
    Ok(())
}

fn validate_file_name(name: &str) -> PlatformResult<()> {
    let path = Path::new(name);
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default();
    if name.is_empty()
        || name.len() > 128
        || path.file_name().and_then(|value| value.to_str()) != Some(name)
        || name.chars().any(char::is_control)
        || !matches!(
            extension.to_ascii_lowercase().as_str(),
            "res" | "vtex_c" | "png"
        )
    {
        return Err(PlatformError::InvalidInput(
            "HUD assets must be safe flat files with an allowed extension".to_owned(),
        ));
    }
    Ok(())
}

fn read_bounded(path: &Path, maximum: u64) -> PlatformResult<Vec<u8>> {
    let metadata = fs::symlink_metadata(path)
        .map_err(|error| io_error("reading HUD asset metadata", path, error))?;
    if metadata.file_type().is_symlink() || !metadata.is_file() || metadata.len() > maximum {
        return Err(PlatformError::InvalidInput(
            "HUD asset must be a bounded regular non-symlink file".to_owned(),
        ));
    }
    fs::read(path).map_err(|error| io_error("reading HUD asset", path, error))
}

fn sha256(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn installs_user_owned_assets_and_restores_previous_files() {
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("source");
        let target = root.path().join("target");
        fs::create_dir_all(&source).unwrap();
        fs::create_dir_all(&target).unwrap();
        fs::write(source.join("hud.res"), b"new").unwrap();
        fs::write(
            source.join(MANIFEST_NAME),
            format!(
                r#"{{"license":"UserOwned","files":[{{"name":"hud.res","sha256":"{}"}}]}}"#,
                sha256(b"new")
            ),
        )
        .unwrap();
        fs::write(target.join("hud.res"), b"old").unwrap();
        let installer =
            FirstPersonHudInstaller::new(&source, &target, root.path().join("recovery")).unwrap();
        installer.install().unwrap();
        assert_eq!(fs::read(target.join("hud.res")).unwrap(), b"new");
        fs::remove_dir_all(&source).unwrap();
        installer.restore().unwrap();
        assert_eq!(fs::read(target.join("hud.res")).unwrap(), b"old");
    }

    #[test]
    fn rejects_undeclared_or_hash_mismatched_assets() {
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("source");
        let target = root.path().join("target");
        fs::create_dir_all(&source).unwrap();
        fs::create_dir_all(&target).unwrap();
        fs::write(source.join("hud.res"), b"new").unwrap();
        fs::write(
            source.join(MANIFEST_NAME),
            r#"{"license":"Restricted","files":[{"name":"hud.res","sha256":"00"}]}"#,
        )
        .unwrap();
        let installer =
            FirstPersonHudInstaller::new(&source, &target, root.path().join("recovery")).unwrap();
        assert!(installer.install().is_err());
        assert!(!installer.backup.journal_path().exists());
    }
}
