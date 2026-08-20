use std::{fs, path::PathBuf};

use tempfile::{TempDir, tempdir};
use vibe_cs_hlae::{
    CS2_OBSERVER_MODE_IN_EYE, CaptureObserverContract, CaptureTickContract,
    HLAE_SESSION_MAX_MESSAGE_BYTES, HLAE_SESSION_MAX_MESSAGES_PER_SECOND, HLAE_SESSION_MAX_TAKES,
    HlaeBridgeControlMessage, HlaeBridgeEvent, HlaeBridgeMessage, HlaeHostEvent,
    HlaeSessionMachine, HlaeSessionProtocolError, HlaeSessionState, SessionToken,
    ValidatedCapturePaths,
};

#[test]
fn host_controls_are_typed_advance_or_finish_envelopes_without_free_commands() {
    let token = SessionToken::try_from_bytes(&token_bytes(0x34)).expect("token");
    let ticks = CaptureTickContract::try_new(4_096, 512, 512, 640, 4, 4).expect("second ticks");
    let observer =
        CaptureObserverContract::try_new("76561198000000001", 8).expect("second observer");

    assert_eq!(HLAE_SESSION_MAX_TAKES, 64);
    assert!(matches!(
        HlaeBridgeControlMessage::advance_take(
            &token,
            1,
            HLAE_SESSION_MAX_TAKES,
            ticks,
            Some(observer)
        ),
        Err(HlaeSessionProtocolError::InvalidControlEnvelope)
    ));
    let advance = HlaeBridgeControlMessage::advance_take(&token, 1, 1, ticks, Some(observer))
        .expect("typed advance");
    let advance_json: serde_json::Value =
        serde_json::from_slice(&advance.encode().expect("advance envelope")).expect("json");
    assert_eq!(advance_json.as_object().expect("object").len(), 3);
    assert_eq!(advance_json["sequence"], 1);
    assert_eq!(advance_json["control"]["kind"], "advance_take");
    assert_eq!(advance_json["control"]["takeIndex"], 1);
    assert_eq!(advance_json["control"]["seekTargetTick"], 512);
    assert_eq!(advance_json["control"]["captureEndTick"], 640);
    assert_eq!(
        advance_json["control"]["observer"]["steamId64"],
        "76561198000000001"
    );
    assert!(!advance_json.to_string().contains("command"));

    let finish = HlaeBridgeControlMessage::finish_session(&token, 2).expect("typed finish");
    let finish_json: serde_json::Value =
        serde_json::from_slice(&finish.encode().expect("finish envelope")).expect("json");
    assert_eq!(finish_json["control"]["kind"], "finish_session");
    assert!(!finish_json.to_string().contains("command"));
}

#[test]
fn one_authenticated_demo_session_can_capture_two_independent_takes() {
    let (fixture, token, mut session) = player_pov_test_session(0x35);
    let take_one = fixture.output.join("take0000");
    let take_two = fixture.output.join("take0001");
    fs::create_dir(&take_one).expect("first take");
    fs::create_dir(&take_two).expect("second take");

    apply_host_handshake(&mut session);
    send_demo_loaded(&fixture, &token, &mut session);
    capture_player_pov_take(
        &mut session,
        &token,
        2,
        20,
        128,
        128,
        256,
        "76561197960690195",
        &take_one,
    );

    let second_observer =
        CaptureObserverContract::try_new("76561198000000001", 8).expect("second observer");
    let second_ticks =
        CaptureTickContract::try_new(4_096, 512, 512, 640, 4, 4).expect("second ticks");
    assert_eq!(
        session
            .apply_host_event(HlaeHostEvent::AdvanceTake {
                ticks: second_ticks,
                observer: Some(second_observer),
            })
            .expect("advance without another launch or demo load"),
        HlaeSessionState::DemoReady
    );
    assert_eq!(session.observer_evidence(), None);
    assert_eq!(session.observed_capture_span(), None);
    assert_eq!(session.capture_take_directory(), None);

    capture_player_pov_take(
        &mut session,
        &token,
        8,
        80,
        512,
        512,
        640,
        "76561198000000001",
        &take_two,
    );
    assert_eq!(session.completed_take_count(), 2);
    let canonical_take_two = fs::canonicalize(&take_two).expect("canonical second take");
    assert_eq!(
        session.capture_take_directory(),
        Some(canonical_take_two.as_path())
    );
    assert_eq!(
        session
            .observer_evidence()
            .expect("second take evidence")
            .steam_id64(),
        76_561_198_000_000_001
    );
    assert_eq!(
        session
            .apply_host_event(HlaeHostEvent::FinalizationCompleted)
            .expect("finish shared session"),
        HlaeSessionState::Completed
    );
}

