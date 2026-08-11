use std::{
    fs,
    path::{Component, Path, PathBuf},
};

use url::Host;
use uuid::Uuid;

use crate::{
    BackupManager, ManagedFile, PlatformError, PlatformResult, RecoveryStatus,
    fs_atomic::atomic_write, io_error,
};

pub const GSI_CONFIG_FILE_NAME: &str = "gamestate_integration_vibe_cs.cfg";
const MAXIMUM_URI_BYTES: usize = 2_048;
const MAXIMUM_TOKEN_BYTES: usize = 256;
const MAXIMUM_CONFIG_BYTES: usize = 64 * 1024;

#[derive(Clone, PartialEq, Eq)]
pub struct GsiConfig {
    pub uri: String,
    pub token: String,
}

impl std::fmt::Debug for GsiConfig {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("GsiConfig")
            .field("uri", &self.uri)
            .field("token", &"[REDACTED]")
            .finish()
    }
}

/// Renders a bounded Valve `KeyValues` GSI configuration for a loopback endpoint.
///
/// # Errors
///
/// Rejects non-HTTP/non-loopback URLs, credentials, fragments, and token or URI
/// characters that could escape the `KeyValues` string.
pub fn render_gsi_config(config: &GsiConfig) -> PlatformResult<Vec<u8>> {
    validate_key_value(&config.uri, "GSI URI", MAXIMUM_URI_BYTES)?;
    validate_key_value(&config.token, "GSI token", MAXIMUM_TOKEN_BYTES)?;
    if config.token.is_empty() {
        return Err(PlatformError::InvalidInput(
            "GSI token must not be empty".to_owned(),
        ));
    }
    let uri = url::Url::parse(&config.uri)?;
    if uri.scheme() != "http"
        || !uri.username().is_empty()
        || uri.password().is_some()
        || uri.fragment().is_some()
        || !uri_host_is_loopback(&uri)
    {
        return Err(PlatformError::InvalidInput(
            "GSI URI must be an unauthenticated loopback HTTP URL without a fragment".to_owned(),
        ));
    }
    let rendered = format!(
        "\"Vibe CS\"\n{{\n  \"uri\" \"{}\"\n  \"timeout\" \"5.0\"\n  \"buffer\" \"0.1\"\n  \"throttle\" \"0.1\"\n  \"heartbeat\" \"30.0\"\n  \"auth\"\n  {{\n    \"token\" \"{}\"\n  }}\n  \"data\"\n  {{\n    \"provider\" \"1\"\n    \"map\" \"1\"\n    \"round\" \"1\"\n    \"player_id\" \"1\"\n    \"player_state\" \"1\"\n    \"player_weapons\" \"1\"\n  }}\n}}\n",
        config.uri, config.token
    );
    if rendered.len() > MAXIMUM_CONFIG_BYTES {
        return Err(PlatformError::InvalidInput(
            "rendered GSI configuration exceeds its safety limit".to_owned(),
        ));
    }
    Ok(rendered.into_bytes())
}

#[derive(Debug, Clone)]
pub struct GsiInstaller {
    target: PathBuf,
    backup: BackupManager,
}

impl GsiInstaller {
    /// Creates a GSI installer for one absolute CS2 cfg directory.
    ///
    /// # Errors
    ///
    /// Rejects relative/control-bearing paths or a non-directory path.
    pub fn new(
        cs2_cfg_directory: impl Into<PathBuf>,
        recovery_directory: impl Into<PathBuf>,
    ) -> PlatformResult<Self> {
        let cs2_cfg_directory = cs2_cfg_directory.into();
        validate_directory_path(&cs2_cfg_directory)?;
        fs::create_dir_all(&cs2_cfg_directory).map_err(|error| {
            io_error(
                "creating CS2 configuration directory",
                &cs2_cfg_directory,
                error,
            )
        })?;
        let target = cs2_cfg_directory.join(GSI_CONFIG_FILE_NAME);
        Ok(Self {
            target,
            backup: BackupManager::with_maximum_file_bytes(
                recovery_directory,
                MAXIMUM_CONFIG_BYTES as u64,
            )?,
        })
    }

    #[must_use]
    pub fn target_path(&self) -> &Path {
        &self.target
    }

    /// Journals any previous config before atomically installing managed bytes.
    ///
    /// # Errors
    ///
    /// Refuses a second install while recovery is pending.
    pub fn install(&self, config: &GsiConfig) -> PlatformResult<Uuid> {
        let bytes = render_gsi_config(config)?;
        let transaction = self
            .backup
            .prepare(&[ManagedFile::for_bytes(&self.target, &bytes)])?;
        // If publication fails, the durable journal deliberately remains so a
        // later recovery can prove and restore the prior state.
        atomic_write(&self.target, &bytes)?;
        Ok(transaction)
    }

