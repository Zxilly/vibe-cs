use std::{
    io::ErrorKind,
    net::{IpAddr, SocketAddr},
    path::Path,
    time::Duration,
};

use axum::{
    Json, Router,
    extract::State,
    http::StatusCode,
    routing::{get, post},
};
use chrono::{DateTime, Utc};
use futures_util::StreamExt;
use semver::Version;
use serde::{Deserialize, Serialize};
use serde_json::json;
use tokio::io::AsyncWriteExt;
use url::Url;
use uuid::Uuid;

use crate::{ApiError, ApiResult, AppState};

const MAXIMUM_MANIFEST_BYTES: usize = 64 * 1024;
const MAXIMUM_MANIFEST_URL_BYTES: usize = 2_048;
const UPDATE_TIMEOUT: Duration = Duration::from_secs(8);
const UPDATE_CONNECT_TIMEOUT: Duration = Duration::from_secs(3);

pub(crate) fn router() -> Router<AppState> {
    Router::new()
        .route("/api/app/update-info", get(update_info))
        .route("/api/app/check-update", post(check_update))
        .route("/api/app/managed-locations", get(managed_locations))
        .route("/api/app/diagnostics/export", post(export_diagnostics))
}

#[derive(Debug, Serialize)]
struct UpdateInfo {
    current_version: &'static str,
    configured: bool,
    manifest_url: Option<String>,
    policy: &'static str,
}

async fn update_info(State(state): State<AppState>) -> ApiResult<Json<UpdateInfo>> {
    let config = state.storage.get_config().await?.unwrap_or_default();
    let manifest_url = normalized_optional_url(&config.update_manifest_url)?;
    Ok(Json(UpdateInfo {
        current_version: env!("CARGO_PKG_VERSION"),
        configured: manifest_url.is_some(),
        manifest_url,
        policy: "manual_check_only",
    }))
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct UpdateManifest {
    version: String,
    download_url: String,
    #[serde(default)]
    notes: String,
    #[serde(default)]
    published_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Serialize)]
struct UpdateCheckResult {
    current_version: String,
    latest_version: String,
    update_available: bool,
    download_url: String,
    notes: String,
    published_at: Option<DateTime<Utc>>,
    checked_at: DateTime<Utc>,
}

async fn check_update(State(state): State<AppState>) -> ApiResult<Json<UpdateCheckResult>> {
    let config = state.storage.get_config().await?.unwrap_or_default();
    let manifest_url = normalized_optional_url(&config.update_manifest_url)?
        .ok_or_else(|| ApiError::invalid("an HTTPS update manifest is not configured"))?;
    let url = validate_public_https_url(&manifest_url, "update manifest")?;
    let response = fetch_manifest(&url).await?;
    let manifest = serde_json::from_slice::<UpdateManifest>(&response).map_err(|error| {
        tracing::warn!(%error, "update manifest could not be decoded");
        ApiError::new(
            StatusCode::BAD_GATEWAY,
            "invalid_update_manifest",
            "The update manifest is not valid JSON",
        )
    })?;
    validate_manifest_text(&manifest)?;
    let current = Version::parse(env!("CARGO_PKG_VERSION")).map_err(|error| {
        tracing::error!(%error, "application package version is invalid");
        ApiError::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            "invalid_application_version",
            "The application version could not be compared",
        )
    })?;
    let latest = Version::parse(&manifest.version).map_err(|_| {
        ApiError::new(
            StatusCode::BAD_GATEWAY,
            "invalid_update_manifest",
            "The update manifest contains an invalid semantic version",
        )
    })?;
    let download_url = validate_public_https_url(&manifest.download_url, "download")?;
    let _download_addresses = resolve_public_addresses(&download_url).await?;
    Ok(Json(UpdateCheckResult {
        current_version: current.to_string(),
        latest_version: latest.to_string(),
        update_available: latest > current,
        download_url: download_url.to_string(),
        notes: manifest.notes,
        published_at: manifest.published_at,
        checked_at: Utc::now(),
    }))
}

fn validate_manifest_text(manifest: &UpdateManifest) -> ApiResult<()> {
    if manifest.version.len() > 64
        || manifest.download_url.len() > MAXIMUM_MANIFEST_URL_BYTES
        || manifest.notes.len() > 8_192
        || manifest.notes.chars().any(|character| character == '\0')
    {
        return Err(ApiError::new(
            StatusCode::BAD_GATEWAY,
            "invalid_update_manifest",
            "The update manifest exceeds the supported field limits",
        ));
    }
    Ok(())
}

