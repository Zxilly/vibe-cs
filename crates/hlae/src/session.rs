//! Authenticated protocol boundary for one managed HLAE capture session.
//!
//! Host lifecycle facts never cross the `mirv-script` WebSocket. The bridge
//! has its own small event vocabulary and an independent sequence space that
//! always starts at one.

use std::{
    collections::VecDeque,
    fmt, fs,
    path::{Path, PathBuf},
};

use serde::{Deserialize, Serialize};
use thiserror::Error;

pub const HLAE_SESSION_MIN_TOKEN_BYTES: usize = 16;
pub const HLAE_SESSION_MAX_TOKEN_BYTES: usize = 64;
pub const HLAE_SESSION_MAX_MESSAGE_BYTES: usize = 16 * 1_024;
pub const HLAE_SESSION_MAX_MESSAGES_PER_SECOND: usize = 120;
/// Maximum number of takes in one authenticated managed session.
pub const HLAE_SESSION_MAX_TAKES: u32 = 64;
pub const HLAE_SESSION_RATE_WINDOW_MS: u64 = 1_000;
pub const HLAE_SESSION_MAX_PATH_BYTES: usize = 1_024;
pub const HLAE_SESSION_MAX_TICK: u32 = i32::MAX as u32;
pub const HLAE_SESSION_MAX_FAILURE_REASON_BYTES: usize = 512;
/// `ObserverMode_t::OBS_MODE_IN_EYE` from the CS2 client schema. The managed
/// bridge reads this raw value through HLAE's `getObserverMode()` API.
pub const CS2_OBSERVER_MODE_IN_EYE: u8 = 2;

#[derive(Clone, PartialEq, Eq)]
pub struct SessionToken(Box<[u8]>);

impl SessionToken {
    /// Creates a fresh 256-bit token from the operating-system CSPRNG.
    ///
    /// # Errors
    ///
    /// Returns an error when the operating system cannot provide secure
    /// randomness.
    pub fn generate() -> Result<Self, HlaeSessionProtocolError> {
        let mut bytes = [0_u8; 32];
        getrandom::fill(&mut bytes).map_err(HlaeSessionProtocolError::TokenGeneration)?;
        Self::try_from_bytes(&bytes)
    }

    /// Constructs a token from opaque trusted bytes.
    ///
    /// # Errors
    ///
    /// Returns an error when the byte length is outside protocol bounds.
    pub fn try_from_bytes(bytes: &[u8]) -> Result<Self, HlaeSessionProtocolError> {
        if bytes.len() < HLAE_SESSION_MIN_TOKEN_BYTES {
            return Err(HlaeSessionProtocolError::TokenTooShort {
                actual: bytes.len(),
                minimum: HLAE_SESSION_MIN_TOKEN_BYTES,
            });
        }
        if bytes.len() > HLAE_SESSION_MAX_TOKEN_BYTES {
            return Err(HlaeSessionProtocolError::TokenTooLong {
                actual: bytes.len(),
                maximum: HLAE_SESSION_MAX_TOKEN_BYTES,
            });
        }
        Ok(Self(bytes.into()))
    }

    pub(crate) fn as_bytes(&self) -> &[u8] {
        &self.0
    }

    pub(crate) fn as_hex(&self) -> String {
        hex::encode(&self.0)
    }
}

impl fmt::Debug for SessionToken {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("SessionToken")
            .field("bytes", &"[REDACTED]")
            .field("length", &self.0.len())
            .finish()
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ValidatedCapturePaths {
    demo: PathBuf,
    managed_output_root: PathBuf,
    output_directory: PathBuf,
}

impl ValidatedCapturePaths {
    /// Binds canonical existing paths to one managed capture session.
    ///
    /// # Errors
    ///
    /// Returns an error for missing or wrong-kind paths, a non-demo file, or
    /// an output directory outside the managed root.
    pub fn verify(
        demo: impl AsRef<Path>,
        managed_output_root: impl AsRef<Path>,
        output_directory: impl AsRef<Path>,
    ) -> Result<Self, HlaeSessionProtocolError> {
        let demo = canonical_file(demo.as_ref(), "demo")?;
        if !demo
            .extension()
            .is_some_and(|extension| extension.eq_ignore_ascii_case("dem"))
        {
            return Err(HlaeSessionProtocolError::InvalidPath(
                "demo must use the .dem extension".into(),
            ));
        }
        let managed_output_root = canonical_directory(managed_output_root.as_ref(), "root")?;
        let output_directory = canonical_directory(output_directory.as_ref(), "output")?;
        if output_directory == managed_output_root
            || !output_directory.starts_with(&managed_output_root)
        {
            return Err(HlaeSessionProtocolError::InvalidPath(
                "output directory must be a strict descendant of the managed root".into(),
            ));
        }
        Ok(Self {
            demo,
            managed_output_root,
            output_directory,
        })
    }
}

/// Host-verified demo and capture timing limits shared by the session and the
/// generated fixed bridge. The bridge reports observations; this contract is
/// the authority that accepts or rejects them.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CaptureTickContract {
    verified_total_ticks: u32,
    seek_target_tick: u32,
    capture_start_tick: u32,
    capture_end_tick: u32,
    max_start_overshoot_ticks: u32,
    max_end_overshoot_ticks: u32,
}

