use std::{
    fs::{self, OpenOptions},
    io::{self, Read, Write},
    path::{Path, PathBuf},
    time::Duration,
};

use cap_std::{ambient_authority, fs::Dir};
use rusqlite::{Connection, OpenFlags, backup::Backup};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use thiserror::Error;
use uuid::Uuid;
use walkdir::WalkDir;

const MAXIMUM_CACHE_ENTRIES: usize = 128;
const MAXIMUM_CACHE_BYTES: u64 = 512 * 1024 * 1024;
const MAXIMUM_MANAGED_FILES: usize = 100_000;
const MAXIMUM_MANAGED_BYTES: u64 = 512 * 1024 * 1024 * 1024;
const MAXIMUM_JOURNAL_BYTES: u64 = 64 * 1024;
const STAGE_PREFIX: &str = ".previous-data-import-";
const JOURNAL_NAME: &str = "publication.json";
const MANAGED_DIRECTORIES: &[&str] = &[
    "recordings",
    "exports",
    "uploads",
    "package-uploads",
    "packages",
    "portable-assets",
    "proxies",
    "cosmetics",
    "downloads",
    "avatar-cache",
    "playback-cache",
    "replay-cache",
    "worker-tasks",
    "recovery",
    "obs-backups",
];

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PreviousDataImport {
    pub database_imported: bool,
    pub cache_files_imported: usize,
    pub cache_bytes_imported: u64,
    pub managed_files_imported: usize,
    pub managed_bytes_imported: u64,
}

