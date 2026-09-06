//! End-to-end native encoding over the production Project export plan.
//! Inputs are synthetic calibration media, not CS2 recording evidence.

use std::{collections::HashMap, io::Write as _, path::Path, time::Instant};

use serde_json::{Value, json};
use uuid::Uuid;
use vibe_cs_domain::Project;
use vibe_cs_media::{
    EditorMediaKind, EditorMediaSource, EditorRenderOptions, EncoderSelection, ProcessCancellation,
    ThumbnailOptions, WaveformOptions, build_project_plan_with_sources, execute_native_filter_plan,
    generate_native_thumbnail, generate_native_waveform, native_probe_media,
};

const WIDTH: usize = 320;
const HEIGHT: usize = 180;
const FPS: usize = 30;

#[cfg(windows)]
#[tokio::test]
async fn exports_chinese_text_with_an_imported_truetype_font() {
    let directory = tempfile::Builder::new()
        .prefix("vibe-cs-chinese-font-")
        .tempdir()
        .unwrap();
    let root = directory.path();
    let font_path =
        std::fs::canonicalize("C:/Windows/Fonts/simhei.ttf").expect("Windows SimHei font");
    let font_id = Uuid::new_v4();
    let story_id = Uuid::new_v4();
    let mut title = clip(font_id, 0.0, 1.0, 0.0, 0.0);
    title["material"] = json!({"kind":"planned"});
    title["text"] = json!({"content":"中文高光 · NiKo","font_family":"SimHei",
        "font_asset_id":font_id,"font_size":32.0,"color":"#FFFFFF","background":null,"align":"center"});
    let project: Project = serde_json::from_value(json!({
        "id":Uuid::new_v4(),"name":"Chinese custom font acceptance","revision":1,
        "document":{"width":WIDTH,"height":HEIGHT,"fps":FPS,"duration_seconds":1.0,
            "story_track_id":story_id,
            "tracks":[track(story_id,"Story","video",0,&[]),track(Uuid::new_v4(),"Title","text",1,&[title])],
            "markers":[],"settings":{"source_demo_ids":[],"ripple_sequence_markers":false,"use_media_proxies":false}},
        "created_at":chrono::Utc::now(),"updated_at":chrono::Utc::now()
    })).unwrap();
    let sources = HashMap::from([(
        font_id.to_string(),
        EditorMediaSource {
            path: font_path,
            kind: EditorMediaKind::Font,
            has_audio: false,
        },
    )]);
    let output = root.join("chinese-title.mp4");
    let plan = build_project_plan_with_sources(
        &project,
        &sources,
        &output,
        &EditorRenderOptions {
            encoder: EncoderSelection {
                primary: "libopenh264".to_owned(),
                fallback: None,
            },
            quality: 80,
            range_start: None,
            range_end: None,
        },
    )
    .expect("custom-font Project plan");
    let cancellation = ProcessCancellation::default();
    execute_native_filter_plan(&plan, &cancellation)
        .await
        .expect("native Chinese font rendering");
    let bytes = generate_native_thumbnail(
        &output,
        ThumbnailOptions {
            time_seconds: 0.5,
            maximum_width: 320,
            maximum_height: 180,
        },
        &cancellation,
    )
    .unwrap();
    let pixels = read_rgb(&bytes);
    let text_pixels = pixels
        .chunks_exact(3)
        .filter(|pixel| pixel.iter().all(|value| *value > 150))
        .count();
    assert!(text_pixels > 250, "title must be visibly rendered");
    assert_eq!(decoded_video_frames(&output), 30);
    std::fs::write(root.join("frame.png"), bytes).unwrap();
    std::fs::write(
        root.join("project.json"),
        serde_json::to_vec_pretty(&project).unwrap(),
    )
    .unwrap();
    std::fs::write(
        root.join("result.json"),
        serde_json::to_vec_pretty(&native_probe_media(&output, &cancellation).unwrap()).unwrap(),
    )
    .unwrap();
    println!("Chinese custom font acceptance: {}", root.display());
    if std::env::var_os("VIBE_CS_KEEP_ENCODING_EVIDENCE").is_some() {
        let _ = directory.keep();
    }
}

