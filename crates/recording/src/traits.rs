use std::{
    path::{Path, PathBuf},
    time::Duration,
};

use async_trait::async_trait;
use vibe_cs_platform_windows::{
    BackupManager, ConsoleCommand, ProcessCancellation, ProcessInfo, RecoveryStatus,
};

use crate::{LaunchPolicy, PlaybackSnapshot, RecordingError, RecordingResult};

#[async_trait]
pub trait GameController: Send + Sync {
    /// Discovers running CS2 processes without changing system state.
    ///
    /// # Errors
    ///
    /// Returns an error when process enumeration fails.
    fn discover_cs2(&self) -> RecordingResult<Vec<ProcessInfo>>;

    /// Launches CS2 directly and confirms the returned PID is discoverable.
    ///
    /// # Errors
    ///
    /// Returns an error for launch failure, cancellation, or timeout.
    async fn launch_cs2(
        &self,
        executable: &Path,
        policy: LaunchPolicy,
        timeout: Duration,
        cancellation: &ProcessCancellation,
    ) -> RecordingResult<u32>;

    /// Sends one typed console command after foreground validation.
    ///
    /// # Errors
    ///
    /// Returns an error if the PID/window changed or input delivery fails.
    fn send_command(&self, process_id: u32, command: &ConsoleCommand) -> RecordingResult<()>;
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CaptureStatus {
    pub active: bool,
    pub paused: bool,
    pub timecode: Option<String>,
    pub artifact_path: Option<PathBuf>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CaptureArtifact {
    pub path: PathBuf,
}

#[async_trait]
pub trait CaptureRecorder: Send {
    /// Queries whether the capture backend is currently active.
    ///
    /// # Errors
    ///
    /// Returns a capture-backend or protocol error.
    async fn capture_status(&mut self) -> RecordingResult<CaptureStatus>;

    /// Requests capture start.
    ///
    /// # Errors
    ///
    /// Returns a capture-backend or protocol error.
    async fn start_capture(&mut self) -> RecordingResult<()>;

    /// Stops capture and returns its output artifact, when reported.
    ///
    /// # Errors
    ///
    /// Returns a capture-backend or protocol error.
    async fn stop_capture(&mut self) -> RecordingResult<Option<CaptureArtifact>>;
}

#[async_trait]
pub trait PlaybackSynchronizer: Send + Sync {
    /// Confirms that the requested demo, rather than an arbitrary game, is ready.
    async fn confirm_demo_ready(
        &self,
        demo_path: &Path,
        timeout: Duration,
        cancellation: &ProcessCancellation,
    ) -> RecordingResult<()>;

    /// Confirms that playback reached the requested seek tick.
    async fn confirm_tick(
        &self,
        tick: u64,
        timeout: Duration,
        cancellation: &ProcessCancellation,
    ) -> RecordingResult<()>;

    /// Confirms that the intended observer target is active.
    async fn confirm_observer(
        &self,
        player_id: &str,
        timeout: Duration,
        cancellation: &ProcessCancellation,
    ) -> RecordingResult<()>;

    /// Waits for playback to reach the end of a segment.
    async fn wait_until_tick(
        &self,
        tick: u64,
        tick_rate: f64,
        timeout: Duration,
        cancellation: &ProcessCancellation,
    ) -> RecordingResult<()>;
}

#[async_trait]
pub trait PlaybackSnapshotSource: Send + Sync {
    /// Returns the latest evidence-bearing playback snapshot.
    ///
    /// Implementations must keep `sequence` unchanged between source
    /// heartbeats and may set `ready` only for a fresh, active CS2 heartbeat.
    ///
    /// # Errors
    ///
    /// Returns an error when the snapshot source is unavailable.
    async fn snapshot(&self) -> RecordingResult<Option<PlaybackSnapshot>>;
}

pub trait RecoveryGate: Send + Sync {
    /// Returns the current configuration recovery state.
    ///
    /// # Errors
    ///
    /// Returns an error if the durable journal cannot be validated.
    fn recovery_status(&self) -> RecordingResult<RecoveryStatus>;
}

impl RecoveryGate for BackupManager {
    fn recovery_status(&self) -> RecordingResult<RecoveryStatus> {
        self.status().map_err(RecordingError::from)
    }
}
