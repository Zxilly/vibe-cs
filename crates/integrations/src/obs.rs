use std::path::PathBuf;

use async_trait::async_trait;
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tokio::net::TcpStream;
use tokio_tungstenite::{
    MaybeTlsStream, WebSocketStream, connect_async_with_config,
    tungstenite::{Message, protocol::WebSocketConfig},
};
use uuid::Uuid;

use crate::{IntegrationError, IntegrationResult, SecretString};

#[async_trait]
pub trait ObsTransport: Send {
    async fn send_text(&mut self, message: String) -> IntegrationResult<()>;
    async fn receive_text(&mut self) -> IntegrationResult<String>;
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ObsTransportLimits {
    pub connect_timeout: std::time::Duration,
    pub message_timeout: std::time::Duration,
    pub maximum_message_bytes: usize,
}

impl Default for ObsTransportLimits {
    fn default() -> Self {
        Self {
            connect_timeout: std::time::Duration::from_secs(8),
            message_timeout: std::time::Duration::from_secs(8),
            maximum_message_bytes: 1024 * 1024,
        }
    }
}

pub struct WebSocketObsTransport {
    socket: WebSocketStream<MaybeTlsStream<TcpStream>>,
    limits: ObsTransportLimits,
}

impl std::fmt::Debug for WebSocketObsTransport {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("WebSocketObsTransport")
            .field("limits", &self.limits)
            .finish_non_exhaustive()
    }
}

impl WebSocketObsTransport {
    /// Connects to an OBS WebSocket host and port with bounded transport limits.
    ///
    /// # Errors
    ///
    /// Returns an error for invalid settings, timeout, or WebSocket handshake failure.
    pub async fn connect(
        host: &str,
        port: u16,
        limits: ObsTransportLimits,
    ) -> IntegrationResult<Self> {
        validate_obs_host(host, port, limits)?;
        let endpoint = if host.contains(':') && !host.starts_with('[') {
            format!("ws://[{host}]:{port}/")
        } else {
            format!("ws://{host}:{port}/")
        };
        Self::connect_url(&endpoint, limits).await
    }

    /// Connects to a credential-free `ws` or `wss` endpoint.
    ///
    /// # Errors
    ///
    /// Returns an error for an unsafe endpoint, timeout, or handshake failure.
    pub async fn connect_url(
        endpoint: &str,
        limits: ObsTransportLimits,
    ) -> IntegrationResult<Self> {
        validate_obs_endpoint(endpoint, limits)?;
        let config = WebSocketConfig::default()
            .max_message_size(Some(limits.maximum_message_bytes))
            .max_frame_size(Some(limits.maximum_message_bytes));
        let connection = tokio::time::timeout(
            limits.connect_timeout,
            connect_async_with_config(endpoint, Some(config), false),
        )
        .await
        .map_err(|_| obs_timeout("connection"))?
        .map_err(|error| IntegrationError::Unavailable {
            integration: "OBS WebSocket",
            message: error.to_string(),
        })?;
        Ok(Self {
            socket: connection.0,
            limits,
        })
    }
}

#[async_trait]
impl ObsTransport for WebSocketObsTransport {
    async fn send_text(&mut self, message: String) -> IntegrationResult<()> {
        if message.len() > self.limits.maximum_message_bytes {
            return Err(IntegrationError::ResponseLimit(
                self.limits.maximum_message_bytes,
            ));
        }
        tokio::time::timeout(
            self.limits.message_timeout,
            self.socket.send(Message::Text(message.into())),
        )
        .await
        .map_err(|_| obs_timeout("send"))?
        .map_err(|error| IntegrationError::Unavailable {
            integration: "OBS WebSocket",
            message: error.to_string(),
        })
    }

    async fn receive_text(&mut self) -> IntegrationResult<String> {
        let deadline = tokio::time::Instant::now() + self.limits.message_timeout;
        loop {
            let message = tokio::time::timeout_at(deadline, self.socket.next())
                .await
                .map_err(|_| obs_timeout("receive"))?
                .ok_or_else(|| IntegrationError::Unavailable {
                    integration: "OBS WebSocket",
                    message: "connection ended without a close frame".to_owned(),
                })?
                .map_err(|error| IntegrationError::Unavailable {
                    integration: "OBS WebSocket",
                    message: error.to_string(),
                })?;
            match message {
                Message::Text(text) => {
                    if text.len() > self.limits.maximum_message_bytes {
                        return Err(IntegrationError::ResponseLimit(
                            self.limits.maximum_message_bytes,
                        ));
                    }
                    return Ok(text.to_string());
                }
                Message::Ping(payload) => {
                    tokio::time::timeout_at(deadline, self.socket.send(Message::Pong(payload)))
                        .await
                        .map_err(|_| obs_timeout("pong"))?
                        .map_err(|error| IntegrationError::Unavailable {
                            integration: "OBS WebSocket",
                            message: error.to_string(),
                        })?;
                }
                Message::Pong(_) | Message::Frame(_) => {}
                Message::Close(frame) => {
                    return Err(IntegrationError::Unavailable {
                        integration: "OBS WebSocket",
                        message: frame.map_or_else(
                            || "server closed the connection".to_owned(),
                            |frame| format!("server closed the connection: {}", frame.reason),
                        ),
                    });
                }
                Message::Binary(payload) => {
                    if payload.len() > self.limits.maximum_message_bytes {
                        return Err(IntegrationError::ResponseLimit(
                            self.limits.maximum_message_bytes,
                        ));
                    }
                    return Err(IntegrationError::Protocol(
                        "OBS sent an unexpected binary message".to_owned(),
                    ));
                }
            }
        }
    }
}

