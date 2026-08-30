//! End-to-end orchestration for one application-managed offline HLAE session.

use std::{
    fmt, fs,
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use sha2::{Digest as _, Sha256};
use vibe_cs_hlae::{
    CaptureObserverContract, CaptureSettings, CaptureTickContract, GeneratedArtifact,
    HlaeBridgeControlMessage, HlaeBundleLaunchInputs, HlaeCustomLoaderInvocation, HlaeError,
    HlaeFrameCountBounds, HlaeHostEvent, HlaePersistentPovCommands, HlaePlan, HlaePlanMode,
    HlaePlayerPovCapturePlan, HlaeSessionMachine, HlaeSessionProtocolError, HlaeSessionState,
    HlaeTakeExpectation, MirvScriptBridgeContract, ObservedCaptureSpan, ObservedPlayerPov,
    SessionToken, ValidatedCapturePaths, build_hlae_launch_profile,
    build_hlae_managed_session_invocation, compile_hlae_managed_session_bootstrap,
    compile_hlae_plan, compile_hlae_player_pov_capture, compile_mirv_script_bridge,
    estimate_hlae_capture_span_resources, hlae_frame_count_bounds,
};
#[cfg(windows)]
use vibe_cs_platform_windows::{DesktopBackend, SystemDesktopBackend};
use vibe_cs_platform_windows::{
    HlaeDiskSpaceEvidence, HlaeDiskSpacePreflightError, NativeMp4VideoInspection,
    NativeMp4VideoSummary, PlatformError, ProcessCancellation, atomic_write_new,
};

use crate::{
    HlaeTakeMp4EncodeError, HlaeTakeMp4EncodeEvidence, HlaeTakeMp4EncodeRequest,
    HlaeTakeStabilityError, HlaeTakeStabilityPolicy, RecordingProgressSink, RecordingStage,
    RuntimeHlaeBridgeConnection, RuntimeHlaeBridgeError, RuntimeHlaeBridgeListener,
    RuntimeHlaeSequenceEncoder, RuntimeManagedHlaeProcess,
    recording_progress::recording_progress_channel, wait_for_stable_hlae_take,
};

const RUNTIME_HLAE_SESSION_MANIFEST_FILE: &str = "vibe_cs_session_manifest.json";
const MINIMUM_TARGET_BITRATE_BPS: u32 = 100_000;
const MAXIMUM_TARGET_BITRATE_BPS: u32 = 100_000_000;
const MAXIMUM_PROTOCOL_TIMEOUT: Duration = Duration::from_secs(60 * 60);
const MAXIMUM_BRIDGE_TIMEOUT: Duration = Duration::from_secs(60);
const MAXIMUM_CANCELLATION_GRACE: Duration = Duration::from_secs(60);
const HLAE_ENCODED_OUTPUT_FILE: &str = "encoded-output.mp4";
const HLAE_PARTIAL_OUTPUT_FILE: &str = ".encoded-output.partial.mp4";
const STEAM_CLIENT_STARTUP_TIMEOUT: Duration = Duration::from_secs(30);
const STEAM_CLIENT_POLL_INTERVAL: Duration = Duration::from_millis(100);
const FAILED_JOB_CLEANUP_ATTEMPTS: usize = 20;
const FAILED_JOB_CLEANUP_RETRY_INTERVAL: Duration = Duration::from_millis(100);
const MAXIMUM_USER_CONFIG_FILES: usize = 32;
const MAXIMUM_USER_CONFIG_FILE_BYTES: u64 = 2 * 1_024 * 1_024;
const MAXIMUM_USER_CONFIG_TOTAL_BYTES: u64 = 8 * 1_024 * 1_024;

/// Bounded deadlines for one managed HLAE session.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RuntimeHlaeSessionTimeouts {
    pub game_discovery: Duration,
    pub bridge_accept: Duration,
    pub bridge_receive: Duration,
    pub protocol: Duration,
    /// Maximum time granted to an in-process encoder after cancellation.
    pub cancellation_grace: Duration,
}

impl Default for RuntimeHlaeSessionTimeouts {
    fn default() -> Self {
        Self {
            game_discovery: Duration::from_secs(60),
            bridge_accept: Duration::from_secs(60),
            bridge_receive: Duration::from_secs(15),
            protocol: Duration::from_secs(10 * 60),
            cancellation_grace: Duration::from_secs(5),
        }
    }
}

/// Closed capture programs accepted by the managed runtime.
///
/// Player POV remains a distinct compiler product; it is never represented by
/// invented cinematic camera coordinates.
#[derive(Debug, Clone, PartialEq)]
pub enum RuntimeHlaeCaptureProgram {
    Camera(HlaePlan),
    PlayerPov(HlaePlayerPovCapturePlan),
}

/// Complete request for one no-clobber, managed HLAE capture.
#[derive(Debug, Clone)]
pub struct RuntimeHlaeSessionRequest {
    pub job_id: uuid::Uuid,
    pub take_index: usize,
    pub capture_program: RuntimeHlaeCaptureProgram,
    pub launch_inputs: HlaeBundleLaunchInputs,
    pub verified_total_ticks: u32,
    /// A new, absent job directory whose existing parent is app-managed.
    pub managed_job_root: PathBuf,
    pub output_mp4: PathBuf,
    pub target_bitrate_bps: u32,
    pub max_start_overshoot_ticks: u32,
    pub max_end_overshoot_ticks: u32,
    pub take_stability: HlaeTakeStabilityPolicy,
    pub timeouts: RuntimeHlaeSessionTimeouts,
    pub cancellation: ProcessCancellation,
}

/// Durable evidence returned only after MP4 verification and process-tree
/// shutdown both succeed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RuntimeHlaeSessionEvidence {
    pub managed_job_root: PathBuf,
    pub artifact_manifest: PathBuf,
    pub loader_process_id: u32,
    pub game_process_id: u32,
    pub observed_capture_span: ObservedCaptureSpan,
    pub observer_evidence: Option<ObservedPlayerPov>,
    pub frame_count_bounds: HlaeFrameCountBounds,
    pub disk_space: HlaeDiskSpaceEvidence,
    pub mp4_summary: NativeMp4VideoSummary,
    pub mp4_inspection: NativeMp4VideoInspection,
}

