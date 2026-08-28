use vibe_cs_hlae::{
    CaptureObserverContract, CaptureTickContract, HLAE_MIRV_BRIDGE_FILE_NAME,
    HLAE_MIRV_BRIDGE_PATH, MirvScriptBridgeContract, MirvScriptBridgeFactSource, SessionToken,
    compile_mirv_script_bridge,
};

const ENDPOINT: &str = "ws://127.0.0.1:54321/hlae/session";

fn token() -> SessionToken {
    SessionToken::try_from_bytes(&[0x12; 32]).expect("token")
}

fn observer_contract() -> MirvScriptBridgeContract {
    contract().with_observer(
        CaptureObserverContract::try_new("76561197960690195", 7).expect("observer contract"),
    )
}

fn contract() -> MirvScriptBridgeContract {
    let ticks =
        CaptureTickContract::try_new(4_096, 128, 128, 256, 4, 4).expect("capture tick contract");
    MirvScriptBridgeContract::new(ticks)
}

#[test]
fn bridge_compiler_uses_a_typed_token_fixed_seek_and_sequence_one() {
    let artifact = compile_mirv_script_bridge(ENDPOINT, &token(), contract()).expect("bridge");
    let source = artifact.source();

    assert_eq!(artifact.file_name(), HLAE_MIRV_BRIDGE_FILE_NAME);
    assert_eq!(artifact.media_type(), "text/javascript");
    assert_eq!(HLAE_MIRV_BRIDGE_PATH, "/hlae/session");
    assert!(source.contains("let nextSequence = 1;"));
    assert!(source.contains(r#"let FIXED_SEEK_COMMAND = "demo_gototick 128; demo_resume";"#));
    assert!(source.contains("mirv.exec(FIXED_SEEK_COMMAND);"));
    assert_eq!(source.matches("mirv.exec(").count(), 2);
    assert_eq!(source.matches("demo_resume").count(), 2);
    assert!(source.contains(r#"kind: "seek_requested", target_tick: SEEK_TARGET_TICK"#));
    assert!(source.contains(r#"kind: "seek_completed", current_tick:"#));
}

#[test]
fn compiles_the_authenticated_loopback_only_bridge_without_dynamic_execution() {
    let artifact = compile_mirv_script_bridge(ENDPOINT, &token(), contract()).expect("bridge");
    let source = artifact.source();

    assert!(source.contains(r#"const WS_ADDRESS = "ws://127.0.0.1:54321/hlae/session";"#));
    assert!(source.contains(&format!(r#"const SESSION_TOKEN = "{}";"#, "12".repeat(32))));
    for placeholder in [
        "__WS_ADDRESS_JSON__",
        "__SESSION_TOKEN_JSON__",
        "__EXPECTED_OBSERVER_STEAM_ID_JSON__",
        "__FIXED_SPEC_PLAYER_COMMAND_JSON__",
        "__EXPECTED_OBSERVER_MODE_IN_EYE__",
        "__SEEK_TARGET_TICK__",
        "__FIXED_SEEK_COMMAND_JSON__",
    ] {
        assert!(!source.contains(placeholder), "unexpanded {placeholder}");
    }
    assert!(!source.contains("eval("));
    assert!(!source.contains("Function("));
    assert!(!source.contains("new Function"));
    assert_eq!(source.matches("JSON.parse(").count(), 1);
}

#[test]
fn generated_artifact_debug_output_does_not_leak_the_session_token() {
    let artifact = compile_mirv_script_bridge(ENDPOINT, &token(), contract()).expect("bridge");
    let debug = format!("{artifact:?}");

    assert!(debug.contains("[REDACTED]"));
    assert!(!debug.contains(&"12".repeat(32)));
}

#[test]
fn rejects_noncanonical_or_non_loopback_endpoints() {
    for endpoint in [
        "ws://example.com:54321/hlae/session",
        "ws://127.0.0.1:54321/user-controlled",
        "http://127.0.0.1:54321/hlae/session",
        "ws://127.0.0.1:31337/hlae/session",
        "ws://127.0.0.1/hlae/session",
        "ws://127.0.0.1:54321/hlae/session?command=exec",
        "ws://127.0.0.1:54321/hlae/session#fragment",
        "ws://user@127.0.0.1:54321/hlae/session",
        "ws://127.0.0.1:54321/hlae/session\n",
    ] {
        assert!(
            compile_mirv_script_bridge(endpoint, &token(), contract()).is_err(),
            "accepted unsafe endpoint {endpoint:?}"
        );
    }
}

#[test]
fn rejects_a_session_token_that_is_not_exactly_256_bits() {
    let short = SessionToken::try_from_bytes(&[0x12; 16]).expect("protocol-valid token");
    assert!(compile_mirv_script_bridge(ENDPOINT, &short, contract()).is_err());
}

#[test]
fn observes_demo_seek_and_recording_through_reviewed_hlae_apis() {
    let source = compile_mirv_script_bridge(ENDPOINT, &token(), contract())
        .expect("bridge")
        .source()
        .to_owned();

    for api in [
        "mirv.connect_async(WS_ADDRESS)",
        "mirv.getDemoFilePath()",
        "mirv.resolveGamePath(rawDemoPath)",
        "mirv.getDemoTick()",
        "mirv.isPlayingDemo()",
        "mirv.isDemoPaused()",
        "mirv.exec(FIXED_SEEK_COMMAND)",
        "mirv.events.recordStart.on",
        "mirv.events.recordEnd.on",
        "mirv.events.clientFrameStageNotify.on",
    ] {
        assert!(source.contains(api), "missing reviewed API call {api}");
    }
    for kind in [
        "demo_loaded",
        "seek_requested",
        "seek_completed",
        "capture_started",
        "capture_stopped",
        "heartbeat",
        "failure_reported",
    ] {
        assert!(source.contains(&format!(r#"kind: "{kind}""#)));
    }
}

#[test]
fn bridge_inlines_hlae_const_enum_values_for_the_javascript_runtime() {
    let source = compile_mirv_script_bridge(ENDPOINT, &token(), contract())
        .expect("bridge")
        .source()
        .to_owned();

    assert!(source.contains("const FRAME_START = 0;"));
    assert!(source.contains("const FRAME_RENDER_PASS = 12;"));
    assert!(!source.contains("SOURCESDK_CS2.ClientFrameStage_t"));
}

#[test]
fn null_demo_path_and_unavailable_or_negative_tick_retry_until_wall_clock_deadline() {
    let source = compile_mirv_script_bridge(ENDPOINT, &token(), contract())
        .expect("bridge")
        .source()
        .to_owned();

    for bound in [
        "const CONNECT_ATTEMPT_TIMEOUT_MS = 5000;",
        "const CONNECT_RETRY_INTERVAL_MS = 500;",
        "const DEMO_EVIDENCE_TIMEOUT_MS = 30000;",
        "const SEEK_TIMEOUT_MS = 30000;",
        "const CAPTURE_OBSERVATION_TIMEOUT_MS = 5000;",
        "const HEARTBEAT_INTERVAL_MS = 1000;",
    ] {
        assert!(source.contains(bound), "missing wall-clock bound {bound}");
    }
    assert!(source.contains("const nowMs = Date.now();"));
    assert!(source.contains("rawDemoPath === null"));
    assert!(source.contains("tick === undefined || (typeof tick === \"number\" && tick < 0)"));
    assert!(source.contains("evidence.kind === \"transient\""));
    assert!(source.contains("nowMs >= demoEvidenceDeadlineMs"));
    assert!(!source.contains("TIMEOUT_FRAMES"));
    assert!(!source.contains("INTERVAL_FRAMES"));
}

#[test]
fn transient_round_boundary_does_not_end_demo_playback_on_one_frame() {
    let source = compile_mirv_script_bridge(ENDPOINT, &token(), contract())
        .expect("bridge")
        .source()
        .to_owned();

    assert!(source.contains("const DEMO_PLAYBACK_LOSS_GRACE_MS = 5000;"));
    assert!(source.contains("function serviceDemoPlaybackContinuity(nowMs)"));
    assert!(source.contains("demoPlaybackMissingSinceMs = nowMs;"));
    assert!(source.contains("nowMs - demoPlaybackMissingSinceMs >= DEMO_PLAYBACK_LOSS_GRACE_MS"));
    assert!(!source.contains("if (demoReported && !mirv.isPlayingDemo())"));
}

#[test]
fn record_callbacks_report_observed_start_and_the_fixed_stop_command_tick() {
    let source = compile_mirv_script_bridge(ENDPOINT, &token(), contract())
        .expect("bridge")
        .source()
        .to_owned();

    assert!(source.contains(r#"kind: "capture_started""#));
    assert!(source.contains("observed_tick: evidence.tick"));
    assert!(source.contains(r#"kind: "capture_stopped""#));
    assert!(source.contains("const observedTick = CAPTURE_END_TICK;"));
    assert!(!source.contains("start_tick: CAPTURE_START_TICK"));
    assert!(!source.contains("end_tick: CAPTURE_END_TICK"));
    assert!(!source.contains("currentTick !== CAPTURE_START_TICK"));
    assert!(!source.contains("finalTick !== CAPTURE_END_TICK"));
}

#[test]
fn record_end_uses_the_closed_command_program_tick_and_keeps_its_deadline() {
    let source = compile_mirv_script_bridge(ENDPOINT, &token(), contract())
        .expect("bridge")
        .source()
        .to_owned();

    assert!(source.contains("const observedTick = CAPTURE_END_TICK;"));
    assert!(!source.contains("lastReadyCaptureTick"));
    assert!(source.contains("if (nowMs >= pendingRecordEndDeadlineMs)"));
}

#[test]
fn record_start_failure_reports_the_exact_failed_preconditions() {
    let source = compile_mirv_script_bridge(ENDPOINT, &token(), contract())
        .expect("bridge")
        .source()
        .to_owned();

    assert!(source.contains("function recordStartInvalidState()"));
    for reason in [
        "not_connected",
        "demo_not_reported",
        "seek_not_completed",
        "awaiting_control",
        "already_capturing",
        "start_already_pending",
        "end_pending",
        "demo_not_playing",
        "demo_paused",
    ] {
        assert!(
            source.contains(reason),
            "missing record-start reason {reason}"
        );
    }
    assert!(source.contains(
        "failClosed(\"record start arrived outside a sought offline demo: \" + invalidState);",
    ));
}

#[test]
fn record_start_ignores_a_late_duplicate_while_record_end_evidence_is_pending() {
    let source = compile_mirv_script_bridge(ENDPOINT, &token(), contract())
        .expect("bridge")
        .source()
        .to_owned();

    let duplicate_guard = source
        .find("if ((capturing && pendingRecordEndDeadlineMs !== 0) || awaitingControl) return;")
        .expect("late duplicate guard");
    let invalid_state = source
        .find("const invalidState = recordStartInvalidState();")
        .expect("record start validation");
    assert!(duplicate_guard < invalid_state);
}

#[test]
fn player_pov_bridge_verifies_first_person_identity_before_and_at_capture_stop() {
    let source = compile_mirv_script_bridge(ENDPOINT, &token(), observer_contract())
        .expect("observer bridge")
        .source()
        .to_owned();

    assert!(source.contains(r#"let EXPECTED_OBSERVER_STEAM_ID = "76561197960690195";"#));
    assert!(source.contains("const EXPECTED_OBSERVER_MODE_IN_EYE = 2;"));
    for api in [
        "mirv.getEntityFromSplitScreenPlayer(0)",
        "getPlayerPawnHandle()",
        "getObserverTargetHandle()",
        "getPlayerControllerHandle()",
        "getSteamId()",
        "getObserverMode()",
    ] {
        assert!(source.contains(api), "missing observer evidence API {api}");
    }
    assert!(source.matches(r#"kind: "observer_verified""#).count() >= 2);
    assert!(source.contains("steam_id64: observer.steamId64"));
    assert!(source.contains("observer_mode: observer.mode"));
    assert!(source.contains("observed_tick: evidence.tick"));
    assert!(source.contains("observer.mode !== EXPECTED_OBSERVER_MODE_IN_EYE"));
    assert!(source.contains("observer.steamId64 !== EXPECTED_OBSERVER_STEAM_ID"));
    assert!(source.contains("record end observer identity or first-person mode"));
}

#[test]
fn player_pov_bridge_reasserts_and_fails_closed_on_sustained_observer_drift() {
    let source = compile_mirv_script_bridge(ENDPOINT, &token(), observer_contract())
        .expect("observer bridge")
        .source()
        .to_owned();

    assert!(source.contains("function serviceActiveObserverLock()"));
    assert!(source.contains("if (!capturing || EXPECTED_OBSERVER_STEAM_ID === null"));
    assert!(source.contains("active capture observer identity or first-person mode drifted"));
    assert!(source.contains("observerDriftFrames += 1;"));
    assert!(source.contains("if (observerDriftFrames > 2)"));
    assert!(source.contains("observerDriftFrames = 0;"));
    let lock_call = source
        .find("serviceActiveObserverLock();")
        .expect("per-frame observer lock call");
    let fixed_lock_call = source
        .find("serviceFixedSpectatorSlotLock();")
        .expect("per-frame fixed spectator lock call");
    let observations_call = source
        .find("serviceCaptureObservations(nowMs);")
        .expect("capture observation call");
    assert!(fixed_lock_call < lock_call);
    assert!(lock_call < observations_call);
    assert!(source.contains(r#"let FIXED_SPEC_PLAYER_COMMAND = "spec_player 7";"#));
    assert!(source.contains("function serviceFixedSpectatorSlotLock()"));
    assert!(source.contains("mirv.exec(FIXED_SPEC_PLAYER_COMMAND);"));
}

#[test]
fn camera_bridge_does_not_require_player_observer_evidence() {
    let source = compile_mirv_script_bridge(ENDPOINT, &token(), contract())
        .expect("camera bridge")
        .source()
        .to_owned();

    assert!(source.contains("let EXPECTED_OBSERVER_STEAM_ID = null;"));
    assert!(source.contains("let FIXED_SPEC_PLAYER_COMMAND = null;"));
}

#[test]
fn bridge_queues_with_fixed_limits_and_refuses_free_form_server_commands() {
    let source = compile_mirv_script_bridge(ENDPOINT, &token(), contract())
        .expect("bridge")
        .source()
        .to_owned();

    for bound in [
        "const MAX_MESSAGE_BYTES = 16384;",
        "const MAX_QUEUE_MESSAGES = 32;",
        "const MAX_CONNECT_ATTEMPTS = 10;",
    ] {
        assert!(source.contains(bound), "missing fixed bound {bound}");
    }
    assert!(source.contains("utf8ByteLength(encoded) > MAX_MESSAGE_BYTES"));
    assert!(source.contains("if (message === null)"));
    assert!(source.contains("terminateWithoutReport();"));
    assert!(source.contains("function decodeControlMessage(message)"));
    assert!(source.contains("server control was malformed or arrived outside the take boundary"));
    assert!(!source.contains("case \"exec\""));
    assert!(!source.contains("mirv.exec(message"));
    assert!(!source.contains("mirv.exec(command"));
}

#[test]
fn bridge_accepts_only_authenticated_typed_advance_or_finish_controls() {
    let source = compile_mirv_script_bridge(ENDPOINT, &token(), observer_contract())
        .expect("bridge")
        .source()
        .to_owned();

    for contract in [
        "let expectedControlSequence = 1;",
        "const MAX_TAKES = 64;",
        "const MAX_TICK = 2147483647;",
        "function decodeControlMessage(message)",
        "hasExactKeys(envelope, [\"sessionToken\", \"sequence\", \"control\"])",
        "envelope.sessionToken !== SESSION_TOKEN",
        "envelope.sequence !== expectedControlSequence",
        "control.kind === \"advance_take\"",
        "control.kind === \"finish_session\"",
        "takeIndex !== activeTakeIndex + 1",
        "control.takeIndex >= MAX_TAKES",
        "value <= MAX_TICK",
        "FIXED_SEEK_COMMAND = \"demo_gototick \" + SEEK_TARGET_TICK + \"; demo_resume\";",
        "\"spec_player \" + control.observer.spectatorSlot;",
    ] {
        assert!(
            source.contains(contract),
            "missing typed control guard {contract}"
        );
    }
    assert!(!source.contains("control.command"));
    assert!(!source.contains("message.command"));
    assert!(!source.contains("mirv.exec(control"));
    assert!(!source.contains("mirv.exec(message"));
}

#[test]
fn capability_report_does_not_claim_pid_or_total_ticks_from_mirv_script() {
    let artifact = compile_mirv_script_bridge(ENDPOINT, &token(), contract()).expect("bridge");
    let capabilities = artifact.capabilities();

    assert_eq!(
        capabilities.game_process_id,
        MirvScriptBridgeFactSource::ExternalProcessBindingRequired
    );
    assert_eq!(
        capabilities.total_ticks,
        MirvScriptBridgeFactSource::HostVerifiedDemoParser
    );
}