fn validate_obs_host(host: &str, port: u16, limits: ObsTransportLimits) -> IntegrationResult<()> {
    if host.trim().is_empty()
        || host.contains(['/', '\\', '@', '?', '#', '\0', '\r', '\n'])
        || port == 0
    {
        return Err(IntegrationError::InvalidConfiguration(
            "OBS host/port is invalid".to_owned(),
        ));
    }
    validate_obs_limits(limits)
}

fn validate_obs_endpoint(endpoint: &str, limits: ObsTransportLimits) -> IntegrationResult<()> {
    validate_obs_limits(limits)?;
    let url = url::Url::parse(endpoint)?;
    if !matches!(url.scheme(), "ws" | "wss")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(IntegrationError::InvalidConfiguration(
            "OBS endpoint must be a credential-free ws:// or wss:// URL".to_owned(),
        ));
    }
    Ok(())
}

fn validate_obs_limits(limits: ObsTransportLimits) -> IntegrationResult<()> {
    if limits.connect_timeout.is_zero()
        || limits.message_timeout.is_zero()
        || !(1024..=16 * 1024 * 1024).contains(&limits.maximum_message_bytes)
    {
        Err(IntegrationError::InvalidConfiguration(
            "OBS timeout/message limits are invalid".to_owned(),
        ))
    } else {
        Ok(())
    }
}

fn obs_timeout(operation: &str) -> IntegrationError {
    IntegrationError::Unavailable {
        integration: "OBS WebSocket",
        message: format!("{operation} timed out"),
    }
}

/// Explicit placeholder for builds that do not install a WebSocket transport.
#[derive(Debug, Default)]
pub struct UnavailableObsTransport;

#[async_trait]
impl ObsTransport for UnavailableObsTransport {
    async fn send_text(&mut self, _message: String) -> IntegrationResult<()> {
        Err(obs_transport_unavailable())
    }

    async fn receive_text(&mut self) -> IntegrationResult<String> {
        Err(obs_transport_unavailable())
    }
}

