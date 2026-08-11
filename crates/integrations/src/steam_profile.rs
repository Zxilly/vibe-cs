use std::time::Duration;

use async_trait::async_trait;
use futures_util::StreamExt;
use serde::Deserialize;
use url::Url;

use crate::{IntegrationError, IntegrationResult, SecretString};

const PLAYER_SUMMARIES_ENDPOINT: &str =
    "https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v0002/";
const MAXIMUM_PROFILE_RESPONSE_BYTES: usize = 1024 * 1024;
pub const MAXIMUM_STEAM_PROFILE_IDS: usize = 100;
pub const MAXIMUM_STEAM_AVATAR_BYTES: usize = 1024 * 1024;
const MAXIMUM_PERSONA_CHARS: usize = 128;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SteamPlayerSummary {
    pub steam_id: String,
    pub persona_name: String,
    pub profile_url: Option<Url>,
    pub avatar_url: Option<Url>,
    pub real_name: Option<String>,
    pub country_code: Option<String>,
    pub persona_state: Option<u8>,
    pub last_logoff: Option<u64>,
    pub created_at: Option<u64>,
}

#[derive(Clone, PartialEq, Eq)]
pub struct SteamAvatarImage {
    pub bytes: Vec<u8>,
    pub mime_type: &'static str,
}

impl std::fmt::Debug for SteamAvatarImage {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("SteamAvatarImage")
            .field("bytes", &self.bytes.len())
            .field("mime_type", &self.mime_type)
            .finish()
    }
}

#[async_trait]
pub trait SteamPlayerProfilePort: Send + Sync {
    async fn summaries(&self, steam_ids: &[String]) -> IntegrationResult<Vec<SteamPlayerSummary>>;

    async fn avatar(&self, url: &Url) -> IntegrationResult<SteamAvatarImage>;
}

#[derive(Debug, Clone)]
pub struct SteamProfileClient {
    http: reqwest::Client,
    api_key: SecretString,
    summaries_endpoint: Url,
}

impl SteamProfileClient {
    /// Creates a client pinned to Valve's official player summaries endpoint.
    ///
    /// # Errors
    ///
    /// Returns an error when the bounded HTTP client or fixed endpoint cannot be built.
    pub fn new(api_key: SecretString) -> IntegrationResult<Self> {
        Self::with_endpoint(
            api_key,
            Url::parse(PLAYER_SUMMARIES_ENDPOINT)?,
            Duration::from_secs(12),
        )
    }

    fn with_endpoint(
        api_key: SecretString,
        summaries_endpoint: Url,
        timeout: Duration,
    ) -> IntegrationResult<Self> {
        Ok(Self {
            http: reqwest::Client::builder()
                .connect_timeout(Duration::from_secs(5))
                .timeout(timeout)
                .redirect(reqwest::redirect::Policy::none())
                .build()?,
            api_key,
            summaries_endpoint,
        })
    }
}

#[derive(Debug, Deserialize)]
struct PlayerSummariesEnvelope {
    response: PlayerSummariesResponse,
}

#[derive(Debug, Deserialize)]
struct PlayerSummariesResponse {
    #[serde(default)]
    players: Vec<RawPlayerSummary>,
}

#[derive(Debug, Deserialize)]
struct RawPlayerSummary {
    steamid: String,
    personaname: String,
    #[serde(default)]
    profileurl: Option<String>,
    #[serde(default)]
    avatar: Option<String>,
    #[serde(default)]
    avatarmedium: Option<String>,
    #[serde(default)]
    avatarfull: Option<String>,
    #[serde(default)]
    realname: Option<String>,
    #[serde(default)]
    loccountrycode: Option<String>,
    #[serde(default)]
    personastate: Option<u8>,
    #[serde(default)]
    lastlogoff: Option<u64>,
    #[serde(default)]
    timecreated: Option<u64>,
}