async fn fetch_manifest(url: &Url) -> ApiResult<Vec<u8>> {
    let host = url.host_str().expect("validated URL has a host");
    let addresses = resolve_public_addresses(url).await?;
    let client = reqwest::Client::builder()
        .https_only(true)
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(UPDATE_CONNECT_TIMEOUT)
        .timeout(UPDATE_TIMEOUT)
        .resolve_to_addrs(host, &addresses)
        .build()
        .map_err(|error| update_network_error("create client", error))?;

    let response = client
        .get(url.clone())
        .header(reqwest::header::ACCEPT, "application/json")
        .send()
        .await
        .map_err(|error| update_network_error("request", error))?;
    if response.status().is_redirection() {
        return Err(ApiError::new(
            StatusCode::BAD_GATEWAY,
            "update_redirect_rejected",
            "The update manifest endpoint must not redirect",
        ));
    }
    if !response.status().is_success() {
        tracing::warn!(status = %response.status(), "update manifest returned an unsuccessful status");
        return Err(ApiError::new(
            StatusCode::BAD_GATEWAY,
            "update_check_failed",
            "The update manifest could not be retrieved",
        ));
    }
    if response
        .content_length()
        .is_some_and(|length| length > MAXIMUM_MANIFEST_BYTES as u64)
    {
        return Err(manifest_too_large());
    }

    let mut bytes = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|error| update_network_error("read response", error))?;
        if bytes.len().saturating_add(chunk.len()) > MAXIMUM_MANIFEST_BYTES {
            return Err(manifest_too_large());
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

async fn resolve_public_addresses(url: &Url) -> ApiResult<Vec<SocketAddr>> {
    let host = url.host_str().expect("validated URL has a host");
    let addresses = tokio::net::lookup_host((host, 443))
        .await
        .map_err(|error| update_network_error("resolve", error))?
        .collect::<Vec<_>>();
    if addresses.is_empty() || addresses.iter().any(|address| !is_public_ip(address.ip())) {
        return Err(ApiError::invalid(
            "update hosts must resolve exclusively to public HTTPS endpoints",
        ));
    }
    Ok(addresses)
}

fn manifest_too_large() -> ApiError {
    ApiError::new(
        StatusCode::BAD_GATEWAY,
        "update_manifest_too_large",
        "The update manifest exceeds the 64 KiB limit",
    )
}

fn update_network_error(context: &'static str, error: impl std::fmt::Display) -> ApiError {
    tracing::warn!(%error, context, "update check network operation failed");
    ApiError::new(
        StatusCode::BAD_GATEWAY,
        "update_check_failed",
        "The update manifest could not be retrieved",
    )
}

fn normalized_optional_url(value: &str) -> ApiResult<Option<String>> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }
    if value != trimmed || trimmed.len() > MAXIMUM_MANIFEST_URL_BYTES {
        return Err(ApiError::invalid("the update manifest URL is invalid"));
    }
    validate_public_https_url(trimmed, "update manifest").map(|url| Some(url.to_string()))
}

pub(super) fn validate_configured_manifest_url(value: &str) -> ApiResult<()> {
    normalized_optional_url(value).map(|_| ())
}

fn validate_public_https_url(value: &str, label: &str) -> ApiResult<Url> {
    let url =
        Url::parse(value).map_err(|_| ApiError::invalid(format!("the {label} URL is invalid")))?;
    let host = url
        .host_str()
        .ok_or_else(|| ApiError::invalid(format!("the {label} URL must include a host")))?;
    if url.scheme() != "https"
        || url.port_or_known_default() != Some(443)
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || host.eq_ignore_ascii_case("localhost")
        || host.ends_with(".localhost")
        || host
            .parse::<IpAddr>()
            .is_ok_and(|address| !is_public_ip(address))
    {
        return Err(ApiError::invalid(format!(
            "the {label} URL must be a public HTTPS URL on port 443 without credentials, a query, or a fragment"
        )));
    }
    Ok(url)
}

