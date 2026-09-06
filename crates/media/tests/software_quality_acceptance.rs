//! Real native-encoder regression: the quality slider must constrain distortion,
//! rather than cap every resolution and frame rate at the same small bitrate.

use std::{collections::HashMap, io::Write as _, path::Path};

use serde_json::json;
use uuid::Uuid;
use vibe_cs_domain::Project;
use vibe_cs_media::{
    EditorMediaKind, EditorMediaSource, EditorRenderOptions, EncoderSelection, ProcessCancellation,
    build_project_plan_with_sources, execute_native_filter_plan,
};

const WIDTH: usize = 640;
const HEIGHT: usize = 360;
const FRAMES: usize = 30;

#[tokio::test]
async fn software_quality_preserves_high_detail_frames_without_a_fixed_bitrate_ceiling() {
    let directory = tempfile::tempdir().unwrap();
    let source = directory.path().join("detail.y4m");
    let mut file = std::io::BufWriter::new(std::fs::File::create(&source).unwrap());
    writeln!(file, "YUV4MPEG2 W{WIDTH} H{HEIGHT} F60:1 Ip A1:1 C420jpeg").unwrap();
    for index in 0..FRAMES {
        file.write_all(b"FRAME\n").unwrap();
        file.write_all(&luma_frame(index)).unwrap();
        file.write_all(&vec![128; WIDTH * HEIGHT / 2]).unwrap();
    }
    file.flush().unwrap();
    let asset_id = Uuid::new_v4();
    let story_id = Uuid::new_v4();
    let project: Project = serde_json::from_value(json!({
        "id":Uuid::new_v4(),"name":"Software quality calibration","revision":1,
        "document":{"width":WIDTH,"height":HEIGHT,"fps":60,"duration_seconds":0.5,
            "story_track_id":story_id,"tracks":[{
                "id":story_id,"name":"Story","kind":"video","order":0,"muted":false,"solo":false,
                "volume":1.0,"pan":0.0,"keyframes":[],"locked":false,"hidden":false,"clips":[{
                    "id":Uuid::new_v4(),"name":"High detail","capture_intent":null,
                    "material":{"kind":"asset","asset_id":asset_id,"media_duration_seconds":0.5},
                    "placement":{"start":0.0,"duration":0.5,"source_in":0.0,"source_out":0.5,
                        "speed":1.0,"reverse":false,"frame_hold_source_time":null,"volume":0.0,"pan":0.0,"enabled":true},
                    "transform":{"x":0.0,"y":0.0,"scale_x":1.0,"scale_y":1.0,"rotation":0.0,"opacity":1.0},
                    "effects":[],"transitions":{"video_in":null,"video_out":null,"audio_in":null,"audio_out":null},
                    "text":null,"metadata":{},"group_id":null,"link_group_id":null,"keyframes":[],"speed_segments":[]
                }]
            }],"markers":[],"settings":{"source_demo_ids":[],"ripple_sequence_markers":false,"use_media_proxies":false}},
        "created_at":chrono::Utc::now(),"updated_at":chrono::Utc::now()
    })).unwrap();
    let sources = HashMap::from([(
        asset_id.to_string(),
        EditorMediaSource {
            path: source,
            kind: EditorMediaKind::Video,
            has_audio: false,
        },
    )]);
    let mut scores = Vec::new();
    for quality in [20, 80] {
        let output = directory.path().join(format!("quality-{quality}.mp4"));
        let plan = build_project_plan_with_sources(
            &project,
            &sources,
            &output,
            &EditorRenderOptions {
                encoder: EncoderSelection {
                    primary: "libopenh264".to_owned(),
                    fallback: None,
                },
                quality,
                range_start: None,
                range_end: None,
            },
        )
        .unwrap();
        execute_native_filter_plan(&plan, &ProcessCancellation::default())
            .await
            .unwrap();
        scores.push(decoded_luma_psnr(&output));
    }
    println!("software quality 20/80 luma PSNR: {scores:?}");
    assert!(
        scores[1] > 40.0,
        "quality 80 must retain luma detail: {scores:?}"
    );
    assert!(
        scores[1] > scores[0] + 8.0,
        "quality must control actual distortion: {scores:?}"
    );
}

fn luma_frame(index: usize) -> Vec<u8> {
    let mut state = u32::try_from(index).unwrap() + 1;
    (0..WIDTH * HEIGHT)
        .map(|_| {
            state = state.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
            16 + u8::try_from((state >> 16) % 220).unwrap()
        })
        .collect()
}

fn decoded_luma_psnr(path: &Path) -> f64 {
    let mut input = ffmpeg_next::format::input(path).unwrap();
    let stream = input
        .streams()
        .best(ffmpeg_next::media::Type::Video)
        .unwrap();
    let index = stream.index();
    let mut decoder = ffmpeg_next::codec::context::Context::from_parameters(stream.parameters())
        .unwrap()
        .decoder()
        .video()
        .unwrap();
    let mut count = 0;
    let mut squared_error = 0.0;
    let mut frame = ffmpeg_next::frame::Video::empty();
    let mut receive = |decoder: &mut ffmpeg_next::decoder::Video| {
        while decoder.receive_frame(&mut frame).is_ok() {
            let reference = luma_frame(count);
            for y in 0..HEIGHT {
                for x in 0..WIDTH {
                    let error = f64::from(reference[y * WIDTH + x])
                        - f64::from(frame.data(0)[y * frame.stride(0) + x]);
                    squared_error += error * error;
                }
            }
            count += 1;
        }
    };
    for (stream, packet) in input.packets() {
        if stream.index() == index {
            decoder.send_packet(&packet).unwrap();
            receive(&mut decoder);
        }
    }
    decoder.send_eof().unwrap();
    receive(&mut decoder);
    assert_eq!(count, FRAMES, "encoding must preserve every frame");
    let samples = f64::from(u32::try_from(FRAMES * WIDTH * HEIGHT).unwrap());
    10.0 * (255.0 * 255.0 / (squared_error / samples)).log10()
}
