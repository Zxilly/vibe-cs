use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::Arc,
    time::SystemTime,
};

use async_trait::async_trait;
use chrono::{DateTime, Utc};
use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::sync::Mutex;
use uuid::Uuid;
use vibe_cs_api::{
    ObsTuningPort, ObsVideoApplyRequest, ObsVideoApplyResult, ObsVideoBackup,
    ObsVideoBackupDeleteResult, ObsVideoBackupReason, ObsVideoField, ObsVideoFieldDiff,
    ObsVideoRestoreRequest, ObsVideoRestoreResult, ObsVideoSettingsSnapshot, ObsVideoTuningPlan,
};
use vibe_cs_domain::{AppConfig, DomainError, ObsConfig};
use vibe_cs_integrations::{
    IntegrationError, ObsClient, ObsRecordStatus, ObsTransportLimits, ObsVideoOutputSettings,
    ObsVideoSettings, SecretString, WebSocketObsTransport,
};
use vibe_cs_storage::Storage;

const BACKUP_FORMAT_VERSION: u32 = 2;
const MAXIMUM_BACKUPS: usize = 32;
const MAXIMUM_BACKUP_BYTES: u64 = 64 * 1024;
const MAXIMUM_BACKUP_DIRECTORY_ENTRIES: usize = 1024;
const BACKUP_AUTHENTICATION_KEY_BYTES: usize = 32;
const BACKUP_AUTHENTICATION_TAG_BYTES: usize = 32;
const BACKUP_AUTHENTICATION_KEY_FILE: &str = ".authentication-key-v1";

type BackupHmac = Hmac<Sha256>;

#[async_trait]
trait ObsVideoConnection: Send + std::fmt::Debug {
    async fn record_status(&mut self) -> Result<ObsRecordStatus, DomainError>;
    async fn video_settings(&mut self) -> Result<ObsVideoSettings, DomainError>;
    async fn set_video_settings(
        &mut self,
        expected_current: &ObsVideoSettings,
        target: ObsVideoOutputSettings,
    ) -> Result<(), DomainError>;
}

#[async_trait]
trait ObsVideoConnector: Send + Sync + std::fmt::Debug {
    async fn connect(&self, config: &ObsConfig)
    -> Result<Box<dyn ObsVideoConnection>, DomainError>;
}

#[derive(Debug, Default)]
struct SystemObsVideoConnector;

#[async_trait]
impl ObsVideoConnector for SystemObsVideoConnector {
    async fn connect(
        &self,
        config: &ObsConfig,
    ) -> Result<Box<dyn ObsVideoConnection>, DomainError> {
        if config.host.trim().is_empty() || config.port == 0 {
            return Err(DomainError::DependencyUnavailable(
                "OBS WebSocket is not configured".to_owned(),
            ));
        }
        let client = ObsClient::connect_websocket(
            config.host.trim(),
            config.port,
            &SecretString::new(config.password.clone()),
            ObsTransportLimits::default(),
        )
        .await
        .map_err(map_integration_error)?;
        Ok(Box::new(SystemObsVideoConnection { client }))
    }
}

#[derive(Debug)]
struct SystemObsVideoConnection {
    client: ObsClient<WebSocketObsTransport>,
}

#[async_trait]
impl ObsVideoConnection for SystemObsVideoConnection {
    async fn record_status(&mut self) -> Result<ObsRecordStatus, DomainError> {
        self.client
            .record_status()
            .await
            .map_err(map_integration_error)
    }

    async fn video_settings(&mut self) -> Result<ObsVideoSettings, DomainError> {
        self.client
            .video_settings()
            .await
            .map_err(map_integration_error)
    }

    async fn set_video_settings(
        &mut self,
        expected_current: &ObsVideoSettings,
        target: ObsVideoOutputSettings,
    ) -> Result<(), DomainError> {
        if self
            .client
            .record_status()
            .await
            .map_err(map_integration_error)?
            .active
        {
            return Err(DomainError::Conflict(
                "OBS started recording immediately before SetVideoSettings".to_owned(),
            ));
        }
        self.client
            .set_video_settings(expected_current, target)
            .await
            .map_err(|error| match &error {
                IntegrationError::Protocol(message)
                    if message.contains("changed after the plan") =>
                {
                    DomainError::Conflict(message.clone())
                }
                _ => map_integration_error(error),
            })
    }
}

/// Explicit, optimistic-lock protected OBS output resolution and frame-rate tuning.
#[derive(Debug, Clone)]
pub struct RuntimeObsTuningPort {
    storage: Storage,
    data_dir: PathBuf,
    connector: Arc<dyn ObsVideoConnector>,
    gate: Arc<Mutex<()>>,
}

impl RuntimeObsTuningPort {
    #[must_use]
    pub fn new(storage: Storage, data_dir: PathBuf) -> Self {
        Self {
            storage,
            data_dir,
            connector: Arc::new(SystemObsVideoConnector),
            gate: Arc::new(Mutex::new(())),
        }
    }

    #[cfg(test)]
    fn with_connector(mut self, connector: Arc<dyn ObsVideoConnector>) -> Self {
        self.connector = connector;
        self
    }

    async fn config(&self) -> Result<AppConfig, DomainError> {
        self.storage
            .get_config()
            .await
            .map_err(|error| DomainError::Internal(format!("load OBS configuration: {error}")))
            .map(Option::unwrap_or_default)
    }

    fn backup_directory(&self) -> PathBuf {
        self.data_dir.join("obs-backups")
    }

    async fn create_backup(
        &self,
        settings: &ObsVideoSettings,
        reason: ObsVideoBackupReason,
    ) -> Result<ObsVideoBackup, DomainError> {
        self.create_backup_protected(settings, reason, None).await
    }

    async fn create_backup_protected(
        &self,
        settings: &ObsVideoSettings,
        reason: ObsVideoBackupReason,
        protected_backup: Option<Uuid>,
    ) -> Result<ObsVideoBackup, DomainError> {
        let directory = self.backup_directory();
        let backup = ObsVideoBackup {
            id: Uuid::new_v4(),
            created_at: Utc::now(),
            reason,
            settings: snapshot(settings),
            settings_fingerprint: settings_fingerprint(settings),
        };
        let backup_for_write = backup.clone();
        tokio::task::spawn_blocking(move || {
            write_backup(&directory, &backup_for_write, protected_backup)
        })
        .await
        .map_err(|error| DomainError::Internal(format!("OBS backup task failed: {error}")))??;
        Ok(backup)
    }

    async fn load_backup(&self, id: Uuid) -> Result<ObsVideoBackup, DomainError> {
        let directory = self.backup_directory();
        tokio::task::spawn_blocking(move || read_backup(&directory, id))
            .await
            .map_err(|error| DomainError::Internal(format!("OBS backup task failed: {error}")))?
    }