#[tokio::test]
async fn exports_two_source_ranges_with_overlay_mixed_audio_and_fades() {
    let directory = tempfile::Builder::new()
        .prefix("vibe-cs-encoding-acceptance-")
        .tempdir()
        .expect("evidence directory");
    let root = directory.path();
    let source = root.join("calibration.y4m");
    let bed = root.join("bed-440hz.wav");
    let accent = root.join("accent-880hz.wav");
    let overlay = root.join("overlay.png");
    write_calibration_video(&source);
    write_tone(&bed, 440.0);
    write_tone(&accent, 880.0);
    write_overlay(&overlay);

    let video_id = Uuid::new_v4();
    let bed_id = Uuid::new_v4();
    let accent_id = Uuid::new_v4();
    let overlay_id = Uuid::new_v4();
    let story_id = Uuid::new_v4();
    let mut first = clip(video_id, 0.0, 2.0, 0.5, 0.0);
    first["transitions"]["video_out"] = json!({"kind":"fade","duration_seconds":0.4});
    let mut second = clip(video_id, 2.0, 2.0, 3.5, 0.0);
    second["transitions"]["video_in"] = json!({"kind":"fade","duration_seconds":0.4});
    let mut background = clip(bed_id, 0.0, 4.0, 0.0, 0.3);
    background["transitions"]["audio_in"] = json!({"kind":"fade","duration_seconds":0.4});
    background["transitions"]["audio_out"] = json!({"kind":"fade","duration_seconds":0.4});
    let mut foreground = clip(accent_id, 1.0, 2.0, 0.0, 0.5);
    foreground["transitions"]["audio_in"] = json!({"kind":"constant_power","duration_seconds":0.3});
    foreground["transitions"]["audio_out"] =
        json!({"kind":"constant_power","duration_seconds":0.3});
    let project: Project = serde_json::from_value(json!({
        "id":Uuid::new_v4(),"name":"Synthetic export acceptance","revision":1,
        "document":{"width":WIDTH,"height":HEIGHT,"fps":FPS,"duration_seconds":4.0,
            "story_track_id":story_id,
            "tracks":[
                track(story_id,"Story","video",0,&[first,second]),
                track(Uuid::new_v4(),"Overlay","overlay",1,&[clip(overlay_id,0.0,4.0,0.0,0.0)]),
                track(Uuid::new_v4(),"Bed","audio",2,&[background]),
                track(Uuid::new_v4(),"Accent","audio",3,&[foreground])],
            "markers":[],"settings":{"source_demo_ids":[],"ripple_sequence_markers":false,"use_media_proxies":false}},
        "created_at":chrono::Utc::now(),"updated_at":chrono::Utc::now()
    })).expect("Project document");
    let sources = HashMap::from([
        (
            video_id.to_string(),
            EditorMediaSource {
                path: source,
                kind: EditorMediaKind::Video,
                has_audio: false,
            },
        ),
        (
            overlay_id.to_string(),
            EditorMediaSource {
                path: overlay,
                kind: EditorMediaKind::Image,
                has_audio: false,
            },
        ),
        (
            bed_id.to_string(),
            EditorMediaSource {
                path: bed,
                kind: EditorMediaKind::Audio,
                has_audio: true,
            },
        ),
        (
            accent_id.to_string(),
            EditorMediaSource {
                path: accent,
                kind: EditorMediaKind::Audio,
                has_audio: true,
            },
        ),
    ]);
    let output = root.join("synthetic-project-export.mp4");
    let plan = build_project_plan_with_sources(
        &project,
        &sources,
        &output,
        &EditorRenderOptions {
            encoder: EncoderSelection {
                primary: "libopenh264".to_owned(),
                fallback: None,
            },
            quality: 80,
            range_start: None,
            range_end: None,
        },
    )
    .expect("production export plan");
    std::fs::write(
        root.join("project.json"),
        serde_json::to_vec_pretty(&project).unwrap(),
    )
    .unwrap();
    std::fs::write(root.join("plan.txt"), format!("{:#?}", plan.command)).unwrap();
    let cancellation = ProcessCancellation::default();
    let start = Instant::now();
    execute_native_filter_plan(&plan, &cancellation)
        .await
        .expect("native project encoding");
    let elapsed = start.elapsed().as_secs_f64();
    assert!(!plan.temporary_output.exists());

    let probe = native_probe_media(&output, &cancellation).expect("output probe");
    let video = probe
        .streams
        .iter()
        .find(|stream| stream.kind == "video")
        .expect("video stream");
    let audio = probe
        .streams
        .iter()
        .find(|stream| stream.kind == "audio")
        .expect("audio stream");
    assert_eq!(video.codec, "h264");
    assert_eq!((video.width, video.height), (Some(320), Some(180)));
    assert_eq!(video.frame_rate.as_deref(), Some("30"));
    assert_eq!(audio.codec, "aac");
    assert_eq!(audio.sample_rate, Some(48_000));
    assert!(
        (probe.duration_seconds.unwrap() - 4.0).abs() < 0.1,
        "{probe:?}"
    );

    let times = [0.5, 1.5, 1.966_666, 2.033_334, 2.5, 3.5];
    let mut frames = Vec::new();
    for time in times {
        let bytes = generate_native_thumbnail(
            &output,
            ThumbnailOptions {
                time_seconds: time,
                maximum_width: 320,
                maximum_height: 180,
            },
            &cancellation,
        )
        .expect("output frame");
        std::fs::write(root.join(format!("frame-{time:.3}.png")), &bytes).unwrap();
        frames.push(read_rgb(&bytes));
    }
    let first_pixel = pixel(&frames[0], 100, 60);
    let second_pixel = pixel(&frames[4], 100, 60);
    assert!(
        first_pixel[0] > first_pixel[2] + 30,
        "first source range: {first_pixel:?}"
    );
    assert!(
        second_pixel[2] > second_pixel[0] + 30,
        "second source range: {second_pixel:?}"
    );
    for frame in &frames {
        let badge = pixel(frame, 30, 25);
        assert!(
            badge[0] > 180 && badge[1] > 150 && badge[2] < 90,
            "overlay: {badge:?}"
        );
    }
    let normal_brightness = brightness(pixel(&frames[1], 100, 60));
    assert!(
        brightness(pixel(&frames[2], 100, 60)) < normal_brightness * 0.5,
        "outgoing transition"
    );
    assert!(
        brightness(pixel(&frames[3], 100, 60)) < normal_brightness * 0.5,
        "incoming transition"
    );

    let waveform = generate_native_waveform(
        &output,
        WaveformOptions {
            buckets: 80,
            ..WaveformOptions::default()
        },
        &cancellation,
    )
    .expect("decoded output audio");
    let solo_peak = waveform[10..18].iter().copied().fold(0.0_f32, f32::max);
    let mixed_peak = waveform[30..50].iter().copied().fold(0.0_f32, f32::max);
    assert!(solo_peak > 0.04, "background track audible: {waveform:?}");
    assert!(
        mixed_peak > solo_peak * 1.5,
        "accent mixed into background: {waveform:?}"
    );
    assert!(waveform[0] < solo_peak * 0.5, "audio fade in: {waveform:?}");
    assert!(
        waveform[79] < solo_peak * 0.5,
        "audio fade out: {waveform:?}"
    );
    let frame_count = decoded_video_frames(&output);
    assert_eq!(frame_count, 120);
    std::fs::write(
        root.join("result.json"),
        serde_json::to_vec_pretty(&json!({
            "kind":"synthetic_encoding_acceptance_not_demo_capture","render_seconds":elapsed,
            "probe":probe,"decoded_video_frames":frame_count,"sampled_frame_times":times,
            "audio_peaks":waveform,"solo_peak":solo_peak,"mixed_peak":mixed_peak,
        }))
        .unwrap(),
    )
    .unwrap();
    println!("encoding acceptance: {} ({elapsed:.3}s)", root.display());
    if std::env::var_os("VIBE_CS_KEEP_ENCODING_EVIDENCE").is_some() {
        let _ = directory.keep();
    }
}