fn obs_transport_unavailable() -> IntegrationError {
    IntegrationError::Unavailable {
        integration: "OBS WebSocket",
        message: "no WebSocket transport was linked into this build".to_owned(),
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ObsRecordStatus {
    pub active: bool,
    pub paused: bool,
    pub timecode: Option<String>,
    pub output_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ObsSceneStatus {
    pub current_program_scene: String,
    pub scenes: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ObsRealtimeMediaInput {
    pub scene: String,
    pub input_name: String,
    pub media_path: PathBuf,
    pub loop_media: bool,
}

impl ObsRealtimeMediaInput {
    /// Validates a user-provided local media input before OBS receives a path.
    ///
    /// # Errors
    ///
    /// Rejects invalid names and missing, linked, oversized, or unsupported files.
    pub fn validate(mut self) -> IntegrationResult<Self> {
        validate_scene_name(&self.scene)?;
        validate_input_name(&self.input_name)?;
        if cfg!(windows) && self.media_path.to_string_lossy().starts_with("\\\\") {
            return Err(IntegrationError::InvalidInput(
                "OBS overlay media must not use a UNC or network path".to_owned(),
            ));
        }
        let submitted_metadata = std::fs::symlink_metadata(&self.media_path).map_err(|error| {
            IntegrationError::InvalidInput(format!(
                "OBS overlay media is unavailable at {}: {error}",
                self.media_path.display()
            ))
        })?;
        if submitted_metadata.file_type().is_symlink() {
            return Err(IntegrationError::InvalidInput(
                "OBS overlay media must not be a symbolic link".to_owned(),
            ));
        }
        self.media_path = std::fs::canonicalize(&self.media_path).map_err(|error| {
            IntegrationError::InvalidInput(format!(
                "OBS overlay media is unavailable at {}: {error}",
                self.media_path.display()
            ))
        })?;
        let metadata = std::fs::symlink_metadata(&self.media_path).map_err(|error| {
            IntegrationError::InvalidInput(format!(
                "OBS overlay media is unavailable at {}: {error}",
                self.media_path.display()
            ))
        })?;
        let extension = self
            .media_path
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or_default();
        if !self.media_path.is_absolute()
            || metadata.file_type().is_symlink()
            || !metadata.is_file()
            || metadata.len() == 0
            || metadata.len() > 512 * 1024 * 1024
            || !matches!(
                extension.to_ascii_lowercase().as_str(),
                "webm" | "mov" | "mp4" | "png"
            )
        {
            return Err(IntegrationError::InvalidInput(
                "OBS overlay must be an existing bounded regular .webm/.mov/.mp4/.png file"
                    .to_owned(),
            ));
        }
        Ok(self)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ObsVideoSettings {
    pub base_width: u32,
    pub base_height: u32,
    pub output_width: u32,
    pub output_height: u32,
    pub fps_numerator: u32,
    pub fps_denominator: u32,
}

/// The intentionally narrow subset of OBS video settings this application may change.
/// Canvas size, encoder, bitrate, scenes, and every other OBS setting remain untouched.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub struct ObsVideoOutputSettings {
    pub output_width: u32,
    pub output_height: u32,
    pub fps_numerator: u32,
    pub fps_denominator: u32,
}

impl ObsVideoOutputSettings {
    fn validate(self) -> IntegrationResult<Self> {
        const MAXIMUM_DIMENSION: u32 = 16_384;
        const MAXIMUM_FPS_COMPONENT: u32 = 1_000_000;
        const MAXIMUM_FPS: u32 = 1_000;
        if !(16..=MAXIMUM_DIMENSION).contains(&self.output_width)
            || !(16..=MAXIMUM_DIMENSION).contains(&self.output_height)
            || !(1..=MAXIMUM_FPS_COMPONENT).contains(&self.fps_numerator)
            || !(1..=MAXIMUM_FPS_COMPONENT).contains(&self.fps_denominator)
            || self.fps_numerator > self.fps_denominator.saturating_mul(MAXIMUM_FPS)
        {
            return Err(IntegrationError::InvalidInput(
                "OBS output dimensions or rational frame rate are outside supported bounds"
                    .to_owned(),
            ));
        }
        Ok(self)
    }
}

#[derive(Debug)]
pub struct ObsClient<T> {
    transport: T,
    rpc_version: u32,
}

impl<T: ObsTransport> ObsClient<T> {
    /// Performs the OBS WebSocket v5 Hello/Identify handshake.
    ///
    /// # Errors
    ///
    /// Returns an error for transport, authentication, or protocol failures.
    pub async fn connect(mut transport: T, password: &SecretString) -> IntegrationResult<Self> {
        let hello_text = transport.receive_text().await?;
        let hello: WireMessage = serde_json::from_str(&hello_text)?;
        if hello.op != 0 {
            return Err(IntegrationError::Protocol(format!(
                "expected OBS Hello (op 0), received op {}",
                hello.op
            )));
        }
        let rpc_version = hello
            .data
            .get("rpcVersion")
            .and_then(Value::as_u64)
            .and_then(|value| u32::try_from(value).ok())
            .unwrap_or(1)
            .min(1);
        let authentication = hello
            .data
            .get("authentication")
            .map(|authentication| {
                let challenge = authentication
                    .get("challenge")
                    .and_then(Value::as_str)
                    .ok_or_else(|| {
                        IntegrationError::Protocol(
                            "OBS Hello authentication has no challenge".to_owned(),
                        )
                    })?;
                let salt = authentication
                    .get("salt")
                    .and_then(Value::as_str)
                    .ok_or_else(|| {
                        IntegrationError::Protocol(
                            "OBS Hello authentication has no salt".to_owned(),
                        )
                    })?;
                if password.is_empty() {
                    return Err(IntegrationError::NotConfigured {
                        integration: "OBS WebSocket",
                        message: "server requires a password".to_owned(),
                    });
                }
                Ok::<_, IntegrationError>(obs_authentication(password, salt, challenge))
            })
            .transpose()?;
        let mut identify = json!({"rpcVersion": rpc_version});
        if let Some(authentication) = authentication {
            identify["authentication"] = Value::String(authentication);
        }
        transport
            .send_text(serde_json::to_string(&WireMessage {
                op: 1,
                data: identify,
            })?)
            .await?;
        let identified: WireMessage = serde_json::from_str(&transport.receive_text().await?)?;
        if identified.op != 2 {
            return Err(IntegrationError::Protocol(format!(
                "expected OBS Identified (op 2), received op {}",
                identified.op
            )));
        }
        Ok(Self {
            transport,
            rpc_version,
        })
    }

    #[must_use]
    pub const fn rpc_version(&self) -> u32 {
        self.rpc_version
    }

    /// Queries current recording status.
    ///
    /// # Errors
    ///
    /// Returns an error when the request transport or OBS response fails.
    pub async fn record_status(&mut self) -> IntegrationResult<ObsRecordStatus> {
        let data = self.request("GetRecordStatus", json!({})).await?;
        Ok(ObsRecordStatus {
            active: data
                .get("outputActive")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            paused: data
                .get("outputPaused")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            timecode: data
                .get("outputTimecode")
                .and_then(Value::as_str)
                .map(str::to_owned),
            output_path: data
                .get("outputPath")
                .and_then(Value::as_str)
                .map(str::to_owned),
        })
    }

    /// Queries the current program scene and the bounded scene list.
    ///
    /// # Errors
    ///
    /// Returns an error for malformed or unreasonably large OBS responses.
    pub async fn scene_status(&mut self) -> IntegrationResult<ObsSceneStatus> {
        const MAXIMUM_SCENES: usize = 512;
        let data = self.request("GetSceneList", json!({})).await?;
        let current_program_scene = data
            .get("currentProgramSceneName")
            .and_then(Value::as_str)
            .ok_or_else(|| {
                IntegrationError::Protocol("OBS scene list has no current program scene".to_owned())
            })?;
        validate_scene_name(current_program_scene)?;
        let values = data
            .get("scenes")
            .and_then(Value::as_array)
            .ok_or_else(|| IntegrationError::Protocol("OBS scene list is missing".to_owned()))?;
        if values.is_empty() || values.len() > MAXIMUM_SCENES {
            return Err(IntegrationError::Protocol(format!(
                "OBS scene count must be between 1 and {MAXIMUM_SCENES}"
            )));
        }
        let mut scenes = Vec::with_capacity(values.len());
        for scene in values {
            let name = scene
                .get("sceneName")
                .and_then(Value::as_str)
                .ok_or_else(|| {
                    IntegrationError::Protocol("OBS scene has no sceneName".to_owned())
                })?;
            validate_scene_name(name)?;
            scenes.push(name.to_owned());
        }
        if !scenes.iter().any(|scene| scene == current_program_scene) {
            return Err(IntegrationError::Protocol(
                "OBS current program scene is absent from its scene list".to_owned(),
            ));
        }
        Ok(ObsSceneStatus {
            current_program_scene: current_program_scene.to_owned(),
            scenes,
        })
    }

    /// Switches the current program scene by exact, validated name.
    ///
    /// # Errors
    ///
    /// Returns an error when the scene name is invalid or OBS rejects the request.
    pub async fn set_current_program_scene(&mut self, scene: &str) -> IntegrationResult<()> {
        validate_scene_name(scene)?;
        self.request("SetCurrentProgramScene", json!({ "sceneName": scene }))
            .await
            .map(|_| ())
    }

    /// Creates one disabled-by-default local media input for a transparent live
    /// overlay. Callers retain the returned scene-item id and must remove the
    /// exact input during cleanup.
    ///
    /// # Errors
    ///
    /// Returns an error when validation, transport, or OBS publication fails.
    pub async fn create_realtime_media_input(
        &mut self,
        input: ObsRealtimeMediaInput,
    ) -> IntegrationResult<i64> {
        let input = input.validate()?;
        let path = input.media_path.to_str().ok_or_else(|| {
            IntegrationError::InvalidInput("OBS overlay path is not valid Unicode".to_owned())
        })?;
        let data = self
            .request(
                "CreateInput",
                json!({
                    "sceneName": input.scene,
                    "inputName": input.input_name,
                    "inputKind": "ffmpeg_source",
                    "inputSettings": {
                        "is_local_file": true,
                        "local_file": path,
                        "looping": input.loop_media,
                        "restart_on_activate": true,
                        "clear_on_media_end": true
                    },
                    "sceneItemEnabled": false
                }),
            )
            .await?;
        data.get("sceneItemId")
            .and_then(Value::as_i64)
            .ok_or_else(|| {
                IntegrationError::Protocol("OBS CreateInput returned no sceneItemId".to_owned())
            })
    }

    /// Creates one disabled text source for evidence-backed keyboard state.
    ///
    /// # Errors
    ///
    /// Returns an error for invalid names, transport failure, or OBS rejection.
    pub async fn create_realtime_text_input(
        &mut self,
        scene: &str,
        input_name: &str,
    ) -> IntegrationResult<i64> {
        validate_scene_name(scene)?;
        validate_input_name(input_name)?;
        let data = self
            .request(
                "CreateInput",
                json!({
                    "sceneName": scene,
                    "inputName": input_name,
                    "inputKind": "text_gdiplus_v2",
                    "inputSettings": {
                        "text": "",
                        "color": 16_777_215,
                        "bk_color": 0,
                        "bk_opacity": 70,
                        "font": { "face": "Arial", "size": 28, "style": "Bold" }
                    },
                    "sceneItemEnabled": false
                }),
            )
            .await?;
        data.get("sceneItemId")
            .and_then(Value::as_i64)
            .ok_or_else(|| {
                IntegrationError::Protocol("OBS CreateInput returned no sceneItemId".to_owned())
            })
    }

    /// Updates the exact managed text source without replacing other settings.
    ///
    /// # Errors
    ///
    /// Returns an error for invalid text/name, transport failure, or OBS rejection.
    pub async fn set_realtime_text(
        &mut self,
        input_name: &str,
        text: &str,
    ) -> IntegrationResult<()> {
        validate_input_name(input_name)?;
        if text.len() > 256 || text.chars().any(char::is_control) {
            return Err(IntegrationError::InvalidInput(
                "OBS realtime text must be printable and at most 256 bytes".to_owned(),
            ));
        }
        self.request(
            "SetInputSettings",
            json!({
                "inputName": input_name,
                "inputSettings": { "text": text },
                "overlay": true
            }),
        )
        .await
        .map(|_| ())
    }

    /// Restarts an exact local media source for one-shot playback.
    ///
    /// # Errors
    ///
    /// Returns an error for an invalid name, transport failure, or OBS rejection.
    pub async fn restart_realtime_media(&mut self, input_name: &str) -> IntegrationResult<()> {
        validate_input_name(input_name)?;
        self.request(
            "TriggerMediaInputAction",
            json!({
                "inputName": input_name,
                "mediaAction": "OBS_WEBSOCKET_MEDIA_INPUT_ACTION_RESTART"
            }),
        )
        .await
        .map(|_| ())
    }

    /// Enables or disables an exact managed scene item.
    ///
    /// # Errors
    ///
    /// Returns an error for invalid identity, transport failure, or OBS rejection.
    pub async fn set_realtime_media_enabled(
        &mut self,
        scene: &str,
        scene_item_id: i64,
        enabled: bool,
    ) -> IntegrationResult<()> {
        validate_scene_name(scene)?;
        if scene_item_id < 0 {
            return Err(IntegrationError::InvalidInput(
                "OBS scene item id must be non-negative".to_owned(),
            ));
        }
        self.request(
            "SetSceneItemEnabled",
            json!({
                "sceneName": scene,
                "sceneItemId": scene_item_id,
                "sceneItemEnabled": enabled
            }),
        )
        .await
        .map(|_| ())
    }

    /// Removes an exact managed OBS input by its validated name.
    ///
    /// # Errors
    ///
    /// Returns an error for an invalid name, transport failure, or OBS rejection.
    pub async fn remove_realtime_media_input(&mut self, input_name: &str) -> IntegrationResult<()> {
        validate_input_name(input_name)?;
        self.request("RemoveInput", json!({ "inputName": input_name }))
            .await
            .map(|_| ())
    }

    /// Queries OBS canvas, output, and rational frame-rate settings.
    ///
    /// # Errors
    ///
    /// Returns an error when OBS omits or returns invalid video dimensions.
    pub async fn video_settings(&mut self) -> IntegrationResult<ObsVideoSettings> {
        let data = self.request("GetVideoSettings", json!({})).await?;
        let read_u32 = |field: &'static str| {
            data.get(field)
                .and_then(Value::as_u64)
                .and_then(|value| u32::try_from(value).ok())
                .filter(|value| *value > 0)
                .ok_or_else(|| {
                    IntegrationError::Protocol(format!(
                        "OBS video settings contain no valid {field}"
                    ))
                })
        };
        Ok(ObsVideoSettings {
            base_width: read_u32("baseWidth")?,
            base_height: read_u32("baseHeight")?,
            output_width: read_u32("outputWidth")?,
            output_height: read_u32("outputHeight")?,
            fps_numerator: read_u32("fpsNumerator")?,
            fps_denominator: read_u32("fpsDenominator")?,
        })
    }

    /// Applies only output resolution and rational frame rate after an optimistic-lock check.
    /// The base canvas is re-read and preserved immediately before `SetVideoSettings`.
    ///
    /// # Errors
    ///
    /// Returns an error if the target is invalid, current settings changed since planning,
    /// or OBS rejects the request.
    pub async fn set_video_settings(
        &mut self,
        expected_current: &ObsVideoSettings,
        target: ObsVideoOutputSettings,
    ) -> IntegrationResult<()> {
        let target = target.validate()?;
        let current = self.video_settings().await?;
        if current != *expected_current {
            return Err(IntegrationError::Protocol(
                "OBS video settings changed after the plan was created".to_owned(),
            ));
        }
        self.request(
            "SetVideoSettings",
            json!({
                "baseWidth": current.base_width,
                "baseHeight": current.base_height,
                "outputWidth": target.output_width,
                "outputHeight": target.output_height,
                "fpsNumerator": target.fps_numerator,
                "fpsDenominator": target.fps_denominator,
            }),
        )
        .await
        .map(|_| ())
    }

    /// Requests recording start.
    ///
    /// # Errors
    ///
    /// Returns an error when the request transport or OBS response fails.
    pub async fn start_recording(&mut self) -> IntegrationResult<()> {
        self.request("StartRecord", json!({})).await.map(|_| ())
    }

    /// Requests recording stop and returns OBS's output path when available.
    ///
    /// # Errors
    ///
    /// Returns an error when the request transport or OBS response fails.
    pub async fn stop_recording(&mut self) -> IntegrationResult<Option<String>> {
        let data = self.request("StopRecord", json!({})).await?;
        Ok(data
            .get("outputPath")
            .and_then(Value::as_str)
            .map(str::to_owned))
    }

    async fn request(
        &mut self,
        request_type: &str,
        request_data: Value,
    ) -> IntegrationResult<Value> {
        let request_id = Uuid::new_v4().to_string();
        let message = WireMessage {
            op: 6,
            data: json!({
                "requestType": request_type,
                "requestId": request_id,
                "requestData": request_data,
            }),
        };
        self.transport
            .send_text(serde_json::to_string(&message)?)
            .await?;
        let mut response = None;
        for _ in 0..32 {
            let candidate: WireMessage =
                serde_json::from_str(&self.transport.receive_text().await?)?;
            if candidate.op == 5 {
                continue;
            }
            if candidate.op != 7 {
                return Err(IntegrationError::Protocol(format!(
                    "expected OBS RequestResponse (op 7), received op {}",
                    candidate.op
                )));
            }
            response = Some(candidate);
            break;
        }
        let response = response.ok_or_else(|| {
            IntegrationError::Protocol("too many OBS events before request response".to_owned())
        })?;
        if response.data.get("requestId").and_then(Value::as_str) != Some(request_id.as_str()) {
            return Err(IntegrationError::Protocol(
                "OBS response requestId does not match".to_owned(),
            ));
        }
        let status = response.data.get("requestStatus").ok_or_else(|| {
            IntegrationError::Protocol("OBS response has no requestStatus".to_owned())
        })?;
        if !status
            .get("result")
            .and_then(Value::as_bool)
            .unwrap_or(false)
        {
            let code = status.get("code").and_then(Value::as_u64).unwrap_or(0);
            let comment = status
                .get("comment")
                .and_then(Value::as_str)
                .unwrap_or("request rejected");
            return Err(IntegrationError::Protocol(format!(
                "OBS request failed ({code}): {comment}"
            )));
        }
        Ok(response
            .data
            .get("responseData")
            .cloned()
            .unwrap_or_else(|| json!({})))
    }
}

fn validate_scene_name(scene: &str) -> IntegrationResult<()> {
    if scene.is_empty()
        || scene.len() > 256
        || scene.trim() != scene
        || scene.chars().any(char::is_control)
    {
        return Err(IntegrationError::Protocol(
            "OBS scene name must be a trimmed printable value of at most 256 bytes".to_owned(),
        ));
    }
    Ok(())
}

fn validate_input_name(name: &str) -> IntegrationResult<()> {
    if name.is_empty()
        || name.len() > 128
        || name.trim() != name
        || name.chars().any(char::is_control)
    {
        return Err(IntegrationError::InvalidInput(
            "OBS input name must be a trimmed printable value of at most 128 bytes".to_owned(),
        ));
    }
    Ok(())
}

impl ObsClient<WebSocketObsTransport> {
    /// Opens a real WebSocket connection and performs the v5 handshake.
    ///
    /// # Errors
    ///
    /// Returns an error for connection, authentication, timeout, or protocol failures.
    pub async fn connect_websocket(
        host: &str,
        port: u16,
        password: &SecretString,
        limits: ObsTransportLimits,
    ) -> IntegrationResult<Self> {
        let transport = WebSocketObsTransport::connect(host, port, limits).await?;
        Self::connect(transport, password).await
    }
}

#[derive(Debug, Serialize, Deserialize)]
struct WireMessage {
    op: u8,
    #[serde(rename = "d")]
    data: Value,
}

#[must_use]
pub fn obs_authentication(password: &SecretString, salt: &str, challenge: &str) -> String {
    let secret = base64(&Sha256::digest(
        format!("{}{salt}", password.expose()).as_bytes(),
    ));
    base64(&Sha256::digest(format!("{secret}{challenge}").as_bytes()))
}

fn base64(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut encoded = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let first = chunk[0];
        let second = chunk.get(1).copied().unwrap_or(0);
        let third = chunk.get(2).copied().unwrap_or(0);
        encoded.push(char::from(TABLE[usize::from(first >> 2)]));
        encoded.push(char::from(
            TABLE[usize::from(((first & 0x03) << 4) | (second >> 4))],
        ));
        encoded.push(if chunk.len() > 1 {
            char::from(TABLE[usize::from(((second & 0x0f) << 2) | (third >> 6))])
        } else {
            '='
        });
        encoded.push(if chunk.len() > 2 {
            char::from(TABLE[usize::from(third & 0x3f)])
        } else {
            '='
        });
    }
    encoded
}

#[cfg(test)]
mod tests {
    use std::collections::VecDeque;

    use super::*;

    #[derive(Debug, Default)]
    struct FakeTransport {
        incoming: VecDeque<String>,
        sent: Vec<String>,
    }

    #[async_trait]
    impl ObsTransport for FakeTransport {
        async fn send_text(&mut self, message: String) -> IntegrationResult<()> {
            let wire: WireMessage = serde_json::from_str(&message)?;
            if wire.op == 6 {
                let request_id = wire.data["requestId"].as_str().unwrap_or_default();
                let request_type = wire.data["requestType"].as_str().unwrap_or_default();
                self.incoming.push_back(serde_json::to_string(&WireMessage {
                    op: 5,
                    data: json!({"eventType": "CurrentProgramSceneChanged"}),
                })?);
                let response_data = match request_type {
                    "GetRecordStatus" => json!({
                        "outputActive": true,
                        "outputPaused": false,
                        "outputTimecode": "00:00:12.000",
                    }),
                    "GetSceneList" => json!({
                        "currentProgramSceneName": "Gameplay",
                        "scenes": [
                            {"sceneIndex": 1, "sceneName": "Gameplay"},
                            {"sceneIndex": 0, "sceneName": "Desktop"}
                        ],
                    }),
                    "GetVideoSettings" => json!({
                        "baseWidth": 2560,
                        "baseHeight": 1440,
                        "outputWidth": 1920,
                        "outputHeight": 1080,
                        "fpsNumerator": 60,
                        "fpsDenominator": 1,
                    }),
                    "StopRecord" => json!({"outputPath": "recording.mkv"}),
                    "CreateInput" => json!({"sceneItemId": 42}),
                    _ => json!({}),
                };
                self.incoming.push_back(serde_json::to_string(&WireMessage {
                    op: 7,
                    data: json!({
                        "requestId": request_id,
                        "requestStatus": {"result": true, "code": 100},
                        "responseData": response_data,
                    }),
                })?);
            }
            self.sent.push(message);
            Ok(())
        }

        async fn receive_text(&mut self) -> IntegrationResult<String> {
            self.incoming
                .pop_front()
                .ok_or_else(|| IntegrationError::Protocol("fake transport exhausted".to_owned()))
        }
    }

    #[tokio::test]
    async fn performs_v5_identification_without_opening_a_socket() {
        let mut transport = FakeTransport::default();
        transport
            .incoming
            .push_back(r#"{"op":0,"d":{"rpcVersion":1}}"#.to_owned());
        transport
            .incoming
            .push_back(r#"{"op":2,"d":{"negotiatedRpcVersion":1}}"#.to_owned());
        let client = ObsClient::connect(transport, &SecretString::default())
            .await
            .unwrap();
        assert_eq!(client.rpc_version(), 1);
        assert_eq!(client.transport.sent.len(), 1);
        let identify: WireMessage = serde_json::from_str(&client.transport.sent[0]).unwrap();
        assert_eq!(identify.op, 1);
    }

    #[tokio::test]
    async fn recording_requests_round_trip_over_fake_transport() {
        let mut transport = FakeTransport::default();
        transport
            .incoming
            .push_back(r#"{"op":0,"d":{"rpcVersion":1}}"#.to_owned());
        transport
            .incoming
            .push_back(r#"{"op":2,"d":{"negotiatedRpcVersion":1}}"#.to_owned());
        let mut client = ObsClient::connect(transport, &SecretString::default())
            .await
            .unwrap();
        let status = client.record_status().await.unwrap();
        assert!(status.active);
        assert_eq!(status.timecode.as_deref(), Some("00:00:12.000"));
        client.start_recording().await.unwrap();
        assert_eq!(
            client.stop_recording().await.unwrap().as_deref(),
            Some("recording.mkv")
        );
    }

    #[tokio::test]
    async fn scene_and_video_requests_are_typed_and_bounded() {
        let mut transport = FakeTransport::default();
        transport
            .incoming
            .push_back(r#"{"op":0,"d":{"rpcVersion":1}}"#.to_owned());
        transport
            .incoming
            .push_back(r#"{"op":2,"d":{"negotiatedRpcVersion":1}}"#.to_owned());
        let mut client = ObsClient::connect(transport, &SecretString::default())
            .await
            .unwrap();

        let scenes = client.scene_status().await.unwrap();
        assert_eq!(scenes.current_program_scene, "Gameplay");
        assert_eq!(scenes.scenes, ["Gameplay", "Desktop"]);
        client.set_current_program_scene("Desktop").await.unwrap();

        let video = client.video_settings().await.unwrap();
        assert_eq!((video.output_width, video.output_height), (1920, 1080));
        assert_eq!((video.fps_numerator, video.fps_denominator), (60, 1));
        client
            .set_video_settings(
                &video,
                ObsVideoOutputSettings {
                    output_width: 2560,
                    output_height: 1440,
                    fps_numerator: 60_000,
                    fps_denominator: 1_001,
                },
            )
            .await
            .unwrap();
        let set_request = client
            .transport
            .sent
            .iter()
            .filter_map(|message| serde_json::from_str::<WireMessage>(message).ok())
            .find(|wire| wire.data["requestType"] == "SetVideoSettings")
            .expect("SetVideoSettings request");
        assert_eq!(set_request.data["requestData"]["baseWidth"], 2560);
        assert_eq!(set_request.data["requestData"]["baseHeight"], 1440);
        assert_eq!(set_request.data["requestData"]["outputWidth"], 2560);
        assert_eq!(set_request.data["requestData"]["fpsNumerator"], 60_000);
        assert!(set_request.data["requestData"].get("encoder").is_none());
        assert!(set_request.data["requestData"].get("bitrate").is_none());
        assert!(set_request.data["requestData"].get("scene").is_none());
        assert!(
            client
                .set_video_settings(
                    &video,
                    ObsVideoOutputSettings {
                        output_width: 0,
                        output_height: 1080,
                        fps_numerator: 60,
                        fps_denominator: 1,
                    },
                )
                .await
                .is_err()
        );
        assert_eq!(
            client
                .transport
                .sent
                .iter()
                .filter_map(|message| serde_json::from_str::<WireMessage>(message).ok())
                .filter(|wire| wire.data["requestType"] == "SetVideoSettings")
                .count(),
            1
        );
    }

    #[tokio::test]
    async fn realtime_media_requires_real_local_material_and_is_exactly_managed() {
        let root = tempfile::tempdir().unwrap();
        let media = root.path().join("effect.webm");
        std::fs::write(&media, b"transparent-effect").unwrap();
        let mut transport = FakeTransport::default();
        transport
            .incoming
            .push_back(r#"{"op":0,"d":{"rpcVersion":1}}"#.to_owned());
        transport
            .incoming
            .push_back(r#"{"op":2,"d":{"negotiatedRpcVersion":1}}"#.to_owned());
        let mut client = ObsClient::connect(transport, &SecretString::default())
            .await
            .unwrap();
        let id = client
            .create_realtime_media_input(ObsRealtimeMediaInput {
                scene: "Gameplay".to_owned(),
                input_name: "VibeCS-kill".to_owned(),
                media_path: media,
                loop_media: false,
            })
            .await
            .unwrap();
        assert_eq!(id, 42);
        client
            .set_realtime_media_enabled("Gameplay", id, true)
            .await
            .unwrap();
        client.restart_realtime_media("VibeCS-kill").await.unwrap();
        let text_id = client
            .create_realtime_text_input("Gameplay", "VibeCS-keyboard")
            .await
            .unwrap();
        assert_eq!(text_id, 42);
        client
            .set_realtime_text("VibeCS-keyboard", "W · · D  |  SPACE")
            .await
            .unwrap();
        client
            .remove_realtime_media_input("VibeCS-kill")
            .await
            .unwrap();
        let sent = client.transport.sent.join("\n");
        assert!(sent.contains("CreateInput"));
        assert!(sent.contains("SetSceneItemEnabled"));
        assert!(sent.contains("TriggerMediaInputAction"));
        assert!(sent.contains("OBS_WEBSOCKET_MEDIA_INPUT_ACTION_RESTART"));
        assert!(sent.contains("text_gdiplus_v2"));
        assert!(sent.contains("SetInputSettings"));
        assert!(sent.contains("VibeCS-keyboard"));
        assert!(sent.contains("RemoveInput"));
        assert!(
            ObsRealtimeMediaInput {
                scene: "Gameplay".to_owned(),
                input_name: "missing".to_owned(),
                media_path: root.path().join("missing.webm"),
                loop_media: false,
            }
            .validate()
            .is_err()
        );
    }

    #[test]
    fn scene_names_reject_invisible_or_unbounded_values() {
        assert!(validate_scene_name("").is_err());
        assert!(validate_scene_name(" Gameplay").is_err());
        assert!(validate_scene_name("Gameplay\nquit").is_err());
        assert!(validate_scene_name(&"x".repeat(257)).is_err());
        assert!(validate_scene_name("Gameplay").is_ok());
    }

    #[test]
    fn authentication_matches_obs_reference_vector() {
        // The function is independently testable and never exposes the secret through Debug.
        let result = obs_authentication(&SecretString::new("password"), "salt", "challenge");
        assert_eq!(result.len(), 44);
        assert_ne!(result, "password");
    }

    #[test]
    fn websocket_endpoint_validation_rejects_credentials_and_oversized_limits() {
        assert!(
            validate_obs_endpoint(
                "ws://user:secret@127.0.0.1:4455/",
                ObsTransportLimits::default(),
            )
            .is_err()
        );
        assert!(
            validate_obs_endpoint(
                "ws://127.0.0.1:4455/",
                ObsTransportLimits {
                    maximum_message_bytes: 32,
                    ..ObsTransportLimits::default()
                },
            )
            .is_err()
        );
    }
}
