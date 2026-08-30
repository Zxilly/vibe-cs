//! Process-free generator for the managed HLAE `mirv-script` bridge.

use std::fmt;

use crate::{
    CS2_OBSERVER_MODE_IN_EYE, CaptureObserverContract, CaptureTickContract, HLAE_SESSION_MAX_TAKES,
    HLAE_SESSION_MAX_TICK, HlaeError, HlaePersistentPovCommands, SessionToken,
};

/// Fixed WebSocket path used by the managed bridge.
pub const HLAE_MIRV_BRIDGE_PATH: &str = "/hlae/session";
/// Fixed direct-child artifact name used by managed HLAE jobs.
pub const HLAE_MIRV_BRIDGE_FILE_NAME: &str = "vibe_cs_bridge.js";
/// First port in the IANA dynamic/private range used for OS-selected listeners.
pub const HLAE_MIRV_BRIDGE_MIN_DYNAMIC_PORT: u16 = 49_152;
/// Maximum size of the generated JavaScript artifact.
pub const HLAE_MIRV_BRIDGE_MAX_ARTIFACT_BYTES: usize = 64 * 1_024;
const BRIDGE_TEMPLATE: &str = include_str!("bridge_template.js");

/// Host-verified facts needed to map HLAE observations onto session events.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MirvScriptBridgeContract {
    capture_ticks: CaptureTickContract,
    observer: Option<CaptureObserverContract>,
    persistent_pov: Option<HlaePersistentPovCommands>,
}

impl MirvScriptBridgeContract {
    /// Binds the same parser-verified tick contract used by the host session.
    #[must_use]
    pub const fn new(capture_ticks: CaptureTickContract) -> Self {
        Self {
            capture_ticks,
            observer: None,
            persistent_pov: None,
        }
    }

    #[must_use]
    pub const fn capture_ticks(&self) -> CaptureTickContract {
        self.capture_ticks
    }

    /// Requires the generated bridge to prove the active observed Steam
    /// identity and CS2 first-person observer mode before capture and again
    /// when HLAE reports recording stopped.
    #[must_use]
    pub const fn with_observer(mut self, observer: CaptureObserverContract) -> Self {
        self.observer = Some(observer);
        self
    }

    /// Enables typed subsequent-take commands compiled by the player-POV
    /// compiler. No caller-provided command text enters this contract.
    #[must_use]
    pub fn with_persistent_pov(mut self, commands: &HlaePersistentPovCommands) -> Self {
        self.persistent_pov = Some(commands.clone());
        self
    }
}

/// One self-contained JavaScript artifact; compiling it has no side effects.
#[derive(Clone, PartialEq, Eq)]
pub struct MirvScriptBridgeArtifact {
    source: String,
}

impl fmt::Debug for MirvScriptBridgeArtifact {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("MirvScriptBridgeArtifact")
            .field("source", &"[REDACTED]")
            .field("source_bytes", &self.source.len())
            .finish()
    }
}

/// Explicit boundary between facts exposed by HLAE and facts bound by the host.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MirvScriptBridgeCapabilities {
    /// HLAE 2.191.1 has no `mirv-script` PID API.
    pub game_process_id: MirvScriptBridgeFactSource,
    /// HLAE 2.191.1 has no `mirv-script` total-tick API.
    pub total_ticks: MirvScriptBridgeFactSource,
}

/// Trusted origin required for a bridge protocol fact.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MirvScriptBridgeFactSource {
    /// Must be bound to the exact process handle launched by the host runtime.
    ExternalProcessBindingRequired,
    /// Comes from the application's bounded demo parser before launch.
    HostVerifiedDemoParser,
}