    async fn rollback_after_failure(
        connection: &mut dyn ObsVideoConnection,
        original: &ObsVideoSettings,
        primary: DomainError,
    ) -> DomainError {
        let rollback = async {
            let current = connection.video_settings().await?;
            connection
                .set_video_settings(&current, output_settings(original))
                .await?;
            let verified = connection.video_settings().await?;
            let expected = with_output(&current, original);
            if verified != expected {
                return Err(DomainError::Internal(
                    "OBS rollback verification returned unexpected video settings".to_owned(),
                ));
            }
            Ok::<(), DomainError>(())
        }
        .await;

        match rollback {
            Ok(()) => DomainError::Internal(format!(
                "OBS video settings update failed: {primary}; previous output settings were restored"
            )),
            Err(rollback_error) => DomainError::Internal(format!(
                "OBS video settings update failed: {primary}; rollback also failed: {rollback_error}"
            )),
        }
    }

    async fn apply_target(
        connection: &mut dyn ObsVideoConnection,
        current: &ObsVideoSettings,
        target: &ObsVideoSettings,
    ) -> Result<ObsVideoSettings, DomainError> {
        if let Err(error) = connection
            .set_video_settings(current, output_settings(target))
            .await
        {
            if matches!(error, DomainError::Conflict(_)) {
                return Err(error);
            }
            return Err(Self::rollback_after_failure(connection, current, error).await);
        }
        match connection.video_settings().await {
            Ok(verified) if verified == *target => Ok(verified),
            Ok(_) => {
                let error = DomainError::Internal(
                    "OBS accepted SetVideoSettings but verification did not match the plan"
                        .to_owned(),
                );
                Err(Self::rollback_after_failure(connection, current, error).await)
            }
            Err(error) => Err(Self::rollback_after_failure(connection, current, error).await),
        }
    }
}

#[async_trait]
impl ObsTuningPort for RuntimeObsTuningPort {
    async fn plan(&self) -> Result<ObsVideoTuningPlan, DomainError> {
        let config = self.config().await?;
        let mut connection = self.connector.connect(&config.obs).await?;
        let recording = connection.record_status().await?;
        let current = connection.video_settings().await?;
        build_plan(&config, &current, recording.active)
    }

    async fn apply(
        &self,
        request: ObsVideoApplyRequest,
    ) -> Result<ObsVideoApplyResult, DomainError> {
        if !request.confirm {
            return Err(DomainError::InvalidInput(
                "explicit confirmation is required".to_owned(),
            ));
        }
        validate_fingerprint(&request.expected_fingerprint)?;
        let _guard = self.gate.lock().await;
        let config = self.config().await?;
        let mut connection = self.connector.connect(&config.obs).await?;
        let recording = connection.record_status().await?;
        if recording.active {
            return Err(DomainError::Conflict(
                "OBS video settings cannot change while recording".to_owned(),
            ));
        }
        let current = connection.video_settings().await?;
        let plan = build_plan(&config, &current, false)?;
        if plan.expected_fingerprint != request.expected_fingerprint {
            return Err(DomainError::Conflict(
                "OBS video settings or saved recording defaults changed after planning".to_owned(),
            ));
        }
        let target = settings(&plan.target);
        if current == target {
            return Ok(ObsVideoApplyResult {
                applied: false,
                backup: None,
                settings: snapshot(&current),
            });
        }
        let backup = self
            .create_backup(&current, ObsVideoBackupReason::Apply)
            .await?;
        if connection.record_status().await?.active {
            return Err(DomainError::Conflict(
                "OBS started recording before video settings could be applied".to_owned(),
            ));
        }
        let verified = Self::apply_target(connection.as_mut(), &current, &target).await?;
        Ok(ObsVideoApplyResult {
            applied: true,
            backup: Some(backup),
            settings: snapshot(&verified),
        })
    }

    async fn list_backups(&self) -> Result<Vec<ObsVideoBackup>, DomainError> {
        let _guard = self.gate.lock().await;
        let directory = self.backup_directory();
        tokio::task::spawn_blocking(move || list_backups(&directory))
            .await
            .map_err(|error| DomainError::Internal(format!("OBS backup task failed: {error}")))?
    }

    async fn restore(
        &self,
        id: Uuid,
        request: ObsVideoRestoreRequest,
    ) -> Result<ObsVideoRestoreResult, DomainError> {
        if !request.confirm {
            return Err(DomainError::InvalidInput(
                "explicit confirmation is required".to_owned(),
            ));
        }
        let _guard = self.gate.lock().await;
        let backup = self.load_backup(id).await?;
        let config = self.config().await?;
        let mut connection = self.connector.connect(&config.obs).await?;
        if connection.record_status().await?.active {
            return Err(DomainError::Conflict(
                "OBS video settings cannot be restored while recording".to_owned(),
            ));
        }
        let current = connection.video_settings().await?;
        let backup_settings = settings(&backup.settings);
        let target = with_output(&current, &backup_settings);
        if current == target {
            return Ok(ObsVideoRestoreResult {
                restored: false,
                restored_backup_id: id,
                rollback_backup: None,
                settings: snapshot(&current),
            });
        }
        let rollback_backup = self
            .create_backup_protected(&current, ObsVideoBackupReason::BeforeRestore, Some(id))
            .await?;
        if connection.record_status().await?.active {
            return Err(DomainError::Conflict(
                "OBS started recording before video settings could be restored".to_owned(),
            ));
        }
        let verified = Self::apply_target(connection.as_mut(), &current, &target).await?;
        Ok(ObsVideoRestoreResult {
            restored: true,
            restored_backup_id: id,
            rollback_backup: Some(rollback_backup),
            settings: snapshot(&verified),
        })
    }

    async fn delete_backup(&self, id: Uuid) -> Result<ObsVideoBackupDeleteResult, DomainError> {
        let _guard = self.gate.lock().await;
        let directory = self.backup_directory();
        tokio::task::spawn_blocking(move || delete_backup(&directory, id))
            .await
            .map_err(|error| DomainError::Internal(format!("OBS backup task failed: {error}")))??;
        Ok(ObsVideoBackupDeleteResult { id, deleted: true })
    }
}

fn build_plan(
    config: &AppConfig,
    current: &ObsVideoSettings,
    recording_active: bool,
) -> Result<ObsVideoTuningPlan, DomainError> {
    let (output_width, output_height) = parse_resolution(&config.recording.resolution)?;
    let target = ObsVideoSettings {
        base_width: current.base_width,
        base_height: current.base_height,
        output_width,
        output_height,
        fps_numerator: config.recording.fps,
        fps_denominator: 1,
    };
    validate_settings(&target)?;
    let mut diff = Vec::with_capacity(2);
    if (current.output_width, current.output_height) != (target.output_width, target.output_height)
    {
        diff.push(ObsVideoFieldDiff {
            field: ObsVideoField::OutputResolution,
            current: format!("{}x{}", current.output_width, current.output_height),
            target: format!("{}x{}", target.output_width, target.output_height),
        });
    }
    if current.fps_numerator != target.fps_numerator
        || current.fps_denominator != target.fps_denominator
    {
        diff.push(ObsVideoFieldDiff {
            field: ObsVideoField::FrameRate,
            current: format!("{}/{}", current.fps_numerator, current.fps_denominator),
            target: format!("{}/{}", target.fps_numerator, target.fps_denominator),
        });
    }
    let mut warnings = Vec::new();
    if recording_active {
        warnings.push("OBS is recording; applying this plan is blocked".to_owned());
    }
    if diff.is_empty() {
        warnings.push("OBS output video settings already match the saved defaults".to_owned());
    }
    let expected_fingerprint = plan_fingerprint(current, &target);
    Ok(ObsVideoTuningPlan {
        current: snapshot(current),
        target: snapshot(&target),
        diff,
        expected_fingerprint,
        recording_active,
        warnings,
        managed_fields: vec!["output_resolution".to_owned(), "frame_rate".to_owned()],
        excluded_fields: vec![
            "base_canvas".to_owned(),
            "encoder".to_owned(),
            "bitrate".to_owned(),
            "scene".to_owned(),
        ],
    })
}

