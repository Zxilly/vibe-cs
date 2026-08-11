use std::{
    future::Future,
    io::ErrorKind,
    path::{Path, PathBuf},
    sync::Arc,
    time::SystemTime,
};

use chrono::{DateTime, Utc};
use sha2::{Digest, Sha256};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    sync::Mutex,
};
use uuid::Uuid;
use vibe_cs_api::{AvatarCacheCleanup, AvatarCacheStatus, PlayerAvatar};
use vibe_cs_domain::DomainError;
use vibe_cs_integrations::{
    MAXIMUM_STEAM_AVATAR_BYTES, SteamAvatarImage, detect_steam_avatar_mime, is_steam_id,
};

const AVATAR_CACHE_VERSION: u32 = 1;
const MAXIMUM_AVATAR_CACHE_BYTES: u64 = 64 * 1024 * 1024;
const MAXIMUM_AVATAR_CACHE_ENTRIES: usize = 500;
const MAXIMUM_AVATAR_SCAN_ENTRIES: usize = 2_048;

#[derive(Debug, Clone)]
pub(crate) struct AvatarCache {
    root: PathBuf,
    gate: Arc<Mutex<()>>,
}

#[derive(Debug)]
struct AvatarEntry {
    path: PathBuf,
    steam_id: String,
    hash: String,
    extension: &'static str,
    bytes: u64,
    modified: SystemTime,
}

impl AvatarCache {
    pub(crate) fn new(root: PathBuf) -> Self {
        Self {
            root,
            gate: Arc::new(Mutex::new(())),
        }
    }

    pub(crate) async fn resolve<F, Fut>(
        &self,
        steam_id: &str,
        fetch: F,
    ) -> Result<PlayerAvatar, DomainError>
    where
        F: FnOnce() -> Fut,
        Fut: Future<Output = Result<SteamAvatarImage, DomainError>>,
    {
        if !is_steam_id(steam_id) {
            return Err(DomainError::InvalidInput(
                "Steam ID must contain exactly 17 digits".to_owned(),
            ));
        }
        let _guard = self.gate.lock().await;
        tokio::fs::create_dir_all(&self.root)
            .await
            .map_err(|error| cache_io_error(&error))?;
        if let Some(avatar) = self.load(steam_id).await? {
            return Ok(avatar);
        }

        let image = fetch().await?;
        validate_image(&image)?;
        let hash = hex_digest(&image.bytes);
        let extension = mime_extension(image.mime_type).ok_or_else(|| {
            DomainError::InvalidInput("Steam avatar MIME type is unsupported".to_owned())
        })?;
        let destination = self.root.join(entry_name(steam_id, &hash, extension));
        write_atomic(&self.root, &destination, steam_id, &image.bytes).await?;
        self.remove_older_for_player(steam_id, &destination).await?;
        self.prune(&destination).await?;
        Ok(PlayerAvatar {
            bytes: image.bytes,
            content_type: image.mime_type.to_owned(),
            etag: format!("\"sha256-{hash}\""),
            last_modified: Utc::now(),
            cached: false,
        })
    }

    pub(crate) async fn status(&self) -> Result<AvatarCacheStatus, DomainError> {
        let _guard = self.gate.lock().await;
        let (entries, scan_complete) = self.scan_entries().await?;
        Ok(AvatarCacheStatus {
            version: AVATAR_CACHE_VERSION,
            entries: u64::try_from(entries.len()).unwrap_or(u64::MAX),
            bytes: entries
                .iter()
                .fold(0_u64, |total, entry| total.saturating_add(entry.bytes)),
            maximum_entries: u64::try_from(MAXIMUM_AVATAR_CACHE_ENTRIES).unwrap_or(u64::MAX),
            maximum_bytes: MAXIMUM_AVATAR_CACHE_BYTES,
            scan_complete,
            checked_at: Utc::now(),
        })
    }

