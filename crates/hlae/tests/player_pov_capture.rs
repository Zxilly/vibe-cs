use std::fs;

use tempfile::TempDir;
use vibe_cs_hlae::{
    CaptureLayers, CaptureSettings, HlaeHudVisibility, HlaePlayerPovCapturePlan,
    HlaePlayerPovPresentation, HlaeRadarVisibility, HlaeVoicePolicy,
    compile_hlae_player_pov_capture,
};

fn fixture() -> (TempDir, HlaePlayerPovCapturePlan) {
    let root = TempDir::new().expect("temporary root");
    let demo_path = root.path().join("major.dem");
    let output_directory = root.path().join("capture");
    fs::write(&demo_path, b"HL2DEMO fixture").expect("demo fixture");
    fs::create_dir(&output_directory).expect("capture root");
    (
        root,
        HlaePlayerPovCapturePlan {
            demo_path,
            output_directory,
            player_id: "76561197960690195".to_owned(),
            spectator_slot: 7,
            start_tick: 160_986,
            end_tick: 161_310,
            pre_roll_ticks: 128,
            tick_rate: 64.0,
            capture: CaptureSettings {
                fps: 60,
                width: 1_920,
                height: 1_080,
                record_wav: true,
                layers: CaptureLayers::default(),
            },
            presentation: HlaePlayerPovPresentation::default(),
        },
    )
}

#[test]
fn compiles_a_bounded_player_pov_program_without_fake_camera_artifacts() {
    let (root, plan) = fixture();
    let artifact_directory = root.path().join("job");
    fs::create_dir(&artifact_directory).expect("artifact root");

    let compiled = compile_hlae_player_pov_capture(&plan, &artifact_directory)
        .expect("player POV program should compile");

    assert_eq!(compiled.demo_path(), plan.demo_path);
    assert_eq!(compiled.output_directory(), plan.output_directory);
    assert_eq!(compiled.player_id(), "76561197960690195");
    assert_eq!(compiled.spectator_slot(), 7);
    assert_eq!(compiled.seek_tick(), 160_858);
    assert_eq!(compiled.setup_tick(), 160_859);
    assert_eq!(compiled.first_tick(), 160_986);
    assert_eq!(compiled.last_tick(), 161_310);
    assert_eq!(compiled.capture(), &plan.capture);
    assert_eq!(
        compiled.command_system().path,
        artifact_directory.join("vibe_cs_commands.xml")
    );
    assert!(compiled.camera_paths().is_empty());
    assert!(compiled.resource_estimate().maximum_frame_count >= 303);
    assert!(
        compiled
            .persistent_commands()
            .observer_setup()
            .contains("spec_mode 2")
    );
    assert!(
        !compiled
            .persistent_commands()
            .observer_setup()
            .contains("spec_player")
    );
    assert!(
        compiled
            .persistent_commands()
            .capture_start()
            .contains("mirv_streams record start")
    );
    assert!(
        compiled
            .persistent_commands()
            .capture_stop()
            .contains("mirv_streams record end; demo_pause")
    );

    let xml = &compiled.command_system().contents;
    assert!(xml.contains("<c tick=\"160859\"><body>"));
    assert!(xml.contains("spec_mode 2; spec_player 7"));
    assert_eq!(xml.matches("spec_mode 2").count(), 1);
    assert_eq!(xml.matches("spec_player 7").count(), 1);
    assert!(xml.contains("demo_ui_mode 0; gameui_hide; cl_showdemooverlay 0"));
    assert!(xml.contains("mirv_streams record screen enabled 1"));
    assert!(xml.contains("mirv_streams record startMovieWav 1"));
    assert!(xml.contains("mirv_streams record start"));
    assert!(xml.contains("cl_drawhud_force_radar 1"));
    assert!(xml.contains("cl_drawhud 1; cl_draw_only_deathnotices 0"));
    assert!(xml.contains("tv_listen_voice_indices -1"));
    assert!(xml.contains("tv_listen_voice_indices_h -1"));
    assert!(xml.contains("mirv_streams record end; demo_pause"));
    assert!(xml.contains("<c tick=\"161310\"><body>mirv_streams record end"));
    assert!(!xml.contains("mirv_campath load"));
    assert!(!xml.contains("<campath"));
}