fn is_public_ip(address: IpAddr) -> bool {
    match address {
        IpAddr::V4(address) => {
            let [first, second, third, _] = address.octets();
            let shared = first == 100 && (64..=127).contains(&second);
            let protocol_assignments = first == 192 && second == 0 && third == 0;
            let deprecated_relay = first == 192 && second == 88 && third == 99;
            let benchmarking = first == 198 && (18..=19).contains(&second);
            let reserved = first >= 224;
            !(first == 0
                || shared
                || protocol_assignments
                || deprecated_relay
                || benchmarking
                || reserved
                || address.is_private()
                || address.is_loopback()
                || address.is_link_local()
                || address.is_unspecified()
                || address.is_broadcast()
                || address.is_documentation()
                || address.is_multicast())
        }
        IpAddr::V6(address) => {
            if let Some(mapped) = address.to_ipv4_mapped() {
                return is_public_ip(IpAddr::V4(mapped));
            }
            let segments = address.segments();
            let documentation = segments[0] == 0x2001 && segments[1] == 0x0db8;
            let discard_only =
                segments[0] == 0x0100 && segments[1..4].iter().all(|segment| *segment == 0);
            !(address.is_loopback()
                || address.is_unspecified()
                || address.is_multicast()
                || address.is_unique_local()
                || address.is_unicast_link_local()
                || documentation
                || discard_only)
        }
    }
}

#[derive(Debug, Serialize)]
struct ManagedLocations {
    data: String,
    logs: String,
    recordings: String,
    exports: String,
    diagnostics: String,
    desktop_open_supported: bool,
}

async fn managed_locations(State(state): State<AppState>) -> ApiResult<Json<ManagedLocations>> {
    let data = state.data_dir().clone();
    let logs = data.join("logs");
    let recordings = data.join("recordings");
    let exports = data.join("exports");
    let diagnostics = data.join("diagnostics");
    for directory in [&logs, &recordings, &exports, &diagnostics] {
        tokio::fs::create_dir_all(directory).await?;
    }
    Ok(Json(ManagedLocations {
        data: display_path(&data),
        logs: display_path(&logs),
        recordings: display_path(&recordings),
        exports: display_path(&exports),
        diagnostics: display_path(&diagnostics),
        desktop_open_supported: false,
    }))
}

#[derive(Debug, Serialize)]
struct DiagnosticExport {
    path: String,
    created_at: DateTime<Utc>,
    contains_secrets: bool,
}

async fn export_diagnostics(State(state): State<AppState>) -> ApiResult<Json<DiagnosticExport>> {
    let created_at = Utc::now();
    let config = state.storage.get_config().await?.unwrap_or_default();
    let root = state.data_dir().join("diagnostics");
    tokio::fs::create_dir_all(&root).await?;
    let document = json!({
        "created_at": created_at,
        "application": {
            "version": env!("CARGO_PKG_VERSION"),
            "started_at": state.started_at,
            "runtime_session": state.runtime_session_snapshot().await.0,
            "target_os": std::env::consts::OS,
            "target_arch": std::env::consts::ARCH,
        },
        "configuration": {
            "locale": config.locale,
            "theme": config.theme,
            "data_directory_configured": !config.data_dir.is_empty(),
            "game_path_configured": !config.cs2_path.is_empty(),
            "steam_identity_configured": !config.steam.steam_id.is_empty(),
            "steam_credentials_configured": !config.steam.web_api_key.is_empty(),
            "assistant_configured": !config.llm.provider.is_empty(),
            "assistant_key_configured": !config.llm.api_key.is_empty(),
            "update_manifest_configured": !config.update_manifest_url.is_empty(),
        },
        "storage": {
            "data_directory": display_path(state.data_dir()),
            "schema_contract": "the database must match the current application schema exactly",
            "replay_cache": "entries use the current parser and replay artifact contract",
        },
        "privacy": "Credential values, access tokens, and user media contents are intentionally omitted."
    });
    let bytes = serde_json::to_vec_pretty(&document).map_err(|error| {
        tracing::error!(%error, "diagnostic document serialization failed");
        ApiError::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            "diagnostic_export_failed",
            "The diagnostic report could not be created",
        )
    })?;
    let final_path = publish_diagnostic(&root, created_at, Uuid::new_v4(), &bytes).await?;
    Ok(Json(DiagnosticExport {
        path: display_path(&final_path),
        created_at,
        contains_secrets: false,
    }))
}