fn parse_resolution(resolution: &str) -> Result<(u32, u32), DomainError> {
    let (width, height) = resolution.trim().split_once('x').ok_or_else(|| {
        DomainError::InvalidInput("saved recording resolution is invalid".to_owned())
    })?;
    let width = width.parse::<u32>().map_err(|_| {
        DomainError::InvalidInput("saved recording resolution width is invalid".to_owned())
    })?;
    let height = height.parse::<u32>().map_err(|_| {
        DomainError::InvalidInput("saved recording resolution height is invalid".to_owned())
    })?;
    Ok((width, height))
}

fn validate_settings(settings: &ObsVideoSettings) -> Result<(), DomainError> {
    let dimensions = [
        settings.base_width,
        settings.base_height,
        settings.output_width,
        settings.output_height,
    ];
    if dimensions
        .into_iter()
        .any(|dimension| !(16..=16_384).contains(&dimension))
        || settings.fps_numerator == 0
        || settings.fps_denominator == 0
        || settings.fps_numerator > 1_000_000
        || settings.fps_denominator > 1_000_000
        || settings.fps_numerator > settings.fps_denominator.saturating_mul(1_000)
    {
        return Err(DomainError::InvalidInput(
            "OBS backup contains invalid video settings".to_owned(),
        ));
    }
    Ok(())
}

fn validate_fingerprint(fingerprint: &str) -> Result<(), DomainError> {
    if fingerprint.len() == 64
        && fingerprint
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        Ok(())
    } else {
        Err(DomainError::InvalidInput(
            "expected fingerprint must be a lowercase SHA-256 value".to_owned(),
        ))
    }
}

fn snapshot(settings: &ObsVideoSettings) -> ObsVideoSettingsSnapshot {
    ObsVideoSettingsSnapshot {
        base_width: settings.base_width,
        base_height: settings.base_height,
        output_width: settings.output_width,
        output_height: settings.output_height,
        fps_numerator: settings.fps_numerator,
        fps_denominator: settings.fps_denominator,
    }
}

fn settings(snapshot: &ObsVideoSettingsSnapshot) -> ObsVideoSettings {
    ObsVideoSettings {
        base_width: snapshot.base_width,
        base_height: snapshot.base_height,
        output_width: snapshot.output_width,
        output_height: snapshot.output_height,
        fps_numerator: snapshot.fps_numerator,
        fps_denominator: snapshot.fps_denominator,
    }
}

fn output_settings(settings: &ObsVideoSettings) -> ObsVideoOutputSettings {
    ObsVideoOutputSettings {
        output_width: settings.output_width,
        output_height: settings.output_height,
        fps_numerator: settings.fps_numerator,
        fps_denominator: settings.fps_denominator,
    }
}

fn with_output(base: &ObsVideoSettings, output: &ObsVideoSettings) -> ObsVideoSettings {
    ObsVideoSettings {
        base_width: base.base_width,
        base_height: base.base_height,
        output_width: output.output_width,
        output_height: output.output_height,
        fps_numerator: output.fps_numerator,
        fps_denominator: output.fps_denominator,
    }
}

fn update_settings_hash(hasher: &mut Sha256, settings: &ObsVideoSettings) {
    for value in [
        settings.base_width,
        settings.base_height,
        settings.output_width,
        settings.output_height,
        settings.fps_numerator,
        settings.fps_denominator,
    ] {
        hasher.update(value.to_be_bytes());
    }
}

fn plan_fingerprint(current: &ObsVideoSettings, target: &ObsVideoSettings) -> String {
    let mut hasher = Sha256::new();
    hasher.update(b"vibe-cs-obs-video-plan-v1\0");
    update_settings_hash(&mut hasher, current);
    update_settings_hash(&mut hasher, target);
    format!("{:x}", hasher.finalize())
}

fn settings_fingerprint(settings: &ObsVideoSettings) -> String {
    let mut hasher = Sha256::new();
    hasher.update(b"vibe-cs-obs-video-settings-v1\0");
    update_settings_hash(&mut hasher, settings);
    format!("{:x}", hasher.finalize())
}

fn backup_authentication_tag(
    authentication_key: &[u8; BACKUP_AUTHENTICATION_KEY_BYTES],
    envelope: &BackupEnvelope,
) -> Result<[u8; BACKUP_AUTHENTICATION_TAG_BYTES], DomainError> {
    let mut mac = BackupHmac::new_from_slice(authentication_key)
        .map_err(|_| DomainError::Internal("initialize OBS backup HMAC".to_owned()))?;
    update_backup_mac(&mut mac, envelope);
    let bytes = mac.finalize().into_bytes();
    let mut tag = [0_u8; BACKUP_AUTHENTICATION_TAG_BYTES];
    tag.copy_from_slice(&bytes);
    Ok(tag)
}

fn verify_backup_authentication(
    authentication_key: &[u8; BACKUP_AUTHENTICATION_KEY_BYTES],
    envelope: &BackupEnvelope,
) -> Result<(), DomainError> {
    let tag = decode_authentication_tag(&envelope.authentication_tag).ok_or_else(|| {
        DomainError::Conflict("OBS backup authentication tag is invalid".to_owned())
    })?;
    let mut mac = BackupHmac::new_from_slice(authentication_key)
        .map_err(|_| DomainError::Internal("initialize OBS backup HMAC".to_owned()))?;
    update_backup_mac(&mut mac, envelope);
    // `Mac::verify_slice` performs the tag comparison in constant time.
    mac.verify_slice(&tag).map_err(|_| {
        DomainError::Conflict("OBS backup authentication validation failed".to_owned())
    })
}