#[derive(Debug, Error)]
pub enum PreviousDataImportError {
    #[error("previous and target data directories must be absolute, distinct directories")]
    InvalidDirectories,
    #[error("the target database already exists; existing data is never overwritten")]
    TargetAlreadyInitialized,
    #[error("a supported database was not found in the previous data directory")]
    DatabaseNotFound,
    #[error("previous data contains an unsafe symbolic link or non-regular cache entry")]
    UnsafeEntry,
    #[error("previous managed files exceed the bounded migration limit")]
    ManagedFileLimitExceeded,
    #[error("migration filesystem operation failed: {0}")]
    Io(#[from] io::Error),
    #[error("migration database snapshot failed: {0}")]
    Database(#[from] rusqlite::Error),
    #[error("stored migration document is invalid: {0}")]
    Serialization(#[from] serde_json::Error),
    #[error("an interrupted previous-data import could not be resumed safely")]
    InvalidJournal,
}

#[derive(Debug, Serialize, Deserialize)]
struct PublicationJournal {
    schema_version: u32,
    previous: PathBuf,
    target: PathBuf,
    directories: Vec<String>,
    report: PreviousDataImport,
}

/// Imports a consistent database snapshot and compatible replay-cache entries before startup.
///
/// The operation never replaces an existing target database. Files are staged below the target
/// directory, publication progress is recoverable, and the database is published last.
///
/// # Errors
///
/// Returns an error when the directory boundary is unsafe, the target is already initialized,
/// the source database cannot be snapshotted, or the bounded cache copy cannot be completed.
pub fn import_previous_data_directory(
    previous: &Path,
    target: &Path,
) -> Result<PreviousDataImport, PreviousDataImportError> {
    if !previous.is_absolute() || !target.is_absolute() {
        return Err(PreviousDataImportError::InvalidDirectories);
    }
    let previous = previous.canonicalize()?;
    fs::create_dir_all(target)?;
    let target = target.canonicalize()?;
    if previous == target || target.starts_with(&previous) || previous.starts_with(&target) {
        return Err(PreviousDataImportError::InvalidDirectories);
    }
    let target_database = target.join("vibe-cs.db");
    if target_database.exists() {
        return Err(PreviousDataImportError::TargetAlreadyInitialized);
    }
    if let Some((stage, journal)) = recoverable_publication(&target, &previous)? {
        publish_stage(&stage, &target, &target_database, &journal.directories)?;
        remove_stage(&stage);
        return Ok(journal.report);
    }
    let source_database = [previous.join("vibe-cs.db"), previous.join("app.db")]
        .into_iter()
        .find(|path| path.is_file())
        .ok_or(PreviousDataImportError::DatabaseNotFound)?;
    if fs::symlink_metadata(&source_database)?
        .file_type()
        .is_symlink()
    {
        return Err(PreviousDataImportError::UnsafeEntry);
    }

    let stage = target.join(format!("{STAGE_PREFIX}{}", Uuid::new_v4()));
    fs::create_dir(&stage)?;
    let report = match import_into_stage(&source_database, &previous, &target, &stage) {
        Ok(report) => report,
        Err(error) => {
            remove_stage(&stage);
            return Err(error);
        }
    };
    let directories = MANAGED_DIRECTORIES
        .iter()
        .filter(|name| stage.join(name).exists())
        .map(|name| (*name).to_owned())
        .collect::<Vec<_>>();
    let journal = PublicationJournal {
        schema_version: 1,
        previous,
        target: target.clone(),
        directories,
        report: report.clone(),
    };
    if let Err(error) = write_journal(&stage, &journal) {
        remove_stage(&stage);
        return Err(error);
    }
    publish_stage(&stage, &target, &target_database, &journal.directories)?;
    remove_stage(&stage);
    Ok(report)
}

fn remove_stage(stage: &Path) {
    if let Err(error) = fs::remove_dir_all(stage)
        && error.kind() != io::ErrorKind::NotFound
    {
        tracing::warn!(%error, path = %stage.display(), "previous data import staging cleanup failed");
    }
}

fn write_journal(
    stage: &Path,
    journal: &PublicationJournal,
) -> Result<(), PreviousDataImportError> {
    let encoded = serde_json::to_vec(journal)?;
    if encoded.len() as u64 > MAXIMUM_JOURNAL_BYTES {
        return Err(PreviousDataImportError::InvalidJournal);
    }
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(stage.join(JOURNAL_NAME))?;
    file.write_all(&encoded)?;
    file.sync_all()?;
    Ok(())
}

fn recoverable_publication(
    target: &Path,
    previous: &Path,
) -> Result<Option<(PathBuf, PublicationJournal)>, PreviousDataImportError> {
    let mut recovery = None;
    for entry in fs::read_dir(target)? {
        let entry = entry?;
        let name = entry.file_name();
        if !name.to_string_lossy().starts_with(STAGE_PREFIX) {
            continue;
        }
        let metadata = fs::symlink_metadata(entry.path())?;
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            return Err(PreviousDataImportError::InvalidJournal);
        }
        let journal_path = entry.path().join(JOURNAL_NAME);
        if !journal_path.exists() {
            continue;
        }
        if recovery.is_some() {
            return Err(PreviousDataImportError::InvalidJournal);
        }
        let journal_metadata = fs::symlink_metadata(&journal_path)?;
        if journal_metadata.file_type().is_symlink()
            || !journal_metadata.is_file()
            || journal_metadata.len() > MAXIMUM_JOURNAL_BYTES
        {
            return Err(PreviousDataImportError::InvalidJournal);
        }
        let journal = serde_json::from_slice::<PublicationJournal>(&fs::read(&journal_path)?)?;
        let valid_directories = journal.directories.len() <= MANAGED_DIRECTORIES.len()
            && journal
                .directories
                .iter()
                .all(|name| MANAGED_DIRECTORIES.contains(&name.as_str()))
            && {
                let mut unique = journal.directories.clone();
                unique.sort_unstable();
                unique.dedup();
                unique.len() == journal.directories.len()
            };
        if journal.schema_version != 1
            || journal.previous != previous
            || journal.target != target
            || !valid_directories
            || !entry.path().join("vibe-cs.db").is_file()
        {
            return Err(PreviousDataImportError::InvalidJournal);
        }
        recovery = Some((entry.path(), journal));
    }
    Ok(recovery)
}

fn import_into_stage(
    source_database: &Path,
    previous: &Path,
    target: &Path,
    stage: &Path,
) -> Result<PreviousDataImport, PreviousDataImportError> {
    let source = Connection::open_with_flags(
        source_database,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    let mut destination = Connection::open(stage.join("vibe-cs.db"))?;
    let backup = Backup::new(&source, &mut destination)?;
    backup.run_to_completion(128, Duration::from_millis(20), None)?;
    drop(backup);
    remap_database_paths(&mut destination, previous, target)?;
    destination.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);")?;
    drop(destination);

    let mut managed_files_imported = 0_usize;
    let mut managed_bytes_imported = 0_u64;
    let mut cache_files_imported = 0_usize;
    let mut cache_bytes_imported = 0_u64;
    for name in MANAGED_DIRECTORIES {
        let source = previous.join(name);
        if !source.exists() {
            continue;
        }
        let (files, bytes) = copy_bounded_tree(
            &source,
            &stage.join(name),
            MAXIMUM_MANAGED_FILES.saturating_sub(managed_files_imported),
            MAXIMUM_MANAGED_BYTES.saturating_sub(managed_bytes_imported),
        )?;
        managed_files_imported = managed_files_imported.saturating_add(files);
        managed_bytes_imported = managed_bytes_imported.saturating_add(bytes);
        if *name == "replay-cache" {
            cache_files_imported = files;
            cache_bytes_imported = bytes;
        }
    }
    Ok(PreviousDataImport {
        database_imported: true,
        cache_files_imported,
        cache_bytes_imported,
        managed_files_imported,
        managed_bytes_imported,
    })
}

fn copy_bounded_tree(
    source: &Path,
    destination: &Path,
    maximum_files: usize,
    maximum_bytes: u64,
) -> Result<(usize, u64), PreviousDataImportError> {
    if fs::symlink_metadata(source)?.file_type().is_symlink() || !source.is_dir() {
        return Err(PreviousDataImportError::UnsafeEntry);
    }
    let source_directory = Dir::open_ambient_dir(source, ambient_authority())?;
    fs::create_dir(destination)?;
    let mut files = 0_usize;
    let mut bytes = 0_u64;
    for entry in WalkDir::new(source).follow_links(false).max_depth(32) {
        let entry = entry.map_err(|error| io::Error::other(error.to_string()))?;
        if entry.path() == source {
            continue;
        }
        let relative = entry
            .path()
            .strip_prefix(source)
            .map_err(|_| PreviousDataImportError::UnsafeEntry)?;
        let metadata = source_directory.symlink_metadata(relative)?;
        if metadata.file_type().is_symlink()
            || capability_metadata_is_reparse(&metadata)
            || (!metadata.is_dir() && !metadata.is_file())
        {
            return Err(PreviousDataImportError::UnsafeEntry);
        }
        let output = destination.join(relative);
        if metadata.is_dir() {
            fs::create_dir(&output)?;
            continue;
        }
        let input = source_directory.open(relative)?;
        let opened_metadata = input.metadata()?;
        let current_metadata = source_directory.symlink_metadata(relative)?;
        if !opened_metadata.is_file()
            || capability_metadata_is_reparse(&opened_metadata)
            || current_metadata.file_type().is_symlink()
            || capability_metadata_is_reparse(&current_metadata)
            || opened_metadata.len() != metadata.len()
            || current_metadata.len() != metadata.len()
        {
            return Err(PreviousDataImportError::UnsafeEntry);
        }
        let replay_cache = source
            .file_name()
            .is_some_and(|name| name == "replay-cache");
        let file_limit = if replay_cache {
            MAXIMUM_CACHE_ENTRIES.min(maximum_files)
        } else {
            maximum_files
        };
        let byte_limit = if replay_cache {
            MAXIMUM_CACHE_BYTES.min(maximum_bytes)
        } else {
            maximum_bytes
        };
        let next_files = files.saturating_add(1);
        let remaining_bytes = byte_limit.saturating_sub(bytes);
        if next_files > file_limit || metadata.len() > remaining_bytes {
            return Err(PreviousDataImportError::ManagedFileLimitExceeded);
        }
        let mut output_file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&output)?;
        let copied = io::copy(
            &mut input.take(metadata.len().saturating_add(1)),
            &mut output_file,
        )?;
        if copied != metadata.len() {
            drop(output_file);
            let _ = fs::remove_file(&output);
            return Err(if copied > remaining_bytes {
                PreviousDataImportError::ManagedFileLimitExceeded
            } else {
                PreviousDataImportError::UnsafeEntry
            });
        }
        output_file.sync_all()?;
        files = next_files;
        bytes = bytes.saturating_add(copied);
    }
    Ok((files, bytes))
}

#[cfg(windows)]
fn capability_metadata_is_reparse(metadata: &cap_std::fs::Metadata) -> bool {
    use cap_std::fs::MetadataExt as _;

    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
    metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
}

#[cfg(not(windows))]
fn capability_metadata_is_reparse(_metadata: &cap_std::fs::Metadata) -> bool {
    false
}

fn publish_stage(
    stage: &Path,
    target: &Path,
    target_database: &Path,
    directories: &[String],
) -> Result<(), PreviousDataImportError> {
    let mut published: Vec<std::path::PathBuf> = Vec::new();
    for name in directories {
        let source = stage.join(name);
        let destination = target.join(name);
        if !source.exists() && destination.is_dir() {
            published.push(destination);
            continue;
        }
        if !source.is_dir() || destination.exists() {
            rollback_publication(stage, &published);
            return Err(PreviousDataImportError::TargetAlreadyInitialized);
        }
        if let Err(error) = fs::rename(&source, &destination) {
            rollback_publication(stage, &published);
            return Err(error.into());
        }
        published.push(destination);
    }
    if target_database.exists() || !stage.join("vibe-cs.db").is_file() {
        rollback_publication(stage, &published);
        return Err(PreviousDataImportError::TargetAlreadyInitialized);
    }
    if let Err(error) = fs::rename(stage.join("vibe-cs.db"), target_database) {
        rollback_publication(stage, &published);
        return Err(error.into());
    }
    Ok(())
}

fn rollback_publication(stage: &Path, published: &[PathBuf]) {
    for directory in published.iter().rev() {
        let Some(name) = directory.file_name() else {
            continue;
        };
        if stage.join(name).exists() {
            continue;
        }
        if let Err(error) = fs::rename(directory, stage.join(name)) {
            tracing::error!(%error, path = %directory.display(), "managed migration rollback failed");
        }
    }
}

fn remap_database_paths(
    connection: &mut Connection,
    previous: &Path,
    target: &Path,
) -> Result<(), PreviousDataImportError> {
    let tables = {
        let mut statement = connection.prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
        )?;
        statement
            .query_map([], |row| row.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?
    };
    let transaction = connection.transaction()?;
    for table in tables.into_iter().filter(|table| safe_identifier(table)) {
        let columns = {
            let mut statement = transaction.prepare(&format!("PRAGMA table_info(\"{table}\")"))?;
            statement
                .query_map([], |row| row.get::<_, String>(1))?
                .collect::<Result<Vec<_>, _>>()?
        };
        if columns.iter().any(|column| column == "document_json") {
            let rows = {
                let mut statement = transaction
                    .prepare(&format!("SELECT rowid, document_json FROM \"{table}\""))?;
                statement
                    .query_map([], |row| {
                        Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
                    })?
                    .collect::<Result<Vec<_>, _>>()?
            };
            for (row_id, encoded) in rows {
                let mut document = serde_json::from_str::<Value>(&encoded)?;
                if remap_known_document_paths(&table, &mut document, previous, target) {
                    transaction.execute(
                        &format!("UPDATE \"{table}\" SET document_json = ?1 WHERE rowid = ?2"),
                        rusqlite::params![serde_json::to_string(&document)?, row_id],
                    )?;
                }
            }
        }
        if matches!(table.as_str(), "demos" | "recorded_clips" | "media_assets")
            && columns.iter().any(|column| column == "path")
        {
            let rows = {
                let mut statement =
                    transaction.prepare(&format!("SELECT rowid, path FROM \"{table}\""))?;
                statement
                    .query_map([], |row| {
                        Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
                    })?
                    .collect::<Result<Vec<_>, _>>()?
            };
            for (row_id, path) in rows {
                if let Some(remapped) = remap_path(&path, previous, target) {
                    transaction.execute(
                        &format!("UPDATE \"{table}\" SET path = ?1 WHERE rowid = ?2"),
                        rusqlite::params![remapped, row_id],
                    )?;
                }
            }
        }
    }
    transaction.commit()?;
    Ok(())
}

fn safe_identifier(value: &str) -> bool {
    !value.is_empty()
        && value
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || character == '_')
}