async fn publish_diagnostic(
    root: &Path,
    created_at: DateTime<Utc>,
    identifier: Uuid,
    bytes: &[u8],
) -> std::io::Result<std::path::PathBuf> {
    let final_path = root.join(format!(
        "diagnostics-{}-{identifier}.json",
        created_at.format("%Y%m%dT%H%M%S%.9fZ")
    ));
    let temporary = root.join(format!(".{identifier}-{}.tmp", Uuid::new_v4()));
    let write_result = async {
        let mut file = tokio::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .await?;
        file.write_all(bytes).await?;
        file.flush().await?;
        file.sync_all().await?;
        drop(file);
        tokio::fs::hard_link(&temporary, &final_path).await
    }
    .await;
    if let Err(error) = write_result {
        cleanup_diagnostic_temporary(&temporary).await;
        return Err(error);
    }
    cleanup_diagnostic_temporary(&temporary).await;
    Ok(final_path)
}

async fn cleanup_diagnostic_temporary(temporary: &Path) {
    if let Err(error) = tokio::fs::remove_file(temporary).await
        && error.kind() != ErrorKind::NotFound
    {
        tracing::warn!(%error, path = %temporary.display(), "diagnostic temporary file cleanup failed");
    }
}

fn display_path(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn update_urls_require_public_https_without_credentials() {
        assert!(
            validate_public_https_url("https://updates.example.com/manifest.json", "manifest")
                .is_ok()
        );
        for invalid in [
            "http://updates.example.com/manifest.json",
            "https://localhost/manifest.json",
            "https://127.0.0.1/manifest.json",
            "https://user:secret@updates.example.com/manifest.json",
            "https://updates.example.com/manifest.json?token=secret",
            "https://updates.example.com:8443/manifest.json",
            "https://updates.example.com/manifest.json#fragment",
        ] {
            assert!(
                validate_public_https_url(invalid, "manifest").is_err(),
                "{invalid}"
            );
        }
    }

    #[test]
    fn public_ip_filter_rejects_non_global_ranges() {
        for rejected in [
            "0.1.2.3",
            "10.0.0.1",
            "100.64.0.1",
            "100.127.255.254",
            "127.0.0.1",
            "169.254.1.1",
            "172.16.0.1",
            "192.0.0.9",
            "192.0.2.1",
            "192.88.99.1",
            "192.168.1.1",
            "198.18.0.1",
            "198.19.255.254",
            "198.51.100.1",
            "203.0.113.1",
            "224.0.0.1",
            "240.0.0.1",
            "255.255.255.255",
            "::1",
            "::ffff:127.0.0.1",
            "::ffff:100.64.0.1",
            "2001:db8::1",
        ] {
            assert!(
                !is_public_ip(rejected.parse().expect("IP address")),
                "{rejected}"
            );
        }
        for accepted in ["1.1.1.1", "8.8.8.8", "100.128.0.1", "2606:4700:4700::1111"] {
            assert!(
                is_public_ip(accepted.parse().expect("IP address")),
                "{accepted}"
            );
        }
    }

    #[tokio::test]
    async fn concurrent_diagnostic_publication_never_overwrites() {
        let directory = tempfile::tempdir().expect("diagnostic directory");
        let created_at = Utc::now();
        let first_id = Uuid::new_v4();
        let second_id = Uuid::new_v4();
        let (first, second) = tokio::join!(
            publish_diagnostic(directory.path(), created_at, first_id, b"first"),
            publish_diagnostic(directory.path(), created_at, second_id, b"second"),
        );
        let first = first.expect("first diagnostic");
        let second = second.expect("second diagnostic");
        assert_ne!(first, second);
        assert_eq!(std::fs::read(first).expect("first bytes"), b"first");
        assert_eq!(std::fs::read(second).expect("second bytes"), b"second");

        let collision_id = Uuid::new_v4();
        let (first, second) = tokio::join!(
            publish_diagnostic(directory.path(), created_at, collision_id, b"winner one"),
            publish_diagnostic(directory.path(), created_at, collision_id, b"winner two"),
        );
        assert_ne!(first.is_ok(), second.is_ok());
        let published = first.or(second).expect("one collision winner");
        let bytes = std::fs::read(published).expect("winner bytes");
        assert!(bytes == b"winner one" || bytes == b"winner two");
    }
}