    pub(crate) async fn clear(&self) -> Result<AvatarCacheCleanup, DomainError> {
        let _guard = self.gate.lock().await;
        let mut directory = match tokio::fs::read_dir(&self.root).await {
            Ok(directory) => directory,
            Err(error) if error.kind() == ErrorKind::NotFound => {
                return Ok(AvatarCacheCleanup {
                    removed_entries: 0,
                    freed_bytes: 0,
                    failed_entries: 0,
                    scan_complete: true,
                    completed_at: Utc::now(),
                });
            }
            Err(error) => return Err(cache_io_error(&error)),
        };
        let mut removed_entries = 0_u64;
        let mut freed_bytes = 0_u64;
        let mut failed_entries = 0_u64;
        let mut scanned = 0_usize;
        let scan_complete = loop {
            if scanned >= MAXIMUM_AVATAR_SCAN_ENTRIES {
                break directory
                    .next_entry()
                    .await
                    .map_err(|error| cache_io_error(&error))?
                    .is_none();
            }
            let Some(entry) = directory
                .next_entry()
                .await
                .map_err(|error| cache_io_error(&error))?
            else {
                break true;
            };
            scanned += 1;
            let file_name = entry.file_name().to_string_lossy().into_owned();
            if parse_entry_name(&file_name).is_none() && !is_temporary_name(&file_name) {
                continue;
            }
            let Ok(metadata) = tokio::fs::symlink_metadata(entry.path()).await else {
                failed_entries = failed_entries.saturating_add(1);
                continue;
            };
            match tokio::fs::remove_file(entry.path()).await {
                Ok(()) => {
                    removed_entries = removed_entries.saturating_add(1);
                    freed_bytes = freed_bytes.saturating_add(metadata.len());
                }
                Err(_) => failed_entries = failed_entries.saturating_add(1),
            }
        };
        Ok(AvatarCacheCleanup {
            removed_entries,
            freed_bytes,
            failed_entries,
            scan_complete,
            completed_at: Utc::now(),
        })
    }

    async fn load(&self, steam_id: &str) -> Result<Option<PlayerAvatar>, DomainError> {
        let (mut entries, _) = self.scan_entries().await?;
        entries.retain(|entry| entry.steam_id == steam_id);
        entries.sort_by_key(|entry| std::cmp::Reverse(entry.modified));
        for entry in entries {
            let valid_metadata =
                tokio::fs::symlink_metadata(&entry.path)
                    .await
                    .is_ok_and(|metadata| {
                        metadata.is_file()
                            && !metadata.file_type().is_symlink()
                            && metadata.len()
                                <= u64::try_from(MAXIMUM_STEAM_AVATAR_BYTES).unwrap_or(u64::MAX)
                    });
            let bytes = if valid_metadata {
                read_bounded(&entry.path).await.ok()
            } else {
                None
            };
            if let Some(bytes) = bytes {
                let mime_type = detect_steam_avatar_mime(&bytes);
                let hash = hex_digest(&bytes);
                if mime_type.and_then(mime_extension) == Some(entry.extension) && hash == entry.hash
                {
                    return Ok(Some(PlayerAvatar {
                        bytes,
                        content_type: mime_type.unwrap_or_default().to_owned(),
                        etag: format!("\"sha256-{hash}\""),
                        last_modified: DateTime::<Utc>::from(entry.modified),
                        cached: true,
                    }));
                }
            }
            tokio::fs::remove_file(&entry.path)
                .await
                .map_err(|error| cache_io_error(&error))?;
        }
        Ok(None)
    }

    async fn remove_older_for_player(
        &self,
        steam_id: &str,
        keep: &Path,
    ) -> Result<(), DomainError> {
        let (entries, _) = self.scan_entries().await?;
        for entry in entries
            .into_iter()
            .filter(|entry| entry.steam_id == steam_id && entry.path != keep)
        {
            tokio::fs::remove_file(entry.path)
                .await
                .map_err(|error| cache_io_error(&error))?;
        }
        Ok(())
    }

    async fn prune(&self, protected: &Path) -> Result<(), DomainError> {
        let (mut entries, _) = self.scan_entries().await?;
        entries.sort_by_key(|entry| entry.modified);
        let mut total_bytes = entries
            .iter()
            .fold(0_u64, |total, entry| total.saturating_add(entry.bytes));
        while entries.len() > MAXIMUM_AVATAR_CACHE_ENTRIES
            || total_bytes > MAXIMUM_AVATAR_CACHE_BYTES
        {
            let Some(index) = entries.iter().position(|entry| entry.path != protected) else {
                break;
            };
            let oldest = entries.remove(index);
            tokio::fs::remove_file(oldest.path)
                .await
                .map_err(|error| cache_io_error(&error))?;
            total_bytes = total_bytes.saturating_sub(oldest.bytes);
        }
        Ok(())
    }