impl MirvScriptBridgeArtifact {
    /// Returns the fixed direct-child name for this managed artifact.
    #[must_use]
    pub const fn file_name(&self) -> &'static str {
        HLAE_MIRV_BRIDGE_FILE_NAME
    }

    /// Returns the JavaScript media type used by manifests and writers.
    #[must_use]
    pub const fn media_type(&self) -> &'static str {
        "text/javascript"
    }

    /// Returns the generated self-contained JavaScript source.
    #[must_use]
    pub fn source(&self) -> &str {
        &self.source
    }

    /// Reports HLAE 2.191.1 API gaps without inventing unavailable values.
    #[must_use]
    pub const fn capabilities(&self) -> MirvScriptBridgeCapabilities {
        MirvScriptBridgeCapabilities {
            game_process_id: MirvScriptBridgeFactSource::ExternalProcessBindingRequired,
            total_ticks: MirvScriptBridgeFactSource::HostVerifiedDemoParser,
        }
    }
}

/// Compiles a self-contained, process-free `mirv-script` bridge artifact.
///
/// # Errors
///
/// Returns [`HlaeError`] when an input cannot be represented safely.
pub fn compile_mirv_script_bridge(
    endpoint: &str,
    session_token: &SessionToken,
    contract: MirvScriptBridgeContract,
) -> Result<MirvScriptBridgeArtifact, HlaeError> {
    let MirvScriptBridgeContract {
        capture_ticks,
        observer,
        persistent_pov,
    } = contract;
    if endpoint.chars().any(char::is_control) {
        return Err(HlaeError::InvalidPlan(
            "bridge endpoint contains control characters".to_owned(),
        ));
    }
    let parsed = url::Url::parse(endpoint)
        .map_err(|_| HlaeError::InvalidPlan("bridge endpoint is not a valid URL".to_owned()))?;
    if parsed.scheme() != "ws"
        || parsed.host_str() != Some("127.0.0.1")
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.query().is_some()
        || parsed.fragment().is_some()
    {
        return Err(HlaeError::InvalidPlan(
            "bridge endpoint must be an unauthenticated ws URL on numeric IPv4 loopback".to_owned(),
        ));
    }
    if parsed.path() != HLAE_MIRV_BRIDGE_PATH {
        return Err(HlaeError::InvalidPlan(format!(
            "bridge endpoint must use the fixed {HLAE_MIRV_BRIDGE_PATH} path"
        )));
    }
    let port = parsed.port().ok_or_else(|| {
        HlaeError::InvalidPlan("bridge endpoint must contain an explicit dynamic port".to_owned())
    })?;
    if port < HLAE_MIRV_BRIDGE_MIN_DYNAMIC_PORT
        || endpoint != format!("ws://127.0.0.1:{port}{HLAE_MIRV_BRIDGE_PATH}")
    {
        return Err(HlaeError::InvalidPlan(
            "bridge endpoint must use a canonical OS-selected dynamic loopback port".to_owned(),
        ));
    }
    if session_token.as_bytes().len() != 32 {
        return Err(HlaeError::InvalidPlan(
            "bridge session token must contain exactly 256 bits".to_owned(),
        ));
    }
    let endpoint = serde_json::to_string(endpoint).map_err(|error| {
        HlaeError::InvalidPlan(format!("unable to encode bridge endpoint: {error}"))
    })?;
    let session_token = serde_json::to_string(&session_token.as_hex()).map_err(|error| {
        HlaeError::InvalidPlan(format!("unable to encode bridge session token: {error}"))
    })?;
    let expected_observer = observer
        .map(|observer| serde_json::to_string(&observer.steam_id64().to_string()))
        .transpose()
        .map_err(|error| {
            HlaeError::InvalidPlan(format!("unable to encode observer identity: {error}"))
        })?
        .unwrap_or_else(|| "null".to_owned());
    let fixed_spec_player_command = observer
        .map(|observer| {
            serde_json::to_string(&format!("spec_player {}", observer.spectator_slot()))
        })
        .transpose()
        .map_err(|error| {
            HlaeError::InvalidPlan(format!("unable to encode spectator lock: {error}"))
        })?
        .unwrap_or_else(|| "null".to_owned());
    let fixed_seek_command = serde_json::to_string(&format!(
        "demo_gototick {}; demo_resume",
        capture_ticks.seek_target_tick()
    ))
    .map_err(|error| {
        HlaeError::InvalidPlan(format!("unable to encode fixed seek command: {error}"))
    })?;
    let encode_persistent_command = |command: Option<&str>, label: &str| {
        command
            .map(serde_json::to_string)
            .transpose()
            .map_err(|error| {
                HlaeError::InvalidPlan(format!(
                    "unable to encode persistent {label} command: {error}"
                ))
            })
            .map(|value| value.unwrap_or_else(|| "null".to_owned()))
    };
    let persistent_observer_setup = encode_persistent_command(
        persistent_pov
            .as_ref()
            .map(HlaePersistentPovCommands::observer_setup),
        "observer setup",
    )?;
    let persistent_capture_start = encode_persistent_command(
        persistent_pov
            .as_ref()
            .map(HlaePersistentPovCommands::capture_start),
        "capture start",
    )?;
    let persistent_capture_stop = encode_persistent_command(
        persistent_pov
            .as_ref()
            .map(HlaePersistentPovCommands::capture_stop),
        "capture stop",
    )?;
    let source = BRIDGE_TEMPLATE
        .replace("__WS_ADDRESS_JSON__", &endpoint)
        .replace("__MAX_TAKES__", &HLAE_SESSION_MAX_TAKES.to_string())
        .replace("__MAX_TICK__", &HLAE_SESSION_MAX_TICK.to_string())
        .replace("__SESSION_TOKEN_JSON__", &session_token)
        .replace("__EXPECTED_OBSERVER_STEAM_ID_JSON__", &expected_observer)
        .replace(
            "__FIXED_SPEC_PLAYER_COMMAND_JSON__",
            &fixed_spec_player_command,
        )
        .replace(
            "__EXPECTED_OBSERVER_MODE_IN_EYE__",
            &CS2_OBSERVER_MODE_IN_EYE.to_string(),
        )
        .replace(
            "__VERIFIED_TOTAL_TICKS__",
            &capture_ticks.verified_total_ticks().to_string(),
        )
        .replace(
            "__SEEK_TARGET_TICK__",
            &capture_ticks.seek_target_tick().to_string(),
        )
        .replace(
            "__SEEK_COMPLETION_MAX_TICK__",
            &(capture_ticks.seek_target_tick() + capture_ticks.max_start_overshoot_ticks())
                .to_string(),
        )
        .replace("__FIXED_SEEK_COMMAND_JSON__", &fixed_seek_command)
        .replace(
            "__PERSISTENT_OBSERVER_SETUP_COMMAND_JSON__",
            &persistent_observer_setup,
        )
        .replace(
            "__PERSISTENT_CAPTURE_START_COMMAND_JSON__",
            &persistent_capture_start,
        )
        .replace(
            "__PERSISTENT_CAPTURE_STOP_COMMAND_JSON__",
            &persistent_capture_stop,
        )
        .replace(
            "__CAPTURE_START_TICK__",
            &capture_ticks.capture_start_tick().to_string(),
        )
        .replace(
            "__CAPTURE_START_MAX_TICK__",
            &(capture_ticks.capture_start_tick() + capture_ticks.max_start_overshoot_ticks())
                .to_string(),
        )
        .replace(
            "__CAPTURE_END_TICK__",
            &capture_ticks.capture_end_tick().to_string(),
        )
        .replace(
            "__CAPTURE_END_MAX_TICK__",
            &(capture_ticks.capture_end_tick() + capture_ticks.max_end_overshoot_ticks())
                .to_string(),
        );
    if source.len() > HLAE_MIRV_BRIDGE_MAX_ARTIFACT_BYTES {
        return Err(HlaeError::InvalidPlan(
            "generated mirv-script bridge exceeds its artifact limit".to_owned(),
        ));
    }
    Ok(MirvScriptBridgeArtifact { source })
}