fn update_backup_mac(mac: &mut BackupHmac, envelope: &BackupEnvelope) {
    mac.update(b"vibe-cs-obs-video-backup-envelope-v2\0");
    mac.update(&envelope.version.to_be_bytes());
    mac.update(envelope.id.as_bytes());
    mac.update(&envelope.created_at.timestamp().to_be_bytes());
    mac.update(&envelope.created_at.timestamp_subsec_nanos().to_be_bytes());
    mac.update(&[match envelope.reason {
        ObsVideoBackupReason::Apply => 0,
        ObsVideoBackupReason::BeforeRestore => 1,
    }]);
    for value in [
        envelope.settings.base_width,
        envelope.settings.base_height,
        envelope.settings.output_width,
        envelope.settings.output_height,
        envelope.settings.fps_numerator,
        envelope.settings.fps_denominator,
    ] {
        mac.update(&value.to_be_bytes());
    }
    mac.update(
        &u64::try_from(envelope.settings_fingerprint.len())
            .unwrap_or(u64::MAX)
            .to_be_bytes(),
    );
    mac.update(envelope.settings_fingerprint.as_bytes());
}

fn encode_authentication_tag(tag: &[u8; BACKUP_AUTHENTICATION_TAG_BYTES]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut encoded = String::with_capacity(BACKUP_AUTHENTICATION_TAG_BYTES * 2);
    for byte in tag {
        encoded.push(char::from(HEX[usize::from(byte >> 4)]));
        encoded.push(char::from(HEX[usize::from(byte & 0x0f)]));
    }
    encoded
}

fn decode_authentication_tag(encoded: &str) -> Option<[u8; BACKUP_AUTHENTICATION_TAG_BYTES]> {
    if encoded.len() != BACKUP_AUTHENTICATION_TAG_BYTES * 2 || !encoded.is_ascii() {
        return None;
    }
    let mut tag = [0_u8; BACKUP_AUTHENTICATION_TAG_BYTES];
    for (index, pair) in encoded.as_bytes().chunks_exact(2).enumerate() {
        let high = decode_lower_hex_digit(pair[0])?;
        let low = decode_lower_hex_digit(pair[1])?;
        tag[index] = (high << 4) | low;
    }
    Some(tag)
}

fn decode_lower_hex_digit(value: u8) -> Option<u8> {
    match value {
        b'0'..=b'9' => Some(value - b'0'),
        b'a'..=b'f' => Some(value - b'a' + 10),
        _ => None,
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct BackupEnvelope {
    version: u32,
    id: Uuid,
    created_at: DateTime<Utc>,
    reason: ObsVideoBackupReason,
    settings: ObsVideoSettingsSnapshot,
    settings_fingerprint: String,
    authentication_tag: String,
}

impl BackupEnvelope {
    fn authenticated(
        backup: &ObsVideoBackup,
        authentication_key: &[u8; BACKUP_AUTHENTICATION_KEY_BYTES],
    ) -> Result<Self, DomainError> {
        let mut envelope = Self {
            version: BACKUP_FORMAT_VERSION,
            id: backup.id,
            created_at: backup.created_at,
            reason: backup.reason,
            settings: backup.settings,
            settings_fingerprint: backup.settings_fingerprint.clone(),
            authentication_tag: String::new(),
        };
        envelope.authentication_tag =
            encode_authentication_tag(&backup_authentication_tag(authentication_key, &envelope)?);
        Ok(envelope)
    }
}

impl From<BackupEnvelope> for ObsVideoBackup {
    fn from(backup: BackupEnvelope) -> Self {
        Self {
            id: backup.id,
            created_at: backup.created_at,
            reason: backup.reason,
            settings: backup.settings,
            settings_fingerprint: backup.settings_fingerprint,
        }
    }
}

fn ensure_backup_directory(directory: &Path) -> Result<(), DomainError> {
    match fs::symlink_metadata(directory) {
        Ok(metadata) => {
            if metadata.file_type().is_symlink() || !metadata.is_dir() {
                return Err(DomainError::Conflict(
                    "OBS backup directory is not a regular directory".to_owned(),
                ));
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            fs::create_dir_all(directory).map_err(|error| backup_io("create directory", &error))?;
            let metadata = fs::symlink_metadata(directory)
                .map_err(|error| backup_io("inspect created directory", &error))?;
            if metadata.file_type().is_symlink() || !metadata.is_dir() {
                return Err(DomainError::Conflict(
                    "OBS backup directory changed during creation".to_owned(),
                ));
            }
        }
        Err(error) => return Err(backup_io("inspect directory", &error)),
    }
    Ok(())
}

fn load_backup_authentication_key(
    directory: &Path,
) -> Result<[u8; BACKUP_AUTHENTICATION_KEY_BYTES], DomainError> {
    read_backup_authentication_key(&directory.join(BACKUP_AUTHENTICATION_KEY_FILE))
}

fn load_or_create_backup_authentication_key(
    directory: &Path,
) -> Result<[u8; BACKUP_AUTHENTICATION_KEY_BYTES], DomainError> {
    let path = directory.join(BACKUP_AUTHENTICATION_KEY_FILE);
    match fs::symlink_metadata(&path) {
        Ok(_) => return read_backup_authentication_key(&path),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(backup_io("inspect authentication key", &error)),
    }
    if !managed_backup_paths(directory)?.is_empty() {
        return Err(DomainError::Conflict(
            "OBS backup authentication key is missing while backups exist".to_owned(),
        ));
    }

    let mut key = [0_u8; BACKUP_AUTHENTICATION_KEY_BYTES];
    getrandom::fill(&mut key).map_err(|error| {
        DomainError::Internal(format!("generate OBS backup authentication key: {error}"))
    })?;
    let temporary = directory.join(format!(
        "{BACKUP_AUTHENTICATION_KEY_FILE}.{}.tmp",
        Uuid::new_v4()
    ));
    let persistence = (|| {
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt as _;
            options.mode(0o600);
        }
        let mut file = options
            .open(&temporary)
            .map_err(|error| backup_io("create authentication key", &error))?;
        file.write_all(&key)
            .and_then(|()| file.flush())
            .and_then(|()| file.sync_all())
            .map_err(|error| backup_io("persist authentication key", &error))
    })();
    if let Err(error) = persistence {
        let _ = fs::remove_file(&temporary);
        return Err(error);
    }
    let publication = fs::hard_link(&temporary, &path);
    let _ = fs::remove_file(&temporary);
    match publication {
        Ok(()) => Ok(key),
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            read_backup_authentication_key(&path)
        }
        Err(error) => Err(backup_io("publish authentication key", &error)),
    }
}

fn read_backup_authentication_key(
    path: &Path,
) -> Result<[u8; BACKUP_AUTHENTICATION_KEY_BYTES], DomainError> {
    let metadata = fs::symlink_metadata(path).map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            DomainError::Conflict("OBS backup authentication key is missing".to_owned())
        } else {
            backup_io("inspect authentication key", &error)
        }
    })?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(DomainError::Conflict(
            "OBS backup authentication key is not a regular file".to_owned(),
        ));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        if metadata.permissions().mode() & 0o077 != 0 {
            return Err(DomainError::Conflict(
                "OBS backup authentication key permissions are not private".to_owned(),
            ));
        }
    }
    if metadata.len() != BACKUP_AUTHENTICATION_KEY_BYTES as u64 {
        return Err(DomainError::Conflict(
            "OBS backup authentication key has an invalid length".to_owned(),
        ));
    }
    let mut bytes = Vec::with_capacity(BACKUP_AUTHENTICATION_KEY_BYTES);
    File::open(path)
        .map_err(|error| backup_io("open authentication key", &error))?
        .take(BACKUP_AUTHENTICATION_KEY_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| backup_io("read authentication key", &error))?;
    bytes.try_into().map_err(|_| {
        DomainError::Conflict("OBS backup authentication key changed while read".to_owned())
    })
}

