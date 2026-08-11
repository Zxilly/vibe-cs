use std::{
    fs::OpenOptions,
    io::{BufReader, Read, Write},
    path::{Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
};

use async_trait::async_trait;
use futures_util::StreamExt;
use serde::Deserialize;
use tokio::io::AsyncWriteExt;
use tokio::sync::Notify;
use url::Url;

use crate::{IntegrationError, IntegrationResult, SecretString};

const MATCH_SHARING_ALPHABET: &[u8; 57] =
    b"ABCDEFGHJKLMNOPQRSTUVWXYZabcdefhijkmnopqrstuvwxyz23456789";

#[derive(Clone, PartialEq, Eq)]
pub struct MatchHistoryRequest {
    pub steam_id: String,
    pub authentication_code: SecretString,
    pub known_code: String,
    pub maximum_results: usize,
}

impl std::fmt::Debug for MatchHistoryRequest {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("MatchHistoryRequest")
            .field("steam_id", &self.steam_id)
            .field("authentication_code", &self.authentication_code)
            .field("known_code", &"[REDACTED]")
            .field("maximum_results", &self.maximum_results)
            .finish()
    }
}

impl MatchHistoryRequest {
    /// Validates Steam64 ID, sharing code, and result count.
    ///
    /// # Errors
    ///
    /// Returns an error when any field is outside its accepted format or range.
    pub fn validate(&self) -> IntegrationResult<()> {
        if self.steam_id.len() != 17
            || !self
                .steam_id
                .chars()
                .all(|character| character.is_ascii_digit())
        {
            return Err(IntegrationError::InvalidInput(
                "Steam ID must contain exactly 17 digits".to_owned(),
            ));
        }
        if !is_sharing_code(&self.known_code) {
            return Err(IntegrationError::InvalidInput(
                "known match code is invalid".to_owned(),
            ));
        }
        if !is_authentication_code(self.authentication_code.expose()) {
            return Err(IntegrationError::InvalidInput(
                "game authentication code must use the XXXX-XXXXX-XXXX format".to_owned(),
            ));
        }
        if !(1..=100).contains(&self.maximum_results) {
            return Err(IntegrationError::InvalidInput(
                "maximum_results must be between 1 and 100".to_owned(),
            ));
        }
        Ok(())
    }
}

fn is_authentication_code(value: &str) -> bool {
    let groups = value.split('-').collect::<Vec<_>>();
    groups.len() == 3
        && groups[0].len() == 4
        && groups[1].len() == 5
        && groups[2].len() == 4
        && groups.iter().all(|group| {
            group
                .chars()
                .all(|character| character.is_ascii_alphanumeric())
        })
}

fn is_sharing_code(value: &str) -> bool {
    let groups = value.split('-').collect::<Vec<_>>();
    groups.len() == 6
        && groups[0] == "CSGO"
        && groups[1..].iter().all(|group| {
            group.len() == 5
                && group
                    .bytes()
                    .all(|character| MATCH_SHARING_ALPHABET.contains(&character))
        })
}

#[derive(Clone, PartialEq, Eq)]
pub struct SteamMatchReference {
    pub sharing_code: String,
    pub match_id: u64,
    pub outcome_id: u64,
    pub token: u16,
}

impl std::fmt::Debug for SteamMatchReference {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("SteamMatchReference")
            .field("sharing_code", &"[REDACTED]")
            .field("match_id", &self.match_id)
            .field("outcome_id", &self.outcome_id)
            .field("token", &self.token)
            .finish()
    }
}

impl SteamMatchReference {
    /// Builds the bounded Valve replay URL represented by this match reference.
    ///
    /// # Errors
    ///
    /// Returns an error only if the internally generated URL cannot be parsed.
    pub fn replay_url(&self) -> IntegrationResult<Url> {
        let server = self.match_id % 10 + 131;
        Ok(Url::parse(&format!(
            "http://replay{server}.valve.net/730/{}_{}.dem.bz2",
            self.match_id, self.outcome_id
        ))?)
    }
}