#[async_trait]
impl SteamPlayerProfilePort for SteamProfileClient {
    async fn summaries(&self, steam_ids: &[String]) -> IntegrationResult<Vec<SteamPlayerSummary>> {
        validate_steam_ids(steam_ids)?;
        if self.api_key.is_empty() {
            return Err(IntegrationError::NotConfigured {
                integration: "Steam Web API",
                message: "API key is empty".to_owned(),
            });
        }
        let joined = steam_ids.join(",");
        let response = self
            .http
            .get(self.summaries_endpoint.clone())
            .query(&[
                ("key", self.api_key.expose()),
                ("steamids", joined.as_str()),
            ])
            .send()
            .await
            .map_err(sanitized_http_error)?;
        if !response.status().is_success() {
            return Err(IntegrationError::HttpStatus {
                status: response.status().as_u16(),
                message: "Steam player summaries request failed".to_owned(),
            });
        }
        let bytes = read_bounded_response(response, MAXIMUM_PROFILE_RESPONSE_BYTES).await?;
        let response: PlayerSummariesEnvelope = serde_json::from_slice(&bytes)?;
        let requested = steam_ids
            .iter()
            .map(String::as_str)
            .collect::<std::collections::HashSet<_>>();
        let mut summaries = Vec::with_capacity(response.response.players.len());
        for raw in response.response.players {
            if !requested.contains(raw.steamid.as_str()) || !is_steam_id(&raw.steamid) {
                return Err(IntegrationError::Protocol(
                    "Steam returned an unexpected player identifier".to_owned(),
                ));
            }
            summaries.push(normalize_summary(raw)?);
        }
        summaries.sort_by(|left, right| left.steam_id.cmp(&right.steam_id));
        summaries.dedup_by(|left, right| left.steam_id == right.steam_id);
        Ok(summaries)
    }

    async fn avatar(&self, url: &Url) -> IntegrationResult<SteamAvatarImage> {
        validate_avatar_url(url)?;
        let response = self
            .http
            .get(url.clone())
            .send()
            .await
            .map_err(sanitized_http_error)?;
        if !response.status().is_success() {
            return Err(IntegrationError::HttpStatus {
                status: response.status().as_u16(),
                message: "Steam avatar request failed".to_owned(),
            });
        }
        let declared_type = response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.split(';').next())
            .map(str::trim)
            .map(str::to_ascii_lowercase);
        let bytes = read_bounded_response(response, MAXIMUM_STEAM_AVATAR_BYTES).await?;
        let mime_type = detect_steam_avatar_mime(&bytes).ok_or_else(|| {
            IntegrationError::Protocol("Steam avatar is not a supported image".to_owned())
        })?;
        if declared_type.is_some_and(|declared| declared != mime_type) {
            return Err(IntegrationError::Protocol(
                "Steam avatar content type does not match its bytes".to_owned(),
            ));
        }
        Ok(SteamAvatarImage { bytes, mime_type })
    }
}

fn normalize_summary(raw: RawPlayerSummary) -> IntegrationResult<SteamPlayerSummary> {
    let persona_name = bounded_required_text(&raw.personaname, "Steam persona name")?;
    let real_name = raw
        .realname
        .as_deref()
        .map(|value| bounded_optional_text(value, "Steam real name"))
        .transpose()?
        .flatten();
    let country_code = raw.loccountrycode.and_then(|value| {
        let value = value.trim().to_ascii_uppercase();
        (value.len() == 2 && value.bytes().all(|byte| byte.is_ascii_alphabetic())).then_some(value)
    });
    let profile_url = raw
        .profileurl
        .and_then(|value| Url::parse(&value).ok())
        .filter(|url| valid_profile_url(url, &raw.steamid));
    let avatar_url = raw
        .avatarfull
        .or(raw.avatarmedium)
        .or(raw.avatar)
        .and_then(|value| Url::parse(&value).ok())
        .filter(|url| validate_avatar_url(url).is_ok());
    Ok(SteamPlayerSummary {
        steam_id: raw.steamid,
        persona_name,
        profile_url,
        avatar_url,
        real_name,
        country_code,
        persona_state: raw.personastate,
        last_logoff: raw.lastlogoff,
        created_at: raw.timecreated,
    })
}