fn managed_backup_paths(directory: &Path) -> Result<Vec<(PathBuf, SystemTime)>, DomainError> {
    let mut managed = Vec::new();
    for (index, entry) in fs::read_dir(directory)
        .map_err(|error| backup_io("list directory", &error))?
        .enumerate()
    {
        if index >= MAXIMUM_BACKUP_DIRECTORY_ENTRIES {
            return Err(DomainError::Conflict(
                "OBS backup directory contains too many entries".to_owned(),
            ));
        }
        let entry = entry.map_err(|error| backup_io("read directory entry", &error))?;
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        let Some(stem) = name.strip_suffix(".json") else {
            continue;
        };
        let Ok(id) = Uuid::parse_str(stem) else {
            continue;
        };
        if name != format!("{id}.json") {
            continue;
        }
        let metadata = fs::symlink_metadata(entry.path())
            .map_err(|error| backup_io("inspect backup", &error))?;
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            return Err(DomainError::Conflict(format!(
                "managed OBS backup {id} is not a regular file"
            )));
        }
        managed.push((
            entry.path(),
            metadata.modified().unwrap_or(SystemTime::UNIX_EPOCH),
        ));
    }
    Ok(managed)
}

fn prune_backups_to_limit(directory: &Path, protected_backups: &[Uuid]) -> Result<(), DomainError> {
    let mut managed = managed_backup_paths(directory)?;
    managed.sort_by(|left, right| left.1.cmp(&right.1).then_with(|| left.0.cmp(&right.0)));
    while managed.len() > MAXIMUM_BACKUPS {
        let removable = managed
            .iter()
            .position(|(path, _)| {
                managed_backup_id(path).is_none_or(|id| !protected_backups.contains(&id))
            })
            .ok_or_else(|| {
                DomainError::Conflict("no OBS backup can be pruned safely".to_owned())
            })?;
        let (path, _) = managed.remove(removable);
        fs::remove_file(&path).map_err(|error| backup_io("prune oldest backup", &error))?;
    }
    Ok(())
}

fn managed_backup_id(path: &Path) -> Option<Uuid> {
    path.file_stem()
        .and_then(|stem| stem.to_str())
        .and_then(|stem| Uuid::parse_str(stem).ok())
}

fn write_backup(
    directory: &Path,
    backup: &ObsVideoBackup,
    protected_backup: Option<Uuid>,
) -> Result<(), DomainError> {
    ensure_backup_directory(directory)?;
    let authentication_key = load_or_create_backup_authentication_key(directory)?;
    if managed_backup_paths(directory)?.len() > MAXIMUM_BACKUPS {
        // A prior post-publication prune may leave one excess file. Converge it and make the
        // caller retry before attempting another publication, so a later publication failure
        // cannot consume an existing backup.
        prune_backups_to_limit(directory, &[])?;
        return Err(DomainError::Conflict(
            "OBS backup retention was recovered; retry backup creation".to_owned(),
        ));
    }
    let envelope = BackupEnvelope::authenticated(backup, &authentication_key)?;
    let bytes = serde_json::to_vec_pretty(&envelope)
        .map_err(|error| DomainError::Internal(format!("serialize OBS backup: {error}")))?;
    if u64::try_from(bytes.len()).unwrap_or(u64::MAX) > MAXIMUM_BACKUP_BYTES {
        return Err(DomainError::Internal(
            "serialized OBS backup exceeded its size limit".to_owned(),
        ));
    }
    let final_path = directory.join(format!("{}.json", backup.id));
    let temporary = directory.join(format!(".{}.{}.tmp", backup.id, Uuid::new_v4()));
    let publication = (|| {
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt as _;
            options.mode(0o600);
        }
        let mut file = options
            .open(&temporary)
            .map_err(|error| backup_io("create temporary backup", &error))?;
        file.write_all(&bytes)
            .and_then(|()| file.flush())
            .and_then(|()| file.sync_all())
            .map_err(|error| backup_io("persist temporary backup", &error))?;
        drop(file);
        fs::hard_link(&temporary, &final_path)
            .map_err(|error| backup_io("publish create-new backup", &error))?;
        Ok::<(), DomainError>(())
    })();
    let _ = fs::remove_file(&temporary);
    publication?;

    // Publication is the commit point. Retention runs afterwards and the new backup is always
    // protected, so a failed prune returns an error while leaving at most the 33rd file present.
    let mut protected = vec![backup.id];
    if let Some(id) = protected_backup {
        protected.push(id);
    }
    prune_backups_to_limit(directory, &protected).map_err(|error| {
        DomainError::Internal(format!(
            "OBS backup was published, but retention cleanup failed; retry listing backups: {error}"
        ))
    })
}

fn read_backup(directory: &Path, id: Uuid) -> Result<ObsVideoBackup, DomainError> {
    ensure_backup_directory(directory)?;
    let authentication_key = load_backup_authentication_key(directory)?;
    read_backup_with_key(directory, id, &authentication_key)
}

fn read_backup_with_key(
    directory: &Path,
    id: Uuid,
    authentication_key: &[u8; BACKUP_AUTHENTICATION_KEY_BYTES],
) -> Result<ObsVideoBackup, DomainError> {
    let path = directory.join(format!("{id}.json"));
    let metadata = fs::symlink_metadata(&path).map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            DomainError::NotFound("OBS video settings backup".to_owned())
        } else {
            backup_io("inspect backup", &error)
        }
    })?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(DomainError::Conflict(
            "OBS backup is not a regular file".to_owned(),
        ));
    }
    if metadata.len() > MAXIMUM_BACKUP_BYTES {
        return Err(DomainError::Conflict(
            "OBS backup exceeds its size limit".to_owned(),
        ));
    }
    let mut bytes = Vec::new();
    File::open(&path)
        .map_err(|error| backup_io("open backup", &error))?
        .take(MAXIMUM_BACKUP_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| backup_io("read backup", &error))?;
    if u64::try_from(bytes.len()).unwrap_or(u64::MAX) > MAXIMUM_BACKUP_BYTES {
        return Err(DomainError::Conflict(
            "OBS backup changed while it was read".to_owned(),
        ));
    }
    let envelope = serde_json::from_slice::<BackupEnvelope>(&bytes)
        .map_err(|_| DomainError::Conflict("OBS backup JSON is invalid or tampered".to_owned()))?;
    verify_backup_authentication(authentication_key, &envelope)?;
    if envelope.version != BACKUP_FORMAT_VERSION || envelope.id != id {
        return Err(DomainError::Conflict(
            "OBS backup identity or version is invalid".to_owned(),
        ));
    }
    let restored_settings = settings(&envelope.settings);
    validate_settings(&restored_settings)
        .map_err(|_| DomainError::Conflict("OBS backup video settings are invalid".to_owned()))?;
    if settings_fingerprint(&restored_settings) != envelope.settings_fingerprint {
        return Err(DomainError::Conflict(
            "OBS backup fingerprint validation failed".to_owned(),
        ));
    }
    Ok(envelope.into())
}

