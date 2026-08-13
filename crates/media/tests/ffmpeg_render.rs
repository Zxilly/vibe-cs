use std::{collections::HashMap, path::Path};

use chrono::Utc;
use ez_ffmpeg::{FfmpegContext, Input, Output};
use serde_json::Value;
use uuid::Uuid;
use vibe_cs_domain::{
    EditorClip, EditorKeyframe, EditorKeyframeProperty, EditorProject, EditorSpeedSegment,
    EditorTrack, MontageClip, MontageProject, MontageSettings, TextStyle, TrackKind, Transform,
};
use vibe_cs_media::{
    EditorMediaKind, EditorMediaSource, EditorRenderOptions, EncoderSelection, MontageSource,
    ProcessCancellation, build_audio_extraction_plan, build_editor_plan_with_sources,
    build_montage_plan_with_sources, execute_native_filter_plan, native_probe_media,
};

fn generate_source(output: &Path, color: &str) {
    let context = FfmpegContext::builder()
        .input(Input::from(format!("color=c={color}:s=320x180:r=30:d=2")).set_format("lavfi"))
        .input(Input::from("sine=frequency=440:sample_rate=48000:duration=2").set_format("lavfi"))
        .output(
            Output::from(output.to_string_lossy().into_owned())
                .set_video_codec("libopenh264")
                .set_audio_codec("aac")
                .set_pix_fmt("yuv420p")
                .set_shortest(true),
        )
        .build()
        .expect("source context");
    context
        .start()
        .expect("source scheduler")
        .wait()
        .expect("generate source");
}

fn generate_image(output: &Path) {
    let context = FfmpegContext::builder()
        .input(Input::from("color=c=green:s=96x96:d=0.1").set_format("lavfi"))
        .output(Output::from(output.to_string_lossy().into_owned()).set_max_video_frames(Some(1)))
        .build()
        .expect("image context");
    context
        .start()
        .expect("image scheduler")
        .wait()
        .expect("generate image");
}