/// Parser-backed identity expected throughout a player-POV capture. The bridge
/// independently reads the active observer target from the HLAE entity API
/// before capture and again when capture stops; it never derives this value
/// from a player name or slot.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CaptureObserverContract {
    steam_id64: u64,
    spectator_slot: u8,
}

impl CaptureObserverContract {
    /// Binds one canonical 17-digit `SteamID64` and parser-backed CS2
    /// spectator slot as the required POV target.
    ///
    /// # Errors
    ///
    /// Returns an error for a non-canonical or zero identifier, or for a slot
    /// outside the CS2 player-controller range.
    pub fn try_new(steam_id64: &str, spectator_slot: u8) -> Result<Self, HlaeSessionProtocolError> {
        if steam_id64.len() != 17 || !steam_id64.bytes().all(|byte| byte.is_ascii_digit()) {
            return Err(HlaeSessionProtocolError::InvalidObserverEvidence);
        }
        let steam_id64 = steam_id64
            .parse::<u64>()
            .map_err(|_| HlaeSessionProtocolError::InvalidObserverEvidence)?;
        if steam_id64 == 0 || !(1..=64).contains(&spectator_slot) {
            return Err(HlaeSessionProtocolError::InvalidObserverEvidence);
        }
        Ok(Self {
            steam_id64,
            spectator_slot,
        })
    }

    #[must_use]
    pub const fn steam_id64(self) -> u64 {
        self.steam_id64
    }

    #[must_use]
    pub const fn spectator_slot(self) -> u8 {
        self.spectator_slot
    }
}

/// HLAE entity evidence captured before recording and revalidated when the
/// bounded capture stops.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ObservedPlayerPov {
    steam_id64: u64,
    observer_mode: u8,
    verified_before_capture_tick: u32,
    verified_at_capture_stop_tick: Option<u32>,
}

impl ObservedPlayerPov {
    #[must_use]
    pub const fn steam_id64(self) -> u64 {
        self.steam_id64
    }

    /// Raw Source 2 observer mode reported by HLAE. Player-POV sessions accept
    /// only [`CS2_OBSERVER_MODE_IN_EYE`].
    #[must_use]
    pub const fn observer_mode(self) -> u8 {
        self.observer_mode
    }

    #[must_use]
    pub const fn verified_before_capture_tick(self) -> u32 {
        self.verified_before_capture_tick
    }

    #[must_use]
    pub const fn verified_at_capture_stop_tick(self) -> Option<u32> {
        self.verified_at_capture_stop_tick
    }
}

impl CaptureTickContract {
    /// Creates a bounded contract. Overshoot windows must themselves remain
    /// inside the parser-verified demo range.
    ///
    /// # Errors
    ///
    /// Returns an error for reversed, overflowing, or out-of-demo tick ranges.
    pub fn try_new(
        verified_total_ticks: u32,
        seek_target_tick: u32,
        capture_start_tick: u32,
        capture_end_tick: u32,
        max_start_overshoot_ticks: u32,
        max_end_overshoot_ticks: u32,
    ) -> Result<Self, HlaeSessionProtocolError> {
        let start_limit = capture_start_tick.checked_add(max_start_overshoot_ticks);
        let end_limit = capture_end_tick.checked_add(max_end_overshoot_ticks);
        if verified_total_ticks == 0
            || verified_total_ticks > HLAE_SESSION_MAX_TICK
            || seek_target_tick > capture_start_tick
            || capture_start_tick >= capture_end_tick
            || capture_end_tick > verified_total_ticks
            || start_limit.is_none_or(|limit| limit > verified_total_ticks)
            || end_limit.is_none_or(|limit| limit > verified_total_ticks)
        {
            return Err(HlaeSessionProtocolError::InvalidTickContract);
        }
        Ok(Self {
            verified_total_ticks,
            seek_target_tick,
            capture_start_tick,
            capture_end_tick,
            max_start_overshoot_ticks,
            max_end_overshoot_ticks,
        })
    }

    #[must_use]
    pub const fn verified_total_ticks(self) -> u32 {
        self.verified_total_ticks
    }

    #[must_use]
    pub const fn seek_target_tick(self) -> u32 {
        self.seek_target_tick
    }

    #[must_use]
    pub const fn capture_start_tick(self) -> u32 {
        self.capture_start_tick
    }

    #[must_use]
    pub const fn capture_end_tick(self) -> u32 {
        self.capture_end_tick
    }

    #[must_use]
    pub const fn max_start_overshoot_ticks(self) -> u32 {
        self.max_start_overshoot_ticks
    }

    #[must_use]
    pub const fn max_end_overshoot_ticks(self) -> u32 {
        self.max_end_overshoot_ticks
    }

    fn seek_completion_is_bounded(self, tick: u32) -> bool {
        tick >= self.seek_target_tick
            && tick <= self.seek_target_tick + self.max_start_overshoot_ticks
    }

    fn capture_start_is_bounded(self, tick: u32) -> bool {
        tick >= self.capture_start_tick
            && tick <= self.capture_start_tick + self.max_start_overshoot_ticks
    }