fn clip(asset_id: Uuid, start: f64, duration: f64, source_in: f64, volume: f64) -> Value {
    json!({
        "id":Uuid::new_v4(),"name":"Calibration source","capture_intent":null,
        "material":{"kind":"asset","asset_id":asset_id,"media_duration_seconds":6.0},
        "placement":{"start":start,"duration":duration,"source_in":source_in,"source_out":source_in+duration,
            "speed":1.0,"reverse":false,"frame_hold_source_time":null,"volume":volume,"pan":0.0,"enabled":true},
        "transform":{"x":0.0,"y":0.0,"scale_x":1.0,"scale_y":1.0,"rotation":0.0,"opacity":1.0},
        "effects":[],"transitions":{"video_in":null,"video_out":null,"audio_in":null,"audio_out":null},
        "text":null,"metadata":{},"group_id":null,"link_group_id":null,"keyframes":[],"speed_segments":[]
    })
}

fn track(id: Uuid, name: &str, kind: &str, order: u32, clips: &[Value]) -> Value {
    json!({"id":id,"name":name,"kind":kind,"order":order,"muted":false,"solo":false,
        "volume":1.0,"pan":0.0,"keyframes":[],"locked":false,"hidden":false,"clips":clips})
}

fn write_calibration_video(path: &Path) {
    let mut file = std::io::BufWriter::new(std::fs::File::create(path).unwrap());
    writeln!(
        file,
        "YUV4MPEG2 W{WIDTH} H{HEIGHT} F{FPS}:1 Ip A1:1 C420jpeg"
    )
    .unwrap();
    for frame in 0..6 * FPS {
        file.write_all(b"FRAME\n").unwrap();
        let mut luma = vec![0_u8; WIDTH * HEIGHT];
        for y in 0..HEIGHT {
            for x in 0..WIDTH {
                luma[y * WIDTH + x] = if x.abs_diff(frame * 3 % WIDTH) < 8 {
                    220
                } else {
                    70 + u8::try_from((x + y) % 60).unwrap()
                };
            }
        }
        file.write_all(&luma).unwrap();
        let (cb, cr) = if frame < 3 * FPS {
            (90, 175)
        } else {
            (180, 90)
        };
        file.write_all(&vec![cb; WIDTH * HEIGHT / 4]).unwrap();
        file.write_all(&vec![cr; WIDTH * HEIGHT / 4]).unwrap();
    }
}