    async fn scan_entries(&self) -> Result<(Vec<AvatarEntry>, bool), DomainError> {
        let mut directory = match tokio::fs::read_dir(&self.root).await {
            Ok(directory) => directory,
            Err(error) if error.kind() == ErrorKind::NotFound => return Ok((Vec::new(), true)),
            Err(error) => return Err(cache_io_error(&error)),
        };
        let mut entries = Vec::new();
        let mut scanned = 0_usize;
        while scanned < MAXIMUM_AVATAR_SCAN_ENTRIES {
            let Some(entry) = directory
                .next_entry()
                .await
                .map_err(|error| cache_io_error(&error))?
            else {
                return Ok((entries, true));
            };
            scanned += 1;
            let file_name = entry.file_name().to_string_lossy().into_owned();
            let Some((steam_id, hash, extension)) = parse_entry_name(&file_name) else {
                continue;
            };
            let metadata = match tokio::fs::symlink_metadata(entry.path()).await {
                Ok(metadata) if metadata.is_file() && !metadata.file_type().is_symlink() => {
                    metadata
                }
                Ok(_) => continue,
                Err(error) if error.kind() == ErrorKind::NotFound => continue,
                Err(error) => return Err(cache_io_error(&error)),
            };
            entries.push(AvatarEntry {
                path: entry.path(),
                steam_id,
                hash,
                extension,
                bytes: metadata.len(),
                modified: metadata.modified().unwrap_or(SystemTime::UNIX_EPOCH),
            });
        }
        Ok((
            entries,
            directory
                .next_entry()
                .await
                .map_err(|error| cache_io_error(&error))?
                .is_none(),
        ))
    }
}

fn validate_image(image: &SteamAvatarImage) -> Result<(), DomainError> {
    if image.bytes.is_empty()
        || image.bytes.len() > MAXIMUM_STEAM_AVATAR_BYTES
        || detect_steam_avatar_mime(&image.bytes) != Some(image.mime_type)
        || mime_extension(image.mime_type).is_none()
    {
        return Err(DomainError::InvalidInput(
            "Steam avatar bytes or MIME type are invalid".to_owned(),
        ));
    }
    Ok(())
}

async fn read_bounded(path: &Path) -> Result<Vec<u8>, DomainError> {
    let file = tokio::fs::File::open(path)
        .await
        .map_err(|error| cache_io_error(&error))?;
    let limit = u64::try_from(MAXIMUM_STEAM_AVATAR_BYTES).unwrap_or(u64::MAX);
    let mut bytes = Vec::new();
    file.take(limit.saturating_add(1))
        .read_to_end(&mut bytes)
        .await
        .map_err(|error| cache_io_error(&error))?;
    if bytes.len() > MAXIMUM_STEAM_AVATAR_BYTES {
        return Err(DomainError::InvalidInput(
            "cached Steam avatar exceeds the size limit".to_owned(),
        ));
    }
    Ok(bytes)
}

async fn write_atomic(
    root: &Path,
    destination: &Path,
    steam_id: &str,
    bytes: &[u8],
) -> Result<(), DomainError> {
    let temporary = root.join(format!(
        ".avatar-v{AVATAR_CACHE_VERSION}-{steam_id}-{}.tmp",
        Uuid::new_v4()
    ));
    let mut file = tokio::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary)
        .await
        .map_err(|error| cache_io_error(&error))?;
    let result = async {
        file.write_all(bytes)
            .await
            .map_err(|error| cache_io_error(&error))?;
        file.flush().await.map_err(|error| cache_io_error(&error))?;
        file.sync_all()
            .await
            .map_err(|error| cache_io_error(&error))?;
        drop(file);
        tokio::fs::rename(&temporary, destination)
            .await
            .map_err(|error| cache_io_error(&error))
    }
    .await;
    if result.is_err() {
        let _ = tokio::fs::remove_file(&temporary).await;
    }
    result
}

fn entry_name(steam_id: &str, hash: &str, extension: &str) -> String {
    format!("v{AVATAR_CACHE_VERSION}-{steam_id}-{hash}.{extension}")
}

fn parse_entry_name(name: &str) -> Option<(String, String, &'static str)> {
    let prefix = format!("v{AVATAR_CACHE_VERSION}-");
    let rest = name.strip_prefix(&prefix)?;
    let (steam_id, file) = rest.split_once('-')?;
    if !is_steam_id(steam_id) {
        return None;
    }
    let path = Path::new(file);
    let hash = path.file_stem()?.to_str()?;
    let extension = path.extension()?.to_str()?;
    let extension = if extension.eq_ignore_ascii_case("jpg") {
        "jpg"
    } else if extension.eq_ignore_ascii_case("png") {
        "png"
    } else if extension.eq_ignore_ascii_case("webp") {
        "webp"
    } else {
        return None;
    };
    (hash.len() == 64 && hash.bytes().all(|byte| byte.is_ascii_hexdigit()))
        .then(|| (steam_id.to_owned(), hash.to_ascii_lowercase(), extension))
}

fn is_temporary_name(name: &str) -> bool {
    name.starts_with(&format!(".avatar-v{AVATAR_CACHE_VERSION}-"))
        && Path::new(name)
            .extension()
            .is_some_and(|extension| extension.eq_ignore_ascii_case("tmp"))
        && name.len() <= 128
}

