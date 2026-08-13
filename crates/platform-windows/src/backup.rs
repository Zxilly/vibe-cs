use std::{
    collections::HashSet,
    fs::{self, File},
    io::Read,
    path::{Component, Path, PathBuf},
};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::{
    PlatformError, PlatformResult,
    fs_atomic::{atomic_write, atomic_write_new, remove_file_synced, write_new_synced},
    io_error,
};

const JOURNAL_FILE_NAME: &str = "managed-files.json";
const MAXIMUM_MANAGED_FILES: usize = 128;
const MAXIMUM_JOURNAL_BYTES: u64 = 256 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ManagedFile {
    pub target: PathBuf,
    pub replacement_sha256: String,
}

impl ManagedFile {
    #[must_use]
    pub fn for_bytes(target: impl Into<PathBuf>, replacement: &[u8]) -> Self {
        Self {
            target: target.into(),
            replacement_sha256: sha256(replacement),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RecoveryStatus {
    Clean,
    Pending {
        transaction_id: Uuid,
        restorable: bool,
        files: Vec<FileRecoveryStatus>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileRecoveryStatus {
    pub target: PathBuf,
    pub backup: BackupState,
    pub target_state: TargetState,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BackupState {
    NotRequired,
    Verified,
    Missing,
    Tampered,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TargetState {
    Original,
    Managed,
    Missing,
    Diverged,
}

#[derive(Debug, Clone)]
pub struct BackupManager {
    recovery_dir: PathBuf,
    maximum_file_bytes: u64,
}

impl BackupManager {
    /// Creates a manager whose journal and immutable backups live in one directory.
    ///
    /// # Errors
    ///
    /// Rejects relative paths and files in place of the recovery directory.
    pub fn new(recovery_dir: impl Into<PathBuf>) -> PlatformResult<Self> {
        Self::with_maximum_file_bytes(recovery_dir, 1024 * 1024)
    }

    /// Creates a manager with an explicit per-file read and backup limit.
    ///
    /// # Errors
    ///
    /// Rejects invalid directories and a zero byte limit.
    pub fn with_maximum_file_bytes(
        recovery_dir: impl Into<PathBuf>,
        maximum_file_bytes: u64,
    ) -> PlatformResult<Self> {
        let recovery_dir = recovery_dir.into();
        validate_absolute_path(&recovery_dir)?;
        if maximum_file_bytes == 0 {
            return Err(PlatformError::InvalidInput(
                "maximum backup file size must be positive".to_owned(),
            ));
        }
        fs::create_dir_all(&recovery_dir)
            .map_err(|error| io_error("creating recovery directory", &recovery_dir, error))?;
        if !recovery_dir.is_dir() {
            return Err(PlatformError::InvalidInput(
                "recovery path must be a directory".to_owned(),
            ));
        }
        Ok(Self {
            recovery_dir,
            maximum_file_bytes,
        })
    }

    #[must_use]
    pub fn journal_path(&self) -> PathBuf {
        self.recovery_dir.join(JOURNAL_FILE_NAME)
    }

    /// Snapshots every existing target and atomically publishes one journal.
    ///
    /// Call this before writing managed contents. Existing backups are never
    /// overwritten, and a pending transaction must be recovered first.
    ///
    /// # Errors
    ///
    /// Returns an integrity or I/O error without modifying any target file.
    pub fn prepare(&self, managed: &[ManagedFile]) -> PlatformResult<Uuid> {
        if self
            .journal_path()
            .try_exists()
            .map_err(|error| io_error("checking recovery journal", self.journal_path(), error))?
        {
            return Err(PlatformError::RecoveryPending);
        }
        validate_managed_files(managed)?;

        let transaction_id = Uuid::new_v4();
        let mut entries = Vec::with_capacity(managed.len());
        let mut created_backups = Vec::new();
        let result = (|| {
            for (index, file) in managed.iter().enumerate() {
                let backup_name = backup_name(index, &file.target);
                let backup_path = self.recovery_dir.join(&backup_name);
                let original = if file
                    .target
                    .try_exists()
                    .map_err(|error| io_error("checking managed file", &file.target, error))?
                {
                    let bytes = read_bounded_file(&file.target, self.maximum_file_bytes)?;
                    let original_sha256 = sha256(&bytes);
                    write_new_synced(&backup_path, &bytes).map_err(|error| {
                        PlatformError::BackupIntegrity {
                            path: backup_path.clone(),
                            reason: format!("refusing to replace an existing backup: {error}"),
                        }
                    })?;
                    created_backups.push(backup_path.clone());
                    let verified = read_bounded_file(&backup_path, self.maximum_file_bytes)?;
                    if sha256(&verified) != original_sha256 {
                        return Err(PlatformError::BackupIntegrity {
                            path: backup_path,
                            reason: "backup hash changed immediately after synchronization"
                                .to_owned(),
                        });
                    }
                    OriginalState::Present {
                        sha256: original_sha256,
                        size: u64::try_from(bytes.len()).map_err(|_| {
                            PlatformError::InvalidInput("managed file is too large".to_owned())
                        })?,
                        backup_name: Some(backup_name),
                    }
                } else {
                    OriginalState::Absent
                };
                entries.push(JournalEntry {
                    target: file.target.clone(),
                    replacement_sha256: file.replacement_sha256.clone(),
                    original,
                });
            }
            let journal = Journal {
                transaction_id,
                entries,
            };
            let bytes = serde_json::to_vec_pretty(&journal)?;
            atomic_write_new(&self.journal_path(), &bytes)?;
            Ok(transaction_id)
        })();
        if result.is_err() {
            for backup in created_backups {
                let _ = fs::remove_file(backup);
            }
        }
        result
    }

    /// Inspects a pending transaction without mutating managed files.
    ///
    /// # Errors
    ///
    /// Returns an error when the journal itself is invalid or unreadable.
    pub fn status(&self) -> PlatformResult<RecoveryStatus> {
        let Some(journal) = self.load_journal()? else {
            return Ok(RecoveryStatus::Clean);
        };
        let mut files = Vec::with_capacity(journal.entries.len());
        let mut restorable = true;
        for (index, entry) in journal.entries.iter().enumerate() {
            let backup = self.backup_state(index, entry);
            let target_state = self.target_state(entry)?;
            let target_is_safe = match &entry.original {
                OriginalState::Present { .. } => matches!(
                    target_state,
                    TargetState::Original | TargetState::Managed | TargetState::Missing
                ),
                OriginalState::Absent => {
                    matches!(target_state, TargetState::Managed | TargetState::Missing)
                }
            };
            restorable &=
                !matches!(backup, BackupState::Missing | BackupState::Tampered) && target_is_safe;
            files.push(FileRecoveryStatus {
                target: entry.target.clone(),
                backup,
                target_state,
            });
        }
        Ok(RecoveryStatus::Pending {
            transaction_id: journal.transaction_id,
            restorable,
            files,
        })
    }

    /// Restores all targets only after every backup and current target passes
    /// a full preflight. A third-party edit aborts the entire recovery.
    ///
    /// # Errors
    ///
    /// Returns an integrity or conflict error before changing any target.
    pub fn restore(&self) -> PlatformResult<()> {
        let journal = self
            .load_journal()?
            .ok_or(PlatformError::RecoveryNotPending)?;
        let mut actions = Vec::with_capacity(journal.entries.len());
        for (index, entry) in journal.entries.iter().enumerate() {
            let observed = optional_file_hash(&entry.target, self.maximum_file_bytes)?;
            match &entry.original {
                OriginalState::Present {
                    sha256: original_sha256,
                    size,
                    backup_name: Some(recorded_name),
                } => {
                    let expected_name = backup_name(index, &entry.target);
                    if recorded_name != &expected_name {
                        return Err(PlatformError::BackupIntegrity {
                            path: self.recovery_dir.join(recorded_name),
                            reason: "journal backup name does not match its target".to_owned(),
                        });
                    }
                    let backup_path = self.recovery_dir.join(&expected_name);
                    let bytes = read_bounded_file(&backup_path, self.maximum_file_bytes)?;
                    if u64::try_from(bytes.len()).ok() != Some(*size)
                        || sha256(&bytes) != *original_sha256
                    {
                        return Err(PlatformError::BackupIntegrity {
                            path: backup_path,
                            reason: "backup size or SHA-256 does not match the journal".to_owned(),
                        });
                    }
                    if observed.as_deref().is_some_and(|hash| {
                        hash != original_sha256 && hash != entry.replacement_sha256
                    }) {
                        return Err(PlatformError::RecoveryConflict {
                            path: entry.target.clone(),
                            reason: "target contains data not owned by this transaction".to_owned(),
                        });
                    }
                    let already_original = observed.as_deref() == Some(original_sha256.as_str());
                    actions.push(RestoreAction {
                        target: entry.target.clone(),
                        observed,
                        operation: if already_original {
                            RestoreOperation::None
                        } else {
                            RestoreOperation::Write(bytes)
                        },
                    });
                }
                OriginalState::Absent => {
                    if observed
                        .as_deref()
                        .is_some_and(|hash| hash != entry.replacement_sha256)
                    {
                        return Err(PlatformError::RecoveryConflict {
                            path: entry.target.clone(),
                            reason: "target contains data not owned by this transaction".to_owned(),
                        });
                    }
                    actions.push(RestoreAction {
                        target: entry.target.clone(),
                        operation: if observed.is_some() {
                            RestoreOperation::Remove
                        } else {
                            RestoreOperation::None
                        },
                        observed,
                    });
                }
                OriginalState::Present {
                    backup_name: None, ..
                } => {
                    return Err(PlatformError::BackupIntegrity {
                        path: self.journal_path(),
                        reason: "journal omits the backup for an existing target".to_owned(),
                    });
                }
            }
        }

        // Recheck every target before the first mutation so a stale preflight
        // cannot silently overwrite a file changed by another process.
        for action in &actions {
            let current = optional_file_hash(&action.target, self.maximum_file_bytes)?;
            if current != action.observed {
                return Err(PlatformError::RecoveryConflict {
                    path: action.target.clone(),
                    reason: "target changed during recovery preflight".to_owned(),
                });
            }
        }
        for action in actions {
            match action.operation {
                RestoreOperation::None => {}
                RestoreOperation::Write(bytes) => atomic_write(&action.target, &bytes)?,
                RestoreOperation::Remove => remove_file_synced(&action.target)?,
            }
        }
        self.verify_restored(&journal)?;

        // Removing the journal commits recovery. Backup cleanup afterward is
        // best-effort: an orphan is safe, while a journal without its backup is not.
        remove_file_synced(&self.journal_path())?;
        for (index, entry) in journal.entries.iter().enumerate() {
            if matches!(entry.original, OriginalState::Present { .. }) {
                let _ = fs::remove_file(self.recovery_dir.join(backup_name(index, &entry.target)));
            }
        }
        Ok(())
    }

    fn load_journal(&self) -> PlatformResult<Option<Journal>> {
        let path = self.journal_path();
        if !path
            .try_exists()
            .map_err(|error| io_error("checking recovery journal", &path, error))?
        {
            return Ok(None);
        }
        let bytes = read_bounded_file(&path, MAXIMUM_JOURNAL_BYTES)?;
        let journal: Journal = serde_json::from_slice(&bytes)?;
        if journal.entries.is_empty() || journal.entries.len() > MAXIMUM_MANAGED_FILES {
            return Err(PlatformError::BackupIntegrity {
                path,
                reason: "journal entry count is invalid".to_owned(),
            });
        }
        let managed = journal
            .entries
            .iter()
            .map(|entry| ManagedFile {
                target: entry.target.clone(),
                replacement_sha256: entry.replacement_sha256.clone(),
            })
            .collect::<Vec<_>>();
        validate_managed_files(&managed)?;
        Ok(Some(journal))
    }

    fn backup_state(&self, index: usize, entry: &JournalEntry) -> BackupState {
        let OriginalState::Present {
            sha256: expected_hash,
            size,
            backup_name: Some(recorded_name),
        } = &entry.original
        else {
            return if matches!(entry.original, OriginalState::Absent) {
                BackupState::NotRequired
            } else {
                BackupState::Tampered
            };
        };
        let expected_name = backup_name(index, &entry.target);
        if recorded_name != &expected_name {
            return BackupState::Tampered;
        }
        let path = self.recovery_dir.join(expected_name);
        match read_bounded_file(&path, self.maximum_file_bytes) {
            Ok(bytes)
                if u64::try_from(bytes.len()).ok() == Some(*size)
                    && sha256(&bytes) == *expected_hash =>
            {
                BackupState::Verified
            }
            Err(PlatformError::Io { source, .. })
                if source.kind() == std::io::ErrorKind::NotFound =>
            {
                BackupState::Missing
            }
            Ok(_) | Err(_) => BackupState::Tampered,
        }
    }

    fn target_state(&self, entry: &JournalEntry) -> PlatformResult<TargetState> {
        let Some(hash) = optional_file_hash(&entry.target, self.maximum_file_bytes)? else {
            return Ok(TargetState::Missing);
        };
        if let OriginalState::Present {
            sha256: original, ..
        } = &entry.original
            && hash == *original
        {
            return Ok(TargetState::Original);
        }
        if hash == entry.replacement_sha256 {
            Ok(TargetState::Managed)
        } else {
            Ok(TargetState::Diverged)
        }
    }

    fn verify_restored(&self, journal: &Journal) -> PlatformResult<()> {
        for entry in &journal.entries {
            let current = optional_file_hash(&entry.target, self.maximum_file_bytes)?;
            let valid = match &entry.original {
                OriginalState::Absent => current.is_none(),
                OriginalState::Present { sha256, .. } => current.as_deref() == Some(sha256),
            };
            if !valid {
                return Err(PlatformError::RecoveryConflict {
                    path: entry.target.clone(),
                    reason: "restored target failed final verification".to_owned(),
                });
            }
        }
        Ok(())
    }
}

#[derive(Debug)]
struct RestoreAction {
    target: PathBuf,
    observed: Option<String>,
    operation: RestoreOperation,
}

#[derive(Debug)]
enum RestoreOperation {
    None,
    Write(Vec<u8>),
    Remove,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Journal {
    transaction_id: Uuid,
    entries: Vec<JournalEntry>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct JournalEntry {
    target: PathBuf,
    replacement_sha256: String,
    original: OriginalState,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "state", rename_all = "snake_case", deny_unknown_fields)]
enum OriginalState {
    Absent,
    Present {
        sha256: String,
        size: u64,
        backup_name: Option<String>,
    },
}

fn validate_managed_files(managed: &[ManagedFile]) -> PlatformResult<()> {
    if managed.is_empty() || managed.len() > MAXIMUM_MANAGED_FILES {
        return Err(PlatformError::InvalidInput(format!(
            "managed file collection must contain 1..={MAXIMUM_MANAGED_FILES} entries"
        )));
    }
    let mut paths = HashSet::with_capacity(managed.len());
    for file in managed {
        validate_absolute_path(&file.target)?;
        let parent = file.target.parent().ok_or_else(|| {
            PlatformError::InvalidInput("managed target has no parent directory".to_owned())
        })?;
        if !parent.is_dir() {
            return Err(PlatformError::InvalidInput(
                "managed target parent must be an existing directory".to_owned(),
            ));
        }
        if !is_sha256(&file.replacement_sha256) {
            return Err(PlatformError::InvalidInput(
                "replacement SHA-256 must be 64 lowercase hexadecimal characters".to_owned(),
            ));
        }
        let key = normalized_path_key(&file.target)?;
        if !paths.insert(key) {
            return Err(PlatformError::InvalidInput(
                "managed file collection contains duplicate targets".to_owned(),
            ));
        }
    }
    Ok(())
}

fn validate_absolute_path(path: &Path) -> PlatformResult<()> {
    if !path.is_absolute()
        || path.file_name().is_none()
        || path
            .components()
            .any(|component| matches!(component, Component::ParentDir | Component::CurDir))
    {
        return Err(PlatformError::InvalidInput(
            "managed paths must be absolute, normalized, and named".to_owned(),
        ));
    }
    let text = path.to_str().ok_or_else(|| {
        PlatformError::InvalidInput("managed path is not valid Unicode".to_owned())
    })?;
    if text.chars().any(char::is_control) {
        return Err(PlatformError::InvalidInput(
            "managed path contains control characters".to_owned(),
        ));
    }
    Ok(())
}

fn normalized_path_key(path: &Path) -> PlatformResult<String> {
    let text = path.to_str().ok_or_else(|| {
        PlatformError::InvalidInput("managed path is not valid Unicode".to_owned())
    })?;
    Ok(if cfg!(windows) {
        text.to_lowercase()
    } else {
        text.to_owned()
    })
}

fn backup_name(index: usize, target: &Path) -> String {
    let path_hash = sha256(target.to_string_lossy().as_bytes());
    format!("{index:04}-{path_hash}.backup")
}

fn optional_file_hash(path: &Path, maximum_bytes: u64) -> PlatformResult<Option<String>> {
    match path.try_exists() {
        Ok(false) => Ok(None),
        Ok(true) => read_bounded_file(path, maximum_bytes).map(|bytes| Some(sha256(&bytes))),
        Err(error) => Err(io_error("checking managed file", path, error)),
    }
}

fn read_bounded_file(path: &Path, maximum_bytes: u64) -> PlatformResult<Vec<u8>> {
    let metadata = fs::symlink_metadata(path)
        .map_err(|error| io_error("reading file metadata", path, error))?;
    if !metadata.file_type().is_file() || metadata.file_type().is_symlink() {
        return Err(PlatformError::BackupIntegrity {
            path: path.to_path_buf(),
            reason: "path is not a regular non-symlink file".to_owned(),
        });
    }
    if metadata.len() > maximum_bytes {
        return Err(PlatformError::BackupIntegrity {
            path: path.to_path_buf(),
            reason: format!("file exceeds the {maximum_bytes}-byte safety limit"),
        });
    }
    let file = File::open(path).map_err(|error| io_error("opening file", path, error))?;
    let mut bytes = Vec::with_capacity(usize::try_from(metadata.len()).unwrap_or(0));
    file.take(maximum_bytes.saturating_add(1))
        .read_to_end(&mut bytes)
        .map_err(|error| io_error("reading file", path, error))?;
    if u64::try_from(bytes.len()).unwrap_or(u64::MAX) > maximum_bytes {
        return Err(PlatformError::BackupIntegrity {
            path: path.to_path_buf(),
            reason: format!("file exceeds the {maximum_bytes}-byte safety limit"),
        });
    }
    Ok(bytes)
}

fn sha256(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

fn is_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn manager(root: &Path) -> BackupManager {
        BackupManager::new(root.join("recovery")).unwrap()
    }

    #[test]
    fn restores_a_file_collection_including_an_originally_absent_file() {
        let root = tempfile::tempdir().unwrap();
        let first = root.path().join("first.cfg");
        let second = root.path().join("second.cfg");
        fs::write(&first, b"original").unwrap();
        let replacement = b"managed";
        let manager = manager(root.path());
        manager
            .prepare(&[
                ManagedFile::for_bytes(&first, replacement),
                ManagedFile::for_bytes(&second, replacement),
            ])
            .unwrap();
        fs::write(&first, replacement).unwrap();
        fs::write(&second, replacement).unwrap();

        assert!(matches!(
            manager.status().unwrap(),
            RecoveryStatus::Pending {
                restorable: true,
                ..
            }
        ));
        manager.restore().unwrap();
        assert_eq!(fs::read(first).unwrap(), b"original");
        assert!(!second.exists());
        assert_eq!(manager.status().unwrap(), RecoveryStatus::Clean);
    }

    #[test]
    fn tampered_backup_blocks_all_restore_writes() {
        let root = tempfile::tempdir().unwrap();
        let first = root.path().join("first.cfg");
        let second = root.path().join("second.cfg");
        fs::write(&first, b"first-original").unwrap();
        fs::write(&second, b"second-original").unwrap();
        let replacement = b"managed";
        let manager = manager(root.path());
        manager
            .prepare(&[
                ManagedFile::for_bytes(&first, replacement),
                ManagedFile::for_bytes(&second, replacement),
            ])
            .unwrap();
        fs::write(&first, replacement).unwrap();
        fs::write(&second, replacement).unwrap();
        let backup = fs::read_dir(root.path().join("recovery"))
            .unwrap()
            .filter_map(Result::ok)
            .map(|entry| entry.path())
            .find(|path| {
                path.extension()
                    .is_some_and(|extension| extension == "backup")
            })
            .unwrap();
        fs::write(backup, b"tampered").unwrap();

        assert!(matches!(
            manager.status().unwrap(),
            RecoveryStatus::Pending {
                restorable: false,
                ..
            }
        ));
        assert!(matches!(
            manager.restore(),
            Err(PlatformError::BackupIntegrity { .. })
        ));
        assert_eq!(fs::read(first).unwrap(), replacement);
        assert_eq!(fs::read(second).unwrap(), replacement);
    }

    #[test]
    fn third_party_target_edit_blocks_collection_restore() {
        let root = tempfile::tempdir().unwrap();
        let first = root.path().join("first.cfg");
        let second = root.path().join("second.cfg");
        fs::write(&first, b"first-original").unwrap();
        fs::write(&second, b"second-original").unwrap();
        let replacement = b"managed";
        let manager = manager(root.path());
        manager
            .prepare(&[
                ManagedFile::for_bytes(&first, replacement),
                ManagedFile::for_bytes(&second, replacement),
            ])
            .unwrap();
        fs::write(&first, replacement).unwrap();
        fs::write(&second, b"external-edit").unwrap();

        assert!(matches!(
            manager.restore(),
            Err(PlatformError::RecoveryConflict { .. })
        ));
        assert_eq!(fs::read(first).unwrap(), replacement);
        assert_eq!(fs::read(second).unwrap(), b"external-edit");
    }

    #[test]
    fn prepare_exposes_crash_recovery_status_before_managed_write() {
        let root = tempfile::tempdir().unwrap();
        let target = root.path().join("config.cfg");
        fs::write(&target, b"original").unwrap();
        let manager = manager(root.path());
        manager
            .prepare(&[ManagedFile::for_bytes(&target, b"managed")])
            .unwrap();

        assert!(matches!(
            manager.status().unwrap(),
            RecoveryStatus::Pending {
                restorable: true,
                files,
                ..
            } if files[0].target_state == TargetState::Original
        ));
        manager.restore().unwrap();
    }

    #[test]
    fn prepare_rejects_control_bearing_target_paths() {
        let root = tempfile::tempdir().unwrap();
        let target = root.path().join("unsafe\nconfig.cfg");
        let manager = manager(root.path());
        assert!(matches!(
            manager.prepare(&[ManagedFile::for_bytes(target, b"managed")]),
            Err(PlatformError::InvalidInput(_))
        ));
        assert_eq!(manager.status().unwrap(), RecoveryStatus::Clean);
    }

    #[test]
    fn prepare_never_overwrites_a_preexisting_backup() {
        let root = tempfile::tempdir().unwrap();
        let target = root.path().join("config.cfg");
        fs::write(&target, b"original").unwrap();
        let manager = manager(root.path());
        let backup = root.path().join("recovery").join(backup_name(0, &target));
        fs::write(&backup, b"do-not-overwrite").unwrap();

        assert!(matches!(
            manager.prepare(&[ManagedFile::for_bytes(&target, b"managed")]),
            Err(PlatformError::BackupIntegrity { .. })
        ));
        assert_eq!(fs::read(backup).unwrap(), b"do-not-overwrite");
        assert_eq!(fs::read(target).unwrap(), b"original");
    }
}