#[test]
fn player_pov_session_requires_matching_observer_identity_before_capture() {
    let directory = tempdir().expect("fixture");
    let demo = directory.path().join("match.dem");
    let output_root = directory.path().join("captures");
    let output = output_root.join("session-1");
    let take = output.join("take0000");
    fs::write(&demo, b"PBDEMS2").expect("demo");
    fs::create_dir_all(&take).expect("managed take");
    let paths = ValidatedCapturePaths::verify(&demo, &output_root, &output).expect("paths");
    let token = SessionToken::try_from_bytes(&token_bytes(0x39)).expect("token");
    let observer =
        CaptureObserverContract::try_new("76561197960690195", 7).expect("observer contract");
    let mut session =
        HlaeSessionMachine::new_with_observer(token.clone(), paths, tick_contract(), observer);
    let fixture = SessionFixture {
        _directory: directory,
        demo,
        output,
    };
    reach_demo_ready_after_seek(&fixture, &token, &mut session, 128);

    assert!(matches!(
        send_bridge(
            &mut session,
            &token,
            4,
            40,
            HlaeBridgeEvent::CaptureStarted {
                output_directory: take.to_string_lossy().into_owned(),
                observed_tick: 128,
            },
        ),
        Err(HlaeSessionProtocolError::InvalidBridgeTransition)
    ));

    let directory = tempdir().expect("fixture");
    let demo = directory.path().join("match.dem");
    let output_root = directory.path().join("captures");
    let output = output_root.join("session-1");
    let take = output.join("take0000");
    fs::write(&demo, b"PBDEMS2").expect("demo");
    fs::create_dir_all(&take).expect("managed take");
    let paths = ValidatedCapturePaths::verify(&demo, &output_root, &output).expect("paths");
    let token = SessionToken::try_from_bytes(&token_bytes(0x3a)).expect("token");
    let observer =
        CaptureObserverContract::try_new("76561197960690195", 7).expect("observer contract");
    let mut session =
        HlaeSessionMachine::new_with_observer(token.clone(), paths, tick_contract(), observer);
    let fixture = SessionFixture {
        _directory: directory,
        demo,
        output,
    };
    reach_demo_ready_after_seek(&fixture, &token, &mut session, 128);
    send_bridge(
        &mut session,
        &token,
        4,
        40,
        HlaeBridgeEvent::ObserverVerified {
            steam_id64: "76561197960690195".to_owned(),
            observer_mode: CS2_OBSERVER_MODE_IN_EYE,
            observed_tick: 128,
        },
    )
    .expect("matching observer");
    send_bridge(
        &mut session,
        &token,
        5,
        50,
        HlaeBridgeEvent::CaptureStarted {
            output_directory: take.to_string_lossy().into_owned(),
            observed_tick: 128,
        },
    )
    .expect("capture after observer evidence");
    let evidence = session.observer_evidence().expect("observer evidence");
    assert_eq!(evidence.steam_id64(), 76_561_197_960_690_195);
    assert_eq!(evidence.observer_mode(), CS2_OBSERVER_MODE_IN_EYE);
    assert_eq!(evidence.verified_before_capture_tick(), 128);
    assert_eq!(evidence.verified_at_capture_stop_tick(), None);
}

#[test]
fn player_pov_capture_cannot_stop_without_fresh_matching_observer_evidence() {
    let directory = tempdir().expect("fixture");
    let demo = directory.path().join("match.dem");
    let output_root = directory.path().join("captures");
    let output = output_root.join("session-1");
    let take = output.join("take0000");
    fs::write(&demo, b"PBDEMS2").expect("demo");
    fs::create_dir_all(&take).expect("managed take");
    let paths = ValidatedCapturePaths::verify(&demo, &output_root, &output).expect("paths");
    let token = SessionToken::try_from_bytes(&token_bytes(0x3b)).expect("token");
    let observer =
        CaptureObserverContract::try_new("76561197960690195", 7).expect("observer contract");
    let mut session =
        HlaeSessionMachine::new_with_observer(token.clone(), paths, tick_contract(), observer);
    let fixture = SessionFixture {
        _directory: directory,
        demo,
        output,
    };
    reach_demo_ready_after_seek(&fixture, &token, &mut session, 128);
    send_bridge(
        &mut session,
        &token,
        4,
        40,
        HlaeBridgeEvent::ObserverVerified {
            steam_id64: "76561197960690195".to_owned(),
            observer_mode: CS2_OBSERVER_MODE_IN_EYE,
            observed_tick: 128,
        },
    )
    .expect("matching observer at capture start");
    send_bridge(
        &mut session,
        &token,
        5,
        50,
        HlaeBridgeEvent::CaptureStarted {
            output_directory: take.to_string_lossy().into_owned(),
            observed_tick: 128,
        },
    )
    .expect("capture start");

    assert!(matches!(
        send_bridge(
            &mut session,
            &token,
            6,
            60,
            HlaeBridgeEvent::CaptureStopped { observed_tick: 256 },
        ),
        Err(HlaeSessionProtocolError::InvalidObserverEvidence)
    ));
    assert_eq!(session.state(), HlaeSessionState::Failed);
}