fn mime_extension(mime_type: &str) -> Option<&'static str> {
    match mime_type {
        "image/jpeg" => Some("jpg"),
        "image/png" => Some("png"),
        "image/webp" => Some("webp"),
        _ => None,
    }
}

fn hex_digest(bytes: &[u8]) -> String {
    use std::fmt::Write as _;

    let digest = Sha256::digest(bytes);
    let mut output = String::with_capacity(64);
    for byte in digest {
        let _ = write!(output, "{byte:02x}");
    }
    output
}

fn cache_io_error(error: &std::io::Error) -> DomainError {
    DomainError::Internal(format!("avatar cache I/O failed: {error}"))
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};

    use tempfile::TempDir;

    use super::*;

    const STEAM_ID: &str = "76561198000000001";

    fn image(marker: u8) -> SteamAvatarImage {
        SteamAvatarImage {
            bytes: vec![0xff, 0xd8, 0xff, marker],
            mime_type: "image/jpeg",
        }
    }

    #[tokio::test]
    async fn generated_avatar_is_reused() {
        let temporary = TempDir::new().expect("temp dir");
        let cache = AvatarCache::new(temporary.path().join("avatar-cache"));
        let count = AtomicUsize::new(0);
        let first = cache
            .resolve(STEAM_ID, || async {
                count.fetch_add(1, Ordering::SeqCst);
                Ok(image(1))
            })
            .await
            .expect("generate");
        let second = cache
            .resolve(STEAM_ID, || async {
                count.fetch_add(1, Ordering::SeqCst);
                Ok(image(2))
            })
            .await
            .expect("cache hit");

        assert!(!first.cached);
        assert!(second.cached);
        assert_eq!(first.bytes, second.bytes);
        assert_eq!(count.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn tampered_avatar_is_removed_and_refetched() {
        let temporary = TempDir::new().expect("temp dir");
        let cache = AvatarCache::new(temporary.path().join("avatar-cache"));
        cache
            .resolve(STEAM_ID, || async { Ok(image(1)) })
            .await
            .expect("generate");
        let (entries, _) = cache.scan_entries().await.expect("entries");
        tokio::fs::write(&entries[0].path, image(9).bytes)
            .await
            .expect("tamper");

        let repaired = cache
            .resolve(STEAM_ID, || async { Ok(image(2)) })
            .await
            .expect("repair");
        assert!(!repaired.cached);
        assert_eq!(repaired.bytes, image(2).bytes);
        assert_eq!(cache.status().await.expect("status").entries, 1);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn concurrent_requests_share_one_fetch() {
        let temporary = TempDir::new().expect("temp dir");
        let cache = Arc::new(AvatarCache::new(temporary.path().join("avatar-cache")));
        let count = Arc::new(AtomicUsize::new(0));
        let first_cache = Arc::clone(&cache);
        let first_count = Arc::clone(&count);
        let first = tokio::spawn(async move {
            first_cache
                .resolve(STEAM_ID, || async move {
                    first_count.fetch_add(1, Ordering::SeqCst);
                    tokio::time::sleep(std::time::Duration::from_millis(40)).await;
                    Ok(image(1))
                })
                .await
        });
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        let second_cache = Arc::clone(&cache);
        let second_count = Arc::clone(&count);
        let second = tokio::spawn(async move {
            second_cache
                .resolve(STEAM_ID, || async move {
                    second_count.fetch_add(1, Ordering::SeqCst);
                    Ok(image(2))
                })
                .await
        });

        let first = first.await.expect("first task").expect("first avatar");
        let second = second.await.expect("second task").expect("second avatar");
        assert_eq!(count.load(Ordering::SeqCst), 1);
        assert!(!first.cached);
        assert!(second.cached);
    }

    #[tokio::test]
    async fn limits_status_and_cleanup_are_enforced() {
        let temporary = TempDir::new().expect("temp dir");
        let cache = AvatarCache::new(temporary.path().join("avatar-cache"));
        let oversized = SteamAvatarImage {
            bytes: vec![0xff; MAXIMUM_STEAM_AVATAR_BYTES + 1],
            mime_type: "image/jpeg",
        };
        assert!(
            cache
                .resolve(STEAM_ID, || async { Ok(oversized) })
                .await
                .is_err()
        );
        cache
            .resolve(STEAM_ID, || async { Ok(image(1)) })
            .await
            .expect("valid avatar");
        let status = cache.status().await.expect("status");
        assert_eq!(status.entries, 1);
        assert!(status.bytes > 0);
        let cleanup = cache.clear().await.expect("cleanup");
        assert_eq!(cleanup.removed_entries, 1);
        assert!(cleanup.scan_complete);
        assert_eq!(cache.status().await.expect("empty").entries, 0);
    }
}