    /// Restores the verified prior config or removes a verified managed config.
    ///
    /// # Errors
    ///
    /// Refuses deletion when the managed file was externally modified.
    pub fn remove(&self) -> PlatformResult<()> {
        self.backup.restore()
    }

    /// Returns durable crash-recovery state without changing files.
    ///
    /// # Errors
    ///
    /// Returns an error when the journal itself is invalid.
    pub fn status(&self) -> PlatformResult<RecoveryStatus> {
        self.backup.status()
    }
}

fn validate_key_value(value: &str, label: &str, maximum_bytes: usize) -> PlatformResult<()> {
    if value.len() > maximum_bytes
        || value
            .chars()
            .any(|character| character.is_control() || matches!(character, '"' | '\\'))
    {
        return Err(PlatformError::InvalidInput(format!(
            "{label} contains unsafe characters or exceeds {maximum_bytes} bytes"
        )));
    }
    Ok(())
}

fn uri_host_is_loopback(uri: &url::Url) -> bool {
    match uri.host() {
        Some(Host::Domain(domain)) => domain.eq_ignore_ascii_case("localhost"),
        Some(Host::Ipv4(address)) => address.is_loopback(),
        Some(Host::Ipv6(address)) => address.is_loopback(),
        None => false,
    }
}

fn validate_directory_path(path: &Path) -> PlatformResult<()> {
    if !path.is_absolute()
        || path
            .components()
            .any(|component| matches!(component, Component::ParentDir | Component::CurDir))
    {
        return Err(PlatformError::InvalidInput(
            "configuration directory must be an absolute normalized path".to_owned(),
        ));
    }
    let text = path.to_str().ok_or_else(|| {
        PlatformError::InvalidInput("configuration path is not valid Unicode".to_owned())
    })?;
    if text.chars().any(char::is_control) {
        return Err(PlatformError::InvalidInput(
            "configuration path contains control characters".to_owned(),
        ));
    }
    if path.exists() && !path.is_dir() {
        return Err(PlatformError::InvalidInput(
            "configuration path must be a directory".to_owned(),
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::fs;

    use super::*;

    fn config() -> GsiConfig {
        GsiConfig {
            uri: "http://127.0.0.1:32123/gsi".to_owned(),
            token: "opaque-token".to_owned(),
        }
    }

    #[test]
    fn renders_expected_bounded_loopback_config() {
        let rendered = String::from_utf8(render_gsi_config(&config()).unwrap()).unwrap();
        assert!(rendered.contains("\"uri\" \"http://127.0.0.1:32123/gsi\""));
        assert!(rendered.contains("\"token\" \"opaque-token\""));
        assert!(rendered.contains("\"player_state\" \"1\""));
    }

    #[test]
    fn rejects_remote_and_control_bearing_values() {
        let mut remote = config();
        remote.uri = "https://example.com/gsi".to_owned();
        assert!(matches!(
            render_gsi_config(&remote),
            Err(PlatformError::InvalidInput(_))
        ));
        let mut injected = config();
        injected.token = "token\n\"data\"".to_owned();
        assert!(matches!(
            render_gsi_config(&injected),
            Err(PlatformError::InvalidInput(_))
        ));
    }

    #[test]
    fn install_then_remove_restores_previous_config() {
        let root = tempfile::tempdir().unwrap();
        let cfg = root.path().join("cfg");
        let recovery = root.path().join("recovery");
        let installer = GsiInstaller::new(&cfg, recovery).unwrap();
        fs::write(installer.target_path(), b"prior config").unwrap();

        installer.install(&config()).unwrap();
        assert_ne!(fs::read(installer.target_path()).unwrap(), b"prior config");
        installer.remove().unwrap();
        assert_eq!(fs::read(installer.target_path()).unwrap(), b"prior config");
        assert_eq!(installer.status().unwrap(), RecoveryStatus::Clean);
    }

    #[test]
    fn remove_deletes_a_verified_new_install_but_preserves_external_edits() {
        let root = tempfile::tempdir().unwrap();
        let cfg = root.path().join("cfg");
        let installer = GsiInstaller::new(&cfg, root.path().join("recovery")).unwrap();
        installer.install(&config()).unwrap();
        installer.remove().unwrap();
        assert!(!installer.target_path().exists());

        let other = GsiInstaller::new(&cfg, root.path().join("other-recovery")).unwrap();
        other.install(&config()).unwrap();
        fs::write(other.target_path(), b"external").unwrap();
        assert!(matches!(
            other.remove(),
            Err(PlatformError::RecoveryConflict { .. })
        ));
        assert_eq!(fs::read(other.target_path()).unwrap(), b"external");
    }
}