#[test]
fn player_pov_capture_accepts_only_a_matching_end_observer_check() {
    let directory = tempdir().expect("fixture");
    let demo = directory.path().join("match.dem");
    let output_root = directory.path().join("captures");
    let output = output_root.join("session-1");
    let take = output.join("take0000");
    fs::write(&demo, b"PBDEMS2").expect("demo");
    fs::create_dir_all(&take).expect("managed take");
    let paths = ValidatedCapturePaths::verify(&demo, &output_root, &output).expect("paths");
    let token = SessionToken::try_from_bytes(&token_bytes(0x3c)).expect("token");
    let observer =
        CaptureObserverContract::try_new("76561197960690195", 7).expect("observer contract");
    let mut session =
        HlaeSessionMachine::new_with_observer(token.clone(), paths, tick_contract(), observer);
    let fixture = SessionFixture {
        _directory: directory,
        demo,
        output,
    };
    reach_demo_ready_after_seek(&fixture, &token, &mut session, 128);
    for (sequence, event) in [
        HlaeBridgeEvent::ObserverVerified {
            steam_id64: "76561197960690195".to_owned(),
            observer_mode: CS2_OBSERVER_MODE_IN_EYE,
            observed_tick: 128,
        },
        HlaeBridgeEvent::CaptureStarted {
            output_directory: take.to_string_lossy().into_owned(),
            observed_tick: 128,
        },
        HlaeBridgeEvent::ObserverVerified {
            steam_id64: "76561197960690195".to_owned(),
            observer_mode: CS2_OBSERVER_MODE_IN_EYE,
            observed_tick: 256,
        },
        HlaeBridgeEvent::CaptureStopped { observed_tick: 256 },
    ]
    .into_iter()
    .enumerate()
    {
        send_bridge(
            &mut session,
            &token,
            u64::try_from(sequence).expect("sequence") + 4,
            u64::try_from(sequence).expect("arrival") * 10 + 40,
            event,
        )
        .expect("bounded player POV event");
    }

    assert_eq!(session.state(), HlaeSessionState::Finalizing);
    let evidence = session
        .observer_evidence()
        .expect("closed observer evidence");
    assert_eq!(evidence.verified_before_capture_tick(), 128);
    assert_eq!(evidence.verified_at_capture_stop_tick(), Some(256));
}

#[test]
fn player_pov_session_rejects_a_non_first_person_observer_mode() {
    let (fixture, token, mut session) = player_pov_test_session(0x3d);
    reach_demo_ready_after_seek(&fixture, &token, &mut session, 128);

    assert!(matches!(
        send_bridge(
            &mut session,
            &token,
            4,
            40,
            HlaeBridgeEvent::ObserverVerified {
                steam_id64: "76561197960690195".to_owned(),
                observer_mode: 4,
                observed_tick: 128,
            },
        ),
        Err(HlaeSessionProtocolError::InvalidObserverEvidence)
    ));
    assert_eq!(session.state(), HlaeSessionState::Failed);
}

#[test]
fn observer_contract_rejects_an_unbounded_spectator_slot() {
    for slot in [0, 65, u8::MAX] {
        assert!(matches!(
            CaptureObserverContract::try_new("76561197960690195", slot),
            Err(HlaeSessionProtocolError::InvalidObserverEvidence)
        ));
    }
}

#[test]
fn player_pov_session_rejects_observer_drift_at_capture_stop() {
    let (fixture, token, mut session) = player_pov_test_session(0x3e);
    let take = fixture.output.join("take0000");
    fs::create_dir(&take).expect("take");
    reach_demo_ready_after_seek(&fixture, &token, &mut session, 128);
    for (sequence, event) in [
        HlaeBridgeEvent::ObserverVerified {
            steam_id64: "76561197960690195".to_owned(),
            observer_mode: CS2_OBSERVER_MODE_IN_EYE,
            observed_tick: 128,
        },
        HlaeBridgeEvent::CaptureStarted {
            output_directory: take.to_string_lossy().into_owned(),
            observed_tick: 128,
        },
    ]
    .into_iter()
    .enumerate()
    {
        send_bridge(
            &mut session,
            &token,
            u64::try_from(sequence).expect("sequence") + 4,
            u64::try_from(sequence).expect("arrival") * 10 + 40,
            event,
        )
        .expect("capture start evidence");
    }

    assert!(matches!(
        send_bridge(
            &mut session,
            &token,
            6,
            60,
            HlaeBridgeEvent::ObserverVerified {
                steam_id64: "76561197960690196".to_owned(),
                observer_mode: CS2_OBSERVER_MODE_IN_EYE,
                observed_tick: 256,
            },
        ),
        Err(HlaeSessionProtocolError::InvalidObserverEvidence)
    ));
    assert_eq!(session.state(), HlaeSessionState::Failed);
}