fn remap_known_document_paths(
    table: &str,
    document: &mut Value,
    previous: &Path,
    target: &Path,
) -> bool {
    let pointers: &[&str] = match table {
        "app_config" => &[
            "/data_dir",
            "/recording/first_person_hud_assets",
            "/recording/obs_realtime_kill_fx_media",
            "/recording/obs_realtime_keyboard_media",
        ],
        "demos" | "recorded_clips" => &["/path"],
        "media_assets" => &["/path", "/proxy_path"],
        "montage_projects" => &["/settings/background_music"],
        "export_jobs" => &["/output_path"],
        _ => &[],
    };
    let mut changed = false;
    for pointer in pointers {
        if let Some(value) = document.pointer_mut(pointer) {
            changed |= remap_path_value(value, previous, target);
        }
    }
    if table == "app_config"
        && let Some(Value::Array(paths)) = document.get_mut("demo_watch_paths")
    {
        for path in paths {
            changed |= remap_path_value(path, previous, target);
        }
    }
    if table == "recording_jobs"
        && let Some(Value::Array(outputs)) = document.get_mut("outputs")
    {
        for output in outputs {
            if let Some(path) = output.get_mut("path") {
                changed |= remap_path_value(path, previous, target);
            }
        }
    }
    changed
}

fn remap_path_value(value: &mut Value, previous: &Path, target: &Path) -> bool {
    let Value::String(path) = value else {
        return false;
    };
    remap_path(path, previous, target).is_some_and(|remapped| {
        *path = remapped;
        true
    })
}