    fn capture_end_is_bounded(self, tick: u32) -> bool {
        tick >= self.capture_end_tick
            && tick <= self.capture_end_tick + self.max_end_overshoot_ticks
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ObservedCaptureSpan {
    start_tick: u32,
    end_tick: u32,
}

impl ObservedCaptureSpan {
    #[must_use]
    pub const fn start_tick(self) -> u32 {
        self.start_tick
    }

    #[must_use]
    pub const fn end_tick(self) -> u32 {
        self.end_tick
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HlaeSessionState {
    NotPrepared,
    Ready,
    Launching,
    HookHandshaking,
    DemoReady,
    Seeking,
    Capturing,
    Finalizing,
    Completed,
    Failed,
    Cancelled,
}

/// Facts produced by trusted host code. They are never serialized onto the
/// game bridge and never affect the bridge's sequence counter.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HlaeHostEvent {
    PreparationVerified,
    LaunchRequested,
    LoaderStarted {
        process_id: u32,
    },
    LoaderExited {
        exit_code: i32,
    },
    /// The caller has externally bound the accepted connection to this exact
    /// CS2 process. It is intentionally independent from the HLAE loader PID.
    GameHookAuthenticated {
        game_process_id: u32,
    },
    /// Advances an already-authenticated, already-loaded Demo session to its
    /// next take. Only trusted host code may change the bounded tick and
    /// observer contracts; no console command crosses the bridge.
    AdvanceTake {
        ticks: CaptureTickContract,
        observer: Option<CaptureObserverContract>,
    },
    FinalizationCompleted,
    FailureReported {
        reason: String,
    },
    CancelRequested,
}

/// Strict whitelist of observations the generated bridge may send.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum HlaeBridgeEvent {
    DemoLoaded {
        demo_path: String,
        current_tick: u32,
        total_ticks: u32,
    },
    SeekRequested {
        target_tick: u32,
    },
    SeekCompleted {
        current_tick: u32,
    },
    ObserverVerified {
        steam_id64: String,
        observer_mode: u8,
        observed_tick: u32,
    },
    CaptureStarted {
        output_directory: String,
        observed_tick: u32,
    },
    CaptureStopped {
        observed_tick: u32,
    },
    FailureReported {
        reason: String,
    },
    Heartbeat,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BridgeWireMessage {
    session_token: String,
    sequence: u64,
    event: HlaeBridgeEvent,
}

#[derive(Clone, PartialEq, Eq)]
pub struct HlaeBridgeMessage(BridgeWireMessage);

impl fmt::Debug for HlaeBridgeMessage {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("HlaeBridgeMessage")
            .field("session_token", &"[REDACTED]")
            .field("sequence", &self.0.sequence)
            .field("event", &self.0.event)
            .finish()
    }
}

impl HlaeBridgeMessage {
    #[must_use]
    pub fn new(token: &SessionToken, sequence: u64, event: HlaeBridgeEvent) -> Self {
        Self(BridgeWireMessage {
            session_token: token.as_hex(),
            sequence,
            event,
        })
    }

    /// Serializes this bounded authenticated bridge envelope.
    ///
    /// # Errors
    ///
    /// Returns an error when serialization fails or exceeds the message cap.
    pub fn encode(&self) -> Result<Vec<u8>, HlaeSessionProtocolError> {
        let bytes = serde_json::to_vec(&self.0).map_err(HlaeSessionProtocolError::Encode)?;
        if bytes.len() > HLAE_SESSION_MAX_MESSAGE_BYTES {
            return Err(HlaeSessionProtocolError::MessageTooLarge {
                actual: bytes.len(),
                maximum: HLAE_SESSION_MAX_MESSAGE_BYTES,
            });
        }
        Ok(bytes)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BridgeControlObserverWire {
    steam_id64: String,
    spectator_slot: u8,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
enum BridgeControlWire {
    AdvanceTake {
        take_index: u32,
        verified_total_ticks: u32,
        seek_target_tick: u32,
        max_start_overshoot_ticks: u32,
        capture_start_tick: u32,
        capture_end_tick: u32,
        max_end_overshoot_ticks: u32,
        observer: Option<BridgeControlObserverWire>,
    },
    FinishSession,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BridgeControlWireMessage {
    session_token: String,
    sequence: u64,
    control: BridgeControlWire,
}

/// Authenticated server-to-bridge control envelope. Its constructors expose
/// only the two protocol operations required by a persistent capture session;
/// arbitrary console text cannot be represented by this type.
#[derive(Clone, PartialEq, Eq)]
pub struct HlaeBridgeControlMessage(BridgeControlWireMessage);

impl fmt::Debug for HlaeBridgeControlMessage {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("HlaeBridgeControlMessage")
            .field("session_token", &"[REDACTED]")
            .field("sequence", &self.0.sequence)
            .field("control", &self.0.control)
            .finish()
    }
}

impl HlaeBridgeControlMessage {
    /// Creates the only control capable of advancing a loaded Demo to another
    /// bounded take. All command text is compiled locally by the bridge from
    /// these validated numeric and identity facts.
    ///
    /// # Errors
    ///
    /// Returns an error for zero-based/zero-sequence envelopes, which are not
    /// valid after the initial take has completed.
    pub fn advance_take(
        token: &SessionToken,
        sequence: u64,
        take_index: u32,
        ticks: CaptureTickContract,
        observer: Option<CaptureObserverContract>,
    ) -> Result<Self, HlaeSessionProtocolError> {
        validate_control_position(sequence, Some(take_index))?;
        Ok(Self(BridgeControlWireMessage {
            session_token: token.as_hex(),
            sequence,
            control: BridgeControlWire::AdvanceTake {
                take_index,
                verified_total_ticks: ticks.verified_total_ticks(),
                seek_target_tick: ticks.seek_target_tick(),
                max_start_overshoot_ticks: ticks.max_start_overshoot_ticks(),
                capture_start_tick: ticks.capture_start_tick(),
                capture_end_tick: ticks.capture_end_tick(),
                max_end_overshoot_ticks: ticks.max_end_overshoot_ticks(),
                observer: observer.map(|observer| BridgeControlObserverWire {
                    steam_id64: observer.steam_id64().to_string(),
                    spectator_slot: observer.spectator_slot(),
                }),
            },
        }))
    }

    /// Creates the only terminal control accepted by the bridge.
    ///
    /// # Errors
    ///
    /// Returns an error for sequence zero.
    pub fn finish_session(
        token: &SessionToken,
        sequence: u64,
    ) -> Result<Self, HlaeSessionProtocolError> {
        validate_control_position(sequence, None)?;
        Ok(Self(BridgeControlWireMessage {
            session_token: token.as_hex(),
            sequence,
            control: BridgeControlWire::FinishSession,
        }))
    }

    /// Serializes this bounded authenticated control envelope.
    ///
    /// # Errors
    ///
    /// Returns an error when serialization fails or exceeds the message cap.
    pub fn encode(&self) -> Result<Vec<u8>, HlaeSessionProtocolError> {
        let bytes = serde_json::to_vec(&self.0).map_err(HlaeSessionProtocolError::Encode)?;
        if bytes.len() > HLAE_SESSION_MAX_MESSAGE_BYTES {
            return Err(HlaeSessionProtocolError::MessageTooLarge {
                actual: bytes.len(),
                maximum: HLAE_SESSION_MAX_MESSAGE_BYTES,
            });
        }
        Ok(bytes)
    }
}

fn validate_control_position(
    sequence: u64,
    take_index: Option<u32>,
) -> Result<(), HlaeSessionProtocolError> {
    if sequence == 0
        || take_index
            .is_some_and(|take_index| take_index == 0 || take_index >= HLAE_SESSION_MAX_TAKES)
    {
        return Err(HlaeSessionProtocolError::InvalidControlEnvelope);
    }
    Ok(())
}

#[derive(Debug)]
pub struct HlaeSessionMachine {
    token: SessionToken,
    paths: ValidatedCapturePaths,
    ticks: CaptureTickContract,
    state: HlaeSessionState,
    expected_bridge_sequence: u64,
    loader_process_id: Option<u32>,
    game_process_id: Option<u32>,
    loader_exit_seen: bool,
    current_tick: Option<u32>,
    seek_completed: bool,
    expected_observer: Option<CaptureObserverContract>,
    observer_evidence: Option<ObservedPlayerPov>,
    capture_observed_start: Option<u32>,
    observed_capture_span: Option<ObservedCaptureSpan>,
    capture_take_directory: Option<PathBuf>,
    completed_take_directories: Vec<PathBuf>,
    failure_reason: Option<String>,
    bridge_arrival_times_ms: VecDeque<u64>,
}

impl HlaeSessionMachine {
    #[must_use]
    pub fn new(
        token: SessionToken,
        paths: ValidatedCapturePaths,
        ticks: CaptureTickContract,
    ) -> Self {
        Self::new_inner(token, paths, ticks, None)
    }

    #[must_use]
    pub fn new_with_observer(
        token: SessionToken,
        paths: ValidatedCapturePaths,
        ticks: CaptureTickContract,
        observer: CaptureObserverContract,
    ) -> Self {
        Self::new_inner(token, paths, ticks, Some(observer))
    }

    fn new_inner(
        token: SessionToken,
        paths: ValidatedCapturePaths,
        ticks: CaptureTickContract,
        expected_observer: Option<CaptureObserverContract>,
    ) -> Self {
        Self {
            token,
            paths,
            ticks,
            state: HlaeSessionState::NotPrepared,
            expected_bridge_sequence: 1,
            loader_process_id: None,
            game_process_id: None,
            loader_exit_seen: false,
            current_tick: None,
            seek_completed: false,
            expected_observer,
            observer_evidence: None,
            capture_observed_start: None,
            observed_capture_span: None,
            capture_take_directory: None,
            completed_take_directories: Vec::new(),
            failure_reason: None,
            bridge_arrival_times_ms: VecDeque::with_capacity(HLAE_SESSION_MAX_MESSAGES_PER_SECOND),
        }
    }

    #[must_use]
    pub const fn state(&self) -> HlaeSessionState {
        self.state
    }

    #[must_use]
    pub fn capture_take_directory(&self) -> Option<&Path> {
        self.capture_take_directory.as_deref()
    }

    #[must_use]
    pub const fn observed_capture_span(&self) -> Option<ObservedCaptureSpan> {
        self.observed_capture_span
    }

    #[must_use]
    pub const fn observer_evidence(&self) -> Option<ObservedPlayerPov> {
        self.observer_evidence
    }

    #[must_use]
    pub fn completed_take_count(&self) -> usize {
        self.completed_take_directories.len()
    }

    /// Returns the validated reason supplied by the host or authenticated
    /// bridge when the session entered [`HlaeSessionState::Failed`].
    #[must_use]
    pub fn failure_reason(&self) -> Option<&str> {
        self.failure_reason.as_deref()
    }

    /// Applies one trusted host fact without serialization, rate limiting, or
    /// bridge sequence consumption.
    ///
    /// # Errors
    ///
    /// Returns an error for an invalid transition or malformed host evidence.
    pub fn apply_host_event(
        &mut self,
        event: HlaeHostEvent,
    ) -> Result<HlaeSessionState, HlaeSessionProtocolError> {
        if self.state.is_terminal() {
            return Err(HlaeSessionProtocolError::TerminalState(self.state));
        }
        let result = self.apply_active_host_event(event);
        if result.is_err() {
            self.state = HlaeSessionState::Failed;
        }
        result
    }

    fn apply_active_host_event(
        &mut self,
        event: HlaeHostEvent,
    ) -> Result<HlaeSessionState, HlaeSessionProtocolError> {
        match (self.state, event) {
            (_, HlaeHostEvent::FailureReported { reason }) => {
                validate_failure_reason(&reason)?;
                self.failure_reason = Some(reason);
                self.state = HlaeSessionState::Failed;
            }
            (_, HlaeHostEvent::CancelRequested) => {
                self.state = HlaeSessionState::Cancelled;
            }
            (HlaeSessionState::NotPrepared, HlaeHostEvent::PreparationVerified) => {
                self.state = HlaeSessionState::Ready;
            }
            (HlaeSessionState::Ready, HlaeHostEvent::LaunchRequested) => {
                self.state = HlaeSessionState::Launching;
            }
            (HlaeSessionState::Launching, HlaeHostEvent::LoaderStarted { process_id }) => {
                if process_id == 0 {
                    return Err(HlaeSessionProtocolError::InvalidProcessId);
                }
                self.loader_process_id = Some(process_id);
                self.state = HlaeSessionState::HookHandshaking;
            }
            (
                HlaeSessionState::HookHandshaking
                | HlaeSessionState::DemoReady
                | HlaeSessionState::Seeking
                | HlaeSessionState::Capturing
                | HlaeSessionState::Finalizing,
                HlaeHostEvent::LoaderExited { exit_code },
            ) if !self.loader_exit_seen => {
                self.loader_exit_seen = true;
                if exit_code != 0 {
                    self.state = HlaeSessionState::Failed;
                }
            }
            (
                HlaeSessionState::HookHandshaking,
                HlaeHostEvent::GameHookAuthenticated { game_process_id },
            ) => {
                if game_process_id == 0 || self.game_process_id.is_some() {
                    return Err(HlaeSessionProtocolError::InvalidHandshake);
                }
                self.game_process_id = Some(game_process_id);
            }
            (HlaeSessionState::Finalizing, HlaeHostEvent::AdvanceTake { ticks, observer }) => {
                if u32::try_from(self.completed_take_directories.len())
                    .map_or(true, |count| count >= HLAE_SESSION_MAX_TAKES)
                    || ticks.verified_total_ticks() != self.ticks.verified_total_ticks()
                {
                    return Err(HlaeSessionProtocolError::InvalidHostTransition);
                }
                self.ticks = ticks;
                self.expected_observer = observer;
                self.current_tick = None;
                self.seek_completed = false;
                self.observer_evidence = None;
                self.capture_observed_start = None;
                self.observed_capture_span = None;
                self.capture_take_directory = None;
                self.state = HlaeSessionState::DemoReady;
            }
            (HlaeSessionState::Finalizing, HlaeHostEvent::FinalizationCompleted) => {
                self.state = HlaeSessionState::Completed;
            }
            _ => return Err(HlaeSessionProtocolError::InvalidHostTransition),
        }
        Ok(self.state)
    }

    /// Authenticates, rate-limits, sequences, and applies one bridge message.
    /// Any malformed or state-invalid bridge input fails the session closed.
    ///
    /// # Errors
    ///
    /// Returns the first envelope, authentication, sequencing, evidence, or
    /// state-transition failure.
    pub fn ingest_bridge(
        &mut self,
        bytes: &[u8],
        received_at_ms: u64,
    ) -> Result<HlaeSessionState, HlaeSessionProtocolError> {
        if self.state.is_terminal() {
            return Err(HlaeSessionProtocolError::TerminalState(self.state));
        }
        let result = self.ingest_active_bridge(bytes, received_at_ms);
        if result.is_err() {
            self.state = HlaeSessionState::Failed;
        }
        result
    }

    fn ingest_active_bridge(
        &mut self,
        bytes: &[u8],
        received_at_ms: u64,
    ) -> Result<HlaeSessionState, HlaeSessionProtocolError> {
        if bytes.len() > HLAE_SESSION_MAX_MESSAGE_BYTES {
            return Err(HlaeSessionProtocolError::MessageTooLarge {
                actual: bytes.len(),
                maximum: HLAE_SESSION_MAX_MESSAGE_BYTES,
            });
        }
        self.validate_bridge_arrival(received_at_ms)?;
        let message: BridgeWireMessage =
            serde_json::from_slice(bytes).map_err(HlaeSessionProtocolError::Decode)?;
        let supplied_token = hex::decode(&message.session_token)
            .map_err(HlaeSessionProtocolError::InvalidTokenEncoding)?;
        if supplied_token.len() < HLAE_SESSION_MIN_TOKEN_BYTES
            || supplied_token.len() > HLAE_SESSION_MAX_TOKEN_BYTES
            || !constant_time_eq(&supplied_token, self.token.as_bytes())
        {
            return Err(HlaeSessionProtocolError::TokenMismatch);
        }
        if message.sequence != self.expected_bridge_sequence {
            return Err(HlaeSessionProtocolError::SequenceMismatch {
                expected: self.expected_bridge_sequence,
                actual: message.sequence,
            });
        }
        if self.game_process_id.is_none() {
            return Err(HlaeSessionProtocolError::InvalidHandshake);
        }
        self.apply_active_bridge_event(message.event)?;
        self.expected_bridge_sequence += 1;
        Ok(self.state)
    }

    fn apply_active_bridge_event(
        &mut self,
        event: HlaeBridgeEvent,
    ) -> Result<(), HlaeSessionProtocolError> {
        match (self.state, event) {
            (
                HlaeSessionState::HookHandshaking
                | HlaeSessionState::DemoReady
                | HlaeSessionState::Seeking
                | HlaeSessionState::Capturing
                | HlaeSessionState::Finalizing,
                HlaeBridgeEvent::FailureReported { reason },
            ) => {
                validate_failure_reason(&reason)?;
                self.failure_reason = Some(reason);
                self.state = HlaeSessionState::Failed;
            }
            (
                HlaeSessionState::HookHandshaking
                | HlaeSessionState::DemoReady
                | HlaeSessionState::Seeking
                | HlaeSessionState::Capturing
                | HlaeSessionState::Finalizing,
                HlaeBridgeEvent::Heartbeat,
            ) => {}
            (
                HlaeSessionState::HookHandshaking,
                HlaeBridgeEvent::DemoLoaded {
                    demo_path,
                    current_tick,
                    total_ticks,
                },
            ) if self.game_process_id.is_some() => {
                validate_reported_path(&demo_path, &self.paths.demo)?;
                if total_ticks != self.ticks.verified_total_ticks() || current_tick > total_ticks {
                    return Err(HlaeSessionProtocolError::InvalidTick);
                }
                self.current_tick = Some(current_tick);
                self.state = HlaeSessionState::DemoReady;
            }
            (HlaeSessionState::DemoReady, HlaeBridgeEvent::SeekRequested { target_tick }) => {
                if self.seek_completed || target_tick != self.ticks.seek_target_tick() {
                    return Err(HlaeSessionProtocolError::InvalidTick);
                }
                self.state = HlaeSessionState::Seeking;
            }
            (HlaeSessionState::Seeking, HlaeBridgeEvent::SeekCompleted { current_tick }) => {
                if !self.ticks.seek_completion_is_bounded(current_tick) {
                    return Err(HlaeSessionProtocolError::InvalidTick);
                }
                self.current_tick = Some(current_tick);
                self.seek_completed = true;
                self.state = HlaeSessionState::DemoReady;
            }
            (
                HlaeSessionState::DemoReady,
                HlaeBridgeEvent::ObserverVerified {
                    steam_id64,
                    observer_mode,
                    observed_tick,
                },
            ) => {
                if !self.seek_completed || self.observer_evidence.is_some() {
                    return Err(HlaeSessionProtocolError::InvalidBridgeTransition);
                }
                let expected = self
                    .expected_observer
                    .ok_or(HlaeSessionProtocolError::InvalidBridgeTransition)?;
                let observed =
                    CaptureObserverContract::try_new(&steam_id64, expected.spectator_slot())?;
                if observed != expected
                    || observer_mode != CS2_OBSERVER_MODE_IN_EYE
                    || observed_tick < self.ticks.seek_target_tick()
                    || observed_tick
                        > self.ticks.capture_start_tick() + self.ticks.max_start_overshoot_ticks()
                {
                    return Err(HlaeSessionProtocolError::InvalidObserverEvidence);
                }
                self.observer_evidence = Some(ObservedPlayerPov {
                    steam_id64: observed.steam_id64(),
                    observer_mode,
                    verified_before_capture_tick: observed_tick,
                    verified_at_capture_stop_tick: None,
                });
            }
            (
                HlaeSessionState::Capturing,
                HlaeBridgeEvent::ObserverVerified {
                    steam_id64,
                    observer_mode,
                    observed_tick,
                },
            ) => {
                let expected = self
                    .expected_observer
                    .ok_or(HlaeSessionProtocolError::InvalidBridgeTransition)?;
                let start_evidence = self
                    .observer_evidence
                    .ok_or(HlaeSessionProtocolError::InvalidBridgeTransition)?;
                let observed =
                    CaptureObserverContract::try_new(&steam_id64, expected.spectator_slot())?;
                if observed != expected
                    || observer_mode != start_evidence.observer_mode
                    || observer_mode != CS2_OBSERVER_MODE_IN_EYE
                    || !self.ticks.capture_end_is_bounded(observed_tick)
                {
                    return Err(HlaeSessionProtocolError::InvalidObserverEvidence);
                }
                self.observer_evidence = Some(ObservedPlayerPov {
                    steam_id64: observed.steam_id64(),
                    observer_mode,
                    verified_before_capture_tick: start_evidence.verified_before_capture_tick,
                    verified_at_capture_stop_tick: Some(observed_tick),
                });
            }
            (
                HlaeSessionState::DemoReady,
                HlaeBridgeEvent::CaptureStarted {
                    output_directory,
                    observed_tick,
                },
            ) => {
                if !self.seek_completed {
                    return Err(HlaeSessionProtocolError::InvalidBridgeTransition);
                }
                if self.expected_observer.is_some() && self.observer_evidence.is_none() {
                    return Err(HlaeSessionProtocolError::InvalidBridgeTransition);
                }
                if !self.ticks.capture_start_is_bounded(observed_tick) {
                    return Err(HlaeSessionProtocolError::InvalidTick);
                }
                revalidate_capture_paths(&self.paths)?;
                let take_directory = validate_reported_take_directory(
                    &output_directory,
                    &self.paths.output_directory,
                )?;
                if self.completed_take_directories.contains(&take_directory) {
                    return Err(HlaeSessionProtocolError::InvalidPath(
                        "each capture take must use a fresh managed directory".into(),
                    ));
                }
                self.current_tick = Some(observed_tick);
                self.capture_observed_start = Some(observed_tick);
                self.capture_take_directory = Some(take_directory);
                self.state = HlaeSessionState::Capturing;
            }
            (HlaeSessionState::Capturing, HlaeBridgeEvent::CaptureStopped { observed_tick }) => {
                if self.expected_observer.is_some() {
                    let evidence = self
                        .observer_evidence
                        .ok_or(HlaeSessionProtocolError::InvalidObserverEvidence)?;
                    if evidence.verified_at_capture_stop_tick != Some(observed_tick) {
                        return Err(HlaeSessionProtocolError::InvalidObserverEvidence);
                    }
                }
                let start_tick = self
                    .capture_observed_start
                    .ok_or(HlaeSessionProtocolError::InvalidBridgeTransition)?;
                if !self.ticks.capture_end_is_bounded(observed_tick) || observed_tick < start_tick {
                    return Err(HlaeSessionProtocolError::InvalidTick);
                }
                revalidate_capture_take(self.capture_take_directory.as_deref())?;
                self.current_tick = Some(observed_tick);
                self.observed_capture_span = Some(ObservedCaptureSpan {
                    start_tick,
                    end_tick: observed_tick,
                });
                self.completed_take_directories.push(
                    self.capture_take_directory
                        .clone()
                        .ok_or(HlaeSessionProtocolError::InvalidBridgeTransition)?,
                );
                self.state = HlaeSessionState::Finalizing;
            }
            _ => return Err(HlaeSessionProtocolError::InvalidBridgeTransition),
        }
        Ok(())
    }

    fn validate_bridge_arrival(
        &mut self,
        received_at_ms: u64,
    ) -> Result<(), HlaeSessionProtocolError> {
        if self
            .bridge_arrival_times_ms
            .back()
            .is_some_and(|previous| received_at_ms < *previous)
        {
            return Err(HlaeSessionProtocolError::ReceiveTimeReordered);
        }
        while self.bridge_arrival_times_ms.front().is_some_and(|oldest| {
            received_at_ms.saturating_sub(*oldest) >= HLAE_SESSION_RATE_WINDOW_MS
        }) {
            self.bridge_arrival_times_ms.pop_front();
        }
        if self.bridge_arrival_times_ms.len() >= HLAE_SESSION_MAX_MESSAGES_PER_SECOND {
            return Err(HlaeSessionProtocolError::RateLimitExceeded {
                maximum: HLAE_SESSION_MAX_MESSAGES_PER_SECOND,
                window_ms: HLAE_SESSION_RATE_WINDOW_MS,
            });
        }
        self.bridge_arrival_times_ms.push_back(received_at_ms);
        Ok(())
    }
}

impl HlaeSessionState {
    const fn is_terminal(self) -> bool {
        matches!(self, Self::Completed | Self::Failed | Self::Cancelled)
    }
}

fn canonical_file(path: &Path, label: &str) -> Result<PathBuf, HlaeSessionProtocolError> {
    let canonical = fs::canonicalize(path)
        .map_err(|error| HlaeSessionProtocolError::InvalidPath(format!("{label} path: {error}")))?;
    if !canonical.is_file() {
        return Err(HlaeSessionProtocolError::InvalidPath(format!(
            "{label} path is not a file"
        )));
    }
    Ok(canonical)
}

fn canonical_directory(path: &Path, label: &str) -> Result<PathBuf, HlaeSessionProtocolError> {
    let canonical = fs::canonicalize(path)
        .map_err(|error| HlaeSessionProtocolError::InvalidPath(format!("{label} path: {error}")))?;
    if !canonical.is_dir() {
        return Err(HlaeSessionProtocolError::InvalidPath(format!(
            "{label} path is not a directory"
        )));
    }
    Ok(canonical)
}

fn constant_time_eq(left: &[u8], right: &[u8]) -> bool {
    if left.len() != right.len() {
        return false;
    }
    left.iter()
        .zip(right)
        .fold(0_u8, |difference, (left, right)| {
            difference | (left ^ right)
        })
        == 0
}

fn validate_failure_reason(reason: &str) -> Result<(), HlaeSessionProtocolError> {
    if reason.trim().is_empty()
        || reason.len() > HLAE_SESSION_MAX_FAILURE_REASON_BYTES
        || reason.chars().any(char::is_control)
    {
        return Err(HlaeSessionProtocolError::InvalidFailureReason);
    }
    Ok(())
}

fn revalidate_capture_paths(paths: &ValidatedCapturePaths) -> Result<(), HlaeSessionProtocolError> {
    let demo = canonical_file(&paths.demo, "bound demo")?;
    let managed_output_root =
        canonical_directory(&paths.managed_output_root, "bound managed output root")?;
    let output_directory = canonical_directory(&paths.output_directory, "bound output directory")?;
    if demo != paths.demo
        || managed_output_root != paths.managed_output_root
        || output_directory != paths.output_directory
        || output_directory == managed_output_root
        || !output_directory.starts_with(&managed_output_root)
    {
        return Err(HlaeSessionProtocolError::InvalidPath(
            "capture paths changed after session verification".into(),
        ));
    }
    Ok(())
}

fn validate_reported_path(reported: &str, expected: &Path) -> Result<(), HlaeSessionProtocolError> {
    if reported.is_empty()
        || reported.len() > HLAE_SESSION_MAX_PATH_BYTES
        || reported.chars().any(char::is_control)
    {
        return Err(HlaeSessionProtocolError::InvalidPath(
            "reported path is empty or exceeds protocol limits".into(),
        ));
    }
    let canonical = fs::canonicalize(reported).map_err(|error| {
        HlaeSessionProtocolError::InvalidPath(format!("reported path: {error}"))
    })?;
    if canonical != expected {
        return Err(HlaeSessionProtocolError::InvalidPath(
            "reported path does not match the verified session path".into(),
        ));
    }
    Ok(())
}

fn validate_reported_take_directory(
    reported: &str,
    expected_capture_directory: &Path,
) -> Result<PathBuf, HlaeSessionProtocolError> {
    if reported.is_empty()
        || reported.len() > HLAE_SESSION_MAX_PATH_BYTES
        || reported.chars().any(char::is_control)
    {
        return Err(HlaeSessionProtocolError::InvalidPath(
            "reported take path is empty or exceeds protocol limits".into(),
        ));
    }
    let reported_path = Path::new(reported);
    let metadata = fs::symlink_metadata(reported_path).map_err(|error| {
        HlaeSessionProtocolError::InvalidPath(format!("reported take path: {error}"))
    })?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(HlaeSessionProtocolError::InvalidPath(
            "reported HLAE take must be a regular directory".into(),
        ));
    }
    let canonical = fs::canonicalize(reported_path).map_err(|error| {
        HlaeSessionProtocolError::InvalidPath(format!("reported take path: {error}"))
    })?;
    let valid_name = canonical
        .file_name()
        .and_then(|name| name.to_str())
        .and_then(|name| name.strip_prefix("take"))
        .is_some_and(|digits| {
            digits.len() == 4 && digits.bytes().all(|byte| byte.is_ascii_digit())
        });
    if canonical.parent() != Some(expected_capture_directory) || !valid_name {
        return Err(HlaeSessionProtocolError::InvalidPath(
            "reported take must be a direct takeNNNN child of the verified capture directory"
                .into(),
        ));
    }
    Ok(canonical)
}

fn revalidate_capture_take(take: Option<&Path>) -> Result<(), HlaeSessionProtocolError> {
    let expected = take.ok_or_else(|| {
        HlaeSessionProtocolError::InvalidPath("capture take was not bound".into())
    })?;
    let canonical = canonical_directory(expected, "bound HLAE take")?;
    if canonical != expected {
        return Err(HlaeSessionProtocolError::InvalidPath(
            "HLAE take path changed while recording".into(),
        ));
    }
    Ok(())
}

#[derive(Debug, Error)]
pub enum HlaeSessionProtocolError {
    #[error("operating system failed to generate an HLAE session token: {0}")]
    TokenGeneration(getrandom::Error),
    #[error("session token is {actual} bytes; at least {minimum} bytes are required")]
    TokenTooShort { actual: usize, minimum: usize },
    #[error("session token is {actual} bytes; maximum is {maximum} bytes")]
    TokenTooLong { actual: usize, maximum: usize },
    #[error("session token is not valid hexadecimal: {0}")]
    InvalidTokenEncoding(hex::FromHexError),
    #[error("invalid capture path: {0}")]
    InvalidPath(String),
    #[error("failed to encode HLAE bridge message: {0}")]
    Encode(serde_json::Error),
    #[error("failed to decode HLAE bridge message: {0}")]
    Decode(serde_json::Error),
    #[error("HLAE bridge message is {actual} bytes; maximum is {maximum}")]
    MessageTooLarge { actual: usize, maximum: usize },
    #[error("HLAE bridge message receive time moved backwards")]
    ReceiveTimeReordered,
    #[error("HLAE bridge exceeded {maximum} messages in {window_ms} ms")]
    RateLimitExceeded { maximum: usize, window_ms: u64 },
    #[error("HLAE bridge session token mismatch")]
    TokenMismatch,
    #[error("expected bridge sequence {expected}, got {actual}")]
    SequenceMismatch { expected: u64, actual: u64 },
    #[error("host event is not valid in the current HLAE session state")]
    InvalidHostTransition,
    #[error("bridge event is not valid in the current HLAE session state")]
    InvalidBridgeTransition,
    #[error("server-to-bridge control envelope is invalid")]
    InvalidControlEnvelope,
    #[error("process identifier must be non-zero")]
    InvalidProcessId,
    #[error("game hook identity was not bound exactly once")]
    InvalidHandshake,
    #[error("capture tick contract is invalid")]
    InvalidTickContract,
    #[error("demo or observed capture tick is outside the host-bound range")]
    InvalidTick,
    #[error("observed player POV does not match the parser-bound Steam identity")]
    InvalidObserverEvidence,
    #[error("failure reason is empty or exceeds protocol limits")]
    InvalidFailureReason,
    #[error("HLAE session is already terminal in state {0:?}")]
    TerminalState(HlaeSessionState),
}