/// Fail-closed outcomes from a managed HLAE session.
#[derive(Debug, thiserror::Error)]
pub enum RuntimeHlaeSessionError {
    #[error(transparent)]
    Hlae(#[from] HlaeError),
    #[error(transparent)]
    Protocol(#[from] HlaeSessionProtocolError),
    #[error(transparent)]
    Bridge(#[from] RuntimeHlaeBridgeError),
    #[error(transparent)]
    Platform(#[from] PlatformError),
    #[error(transparent)]
    Stability(#[from] HlaeTakeStabilityError),
    #[error(transparent)]
    Encode(#[from] HlaeTakeMp4EncodeError),
    #[error(transparent)]
    DiskSpace(#[from] HlaeDiskSpacePreflightError),
    #[error("managed HLAE session I/O failed while {operation} {path}: {source}")]
    Io {
        operation: &'static str,
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("managed HLAE protocol did not finalize before its absolute deadline")]
    ProtocolTimedOut,
    #[error("managed HLAE session entered terminal state {0:?} before finalization")]
    UnexpectedTerminal(vibe_cs_hlae::HlaeSessionState),
    #[error("managed HLAE bridge reported failure: {0}")]
    BridgeReported(String),
    #[error("managed HLAE custom loader exited unsuccessfully with code {exit_code}")]
    LoaderExited { exit_code: i32 },
    #[error("managed HLAE encoder task failed: {0}")]
    EncoderTask(String),
    #[error("managed HLAE cancellation timed out while {phase} after {timeout:?}")]
    CancellationTimedOut {
        phase: &'static str,
        timeout: Duration,
    },
    #[error("managed HLAE session reached finalization without {0}")]
    MissingEvidence(&'static str),
    #[error("managed HLAE cleanup failed after {primary}: {cleanup}")]
    Cleanup { primary: String, cleanup: String },
}

#[derive(Debug)]
struct CaptureProgramView {
    kind: &'static str,
    demo_path: PathBuf,
    output_directory: PathBuf,
    seek_tick: u32,
    first_tick: u32,
    last_tick: u32,
    tick_rate: f64,
    capture: CaptureSettings,
    command_system: GeneratedArtifact,
    auxiliary_artifacts: Vec<GeneratedArtifact>,
    observer: Option<CaptureObserverContract>,
    persistent_pov_commands: Option<HlaePersistentPovCommands>,
    maximum_staging_bytes: u64,
}

#[derive(Debug)]
struct PreparedHlaeSession {
    listener: RuntimeHlaeBridgeListener,
    invocation: HlaeCustomLoaderInvocation,
    machine: HlaeSessionMachine,
    bridge_context: HlaeBridgeLaunchContext,
    manifest_path: PathBuf,
    disk_space: HlaeDiskSpaceEvidence,
    capture: CaptureSettings,
    tick_rate: f64,
    demo_path: PathBuf,
    verified_total_ticks: u32,
    persistent_commands: Option<HlaePersistentPovCommands>,
    managed_config_contents: Vec<u8>,
}

#[derive(Debug)]
struct ConnectedHlaeSession {
    session_root: PathBuf,
    machine: HlaeSessionMachine,
    connection: RuntimeHlaeBridgeConnection,
    token: SessionToken,
    manifest_path: PathBuf,
    disk_space: HlaeDiskSpaceEvidence,
    capture: CaptureSettings,
    tick_rate: f64,
    protocol_origin: tokio::time::Instant,
}

#[derive(Debug)]
struct CompletedHlaeSession {
    evidence: RuntimeHlaeSessionEvidence,
    take_directory: PathBuf,
    managed_config_contents: Vec<u8>,
    machine: HlaeSessionMachine,
    connection: RuntimeHlaeBridgeConnection,
    token: SessionToken,
    manifest_path: PathBuf,
    disk_space: HlaeDiskSpaceEvidence,
    capture: CaptureSettings,
    tick_rate: f64,
    demo_path: PathBuf,
    verified_total_ticks: u32,
    persistent_commands: Option<HlaePersistentPovCommands>,
    protocol_origin: tokio::time::Instant,
}

/// One authenticated process/socket/state machine retained between typed
/// takes. Construction is possible only through the orchestrator after the
/// first Take reached Finalizing and its MP4 was verified.
pub struct RuntimeHlaePersistentSession {
    job_id: uuid::Uuid,
    session_root: PathBuf,
    connected: ConnectedHlaeSession,
    process: Option<Box<dyn HlaeSessionProcess>>,
    loader_process_id: u32,
    game_process_id: u32,
    demo_path: PathBuf,
    verified_total_ticks: u32,
    persistent_commands: HlaePersistentPovCommands,
    launch_inputs: HlaeBundleLaunchInputs,
    managed_config_contents: Vec<u8>,
    timeouts: RuntimeHlaeSessionTimeouts,
    cancellation: ProcessCancellation,
    control_sequence: u64,
    next_take_index: usize,
    last_take_directory: PathBuf,
    last_published_output: PathBuf,
}

impl fmt::Debug for RuntimeHlaePersistentSession {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("RuntimeHlaePersistentSession")
            .field("job_id", &self.job_id)
            .field("session_root", &self.session_root)
            .field("loader_process_id", &self.loader_process_id)
            .field("game_process_id", &self.game_process_id)
            .field("next_take_index", &self.next_take_index)
            .finish_non_exhaustive()
    }
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RuntimeHlaeArtifactManifest {
    state: String,
    producer: String,
    capture_program: String,
    artifacts: Vec<RuntimeHlaeArtifactManifestEntry>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RuntimeHlaeArtifactManifestEntry {
    path: String,
    size: u64,
    sha256: String,
}

#[derive(Debug)]
struct ArtifactToPublish {
    relative_path: PathBuf,
    bytes: Vec<u8>,
}

#[derive(Debug, Clone)]
#[cfg_attr(not(test), allow(dead_code))]
struct HlaeBridgeLaunchContext {
    endpoint: String,
    token: vibe_cs_hlae::SessionToken,
    demo_path: PathBuf,
    capture_directory: PathBuf,
    capture_start_tick: u32,
    capture_end_tick: u32,
    seek_target_tick: u32,
    verified_total_ticks: u32,
    expected_observer_steam_id64: Option<String>,
}

#[async_trait]
trait HlaeSessionProcessLauncher: fmt::Debug + Send + Sync {
    async fn launch(
        &self,
        invocation: &HlaeCustomLoaderInvocation,
        expected_cs2_executable: &Path,
        game_discovery_timeout: Duration,
        cancellation: &ProcessCancellation,
        context: &HlaeBridgeLaunchContext,
    ) -> Result<Box<dyn HlaeSessionProcess>, PlatformError>;
}

#[async_trait]
trait HlaeSessionProcess: fmt::Debug + Send + Sync {
    fn loader_process_id(&self) -> u32;
    fn game_process_id(&self) -> u32;
    async fn wait_loader(
        &self,
        cancellation: &ProcessCancellation,
    ) -> Result<vibe_cs_platform_windows::ProcessTreeExit, PlatformError>;
    fn close(self: Box<Self>) -> Result<(), PlatformError>;
}

#[async_trait]
trait HlaeSteamClientReadiness: fmt::Debug + Send + Sync {
    async fn ensure_ready(
        &self,
        steam_executable: &Path,
        cancellation: &ProcessCancellation,
    ) -> Result<(), PlatformError>;
}

trait HlaeSessionEncoder: fmt::Debug + Send + Sync {
    fn encode(
        &self,
        request: &HlaeTakeMp4EncodeRequest,
        cancellation: &ProcessCancellation,
    ) -> Result<HlaeTakeMp4EncodeEvidence, HlaeTakeMp4EncodeError>;
}

trait HlaeSessionDiskPreflight: fmt::Debug + Send + Sync {
    fn preflight(
        &self,
        staging_directory: &Path,
        staging_bytes: u64,
    ) -> Result<HlaeDiskSpaceEvidence, HlaeDiskSpacePreflightError>;
}

#[derive(Debug, Default)]
struct SystemHlaeSessionProcessLauncher;

#[derive(Debug, Default)]
struct SystemHlaeSteamClientReadiness;

#[async_trait]
impl HlaeSteamClientReadiness for SystemHlaeSteamClientReadiness {
    async fn ensure_ready(
        &self,
        steam_executable: &Path,
        cancellation: &ProcessCancellation,
    ) -> Result<(), PlatformError> {
        ensure_system_steam_client_ready(steam_executable, cancellation).await
    }
}

#[cfg(test)]
#[derive(Debug, Default)]
struct TestHlaeSteamClientReadiness;

#[cfg(test)]
#[async_trait]
impl HlaeSteamClientReadiness for TestHlaeSteamClientReadiness {
    async fn ensure_ready(
        &self,
        _steam_executable: &Path,
        _cancellation: &ProcessCancellation,
    ) -> Result<(), PlatformError> {
        Ok(())
    }
}

#[async_trait]
impl HlaeSessionProcessLauncher for SystemHlaeSessionProcessLauncher {
    async fn launch(
        &self,
        invocation: &HlaeCustomLoaderInvocation,
        expected_cs2_executable: &Path,
        game_discovery_timeout: Duration,
        cancellation: &ProcessCancellation,
        _context: &HlaeBridgeLaunchContext,
    ) -> Result<Box<dyn HlaeSessionProcess>, PlatformError> {
        RuntimeManagedHlaeProcess::launch(
            invocation,
            expected_cs2_executable,
            game_discovery_timeout,
            cancellation,
        )
        .await
        .map(|process| Box::new(process) as Box<dyn HlaeSessionProcess>)
    }
}

#[async_trait]
impl HlaeSessionProcess for RuntimeManagedHlaeProcess {
    fn loader_process_id(&self) -> u32 {
        self.loader_process_id()
    }

    fn game_process_id(&self) -> u32 {
        self.game_process_id()
    }

    async fn wait_loader(
        &self,
        cancellation: &ProcessCancellation,
    ) -> Result<vibe_cs_platform_windows::ProcessTreeExit, PlatformError> {
        self.wait_loader(cancellation).await
    }

    fn close(self: Box<Self>) -> Result<(), PlatformError> {
        (*self).close()
    }
}

#[derive(Debug, Default)]
struct SystemHlaeSessionEncoder;

impl HlaeSessionEncoder for SystemHlaeSessionEncoder {
    fn encode(
        &self,
        request: &HlaeTakeMp4EncodeRequest,
        cancellation: &ProcessCancellation,
    ) -> Result<HlaeTakeMp4EncodeEvidence, HlaeTakeMp4EncodeError> {
        RuntimeHlaeSequenceEncoder::encode(request, cancellation)
    }
}

#[derive(Debug, Default)]
struct SystemHlaeSessionDiskPreflight;

impl HlaeSessionDiskPreflight for SystemHlaeSessionDiskPreflight {
    fn preflight(
        &self,
        staging_directory: &Path,
        staging_bytes: u64,
    ) -> Result<HlaeDiskSpaceEvidence, HlaeDiskSpacePreflightError> {
        vibe_cs_platform_windows::preflight_hlae_staging_disk_space(
            staging_directory,
            staging_bytes,
        )
    }
}

/// Owns the real HLAE listener, process tree, protocol, take finalizer, and
/// native Windows encoder used by a managed session.
pub struct RuntimeHlaeSessionOrchestrator {
    process_launcher: Arc<dyn HlaeSessionProcessLauncher>,
    encoder: Arc<dyn HlaeSessionEncoder>,
    disk_preflight: Arc<dyn HlaeSessionDiskPreflight>,
    steam_client: Arc<dyn HlaeSteamClientReadiness>,
}

impl fmt::Debug for RuntimeHlaeSessionOrchestrator {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("RuntimeHlaeSessionOrchestrator")
            .finish_non_exhaustive()
    }
}

impl Default for RuntimeHlaeSessionOrchestrator {
    fn default() -> Self {
        Self {
            process_launcher: Arc::new(SystemHlaeSessionProcessLauncher),
            encoder: Arc::new(SystemHlaeSessionEncoder),
            disk_preflight: Arc::new(SystemHlaeSessionDiskPreflight),
            steam_client: Arc::new(SystemHlaeSteamClientReadiness),
        }
    }
}

impl RuntimeHlaeSessionOrchestrator {
    /// Runs one managed offline capture and publishes a verified MP4 only after
    /// the authenticated session reaches finalization.
    ///
    /// # Errors
    ///
    /// Returns a fail-closed error before creating the job for an invalid
    /// request, or after cleaning artifacts created by a failed session.
    pub async fn run(
        &self,
        request: RuntimeHlaeSessionRequest,
    ) -> Result<RuntimeHlaeSessionEvidence, RuntimeHlaeSessionError> {
        let (progress, receiver) = recording_progress_channel();
        drop(receiver);
        self.run_with_progress(request, progress).await
    }

    /// Runs one managed capture while publishing bounded, verified pipeline
    /// milestones through a non-blocking sink.
    ///
    /// # Errors
    ///
    /// Returns the same fail-closed validation, launch, protocol, encoding, or
    /// cleanup error as [`Self::run`].
    pub async fn run_with_progress(
        &self,
        request: RuntimeHlaeSessionRequest,
        progress: RecordingProgressSink,
    ) -> Result<RuntimeHlaeSessionEvidence, RuntimeHlaeSessionError> {
        if matches!(
            &request.capture_program,
            RuntimeHlaeCaptureProgram::PlayerPov(_)
        ) {
            let output = request.output_mp4.clone();
            let (session, evidence) = self
                .begin_persistent_with_progress(request, progress)
                .await?;
            if let Err(primary) = self.finish_persistent(session).await {
                return match remove_owned_output(&output) {
                    Ok(()) => Err(primary),
                    Err(cleanup) => Err(RuntimeHlaeSessionError::Cleanup {
                        primary: primary.to_string(),
                        cleanup: cleanup.to_string(),
                    }),
                };
            }
            return Ok(evidence);
        }
        if request.cancellation.is_cancelled() {
            return Err(PlatformError::Cancelled { process_id: None }.into());
        }
        validate_request_mode(&request)?;
        validate_request_basics(&request)?;
        validate_declared_capture_contract(&request)?;
        claim_managed_job(&request)?;

        let result = async {
            let program = capture_program_view(&request)?;
            validate_compiled_capture_contract(&request, &program)?;
            self.run_claimed(&request, program, &progress).await
        }
        .await;
        if let Err(primary) = result {
            return match cleanup_failed_session(&request).await {
                Ok(()) => Err(primary),
                Err(cleanup) => Err(RuntimeHlaeSessionError::Cleanup {
                    primary: primary.to_string(),
                    cleanup: cleanup.to_string(),
                }),
            };
        }
        result
    }

    /// Opens one authenticated POV session, publishes its first verified Take,
    /// and retains the process/socket/state machine for typed subsequent Takes.
    ///
    /// # Errors
    ///
    /// Returns the same fail-closed validation, launch, protocol, encoding, or
    /// cleanup errors as [`Self::run_with_progress`].
    pub async fn begin_persistent_with_progress(
        &self,
        request: RuntimeHlaeSessionRequest,
        progress: RecordingProgressSink,
    ) -> Result<(RuntimeHlaePersistentSession, RuntimeHlaeSessionEvidence), RuntimeHlaeSessionError>
    {
        if request.cancellation.is_cancelled() {
            return Err(PlatformError::Cancelled { process_id: None }.into());
        }
        validate_request_mode(&request)?;
        validate_request_basics(&request)?;
        validate_declared_capture_contract(&request)?;
        claim_managed_job(&request)?;
        let result = async {
            let program = capture_program_view(&request)?;
            validate_compiled_capture_contract(&request, &program)?;
            if program.persistent_pov_commands.is_none() {
                return Err(HlaeError::InvalidPlan(
                    "persistent HLAE session requires a player-POV capture program".to_owned(),
                )
                .into());
            }
            self.start_claimed(&request, program, &progress).await
        }
        .await;
        let (process, mut completed) = match result {
            Ok(value) => value,
            Err(primary) => {
                return match cleanup_failed_session(&request).await {
                    Ok(()) => Err(primary),
                    Err(cleanup) => Err(RuntimeHlaeSessionError::Cleanup {
                        primary: primary.to_string(),
                        cleanup: cleanup.to_string(),
                    }),
                };
            }
        };
        if let Err(primary) = publish_staged_output(
            &request.managed_job_root,
            &completed.evidence.mp4_summary.output_path,
            &request.output_mp4,
            &request.cancellation,
        ) {
            let close = process.close();
            let cleanup = cleanup_failed_session(&request).await;
            return Err(combine_start_cleanup(primary, close, cleanup));
        }
        completed
            .evidence
            .mp4_summary
            .output_path
            .clone_from(&request.output_mp4);
        let CompletedHlaeSession {
            evidence,
            take_directory,
            managed_config_contents,
            machine,
            connection,
            token,
            manifest_path,
            disk_space,
            capture,
            tick_rate,
            demo_path,
            verified_total_ticks,
            persistent_commands,
            protocol_origin,
        } = completed;
        let persistent_commands = persistent_commands.ok_or_else(|| {
            RuntimeHlaeSessionError::from(HlaeError::InvalidPlan(
                "verified POV session lost its persistent command contract".to_owned(),
            ))
        })?;
        let session = RuntimeHlaePersistentSession {
            job_id: request.job_id,
            session_root: request.managed_job_root.clone(),
            connected: ConnectedHlaeSession {
                session_root: request.managed_job_root.clone(),
                machine,
                connection,
                token,
                manifest_path,
                disk_space,
                capture,
                tick_rate,
                protocol_origin,
            },
            process: Some(process),
            loader_process_id: evidence.loader_process_id,
            game_process_id: evidence.game_process_id,
            demo_path,
            verified_total_ticks,
            persistent_commands,
            launch_inputs: request.launch_inputs,
            managed_config_contents,
            timeouts: request.timeouts,
            cancellation: request.cancellation,
            control_sequence: 1,
            next_take_index: request.take_index.saturating_add(1),
            last_take_directory: take_directory,
            last_published_output: request.output_mp4,
        };
        Ok((session, evidence))
    }

    /// Advances one authenticated POV session to its next immutable Take and
    /// publishes the verified MP4 without launching another process.
    ///
    /// # Errors
    ///
    /// Rejects changed job/session/capture facts, a missing database-ACK
    /// sequence, invalid typed controls, or any capture/encode failure.
    pub async fn capture_next_persistent_with_progress(
        &self,
        session: &mut RuntimeHlaePersistentSession,
        request: RuntimeHlaeSessionRequest,
        progress: RecordingProgressSink,
    ) -> Result<RuntimeHlaeSessionEvidence, RuntimeHlaeSessionError> {
        if request.job_id != session.job_id
            || request.take_index != session.next_take_index
            || request.managed_job_root != session.session_root
            || request.launch_inputs != session.launch_inputs
            || request.verified_total_ticks != session.verified_total_ticks
            || request.timeouts != session.timeouts
        {
            return Err(HlaeError::InvalidPlan(
                "persistent HLAE Take changed its immutable session binding".to_owned(),
            )
            .into());
        }
        if request.cancellation.is_cancelled()
            || !request.output_mp4.is_absolute()
            || request.output_mp4.exists()
            || request
                .output_mp4
                .parent()
                .is_none_or(|parent| !parent.is_dir())
        {
            return Err(HlaeError::InvalidPlan(
                "persistent HLAE Take has an invalid output or cancellation state".to_owned(),
            )
            .into());
        }
        validate_request_mode(&request)?;
        validate_declared_capture_contract(&request)?;
        let program = capture_program_view(&request)?;
        if program.demo_path != session.demo_path
            || program.output_directory != session.session_root.join("capture")
            || program.capture != session.connected.capture
            || program.persistent_pov_commands.as_ref() != Some(&session.persistent_commands)
        {
            return Err(HlaeError::InvalidPlan(
                "persistent HLAE Take changed its POV program or capture root".to_owned(),
            )
            .into());
        }
        let ticks = CaptureTickContract::try_new(
            session.verified_total_ticks,
            program.seek_tick,
            program.first_tick,
            program.last_tick,
            request.max_start_overshoot_ticks,
            request.max_end_overshoot_ticks,
        )?;
        session
            .connected
            .machine
            .apply_host_event(HlaeHostEvent::AdvanceTake {
                ticks,
                observer: program.observer,
            })?;
        let take_index = u32::try_from(request.take_index)
            .map_err(|_| HlaeSessionProtocolError::InvalidControlEnvelope)?;
        let advance = HlaeBridgeControlMessage::advance_take(
            &session.connected.token,
            session.control_sequence,
            take_index,
            ticks,
            program.observer,
        )?;
        session
            .connected
            .connection
            .send_control(
                &advance,
                request.timeouts.bridge_receive,
                &request.cancellation,
            )
            .await?;
        session.control_sequence += 1;
        let process = session.process.as_deref().ok_or_else(|| {
            RuntimeHlaeSessionError::from(HlaeError::InvalidPlan(
                "persistent HLAE process is unavailable".to_owned(),
            ))
        })?;
        let (mut evidence, take_directory) = self
            .drive_connected_take(
                &request,
                &mut session.connected,
                process,
                session.loader_process_id,
                session.game_process_id,
                &progress,
            )
            .await?;
        publish_staged_output(
            &session.session_root,
            &evidence.mp4_summary.output_path,
            &request.output_mp4,
            &request.cancellation,
        )?;
        evidence
            .mp4_summary
            .output_path
            .clone_from(&request.output_mp4);
        session.next_take_index += 1;
        session.last_take_directory = take_directory;
        session.last_published_output = request.output_mp4;
        session.cancellation = request.cancellation;
        Ok(evidence)
    }

    /// Sends the typed terminal control, closes the one retained process tree,
    /// restores the snapshotted user configuration, and removes raw takes.
    ///
    /// # Errors
    ///
    /// Returns a fail-closed protocol, process, or cleanup error. Published MP4
    /// files remain outside the disposable session root.
    pub async fn finish_persistent(
        &self,
        mut session: RuntimeHlaePersistentSession,
    ) -> Result<(), RuntimeHlaeSessionError> {
        let finish_result = async {
            let finish = HlaeBridgeControlMessage::finish_session(
                &session.connected.token,
                session.control_sequence,
            )?;
            session
                .connected
                .connection
                .send_control(
                    &finish,
                    session.timeouts.bridge_receive,
                    &session.cancellation,
                )
                .await?;
            session
                .connected
                .machine
                .apply_host_event(HlaeHostEvent::FinalizationCompleted)?;
            if session.connected.machine.state() != HlaeSessionState::Completed {
                return Err(terminal_session_error(&session.connected.machine));
            }
            Ok(())
        }
        .await;
        let close_result = session
            .process
            .take()
            .map_or(Ok(()), HlaeSessionProcess::close);
        let cleanup_result = cleanup_persistent_session_files(&session);
        combine_persistent_finish(finish_result, close_result, cleanup_result)
    }

    /// Closes a failed/cancelled persistent process without sending another
    /// protocol control, then removes only its disposable raw/config state.
    /// Published prefix MP4 files remain untouched.
    ///
    /// # Errors
    ///
    /// Returns a process-close or managed-session cleanup error after making a
    /// bounded attempt at both operations.
    pub fn abort_persistent(
        &self,
        mut session: RuntimeHlaePersistentSession,
    ) -> Result<(), RuntimeHlaeSessionError> {
        let close_result = session
            .process
            .take()
            .map_or(Ok(()), HlaeSessionProcess::close);
        let cleanup_result = cleanup_persistent_session_files(&session);
        combine_persistent_finish(Ok(()), close_result, cleanup_result)
    }

    async fn run_claimed(
        &self,
        request: &RuntimeHlaeSessionRequest,
        program: CaptureProgramView,
        progress: &RecordingProgressSink,
    ) -> Result<RuntimeHlaeSessionEvidence, RuntimeHlaeSessionError> {
        let (process, mut completed) = self.start_claimed(request, program, progress).await?;
        let finish_result = async {
            let finish = HlaeBridgeControlMessage::finish_session(&completed.token, 1)?;
            completed
                .connection
                .send_control(
                    &finish,
                    request.timeouts.bridge_receive,
                    &request.cancellation,
                )
                .await?;
            completed
                .machine
                .apply_host_event(HlaeHostEvent::FinalizationCompleted)?;
            if completed.machine.state() != HlaeSessionState::Completed {
                return Err(terminal_session_error(&completed.machine));
            }
            Ok(())
        }
        .await;
        let close_result = process.close();
        match (finish_result, close_result) {
            (Ok(()), Ok(())) => {
                if request.cancellation.is_cancelled() {
                    remove_owned_output(&completed.evidence.mp4_summary.output_path)?;
                    return Err(PlatformError::Cancelled {
                        process_id: Some(completed.evidence.game_process_id),
                    }
                    .into());
                }
                remove_user_config_snapshot(
                    &request.managed_job_root,
                    &completed.managed_config_contents,
                )?;
                publish_staged_output(
                    &request.managed_job_root,
                    &completed.evidence.mp4_summary.output_path,
                    &request.output_mp4,
                    &request.cancellation,
                )?;
                completed
                    .evidence
                    .mp4_summary
                    .output_path
                    .clone_from(&request.output_mp4);
                if let Err(error) = remove_successful_capture_tree(
                    &request.managed_job_root,
                    &completed.take_directory,
                    &completed.evidence.mp4_summary.output_path,
                ) {
                    remove_owned_output(&completed.evidence.mp4_summary.output_path)?;
                    return Err(error);
                }
                Ok(completed.evidence)
            }
            (Err(primary), Ok(())) => Err(primary),
            (Ok(()), Err(close)) => {
                remove_owned_output(&completed.evidence.mp4_summary.output_path).map_err(
                    |cleanup| RuntimeHlaeSessionError::Cleanup {
                        primary: format!("closing managed HLAE process tree: {close}"),
                        cleanup: cleanup.to_string(),
                    },
                )?;
                Err(close.into())
            }
            (Err(primary), Err(close)) => Err(RuntimeHlaeSessionError::Cleanup {
                primary: primary.to_string(),
                cleanup: format!("closing managed HLAE process tree: {close}"),
            }),
        }
    }

    async fn start_claimed(
        &self,
        request: &RuntimeHlaeSessionRequest,
        program: CaptureProgramView,
        progress: &RecordingProgressSink,
    ) -> Result<(Box<dyn HlaeSessionProcess>, CompletedHlaeSession), RuntimeHlaeSessionError> {
        let mut prepared = self.prepare(request, &program).await?;
        prepared
            .machine
            .apply_host_event(HlaeHostEvent::PreparationVerified)?;
        prepared
            .machine
            .apply_host_event(HlaeHostEvent::LaunchRequested)?;

        progress.report(RecordingStage::Launching);
        self.steam_client
            .ensure_ready(
                &request.launch_inputs.steam_executable,
                &request.cancellation,
            )
            .await?;
        let process = self
            .process_launcher
            .launch(
                &prepared.invocation,
                &request.launch_inputs.game_executable,
                request.timeouts.game_discovery,
                &request.cancellation,
                &prepared.bridge_context,
            )
            .await?;
        let loader_process_id = process.loader_process_id();
        let game_process_id = process.game_process_id();
        prepared
            .machine
            .apply_host_event(HlaeHostEvent::LoaderStarted {
                process_id: loader_process_id,
            })?;

        let session_result = self
            .drive_authenticated_session(
                request,
                prepared,
                process.as_ref(),
                loader_process_id,
                game_process_id,
                progress,
            )
            .await;
        match session_result {
            Ok(completed) => Ok((process, completed)),
            Err(primary) => match process.close() {
                Ok(()) => Err(primary),
                Err(close) => Err(RuntimeHlaeSessionError::Cleanup {
                    primary: primary.to_string(),
                    cleanup: format!("closing managed HLAE process tree: {close}"),
                }),
            },
        }
    }

    async fn prepare(
        &self,
        request: &RuntimeHlaeSessionRequest,
        program: &CaptureProgramView,
    ) -> Result<PreparedHlaeSession, RuntimeHlaeSessionError> {
        let listener = RuntimeHlaeBridgeListener::bind().await?;
        let token = SessionToken::generate()?;
        let ticks = CaptureTickContract::try_new(
            request.verified_total_ticks,
            program.seek_tick,
            program.first_tick,
            program.last_tick,
            request.max_start_overshoot_ticks,
            request.max_end_overshoot_ticks,
        )?;
        let paths = ValidatedCapturePaths::verify(
            &program.demo_path,
            &request.managed_job_root,
            &program.output_directory,
        )?;
        let mut bridge_contract = MirvScriptBridgeContract::new(ticks);
        if let Some(observer) = program.observer {
            bridge_contract = bridge_contract.with_observer(observer);
        }
        if let Some(commands) = program.persistent_pov_commands.as_ref() {
            bridge_contract = bridge_contract.with_persistent_pov(commands);
        }
        let bridge = compile_mirv_script_bridge(listener.endpoint(), &token, bridge_contract)?;

        let mut artifacts = Vec::with_capacity(program.auxiliary_artifacts.len() + 3);
        artifacts.push(ArtifactToPublish {
            relative_path: PathBuf::from("vibe_cs_commands.xml"),
            bytes: program.command_system.contents.as_bytes().to_vec(),
        });
        for artifact in &program.auxiliary_artifacts {
            let name = artifact.path.file_name().ok_or_else(|| {
                HlaeError::InvalidPlan("camera artifact has no direct-child filename".to_owned())
            })?;
            artifacts.push(ArtifactToPublish {
                relative_path: PathBuf::from(name),
                bytes: artifact.contents.as_bytes().to_vec(),
            });
        }
        artifacts.push(ArtifactToPublish {
            relative_path: PathBuf::from(bridge.file_name()),
            bytes: bridge.source().as_bytes().to_vec(),
        });
        publish_artifacts(&request.managed_job_root, &artifacts)?;

        let cfg_directory = request.managed_job_root.join("cfg");
        fs::create_dir(&cfg_directory).map_err(|source| RuntimeHlaeSessionError::Io {
            operation: "creating isolated cfg directory at",
            path: cfg_directory.clone(),
            source,
        })?;
        let user_config_directory = request
            .launch_inputs
            .user_config_directory
            .as_deref()
            .ok_or_else(|| {
                HlaeError::InvalidPlan(
                    "managed HLAE launch has no active Steam user configuration".to_owned(),
                )
            })?;
        snapshot_cs2_user_config(user_config_directory, &cfg_directory)?;
        let command_path = request.managed_job_root.join("vibe_cs_commands.xml");
        let bridge_path = request.managed_job_root.join(bridge.file_name());
        let bootstrap = compile_hlae_managed_session_bootstrap(
            &request.managed_job_root,
            &program.demo_path,
            &command_path,
            &bridge_path,
        )?;
        atomic_write_new(bootstrap.path(), bootstrap.contents().as_bytes())?;
        artifacts.push(ArtifactToPublish {
            relative_path: PathBuf::from(vibe_cs_hlae::HLAE_MANAGED_SESSION_CONFIG_RELATIVE_PATH),
            bytes: bootstrap.contents().as_bytes().to_vec(),
        });

        let manifest_path = publish_manifest(&request.managed_job_root, program.kind, &artifacts)?;
        validate_published_artifacts(&request.managed_job_root, &artifacts)?;

        let profile = build_hlae_launch_profile(
            &request.launch_inputs.installation,
            &request.launch_inputs.game_executable,
            &request.launch_inputs.steam_executable,
            &request.managed_job_root,
            request.launch_inputs.resolution,
        )?;
        let invocation = build_hlae_managed_session_invocation(&profile, &bootstrap)?;
        let disk_space = self
            .disk_preflight
            .preflight(&request.managed_job_root, program.maximum_staging_bytes)?;
        let machine = if let Some(observer) = program.observer {
            HlaeSessionMachine::new_with_observer(token.clone(), paths, ticks, observer)
        } else {
            HlaeSessionMachine::new(token.clone(), paths, ticks)
        };
        let bridge_context = HlaeBridgeLaunchContext {
            endpoint: listener.endpoint().to_owned(),
            token,
            demo_path: program.demo_path.clone(),
            capture_directory: program.output_directory.clone(),
            capture_start_tick: program.first_tick,
            capture_end_tick: program.last_tick,
            seek_target_tick: program.seek_tick,
            verified_total_ticks: request.verified_total_ticks,
            expected_observer_steam_id64: program
                .observer
                .map(|observer| observer.steam_id64().to_string()),
        };
        Ok(PreparedHlaeSession {
            listener,
            invocation,
            machine,
            bridge_context,
            manifest_path,
            disk_space,
            capture: program.capture.clone(),
            tick_rate: program.tick_rate,
            demo_path: program.demo_path.clone(),
            verified_total_ticks: request.verified_total_ticks,
            persistent_commands: program.persistent_pov_commands.clone(),
            managed_config_contents: bootstrap.contents().as_bytes().to_vec(),
        })
    }

    async fn drive_authenticated_session(
        &self,
        request: &RuntimeHlaeSessionRequest,
        mut prepared: PreparedHlaeSession,
        process: &dyn HlaeSessionProcess,
        loader_process_id: u32,
        game_process_id: u32,
        progress: &RecordingProgressSink,
    ) -> Result<CompletedHlaeSession, RuntimeHlaeSessionError> {
        let accept = prepared.listener.accept(
            game_process_id,
            request.timeouts.bridge_accept,
            &request.cancellation,
        );
        let loader_wait = process.wait_loader(&request.cancellation);
        tokio::pin!(accept);
        tokio::pin!(loader_wait);
        let mut loader_exit_seen = false;
        let connection = loop {
            tokio::select! {
                biased;
                exited = &mut loader_wait, if !loader_exit_seen => {
                    apply_loader_exit(&mut prepared.machine, exited?)?;
                    loader_exit_seen = true;
                }
                accepted = &mut accept => break accepted?,
            }
        };
        prepared
            .machine
            .apply_host_event(HlaeHostEvent::GameHookAuthenticated { game_process_id })?;

        let token = prepared.bridge_context.token.clone();
        let managed_config_contents = prepared.managed_config_contents;
        let demo_path = prepared.demo_path;
        let verified_total_ticks = prepared.verified_total_ticks;
        let persistent_commands = prepared.persistent_commands;
        let mut connected = ConnectedHlaeSession {
            session_root: request.managed_job_root.clone(),
            machine: prepared.machine,
            connection,
            token,
            manifest_path: prepared.manifest_path,
            disk_space: prepared.disk_space,
            capture: prepared.capture,
            tick_rate: prepared.tick_rate,
            protocol_origin: tokio::time::Instant::now(),
        };
        let (evidence, take_directory) = self
            .drive_connected_take(
                request,
                &mut connected,
                process,
                loader_process_id,
                game_process_id,
                progress,
            )
            .await?;
        Ok(CompletedHlaeSession {
            evidence,
            take_directory,
            managed_config_contents,
            machine: connected.machine,
            connection: connected.connection,
            token: connected.token,
            manifest_path: connected.manifest_path,
            disk_space: connected.disk_space,
            capture: connected.capture,
            tick_rate: connected.tick_rate,
            demo_path,
            verified_total_ticks,
            persistent_commands,
            protocol_origin: connected.protocol_origin,
        })
    }
    async fn drive_connected_take(
        &self,
        request: &RuntimeHlaeSessionRequest,
        connected: &mut ConnectedHlaeSession,
        process: &dyn HlaeSessionProcess,
        loader_process_id: u32,
        game_process_id: u32,
        progress: &RecordingProgressSink,
    ) -> Result<(RuntimeHlaeSessionEvidence, PathBuf), RuntimeHlaeSessionError> {
        let loader_wait = process.wait_loader(&request.cancellation);
        tokio::pin!(loader_wait);
        let mut loader_exit_seen = false;
        let protocol_started = tokio::time::Instant::now();
        let protocol_deadline = protocol_started + request.timeouts.protocol;
        loop {
            match connected.machine.state() {
                HlaeSessionState::Finalizing => break,
                HlaeSessionState::Completed
                | HlaeSessionState::Failed
                | HlaeSessionState::Cancelled => {
                    return Err(terminal_session_error(&connected.machine));
                }
                _ => {}
            }
            let remaining =
                protocol_deadline.saturating_duration_since(tokio::time::Instant::now());
            if remaining.is_zero() {
                return Err(RuntimeHlaeSessionError::ProtocolTimedOut);
            }
            let receive_timeout = request.timeouts.bridge_receive.min(remaining);
            let receive = connected
                .connection
                .receive(receive_timeout, &request.cancellation);
            tokio::pin!(receive);
            let bytes = loop {
                tokio::select! {
                    biased;
                    exited = &mut loader_wait, if !loader_exit_seen => {
                        apply_loader_exit(&mut connected.machine, exited?)?;
                        loader_exit_seen = true;
                    }
                    received = &mut receive => break received?,
                }
            };
            let received_at_ms =
                u64::try_from(connected.protocol_origin.elapsed().as_millis()).unwrap_or(u64::MAX);
            let state = connected.machine.ingest_bridge(&bytes, received_at_ms)?;
            match state {
                HlaeSessionState::Seeking => progress.report(RecordingStage::Seeking),
                HlaeSessionState::Capturing => progress.report(RecordingStage::Capturing),
                _ => {}
            }
        }
        let observed_capture_span = connected.machine.observed_capture_span().ok_or(
            RuntimeHlaeSessionError::MissingEvidence("observed capture ticks"),
        )?;
        let take_directory = connected
            .machine
            .capture_take_directory()
            .ok_or(RuntimeHlaeSessionError::MissingEvidence(
                "bound HLAE take directory",
            ))?
            .to_path_buf();
        let frame_count_bounds = hlae_frame_count_bounds(
            observed_capture_span.start_tick(),
            observed_capture_span.end_tick(),
            connected.tick_rate,
            connected.capture.fps,
        )?;
        progress.report(RecordingStage::Stabilizing);
        {
            let stable_take = wait_for_stable_hlae_take(
                &connected.session_root,
                &take_directory,
                HlaeTakeExpectation {
                    width: connected.capture.width,
                    height: connected.capture.height,
                    require_audio: connected.capture.record_wav,
                    maximum_frames: frame_count_bounds.maximum,
                },
                request.take_stability,
                &request.cancellation,
            );
            tokio::pin!(stable_take);
            loop {
                tokio::select! {
                    biased;
                    exited = &mut loader_wait, if !loader_exit_seen => {
                        apply_loader_exit(&mut connected.machine, exited?)?;
                        loader_exit_seen = true;
                    }
                    stable = &mut stable_take => {
                        stable?;
                        break;
                    }
                }
            }
        }

        progress.report(RecordingStage::Encoding);
        let staged_output = request.managed_job_root.join(HLAE_ENCODED_OUTPUT_FILE);
        let partial_output = request.managed_job_root.join(HLAE_PARTIAL_OUTPUT_FILE);
        let encode_request = HlaeTakeMp4EncodeRequest {
            managed_output_root: request.managed_job_root.clone(),
            take_directory: take_directory.clone(),
            output_path: staged_output.clone(),
            partial_output_path: partial_output.clone(),
            width: connected.capture.width,
            height: connected.capture.height,
            fps: connected.capture.fps,
            target_bitrate_bps: request.target_bitrate_bps,
            require_audio: connected.capture.record_wav,
            maximum_frames: frame_count_bounds.maximum,
            minimum_frames: if connected.capture.record_wav {
                frame_count_bounds.minimum.saturating_mul(3).div_ceil(4)
            } else {
                frame_count_bounds.minimum
            },
        };
        let encoder = Arc::clone(&self.encoder);
        let encoding_cancel = ProcessCancellation::default();
        let encoding_cancel_for_task = encoding_cancel.clone();
        let mut encode_task = tokio::task::spawn_blocking(move || {
            encoder.encode(&encode_request, &encoding_cancel_for_task)
        });
        let encode_evidence = loop {
            tokio::select! {
                biased;
                exited = &mut loader_wait, if !loader_exit_seen => {
                    let exit_result = exited
                        .map_err(RuntimeHlaeSessionError::from)
                        .and_then(|exit| apply_loader_exit(&mut connected.machine, exit));
                    match exit_result {
                        Ok(()) => loader_exit_seen = true,
                        Err(error) => {
                            encoding_cancel.cancel();
                            if let Err(cleanup) = remove_completed_encode_output(
                                &mut encode_task,
                                request.timeouts.cancellation_grace,
                                &staged_output,
                                &partial_output,
                            ).await {
                                return Err(RuntimeHlaeSessionError::Cleanup {
                                    primary: error.to_string(),
                                    cleanup: cleanup.to_string(),
                                });
                            }
                            return Err(error);
                        }
                    }
                }
                () = request.cancellation.cancelled() => {
                    encoding_cancel.cancel();
                    remove_completed_encode_output(
                        &mut encode_task,
                        request.timeouts.cancellation_grace,
                        &staged_output,
                        &partial_output,
                    ).await?;
                    return Err(PlatformError::Cancelled {
                        process_id: Some(game_process_id),
                    }.into());
                }
                joined = &mut encode_task => {
                    break joined
                        .map_err(|error| RuntimeHlaeSessionError::EncoderTask(error.to_string()))??;
                }
            }
        };
        if encode_evidence.summary.output_path != staged_output {
            remove_owned_output(&staged_output)?;
            return Err(HlaeError::InvalidPlan(
                "native encoder returned an output outside its fixed job-local staging path"
                    .to_owned(),
            )
            .into());
        }
        let observer_evidence = connected.machine.observer_evidence();
        if connected.machine.state() != HlaeSessionState::Finalizing {
            remove_owned_output(&encode_evidence.summary.output_path)?;
            return Err(terminal_session_error(&connected.machine));
        }
        Ok((
            RuntimeHlaeSessionEvidence {
                managed_job_root: request.managed_job_root.clone(),
                artifact_manifest: connected.manifest_path.clone(),
                loader_process_id,
                game_process_id,
                observed_capture_span,
                observer_evidence,
                frame_count_bounds,
                disk_space: connected.disk_space,
                mp4_summary: encode_evidence.summary,
                mp4_inspection: encode_evidence.inspection,
            },
            take_directory,
        ))
    }

    #[cfg(test)]
    fn with_backends(
        process_launcher: Arc<dyn HlaeSessionProcessLauncher>,
        encoder: Arc<dyn HlaeSessionEncoder>,
        disk_preflight: Arc<dyn HlaeSessionDiskPreflight>,
    ) -> Self {
        Self {
            process_launcher,
            encoder,
            disk_preflight,
            steam_client: Arc::new(TestHlaeSteamClientReadiness),
        }
    }

    #[cfg(test)]
    fn with_all_backends(
        process_launcher: Arc<dyn HlaeSessionProcessLauncher>,
        encoder: Arc<dyn HlaeSessionEncoder>,
        disk_preflight: Arc<dyn HlaeSessionDiskPreflight>,
        steam_client: Arc<dyn HlaeSteamClientReadiness>,
    ) -> Self {
        Self {
            process_launcher,
            encoder,
            disk_preflight,
            steam_client,
        }
    }
}

async fn ensure_system_steam_client_ready(
    steam_executable: &Path,
    cancellation: &ProcessCancellation,
) -> Result<(), PlatformError> {
    if !steam_executable.is_absolute()
        || !steam_executable.is_file()
        || !steam_executable
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.eq_ignore_ascii_case("steam.exe"))
    {
        return Err(PlatformError::InvalidInput(
            "managed HLAE launch expects an existing absolute steam.exe".to_owned(),
        ));
    }
    if cancellation.is_cancelled() {
        return Err(PlatformError::Cancelled { process_id: None });
    }

    #[cfg(not(windows))]
    {
        let _ = steam_executable;
        return Err(PlatformError::Unsupported);
    }

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt as _;

        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let backend = SystemDesktopBackend;
        let steam_running = !backend.discover_processes("steam.exe")?.is_empty();
        let helper_running = !backend.discover_processes("steamwebhelper.exe")?.is_empty();
        if steam_running && helper_running {
            return Ok(());
        }
        if !steam_running {
            let mut command = std::process::Command::new(steam_executable);
            command.arg("-silent").creation_flags(CREATE_NO_WINDOW);
            command.spawn().map_err(|source| PlatformError::Io {
                operation: "starting Steam client at",
                path: steam_executable.to_path_buf(),
                source,
            })?;
        }

        let deadline = tokio::time::Instant::now() + STEAM_CLIENT_STARTUP_TIMEOUT;
        loop {
            if cancellation.is_cancelled() {
                return Err(PlatformError::Cancelled { process_id: None });
            }
            let steam_running = !backend.discover_processes("steam.exe")?.is_empty();
            let helper_running = !backend.discover_processes("steamwebhelper.exe")?.is_empty();
            if steam_running && helper_running {
                return Ok(());
            }
            if tokio::time::Instant::now() >= deadline {
                return Err(PlatformError::ProcessNotFound(
                    "Steam client did not become ready within 30 seconds".to_owned(),
                ));
            }
            tokio::time::sleep(STEAM_CLIENT_POLL_INTERVAL).await;
        }
    }
}

fn terminal_session_error(machine: &HlaeSessionMachine) -> RuntimeHlaeSessionError {
    match (machine.state(), machine.failure_reason()) {
        (HlaeSessionState::Failed, Some(reason)) => {
            RuntimeHlaeSessionError::BridgeReported(reason.to_owned())
        }
        (state, _) => RuntimeHlaeSessionError::UnexpectedTerminal(state),
    }
}

fn combine_start_cleanup(
    primary: RuntimeHlaeSessionError,
    close: Result<(), PlatformError>,
    cleanup: Result<(), RuntimeHlaeSessionError>,
) -> RuntimeHlaeSessionError {
    let mut failures = Vec::new();
    if let Err(error) = close {
        failures.push(format!("closing managed HLAE process tree: {error}"));
    }
    if let Err(error) = cleanup {
        failures.push(error.to_string());
    }
    if failures.is_empty() {
        primary
    } else {
        RuntimeHlaeSessionError::Cleanup {
            primary: primary.to_string(),
            cleanup: failures.join("; "),
        }
    }
}

fn cleanup_persistent_session_files(
    session: &RuntimeHlaePersistentSession,
) -> Result<(), RuntimeHlaeSessionError> {
    remove_user_config_snapshot(&session.session_root, &session.managed_config_contents)?;
    remove_successful_capture_tree(
        &session.session_root,
        &session.last_take_directory,
        &session.last_published_output,
    )
}

fn combine_persistent_finish(
    finish: Result<(), RuntimeHlaeSessionError>,
    close: Result<(), PlatformError>,
    cleanup: Result<(), RuntimeHlaeSessionError>,
) -> Result<(), RuntimeHlaeSessionError> {
    let mut cleanup_failures = Vec::new();
    let primary = match (finish.err(), close.err()) {
        (Some(primary), Some(close)) => {
            cleanup_failures.push(format!("closing managed HLAE process tree: {close}"));
            Some(primary)
        }
        (Some(primary), None) => Some(primary),
        (None, Some(close)) => Some(close.into()),
        (None, None) => None,
    };
    if let Err(error) = cleanup {
        cleanup_failures.push(error.to_string());
    }
    match (primary, cleanup_failures.is_empty()) {
        (None, true) => Ok(()),
        (Some(error), true) => Err(error),
        (Some(error), false) => Err(RuntimeHlaeSessionError::Cleanup {
            primary: error.to_string(),
            cleanup: cleanup_failures.join("; "),
        }),
        (None, false) => Err(RuntimeHlaeSessionError::Cleanup {
            primary: "persistent HLAE session cleanup failed".to_owned(),
            cleanup: cleanup_failures.join("; "),
        }),
    }
}

fn validate_request_mode(request: &RuntimeHlaeSessionRequest) -> Result<(), HlaeError> {
    if matches!(
        &request.capture_program,
        RuntimeHlaeCaptureProgram::Camera(plan) if plan.mode != HlaePlanMode::Capture
    ) {
        return Err(HlaeError::InvalidPlan(
            "managed HLAE sessions require capture mode".to_owned(),
        ));
    }
    Ok(())
}

fn apply_loader_exit(
    machine: &mut HlaeSessionMachine,
    exit: vibe_cs_platform_windows::ProcessTreeExit,
) -> Result<(), RuntimeHlaeSessionError> {
    let exit_code = i32::from_ne_bytes(exit.exit_code.to_ne_bytes());
    machine.apply_host_event(HlaeHostEvent::LoaderExited { exit_code })?;
    if exit_code != 0 {
        return Err(RuntimeHlaeSessionError::LoaderExited { exit_code });
    }
    Ok(())
}

fn validate_request_basics(request: &RuntimeHlaeSessionRequest) -> Result<(), HlaeError> {
    if u32::try_from(request.take_index)
        .map_or(true, |index| index >= vibe_cs_hlae::HLAE_SESSION_MAX_TAKES)
    {
        return Err(HlaeError::InvalidPlan(
            "managed HLAE take index exceeds the session limit".to_owned(),
        ));
    }
    if !request.managed_job_root.is_absolute()
        || request.managed_job_root.file_name().is_none()
        || request.managed_job_root.exists()
        || request
            .managed_job_root
            .parent()
            .is_none_or(|parent| !parent.is_dir())
    {
        return Err(HlaeError::InvalidPlan(
            "managed job root must be an absent absolute direct child of an existing directory"
                .to_owned(),
        ));
    }
    let user_config_directory = request
        .launch_inputs
        .user_config_directory
        .as_deref()
        .ok_or_else(|| {
            HlaeError::InvalidPlan(
                "managed HLAE launch requires an active Steam user configuration".to_owned(),
            )
        })?;
    let user_config_metadata =
        fs::symlink_metadata(user_config_directory).map_err(|error| HlaeError::ArtifactIo {
            operation: "inspect active Steam user configuration",
            message: error.to_string(),
        })?;
    if !user_config_directory.is_absolute()
        || user_config_metadata.file_type().is_symlink()
        || metadata_is_reparse_point(&user_config_metadata)
        || !user_config_metadata.is_dir()
        || user_config_directory.starts_with(&request.managed_job_root)
        || request.managed_job_root.starts_with(user_config_directory)
    {
        return Err(HlaeError::InvalidPlan(
            "active Steam user configuration must be an existing absolute plain directory outside the managed job"
                .to_owned(),
        ));
    }
    if !request.output_mp4.is_absolute()
        || request.output_mp4.exists()
        || request
            .output_mp4
            .extension()
            .and_then(|extension| extension.to_str())
            .is_none_or(|extension| !extension.eq_ignore_ascii_case("mp4"))
        || request
            .output_mp4
            .parent()
            .is_none_or(|parent| !parent.is_dir())
    {
        return Err(HlaeError::InvalidPlan(
            "MP4 output must be a new absolute .mp4 below an existing directory".to_owned(),
        ));
    }
    if request.output_mp4.starts_with(&request.managed_job_root) {
        return Err(HlaeError::InvalidPlan(
            "MP4 output must remain outside the disposable managed job tree".to_owned(),
        ));
    }
    if !(MINIMUM_TARGET_BITRATE_BPS..=MAXIMUM_TARGET_BITRATE_BPS)
        .contains(&request.target_bitrate_bps)
    {
        return Err(HlaeError::InvalidPlan(
            "native MP4 target bitrate is outside the bounded range".to_owned(),
        ));
    }
    let timeouts = request.timeouts;
    if timeouts.game_discovery.is_zero()
        || timeouts.game_discovery > Duration::from_secs(300)
        || timeouts.bridge_accept.is_zero()
        || timeouts.bridge_accept > MAXIMUM_BRIDGE_TIMEOUT
        || timeouts.bridge_receive.is_zero()
        || timeouts.bridge_receive > MAXIMUM_BRIDGE_TIMEOUT
        || timeouts.protocol.is_zero()
        || timeouts.protocol > MAXIMUM_PROTOCOL_TIMEOUT
        || timeouts.cancellation_grace.is_zero()
        || timeouts.cancellation_grace > MAXIMUM_CANCELLATION_GRACE
    {
        return Err(HlaeError::InvalidPlan(
            "managed HLAE session timeouts are outside their bounded ranges".to_owned(),
        ));
    }
    Ok(())
}

fn capture_program_view(
    request: &RuntimeHlaeSessionRequest,
) -> Result<CaptureProgramView, RuntimeHlaeSessionError> {
    let allowed_last_tick = match &request.capture_program {
        RuntimeHlaeCaptureProgram::Camera(plan) => {
            vibe_cs_hlae::validate_hlae_plan(plan)?;
            let first_tick = u32::try_from(
                plan.shots
                    .first()
                    .ok_or_else(|| HlaeError::InvalidPlan("camera plan has no shots".to_owned()))?
                    .start_tick,
            )
            .map_err(|_| HlaeError::InvalidPlan("camera start tick is unsupported".to_owned()))?;
            let last_tick = u32::try_from(
                plan.shots
                    .last()
                    .ok_or_else(|| HlaeError::InvalidPlan("camera plan has no shots".to_owned()))?
                    .end_tick,
            )
            .map_err(|_| HlaeError::InvalidPlan("camera end tick is unsupported".to_owned()))?;
            let seek_tick =
                first_tick.saturating_sub(u32::try_from(plan.pre_roll_ticks).map_err(|_| {
                    HlaeError::InvalidPlan("camera pre-roll is unsupported".to_owned())
                })?);
            let allowed_last_tick = last_tick
                .checked_add(request.max_end_overshoot_ticks)
                .ok_or(HlaeSessionProtocolError::InvalidTickContract)?;
            let estimate = estimate_hlae_capture_span_resources(
                first_tick,
                allowed_last_tick,
                plan.tick_rate,
                &plan.capture,
            )?;
            let compiled = compile_hlae_plan(plan, &request.managed_job_root)?;
            return Ok(CaptureProgramView {
                kind: "camera",
                demo_path: plan.demo_path.clone(),
                output_directory: plan.output_directory.clone(),
                seek_tick,
                first_tick,
                last_tick,
                tick_rate: plan.tick_rate,
                capture: plan.capture.clone(),
                command_system: compiled.command_system,
                auxiliary_artifacts: compiled.camera_paths,
                observer: None,
                persistent_pov_commands: None,
                maximum_staging_bytes: estimate.total_bytes,
            });
        }
        RuntimeHlaeCaptureProgram::PlayerPov(plan) => u32::try_from(plan.end_tick)
            .map_err(|_| HlaeError::InvalidPlan("player POV end tick is unsupported".to_owned()))?
            .checked_add(request.max_end_overshoot_ticks)
            .ok_or(HlaeSessionProtocolError::InvalidTickContract)?,
    };

    let RuntimeHlaeCaptureProgram::PlayerPov(plan) = &request.capture_program else {
        unreachable!("camera program returned above")
    };
    let program = compile_hlae_player_pov_capture(plan, &request.managed_job_root)?;
    let observer = CaptureObserverContract::try_new(program.player_id(), program.spectator_slot())?;
    let estimate = estimate_hlae_capture_span_resources(
        program.first_tick(),
        allowed_last_tick,
        program.tick_rate(),
        program.capture(),
    )?;
    Ok(CaptureProgramView {
        kind: "playerPov",
        demo_path: program.demo_path().to_path_buf(),
        output_directory: program.output_directory().to_path_buf(),
        seek_tick: program.seek_tick(),
        first_tick: program.first_tick(),
        last_tick: program.last_tick(),
        tick_rate: program.tick_rate(),
        capture: program.capture().clone(),
        command_system: program.command_system().clone(),
        auxiliary_artifacts: program.camera_paths().to_vec(),
        observer: Some(observer),
        persistent_pov_commands: Some(program.persistent_commands().clone()),
        maximum_staging_bytes: estimate.total_bytes,
    })
}

fn declared_capture_fields(
    request: &RuntimeHlaeSessionRequest,
) -> (&Path, &Path, &CaptureSettings) {
    match &request.capture_program {
        RuntimeHlaeCaptureProgram::Camera(plan) => {
            (&plan.demo_path, &plan.output_directory, &plan.capture)
        }
        RuntimeHlaeCaptureProgram::PlayerPov(plan) => {
            (&plan.demo_path, &plan.output_directory, &plan.capture)
        }
    }
}

fn validate_declared_capture_contract(
    request: &RuntimeHlaeSessionRequest,
) -> Result<(), RuntimeHlaeSessionError> {
    let (demo_path, output_directory, capture) = declared_capture_fields(request);
    if !demo_path.is_absolute()
        || !demo_path.is_file()
        || demo_path
            .extension()
            .and_then(|extension| extension.to_str())
            .is_none_or(|extension| !extension.eq_ignore_ascii_case("dem"))
    {
        return Err(HlaeError::InvalidPlan(
            "managed capture demo must be an existing absolute .dem file".to_owned(),
        )
        .into());
    }
    if output_directory != request.managed_job_root.join("capture") {
        return Err(HlaeError::InvalidPlan(
            "capture output must be the fixed capture child of the managed job".to_owned(),
        )
        .into());
    }
    if capture.width != request.launch_inputs.resolution.width
        || capture.height != request.launch_inputs.resolution.height
    {
        return Err(HlaeError::InvalidPlan(
            "capture dimensions must match the managed CS2 launch resolution".to_owned(),
        )
        .into());
    }
    if !capture.layers.screen || capture.layers.world || capture.layers.depth {
        return Err(HlaeError::InvalidPlan(
            "the native managed session currently requires a screen-only capture".to_owned(),
        )
        .into());
    }
    Ok(())
}

fn claim_managed_job(request: &RuntimeHlaeSessionRequest) -> Result<(), RuntimeHlaeSessionError> {
    if request.cancellation.is_cancelled() {
        return Err(PlatformError::Cancelled { process_id: None }.into());
    }
    fs::create_dir(&request.managed_job_root).map_err(|source| RuntimeHlaeSessionError::Io {
        operation: "claiming managed job directory at",
        path: request.managed_job_root.clone(),
        source,
    })?;
    let capture_directory = request.managed_job_root.join("capture");
    if let Err(source) = fs::create_dir(&capture_directory) {
        let _ = fs::remove_dir(&request.managed_job_root);
        return Err(RuntimeHlaeSessionError::Io {
            operation: "creating capture directory at",
            path: capture_directory,
            source,
        });
    }
    Ok(())
}

fn validate_compiled_capture_contract(
    request: &RuntimeHlaeSessionRequest,
    program: &CaptureProgramView,
) -> Result<(), RuntimeHlaeSessionError> {
    if program.output_directory != request.managed_job_root.join("capture") {
        return Err(HlaeError::InvalidPlan(
            "compiled capture output changed after the managed job was claimed".to_owned(),
        )
        .into());
    }
    Ok(())
}

fn publish_artifacts(
    job_root: &Path,
    artifacts: &[ArtifactToPublish],
) -> Result<(), RuntimeHlaeSessionError> {
    for artifact in artifacts {
        let destination = checked_artifact_path(job_root, &artifact.relative_path)?;
        atomic_write_new(&destination, &artifact.bytes)?;
    }
    Ok(())
}

fn publish_manifest(
    job_root: &Path,
    capture_program: &'static str,
    artifacts: &[ArtifactToPublish],
) -> Result<PathBuf, RuntimeHlaeSessionError> {
    let entries = artifacts
        .iter()
        .map(|artifact| {
            Ok(RuntimeHlaeArtifactManifestEntry {
                path: artifact
                    .relative_path
                    .to_str()
                    .ok_or_else(|| {
                        HlaeError::InvalidPlan("artifact path is not Unicode".to_owned())
                    })?
                    .replace('\\', "/"),
                size: u64::try_from(artifact.bytes.len()).map_err(|_| {
                    HlaeError::InvalidPlan("artifact byte length is unsupported".to_owned())
                })?,
                sha256: hex::encode(Sha256::digest(&artifact.bytes)),
            })
        })
        .collect::<Result<Vec<_>, HlaeError>>()?;
    let manifest = RuntimeHlaeArtifactManifest {
        state: "complete".to_owned(),
        producer: "vibe-cs-runtime".to_owned(),
        capture_program: capture_program.to_owned(),
        artifacts: entries,
    };
    let mut bytes =
        serde_json::to_vec_pretty(&manifest).map_err(|error| HlaeError::ArtifactIo {
            operation: "serialize managed HLAE session manifest",
            message: error.to_string(),
        })?;
    bytes.push(b'\n');
    let path = job_root.join(RUNTIME_HLAE_SESSION_MANIFEST_FILE);
    atomic_write_new(&path, &bytes)?;
    Ok(path)
}

fn validate_published_artifacts(
    job_root: &Path,
    artifacts: &[ArtifactToPublish],
) -> Result<(), RuntimeHlaeSessionError> {
    for artifact in artifacts {
        let path = checked_artifact_path(job_root, &artifact.relative_path)?;
        let metadata =
            fs::symlink_metadata(&path).map_err(|source| RuntimeHlaeSessionError::Io {
                operation: "revalidating managed artifact at",
                path: path.clone(),
                source,
            })?;
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            return Err(HlaeError::InvalidPlan(
                "managed artifact changed to a non-regular path".to_owned(),
            )
            .into());
        }
        let actual = fs::read(&path).map_err(|source| RuntimeHlaeSessionError::Io {
            operation: "reading managed artifact at",
            path: path.clone(),
            source,
        })?;
        if actual.len() != artifact.bytes.len()
            || Sha256::digest(&actual) != Sha256::digest(&artifact.bytes)
        {
            return Err(HlaeError::InvalidPlan(
                "managed artifact changed after no-clobber publication".to_owned(),
            )
            .into());
        }
    }
    Ok(())
}

fn checked_artifact_path(
    job_root: &Path,
    relative: &Path,
) -> Result<PathBuf, RuntimeHlaeSessionError> {
    if relative.is_absolute()
        || relative
            .components()
            .any(|component| !matches!(component, std::path::Component::Normal(_)))
    {
        return Err(HlaeError::InvalidPlan(
            "managed artifact path must contain only relative normal components".to_owned(),
        )
        .into());
    }
    Ok(job_root.join(relative))
}

fn snapshot_cs2_user_config(
    source: &Path,
    destination: &Path,
) -> Result<(), RuntimeHlaeSessionError> {
    let source_metadata =
        fs::symlink_metadata(source).map_err(|source_error| RuntimeHlaeSessionError::Io {
            operation: "inspecting Steam user config snapshot source at",
            path: source.to_path_buf(),
            source: source_error,
        })?;
    let destination_metadata =
        fs::symlink_metadata(destination).map_err(|source_error| RuntimeHlaeSessionError::Io {
            operation: "inspecting managed user config snapshot destination at",
            path: destination.to_path_buf(),
            source: source_error,
        })?;
    if source_metadata.file_type().is_symlink()
        || metadata_is_reparse_point(&source_metadata)
        || !source_metadata.is_dir()
        || destination_metadata.file_type().is_symlink()
        || metadata_is_reparse_point(&destination_metadata)
        || !destination_metadata.is_dir()
    {
        return Err(HlaeError::InvalidPlan(
            "CS2 user config snapshot endpoints must be plain directories".to_owned(),
        )
        .into());
    }
    let canonical_source =
        fs::canonicalize(source).map_err(|source_error| RuntimeHlaeSessionError::Io {
            operation: "canonicalizing Steam user config snapshot source at",
            path: source.to_path_buf(),
            source: source_error,
        })?;
    let canonical_destination =
        fs::canonicalize(destination).map_err(|source_error| RuntimeHlaeSessionError::Io {
            operation: "canonicalizing managed user config snapshot destination at",
            path: destination.to_path_buf(),
            source: source_error,
        })?;
    if canonical_source == canonical_destination
        || canonical_source.starts_with(&canonical_destination)
        || canonical_destination.starts_with(&canonical_source)
    {
        return Err(HlaeError::InvalidPlan(
            "CS2 user config source and managed snapshot must be separate trees".to_owned(),
        )
        .into());
    }
    let mut entries = fs::read_dir(&canonical_source)
        .map_err(|source_error| RuntimeHlaeSessionError::Io {
            operation: "reading Steam user config snapshot directory at",
            path: canonical_source.clone(),
            source: source_error,
        })?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|source_error| RuntimeHlaeSessionError::Io {
            operation: "enumerating Steam user config snapshot directory at",
            path: canonical_source.clone(),
            source: source_error,
        })?;
    entries.sort_by_key(std::fs::DirEntry::file_name);

    let mut copied_files = 0_usize;
    let mut copied_bytes = 0_u64;
    let mut found_user_convars = false;
    for entry in entries {
        let name = entry.file_name();
        let Some(kind) = inherited_cs2_config_kind(&name) else {
            continue;
        };
        let source_path = entry.path();
        let destination_path = canonical_destination.join(&name);
        let metadata = fs::symlink_metadata(&source_path).map_err(|source_error| {
            RuntimeHlaeSessionError::Io {
                operation: "inspecting Steam user config snapshot entry at",
                path: source_path.clone(),
                source: source_error,
            }
        })?;
        if metadata.file_type().is_symlink() || metadata_is_reparse_point(&metadata) {
            return Err(HlaeError::InvalidPlan(
                "inherited CS2 setting is a linked or reparse-point entry".to_owned(),
            )
            .into());
        }
        if !metadata.is_file() {
            return Err(HlaeError::InvalidPlan(
                "inherited CS2 setting is not a regular file".to_owned(),
            )
            .into());
        }
        copied_files = copied_files.checked_add(1).ok_or_else(|| {
            HlaeError::InvalidPlan("CS2 user config file count overflowed".to_owned())
        })?;
        if copied_files > MAXIMUM_USER_CONFIG_FILES {
            return Err(HlaeError::InvalidPlan(format!(
                "CS2 user settings exceed {MAXIMUM_USER_CONFIG_FILES} files"
            ))
            .into());
        }
        if metadata.len() > MAXIMUM_USER_CONFIG_FILE_BYTES {
            return Err(HlaeError::InvalidPlan(format!(
                "CS2 user configuration contains a file larger than {MAXIMUM_USER_CONFIG_FILE_BYTES} bytes"
            ))
            .into());
        }
        copied_bytes = copied_bytes.checked_add(metadata.len()).ok_or_else(|| {
            HlaeError::InvalidPlan("CS2 user config byte count overflowed".to_owned())
        })?;
        if copied_bytes > MAXIMUM_USER_CONFIG_TOTAL_BYTES {
            return Err(HlaeError::InvalidPlan(format!(
                "CS2 user settings exceed {MAXIMUM_USER_CONFIG_TOTAL_BYTES} bytes"
            ))
            .into());
        }
        let bytes = fs::read(&source_path).map_err(|source_error| RuntimeHlaeSessionError::Io {
            operation: "reading Steam user config snapshot file at",
            path: source_path.clone(),
            source: source_error,
        })?;
        let after = fs::symlink_metadata(&source_path).map_err(|source_error| {
            RuntimeHlaeSessionError::Io {
                operation: "revalidating Steam user config snapshot file at",
                path: source_path.clone(),
                source: source_error,
            }
        })?;
        if after.file_type().is_symlink()
            || metadata_is_reparse_point(&after)
            || !after.is_file()
            || after.len() != metadata.len()
            || u64::try_from(bytes.len()).ok() != Some(metadata.len())
            || after.modified().ok() != metadata.modified().ok()
        {
            return Err(HlaeError::InvalidPlan(
                "CS2 user configuration changed while its isolated snapshot was being read"
                    .to_owned(),
            )
            .into());
        }
        atomic_write_new(&destination_path, &bytes)?;
        found_user_convars |= kind == InheritedCs2ConfigKind::UserConvars;
    }
    if !found_user_convars {
        return Err(HlaeError::InvalidPlan(
            "active Steam user configuration has no current CS2 user convar file".to_owned(),
        )
        .into());
    }
    if fs::canonicalize(source).ok().as_deref() != Some(canonical_source.as_path())
        || fs::canonicalize(destination).ok().as_deref() != Some(canonical_destination.as_path())
    {
        return Err(HlaeError::InvalidPlan(
            "CS2 user config snapshot endpoint changed during publication".to_owned(),
        )
        .into());
    }
    Ok(())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum InheritedCs2ConfigKind {
    UserConvars,
    UserKeys,
    MachineConvars,
    Video,
}

fn inherited_cs2_config_kind(name: &std::ffi::OsStr) -> Option<InheritedCs2ConfigKind> {
    let name = name.to_str()?.to_ascii_lowercase();
    let is_vcfg = Path::new(&name)
        .extension()
        .is_some_and(|extension| extension.eq_ignore_ascii_case("vcfg"));
    if is_vcfg && !name.contains("_origin") {
        if name.starts_with("cs2_user_convars_") && name.contains("_slot") {
            return Some(InheritedCs2ConfigKind::UserConvars);
        }
        if name.starts_with("cs2_user_keys_") && name.contains("_slot") {
            return Some(InheritedCs2ConfigKind::UserKeys);
        }
        if name.starts_with("cs2_machine_convars") {
            return Some(InheritedCs2ConfigKind::MachineConvars);
        }
    }
    (name == "cs2_video.txt").then_some(InheritedCs2ConfigKind::Video)
}

fn remove_user_config_snapshot(
    job_root: &Path,
    managed_config_contents: &[u8],
) -> Result<(), RuntimeHlaeSessionError> {
    let job_metadata =
        fs::symlink_metadata(job_root).map_err(|source| RuntimeHlaeSessionError::Io {
            operation: "revalidating managed job before user config cleanup at",
            path: job_root.to_path_buf(),
            source,
        })?;
    let config_directory = job_root.join("cfg");
    let config_metadata =
        fs::symlink_metadata(&config_directory).map_err(|source| RuntimeHlaeSessionError::Io {
            operation: "revalidating isolated user config before cleanup at",
            path: config_directory.clone(),
            source,
        })?;
    if job_metadata.file_type().is_symlink()
        || metadata_is_reparse_point(&job_metadata)
        || !job_metadata.is_dir()
        || config_metadata.file_type().is_symlink()
        || metadata_is_reparse_point(&config_metadata)
        || !config_metadata.is_dir()
    {
        return Err(HlaeError::InvalidPlan(
            "managed job or isolated user config changed to a linked path before cleanup"
                .to_owned(),
        )
        .into());
    }
    let canonical_job =
        fs::canonicalize(job_root).map_err(|source| RuntimeHlaeSessionError::Io {
            operation: "canonicalizing managed job before user config cleanup at",
            path: job_root.to_path_buf(),
            source,
        })?;
    let canonical_config =
        fs::canonicalize(&config_directory).map_err(|source| RuntimeHlaeSessionError::Io {
            operation: "canonicalizing isolated user config before cleanup at",
            path: config_directory.clone(),
            source,
        })?;
    if canonical_config.parent() != Some(canonical_job.as_path()) {
        return Err(HlaeError::InvalidPlan(
            "isolated user config escaped the managed job before cleanup".to_owned(),
        )
        .into());
    }
    fs::remove_dir_all(&canonical_config).map_err(|source| RuntimeHlaeSessionError::Io {
        operation: "removing isolated user config snapshot at",
        path: canonical_config.clone(),
        source,
    })?;
    fs::create_dir(&canonical_config).map_err(|source| RuntimeHlaeSessionError::Io {
        operation: "recreating sanitized managed cfg directory at",
        path: canonical_config.clone(),
        source,
    })?;
    atomic_write_new(
        &canonical_job.join(vibe_cs_hlae::HLAE_MANAGED_SESSION_CONFIG_RELATIVE_PATH),
        managed_config_contents,
    )?;
    Ok(())
}

async fn cleanup_failed_session(
    request: &RuntimeHlaeSessionRequest,
) -> Result<(), RuntimeHlaeSessionError> {
    if request.managed_job_root.exists() {
        let metadata = fs::symlink_metadata(&request.managed_job_root).map_err(|source| {
            RuntimeHlaeSessionError::Io {
                operation: "revalidating failed managed job at",
                path: request.managed_job_root.clone(),
                source,
            }
        })?;
        if metadata.file_type().is_symlink()
            || metadata_is_reparse_point(&metadata)
            || !metadata.is_dir()
        {
            return Err(HlaeError::InvalidPlan(
                "failed managed job changed to a linked or non-directory path".to_owned(),
            )
            .into());
        }
        let parent = request
            .managed_job_root
            .parent()
            .ok_or_else(|| HlaeError::InvalidPlan("managed job root lost its parent".to_owned()))?;
        let canonical_parent =
            fs::canonicalize(parent).map_err(|source| RuntimeHlaeSessionError::Io {
                operation: "canonicalizing managed job parent at",
                path: parent.to_path_buf(),
                source,
            })?;
        let canonical_job = fs::canonicalize(&request.managed_job_root).map_err(|source| {
            RuntimeHlaeSessionError::Io {
                operation: "canonicalizing failed managed job at",
                path: request.managed_job_root.clone(),
                source,
            }
        })?;
        if canonical_job.parent() != Some(canonical_parent.as_path()) {
            return Err(HlaeError::InvalidPlan(
                "failed managed job is no longer the claimed direct child".to_owned(),
            )
            .into());
        }
        for attempt in 0..=FAILED_JOB_CLEANUP_ATTEMPTS {
            match fs::remove_dir_all(&canonical_job) {
                Ok(()) => return Ok(()),
                Err(source) if source.kind() == std::io::ErrorKind::NotFound => return Ok(()),
                Err(source) if attempt < FAILED_JOB_CLEANUP_ATTEMPTS => {
                    tokio::time::sleep(FAILED_JOB_CLEANUP_RETRY_INTERVAL).await;
                    if !canonical_job.exists() {
                        return Ok(());
                    }
                    drop(source);
                }
                Err(source) => {
                    return Err(RuntimeHlaeSessionError::Io {
                        operation: "removing failed managed job at",
                        path: canonical_job,
                        source,
                    });
                }
            }
        }
    }
    Ok(())
}

fn remove_owned_output(path: &Path) -> Result<(), RuntimeHlaeSessionError> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(source) if source.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(source) => Err(RuntimeHlaeSessionError::Io {
            operation: "removing unpublished failed session output at",
            path: path.to_path_buf(),
            source,
        }),
    }
}

async fn remove_completed_encode_output(
    encode_task: &mut tokio::task::JoinHandle<
        Result<HlaeTakeMp4EncodeEvidence, HlaeTakeMp4EncodeError>,
    >,
    cancellation_grace: Duration,
    expected_output: &Path,
    expected_partial_output: &Path,
) -> Result<(), RuntimeHlaeSessionError> {
    let Ok(joined) = tokio::time::timeout(cancellation_grace, &mut *encode_task).await else {
        // `spawn_blocking` work already in flight cannot be synchronously
        // killed by Tokio. Abort detaches the join handle; the cancelled
        // encoder can only touch its job-local staging path, which the
        // session cleanup lease owns. It can never publish the final MP4.
        encode_task.abort();
        let _ = remove_owned_output(expected_output);
        let _ = remove_owned_output(expected_partial_output);
        return Err(RuntimeHlaeSessionError::CancellationTimedOut {
            phase: "finishing the native encoder",
            timeout: cancellation_grace,
        });
    };
    joined.map_err(|error| RuntimeHlaeSessionError::EncoderTask(error.to_string()))??;
    remove_owned_output(expected_output)?;
    remove_owned_output(expected_partial_output)
}

fn publish_staged_output(
    job_root: &Path,
    staged_output: &Path,
    final_output: &Path,
    cancellation: &ProcessCancellation,
) -> Result<(), RuntimeHlaeSessionError> {
    if staged_output != job_root.join(HLAE_ENCODED_OUTPUT_FILE) {
        return Err(HlaeError::InvalidPlan(
            "native encoder returned an output outside its fixed job-local staging path".to_owned(),
        )
        .into());
    }
    let job_metadata =
        fs::symlink_metadata(job_root).map_err(|source| RuntimeHlaeSessionError::Io {
            operation: "revalidating managed job before MP4 publication at",
            path: job_root.to_path_buf(),
            source,
        })?;
    let staged_metadata =
        fs::symlink_metadata(staged_output).map_err(|source| RuntimeHlaeSessionError::Io {
            operation: "revalidating staged MP4 before publication at",
            path: staged_output.to_path_buf(),
            source,
        })?;
    if job_metadata.file_type().is_symlink()
        || metadata_is_reparse_point(&job_metadata)
        || !job_metadata.is_dir()
        || staged_metadata.file_type().is_symlink()
        || metadata_is_reparse_point(&staged_metadata)
        || !staged_metadata.is_file()
    {
        return Err(HlaeError::InvalidPlan(
            "managed job and staged MP4 must remain regular non-link paths before publication"
                .to_owned(),
        )
        .into());
    }
    let canonical_job =
        fs::canonicalize(job_root).map_err(|source| RuntimeHlaeSessionError::Io {
            operation: "canonicalizing managed job before MP4 publication at",
            path: job_root.to_path_buf(),
            source,
        })?;
    let canonical_staged =
        fs::canonicalize(staged_output).map_err(|source| RuntimeHlaeSessionError::Io {
            operation: "canonicalizing staged MP4 before publication at",
            path: staged_output.to_path_buf(),
            source,
        })?;
    if canonical_staged.parent() != Some(canonical_job.as_path()) {
        return Err(HlaeError::InvalidPlan(
            "staged MP4 escaped the fixed managed job directory".to_owned(),
        )
        .into());
    }
    if cancellation.is_cancelled() {
        return Err(PlatformError::Cancelled { process_id: None }.into());
    }
    fs::hard_link(&canonical_staged, final_output).map_err(|source| {
        RuntimeHlaeSessionError::Io {
            operation: "publishing verified MP4 without clobber at",
            path: final_output.to_path_buf(),
            source,
        }
    })?;
    if cancellation.is_cancelled() {
        remove_owned_output(final_output)?;
        return Err(PlatformError::Cancelled { process_id: None }.into());
    }
    if let Err(source) = fs::remove_file(&canonical_staged) {
        let primary = RuntimeHlaeSessionError::Io {
            operation: "removing job-local MP4 after publication at",
            path: canonical_staged,
            source,
        };
        return match remove_owned_output(final_output) {
            Ok(()) => Err(primary),
            Err(cleanup) => Err(RuntimeHlaeSessionError::Cleanup {
                primary: primary.to_string(),
                cleanup: cleanup.to_string(),
            }),
        };
    }
    Ok(())
}

fn remove_successful_capture_tree(
    job_root: &Path,
    take_directory: &Path,
    published_output: &Path,
) -> Result<(), RuntimeHlaeSessionError> {
    let capture_directory = job_root.join("capture");
    for (path, label) in [
        (job_root, "managed job"),
        (capture_directory.as_path(), "capture directory"),
        (take_directory, "bound take"),
    ] {
        let metadata =
            fs::symlink_metadata(path).map_err(|source| RuntimeHlaeSessionError::Io {
                operation: "revalidating successful capture tree at",
                path: path.to_path_buf(),
                source,
            })?;
        if metadata.file_type().is_symlink()
            || metadata_is_reparse_point(&metadata)
            || !metadata.is_dir()
        {
            return Err(HlaeError::InvalidPlan(format!(
                "{label} changed to a linked or non-directory path before cleanup"
            ))
            .into());
        }
    }
    let canonical_job =
        fs::canonicalize(job_root).map_err(|source| RuntimeHlaeSessionError::Io {
            operation: "canonicalizing successful managed job at",
            path: job_root.to_path_buf(),
            source,
        })?;
    let canonical_capture =
        fs::canonicalize(&capture_directory).map_err(|source| RuntimeHlaeSessionError::Io {
            operation: "canonicalizing successful capture directory at",
            path: capture_directory.clone(),
            source,
        })?;
    let canonical_take =
        fs::canonicalize(take_directory).map_err(|source| RuntimeHlaeSessionError::Io {
            operation: "canonicalizing successful HLAE take at",
            path: take_directory.to_path_buf(),
            source,
        })?;
    let canonical_output =
        fs::canonicalize(published_output).map_err(|source| RuntimeHlaeSessionError::Io {
            operation: "canonicalizing published MP4 at",
            path: published_output.to_path_buf(),
            source,
        })?;
    if canonical_capture.parent() != Some(canonical_job.as_path())
        || canonical_take.parent() != Some(canonical_capture.as_path())
        || canonical_output.starts_with(&canonical_capture)
    {
        return Err(HlaeError::InvalidPlan(
            "successful capture cleanup escaped its fixed job/capture/take hierarchy".to_owned(),
        )
        .into());
    }

    let mut found_bound_take = false;
    for take_entry in
        fs::read_dir(&canonical_capture).map_err(|source| RuntimeHlaeSessionError::Io {
            operation: "enumerating successful capture directory at",
            path: canonical_capture.clone(),
            source,
        })?
    {
        let take_entry = take_entry.map_err(|source| RuntimeHlaeSessionError::Io {
            operation: "reading successful capture entry at",
            path: canonical_capture.clone(),
            source,
        })?;
        let take_metadata = fs::symlink_metadata(take_entry.path()).map_err(|source| {
            RuntimeHlaeSessionError::Io {
                operation: "revalidating successful capture entry at",
                path: take_entry.path(),
                source,
            }
        })?;
        if take_metadata.file_type().is_symlink()
            || metadata_is_reparse_point(&take_metadata)
            || !take_metadata.is_dir()
        {
            return Err(HlaeError::InvalidPlan(
                "successful capture contains a linked or non-directory take".to_owned(),
            )
            .into());
        }
        let canonical_entry =
            fs::canonicalize(take_entry.path()).map_err(|source| RuntimeHlaeSessionError::Io {
                operation: "canonicalizing successful capture entry at",
                path: take_entry.path(),
                source,
            })?;
        if canonical_entry.parent() != Some(canonical_capture.as_path()) {
            return Err(HlaeError::InvalidPlan(
                "successful capture take escaped its managed directory".to_owned(),
            )
            .into());
        }
        found_bound_take |= canonical_entry == canonical_take;
        for entry in
            fs::read_dir(&canonical_entry).map_err(|source| RuntimeHlaeSessionError::Io {
                operation: "enumerating successful HLAE take at",
                path: canonical_entry.clone(),
                source,
            })?
        {
            let entry = entry.map_err(|source| RuntimeHlaeSessionError::Io {
                operation: "reading successful HLAE take entry at",
                path: canonical_entry.clone(),
                source,
            })?;
            let metadata = fs::symlink_metadata(entry.path()).map_err(|source| {
                RuntimeHlaeSessionError::Io {
                    operation: "revalidating successful HLAE take entry at",
                    path: entry.path(),
                    source,
                }
            })?;
            if metadata.file_type().is_symlink()
                || metadata_is_reparse_point(&metadata)
                || !metadata.is_file()
            {
                return Err(HlaeError::InvalidPlan(
                    "successful HLAE take contains a linked or non-file entry".to_owned(),
                )
                .into());
            }
        }
    }
    if !found_bound_take {
        return Err(HlaeError::InvalidPlan(
            "successful capture directory lost its bound take".to_owned(),
        )
        .into());
    }
    fs::remove_dir_all(&canonical_capture).map_err(|source| RuntimeHlaeSessionError::Io {
        operation: "removing encoded HLAE capture tree at",
        path: canonical_capture,
        source,
    })
}

#[cfg(windows)]
fn metadata_is_reparse_point(metadata: &fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt as _;

    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
    metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
}

#[cfg(not(windows))]
fn metadata_is_reparse_point(_metadata: &fs::Metadata) -> bool {
    false
}

#[cfg(test)]
mod tests {
    use std::{
        fs,
        sync::{
            Arc, Mutex,
            atomic::{AtomicBool, AtomicUsize, Ordering},
        },
    };

    use futures_util::{SinkExt as _, StreamExt as _};
    use tokio_tungstenite::{connect_async, tungstenite::Message};
    use vibe_cs_hlae::{
        CS2_OBSERVER_MODE_IN_EYE, CameraKeyframe, CameraPosition, CameraRotation, CameraShot,
        CaptureSettings, HlaeBridgeEvent, HlaeBridgeMessage, HlaeDiscoverySource, HlaeInstallation,
        LaunchResolution, PositionInterpolation, RotationInterpolation,
    };
    use vibe_cs_platform_windows::{RationalFrameRate, atomic_write_new};

    use super::*;

    fn plan(mode: HlaePlanMode, demo: PathBuf, output_directory: PathBuf) -> HlaePlan {
        HlaePlan {
            mode,
            tick_rate: 64.0,
            demo_path: demo,
            output_directory,
            pre_roll_ticks: 2,
            capture: CaptureSettings {
                fps: 1,
                width: 320,
                height: 240,
                record_wav: false,
                ..CaptureSettings::default()
            },
            presentation: vibe_cs_hlae::HlaeScenePresentation::default(),
            shots: vec![CameraShot {
                id: "opening".to_owned(),
                start_tick: 10,
                end_tick: 13,
                position_interpolation: PositionInterpolation::Linear,
                rotation_interpolation: RotationInterpolation::SphericalLinear,
                keyframes: [10, 11, 12, 13]
                    .into_iter()
                    .map(|tick| CameraKeyframe {
                        tick,
                        position: CameraPosition {
                            x: 1.0,
                            y: 2.0,
                            z: 3.0,
                        },
                        rotation: CameraRotation {
                            pitch: 0.0,
                            yaw: 0.0,
                            roll: 0.0,
                        },
                        fov: 90.0,
                    })
                    .collect(),
            }],
        }
    }

    fn request(directory: &tempfile::TempDir, mode: HlaePlanMode) -> RuntimeHlaeSessionRequest {
        let demo = directory.path().join("major.dem");
        fs::write(&demo, b"demo").unwrap();
        let installation_root = directory.path().join("hlae");
        fs::create_dir_all(installation_root.join("x64")).unwrap();
        let hlae = installation_root.join("HLAE.exe");
        let hook = installation_root.join("x64/AfxHookSource2.dll");
        let game = directory.path().join("cs2.exe");
        let steam = directory.path().join("steam.exe");
        let user_config_directory = directory.path().join("steam-user/730/local/cfg");
        fs::create_dir_all(&user_config_directory).unwrap();
        fs::write(
            user_config_directory.join("cs2_user_convars_0_slot0.vcfg"),
            b"sensitivity=0.845927\ncl_crosshairsize=3.149234\n",
        )
        .unwrap();
        fs::write(
            user_config_directory.join("autoexec.cfg"),
            b"// user's personal autoexec\n",
        )
        .unwrap();
        fs::write(
            user_config_directory.join("cs2_user_keys_0_slot0.vcfg"),
            b"bind=MOUSE1:+attack\n",
        )
        .unwrap();
        fs::write(
            user_config_directory.join("cs2_user_convars_0_slot0_origin.vcfg"),
            b"stale migration backup",
        )
        .unwrap();
        fs::write(
            user_config_directory.join("gamestate_integration_private.cfg"),
            b"token=must-not-be-copied",
        )
        .unwrap();
        for path in [&hlae, &hook, &game, &steam] {
            fs::write(path, b"fixture").unwrap();
        }
        let managed_job_root = directory.path().join("job-001");
        RuntimeHlaeSessionRequest {
            job_id: uuid::Uuid::from_u128(1),
            take_index: 0,
            capture_program: RuntimeHlaeCaptureProgram::Camera(plan(
                mode,
                demo,
                managed_job_root.join("capture"),
            )),
            launch_inputs: HlaeBundleLaunchInputs {
                installation: HlaeInstallation {
                    root: installation_root,
                    executable: hlae,
                    source2_hook: hook,
                    source: HlaeDiscoverySource::Managed,
                },
                game_executable: game,
                steam_executable: steam,
                user_config_directory: Some(user_config_directory),
                resolution: LaunchResolution {
                    width: 320,
                    height: 240,
                },
            },
            verified_total_ticks: 20,
            managed_job_root,
            output_mp4: directory.path().join("clip.mp4"),
            target_bitrate_bps: 1_000_000,
            max_start_overshoot_ticks: 1,
            max_end_overshoot_ticks: 1,
            take_stability: HlaeTakeStabilityPolicy {
                poll_interval: Duration::from_millis(1),
                required_unchanged_polls: 2,
                timeout: Duration::from_millis(100),
            },
            timeouts: RuntimeHlaeSessionTimeouts::default(),
            cancellation: ProcessCancellation::default(),
        }
    }

    fn player_pov_request(directory: &tempfile::TempDir) -> RuntimeHlaeSessionRequest {
        let mut request = request(directory, HlaePlanMode::Capture);
        let RuntimeHlaeCaptureProgram::Camera(camera) = &request.capture_program else {
            unreachable!()
        };
        request.capture_program = RuntimeHlaeCaptureProgram::PlayerPov(HlaePlayerPovCapturePlan {
            demo_path: camera.demo_path.clone(),
            output_directory: camera.output_directory.clone(),
            player_id: "76561198000000001".to_owned(),
            spectator_slot: 2,
            start_tick: 10,
            end_tick: 13,
            pre_roll_ticks: 2,
            tick_rate: 64.0,
            capture: camera.capture.clone(),
            presentation: vibe_cs_hlae::HlaePlayerPovPresentation::default(),
        });
        request
    }

    #[tokio::test]
    async fn rejects_preview_before_creating_the_managed_job() {
        let directory = tempfile::tempdir().unwrap();
        let request = request(&directory, HlaePlanMode::Preview);
        let job = request.managed_job_root.clone();

        let error = RuntimeHlaeSessionOrchestrator::default()
            .run(request)
            .await
            .expect_err("preview cannot enter capture orchestration");

        assert!(error.to_string().contains("require capture mode"));
        assert!(!job.exists());
    }

    #[tokio::test]
    async fn rejects_a_managed_launch_without_user_config_before_creating_the_job() {
        let directory = tempfile::tempdir().unwrap();
        let mut request = request(&directory, HlaePlanMode::Capture);
        request.launch_inputs.user_config_directory = None;
        let job = request.managed_job_root.clone();

        let error = RuntimeHlaeSessionOrchestrator::default()
            .run(request)
            .await
            .expect_err("managed launch must not fall back to default CS2 settings");

        assert!(error.to_string().contains("user configuration"));
        assert!(!job.exists());
    }

    #[test]
    fn inherits_only_engine_owned_cs2_setting_files() {
        for inherited in [
            "cs2_user_convars_0_slot0.vcfg",
            "cs2_user_keys_0_slot3.vcfg",
            "cs2_machine_convars.vcfg",
            "cs2_video.txt",
        ] {
            assert!(inherited_cs2_config_kind(std::ffi::OsStr::new(inherited)).is_some());
        }
        for private_or_stale in [
            "autoexec.cfg",
            "gamestate_integration_private.cfg",
            "cs2_user_convars_0_slot0_origin.vcfg",
            "cs2_user_convars_0_slot0.vcfg_lastclouded",
        ] {
            assert!(inherited_cs2_config_kind(std::ffi::OsStr::new(private_or_stale)).is_none());
        }
    }

    #[derive(Debug)]
    struct FakeProcessLauncher {
        closed: Arc<AtomicBool>,
        loader_exit_code: Option<u32>,
    }

    #[derive(Debug)]
    struct PersistentFakeProcessLauncher {
        closed: Arc<AtomicBool>,
        launches: Arc<AtomicUsize>,
        fail_second: bool,
    }

    #[async_trait]
    impl HlaeSessionProcessLauncher for PersistentFakeProcessLauncher {
        async fn launch(
            &self,
            _invocation: &HlaeCustomLoaderInvocation,
            _expected_cs2_executable: &Path,
            _game_discovery_timeout: Duration,
            _cancellation: &ProcessCancellation,
            context: &HlaeBridgeLaunchContext,
        ) -> Result<Box<dyn HlaeSessionProcess>, PlatformError> {
            self.launches.fetch_add(1, Ordering::SeqCst);
            let context = context.clone();
            let fail_second = self.fail_second;
            tokio::spawn(async move {
                let (mut socket, _) = connect_async(&context.endpoint).await.unwrap();
                let first_take = context.capture_directory.join("take0000");
                fs::create_dir(&first_take).unwrap();
                write_test_tga(&first_take.join("00000.tga"), 320, 240);
                let mut sequence = 1_u64;
                let mut send = |event| {
                    let bytes = HlaeBridgeMessage::new(&context.token, sequence, event)
                        .encode()
                        .unwrap();
                    sequence += 1;
                    bytes
                };
                let steam_id64 = context
                    .expected_observer_steam_id64
                    .clone()
                    .expect("POV observer");
                for event in [
                    HlaeBridgeEvent::Heartbeat,
                    HlaeBridgeEvent::DemoLoaded {
                        demo_path: context.demo_path.to_string_lossy().into_owned(),
                        current_tick: context.seek_target_tick,
                        total_ticks: context.verified_total_ticks,
                    },
                    HlaeBridgeEvent::SeekRequested {
                        target_tick: context.seek_target_tick,
                    },
                    HlaeBridgeEvent::SeekCompleted {
                        current_tick: context.seek_target_tick,
                    },
                    HlaeBridgeEvent::ObserverVerified {
                        steam_id64: steam_id64.clone(),
                        observer_mode: CS2_OBSERVER_MODE_IN_EYE,
                        observed_tick: context.capture_start_tick,
                    },
                    HlaeBridgeEvent::CaptureStarted {
                        output_directory: first_take.to_string_lossy().into_owned(),
                        observed_tick: context.capture_start_tick,
                    },
                    HlaeBridgeEvent::ObserverVerified {
                        steam_id64: steam_id64.clone(),
                        observer_mode: CS2_OBSERVER_MODE_IN_EYE,
                        observed_tick: context.capture_end_tick,
                    },
                    HlaeBridgeEvent::CaptureStopped {
                        observed_tick: context.capture_end_tick,
                    },
                ] {
                    socket
                        .send(Message::Text(
                            String::from_utf8(send(event)).unwrap().into(),
                        ))
                        .await
                        .unwrap();
                }
                let advance = socket.next().await.unwrap().unwrap();
                let Message::Text(advance) = advance else {
                    panic!("advance control must be text");
                };
                let advance: serde_json::Value =
                    serde_json::from_str(advance.as_ref()).expect("advance JSON");
                assert_eq!(advance["sequence"], 1);
                assert_eq!(advance["control"]["kind"], "advance_take");
                assert_eq!(advance["control"]["takeIndex"], 1);
                if fail_second {
                    let bytes = HlaeBridgeMessage::new(
                        &context.token,
                        sequence,
                        HlaeBridgeEvent::FailureReported {
                            reason: "injected second Take failure".to_owned(),
                        },
                    )
                    .encode()
                    .unwrap();
                    socket
                        .send(Message::Text(String::from_utf8(bytes).unwrap().into()))
                        .await
                        .unwrap();
                    socket.close(None).await.unwrap();
                    return;
                }
                let second_take = context.capture_directory.join("take0001");
                fs::create_dir(&second_take).unwrap();
                write_test_tga(&second_take.join("00000.tga"), 320, 240);
                let seek_tick = advance["control"]["seekTargetTick"].as_u64().unwrap();
                let start_tick = advance["control"]["captureStartTick"].as_u64().unwrap();
                let end_tick = advance["control"]["captureEndTick"].as_u64().unwrap();
                for event in [
                    HlaeBridgeEvent::SeekRequested {
                        target_tick: u32::try_from(seek_tick).unwrap(),
                    },
                    HlaeBridgeEvent::SeekCompleted {
                        current_tick: u32::try_from(seek_tick).unwrap(),
                    },
                    HlaeBridgeEvent::ObserverVerified {
                        steam_id64: steam_id64.clone(),
                        observer_mode: CS2_OBSERVER_MODE_IN_EYE,
                        observed_tick: u32::try_from(start_tick).unwrap(),
                    },
                    HlaeBridgeEvent::CaptureStarted {
                        output_directory: second_take.to_string_lossy().into_owned(),
                        observed_tick: u32::try_from(start_tick).unwrap(),
                    },
                    HlaeBridgeEvent::ObserverVerified {
                        steam_id64: steam_id64.clone(),
                        observer_mode: CS2_OBSERVER_MODE_IN_EYE,
                        observed_tick: u32::try_from(end_tick).unwrap(),
                    },
                    HlaeBridgeEvent::CaptureStopped {
                        observed_tick: u32::try_from(end_tick).unwrap(),
                    },
                ] {
                    socket
                        .send(Message::Text(
                            String::from_utf8(send(event)).unwrap().into(),
                        ))
                        .await
                        .unwrap();
                }
                let finish = socket.next().await.unwrap().unwrap();
                let Message::Text(finish) = finish else {
                    panic!("finish control must be text");
                };
                let finish: serde_json::Value =
                    serde_json::from_str(finish.as_ref()).expect("finish JSON");
                assert_eq!(finish["sequence"], 2);
                assert_eq!(finish["control"]["kind"], "finish_session");
                socket.close(None).await.unwrap();
            });
            Ok(Box::new(FakeProcess {
                closed: Arc::clone(&self.closed),
                loader_exit_code: None,
            }))
        }
    }

    #[derive(Debug)]
    struct BridgeFailureProcessLauncher {
        closed: Arc<AtomicBool>,
        reason: &'static str,
    }

    #[derive(Debug)]
    struct FakeSteamClientReadiness {
        ready: Arc<AtomicBool>,
    }

    #[async_trait]
    impl HlaeSteamClientReadiness for FakeSteamClientReadiness {
        async fn ensure_ready(
            &self,
            _steam_executable: &Path,
            _cancellation: &ProcessCancellation,
        ) -> Result<(), PlatformError> {
            self.ready.store(true, Ordering::Release);
            Ok(())
        }
    }

    #[derive(Debug)]
    struct SteamOrderedProcessLauncher {
        ready: Arc<AtomicBool>,
        closed: Arc<AtomicBool>,
    }

    #[async_trait]
    impl HlaeSessionProcessLauncher for SteamOrderedProcessLauncher {
        async fn launch(
            &self,
            invocation: &HlaeCustomLoaderInvocation,
            expected_cs2_executable: &Path,
            game_discovery_timeout: Duration,
            cancellation: &ProcessCancellation,
            context: &HlaeBridgeLaunchContext,
        ) -> Result<Box<dyn HlaeSessionProcess>, PlatformError> {
            assert!(
                self.ready.load(Ordering::Acquire),
                "Steam readiness must complete before HLAE launch"
            );
            FakeProcessLauncher {
                closed: Arc::clone(&self.closed),
                loader_exit_code: None,
            }
            .launch(
                invocation,
                expected_cs2_executable,
                game_discovery_timeout,
                cancellation,
                context,
            )
            .await
        }
    }

    #[async_trait]
    impl HlaeSessionProcessLauncher for BridgeFailureProcessLauncher {
        async fn launch(
            &self,
            _invocation: &HlaeCustomLoaderInvocation,
            _expected_cs2_executable: &Path,
            _game_discovery_timeout: Duration,
            _cancellation: &ProcessCancellation,
            context: &HlaeBridgeLaunchContext,
        ) -> Result<Box<dyn HlaeSessionProcess>, PlatformError> {
            let context = context.clone();
            let reason = self.reason.to_owned();
            tokio::spawn(async move {
                let (mut socket, _) = connect_async(&context.endpoint).await.unwrap();
                let bytes = HlaeBridgeMessage::new(
                    &context.token,
                    1,
                    HlaeBridgeEvent::FailureReported { reason },
                )
                .encode()
                .unwrap();
                socket
                    .send(Message::Text(String::from_utf8(bytes).unwrap().into()))
                    .await
                    .unwrap();
                socket.close(None).await.unwrap();
            });
            Ok(Box::new(FakeProcess {
                closed: Arc::clone(&self.closed),
                loader_exit_code: None,
            }))
        }
    }

    #[async_trait]
    impl HlaeSessionProcessLauncher for FakeProcessLauncher {
        async fn launch(
            &self,
            invocation: &HlaeCustomLoaderInvocation,
            _expected_cs2_executable: &Path,
            _game_discovery_timeout: Duration,
            cancellation: &ProcessCancellation,
            context: &HlaeBridgeLaunchContext,
        ) -> Result<Box<dyn HlaeSessionProcess>, PlatformError> {
            let config_root = invocation
                .arguments()
                .windows(2)
                .find_map(|pair| {
                    (pair[0] == "-addEnv")
                        .then(|| pair[1].to_str())
                        .flatten()
                        .and_then(|value| value.strip_prefix("USRLOCALCSGO="))
                })
                .map(PathBuf::from)
                .expect("managed invocation config root");
            assert_eq!(
                fs::read(config_root.join("cfg/cs2_user_convars_0_slot0.vcfg")).unwrap(),
                b"sensitivity=0.845927\ncl_crosshairsize=3.149234\n"
            );
            assert_eq!(
                fs::read(config_root.join("cfg/cs2_user_keys_0_slot0.vcfg")).unwrap(),
                b"bind=MOUSE1:+attack\n"
            );
            assert!(
                !config_root
                    .join("cfg/cs2_user_convars_0_slot0_origin.vcfg")
                    .exists()
            );
            assert!(
                !config_root
                    .join("cfg/gamestate_integration_private.cfg")
                    .exists()
            );
            let managed_autoexec =
                fs::read_to_string(config_root.join("cfg/autoexec.cfg")).unwrap();
            assert!(
                managed_autoexec.starts_with(
                    "// Generated by Vibe CS for one managed, offline HLAE session.\n"
                )
            );
            assert!(!managed_autoexec.contains("user's personal autoexec"));
            fs::write(
                config_root.join("cfg/cs2_user_convars_0_slot0.vcfg"),
                b"session-only rewrite",
            )
            .unwrap();
            if self.loader_exit_code.is_none() {
                let context = context.clone();
                let cancellation = cancellation.clone();
                tokio::spawn(async move {
                    let take = context.capture_directory.join("take0000");
                    fs::create_dir(&take).unwrap();
                    write_test_tga(&take.join("00000.tga"), 320, 240);
                    let (mut socket, _) = connect_async(&context.endpoint).await.unwrap();
                    let mut events = vec![
                        HlaeBridgeEvent::Heartbeat,
                        HlaeBridgeEvent::DemoLoaded {
                            demo_path: context.demo_path.to_string_lossy().into_owned(),
                            current_tick: context.seek_target_tick,
                            total_ticks: context.verified_total_ticks,
                        },
                        HlaeBridgeEvent::SeekRequested {
                            target_tick: context.seek_target_tick,
                        },
                        HlaeBridgeEvent::SeekCompleted {
                            current_tick: context.seek_target_tick,
                        },
                    ];
                    if let Some(steam_id64) = context.expected_observer_steam_id64.clone() {
                        events.push(HlaeBridgeEvent::ObserverVerified {
                            steam_id64,
                            observer_mode: CS2_OBSERVER_MODE_IN_EYE,
                            observed_tick: context.capture_start_tick,
                        });
                    }
                    events.push(HlaeBridgeEvent::CaptureStarted {
                        output_directory: take.to_string_lossy().into_owned(),
                        observed_tick: context.capture_start_tick,
                    });
                    if let Some(steam_id64) = context.expected_observer_steam_id64.clone() {
                        events.push(HlaeBridgeEvent::ObserverVerified {
                            steam_id64,
                            observer_mode: CS2_OBSERVER_MODE_IN_EYE,
                            observed_tick: context.capture_end_tick,
                        });
                    }
                    events.push(HlaeBridgeEvent::CaptureStopped {
                        observed_tick: context.capture_end_tick,
                    });
                    for (index, event) in events.into_iter().enumerate() {
                        let bytes = HlaeBridgeMessage::new(
                            &context.token,
                            u64::try_from(index).unwrap() + 1,
                            event,
                        )
                        .encode()
                        .unwrap();
                        socket
                            .send(Message::Text(String::from_utf8(bytes).unwrap().into()))
                            .await
                            .unwrap();
                    }
                    let control = tokio::select! {
                        control = socket.next() => control,
                        () = cancellation.cancelled() => return,
                    }
                    .expect("finish control")
                    .expect("valid finish control");
                    let Message::Text(control) = control else {
                        panic!("finish control must be text");
                    };
                    let control: serde_json::Value =
                        serde_json::from_str(control.as_ref()).expect("finish control JSON");
                    assert_eq!(control["sequence"], 1);
                    assert_eq!(control["control"]["kind"], "finish_session");
                    socket.close(None).await.unwrap();
                });
            }
            Ok(Box::new(FakeProcess {
                closed: Arc::clone(&self.closed),
                loader_exit_code: self.loader_exit_code,
            }))
        }
    }

    #[derive(Debug)]
    struct FakeProcess {
        closed: Arc<AtomicBool>,
        loader_exit_code: Option<u32>,
    }

    #[async_trait]
    impl HlaeSessionProcess for FakeProcess {
        fn loader_process_id(&self) -> u32 {
            41
        }

        fn game_process_id(&self) -> u32 {
            std::process::id()
        }

        async fn wait_loader(
            &self,
            _cancellation: &ProcessCancellation,
        ) -> Result<vibe_cs_platform_windows::ProcessTreeExit, PlatformError> {
            if let Some(exit_code) = self.loader_exit_code {
                return Ok(vibe_cs_platform_windows::ProcessTreeExit {
                    primary_process_id: 41,
                    exit_code,
                });
            }
            futures_util::future::pending().await
        }

        fn close(self: Box<Self>) -> Result<(), PlatformError> {
            self.closed.store(true, Ordering::Release);
            Ok(())
        }
    }

    #[derive(Debug, Default)]
    struct FakeEncoder {
        request: Mutex<Option<HlaeTakeMp4EncodeRequest>>,
    }

    impl HlaeSessionEncoder for FakeEncoder {
        fn encode(
            &self,
            request: &HlaeTakeMp4EncodeRequest,
            _cancellation: &ProcessCancellation,
        ) -> Result<HlaeTakeMp4EncodeEvidence, HlaeTakeMp4EncodeError> {
            *self.request.lock().unwrap() = Some(request.clone());
            atomic_write_new(&request.output_path, b"verified fake MP4")?;
            Ok(HlaeTakeMp4EncodeEvidence {
                summary: NativeMp4VideoSummary {
                    output_path: request.output_path.clone(),
                    output_bytes: 17,
                    frame_count: 1,
                    video_duration_100ns: 10_000_000,
                    audio_stream_included: false,
                },
                inspection: NativeMp4VideoInspection {
                    video_subtype_is_h264: true,
                    audio_stream_is_aac: false,
                    width: request.width,
                    height: request.height,
                    frame_rate: RationalFrameRate {
                        numerator: request.fps,
                        denominator: 1,
                    },
                    sample_count: 1,
                    audio_sample_count: 0,
                    first_presentation_time_100ns: 0,
                    last_presentation_time_100ns: 0,
                    video_duration_100ns: 10_000_000,
                    audio_duration_100ns: 0,
                    timestamps_are_monotonic: true,
                    audio_timestamps_are_monotonic: true,
                },
            })
        }
    }

    #[derive(Debug)]
    struct CancellationIgnoringEncoder {
        started: Arc<AtomicBool>,
        delay: Duration,
    }

    impl HlaeSessionEncoder for CancellationIgnoringEncoder {
        fn encode(
            &self,
            request: &HlaeTakeMp4EncodeRequest,
            _cancellation: &ProcessCancellation,
        ) -> Result<HlaeTakeMp4EncodeEvidence, HlaeTakeMp4EncodeError> {
            self.started.store(true, Ordering::Release);
            std::thread::sleep(self.delay);
            atomic_write_new(&request.output_path, b"late fake MP4")?;
            Ok(HlaeTakeMp4EncodeEvidence {
                summary: NativeMp4VideoSummary {
                    output_path: request.output_path.clone(),
                    output_bytes: 13,
                    frame_count: 1,
                    video_duration_100ns: 10_000_000,
                    audio_stream_included: false,
                },
                inspection: NativeMp4VideoInspection {
                    video_subtype_is_h264: true,
                    audio_stream_is_aac: false,
                    width: request.width,
                    height: request.height,
                    frame_rate: RationalFrameRate {
                        numerator: request.fps,
                        denominator: 1,
                    },
                    sample_count: 1,
                    audio_sample_count: 0,
                    first_presentation_time_100ns: 0,
                    last_presentation_time_100ns: 0,
                    video_duration_100ns: 10_000_000,
                    audio_duration_100ns: 0,
                    timestamps_are_monotonic: true,
                    audio_timestamps_are_monotonic: true,
                },
            })
        }
    }

    #[derive(Debug, Default)]
    struct FakeDiskPreflight;

    impl HlaeSessionDiskPreflight for FakeDiskPreflight {
        fn preflight(
            &self,
            _staging_directory: &Path,
            staging_bytes: u64,
        ) -> Result<HlaeDiskSpaceEvidence, HlaeDiskSpacePreflightError> {
            Ok(HlaeDiskSpaceEvidence {
                available_bytes: staging_bytes + 2_000_000_000,
                required_bytes: staging_bytes + 1_000_000_000,
                staging_bytes,
                safety_reserve_bytes: 1_000_000_000,
            })
        }
    }

    fn write_test_tga(path: &Path, width: u16, height: u16) {
        let mut bytes = vec![0_u8; 18];
        bytes[2] = 2;
        bytes[12..14].copy_from_slice(&width.to_le_bytes());
        bytes[14..16].copy_from_slice(&height.to_le_bytes());
        bytes[16] = 24;
        bytes[17] = 0x20;
        bytes.resize(18 + usize::from(width) * usize::from(height) * 3, 0x40);
        fs::write(path, bytes).unwrap();
    }

    #[tokio::test]
    async fn authenticated_capture_finalizes_a_stable_take_and_publishes_once() {
        let directory = tempfile::tempdir().unwrap();
        let request = request(&directory, HlaePlanMode::Capture);
        let output = request.output_mp4.clone();
        let job = request.managed_job_root.clone();
        let user_config_directory = request
            .launch_inputs
            .user_config_directory
            .clone()
            .expect("fixture user config");
        let source_convars =
            fs::read(user_config_directory.join("cs2_user_convars_0_slot0.vcfg")).unwrap();
        let source_autoexec = fs::read(user_config_directory.join("autoexec.cfg")).unwrap();
        let closed = Arc::new(AtomicBool::new(false));
        let encoder = Arc::new(FakeEncoder::default());
        let orchestrator = RuntimeHlaeSessionOrchestrator::with_backends(
            Arc::new(FakeProcessLauncher {
                closed: Arc::clone(&closed),
                loader_exit_code: None,
            }),
            encoder.clone(),
            Arc::new(FakeDiskPreflight),
        );

        let evidence = orchestrator.run(request).await.unwrap();

        assert!(closed.load(Ordering::Acquire));
        assert_eq!(evidence.loader_process_id, 41);
        assert_eq!(evidence.game_process_id, std::process::id());
        assert_eq!(evidence.mp4_summary.output_path, output);
        assert_eq!(evidence.observed_capture_span.start_tick(), 10);
        assert_eq!(evidence.observed_capture_span.end_tick(), 13);
        assert_eq!(evidence.frame_count_bounds.minimum, 1);
        assert_eq!(evidence.frame_count_bounds.maximum, 3);
        assert_eq!(fs::read(output).unwrap(), b"verified fake MP4");
        assert!(
            !job.join(HLAE_ENCODED_OUTPUT_FILE).exists(),
            "job-local staging MP4 must be consumed by no-clobber publication"
        );
        assert!(job.join(RUNTIME_HLAE_SESSION_MANIFEST_FILE).is_file());
        assert!(job.join("vibe_cs_commands.xml").is_file());
        assert!(job.join("vibe_cs_bridge.js").is_file());
        assert!(!job.join("cfg/cs2_user_convars_0_slot0.vcfg").exists());
        assert!(!job.join("cfg/cs2_user_keys_0_slot0.vcfg").exists());
        assert!(job.join("cfg/autoexec.cfg").is_file());
        assert_eq!(
            fs::read(user_config_directory.join("cs2_user_convars_0_slot0.vcfg")).unwrap(),
            source_convars,
            "managed CS2 must never write through to the user's Steam configuration"
        );
        assert_eq!(
            fs::read(user_config_directory.join("autoexec.cfg")).unwrap(),
            source_autoexec,
            "managed startup must not replace the user's autoexec"
        );
        assert!(
            !job.join("capture").exists(),
            "verified source frames must not be retained by default"
        );
        let encode_request = encoder.request.lock().unwrap().clone().unwrap();
        assert_eq!(encode_request.minimum_frames, 1);
        assert_eq!(encode_request.maximum_frames, 3);
    }

    #[tokio::test]
    async fn steam_client_is_ready_before_hlae_launch() {
        let directory = tempfile::tempdir().unwrap();
        let request = request(&directory, HlaePlanMode::Capture);
        let steam_ready = Arc::new(AtomicBool::new(false));
        let closed = Arc::new(AtomicBool::new(false));
        let orchestrator = RuntimeHlaeSessionOrchestrator::with_all_backends(
            Arc::new(SteamOrderedProcessLauncher {
                ready: Arc::clone(&steam_ready),
                closed: Arc::clone(&closed),
            }),
            Arc::new(FakeEncoder::default()),
            Arc::new(FakeDiskPreflight),
            Arc::new(FakeSteamClientReadiness {
                ready: Arc::clone(&steam_ready),
            }),
        );

        orchestrator.run(request).await.expect("managed capture");

        assert!(steam_ready.load(Ordering::Acquire));
        assert!(closed.load(Ordering::Acquire));
    }

    #[tokio::test]
    async fn managed_capture_reports_verified_pipeline_stages_in_order() {
        let directory = tempfile::tempdir().unwrap();
        let request = request(&directory, HlaePlanMode::Capture);
        let closed = Arc::new(AtomicBool::new(false));
        let orchestrator = RuntimeHlaeSessionOrchestrator::with_backends(
            Arc::new(FakeProcessLauncher {
                closed,
                loader_exit_code: None,
            }),
            Arc::new(FakeEncoder::default()),
            Arc::new(FakeDiskPreflight),
        );
        let (progress, mut updates) = crate::recording_progress::recording_progress_channel();

        let capture = orchestrator.run_with_progress(request, progress);
        let collect = async move {
            let mut stages = Vec::new();
            while let Some(stage) = updates.recv().await {
                stages.push(stage);
            }
            stages
        };
        let (result, stages) = tokio::join!(capture, collect);

        result.expect("managed capture");
        assert_eq!(
            stages,
            vec![
                crate::recording_progress::RecordingStage::Launching,
                crate::recording_progress::RecordingStage::Seeking,
                crate::recording_progress::RecordingStage::Capturing,
                crate::recording_progress::RecordingStage::Stabilizing,
                crate::recording_progress::RecordingStage::Encoding,
            ]
        );
    }

    #[tokio::test]
    async fn cancellation_has_a_bounded_encoder_shutdown_and_never_publishes_the_mp4() {
        let directory = tempfile::tempdir().unwrap();
        let mut request = request(&directory, HlaePlanMode::Capture);
        request.timeouts.cancellation_grace = Duration::from_millis(20);
        let cancellation = request.cancellation.clone();
        let output = request.output_mp4.clone();
        let job = request.managed_job_root.clone();
        let closed = Arc::new(AtomicBool::new(false));
        let encoder_started = Arc::new(AtomicBool::new(false));
        let orchestrator = RuntimeHlaeSessionOrchestrator::with_backends(
            Arc::new(FakeProcessLauncher {
                closed: Arc::clone(&closed),
                loader_exit_code: None,
            }),
            Arc::new(CancellationIgnoringEncoder {
                started: Arc::clone(&encoder_started),
                delay: Duration::from_millis(500),
            }),
            Arc::new(FakeDiskPreflight),
        );
        let running = tokio::spawn(async move { orchestrator.run(request).await });
        tokio::time::timeout(Duration::from_secs(2), async {
            while !encoder_started.load(Ordering::Acquire) {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("fake encoder should start");

        let cancelled_at = tokio::time::Instant::now();
        cancellation.cancel();
        let error = tokio::time::timeout(Duration::from_millis(250), running)
            .await
            .expect("cancellation must settle inside its grace bound")
            .expect("orchestrator task")
            .expect_err("cancelled encode cannot publish a clip");

        assert!(matches!(
            error,
            RuntimeHlaeSessionError::CancellationTimedOut {
                phase: "finishing the native encoder",
                ..
            }
        ));
        assert!(cancelled_at.elapsed() < Duration::from_millis(250));
        assert!(closed.load(Ordering::Acquire));
        assert!(!output.exists(), "cancelled output must not be published");
        tokio::time::sleep(Duration::from_millis(550)).await;
        assert!(
            !output.exists(),
            "late encoder completion must remain isolated"
        );
        assert!(
            !job.join(HLAE_ENCODED_OUTPUT_FILE).exists(),
            "late encoder completion must not retain a staged MP4"
        );
        assert!(
            !job.join(HLAE_PARTIAL_OUTPUT_FILE).exists(),
            "late encoder completion must not retain a partial MP4"
        );
    }

    #[tokio::test]
    async fn timeout_policy_rejects_an_unbounded_cancellation_grace_before_claiming_the_job() {
        for cancellation_grace in [Duration::ZERO, Duration::from_secs(61)] {
            let directory = tempfile::tempdir().unwrap();
            let mut request = request(&directory, HlaePlanMode::Capture);
            let job = request.managed_job_root.clone();
            request.timeouts.cancellation_grace = cancellation_grace;

            let error = RuntimeHlaeSessionOrchestrator::default()
                .run(request)
                .await
                .expect_err("cancellation grace must remain bounded");

            assert!(error.to_string().contains("bounded ranges"));
            assert!(!job.exists());
        }
    }

    #[tokio::test]
    async fn nonzero_loader_exit_fails_immediately_and_closes_the_whole_job() {
        let directory = tempfile::tempdir().unwrap();
        let request = request(&directory, HlaePlanMode::Capture);
        let output = request.output_mp4.clone();
        let job = request.managed_job_root.clone();
        let closed = Arc::new(AtomicBool::new(false));
        let orchestrator = RuntimeHlaeSessionOrchestrator::with_backends(
            Arc::new(FakeProcessLauncher {
                closed: Arc::clone(&closed),
                loader_exit_code: Some(7),
            }),
            Arc::new(FakeEncoder::default()),
            Arc::new(FakeDiskPreflight),
        );

        let error = orchestrator
            .run(request)
            .await
            .expect_err("a nonzero custom-loader exit must fail closed");

        assert!(matches!(
            error,
            RuntimeHlaeSessionError::LoaderExited { exit_code: 7 }
        ));
        assert!(closed.load(Ordering::Acquire));
        assert!(!job.exists());
        assert!(!output.exists());
    }

    #[tokio::test]
    async fn authenticated_bridge_failure_keeps_its_actionable_reason() {
        let directory = tempfile::tempdir().unwrap();
        let request = request(&directory, HlaePlanMode::Capture);
        let closed = Arc::new(AtomicBool::new(false));
        let orchestrator = RuntimeHlaeSessionOrchestrator::with_backends(
            Arc::new(BridgeFailureProcessLauncher {
                closed: Arc::clone(&closed),
                reason: "demo playback crossed a transient round boundary",
            }),
            Arc::new(FakeEncoder::default()),
            Arc::new(FakeDiskPreflight),
        );

        let error = orchestrator
            .run(request)
            .await
            .expect_err("authenticated bridge failure must stop capture");

        assert!(closed.load(Ordering::Acquire));
        assert!(
            error
                .to_string()
                .contains("demo playback crossed a transient round boundary")
        );
    }

    #[tokio::test]
    async fn public_player_pov_request_is_compiled_only_after_the_job_is_claimed() {
        let directory = tempfile::tempdir().unwrap();
        let request = player_pov_request(&directory);
        let job = request.managed_job_root.clone();
        assert!(!job.exists(), "callers must not pre-create the managed job");
        let closed = Arc::new(AtomicBool::new(false));
        let orchestrator = RuntimeHlaeSessionOrchestrator::with_backends(
            Arc::new(FakeProcessLauncher {
                closed: Arc::clone(&closed),
                loader_exit_code: None,
            }),
            Arc::new(FakeEncoder::default()),
            Arc::new(FakeDiskPreflight),
        );

        let evidence = orchestrator.run(request).await.unwrap();

        assert!(closed.load(Ordering::Acquire));
        let observer = evidence
            .observer_evidence
            .expect("player POV must retain independent observer evidence");
        assert_eq!(observer.steam_id64(), 76_561_198_000_000_001);
        assert_eq!(observer.observer_mode(), CS2_OBSERVER_MODE_IN_EYE);
        assert_eq!(observer.verified_before_capture_tick(), 10);
        assert_eq!(observer.verified_at_capture_stop_tick(), Some(13));
        let command = fs::read_to_string(job.join("vibe_cs_commands.xml")).unwrap();
        assert!(command.contains("spec_mode 2; spec_player 2"));
        assert!(!command.contains("mirv_campath load"));
        let manifest = fs::read_to_string(job.join(RUNTIME_HLAE_SESSION_MANIFEST_FILE)).unwrap();
        assert!(manifest.contains("\"captureProgram\": \"playerPov\""));
        let current: serde_json::Value = serde_json::from_str(&manifest).unwrap();
        let mut invalid = current;
        invalid
            .as_object_mut()
            .unwrap()
            .insert("unexpected".to_owned(), serde_json::json!(true));
        assert!(serde_json::from_value::<RuntimeHlaeArtifactManifest>(invalid).is_err());
        assert!(!job.join("capture").exists());
    }

    #[tokio::test]
    async fn persistent_pov_session_keeps_one_process_until_typed_finish() {
        let directory = tempfile::tempdir().unwrap();
        let request = player_pov_request(&directory);
        let job = request.managed_job_root.clone();
        let output = request.output_mp4.clone();
        let closed = Arc::new(AtomicBool::new(false));
        let orchestrator = RuntimeHlaeSessionOrchestrator::with_backends(
            Arc::new(FakeProcessLauncher {
                closed: Arc::clone(&closed),
                loader_exit_code: None,
            }),
            Arc::new(FakeEncoder::default()),
            Arc::new(FakeDiskPreflight),
        );
        let (progress, receiver) = recording_progress_channel();
        drop(receiver);

        let (session, evidence) = orchestrator
            .begin_persistent_with_progress(request, progress)
            .await
            .expect("first persistent Take");

        assert!(!closed.load(Ordering::Acquire));
        assert_eq!(evidence.mp4_summary.output_path, output);
        assert!(output.is_file());
        assert!(job.join("capture/take0000").is_dir());
        assert!(job.join("cfg/cs2_user_convars_0_slot0.vcfg").is_file());

        orchestrator
            .finish_persistent(session)
            .await
            .expect("typed finish");

        assert!(closed.load(Ordering::Acquire));
        assert!(!job.join("capture").exists());
        assert!(!job.join("cfg/cs2_user_convars_0_slot0.vcfg").exists());
    }

    #[tokio::test]
    async fn persistent_pov_session_records_two_takes_with_one_process() {
        let directory = tempfile::tempdir().unwrap();
        let first = player_pov_request(&directory);
        let mut second = first.clone();
        second.take_index = 1;
        second.output_mp4 = directory.path().join("clip-2.mp4");
        let RuntimeHlaeCaptureProgram::PlayerPov(plan) = &mut second.capture_program else {
            unreachable!()
        };
        plan.start_tick = 14;
        plan.end_tick = 17;
        let first_output = first.output_mp4.clone();
        let second_output = second.output_mp4.clone();
        let closed = Arc::new(AtomicBool::new(false));
        let launches = Arc::new(AtomicUsize::new(0));
        let orchestrator = RuntimeHlaeSessionOrchestrator::with_backends(
            Arc::new(PersistentFakeProcessLauncher {
                closed: Arc::clone(&closed),
                launches: Arc::clone(&launches),
                fail_second: false,
            }),
            Arc::new(FakeEncoder::default()),
            Arc::new(FakeDiskPreflight),
        );
        let (first_progress, first_receiver) = recording_progress_channel();
        drop(first_receiver);
        let (mut session, first_evidence) = orchestrator
            .begin_persistent_with_progress(first, first_progress)
            .await
            .expect("first Take");
        let (second_progress, second_receiver) = recording_progress_channel();
        drop(second_receiver);

        let second_evidence = orchestrator
            .capture_next_persistent_with_progress(&mut session, second, second_progress)
            .await
            .expect("second Take");

        assert_eq!(launches.load(Ordering::SeqCst), 1);
        assert!(!closed.load(Ordering::Acquire));
        assert_eq!(
            first_evidence.loader_process_id,
            second_evidence.loader_process_id
        );
        assert_eq!(
            first_evidence.game_process_id,
            second_evidence.game_process_id
        );
        assert_eq!(fs::read(&first_output).unwrap(), b"verified fake MP4");
        assert_eq!(fs::read(&second_output).unwrap(), b"verified fake MP4");

        orchestrator
            .finish_persistent(session)
            .await
            .expect("finish shared session");

        assert!(closed.load(Ordering::Acquire));
        assert!(!directory.path().join("job-001/capture").exists());
    }

    #[tokio::test]
    async fn persistent_second_take_failure_keeps_published_prefix_and_cleans_session() {
        let directory = tempfile::tempdir().unwrap();
        let first = player_pov_request(&directory);
        let mut second = first.clone();
        second.take_index = 1;
        second.output_mp4 = directory.path().join("clip-2.mp4");
        let RuntimeHlaeCaptureProgram::PlayerPov(plan) = &mut second.capture_program else {
            unreachable!()
        };
        plan.start_tick = 14;
        plan.end_tick = 17;
        let first_output = first.output_mp4.clone();
        let second_output = second.output_mp4.clone();
        let closed = Arc::new(AtomicBool::new(false));
        let launches = Arc::new(AtomicUsize::new(0));
        let orchestrator = RuntimeHlaeSessionOrchestrator::with_backends(
            Arc::new(PersistentFakeProcessLauncher {
                closed: Arc::clone(&closed),
                launches,
                fail_second: true,
            }),
            Arc::new(FakeEncoder::default()),
            Arc::new(FakeDiskPreflight),
        );
        let (first_progress, first_receiver) = recording_progress_channel();
        drop(first_receiver);
        let (mut session, _) = orchestrator
            .begin_persistent_with_progress(first, first_progress)
            .await
            .expect("first Take");
        let (second_progress, second_receiver) = recording_progress_channel();
        drop(second_receiver);

        let error = orchestrator
            .capture_next_persistent_with_progress(&mut session, second, second_progress)
            .await
            .expect_err("second Take must fail");
        assert!(error.to_string().contains("injected second Take failure"));

        orchestrator
            .abort_persistent(session)
            .expect("abort shared session");
        assert!(closed.load(Ordering::Acquire));
        assert_eq!(fs::read(&first_output).unwrap(), b"verified fake MP4");
        assert!(!second_output.exists());
        assert!(!directory.path().join("job-001/capture").exists());
    }

    #[tokio::test]
    async fn preexisting_output_is_never_deleted_when_the_request_fails() {
        let directory = tempfile::tempdir().unwrap();
        let request = request(&directory, HlaePlanMode::Capture);
        fs::write(&request.output_mp4, b"owned by another task").unwrap();
        let job = request.managed_job_root.clone();
        let output = request.output_mp4.clone();

        RuntimeHlaeSessionOrchestrator::default()
            .run(request)
            .await
            .expect_err("no-clobber validation must fail before claiming the job");

        assert_eq!(fs::read(output).unwrap(), b"owned by another task");
        assert!(!job.exists());
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn failed_session_cleanup_waits_for_a_late_audio_handle_release() {
        use std::os::windows::fs::OpenOptionsExt as _;

        let directory = tempfile::tempdir().unwrap();
        let request = request(&directory, HlaePlanMode::Capture);
        let audio = request
            .managed_job_root
            .join("capture")
            .join("take0000")
            .join("audio.wav");
        fs::create_dir_all(audio.parent().unwrap()).unwrap();
        fs::write(&audio, b"wav").unwrap();
        let locked = fs::OpenOptions::new()
            .read(true)
            .share_mode(0)
            .open(&audio)
            .unwrap();
        let release = tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(150)).await;
            drop(locked);
        });

        cleanup_failed_session(&request)
            .await
            .expect("bounded cleanup retry");
        release.await.unwrap();

        assert!(!request.managed_job_root.exists());
    }
}