fn remap_path(value: &str, previous: &Path, target: &Path) -> Option<String> {
    let path = Path::new(value);
    let resolved = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
    let relative = resolved.strip_prefix(previous).ok()?;
    let managed = relative.as_os_str().is_empty()
        || relative.components().next().is_some_and(|component| {
            let std::path::Component::Normal(name) = component else {
                return false;
            };
            MANAGED_DIRECTORIES
                .iter()
                .any(|managed| name == std::ffi::OsStr::new(managed))
        });
    managed.then(|| target.join(relative).to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn imports_database_snapshot_and_cache_without_overwriting() {
        let root = tempfile::tempdir().expect("root");
        let previous = root.path().join("previous");
        let target = root.path().join("target");
        fs::create_dir_all(previous.join("replay-cache")).expect("previous dirs");
        fs::create_dir(&target).expect("target");
        let database = Connection::open(previous.join("app.db")).expect("source database");
        database
            .execute_batch("CREATE TABLE sample(value TEXT); INSERT INTO sample VALUES ('kept'); CREATE TABLE media_assets(path TEXT, document_json TEXT);")
            .expect("fixture");
        let old_media = previous
            .join("recordings/clip.mp4")
            .to_string_lossy()
            .into_owned();
        let title = format!("{old_media} championship title");
        let notes = format!("{old_media} is mentioned here but is not a path field");
        database
            .execute(
                "INSERT INTO media_assets(path, document_json) VALUES (?1, ?2)",
                rusqlite::params![
                    &old_media,
                    serde_json::json!({
                        "path": old_media.clone(),
                        "proxy_path": old_media.clone(),
                        "title": title.clone(),
                        "notes": notes.clone(),
                        "metadata": { "path": old_media.clone() }
                    })
                    .to_string()
                ],
            )
            .expect("managed record");
        drop(database);
        fs::write(previous.join("replay-cache/entry.json"), b"cache").expect("cache");
        fs::create_dir(previous.join("recordings")).expect("recordings");
        fs::write(previous.join("recordings/clip.mp4"), b"video").expect("managed media");

        let report = import_previous_data_directory(&previous, &target).expect("import");
        assert!(report.database_imported);
        assert_eq!(report.cache_files_imported, 1);
        let imported = Connection::open(target.join("vibe-cs.db")).expect("imported database");
        let value: String = imported
            .query_row("SELECT value FROM sample", [], |row| row.get(0))
            .expect("value");
        assert_eq!(value, "kept");
        assert_eq!(
            fs::read(target.join("replay-cache/entry.json")).expect("cache bytes"),
            b"cache"
        );
        assert_eq!(
            fs::read(target.join("recordings/clip.mp4")).expect("media bytes"),
            b"video"
        );
        let expected_media = target
            .canonicalize()
            .expect("canonical target")
            .join("recordings/clip.mp4")
            .to_string_lossy()
            .into_owned();
        let (path, document): (String, String) = imported
            .query_row("SELECT path, document_json FROM media_assets", [], |row| {
                Ok((row.get(0)?, row.get(1)?))
            })
            .expect("remapped record");
        assert_eq!(path, expected_media);
        let document: Value = serde_json::from_str(&document).expect("document");
        assert_eq!(document["path"], expected_media);
        assert_eq!(document["proxy_path"], expected_media);
        assert_eq!(document["title"], title);
        assert_eq!(document["notes"], notes);
        assert_eq!(document["metadata"]["path"], old_media);
        assert_eq!(
            remap_path(
                &previous.join("unmanaged/reference.txt").to_string_lossy(),
                &previous.canonicalize().expect("canonical previous"),
                &target.canonicalize().expect("canonical target"),
            ),
            None
        );
        assert!(matches!(
            import_previous_data_directory(&previous, &target),
            Err(PreviousDataImportError::TargetAlreadyInitialized)
        ));
    }

    #[test]
    fn resumes_journaled_directory_publication_before_publishing_database() {
        let root = tempfile::tempdir().expect("root");
        let previous = root.path().join("previous");
        let target = root.path().join("target");
        fs::create_dir_all(previous.join("recordings")).expect("previous recordings");
        fs::create_dir(&target).expect("target");
        fs::write(previous.join("recordings/clip.mp4"), b"video").expect("media");
        let database = Connection::open(previous.join("vibe-cs.db")).expect("source database");
        database
            .execute_batch("CREATE TABLE sample(value TEXT); INSERT INTO sample VALUES ('kept');")
            .expect("fixture");
        drop(database);

        let previous = previous.canonicalize().expect("previous canonical");
        let target = target.canonicalize().expect("target canonical");
        let stage = target.join(format!("{STAGE_PREFIX}fixture"));
        fs::create_dir(&stage).expect("stage");
        let report = import_into_stage(&previous.join("vibe-cs.db"), &previous, &target, &stage)
            .expect("stage import");
        let journal = PublicationJournal {
            schema_version: 1,
            previous: previous.clone(),
            target: target.clone(),
            directories: vec!["recordings".to_owned()],
            report: report.clone(),
        };
        write_journal(&stage, &journal).expect("journal");
        fs::rename(stage.join("recordings"), target.join("recordings"))
            .expect("simulate interrupted publication");

        assert_eq!(
            import_previous_data_directory(&previous, &target).expect("resume"),
            report
        );
        assert!(target.join("vibe-cs.db").is_file());
        assert_eq!(
            fs::read(target.join("recordings/clip.mp4")).expect("published media"),
            b"video"
        );
        assert!(!stage.exists());
    }

    #[test]
    fn publication_conflict_rolls_back_directories_and_keeps_database_staged() {
        let root = tempfile::tempdir().expect("root");
        let target = root.path().join("target");
        let stage = target.join(format!("{STAGE_PREFIX}fixture"));
        fs::create_dir_all(stage.join("recordings")).expect("staged recordings");
        fs::create_dir(stage.join("exports")).expect("staged exports");
        fs::create_dir(target.join("exports")).expect("existing exports");
        fs::write(stage.join("vibe-cs.db"), b"database").expect("staged database");

        let result = publish_stage(
            &stage,
            &target,
            &target.join("vibe-cs.db"),
            &["recordings".to_owned(), "exports".to_owned()],
        );
        assert!(matches!(
            result,
            Err(PreviousDataImportError::TargetAlreadyInitialized)
        ));
        assert!(!target.join("vibe-cs.db").exists());
        assert!(stage.join("vibe-cs.db").is_file());
        assert!(stage.join("recordings").is_dir());
    }
}