/// Decodes Valve's 25-character base-57 match sharing code.
///
/// # Errors
///
/// Returns an error for malformed prefixes, groups, alphabet characters, or overflow.
pub fn decode_match_sharing_code(value: &str) -> IntegrationResult<SteamMatchReference> {
    if !is_sharing_code(value) {
        return Err(IntegrationError::InvalidInput(
            "match sharing code is invalid".to_owned(),
        ));
    }
    let compact = value
        .strip_prefix("CSGO-")
        .unwrap_or_default()
        .bytes()
        .filter(|byte| *byte != b'-')
        .collect::<Vec<_>>();
    let mut decoded = [0_u8; 18];
    for character in compact.iter().rev() {
        let digit = MATCH_SHARING_ALPHABET
            .iter()
            .position(|candidate| candidate == character)
            .ok_or_else(|| {
                IntegrationError::InvalidInput(
                    "match sharing code contains an unsupported character".to_owned(),
                )
            })?;
        let mut carry = u16::try_from(digit).unwrap_or(u16::MAX);
        for byte in &mut decoded {
            let value = u16::from(*byte) * 57 + carry;
            *byte = u8::try_from(value & 0xff).unwrap_or_default();
            carry = value >> 8;
        }
        if carry != 0 {
            return Err(IntegrationError::InvalidInput(
                "match sharing code exceeds the supported identifier size".to_owned(),
            ));
        }
    }
    Ok(SteamMatchReference {
        sharing_code: value.to_owned(),
        match_id: u64::from_le_bytes(decoded[0..8].try_into().unwrap_or_default()),
        outcome_id: u64::from_le_bytes(decoded[8..16].try_into().unwrap_or_default()),
        token: u16::from_le_bytes(decoded[16..18].try_into().unwrap_or_default()),
    })
}

#[async_trait]
pub trait SteamMatchHistoryPort: Send + Sync {
    async fn history(
        &self,
        request: MatchHistoryRequest,
    ) -> IntegrationResult<Vec<SteamMatchReference>>;
}

#[derive(Debug, Clone)]
pub struct SteamWebClient {
    http: reqwest::Client,
    api_key: SecretString,
    endpoint: Url,
}

impl SteamWebClient {
    /// Creates the Steam HTTP adapter.
    ///
    /// # Errors
    ///
    /// Returns an error if the bounded HTTP client or fixed API URL cannot be created.
    pub fn new(api_key: SecretString) -> IntegrationResult<Self> {
        Ok(Self {
            http: reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(30))
                .redirect(reqwest::redirect::Policy::none())
                .build()?,
            api_key,
            endpoint: Url::parse(
                "https://api.steampowered.com/ICSGOPlayers_730/GetNextMatchSharingCode/v1/",
            )?,
        })
    }
}

#[derive(Debug, Deserialize)]
struct NextCodeResponse {
    result: NextCodeResult,
}

#[derive(Debug, Deserialize)]
struct NextCodeResult {
    nextcode: Option<String>,
}

#[async_trait]
impl SteamMatchHistoryPort for SteamWebClient {
    async fn history(
        &self,
        request: MatchHistoryRequest,
    ) -> IntegrationResult<Vec<SteamMatchReference>> {
        request.validate()?;
        if self.api_key.is_empty() {
            return Err(IntegrationError::NotConfigured {
                integration: "Steam Web API",
                message: "API key is empty".to_owned(),
            });
        }
        let mut known = request.known_code;
        let mut matches = Vec::new();
        for _ in 0..request.maximum_results {
            let response = self
                .http
                .get(self.endpoint.clone())
                .query(&[
                    ("key", self.api_key.expose()),
                    ("steamid", request.steam_id.as_str()),
                    ("steamidkey", request.authentication_code.expose()),
                    ("knowncode", known.as_str()),
                ])
                .send()
                .await?;
            let status = response.status();
            let bytes = response.bytes().await?;
            if bytes.len() > 256 * 1024 {
                return Err(IntegrationError::ResponseLimit(256 * 1024));
            }
            if !status.is_success() {
                return Err(IntegrationError::HttpStatus {
                    status: status.as_u16(),
                    message: String::from_utf8_lossy(&bytes).chars().take(500).collect(),
                });
            }
            let response: NextCodeResponse = serde_json::from_slice(&bytes)?;
            let Some(next) = response
                .result
                .nextcode
                .filter(|code| is_sharing_code(code))
            else {
                break;
            };
            if next == known {
                return Err(IntegrationError::Protocol(
                    "Steam returned a repeated match code".to_owned(),
                ));
            }
            known.clone_from(&next);
            matches.push(decode_match_sharing_code(&next)?);
            if matches.len() < request.maximum_results {
                tokio::time::sleep(std::time::Duration::from_secs(1)).await;
            }
        }
        Ok(matches)
    }
}