fn bounded_required_text(value: &str, field: &str) -> IntegrationResult<String> {
    bounded_optional_text(value, field)?
        .ok_or_else(|| IntegrationError::Protocol(format!("{field} is empty")))
}

fn bounded_optional_text(value: &str, field: &str) -> IntegrationResult<Option<String>> {
    let value = value.trim();
    if value.is_empty() {
        return Ok(None);
    }
    if value.chars().count() > MAXIMUM_PERSONA_CHARS || value.contains(['\r', '\n', '\0']) {
        return Err(IntegrationError::Protocol(format!("{field} is invalid")));
    }
    Ok(Some(value.to_owned()))
}

fn validate_steam_ids(steam_ids: &[String]) -> IntegrationResult<()> {
    if steam_ids.is_empty() || steam_ids.len() > MAXIMUM_STEAM_PROFILE_IDS {
        return Err(IntegrationError::InvalidInput(format!(
            "Steam player summary requests require between 1 and {MAXIMUM_STEAM_PROFILE_IDS} IDs"
        )));
    }
    if steam_ids.iter().any(|steam_id| !is_steam_id(steam_id)) {
        return Err(IntegrationError::InvalidInput(
            "Steam ID must contain exactly 17 digits".to_owned(),
        ));
    }
    Ok(())
}

#[must_use]
pub fn is_steam_id(value: &str) -> bool {
    if value.len() != 17 || !value.bytes().all(|byte| byte.is_ascii_digit()) {
        return false;
    }
    let Ok(steam_id) = value.parse::<u64>() else {
        return false;
    };
    let universe = (steam_id >> 56) & 0xff;
    let account_type = (steam_id >> 52) & 0x0f;
    let instance = (steam_id >> 32) & 0x000f_ffff;
    let account_id = steam_id & u64::from(u32::MAX);
    universe == 1 && account_type == 1 && instance == 1 && account_id != 0
}

/// Restricts avatar downloads to the fixed HTTPS Steam avatar CDN boundary.
///
/// # Errors
///
/// Returns an error for non-HTTPS URLs, userinfo, custom ports, unknown hosts,
/// query/fragment data, or unexpected avatar paths.
pub fn validate_avatar_url(url: &Url) -> IntegrationResult<()> {
    let valid_host = matches!(
        url.host_str(),
        Some("avatars.steamstatic.com" | "avatars.cloudflare.steamstatic.com")
    );
    let file_name = url
        .path_segments()
        .and_then(Iterator::last)
        .unwrap_or_default();
    let stem = file_name.strip_suffix(".jpg").unwrap_or_default();
    let hash = stem
        .strip_suffix("_full")
        .or_else(|| stem.strip_suffix("_medium"))
        .unwrap_or(stem);
    if url.scheme() != "https"
        || !valid_host
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some_and(|port| port != 443)
        || url.query().is_some()
        || url.fragment().is_some()
        || url
            .path_segments()
            .is_none_or(|segments| segments.count() != 1)
        || hash.len() != 40
        || !hash.bytes().all(|byte| byte.is_ascii_hexdigit())
    {
        return Err(IntegrationError::InvalidInput(
            "Steam avatar URL is outside the fixed CDN boundary".to_owned(),
        ));
    }
    Ok(())
}

fn valid_profile_url(url: &Url, steam_id: &str) -> bool {
    url.scheme() == "https"
        && url.host_str() == Some("steamcommunity.com")
        && url.username().is_empty()
        && url.password().is_none()
        && url.port().is_none_or(|port| port == 443)
        && url.query().is_none()
        && url.fragment().is_none()
        && url.path().trim_end_matches('/') == format!("/profiles/{steam_id}")
}

