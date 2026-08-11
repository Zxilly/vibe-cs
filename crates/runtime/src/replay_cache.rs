use std::{
    ffi::{OsStr, OsString},
    fs,
    io::{ErrorKind, Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    sync::Arc,
    time::SystemTime,
};

use cap_std::{
    ambient_authority,
    fs::{Dir, File as CapabilityFile, OpenOptions as CapabilityOpenOptions},
};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::sync::Mutex;
use uuid::Uuid;
use vibe_cs_api::{
    ReplayCacheCleanup, ReplayCacheMetadata, ReplayCacheState, ReplayCacheStatus, ReplayPayload,
};
use vibe_cs_domain::{DemoRecord, DomainError, MatchAnalysis, ReplayFrame};

/// Version 2 adds evidence ownership and utility-mask geometry. The version is
/// part of the cache key, so version 1 entries are never interpreted as the new
/// wire model and are replaced on demand before ordinary bounded pruning.
pub(crate) const REPLAY_CACHE_VERSION: u32 = 2;
const MAXIMUM_CACHE_FILE_BYTES: u64 = 128 * 1024 * 1024;
const MAXIMUM_CACHE_BYTES: u64 = 512 * 1024 * 1024;
const MAXIMUM_CACHE_ENTRIES: usize = 128;
const MAXIMUM_SCAN_ENTRIES: usize = 2_048;
const MAXIMUM_REPLAY_FRAMES: usize = 500_000;
const MAXIMUM_PLAYERS_PER_FRAME: usize = 128;
const MAXIMUM_EFFECTS_PER_FRAME: usize = 512;
const MAXIMUM_TEXT_BYTES: usize = 512;

#[derive(Debug, Clone)]
pub(crate) struct ReplayCache {
    root: PathBuf,
    directory: Result<Arc<Dir>, Arc<String>>,
    gate: Arc<Mutex<()>>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct CacheDocument {
    version: u32,
    key: String,
    content_sha256: String,
    analysis_sha256: String,
    generated_at: DateTime<Utc>,
    frame_count: usize,
    frames: Vec<ReplayFrame>,
}

#[derive(Debug)]
struct CachedDocument {
    document: CacheDocument,
    bytes: u64,
}

#[derive(Debug)]
struct CacheEntry {
    name: OsString,
    bytes: u64,
    modified: SystemTime,
}

#[derive(Debug)]
struct BoundedHashWriter {
    hasher: Sha256,
    written: u64,
}

#[derive(Debug, Default)]
struct BoundedBytesWriter {
    bytes: Vec<u8>,
}

impl std::io::Write for BoundedHashWriter {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        let byte_count = u64::try_from(bytes.len()).unwrap_or(u64::MAX);
        if self.written.saturating_add(byte_count) > MAXIMUM_CACHE_FILE_BYTES {
            return Err(std::io::Error::other(
                "analysis exceeds the replay cache hashing limit",
            ));
        }
        self.hasher.update(bytes);
        self.written = self.written.saturating_add(byte_count);
        Ok(bytes.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

impl std::io::Write for BoundedBytesWriter {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        let next_length = self
            .bytes
            .len()
            .checked_add(bytes.len())
            .ok_or_else(|| std::io::Error::other("replay cache size overflow"))?;
        if u64::try_from(next_length).unwrap_or(u64::MAX) > MAXIMUM_CACHE_FILE_BYTES {
            return Err(std::io::Error::other(
                "generated replay exceeds the per-file cache limit",
            ));
        }
        self.bytes
            .try_reserve(bytes.len())
            .map_err(|error| std::io::Error::other(error.to_string()))?;
        self.bytes.extend_from_slice(bytes);
        Ok(bytes.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

impl ReplayCache {
    pub(crate) fn new(root: PathBuf) -> Self {
        let initialized = initialize_cache_directory(&root);
        let (root, directory) = match initialized {
            Ok((root, directory)) => (root, Ok(Arc::new(directory))),
            Err(error) => (root, Err(Arc::new(error.to_string()))),
        };
        Self {
            root,
            directory,
            gate: Arc::new(Mutex::new(())),
        }
    }

    fn directory(&self) -> Result<&Dir, DomainError> {
        let directory = self.directory.as_deref().map_err(|message| {
            DomainError::Internal(format!("replay cache initialization failed: {message}"))
        })?;
        ensure_cache_directory_mapping(directory, &self.root)?;
        Ok(directory)
    }

    pub(crate) async fn resolve<F>(
        &self,
        demo: &DemoRecord,
        analysis: &MatchAnalysis,
        generate: F,
    ) -> Result<ReplayPayload, DomainError>
    where
        F: FnOnce() -> Result<Vec<ReplayFrame>, DomainError>,
    {
        let Some(content_sha256) = normalized_sha256(demo.content_sha256.as_deref()) else {
            let frames = generate()?;
            validate_generated_frames(&frames)?;
            return Ok(ReplayPayload {
                frames,
                cache: ReplayCacheMetadata {
                    state: ReplayCacheState::Bypassed,
                    version: REPLAY_CACHE_VERSION,
                    key: None,
                    bytes: 0,
                    generated_at: None,
                    repaired: false,
                    reason: Some("demo content hash is unavailable".to_owned()),
                },
            });
        };
        let analysis_sha256 = analysis_digest(analysis)?;
        let key = cache_key(&content_sha256, &analysis_sha256);
        let name = format!("{key}.json");

        let _guard = self.gate.lock().await;
        let directory = self.directory()?;
        let (cached, repaired) =
            Self::read_cached(directory, &name, &key, &content_sha256, &analysis_sha256)?;
        ensure_cache_directory_mapping(directory, &self.root)?;
        if let Some(cached) = cached {
            return Ok(ReplayPayload {
                frames: cached.document.frames,
                cache: ReplayCacheMetadata {
                    state: ReplayCacheState::Hit,
                    version: REPLAY_CACHE_VERSION,
                    key: Some(key),
                    bytes: cached.bytes,
                    generated_at: Some(cached.document.generated_at),
                    repaired,
                    reason: None,
                },
            });
        }

        let frames = generate()?;
        validate_generated_frames(&frames)?;
        let generated_at = Utc::now();
        let document = CacheDocument {
            version: REPLAY_CACHE_VERSION,
            key: key.clone(),
            content_sha256,
            analysis_sha256,
            generated_at,
            frame_count: frames.len(),
            frames,
        };
        let mut cache_writer = BoundedBytesWriter::default();
        serde_json::to_writer(&mut cache_writer, &document).map_err(|error| {
            if error.is_io() {
                DomainError::InvalidInput(
                    "generated replay exceeds the per-file cache limit".to_owned(),
                )
            } else {
                DomainError::Internal(format!("unable to encode replay cache: {error}"))
            }
        })?;
        let bytes = cache_writer.bytes;
        write_atomic(directory, &name, &key, &bytes)?;
        Self::prune(directory, OsStr::new(&name))?;
        ensure_cache_directory_mapping(directory, &self.root)?;
        let byte_count = u64::try_from(bytes.len()).unwrap_or(u64::MAX);
        Ok(ReplayPayload {
            frames: document.frames,
            cache: ReplayCacheMetadata {
                state: ReplayCacheState::Generated,
                version: REPLAY_CACHE_VERSION,
                key: Some(key),
                bytes: byte_count,
                generated_at: Some(generated_at),
                repaired,
                reason: None,
            },
        })
    }

    pub(crate) async fn status(&self) -> Result<ReplayCacheStatus, DomainError> {
        let _guard = self.gate.lock().await;
        let directory = self.directory()?;
        let (entries, scan_complete) = Self::scan_entries(directory)?;
        ensure_cache_directory_mapping(directory, &self.root)?;
        Ok(ReplayCacheStatus {
            version: REPLAY_CACHE_VERSION,
            entries: u64::try_from(entries.len()).unwrap_or(u64::MAX),
            bytes: entries
                .iter()
                .fold(0_u64, |total, entry| total.saturating_add(entry.bytes)),
            maximum_entries: u64::try_from(MAXIMUM_CACHE_ENTRIES).unwrap_or(u64::MAX),
            maximum_bytes: MAXIMUM_CACHE_BYTES,
            scan_complete,
            checked_at: Utc::now(),
        })
    }

    pub(crate) async fn clear(&self) -> Result<ReplayCacheCleanup, DomainError> {
        let _guard = self.gate.lock().await;
        let directory = self.directory()?;
        let mut removed_entries = 0_u64;
        let mut freed_bytes = 0_u64;
        let mut failed_entries = 0_u64;
        let mut scanned = 0_usize;
        let mut entries = directory
            .entries()
            .map_err(|error| cache_io_error("list", &error))?;
        let scan_complete = loop {
            let Some(entry) = entries.next() else {
                break true;
            };
            if scanned >= MAXIMUM_SCAN_ENTRIES {
                break false;
            }
            let entry = entry.map_err(|error| cache_io_error("read directory entry", &error))?;
            scanned += 1;
            let file_name = entry.file_name().to_string_lossy().into_owned();
            if !is_managed_cache_name(&file_name) && !is_managed_temporary_name(&file_name) {
                continue;
            }
            let Ok((file, metadata)) = open_verified_plain_file(directory, entry.file_name())
            else {
                failed_entries = failed_entries.saturating_add(1);
                continue;
            };
            let bytes = metadata.len();
            match remove_verified_file(directory, entry.file_name(), &file) {
                Ok(()) => {
                    removed_entries = removed_entries.saturating_add(1);
                    freed_bytes = freed_bytes.saturating_add(bytes);
                }
                Err(_) => failed_entries = failed_entries.saturating_add(1),
            }
        };
        ensure_cache_directory_mapping(directory, &self.root)?;
        Ok(ReplayCacheCleanup {
            removed_entries,
            freed_bytes,
            failed_entries,
            scan_complete,
            completed_at: Utc::now(),
        })
    }

    fn read_cached(
        directory: &Dir,
        name: &str,
        key: &str,
        content_sha256: &str,
        analysis_sha256: &str,
    ) -> Result<(Option<CachedDocument>, bool), DomainError> {
        let (mut file, metadata) = match open_verified_plain_file(directory, name) {
            Ok(value) => value,
            Err(error) if error.kind() == ErrorKind::NotFound => return Ok((None, false)),
            Err(error) => return Err(cache_io_error("open entry", &error)),
        };
        let bytes = (metadata.len() <= MAXIMUM_CACHE_FILE_BYTES)
            .then(|| read_bounded(&mut file))
            .transpose()
            .ok()
            .flatten();
        let document = bytes
            .as_deref()
            .and_then(|bytes| serde_json::from_slice::<CacheDocument>(bytes).ok());
        if let Some(document) = document.filter(|document| {
            document.version == REPLAY_CACHE_VERSION
                && document.key == key
                && document.content_sha256 == content_sha256
                && document.analysis_sha256 == analysis_sha256
                && document.frame_count == document.frames.len()
                && frames_are_valid(&document.frames)
        }) {
            if !capability_file_matches_name(directory, name, &file)
                .map_err(|error| cache_io_error("verify read entry", &error))?
            {
                return Err(DomainError::Conflict(
                    "replay cache entry changed while it was read".to_owned(),
                ));
            }
            return Ok((
                Some(CachedDocument {
                    document,
                    bytes: metadata.len(),
                }),
                false,
            ));
        }
        remove_verified_file(directory, name, &file)
            .map_err(|error| cache_io_error("remove invalid entry", &error))?;
        Ok((None, true))
    }

    fn prune(directory: &Dir, protected: &OsStr) -> Result<(), DomainError> {
        let (mut entries, _) = Self::scan_entries(directory)?;
        entries.sort_by_key(|entry| entry.modified);
        let mut total_bytes = entries
            .iter()
            .fold(0_u64, |total, entry| total.saturating_add(entry.bytes));
        while entries.len() > MAXIMUM_CACHE_ENTRIES || total_bytes > MAXIMUM_CACHE_BYTES {
            let Some(oldest_index) = entries.iter().position(|entry| entry.name != protected)
            else {
                break;
            };
            let oldest = entries.remove(oldest_index);
            let (file, _) = open_verified_plain_file(directory, &oldest.name)
                .map_err(|error| cache_io_error("open prune candidate", &error))?;
            remove_verified_file(directory, &oldest.name, &file)
                .map_err(|error| cache_io_error("remove prune candidate", &error))?;
            total_bytes = total_bytes.saturating_sub(oldest.bytes);
        }
        Ok(())
    }

    fn scan_entries(directory: &Dir) -> Result<(Vec<CacheEntry>, bool), DomainError> {
        let mut directory_entries = directory
            .entries()
            .map_err(|error| cache_io_error("list", &error))?;
        let mut entries = Vec::new();
        let mut scanned = 0_usize;
        while scanned < MAXIMUM_SCAN_ENTRIES {
            let Some(entry) = directory_entries.next() else {
                return Ok((entries, true));
            };
            let entry = entry.map_err(|error| cache_io_error("read directory entry", &error))?;
            scanned += 1;
            let file_name = entry.file_name().to_string_lossy().into_owned();
            if !is_managed_cache_name(&file_name) {
                continue;
            }
            let metadata = match directory.symlink_metadata(entry.file_name()) {
                Ok(metadata)
                    if metadata.is_file()
                        && !metadata.is_symlink()
                        && !capability_metadata_is_reparse(&metadata) =>
                {
                    metadata
                }
                Ok(_) => continue,
                Err(error) if error.kind() == ErrorKind::NotFound => continue,
                Err(error) => return Err(cache_io_error("inspect entry", &error)),
            };
            entries.push(CacheEntry {
                name: entry.file_name(),
                bytes: metadata.len(),
                modified: metadata
                    .modified()
                    .map_or(SystemTime::UNIX_EPOCH, cap_std::time::SystemTime::into_std),
            });
        }
        Ok((entries, directory_entries.next().is_none()))
    }
}

fn read_bounded(file: &mut CapabilityFile) -> Result<Vec<u8>, DomainError> {
    file.seek(SeekFrom::Start(0))
        .map_err(|error| cache_io_error("rewind entry", &error))?;
    let mut bytes = Vec::new();
    file.take(MAXIMUM_CACHE_FILE_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| cache_io_error("read entry", &error))?;
    if u64::try_from(bytes.len()).unwrap_or(u64::MAX) > MAXIMUM_CACHE_FILE_BYTES {
        return Err(DomainError::InvalidInput(
            "replay cache entry exceeds its size limit".to_owned(),
        ));
    }
    Ok(bytes)
}

fn write_atomic(
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
                "replay cache staging entry changed before publication".to_owned(),
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

fn validate_generated_frames(frames: &[ReplayFrame]) -> Result<(), DomainError> {
    if frames_are_valid(frames) {
        Ok(())
    } else {
        Err(DomainError::InvalidInput(
            "generated replay exceeds cache limits or contains invalid coordinates".to_owned(),
        ))
    }
}

fn frames_are_valid(frames: &[ReplayFrame]) -> bool {
    if frames.is_empty() || frames.len() > MAXIMUM_REPLAY_FRAMES {
        return false;
    }
    let mut previous_tick = None;
    for frame in frames {
        if previous_tick.is_some_and(|tick| frame.tick < tick)
            || frame.players.len() > MAXIMUM_PLAYERS_PER_FRAME
            || frame.projectiles.len() > MAXIMUM_EFFECTS_PER_FRAME
        {
            return false;
        }
        previous_tick = Some(frame.tick);
        if frame.players.iter().any(|player| {
            !valid_coordinates(player.position)
                || player.id.len() > MAXIMUM_TEXT_BYTES
                || player.name.len() > MAXIMUM_TEXT_BYTES
                || player.team.len() > MAXIMUM_TEXT_BYTES
                || player.weapon.len() > MAXIMUM_TEXT_BYTES
                || !player.yaw.is_finite()
        }) || frame.projectiles.iter().any(|effect| {
            !valid_coordinates(effect.position)
                || effect.kind.len() > MAXIMUM_TEXT_BYTES
                || effect
                    .radius
                    .is_some_and(|radius| !radius.is_finite() || !(0.0..=4096.0).contains(&radius))
        }) || frame.bomb.as_ref().is_some_and(|bomb| {
            !valid_coordinates(bomb.position)
                || bomb.state.len() > MAXIMUM_TEXT_BYTES
                || bomb
                    .carrier_id
                    .as_ref()
                    .is_some_and(|carrier| carrier.len() > MAXIMUM_TEXT_BYTES)
        }) {
            return false;
        }
    }
    true
}

fn valid_coordinates(position: [f64; 3]) -> bool {
    position.iter().all(|coordinate| coordinate.is_finite())
}

fn normalized_sha256(value: Option<&str>) -> Option<String> {
    let value = value?.trim();
    (value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit()))
        .then(|| value.to_ascii_lowercase())
}

fn cache_key(content_sha256: &str, analysis_sha256: &str) -> String {
    hex_digest(
        format!("replay-cache-v{REPLAY_CACHE_VERSION}\0{content_sha256}\0{analysis_sha256}")
            .as_bytes(),
    )
}

fn analysis_digest(analysis: &MatchAnalysis) -> Result<String, DomainError> {
    let mut writer = BoundedHashWriter {
        hasher: Sha256::new(),
        written: 0,
    };
    serde_json::to_writer(&mut writer, analysis).map_err(|error| {
        if error.is_io() {
            DomainError::InvalidInput("analysis exceeds the replay cache hashing limit".to_owned())
        } else {
            DomainError::Internal(format!("unable to hash analysis: {error}"))
        }
    })?;
    Ok(digest_to_hex(writer.hasher.finalize()))
}

fn hex_digest(bytes: &[u8]) -> String {
    digest_to_hex(Sha256::digest(bytes))
}

fn digest_to_hex(digest: impl AsRef<[u8]>) -> String {
    use std::fmt::Write as _;

    let digest = digest.as_ref();
    let mut output = String::with_capacity(digest.len().saturating_mul(2));
    for byte in digest {
        let _ = write!(output, "{byte:02x}");
    }
    output
}

fn is_managed_cache_name(name: &str) -> bool {
    name.len() == 69
        && Path::new(name)
            .extension()
            .is_some_and(|extension| extension.eq_ignore_ascii_case("json"))
        && name[..64].bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn is_managed_temporary_name(name: &str) -> bool {
    name.starts_with('.')
        && Path::new(name)
            .extension()
            .is_some_and(|extension| extension.eq_ignore_ascii_case("tmp"))
        && name.len() <= 128
}

fn initialize_cache_directory(root: &Path) -> Result<(PathBuf, Dir), DomainError> {
    fs::create_dir_all(root).map_err(|error| cache_io_error("create directory", &error))?;
    let metadata =
        fs::symlink_metadata(root).map_err(|error| cache_io_error("inspect directory", &error))?;
    if !metadata.is_dir()
        || metadata.file_type().is_symlink()
        || ambient_metadata_is_reparse(&metadata)
    {
        return Err(DomainError::Conflict(
            "replay cache root is not a plain directory".to_owned(),
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
            "replay cache capability is not a plain directory".to_owned(),
        ));
    }
    ensure_cache_directory_mapping(&directory, &canonical)?;
    Ok((canonical, directory))
}

fn ensure_cache_directory_mapping(directory: &Dir, path: &Path) -> Result<(), DomainError> {
    let metadata = fs::symlink_metadata(path)
        .map_err(|error| cache_io_error("inspect ambient directory", &error))?;
    if !metadata.is_dir()
        || metadata.file_type().is_symlink()
        || ambient_metadata_is_reparse(&metadata)
    {
        return Err(DomainError::Conflict(
            "replay cache path is no longer a plain directory".to_owned(),
        ));
    }
    let ambient = Dir::open_ambient_dir(path, ambient_authority())
        .map_err(|error| cache_io_error("open ambient directory", &error))?;
    if !capability_directories_are_same(directory, &ambient)? {
        return Err(DomainError::Conflict(
            "replay cache directory identity changed".to_owned(),
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

fn open_verified_plain_file(
    directory: &Dir,
    name: impl AsRef<Path>,
) -> std::io::Result<(CapabilityFile, cap_std::fs::Metadata)> {
    let name = name.as_ref();
    let metadata = directory.symlink_metadata(name)?;
    if !metadata.is_file() || metadata.is_symlink() || capability_metadata_is_reparse(&metadata) {
        return Err(std::io::Error::new(
            ErrorKind::InvalidData,
            "replay cache entry is not a plain file",
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
            "replay cache entry changed while opening",
        ));
    }
    Ok((file, opened))
}

fn capability_file_matches_name(
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

fn remove_verified_file(
    directory: &Dir,
    name: impl AsRef<Path>,
    file: &CapabilityFile,
) -> std::io::Result<()> {
    let name = name.as_ref();
    if !capability_file_matches_name(directory, name, file)? {
        return Err(std::io::Error::new(
            ErrorKind::InvalidData,
            "replay cache entry changed before deletion",
        ));
    }
    directory.remove_file(name)
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

fn cache_io_error(action: &str, error: &std::io::Error) -> DomainError {
    DomainError::Internal(format!("replay cache I/O failed to {action}: {error}"))
}

#[cfg(test)]
mod tests {
    use std::{
        fs,
        sync::atomic::{AtomicUsize, Ordering},
    };

    use tempfile::TempDir;
    use vibe_cs_api::ReplayCacheState;
    use vibe_cs_domain::{DemoStatus, ReplayPlayer};

    use super::*;

    fn demo() -> DemoRecord {
        let now = Utc::now();
        DemoRecord {
            id: Uuid::new_v4(),
            path: "fixture.dem".to_owned(),
            file_name: "fixture.dem".to_owned(),
            display_name: "fixture".to_owned(),
            source: "test".to_owned(),
            status: DemoStatus::Ready,
            map_name: Some("de_test".to_owned()),
            match_date: None,
            duration_seconds: Some(1.0),
            total_rounds: Some(0),
            team_a_name: None,
            team_b_name: None,
            team_a_score: None,
            team_b_score: None,
            remark: String::new(),
            content_sha256: Some("a".repeat(64)),
            file_size: 1,
            created_at: now,
            updated_at: now,
        }
    }

    fn analysis(demo_id: Uuid) -> MatchAnalysis {
        MatchAnalysis {
            demo_id,
            map_name: "de_test".to_owned(),
            tick_rate: 64.0,
            duration_seconds: 1.0,
            teams: Vec::new(),
            players: Vec::new(),
            rounds: Vec::new(),
            highlights: Vec::new(),
        }
    }

    fn frames() -> Vec<ReplayFrame> {
        vec![ReplayFrame {
            tick: 1,
            players: vec![ReplayPlayer {
                id: "1".to_owned(),
                name: "Player".to_owned(),
                team: "T".to_owned(),
                position: [1.0, 2.0, 3.0],
                yaw: 90.0,
                health: 100,
                armor: 0,
                alive: true,
                weapon: "ak47".to_owned(),
                input: None,
            }],
            projectiles: Vec::new(),
            bomb: None,
        }]
    }

    #[tokio::test]
    async fn generated_entry_is_reused_without_regeneration() {
        let temporary = TempDir::new().expect("temp dir");
        let cache = ReplayCache::new(temporary.path().join("replay-cache"));
        let demo = demo();
        let analysis = analysis(demo.id);
        let count = AtomicUsize::new(0);
        let first = cache
            .resolve(&demo, &analysis, || {
                count.fetch_add(1, Ordering::SeqCst);
                Ok(frames())
            })
            .await
            .expect("generate");
        let second = cache
            .resolve(&demo, &analysis, || {
                count.fetch_add(1, Ordering::SeqCst);
                Ok(frames())
            })
            .await
            .expect("hit");

        assert_eq!(first.cache.state, ReplayCacheState::Generated);
        assert_eq!(second.cache.state, ReplayCacheState::Hit);
        assert_eq!(count.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn corrupt_entry_is_removed_and_regenerated() {
        let temporary = TempDir::new().expect("temp dir");
        let cache = ReplayCache::new(temporary.path().join("replay-cache"));
        let demo = demo();
        let analysis = analysis(demo.id);
        let first = cache
            .resolve(&demo, &analysis, || Ok(frames()))
            .await
            .expect("generate");
        let key = first.cache.key.expect("cache key");
        tokio::fs::write(cache.root.join(format!("{key}.json")), b"not-json")
            .await
            .expect("corrupt fixture");

        let repaired = cache
            .resolve(&demo, &analysis, || Ok(frames()))
            .await
            .expect("repair");
        assert_eq!(repaired.cache.state, ReplayCacheState::Generated);
        assert!(repaired.cache.repaired);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn concurrent_requests_share_one_generation() {
        let temporary = TempDir::new().expect("temp dir");
        let cache = Arc::new(ReplayCache::new(temporary.path().join("replay-cache")));
        let demo = demo();
        let analysis = analysis(demo.id);
        let count = Arc::new(AtomicUsize::new(0));

        let first_cache = Arc::clone(&cache);
        let first_demo = demo.clone();
        let first_analysis = analysis.clone();
        let first_count = Arc::clone(&count);
        let first = tokio::spawn(async move {
            first_cache
                .resolve(&first_demo, &first_analysis, || {
                    first_count.fetch_add(1, Ordering::SeqCst);
                    std::thread::sleep(std::time::Duration::from_millis(40));
                    Ok(frames())
                })
                .await
        });
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        let second_cache = Arc::clone(&cache);
        let second_count = Arc::clone(&count);
        let second = tokio::spawn(async move {
            second_cache
                .resolve(&demo, &analysis, || {
                    second_count.fetch_add(1, Ordering::SeqCst);
                    Ok(frames())
                })
                .await
        });
        let first = first.await.expect("first task").expect("first replay");
        let second = second.await.expect("second task").expect("second replay");

        assert_eq!(count.load(Ordering::SeqCst), 1);
        assert_eq!(first.cache.state, ReplayCacheState::Generated);
        assert_eq!(second.cache.state, ReplayCacheState::Hit);
    }

    #[tokio::test]
    async fn status_and_cleanup_report_real_files() {
        let temporary = TempDir::new().expect("temp dir");
        let cache = ReplayCache::new(temporary.path().join("replay-cache"));
        let demo = demo();
        cache
            .resolve(&demo, &analysis(demo.id), || Ok(frames()))
            .await
            .expect("generate");

        let status = cache.status().await.expect("status");
        assert_eq!(status.entries, 1);
        assert!(status.bytes > 0);
        let cleanup = cache.clear().await.expect("clear");
        assert_eq!(cleanup.removed_entries, 1);
        assert!(cleanup.freed_bytes > 0);
        assert_eq!(cache.status().await.expect("empty status").entries, 0);
    }

    #[tokio::test]
    async fn clear_rejects_invalid_managed_entries_without_recursive_deletion() {
        let temporary = TempDir::new().expect("temp dir");
        let cache = ReplayCache::new(temporary.path().join("replay-cache"));
        let invalid_name = format!("{}.json", "b".repeat(64));
        let invalid = cache.root.join(&invalid_name);
        fs::create_dir(&invalid).expect("invalid directory fixture");
        fs::write(invalid.join("sentinel.txt"), b"outside managed files")
            .expect("sentinel fixture");

        let cleanup = cache.clear().await.expect("bounded clear");

        assert_eq!(cleanup.removed_entries, 0);
        assert_eq!(cleanup.failed_entries, 1);
        assert_eq!(
            fs::read(invalid.join("sentinel.txt")).expect("sentinel remains"),
            b"outside managed files"
        );
    }

    #[tokio::test]
    async fn an_ambient_ancestor_swap_is_rejected_before_cache_access() {
        let temporary = TempDir::new().expect("temp dir");
        let data = temporary.path().join("data");
        let root = data.join("replay-cache");
        let cache = ReplayCache::new(root.clone());
        let displaced = temporary.path().join("bound-data");
        if fs::rename(&data, &displaced).is_err() {
            // Some Windows filesystem policies deny renaming an open directory.
            // That denial itself prevents the tested ancestor/root swap.
            return;
        }
        fs::create_dir_all(&root).expect("replacement root");
        let sentinel = root.join("sentinel.txt");
        fs::write(&sentinel, b"replacement").expect("replacement sentinel");

        let error = cache.status().await.expect_err("identity swap must fail");

        assert!(error.to_string().contains("identity changed"));
        assert_eq!(
            fs::read(sentinel).expect("sentinel remains"),
            b"replacement"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn clear_does_not_follow_a_managed_symlink_to_an_external_sentinel() {
        use std::os::unix::fs::symlink;

        let temporary = TempDir::new().expect("temp dir");
        let cache = ReplayCache::new(temporary.path().join("replay-cache"));
        let sentinel = temporary.path().join("external-sentinel.txt");
        fs::write(&sentinel, b"external").expect("sentinel fixture");
        let link = cache.root.join(format!("{}.json", "c".repeat(64)));
        symlink(&sentinel, &link).expect("symlink fixture");

        let cleanup = cache.clear().await.expect("bounded clear");

        assert_eq!(cleanup.removed_entries, 0);
        assert_eq!(cleanup.failed_entries, 1);
        assert_eq!(fs::read(sentinel).expect("sentinel remains"), b"external");
        assert!(fs::symlink_metadata(link).is_ok());
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn clear_does_not_follow_a_managed_junction_to_an_external_sentinel() {
        let temporary = TempDir::new().expect("temp dir");
        let cache = ReplayCache::new(temporary.path().join("replay-cache"));
        let external = temporary.path().join("external");
        fs::create_dir(&external).expect("external directory");
        let sentinel = external.join("sentinel.txt");
        fs::write(&sentinel, b"external").expect("sentinel fixture");
        let junction = cache.root.join(format!("{}.json", "c".repeat(64)));
        let status = std::process::Command::new("cmd")
            .args([
                "/d",
                "/c",
                "mklink",
                "/J",
                &junction.to_string_lossy(),
                &external.to_string_lossy(),
            ])
            .status()
            .expect("invoke mklink");
        if !status.success() {
            // Locked-down runners can forbid creating reparse points. Runtime
            // protection still rejects FILE_ATTRIBUTE_REPARSE_POINT entries.
            return;
        }

        let cleanup = cache.clear().await.expect("bounded clear");

        assert_eq!(cleanup.removed_entries, 0);
        assert_eq!(cleanup.failed_entries, 1);
        assert_eq!(fs::read(sentinel).expect("sentinel remains"), b"external");
        assert!(fs::symlink_metadata(junction).is_ok());
    }
}