fn list_backups(directory: &Path) -> Result<Vec<ObsVideoBackup>, DomainError> {
    match fs::symlink_metadata(directory) {
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(backup_io("inspect directory", &error)),
    }
    ensure_backup_directory(directory)?;
    prune_backups_to_limit(directory, &[])?;
    let managed = managed_backup_paths(directory)?;
    if managed.is_empty() {
        return Ok(Vec::new());
    }
    let authentication_key = load_backup_authentication_key(directory)?;
    let mut backups = managed
        .into_iter()
        .filter_map(|(path, _)| {
            let id = path
                .file_stem()
                .and_then(|stem| stem.to_str())
                .and_then(|stem| Uuid::parse_str(stem).ok())?;
            match read_backup_with_key(directory, id, &authentication_key) {
                Ok(backup) => Some(backup),
                Err(error) => {
                    tracing::warn!(%error, %id, "ignoring invalid OBS backup while listing");
                    None
                }
            }
        })
        .collect::<Vec<_>>();
    backups.sort_by_key(|backup| std::cmp::Reverse(backup.created_at));
    Ok(backups)
}

fn delete_backup(directory: &Path, id: Uuid) -> Result<(), DomainError> {
    ensure_backup_directory(directory)?;
    let path = directory.join(format!("{id}.json"));
    let metadata = fs::symlink_metadata(&path).map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            DomainError::NotFound("OBS video settings backup".to_owned())
        } else {
            backup_io("inspect backup before deletion", &error)
        }
    })?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(DomainError::Conflict(
            "refusing to delete a non-regular OBS backup".to_owned(),
        ));
    }
    fs::remove_file(path).map_err(|error| backup_io("delete backup", &error))
}

fn backup_io(operation: &str, error: &std::io::Error) -> DomainError {
    DomainError::Internal(format!("OBS backup {operation}: {error}"))
}