#[test]
fn host_events_do_not_consume_the_bridge_sequence_space() {
    let (fixture, token, mut session) = test_session(0x41);
    apply_host_handshake(&mut session);

    assert_eq!(
        send_bridge(&mut session, &token, 1, 10, HlaeBridgeEvent::Heartbeat)
            .expect("bridge sequence starts at one"),
        HlaeSessionState::HookHandshaking
    );
    session
        .apply_host_event(HlaeHostEvent::LoaderExited { exit_code: 0 })
        .expect("host event does not consume bridge sequence");
    assert_eq!(
        send_bridge(
            &mut session,
            &token,
            2,
            20,
            HlaeBridgeEvent::DemoLoaded {
                demo_path: fixture.demo.to_string_lossy().into_owned(),
                current_tick: 64,
                total_ticks: 4_096,
            },
        )
        .expect("second bridge message"),
        HlaeSessionState::DemoReady
    );
}

#[test]
fn bridge_seek_and_capture_observations_close_the_bound_tick_contract() {
    let (fixture, token, mut session) = test_session(0x42);
    let take = fixture.output.join("take0000");
    fs::create_dir(&take).expect("HLAE take");
    apply_host_handshake(&mut session);

    let bridge_events = [
        HlaeBridgeEvent::DemoLoaded {
            demo_path: fixture.demo.to_string_lossy().into_owned(),
            current_tick: 64,
            total_ticks: 4_096,
        },
        HlaeBridgeEvent::SeekRequested { target_tick: 128 },
        HlaeBridgeEvent::SeekCompleted { current_tick: 128 },
        HlaeBridgeEvent::CaptureStarted {
            output_directory: take.to_string_lossy().into_owned(),
            observed_tick: 130,
        },
        HlaeBridgeEvent::CaptureStopped { observed_tick: 258 },
    ];
    for (index, event) in bridge_events.into_iter().enumerate() {
        let sequence = index as u64 + 1;
        send_bridge(&mut session, &token, sequence, sequence * 10, event)
            .expect("bounded bridge observation");
    }

    assert_eq!(session.state(), HlaeSessionState::Finalizing);
    let span = session
        .observed_capture_span()
        .expect("observed capture span");
    assert_eq!(span.start_tick(), 130);
    assert_eq!(span.end_tick(), 258);
    assert_eq!(
        session.capture_take_directory(),
        Some(fs::canonicalize(&take).expect("canonical take").as_path())
    );
    assert_eq!(
        session
            .apply_host_event(HlaeHostEvent::FinalizationCompleted)
            .expect("host finalization"),
        HlaeSessionState::Completed
    );
}

#[test]
fn bridge_cannot_forge_host_lifecycle_or_cancellation_events() {
    for forbidden_kind in [
        "preparation_verified",
        "process_started",
        "cancel_requested",
    ] {
        let (_fixture, _token, mut session) = test_session(0x43);
        apply_host_handshake(&mut session);
        let message = format!(
            r#"{{"sessionToken":"{}","sequence":1,"event":{{"kind":"{forbidden_kind}"}}}}"#,
            hex::encode(token_bytes(0x43))
        );
        assert!(matches!(
            session.ingest_bridge(message.as_bytes(), 10),
            Err(HlaeSessionProtocolError::Decode(_))
        ));
        assert_eq!(session.state(), HlaeSessionState::Failed);
    }
}

#[test]
fn capture_tick_contract_rejects_unbounded_or_reversed_windows() {
    for contract in [
        CaptureTickContract::try_new(0, 0, 1, 2, 0, 0),
        CaptureTickContract::try_new(100, 51, 50, 60, 0, 0),
        CaptureTickContract::try_new(100, 50, 50, 50, 0, 0),
        CaptureTickContract::try_new(100, 50, 50, 90, 0, 11),
        CaptureTickContract::try_new(100, 50, 99, 100, 2, 0),
    ] {
        assert!(matches!(
            contract,
            Err(HlaeSessionProtocolError::InvalidTickContract)
        ));
    }
}

#[test]
fn seek_completion_has_its_own_bounded_overshoot_window() {
    let directory = tempdir().expect("fixture");
    let demo = directory.path().join("match.dem");
    let root = directory.path().join("captures");
    let output = root.join("session-1");
    fs::write(&demo, b"PBDEMS2").expect("demo");
    fs::create_dir_all(&output).expect("output");
    let paths = ValidatedCapturePaths::verify(&demo, &root, &output).expect("paths");
    let token = SessionToken::try_from_bytes(&token_bytes(0x40)).expect("token");
    let ticks = CaptureTickContract::try_new(4_096, 64, 128, 256, 4, 4).expect("ticks");
    let mut session = HlaeSessionMachine::new(token.clone(), paths, ticks);
    apply_host_handshake(&mut session);
    send_bridge(
        &mut session,
        &token,
        1,
        10,
        HlaeBridgeEvent::DemoLoaded {
            demo_path: demo.to_string_lossy().into_owned(),
            current_tick: 32,
            total_ticks: 4_096,
        },
    )
    .expect("demo");
    send_bridge(
        &mut session,
        &token,
        2,
        20,
        HlaeBridgeEvent::SeekRequested { target_tick: 64 },
    )
    .expect("seek requested");
    assert!(matches!(
        send_bridge(
            &mut session,
            &token,
            3,
            30,
            HlaeBridgeEvent::SeekCompleted { current_tick: 69 },
        ),
        Err(HlaeSessionProtocolError::InvalidTick)
    ));
}