fn write_tone(path: &Path, frequency: f64) {
    let sample_count = 6 * 48_000_u32;
    let mut bytes = b"RIFF".to_vec();
    bytes.extend_from_slice(&(36 + sample_count * 2).to_le_bytes());
    bytes.extend_from_slice(b"WAVEfmt ");
    bytes.extend_from_slice(&16_u32.to_le_bytes());
    bytes.extend_from_slice(&1_u16.to_le_bytes());
    bytes.extend_from_slice(&1_u16.to_le_bytes());
    bytes.extend_from_slice(&48_000_u32.to_le_bytes());
    bytes.extend_from_slice(&96_000_u32.to_le_bytes());
    bytes.extend_from_slice(&2_u16.to_le_bytes());
    bytes.extend_from_slice(&16_u16.to_le_bytes());
    bytes.extend_from_slice(b"data");
    bytes.extend_from_slice(&(sample_count * 2).to_le_bytes());
    for index in 0..sample_count {
        #[allow(clippy::cast_possible_truncation)]
        let sample = ((f64::from(index) * frequency * std::f64::consts::TAU / 48_000.0).sin()
            * 12_000.0) as i16;
        bytes.extend_from_slice(&sample.to_le_bytes());
    }
    std::fs::write(path, bytes).unwrap();
}

fn write_overlay(path: &Path) {
    let mut data = vec![0_u8; WIDTH * HEIGHT * 4];
    for y in 20..40 {
        for x in 20..60 {
            data[(y * WIDTH + x) * 4..(y * WIDTH + x) * 4 + 4].copy_from_slice(&[255, 220, 0, 255]);
        }
    }
    let mut encoder = png::Encoder::new(std::fs::File::create(path).unwrap(), 320, 180);
    encoder.set_color(png::ColorType::Rgba);
    encoder.set_depth(png::BitDepth::Eight);
    encoder
        .write_header()
        .unwrap()
        .write_image_data(&data)
        .unwrap();
}

fn read_rgb(bytes: &[u8]) -> Vec<u8> {
    let mut reader = png::Decoder::new(std::io::Cursor::new(bytes))
        .read_info()
        .unwrap();
    let mut data = vec![0; reader.output_buffer_size().unwrap()];
    let info = reader.next_frame(&mut data).unwrap();
    assert_eq!(info.color_type, png::ColorType::Rgb);
    data.truncate(info.buffer_size());
    data
}

fn pixel(data: &[u8], x: usize, y: usize) -> [u8; 3] {
    data[(y * WIDTH + x) * 3..(y * WIDTH + x) * 3 + 3]
        .try_into()
        .unwrap()
}

fn brightness(pixel: [u8; 3]) -> f64 {
    pixel.into_iter().map(f64::from).sum()
}

fn decoded_video_frames(path: &Path) -> usize {
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
    let mut frame = ffmpeg_next::frame::Video::empty();
    let mut last_pts = None;
    let mut receive = |decoder: &mut ffmpeg_next::decoder::Video| {
        while decoder.receive_frame(&mut frame).is_ok() {
            let pts = frame.pts().expect("video frame timestamp");
            if let Some(last) = last_pts {
                assert!(pts > last, "monotonic video timestamps");
            }
            last_pts = Some(pts);
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
    count
}