#[derive(Debug, Clone)]
pub struct DemoDownloadRequest {
    pub url: Url,
    pub destination: PathBuf,
    pub maximum_bytes: u64,
}

impl DemoDownloadRequest {
    /// Validates Valve host, archive suffix, destination, and size bound.
    ///
    /// # Errors
    ///
    /// Returns an error when the request could escape the supported download boundary.
    pub fn validate(&self) -> IntegrationResult<()> {
        let host = self.url.host_str().unwrap_or_default().to_ascii_lowercase();
        if !matches!(self.url.scheme(), "http" | "https")
            || !(host == "replay.valve.net"
                || (host.starts_with("replay") && host.ends_with(".valve.net")))
            || !self.url.path().to_ascii_lowercase().ends_with(".dem.bz2")
        {
            return Err(IntegrationError::InvalidInput(
                "demo URL must be a Valve replay .dem.bz2 URL".to_owned(),
            ));
        }
        if self.url.username() != "" || self.url.password().is_some() {
            return Err(IntegrationError::InvalidInput(
                "demo URL must not embed credentials".to_owned(),
            ));
        }
        if self.maximum_bytes == 0 || self.maximum_bytes > 2 * 1024 * 1024 * 1024 {
            return Err(IntegrationError::InvalidInput(
                "invalid demo download size limit".to_owned(),
            ));
        }
        if self
            .destination
            .extension()
            .and_then(|value| value.to_str())
            .is_none_or(|value| !value.eq_ignore_ascii_case("bz2"))
        {
            return Err(IntegrationError::InvalidInput(
                "download destination must end in .bz2".to_owned(),
            ));
        }
        Ok(())
    }
}

#[async_trait]
pub trait DemoDownloadPort: Send + Sync {
    async fn download_archive(&self, request: DemoDownloadRequest) -> IntegrationResult<PathBuf>;