#[test]
fn observed_ticks_must_be_after_the_plan_and_within_overshoot_limits() {
    for (seed, start_tick) in [(0x44, 127), (0x45, 133)] {
        let (fixture, token, mut session) = test_session(seed);
        let take = fixture.output.join("take0000");
        fs::create_dir(&take).expect("take");
        reach_demo_ready_after_seek(&fixture, &token, &mut session, 128);
        let result = send_bridge(
            &mut session,
            &token,
            4,
            40,
            HlaeBridgeEvent::CaptureStarted {
                output_directory: take.to_string_lossy().into_owned(),
                observed_tick: start_tick,
            },
        );
        assert!(matches!(result, Err(HlaeSessionProtocolError::InvalidTick)));
        assert_eq!(session.state(), HlaeSessionState::Failed);
    }

    for (seed, final_tick) in [(0x46, 255), (0x47, 261)] {
        let (fixture, token, mut session) = test_session(seed);
        let take = fixture.output.join("take0000");
        fs::create_dir(&take).expect("take");
        reach_demo_ready_after_seek(&fixture, &token, &mut session, 128);
        send_bridge(
            &mut session,
            &token,
            4,
            40,
            HlaeBridgeEvent::CaptureStarted {
                output_directory: take.to_string_lossy().into_owned(),
                observed_tick: 128,
            },
        )
        .expect("capture start");
        assert!(matches!(
            send_bridge(
                &mut session,
                &token,
                5,
                50,
                HlaeBridgeEvent::CaptureStopped {
                    observed_tick: final_tick,
                },
            ),
            Err(HlaeSessionProtocolError::InvalidTick)
        ));
        assert_eq!(session.state(), HlaeSessionState::Failed);
    }
}

#[test]
fn parser_total_and_fixed_seek_target_are_host_authoritative() {
    let (fixture, token, mut session) = test_session(0x48);
    apply_host_handshake(&mut session);
    assert!(matches!(
        send_bridge(
            &mut session,
            &token,
            1,
            10,
            HlaeBridgeEvent::DemoLoaded {
                demo_path: fixture.demo.to_string_lossy().into_owned(),
                current_tick: 64,
                total_ticks: 4_095,
            },
        ),
        Err(HlaeSessionProtocolError::InvalidTick)
    ));

    let (fixture, token, mut session) = test_session(0x49);
    apply_host_handshake(&mut session);
    send_demo_loaded(&fixture, &token, &mut session);
    assert!(matches!(
        send_bridge(
            &mut session,
            &token,
            2,
            20,
            HlaeBridgeEvent::SeekRequested { target_tick: 129 },
        ),
        Err(HlaeSessionProtocolError::InvalidTick)
    ));
}

#[test]
fn capture_cannot_start_until_the_fixed_seek_is_observed_complete() {
    let (fixture, token, mut session) = test_session(0x4a);
    let take = fixture.output.join("take0000");
    fs::create_dir(&take).expect("take");
    apply_host_handshake(&mut session);
    send_demo_loaded(&fixture, &token, &mut session);

    assert!(matches!(
        send_bridge(
            &mut session,
            &token,
            2,
            20,
            HlaeBridgeEvent::CaptureStarted {
                output_directory: take.to_string_lossy().into_owned(),
                observed_tick: 128,
            },
        ),
        Err(HlaeSessionProtocolError::InvalidBridgeTransition)
    ));
    assert_eq!(session.state(), HlaeSessionState::Failed);
}

#[test]
fn message_rate_size_sequence_schema_and_receive_time_are_bounded() {
    let (_fixture, token, mut rate_session) = test_session(0x50);
    apply_host_handshake(&mut rate_session);
    for sequence in 1..=HLAE_SESSION_MAX_MESSAGES_PER_SECOND as u64 {
        send_bridge(
            &mut rate_session,
            &token,
            sequence,
            sequence,
            HlaeBridgeEvent::Heartbeat,
        )
        .expect("inside rate limit");
    }
    let sequence = HLAE_SESSION_MAX_MESSAGES_PER_SECOND as u64 + 1;
    assert!(matches!(
        send_bridge(
            &mut rate_session,
            &token,
            sequence,
            sequence,
            HlaeBridgeEvent::Heartbeat,
        ),
        Err(HlaeSessionProtocolError::RateLimitExceeded { .. })
    ));

    let (_fixture, _token, mut size_session) = test_session(0x51);
    apply_host_handshake(&mut size_session);
    assert!(matches!(
        size_session.ingest_bridge(&vec![b' '; HLAE_SESSION_MAX_MESSAGE_BYTES + 1], 10),
        Err(HlaeSessionProtocolError::MessageTooLarge { .. })
    ));

    let (_fixture, token, mut sequence_session) = test_session(0x52);
    apply_host_handshake(&mut sequence_session);
    assert!(matches!(
        send_bridge(
            &mut sequence_session,
            &token,
            2,
            10,
            HlaeBridgeEvent::Heartbeat,
        ),
        Err(HlaeSessionProtocolError::SequenceMismatch {
            expected: 1,
            actual: 2
        })
    ));

    let (_fixture, _token, mut schema_session) = test_session(0x53);
    apply_host_handshake(&mut schema_session);
    let unknown_schema = format!(
        r#"{{"sessionToken":"{}","sequence":1,"schemaRevision":1,"event":{{"kind":"heartbeat"}}}}"#,
        hex::encode(token_bytes(0x53))
    );
    assert!(matches!(
        schema_session.ingest_bridge(unknown_schema.as_bytes(), 10),
        Err(HlaeSessionProtocolError::Decode(_))
    ));

    let (_fixture, token, mut time_session) = test_session(0x54);
    apply_host_handshake(&mut time_session);
    send_bridge(&mut time_session, &token, 1, 20, HlaeBridgeEvent::Heartbeat)
        .expect("first heartbeat");
    assert!(matches!(
        send_bridge(&mut time_session, &token, 2, 19, HlaeBridgeEvent::Heartbeat,),
        Err(HlaeSessionProtocolError::ReceiveTimeReordered)
    ));
}