#[must_use]
pub fn detect_steam_avatar_mime(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(&[0xff, 0xd8, 0xff]) {
        Some("image/jpeg")
    } else if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("image/png")
    } else if bytes.len() >= 12 && bytes.starts_with(b"RIFF") && &bytes[8..12] == b"WEBP" {
        Some("image/webp")
    } else {
        None
    }
}

async fn read_bounded_response(
    response: reqwest::Response,
    maximum_bytes: usize,
) -> IntegrationResult<Vec<u8>> {
    if response
        .content_length()
        .is_some_and(|length| length > u64::try_from(maximum_bytes).unwrap_or(u64::MAX))
    {
        return Err(IntegrationError::ResponseLimit(maximum_bytes));
    }
    let mut stream = response.bytes_stream();
    let mut bytes = Vec::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(sanitized_http_error)?;
        let next_length = bytes
            .len()
            .checked_add(chunk.len())
            .ok_or(IntegrationError::ResponseLimit(maximum_bytes))?;
        if next_length > maximum_bytes {
            return Err(IntegrationError::ResponseLimit(maximum_bytes));
        }
        bytes
            .try_reserve(chunk.len())
            .map_err(|_| IntegrationError::ResponseLimit(maximum_bytes))?;
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

fn sanitized_http_error(_error: reqwest::Error) -> IntegrationError {
    IntegrationError::Unavailable {
        integration: "Steam Web API",
        message: "bounded HTTPS request failed".to_owned(),
    }
}

#[cfg(test)]
mod tests {
    use std::fmt::Write as _;

    use tokio::{
        io::{AsyncReadExt, AsyncWriteExt},
        net::TcpListener,
        sync::oneshot,
    };

    use super::*;

    async fn fake_http(response: String) -> (Url, oneshot::Receiver<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("listener");
        let address = listener.local_addr().expect("address");
        let (request_sender, request_receiver) = oneshot::channel();
        tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.expect("accept");
            let mut request = vec![0_u8; 8 * 1024];
            let length = socket.read(&mut request).await.expect("read request");
            let _ = request_sender.send(String::from_utf8_lossy(&request[..length]).into_owned());
            socket
                .write_all(response.as_bytes())
                .await
                .expect("write response");
        });
        (
            Url::parse(&format!("http://{address}/players")).expect("URL"),
            request_receiver,
        )
    }

    fn response(status: &str, headers: &[(&str, String)], body: &str) -> String {
        let mut response = format!("HTTP/1.1 {status}\r\nConnection: close\r\n");
        for (name, value) in headers {
            let _ = write!(response, "{name}: {value}\r\n");
        }
        response.push_str("\r\n");
        response.push_str(body);
        response
    }

    #[tokio::test]
    async fn summaries_use_bounded_request_and_normalize_trusted_fields() {
        let body = r#"{"response":{"players":[{"steamid":"76561198000000001","personaname":"Player","profileurl":"https://steamcommunity.com/profiles/76561198000000001/","avatarfull":"https://avatars.steamstatic.com/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa_full.jpg","realname":"Real Name","loccountrycode":"cn","personastate":1}]}}"#;
        let (endpoint, request) = fake_http(response(
            "200 OK",
            &[
                ("Content-Type", "application/json".to_owned()),
                ("Content-Length", body.len().to_string()),
            ],
            body,
        ))
        .await;
        let client = SteamProfileClient::with_endpoint(
            SecretString::new("secret-key"),
            endpoint,
            Duration::from_secs(2),
        )
        .expect("client");
        let profiles = client
            .summaries(&["76561198000000001".to_owned()])
            .await
            .expect("profiles");

        assert_eq!(profiles[0].persona_name, "Player");
        assert_eq!(profiles[0].country_code.as_deref(), Some("CN"));
        assert_eq!(
            profiles[0].avatar_url.as_ref().and_then(Url::host_str),
            Some("avatars.steamstatic.com")
        );
        let request = request.await.expect("captured request");
        assert!(request.starts_with("GET /players?"));
        assert!(request.contains("steamids=76561198000000001"));
    }

    #[tokio::test]
    async fn summaries_do_not_follow_redirects() {
        let (endpoint, _) = fake_http(response(
            "302 Found",
            &[("Location", "https://evil.example/".to_owned())],
            "",
        ))
        .await;
        let client = SteamProfileClient::with_endpoint(
            SecretString::new("secret-key"),
            endpoint,
            Duration::from_secs(2),
        )
        .expect("client");
        let error = client
            .summaries(&["76561198000000001".to_owned()])
            .await
            .expect_err("redirect must fail");
        assert!(matches!(
            error,
            IntegrationError::HttpStatus { status: 302, .. }
        ));
    }

    #[tokio::test]
    async fn summaries_reject_declared_oversize_before_reading_body() {
        let (endpoint, _) = fake_http(response(
            "200 OK",
            &[(
                "Content-Length",
                (MAXIMUM_PROFILE_RESPONSE_BYTES + 1).to_string(),
            )],
            "",
        ))
        .await;
        let client = SteamProfileClient::with_endpoint(
            SecretString::new("secret-key"),
            endpoint,
            Duration::from_secs(2),
        )
        .expect("client");
        let error = client
            .summaries(&["76561198000000001".to_owned()])
            .await
            .expect_err("oversize must fail");
        assert!(matches!(error, IntegrationError::ResponseLimit(_)));
    }

    #[tokio::test]
    async fn summaries_reject_more_than_one_hundred_ids_without_http() {
        let client = SteamProfileClient::new(SecretString::new("secret-key")).expect("client");
        let ids = (0..=MAXIMUM_STEAM_PROFILE_IDS)
            .map(|index| format!("7656119{index:010}"))
            .collect::<Vec<_>>();
        assert!(matches!(
            client.summaries(&ids).await,
            Err(IntegrationError::InvalidInput(_))
        ));
    }

    #[test]
    fn avatar_boundary_rejects_ssrf_shapes() {
        assert!(
            validate_avatar_url(&Url::parse("https://avatars.steamstatic.com/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa_full.jpg").unwrap()).is_ok()
        );
        for url in [
            "http://avatars.steamstatic.com/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa_full.jpg",
            "https://evil.example/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa_full.jpg",
            "https://avatars.steamstatic.com.evil.example/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa_full.jpg",
            "https://avatars.steamstatic.com/../../metadata",
            "https://avatars.steamstatic.com/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa_full.jpg?next=http://127.0.0.1",
        ] {
            assert!(
                validate_avatar_url(&Url::parse(url).unwrap()).is_err(),
                "{url}"
            );
        }
    }

    #[test]
    fn steam_id_requires_a_public_individual_desktop_identity() {
        assert!(is_steam_id("76561198000000001"));
        for invalid in [
            "72057598332895233", // account type 0
            "76561193665298433", // instance 0
            "76561197960265728", // account id 0
        ] {
            assert_eq!(invalid.len(), 17);
            assert!(!is_steam_id(invalid), "{invalid}");
        }
    }

    #[test]
    fn image_mime_is_derived_from_bytes() {
        assert_eq!(
            detect_steam_avatar_mime(&[0xff, 0xd8, 0xff, 0x00]),
            Some("image/jpeg")
        );
        assert_eq!(
            detect_steam_avatar_mime(b"\x89PNG\r\n\x1a\nrest"),
            Some("image/png")
        );
        assert_eq!(
            detect_steam_avatar_mime(b"RIFF0000WEBPrest"),
            Some("image/webp")
        );
        assert_eq!(detect_steam_avatar_mime(b"<svg></svg>"), None);
    }
}