    async fn download_archive_observed(
        &self,
        request: DemoDownloadRequest,
        cancellation: DownloadCancellation,
        observer: Option<Arc<dyn DemoDownloadObserver>>,
    ) -> IntegrationResult<PathBuf> {
        if cancellation.is_cancelled() {
            return Err(IntegrationError::Cancelled);
        }
        let path = self.download_archive(request).await?;
        if let Some(observer) = observer {
            let size = tokio::fs::metadata(&path)
                .await
                .map(|metadata| metadata.len())
                .unwrap_or_default();
            observer
                .update(DemoDownloadProgress {
                    downloaded_bytes: size,
                    total_bytes: Some(size),
                })
                .await?;
        }
        Ok(path)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DemoDownloadProgress {
    pub downloaded_bytes: u64,
    pub total_bytes: Option<u64>,
}

#[async_trait]
pub trait DemoDownloadObserver: Send + Sync + std::fmt::Debug {
    async fn update(&self, progress: DemoDownloadProgress) -> IntegrationResult<()>;
}

#[derive(Debug, Default)]
struct DownloadCancellationState {
    cancelled: AtomicBool,
    notify: Notify,
}

#[derive(Debug, Clone, Default)]
pub struct DownloadCancellation(Arc<DownloadCancellationState>);

impl DownloadCancellation {
    pub fn cancel(&self) {
        self.0.cancelled.store(true, Ordering::Release);
        self.0.notify.notify_waiters();
        self.0.notify.notify_one();
    }

    #[must_use]
    pub fn is_cancelled(&self) -> bool {
        self.0.cancelled.load(Ordering::Acquire)
    }

    pub async fn cancelled(&self) {
        if self.is_cancelled() {
            return;
        }
        let notified = self.0.notify.notified();
        if self.is_cancelled() {
            return;
        }
        notified.await;
    }
}

#[async_trait]
impl DemoDownloadPort for SteamWebClient {
    async fn download_archive(&self, request: DemoDownloadRequest) -> IntegrationResult<PathBuf> {
        self.download_archive_inner(request, DownloadCancellation::default(), None)
            .await
    }

    async fn download_archive_observed(
        &self,
        request: DemoDownloadRequest,
        cancellation: DownloadCancellation,
        observer: Option<Arc<dyn DemoDownloadObserver>>,
    ) -> IntegrationResult<PathBuf> {
        self.download_archive_inner(request, cancellation, observer)
            .await
    }
}

impl SteamWebClient {
    async fn download_archive_inner(
        &self,
        request: DemoDownloadRequest,
        cancellation: DownloadCancellation,
        observer: Option<Arc<dyn DemoDownloadObserver>>,
    ) -> IntegrationResult<PathBuf> {
        request.validate()?;
        if cancellation.is_cancelled() {
            return Err(IntegrationError::Cancelled);
        }
        if request.destination.exists() {
            return Err(IntegrationError::InvalidInput(
                "download destination already exists".to_owned(),
            ));
        }
        let parent = request
            .destination
            .parent()
            .filter(|path| path.is_dir())
            .ok_or_else(|| {
                IntegrationError::InvalidInput(
                    "download destination directory does not exist".to_owned(),
                )
            })?
            .to_path_buf();
        let response = tokio::select! {
            () = cancellation.cancelled() => return Err(IntegrationError::Cancelled),
            response = self.http.get(request.url).send() => response?,
        };
        if !response.status().is_success() {
            return Err(IntegrationError::HttpStatus {
                status: response.status().as_u16(),
                message: "demo download failed".to_owned(),
            });
        }
        let content_length = response.content_length();
        if content_length.is_some_and(|length| length > request.maximum_bytes) {
            return Err(IntegrationError::ResponseLimit(usize_limit(
                request.maximum_bytes,
            )));
        }
        let temporary = parent.join(format!(
            ".{}.partial.{}",
            request
                .destination
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap_or("demo.bz2"),
            uuid::Uuid::new_v4(),
        ));
        if temporary.exists() {
            return Err(IntegrationError::InvalidInput(
                "temporary download path already exists".to_owned(),
            ));
        }
        let result = async {
            let mut output = tokio::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&temporary)
                .await
                .map_err(|source| IntegrationError::Io {
                    path: temporary.clone(),
                    source,
                })?;
            let mut stream = response.bytes_stream();
            let mut written = 0_u64;
            loop {
                let chunk = tokio::select! {
                    () = cancellation.cancelled() => return Err(IntegrationError::Cancelled),
                    chunk = stream.next() => chunk,
                };
                let Some(chunk) = chunk else { break };
                let chunk = chunk?;
                written = written
                    .checked_add(u64::try_from(chunk.len()).unwrap_or(u64::MAX))
                    .ok_or(IntegrationError::ResponseLimit(usize_limit(
                        request.maximum_bytes,
                    )))?;
                if written > request.maximum_bytes {
                    return Err(IntegrationError::ResponseLimit(usize_limit(
                        request.maximum_bytes,
                    )));
                }
                output
                    .write_all(&chunk)
                    .await
                    .map_err(|source| IntegrationError::Io {
                        path: temporary.clone(),
                        source,
                    })?;
                if let Some(observer) = &observer {
                    observer
                        .update(DemoDownloadProgress {
                            downloaded_bytes: written,
                            total_bytes: content_length,
                        })
                        .await?;
                }
            }
            output
                .flush()
                .await
                .map_err(|source| IntegrationError::Io {
                    path: temporary.clone(),
                    source,
                })?;
            output
                .sync_all()
                .await
                .map_err(|source| IntegrationError::Io {
                    path: temporary.clone(),
                    source,
                })?;
            if request.destination.exists() {
                return Err(IntegrationError::InvalidInput(
                    "download destination appeared during transfer".to_owned(),
                ));
            }
            tokio::fs::rename(&temporary, &request.destination)
                .await
                .map_err(|source| IntegrationError::Io {
                    path: request.destination.clone(),
                    source,
                })?;
            Ok::<_, IntegrationError>(())
        }
        .await;
        if result.is_err() {
            let _ = tokio::fs::remove_file(&temporary).await;
        }
        result?;
        Ok(request.destination)
    }
}

#[derive(Debug, Clone, Copy, Default)]
pub struct UnconfiguredSteamPort;

#[async_trait]
impl SteamMatchHistoryPort for UnconfiguredSteamPort {
    async fn history(
        &self,
        request: MatchHistoryRequest,
    ) -> IntegrationResult<Vec<SteamMatchReference>> {
        request.validate()?;
        Err(IntegrationError::NotConfigured {
            integration: "Steam match history",
            message: "no Steam history provider is configured".to_owned(),
        })
    }
}

#[async_trait]
impl DemoDownloadPort for UnconfiguredSteamPort {
    async fn download_archive(&self, request: DemoDownloadRequest) -> IntegrationResult<PathBuf> {
        request.validate()?;
        Err(IntegrationError::NotConfigured {
            integration: "Steam demo download",
            message: "no Steam download provider is configured".to_owned(),
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DemoDecompressionLimits {
    pub maximum_archive_bytes: u64,
    pub maximum_demo_bytes: u64,
}

impl Default for DemoDecompressionLimits {
    fn default() -> Self {
        Self {
            maximum_archive_bytes: 1024 * 1024 * 1024,
            maximum_demo_bytes: 2 * 1024 * 1024 * 1024,
        }
    }
}

/// Decompresses a demo archive using conservative default limits.
///
/// # Errors
///
/// Returns an error for invalid paths, limits, compression, magic, or atomic publication.
pub fn decompress_bz2_archive(archive: &Path, output: &Path) -> IntegrationResult<()> {
    decompress_bz2_archive_with_limits(archive, output, DemoDecompressionLimits::default())
}

/// Streams a `BZip2` demo archive into a synchronized same-directory temporary file.
///
/// # Errors
///
/// Returns an error when compressed/expanded limits are exceeded, the decoded
/// magic is invalid, output exists, or any I/O/publication step fails.
pub fn decompress_bz2_archive_with_limits(
    archive: &Path,
    output: &Path,
    limits: DemoDecompressionLimits,
) -> IntegrationResult<()> {
    decompress_bz2_archive_cancellable(archive, output, limits, &DownloadCancellation::default())
}

/// Decompresses a replay while observing a cooperative cancellation token.
///
/// # Errors
///
/// Returns the same failures as [`decompress_bz2_archive_with_limits`] plus cancellation.
pub fn decompress_bz2_archive_cancellable(
    archive: &Path,
    output: &Path,
    limits: DemoDecompressionLimits,
    cancellation: &DownloadCancellation,
) -> IntegrationResult<()> {
    if limits.maximum_archive_bytes == 0 || limits.maximum_demo_bytes < 16 {
        return Err(IntegrationError::InvalidConfiguration(
            "demo decompression limits are invalid".to_owned(),
        ));
    }
    let archive_metadata = std::fs::metadata(archive).map_err(|source| IntegrationError::Io {
        path: archive.to_path_buf(),
        source,
    })?;
    if !archive_metadata.is_file()
        || archive_metadata.len() > limits.maximum_archive_bytes
        || archive
            .extension()
            .and_then(|value| value.to_str())
            .is_none_or(|value| !value.eq_ignore_ascii_case("bz2"))
    {
        return Err(IntegrationError::InvalidInput(
            "archive must be a bounded .bz2 file".to_owned(),
        ));
    }
    if output.exists()
        || output
            .extension()
            .and_then(|value| value.to_str())
            .is_none_or(|value| !value.eq_ignore_ascii_case("dem"))
    {
        return Err(IntegrationError::InvalidInput(
            "demo output must be a new .dem path".to_owned(),
        ));
    }
    let parent = output
        .parent()
        .filter(|path| path.is_dir())
        .ok_or_else(|| {
            IntegrationError::InvalidInput("demo output directory does not exist".to_owned())
        })?;
    let name = output
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| {
            IntegrationError::InvalidInput("demo output has no valid file name".to_owned())
        })?;
    let temporary = parent.join(format!(".{name}.partial.{}", uuid::Uuid::new_v4()));
    if temporary.exists() {
        return Err(IntegrationError::InvalidInput(
            "temporary decompression path already exists".to_owned(),
        ));
    }

    let result =
        decompress_to_temporary(archive, &temporary, limits.maximum_demo_bytes, cancellation)
            .and_then(|()| {
                if output.exists() {
                    return Err(IntegrationError::InvalidInput(
                        "demo output appeared during decompression".to_owned(),
                    ));
                }
                std::fs::rename(&temporary, output).map_err(|source| IntegrationError::Io {
                    path: output.to_path_buf(),
                    source,
                })
            });
    if result.is_err() {
        let _ = std::fs::remove_file(&temporary);
    }
    result
}

fn decompress_to_temporary(
    archive: &Path,
    temporary: &Path,
    maximum_demo_bytes: u64,
    cancellation: &DownloadCancellation,
) -> IntegrationResult<()> {
    if cancellation.is_cancelled() {
        return Err(IntegrationError::Cancelled);
    }
    let archive_file = std::fs::File::open(archive).map_err(|source| IntegrationError::Io {
        path: archive.to_path_buf(),
        source,
    })?;
    let mut decoder = bzip2::read::BzDecoder::new(BufReader::new(archive_file));
    let mut magic = [0_u8; 8];
    decoder
        .read_exact(&mut magic)
        .map_err(|source| IntegrationError::Io {
            path: archive.to_path_buf(),
            source,
        })?;
    if &magic != b"PBDEMS2\0" {
        return Err(IntegrationError::InvalidInput(
            "decompressed file is not a Source 2 demo".to_owned(),
        ));
    }
    let mut output = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(temporary)
        .map_err(|source| IntegrationError::Io {
            path: temporary.to_path_buf(),
            source,
        })?;
    output
        .write_all(&magic)
        .map_err(|source| IntegrationError::Io {
            path: temporary.to_path_buf(),
            source,
        })?;
    let mut written = u64::try_from(magic.len()).unwrap_or(u64::MAX);
    let mut buffer = vec![0_u8; 64 * 1024];
    loop {
        if cancellation.is_cancelled() {
            return Err(IntegrationError::Cancelled);
        }
        let count = decoder
            .read(&mut buffer)
            .map_err(|source| IntegrationError::Io {
                path: archive.to_path_buf(),
                source,
            })?;
        if count == 0 {
            break;
        }
        written = written
            .checked_add(u64::try_from(count).unwrap_or(u64::MAX))
            .ok_or(IntegrationError::ResponseLimit(usize_limit(
                maximum_demo_bytes,
            )))?;
        if written > maximum_demo_bytes {
            return Err(IntegrationError::ResponseLimit(usize_limit(
                maximum_demo_bytes,
            )));
        }
        output
            .write_all(&buffer[..count])
            .map_err(|source| IntegrationError::Io {
                path: temporary.to_path_buf(),
                source,
            })?;
    }
    output.flush().map_err(|source| IntegrationError::Io {
        path: temporary.to_path_buf(),
        source,
    })?;
    output.sync_all().map_err(|source| IntegrationError::Io {
        path: temporary.to_path_buf(),
        source,
    })
}

fn usize_limit(value: u64) -> usize {
    usize::try_from(value).unwrap_or(usize::MAX)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_history_identifiers() {
        let mut request = MatchHistoryRequest {
            steam_id: "76561198000000000".to_owned(),
            authentication_code: SecretString::new("ABCD-EFGHI-JKLM"),
            known_code: "CSGO-ABCDE-ABCDE-ABCDE-ABCDE-ABCDE".to_owned(),
            maximum_results: 5,
        };
        assert!(request.validate().is_ok());
        let rendered = format!("{request:?}");
        assert!(!rendered.contains("ABCD-EFGHI-JKLM"));
        assert!(!rendered.contains("CSGO-ABCDE"));
        request.known_code = "CSGO-ABCDI-ABCDE-ABCDE-ABCDE-ABCDE".to_owned();
        assert!(request.validate().is_err());
    }

    #[test]
    fn download_rejects_non_valve_hosts() {
        let request = DemoDownloadRequest {
            url: Url::parse("https://evil.example/match.dem.bz2").unwrap(),
            destination: PathBuf::from("match.dem.bz2"),
            maximum_bytes: 1024,
        };
        assert!(request.validate().is_err());
    }

    #[test]
    fn download_accepts_valves_http_only_replay_hosts() {
        let request = DemoDownloadRequest {
            url: Url::parse("http://replay131.valve.net/730/1_2.dem.bz2").unwrap(),
            destination: PathBuf::from("match.dem.bz2"),
            maximum_bytes: 1024,
        };
        assert!(request.validate().is_ok());
    }

    #[tokio::test]
    async fn unconfigured_port_is_explicit() {
        let error = UnconfiguredSteamPort
            .history(MatchHistoryRequest {
                steam_id: "76561198000000000".to_owned(),
                authentication_code: SecretString::new("ABCD-EFGHI-JKLM"),
                known_code: "CSGO-ABCDE-ABCDE-ABCDE-ABCDE-ABCDE".to_owned(),
                maximum_results: 1,
            })
            .await
            .unwrap_err();
        assert!(matches!(error, IntegrationError::NotConfigured { .. }));
    }

    #[test]
    fn decompresses_valid_demo_atomically() {
        use bzip2::{Compression, write::BzEncoder};

        let root = tempfile::tempdir().unwrap();
        let archive = root.path().join("match.dem.bz2");
        let mut encoder = BzEncoder::new(Vec::new(), Compression::best());
        encoder.write_all(b"PBDEMS2\0abcdefgh").unwrap();
        std::fs::write(&archive, encoder.finish().unwrap()).unwrap();
        let output = root.path().join("match.dem");
        decompress_bz2_archive_with_limits(
            &archive,
            &output,
            DemoDecompressionLimits {
                maximum_archive_bytes: 1024,
                maximum_demo_bytes: 16,
            },
        )
        .unwrap();
        assert_eq!(std::fs::read(output).unwrap(), b"PBDEMS2\0abcdefgh");
    }

    #[test]
    fn decompression_rejects_wrong_magic_without_publishing() {
        use bzip2::{Compression, write::BzEncoder};

        let root = tempfile::tempdir().unwrap();
        let archive = root.path().join("bad.dem.bz2");
        let mut encoder = BzEncoder::new(Vec::new(), Compression::best());
        encoder.write_all(b"NOTADEMOabcdefgh").unwrap();
        std::fs::write(&archive, encoder.finish().unwrap()).unwrap();
        let output = root.path().join("bad.dem");
        assert!(matches!(
            decompress_bz2_archive(&archive, &output),
            Err(IntegrationError::InvalidInput(_))
        ));
        assert!(!output.exists());
    }

    #[test]
    fn sharing_code_decoder_preserves_all_three_identifiers() {
        let mut bytes = [0_u8; 18];
        bytes[0..8].copy_from_slice(&12_345_678_901_234_567_u64.to_le_bytes());
        bytes[8..16].copy_from_slice(&98_765_432_109_876_543_u64.to_le_bytes());
        bytes[16..18].copy_from_slice(&42_123_u16.to_le_bytes());
        let mut digits = Vec::with_capacity(25);
        for _ in 0..25 {
            let mut remainder = 0_u16;
            for byte in bytes.iter_mut().rev() {
                let value = (remainder << 8) | u16::from(*byte);
                *byte = u8::try_from(value / 57).unwrap_or_default();
                remainder = value % 57;
            }
            digits.push(MATCH_SHARING_ALPHABET[usize::from(remainder)] as char);
        }
        let compact = digits.into_iter().collect::<String>();
        let code = format!(
            "CSGO-{}-{}-{}-{}-{}",
            &compact[0..5],
            &compact[5..10],
            &compact[10..15],
            &compact[15..20],
            &compact[20..25]
        );

        let decoded = decode_match_sharing_code(&code).expect("decode sharing code");
        assert_eq!(decoded.match_id, 12_345_678_901_234_567);
        assert_eq!(decoded.outcome_id, 98_765_432_109_876_543);
        assert_eq!(decoded.token, 42_123);
        assert_eq!(decoded.sharing_code, code);
    }

    #[test]
    fn cancelled_decompression_never_publishes_output() {
        use bzip2::{Compression, write::BzEncoder};

        let root = tempfile::tempdir().unwrap();
        let archive = root.path().join("cancel.dem.bz2");
        let mut encoder = BzEncoder::new(Vec::new(), Compression::best());
        encoder.write_all(b"PBDEMS2\0abcdefgh").unwrap();
        std::fs::write(&archive, encoder.finish().unwrap()).unwrap();
        let output = root.path().join("cancel.dem");
        let cancellation = DownloadCancellation::default();
        cancellation.cancel();

        assert!(matches!(
            decompress_bz2_archive_cancellable(
                &archive,
                &output,
                DemoDecompressionLimits::default(),
                &cancellation,
            ),
            Err(IntegrationError::Cancelled)
        ));
        assert!(!output.exists());
    }
}