#[test]
fn tokens_are_bounded_compared_as_bytes_and_redacted() {
    assert!(matches!(
        SessionToken::try_from_bytes(&[0xab; 15]),
        Err(HlaeSessionProtocolError::TokenTooShort { .. })
    ));
    let first = SessionToken::generate().expect("first token");
    let second = SessionToken::generate().expect("second token");
    assert_ne!(first, second);
    assert!(format!("{first:?}").contains("[REDACTED]"));
    let known = SessionToken::try_from_bytes(&[0xab; 32]).expect("known token");
    let message = HlaeBridgeMessage::new(&known, 1, HlaeBridgeEvent::Heartbeat);
    let message_debug = format!("{message:?}");
    assert!(message_debug.contains("[REDACTED]"));
    assert!(!message_debug.contains(&"ab".repeat(32)));

    let (_fixture, _token, mut session) = test_session(0xab);
    apply_host_handshake(&mut session);
    let uppercase = format!(
        r#"{{"sessionToken":"{}","sequence":1,"event":{{"kind":"heartbeat"}}}}"#,
        "AB".repeat(16)
    );
    assert_eq!(
        session
            .ingest_bridge(uppercase.as_bytes(), 10)
            .expect("same token bytes"),
        HlaeSessionState::HookHandshaking
    );
}

#[test]
fn capture_paths_remain_inside_the_bound_direct_take_directory() {
    let fixture = tempdir().expect("fixture");
    let demo = fixture.path().join("match.dem");
    let root = fixture.path().join("captures");
    let output = root.join("session-1");
    let outside = fixture.path().join("outside");
    fs::write(&demo, b"PBDEMS2").expect("demo");
    fs::create_dir_all(&output).expect("output");
    fs::create_dir(&outside).expect("outside");
    assert!(ValidatedCapturePaths::verify(&demo, &root, &outside).is_err());

    let paths = ValidatedCapturePaths::verify(&demo, &root, &output).expect("paths");
    let token = SessionToken::try_from_bytes(&token_bytes(0x60)).expect("token");
    let mut session = HlaeSessionMachine::new(token.clone(), paths, tick_contract());
    apply_host_handshake(&mut session);
    send_bridge(
        &mut session,
        &token,
        1,
        10,
        HlaeBridgeEvent::DemoLoaded {
            demo_path: demo.to_string_lossy().into_owned(),
            current_tick: 64,
            total_ticks: 4_096,
        },
    )
    .expect("demo");
    send_bridge(
        &mut session,
        &token,
        2,
        20,
        HlaeBridgeEvent::SeekRequested { target_tick: 128 },
    )
    .expect("seek requested");
    send_bridge(
        &mut session,
        &token,
        3,
        30,
        HlaeBridgeEvent::SeekCompleted { current_tick: 128 },
    )
    .expect("seek completed");
    assert!(matches!(
        send_bridge(
            &mut session,
            &token,
            4,
            40,
            HlaeBridgeEvent::CaptureStarted {
                output_directory: outside.to_string_lossy().into_owned(),
                observed_tick: 128,
            },
        ),
        Err(HlaeSessionProtocolError::InvalidPath(_))
    ));
}