#[test]
fn compiles_verified_presentation_settings_into_the_closed_capture_program() {
    let (root, mut plan) = fixture();
    let artifact_directory = root.path().join("job");
    fs::create_dir(&artifact_directory).expect("artifact root");
    plan.presentation.radar = HlaeRadarVisibility::Hidden;
    plan.presentation.hud = HlaeHudVisibility::DeathNoticesOnly;
    plan.presentation.camera_fov = 105.0;
    plan.presentation.viewmodel_fov = 60.0;
    plan.presentation.flash_alpha = 96;
    plan.presentation.voice = HlaeVoicePolicy::Muted;

    let compiled = compile_hlae_player_pov_capture(&plan, &artifact_directory)
        .expect("bounded HLAE presentation should compile");
    let xml = &compiled.command_system().contents;

    assert!(xml.contains("cl_drawhud_force_radar -1"));
    assert!(xml.contains("cl_drawhud 1; cl_draw_only_deathnotices 1"));
    assert!(xml.contains("mirv_fov 105"));
    assert!(xml.contains("mirv_fov handleZoom enabled 1"));
    assert!(xml.contains("mirv_viewmodel set * * * 60 *"));
    assert!(xml.contains("mirv_viewmodel enabled 1"));
    assert!(xml.contains("mirv_noflash"));
    assert!(xml.contains("snd_voipvolume 0"));
    assert!(xml.contains("mirv_fov default"));
    assert!(xml.contains("mirv_viewmodel enabled 0"));
}

#[test]
fn rejects_untrusted_player_commands_and_unsupported_capture_layers() {
    let (root, mut plan) = fixture();
    let artifact_directory = root.path().join("job");
    fs::create_dir(&artifact_directory).expect("artifact root");

    plan.player_id = "76561197960690195;quit".to_owned();
    assert!(compile_hlae_player_pov_capture(&plan, &artifact_directory).is_err());

    plan.player_id = "player-1".to_owned();
    assert!(compile_hlae_player_pov_capture(&plan, &artifact_directory).is_err());

    plan.player_id = "76561197960690195".to_owned();
    plan.spectator_slot = 0;
    assert!(compile_hlae_player_pov_capture(&plan, &artifact_directory).is_err());

    plan.spectator_slot = 7;
    plan.capture.layers.world = true;
    let error = compile_hlae_player_pov_capture(&plan, &artifact_directory)
        .expect_err("the current native POV contract must fail closed for auxiliary layers");
    assert_eq!(
        error.to_string(),
        "invalid HLAE plan: managed player POV capture is screen-only"
    );
}

#[test]
fn rejects_invalid_ticks_dimensions_and_missing_inputs() {
    let (root, mut plan) = fixture();
    let artifact_directory = root.path().join("job");
    fs::create_dir(&artifact_directory).expect("artifact root");

    plan.start_tick = plan.end_tick;
    assert!(compile_hlae_player_pov_capture(&plan, &artifact_directory).is_err());

    plan.start_tick = 160_986;
    plan.pre_roll_ticks = 1;
    assert!(compile_hlae_player_pov_capture(&plan, &artifact_directory).is_err());

    plan.pre_roll_ticks = 128;
    plan.capture.width = 1_919;
    assert!(compile_hlae_player_pov_capture(&plan, &artifact_directory).is_err());

    plan.capture.width = 1_920;
    fs::remove_file(&plan.demo_path).expect("remove demo fixture");
    assert!(compile_hlae_player_pov_capture(&plan, &artifact_directory).is_err());
}