#[tokio::test]
async fn renders_real_montage_and_editor_graphs() {
    let root = tempfile::tempdir().expect("temporary directory");
    let first = root.path().join("first.mp4");
    let second = root.path().join("second.mp4");
    let image = root.path().join("overlay.bmp");
    generate_source(&first, "red");
    generate_source(&second, "blue");
    generate_image(&image);
    let separated_audio = root.path().join("separated.m4a");
    let audio_plan =
        build_audio_extraction_plan(&first, &separated_audio, 2.0).expect("audio plan");
    execute_native_filter_plan(&audio_plan, &ProcessCancellation::default())
        .await
        .expect("audio extraction");
    let separated_probe = native_probe_media(&separated_audio, &ProcessCancellation::default())
        .expect("probe separated audio");
    assert!(
        separated_probe
            .streams
            .iter()
            .any(|stream| stream.kind == "audio")
    );
    assert!(
        separated_probe
            .streams
            .iter()
            .all(|stream| stream.kind != "video")
    );

    let first_id = Uuid::new_v4();
    let second_id = Uuid::new_v4();
    let now = Utc::now();
    let montage = MontageProject {
        id: Uuid::new_v4(),
        name: "Real montage".to_owned(),
        clips: vec![
            MontageClip {
                clip_id: first_id,
                order: 0,
                trim_start: 0.1,
                trim_end: Some(1.8),
                transition: "cut".to_owned(),
                title: Some("First player's ace".to_owned()),
                avatar_asset_id: None,
            },
            MontageClip {
                clip_id: second_id,
                order: 1,
                trim_start: 0.0,
                trim_end: Some(1.7),
                transition: "glitch".to_owned(),
                title: Some("Second; safe [title]".to_owned()),
                avatar_asset_id: None,
            },
        ],
        settings: MontageSettings {
            width: 640,
            height: 360,
            fps: 30,
            encoder: "libopenh264".to_owned(),
            quality: 70,
            background_music: Some(first.to_string_lossy().into_owned()),
            music_volume: 0.2,
            transition_seconds: 0.25,
            intro_title: Some("VIBE NIGHT".to_owned()),
            intro_duration_seconds: 0.5,
            include_name_cards: true,
            outro_title: Some("Thanks".to_owned()),
            outro_duration_seconds: 0.5,
            branding_theme: vibe_cs_domain::MontageBrandingTheme::Neon,
            ..MontageSettings::default()
        },
        created_at: now,
        updated_at: now,
    };
    let sources = HashMap::from([
        (
            first_id.to_string(),
            MontageSource {
                path: first.clone(),
                duration_seconds: Some(2.0),
                has_audio: true,
                avatar_path: None,
            },
        ),
        (
            second_id.to_string(),
            MontageSource {
                path: second.clone(),
                duration_seconds: Some(2.0),
                has_audio: true,
                avatar_path: None,
            },
        ),
    ]);
    let montage_output = root.path().join("montage.mp4");
    let montage_plan = build_montage_plan_with_sources(
        &montage,
        &sources,
        &montage_output,
        &EncoderSelection {
            primary: "libopenh264".to_owned(),
            fallback: None,
        },
    )
    .expect("montage plan");
    execute_native_filter_plan(&montage_plan, &ProcessCancellation::default())
        .await
        .expect("montage render");

    let video_clip_id = Uuid::new_v4();
    let audio_clip_id = Uuid::new_v4();
    let image_clip_id = Uuid::new_v4();
    let mut editor = EditorProject {
        id: Uuid::new_v4(),
        name: "Real editor".to_owned(),
        width: 640,
        height: 360,
        fps: 30,
        duration_seconds: 1.5,
        tracks: vec![
            EditorTrack {
                id: Uuid::new_v4(),
                name: "Video".to_owned(),
                kind: TrackKind::Video,
                order: 0,
                muted: false,
                locked: false,
                hidden: false,
                clips: vec![EditorClip {
                    id: Uuid::new_v4(),
                    asset_id: Some(video_clip_id),
                    name: "Video".to_owned(),
                    start: 0.0,
                    duration: 1.5,
                    source_in: 0.2,
                    source_out: 1.7,
                    speed: 1.0,
                    volume: 0.7,
                    transform: Transform {
                        scale_x: 0.9,
                        scale_y: 0.9,
                        rotation: 0.0,
                        opacity: 0.9,
                        ..Transform::default()
                    },
                    effects: vec![vibe_cs_domain::EditorEffect {
                        id: "color".to_owned(),
                        kind: "color_adjust".to_owned(),
                        enabled: true,
                        parameters: serde_json::json!({
                            "brightness": 0.05,
                            "contrast": 1.1,
                            "saturation": 0.9
                        }),
                    }],
                    transition_in: Some("flash".to_owned()),
                    transition_out: Some("dip".to_owned()),
                    text: None,
                    metadata: serde_json::json!({"transition_duration": 0.2}),
                    group_id: None,
                    link_group_id: None,
                    keyframes: vec![
                        EditorKeyframe {
                            id: Uuid::new_v4(),
                            time: 0.0,
                            property: EditorKeyframeProperty::X,
                            value: -40.0,
                        },
                        EditorKeyframe {
                            id: Uuid::new_v4(),
                            time: 0.0,
                            property: EditorKeyframeProperty::ScaleX,
                            value: 0.75,
                        },
                        EditorKeyframe {
                            id: Uuid::new_v4(),
                            time: 0.0,
                            property: EditorKeyframeProperty::ScaleY,
                            value: 0.75,
                        },
                        EditorKeyframe {
                            id: Uuid::new_v4(),
                            time: 0.0,
                            property: EditorKeyframeProperty::Opacity,
                            value: 0.4,
                        },
                        EditorKeyframe {
                            id: Uuid::new_v4(),
                            time: 0.0,
                            property: EditorKeyframeProperty::Volume,
                            value: 0.2,
                        },
                        EditorKeyframe {
                            id: Uuid::new_v4(),
                            time: 1.5,
                            property: EditorKeyframeProperty::X,
                            value: 40.0,
                        },
                        EditorKeyframe {
                            id: Uuid::new_v4(),
                            time: 1.5,
                            property: EditorKeyframeProperty::ScaleX,
                            value: 1.0,
                        },
                        EditorKeyframe {
                            id: Uuid::new_v4(),
                            time: 1.5,
                            property: EditorKeyframeProperty::ScaleY,
                            value: 1.0,
                        },
                        EditorKeyframe {
                            id: Uuid::new_v4(),
                            time: 1.5,
                            property: EditorKeyframeProperty::Opacity,
                            value: 0.9,
                        },
                        EditorKeyframe {
                            id: Uuid::new_v4(),
                            time: 1.5,
                            property: EditorKeyframeProperty::Volume,
                            value: 0.7,
                        },
                    ],
                    speed_segments: vec![
                        EditorSpeedSegment {
                            id: Uuid::new_v4(),
                            start: 0.0,
                            end: 0.75,
                            speed: 0.5,
                        },
                        EditorSpeedSegment {
                            id: Uuid::new_v4(),
                            start: 0.75,
                            end: 1.5,
                            speed: 1.5,
                        },
                    ],
                }],
            },
            EditorTrack {
                id: Uuid::new_v4(),
                name: "Audio".to_owned(),
                kind: TrackKind::Audio,
                order: 1,
                muted: false,
                locked: false,
                hidden: false,
                clips: vec![EditorClip {
                    id: Uuid::new_v4(),
                    asset_id: Some(audio_clip_id),
                    name: "Music".to_owned(),
                    start: 0.0,
                    duration: 1.5,
                    source_in: 0.2,
                    source_out: 1.7,
                    speed: 1.0,
                    volume: 0.7,
                    transform: Transform::default(),
                    effects: Vec::new(),
                    transition_in: None,
                    transition_out: None,
                    text: None,
                    metadata: serde_json::json!({"separated": true}),
                    group_id: None,
                    link_group_id: None,
                    keyframes: Vec::new(),
                    speed_segments: vec![
                        EditorSpeedSegment {
                            id: Uuid::new_v4(),
                            start: 0.0,
                            end: 0.75,
                            speed: 0.5,
                        },
                        EditorSpeedSegment {
                            id: Uuid::new_v4(),
                            start: 0.75,
                            end: 1.5,
                            speed: 1.5,
                        },
                    ],
                }],
            },
            EditorTrack {
                id: Uuid::new_v4(),
                name: "Overlay".to_owned(),
                kind: TrackKind::Overlay,
                order: 2,
                muted: false,
                locked: false,
                hidden: false,
                clips: vec![EditorClip {
                    id: Uuid::new_v4(),
                    asset_id: Some(image_clip_id),
                    name: "Badge".to_owned(),
                    start: 0.35,
                    duration: 0.8,
                    source_in: 0.0,
                    source_out: 0.8,
                    speed: 1.0,
                    volume: 0.0,
                    transform: Transform {
                        x: 180.0,
                        y: -80.0,
                        scale_x: 0.5,
                        scale_y: 0.5,
                        opacity: 0.8,
                        ..Transform::default()
                    },
                    effects: Vec::new(),
                    transition_in: Some("fade".to_owned()),
                    transition_out: Some("fade".to_owned()),
                    text: None,
                    metadata: serde_json::json!({"transition_duration": 0.1}),
                    group_id: None,
                    link_group_id: None,
                    keyframes: vec![
                        EditorKeyframe {
                            id: Uuid::new_v4(),
                            time: 0.0,
                            property: EditorKeyframeProperty::Rotation,
                            value: -8.0,
                        },
                        EditorKeyframe {
                            id: Uuid::new_v4(),
                            time: 0.8,
                            property: EditorKeyframeProperty::Rotation,
                            value: 8.0,
                        },
                    ],
                    speed_segments: Vec::new(),
                }],
            },
            EditorTrack {
                id: Uuid::new_v4(),
                name: "Text".to_owned(),
                kind: TrackKind::Text,
                order: 3,
                muted: false,
                locked: false,
                hidden: false,
                clips: vec![EditorClip {
                    id: Uuid::new_v4(),
                    asset_id: None,
                    name: "Title".to_owned(),
                    start: 0.25,
                    duration: 0.75,
                    source_in: 0.0,
                    source_out: 0.75,
                    speed: 1.0,
                    volume: 0.0,
                    transform: Transform {
                        y: 90.0,
                        ..Transform::default()
                    },
                    effects: Vec::new(),
                    transition_in: None,
                    transition_out: None,
                    text: Some(TextStyle {
                        content: "Round winner; [safe]".to_owned(),
                        font_family: "Arial".to_owned(),
                        font_asset_id: None,
                        font_size: 28.0,
                        color: "#FFFFFF".to_owned(),
                        background: Some("#000000".to_owned()),
                        align: "center".to_owned(),
                    }),
                    metadata: Value::Null,
                    group_id: None,
                    link_group_id: None,
                    keyframes: Vec::new(),
                    speed_segments: Vec::new(),
                }],
            },
        ],
        markers: Vec::new(),
        settings: Value::Null,
        revision: 1,
        created_at: now,
        updated_at: now,
    };
    editor.tracks[0].clips[0].volume = 0.0;
    editor.tracks[0].clips[0]
        .keyframes
        .retain(|keyframe| keyframe.property != EditorKeyframeProperty::Volume);
    let assets = HashMap::from([
        (
            video_clip_id.to_string(),
            EditorMediaSource {
                path: first,
                kind: EditorMediaKind::Video,
                has_audio: true,
            },
        ),
        (
            audio_clip_id.to_string(),
            EditorMediaSource {
                path: separated_audio,
                kind: EditorMediaKind::Audio,
                has_audio: true,
            },
        ),
        (
            image_clip_id.to_string(),
            EditorMediaSource {
                path: image,
                kind: EditorMediaKind::Image,
                has_audio: false,
            },
        ),
    ]);
    let editor_output = root.path().join("editor.mp4");
    let editor_plan = build_editor_plan_with_sources(
        &editor,
        &assets,
        &editor_output,
        &EditorRenderOptions {
            encoder: EncoderSelection {
                primary: "libopenh264".to_owned(),
                fallback: None,
            },
            quality: 75,
            range_start: Some(0.2),
            range_end: Some(1.4),
        },
    )
    .expect("editor plan");
    execute_native_filter_plan(&editor_plan, &ProcessCancellation::default())
        .await
        .expect("editor render");

    for transition in [
        "flash", "dip", "zoom", "wipe", "slide", "blur", "glitch", "spin",
    ] {
        let mut variant = editor.clone();
        for clip in variant
            .tracks
            .iter_mut()
            .flat_map(|track| track.clips.iter_mut())
        {
            clip.transition_in = None;
            clip.transition_out = None;
        }
        variant.tracks[0].clips[0].transition_in = Some(transition.to_owned());
        let output = root.path().join(format!("editor-{transition}.mp4"));
        let plan = build_editor_plan_with_sources(
            &variant,
            &assets,
            &output,
            &EditorRenderOptions {
                encoder: EncoderSelection {
                    primary: "libopenh264".to_owned(),
                    fallback: None,
                },
                quality: 60,
                range_start: None,
                range_end: None,
            },
        )
        .unwrap_or_else(|error| panic!("{transition} plan: {error}"));
        execute_native_filter_plan(&plan, &ProcessCancellation::default())
            .await
            .unwrap_or_else(|error| panic!("{transition} render: {error}"));
    }

    for output in [montage_output, editor_output] {
        let probe =
            native_probe_media(&output, &ProcessCancellation::default()).expect("probe output");
        assert!(probe.streams.iter().any(|stream| stream.kind == "video"));
        assert!(probe.streams.iter().any(|stream| stream.kind == "audio"));
        assert!(
            probe
                .duration_seconds
                .is_some_and(|duration| duration > 1.0)
        );
    }
}