#[test]
fn capture_revalidates_demo_and_take_before_accepting_observations() {
    let (fixture, token, mut session) = test_session(0x61);
    let take = fixture.output.join("take0000");
    fs::create_dir(&take).expect("take");
    reach_demo_ready_after_seek(&fixture, &token, &mut session, 128);
    fs::remove_file(&fixture.demo).expect("remove bound demo");
    assert!(matches!(
        send_bridge(
            &mut session,
            &token,
            4,
            40,
            HlaeBridgeEvent::CaptureStarted {
                output_directory: take.to_string_lossy().into_owned(),
                observed_tick: 128,
            },
        ),
        Err(HlaeSessionProtocolError::InvalidPath(_))
    ));

    let (fixture, token, mut session) = test_session(0x62);
    let take = fixture.output.join("take0000");
    fs::create_dir(&take).expect("take");
    reach_demo_ready_after_seek(&fixture, &token, &mut session, 128);
    send_bridge(
        &mut session,
        &token,
        4,
        40,
        HlaeBridgeEvent::CaptureStarted {
            output_directory: take.to_string_lossy().into_owned(),
            observed_tick: 128,
        },
    )
    .expect("capture start");
    fs::remove_dir(&take).expect("remove take");
    assert!(matches!(
        send_bridge(
            &mut session,
            &token,
            5,
            50,
            HlaeBridgeEvent::CaptureStopped { observed_tick: 256 },
        ),
        Err(HlaeSessionProtocolError::InvalidPath(_))
    ));
}

#[test]
fn host_cancel_and_host_or_bridge_failure_have_distinct_authority() {
    let (_fixture, _token, mut cancelled) = test_session(0x70);
    cancelled
        .apply_host_event(HlaeHostEvent::PreparationVerified)
        .expect("prepared");
    assert_eq!(
        cancelled
            .apply_host_event(HlaeHostEvent::CancelRequested)
            .expect("host cancellation"),
        HlaeSessionState::Cancelled
    );

    let (_fixture, _token, mut host_failed) = test_session(0x71);
    host_failed
        .apply_host_event(HlaeHostEvent::FailureReported {
            reason: "job object launch failed".into(),
        })
        .expect("host failure");
    assert_eq!(host_failed.state(), HlaeSessionState::Failed);
    assert_eq!(
        host_failed.failure_reason(),
        Some("job object launch failed")
    );

    let (_fixture, token, mut bridge_failed) = test_session(0x72);
    apply_host_handshake(&mut bridge_failed);
    assert_eq!(
        send_bridge(
            &mut bridge_failed,
            &token,
            1,
            10,
            HlaeBridgeEvent::FailureReported {
                reason: "demo evidence timed out".into(),
            },
        )
        .expect("authenticated bridge failure"),
        HlaeSessionState::Failed
    );
    assert_eq!(
        bridge_failed.failure_reason(),
        Some("demo evidence timed out")
    );
}

#[test]
fn malformed_failure_evidence_fails_closed_without_becoming_a_valid_report() {
    let (_fixture, token, mut session) = test_session(0x75);
    apply_host_handshake(&mut session);

    assert!(matches!(
        send_bridge(
            &mut session,
            &token,
            1,
            10,
            HlaeBridgeEvent::FailureReported {
                reason: "\n".into(),
            },
        ),
        Err(HlaeSessionProtocolError::InvalidFailureReason)
    ));
    assert_eq!(session.state(), HlaeSessionState::Failed);
}

#[test]
fn loader_pid_and_externally_bound_game_pid_are_not_conflated() {
    let (_fixture, _token, mut session) = test_session(0x73);
    session
        .apply_host_event(HlaeHostEvent::PreparationVerified)
        .expect("prepared");
    session
        .apply_host_event(HlaeHostEvent::LaunchRequested)
        .expect("launch");
    session
        .apply_host_event(HlaeHostEvent::LoaderStarted { process_id: 7300 })
        .expect("loader");
    assert_eq!(
        session
            .apply_host_event(HlaeHostEvent::GameHookAuthenticated {
                game_process_id: 7400,
            })
            .expect("separate game pid"),
        HlaeSessionState::HookHandshaking
    );
}

#[test]
fn bridge_messages_are_rejected_until_the_game_process_is_externally_bound() {
    let (_fixture, token, mut session) = test_session(0x74);
    for event in [
        HlaeHostEvent::PreparationVerified,
        HlaeHostEvent::LaunchRequested,
        HlaeHostEvent::LoaderStarted { process_id: 7300 },
    ] {
        session.apply_host_event(event).expect("host event");
    }

    assert!(matches!(
        send_bridge(&mut session, &token, 1, 10, HlaeBridgeEvent::Heartbeat,),
        Err(HlaeSessionProtocolError::InvalidHandshake)
    ));
    assert_eq!(session.state(), HlaeSessionState::Failed);
}

struct SessionFixture {
    _directory: TempDir,
    demo: PathBuf,
    output: PathBuf,
}

fn test_session(seed: u8) -> (SessionFixture, SessionToken, HlaeSessionMachine) {
    let directory = tempdir().expect("fixture");
    let demo = directory.path().join("match.dem");
    let output_root = directory.path().join("captures");
    let output = output_root.join("session-1");
    fs::write(&demo, b"PBDEMS2").expect("demo");
    fs::create_dir_all(&output).expect("managed output");
    let paths = ValidatedCapturePaths::verify(&demo, &output_root, &output).expect("paths");
    let token = SessionToken::try_from_bytes(&token_bytes(seed)).expect("token");
    let session = HlaeSessionMachine::new(token.clone(), paths, tick_contract());
    (
        SessionFixture {
            _directory: directory,
            demo,
            output,
        },
        token,
        session,
    )
}