fn map_integration_error(error: IntegrationError) -> DomainError {
    match error {
        IntegrationError::NotConfigured {
            integration,
            message,
        }
        | IntegrationError::Unavailable {
            integration,
            message,
        } => DomainError::DependencyUnavailable(format!("{integration}: {message}")),
        IntegrationError::InvalidConfiguration(message)
        | IntegrationError::InvalidInput(message)
        | IntegrationError::Protocol(message) => DomainError::InvalidInput(message),
        IntegrationError::HttpStatus { status, message } => DomainError::DependencyUnavailable(
            format!("remote service returned HTTP {status}: {message}"),
        ),
        IntegrationError::ResponseLimit(limit) => {
            DomainError::InvalidInput(format!("integration response exceeded {limit} bytes"))
        }
        IntegrationError::Cancelled => {
            DomainError::Conflict("integration was cancelled".to_owned())
        }
        IntegrationError::Io { path, source } => DomainError::DependencyUnavailable(format!(
            "I/O failure for {}: {source}",
            path.display()
        )),
        IntegrationError::Http(error) => {
            DomainError::DependencyUnavailable(format!("integration request failed: {error}"))
        }
        IntegrationError::Url(error) => DomainError::InvalidInput(format!("invalid URL: {error}")),
        IntegrationError::Json(error) => {
            DomainError::InvalidInput(format!("invalid integration response: {error}"))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Debug)]
    struct FakeObsState {
        settings: ObsVideoSettings,
        recording_active: bool,
        change_before_set: Option<ObsVideoSettings>,
        corrupt_after_set_once: bool,
    }

    #[derive(Debug, Clone)]
    struct FakeObsConnector {
        state: Arc<Mutex<FakeObsState>>,
    }

    #[derive(Debug)]
    struct FakeObsConnection {
        state: Arc<Mutex<FakeObsState>>,
    }

    #[async_trait]
    impl ObsVideoConnector for FakeObsConnector {
        async fn connect(
            &self,
            _config: &ObsConfig,
        ) -> Result<Box<dyn ObsVideoConnection>, DomainError> {
            Ok(Box::new(FakeObsConnection {
                state: Arc::clone(&self.state),
            }))
        }
    }

    #[async_trait]
    impl ObsVideoConnection for FakeObsConnection {
        async fn record_status(&mut self) -> Result<ObsRecordStatus, DomainError> {
            let state = self.state.lock().await;
            Ok(ObsRecordStatus {
                active: state.recording_active,
                paused: false,
                timecode: None,
                output_path: None,
            })
        }

        async fn video_settings(&mut self) -> Result<ObsVideoSettings, DomainError> {
            Ok(self.state.lock().await.settings.clone())
        }

        async fn set_video_settings(
            &mut self,
            expected_current: &ObsVideoSettings,
            target: ObsVideoOutputSettings,
        ) -> Result<(), DomainError> {
            let mut state = self.state.lock().await;
            if state.recording_active {
                return Err(DomainError::Conflict(
                    "OBS started recording immediately before SetVideoSettings".to_owned(),
                ));
            }
            if let Some(changed) = state.change_before_set.take() {
                state.settings = changed;
            }
            if state.settings != *expected_current {
                return Err(DomainError::Conflict(
                    "OBS video settings changed immediately before SetVideoSettings".to_owned(),
                ));
            }
            state.settings = ObsVideoSettings {
                base_width: state.settings.base_width,
                base_height: state.settings.base_height,
                output_width: target.output_width,
                output_height: target.output_height,
                fps_numerator: target.fps_numerator,
                fps_denominator: target.fps_denominator,
            };
            if state.corrupt_after_set_once {
                state.corrupt_after_set_once = false;
                state.settings.fps_numerator = state.settings.fps_numerator.saturating_add(1);
            }
            Ok(())
        }
    }

    fn original_settings() -> ObsVideoSettings {
        ObsVideoSettings {
            base_width: 2560,
            base_height: 1440,
            output_width: 1280,
            output_height: 720,
            fps_numerator: 30,
            fps_denominator: 1,
        }
    }

    fn fake_connector(settings: ObsVideoSettings) -> FakeObsConnector {
        FakeObsConnector {
            state: Arc::new(Mutex::new(FakeObsState {
                settings,
                recording_active: false,
                change_before_set: None,
                corrupt_after_set_once: false,
            })),
        }
    }

    async fn test_port(
        directory: &tempfile::TempDir,
        connector: FakeObsConnector,
    ) -> RuntimeObsTuningPort {
        let storage = Storage::open_in_memory().await.expect("storage");
        let mut config = AppConfig::default();
        config.obs.password = "must-not-appear-in-backup".to_owned();
        config.recording.resolution = "1920x1080".to_owned();
        config.recording.fps = 60;
        storage.put_config(config).await.expect("config");
        RuntimeObsTuningPort::new(storage, directory.path().to_path_buf())
            .with_connector(Arc::new(connector))
    }

    async fn apply_plan(port: &RuntimeObsTuningPort) -> ObsVideoApplyResult {
        let plan = port.plan().await.expect("plan");
        port.apply(ObsVideoApplyRequest {
            confirm: true,
            expected_fingerprint: plan.expected_fingerprint,
        })
        .await
        .expect("apply")
    }

    #[test]
    fn hmac_covers_the_canonical_backup_envelope() {
        let backup = ObsVideoBackup {
            id: Uuid::new_v4(),
            created_at: Utc::now(),
            reason: ObsVideoBackupReason::Apply,
            settings: snapshot(&original_settings()),
            settings_fingerprint: settings_fingerprint(&original_settings()),
        };
        let key = [7_u8; BACKUP_AUTHENTICATION_KEY_BYTES];
        let envelope =
            BackupEnvelope::authenticated(&backup, &key).expect("authenticated envelope");
        verify_backup_authentication(&key, &envelope).expect("valid HMAC");
        assert!(
            verify_backup_authentication(&[8_u8; BACKUP_AUTHENTICATION_KEY_BYTES], &envelope)
                .is_err()
        );

        let mut changed_version = envelope.clone();
        changed_version.version += 1;
        let mut changed_id = envelope.clone();
        changed_id.id = Uuid::new_v4();
        let mut changed_time = envelope.clone();
        changed_time.created_at += chrono::Duration::seconds(1);
        let mut changed_reason = envelope.clone();
        changed_reason.reason = ObsVideoBackupReason::BeforeRestore;
        let mut changed_settings = envelope.clone();
        changed_settings.settings.output_width += 1;
        let mut changed_fingerprint = envelope.clone();
        changed_fingerprint.settings_fingerprint = "0".repeat(64);

        for changed in [
            changed_version,
            changed_id,
            changed_time,
            changed_reason,
            changed_settings,
            changed_fingerprint,
        ] {
            assert!(verify_backup_authentication(&key, &changed).is_err());
        }
    }

    #[tokio::test]
    async fn plan_derives_target_from_saved_defaults_and_apply_creates_secret_free_backup() {
        let directory = tempfile::tempdir().expect("directory");
        let connector = fake_connector(original_settings());
        let port = test_port(&directory, connector.clone()).await;

        let plan = port.plan().await.expect("plan");
        assert_eq!(
            (plan.target.output_width, plan.target.output_height),
            (1920, 1080)
        );
        assert_eq!(
            (plan.target.fps_numerator, plan.target.fps_denominator),
            (60, 1)
        );
        assert_eq!(plan.diff.len(), 2);
        assert_eq!(plan.managed_fields, ["output_resolution", "frame_rate"]);
        assert!(plan.excluded_fields.contains(&"encoder".to_owned()));
        assert!(plan.excluded_fields.contains(&"bitrate".to_owned()));
        assert!(plan.excluded_fields.contains(&"scene".to_owned()));

        let result = port
            .apply(ObsVideoApplyRequest {
                confirm: true,
                expected_fingerprint: plan.expected_fingerprint,
            })
            .await
            .expect("apply");
        assert!(result.applied);
        let backup = result.backup.expect("backup");
        let persisted =
            fs::read_to_string(port.backup_directory().join(format!("{}.json", backup.id)))
                .expect("backup JSON");
        assert!(!persisted.contains("must-not-appear-in-backup"));
        assert!(!persisted.contains("password"));
        assert!(persisted.contains("authentication_tag"));
        assert_eq!(
            fs::read(port.backup_directory().join(BACKUP_AUTHENTICATION_KEY_FILE))
                .expect("private authentication key")
                .len(),
            BACKUP_AUTHENTICATION_KEY_BYTES
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;
            let key_metadata =
                fs::metadata(port.backup_directory().join(BACKUP_AUTHENTICATION_KEY_FILE))
                    .expect("authentication key metadata");
            assert_eq!(key_metadata.permissions().mode() & 0o077, 0);
        }
        let state = connector.state.lock().await;
        assert_eq!(
            (state.settings.output_width, state.settings.output_height),
            (1920, 1080)
        );
    }

    #[tokio::test]
    async fn verification_failure_rolls_back_and_reports_the_combined_outcome() {
        let directory = tempfile::tempdir().expect("directory");
        let connector = fake_connector(original_settings());
        connector.state.lock().await.corrupt_after_set_once = true;
        let port = test_port(&directory, connector.clone()).await;
        let plan = port.plan().await.expect("plan");

        let error = port
            .apply(ObsVideoApplyRequest {
                confirm: true,
                expected_fingerprint: plan.expected_fingerprint,
            })
            .await
            .expect_err("verification must fail");
        assert!(
            error
                .to_string()
                .contains("previous output settings were restored")
        );
        assert_eq!(connector.state.lock().await.settings, original_settings());
        assert_eq!(port.list_backups().await.expect("backups").len(), 1);
    }

    #[tokio::test]
    async fn optimistic_lock_rejects_both_pre_apply_and_immediate_pre_set_changes() {
        let directory = tempfile::tempdir().expect("directory");
        let connector = fake_connector(original_settings());
        let port = test_port(&directory, connector.clone()).await;
        let plan = port.plan().await.expect("plan");
        connector.state.lock().await.settings.output_width = 1366;

        let error = port
            .apply(ObsVideoApplyRequest {
                confirm: true,
                expected_fingerprint: plan.expected_fingerprint,
            })
            .await
            .expect_err("stale plan must fail");
        assert!(matches!(error, DomainError::Conflict(_)));
        assert!(port.list_backups().await.expect("backups").is_empty());

        connector.state.lock().await.settings = original_settings();
        let fresh = port.plan().await.expect("fresh plan");
        let externally_changed = ObsVideoSettings {
            output_width: 1600,
            output_height: 900,
            ..original_settings()
        };
        connector.state.lock().await.change_before_set = Some(externally_changed.clone());
        let error = port
            .apply(ObsVideoApplyRequest {
                confirm: true,
                expected_fingerprint: fresh.expected_fingerprint,
            })
            .await
            .expect_err("pre-set change must fail");
        assert!(matches!(error, DomainError::Conflict(_)));
        assert_eq!(connector.state.lock().await.settings, externally_changed);
    }

    #[tokio::test]
    async fn tampered_backup_with_a_recomputed_plain_hash_is_rejected_before_restore() {
        let directory = tempfile::tempdir().expect("directory");
        let connector = fake_connector(original_settings());
        let port = test_port(&directory, connector.clone()).await;
        let result = apply_plan(&port).await;
        let id = result.backup.expect("backup").id;
        let path = port.backup_directory().join(format!("{id}.json"));
        let mut document: serde_json::Value =
            serde_json::from_slice(&fs::read(&path).expect("backup")).expect("JSON");
        document["settings"]["output_width"] = serde_json::json!(1024);
        let mut forged_settings = original_settings();
        forged_settings.output_width = 1024;
        document["settings_fingerprint"] =
            serde_json::json!(settings_fingerprint(&forged_settings));
        fs::write(&path, serde_json::to_vec_pretty(&document).expect("JSON")).expect("tamper");

        let before = connector.state.lock().await.settings.clone();
        let error = port
            .restore(id, ObsVideoRestoreRequest { confirm: true })
            .await
            .expect_err("tampered backup must fail");
        assert!(matches!(error, DomainError::Conflict(_)));
        assert!(error.to_string().contains("authentication validation"));
        assert_eq!(connector.state.lock().await.settings, before);
        assert!(port.list_backups().await.expect("list").is_empty());
    }

    #[tokio::test]
    async fn publication_failure_at_capacity_does_not_delete_existing_backups() {
        let directory = tempfile::tempdir().expect("directory");
        let connector = fake_connector(original_settings());
        let port = test_port(&directory, connector).await;
        for index in 0..MAXIMUM_BACKUPS {
            let mut settings = original_settings();
            settings.output_width += u32::try_from(index).expect("bounded test index");
            port.create_backup(&settings, ObsVideoBackupReason::Apply)
                .await
                .expect("backup");
        }
        let backup_directory = port.backup_directory();
        let before = managed_backup_paths(&backup_directory).expect("managed backups");
        let existing_ids = before
            .iter()
            .filter_map(|(path, _)| managed_backup_id(path))
            .collect::<Vec<_>>();
        let collision_path = backup_directory.join(format!("{}.json", existing_ids[0]));
        let collision_contents = fs::read(&collision_path).expect("existing backup contents");
        let collision = ObsVideoBackup {
            id: existing_ids[0],
            created_at: Utc::now(),
            reason: ObsVideoBackupReason::Apply,
            settings: snapshot(&original_settings()),
            settings_fingerprint: settings_fingerprint(&original_settings()),
        };

        write_backup(&backup_directory, &collision, None)
            .expect_err("create-new publication must fail on an existing id");

        let after = managed_backup_paths(&backup_directory).expect("managed backups");
        let after_ids = after
            .iter()
            .filter_map(|(path, _)| managed_backup_id(path))
            .collect::<Vec<_>>();
        assert_eq!(after.len(), MAXIMUM_BACKUPS);
        assert!(existing_ids.iter().all(|id| after_ids.contains(id)));
        assert_eq!(
            fs::read(collision_path).expect("unchanged existing backup"),
            collision_contents
        );
        assert_eq!(
            port.list_backups().await.expect("backups").len(),
            MAXIMUM_BACKUPS
        );
    }

    #[tokio::test]
    async fn backup_retention_never_exceeds_thirty_two_regular_files() {
        let directory = tempfile::tempdir().expect("directory");
        let connector = fake_connector(original_settings());
        let port = test_port(&directory, connector).await;
        for index in 0..40 {
            let mut settings = original_settings();
            settings.output_width += index;
            port.create_backup(&settings, ObsVideoBackupReason::Apply)
                .await
                .expect("backup");
        }

        let backups = port.list_backups().await.expect("backups");
        assert_eq!(backups.len(), MAXIMUM_BACKUPS);
        assert_eq!(
            managed_backup_paths(&port.backup_directory())
                .expect("managed backups")
                .len(),
            MAXIMUM_BACKUPS
        );

        let overflow = ObsVideoBackup {
            id: Uuid::new_v4(),
            created_at: Utc::now(),
            reason: ObsVideoBackupReason::Apply,
            settings: snapshot(&original_settings()),
            settings_fingerprint: settings_fingerprint(&original_settings()),
        };
        let authentication_key =
            load_backup_authentication_key(&port.backup_directory()).expect("authentication key");
        let envelope =
            BackupEnvelope::authenticated(&overflow, &authentication_key).expect("envelope");
        fs::write(
            port.backup_directory()
                .join(format!("{}.json", overflow.id)),
            serde_json::to_vec_pretty(&envelope).expect("serialize overflow"),
        )
        .expect("simulate published retention excess");
        assert_eq!(
            managed_backup_paths(&port.backup_directory())
                .expect("managed backups")
                .len(),
            MAXIMUM_BACKUPS + 1
        );
        assert_eq!(
            port.list_backups().await.expect("converged backups").len(),
            MAXIMUM_BACKUPS
        );
        assert_eq!(
            managed_backup_paths(&port.backup_directory())
                .expect("managed backups")
                .len(),
            MAXIMUM_BACKUPS
        );
    }

    #[tokio::test]
    async fn restore_is_confirmed_verified_and_delete_uses_only_uuid_identity() {
        let directory = tempfile::tempdir().expect("directory");
        let connector = fake_connector(original_settings());
        let port = test_port(&directory, connector.clone()).await;
        let applied = apply_plan(&port).await;
        let backup = applied.backup.expect("backup");
        {
            let mut state = connector.state.lock().await;
            state.settings.base_width = 3840;
            state.settings.base_height = 2160;
        }

        let restored = port
            .restore(backup.id, ObsVideoRestoreRequest { confirm: true })
            .await
            .expect("restore");
        assert!(restored.restored);
        let restored_settings = connector.state.lock().await.settings.clone();
        assert_eq!(
            (restored_settings.base_width, restored_settings.base_height),
            (3840, 2160)
        );
        assert_eq!(
            (
                restored_settings.output_width,
                restored_settings.output_height
            ),
            (1280, 720)
        );
        assert!(restored.rollback_backup.is_some());

        let deleted = port.delete_backup(backup.id).await.expect("delete");
        assert!(deleted.deleted);
        assert!(
            !port
                .list_backups()
                .await
                .expect("backups")
                .iter()
                .any(|item| item.id == backup.id)
        );
    }

    #[tokio::test]
    async fn delete_refuses_non_regular_managed_backup_entries() {
        let directory = tempfile::tempdir().expect("directory");
        let connector = fake_connector(original_settings());
        let port = test_port(&directory, connector).await;
        fs::create_dir_all(port.backup_directory()).expect("backup directory");
        let id = Uuid::new_v4();
        fs::create_dir(port.backup_directory().join(format!("{id}.json")))
            .expect("non-regular entry");

        let error = port
            .delete_backup(id)
            .await
            .expect_err("non-regular backup must not be deleted");
        assert!(matches!(error, DomainError::Conflict(_)));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn delete_never_follows_a_managed_backup_symlink() {
        use std::os::unix::fs::symlink;

        let directory = tempfile::tempdir().expect("directory");
        let connector = fake_connector(original_settings());
        let port = test_port(&directory, connector).await;
        fs::create_dir_all(port.backup_directory()).expect("backup directory");
        let outside = directory.path().join("outside.json");
        fs::write(&outside, b"outside").expect("outside file");
        let id = Uuid::new_v4();
        symlink(&outside, port.backup_directory().join(format!("{id}.json"))).expect("symlink");

        let error = port
            .delete_backup(id)
            .await
            .expect_err("symlink must not be followed");
        assert!(matches!(error, DomainError::Conflict(_)));
        assert_eq!(fs::read(&outside).expect("outside file"), b"outside");
    }
}