fn player_pov_test_session(seed: u8) -> (SessionFixture, SessionToken, HlaeSessionMachine) {
    let directory = tempdir().expect("fixture");
    let demo = directory.path().join("match.dem");
    let output_root = directory.path().join("captures");
    let output = output_root.join("session-1");
    fs::write(&demo, b"PBDEMS2").expect("demo");
    fs::create_dir_all(&output).expect("managed output");
    let paths = ValidatedCapturePaths::verify(&demo, &output_root, &output).expect("paths");
    let token = SessionToken::try_from_bytes(&token_bytes(seed)).expect("token");
    let observer =
        CaptureObserverContract::try_new("76561197960690195", 7).expect("observer contract");
    let session =
        HlaeSessionMachine::new_with_observer(token.clone(), paths, tick_contract(), observer);
    (
        SessionFixture {
            _directory: directory,
            demo,
            output,
        },
        token,
        session,
    )
}

fn token_bytes(seed: u8) -> [u8; 16] {
    [seed; 16]
}

fn tick_contract() -> CaptureTickContract {
    CaptureTickContract::try_new(4_096, 128, 128, 256, 4, 4).expect("tick contract")
}

fn apply_host_handshake(session: &mut HlaeSessionMachine) {
    for event in [
        HlaeHostEvent::PreparationVerified,
        HlaeHostEvent::LaunchRequested,
        HlaeHostEvent::LoaderStarted { process_id: 7300 },
        HlaeHostEvent::GameHookAuthenticated {
            game_process_id: 7400,
        },
    ] {
        session.apply_host_event(event).expect("host event");
    }
}

fn send_bridge(
    session: &mut HlaeSessionMachine,
    token: &SessionToken,
    sequence: u64,
    received_at_ms: u64,
    event: HlaeBridgeEvent,
) -> Result<HlaeSessionState, HlaeSessionProtocolError> {
    let bytes = HlaeBridgeMessage::new(token, sequence, event)
        .encode()
        .expect("message");
    session.ingest_bridge(&bytes, received_at_ms)
}

fn send_demo_loaded(
    fixture: &SessionFixture,
    token: &SessionToken,
    session: &mut HlaeSessionMachine,
) {
    send_bridge(
        session,
        token,
        1,
        10,
        HlaeBridgeEvent::DemoLoaded {
            demo_path: fixture.demo.to_string_lossy().into_owned(),
            current_tick: 64,
            total_ticks: 4_096,
        },
    )
    .expect("demo loaded");
}

#[allow(clippy::too_many_arguments)]
fn capture_player_pov_take(
    session: &mut HlaeSessionMachine,
    token: &SessionToken,
    first_sequence: u64,
    first_arrival_ms: u64,
    seek_tick: u32,
    capture_start_tick: u32,
    capture_end_tick: u32,
    steam_id64: &str,
    take_directory: &std::path::Path,
) {
    for (offset, event) in [
        HlaeBridgeEvent::SeekRequested {
            target_tick: seek_tick,
        },
        HlaeBridgeEvent::SeekCompleted {
            current_tick: seek_tick,
        },
        HlaeBridgeEvent::ObserverVerified {
            steam_id64: steam_id64.to_owned(),
            observer_mode: CS2_OBSERVER_MODE_IN_EYE,
            observed_tick: capture_start_tick,
        },
        HlaeBridgeEvent::CaptureStarted {
            output_directory: take_directory.to_string_lossy().into_owned(),
            observed_tick: capture_start_tick,
        },
        HlaeBridgeEvent::ObserverVerified {
            steam_id64: steam_id64.to_owned(),
            observer_mode: CS2_OBSERVER_MODE_IN_EYE,
            observed_tick: capture_end_tick,
        },
        HlaeBridgeEvent::CaptureStopped {
            observed_tick: capture_end_tick,
        },
    ]
    .into_iter()
    .enumerate()
    {
        let offset = u64::try_from(offset).expect("bounded event offset");
        send_bridge(
            session,
            token,
            first_sequence + offset,
            first_arrival_ms + offset * 10,
            event,
        )
        .expect("valid independent take event");
    }
    assert_eq!(session.state(), HlaeSessionState::Finalizing);
}

fn reach_demo_ready_after_seek(
    fixture: &SessionFixture,
    token: &SessionToken,
    session: &mut HlaeSessionMachine,
    completed_tick: u32,
) {
    apply_host_handshake(session);
    send_demo_loaded(fixture, token, session);
    send_bridge(
        session,
        token,
        2,
        20,
        HlaeBridgeEvent::SeekRequested { target_tick: 128 },
    )
    .expect("seek requested");
    send_bridge(
        session,
        token,
        3,
        30,
        HlaeBridgeEvent::SeekCompleted {
            current_tick: completed_tick,
        },
    )
    .expect("seek completed");
}
