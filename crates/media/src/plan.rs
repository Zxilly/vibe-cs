use std::{
    collections::HashMap,
    ffi::OsString,
    fmt::Write as _,
    hash::BuildHasher,
    path::{Path, PathBuf},
};

use serde_json::Value;
use uuid::Uuid;
use vibe_cs_domain::{
    EditorEffect, EditorKeyframe, EditorKeyframeProperty, EditorSpeedSegment, EditorTransition,
    EditorTransitionKind, Project, TextStyle, TimelineClipMaterial, TrackKind, Transform,
};

use crate::{CommandSpec, MediaError, MediaResult, io_error};

const SOFTWARE_ENCODER: &str = "libopenh264";
const HARDWARE_ENCODERS: &[&str] = &["h264_qsv", "h264_nvenc", "h264_amf"];

#[derive(Debug, Clone, PartialEq)]
pub struct FilterPlan {
    pub command: CommandSpec,
    pub fallback_command: Option<CommandSpec>,
    pub temporary_output: PathBuf,
    pub final_output: PathBuf,
    pub duration_seconds: f64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EncoderSelection {
    pub primary: String,
    pub fallback: Option<String>,
}

/// Selects a compiled H.264 encoder. `auto` prefers QSV, NVENC, then AMF and
/// always keeps the LGPL-compatible `libopenh264` encoder as the runtime fallback.
///
/// # Errors
///
/// Returns an error when the requested encoder is not in the strict allowlist.
pub fn select_video_encoder(
    requested: &str,
    available_encoders: &[String],
) -> MediaResult<EncoderSelection> {
    let normalized = requested.trim().to_ascii_lowercase();
    if normalized.is_empty() || normalized == "auto" {
        let primary = HARDWARE_ENCODERS
            .iter()
            .find(|candidate| available_encoders.iter().any(|item| item == **candidate))
            .copied()
            .unwrap_or(SOFTWARE_ENCODER);
        return Ok(EncoderSelection {
            primary: primary.to_owned(),
            fallback: (primary != SOFTWARE_ENCODER).then(|| SOFTWARE_ENCODER.to_owned()),
        });
    }
    let encoder = validated_encoder(&normalized)?;
    Ok(EncoderSelection {
        primary: encoder.to_owned(),
        fallback: HARDWARE_ENCODERS
            .contains(&encoder)
            .then(|| SOFTWARE_ENCODER.to_owned()),
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EditorMediaKind {
    Video,
    Audio,
    Image,
    Font,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EditorMediaSource {
    pub path: PathBuf,
    pub kind: EditorMediaKind,
    pub has_audio: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub struct EditorRenderOptions {
    pub encoder: EncoderSelection,
    pub quality: u8,
    pub range_start: Option<f64>,
    pub range_end: Option<f64>,
}

#[derive(Debug)]
struct RenderProject {
    width: u32,
    height: u32,
    fps: u32,
    duration_seconds: f64,
    tracks: Vec<RenderTrack>,
}

#[derive(Debug)]
struct RenderTrack {
    kind: TrackKind,
    order: u32,
    muted: bool,
    hidden: bool,
    clips: Vec<RenderClip>,
}

#[derive(Debug)]
struct RenderClip {
    id: Uuid,
    asset_id: Option<Uuid>,
    start: f64,
    duration: f64,
    source_in: f64,
    source_out: f64,
    speed: f64,
    volume: f64,
    transform: Transform,
    effects: Vec<EditorEffect>,
    video_transition_in: Option<EditorTransition>,
    video_transition_out: Option<EditorTransition>,
    audio_transition_in: Option<EditorTransition>,
    audio_transition_out: Option<EditorTransition>,
    text: Option<TextStyle>,
    keyframes: Vec<EditorKeyframe>,
    speed_segments: Vec<EditorSpeedSegment>,
}

impl From<&Project> for RenderProject {
    fn from(project: &Project) -> Self {
        Self {
            width: project.document.width,
            height: project.document.height,
            fps: project.document.fps,
            duration_seconds: project.document.duration_seconds,
            tracks: project
                .document
                .tracks
                .iter()
                .map(|track| RenderTrack {
                    kind: track.kind,
                    order: track.order,
                    muted: track.muted,
                    hidden: track.hidden,
                    clips: track
                        .clips
                        .iter()
                        .filter(|clip| clip.placement.enabled)
                        .map(|clip| RenderClip {
                            id: clip.id,
                            asset_id: match clip.material {
                                TimelineClipMaterial::Take { asset_id, .. }
                                | TimelineClipMaterial::Asset { asset_id, .. } => Some(asset_id),
                                TimelineClipMaterial::Planned => None,
                            },
                            start: clip.placement.start,
                            duration: clip.placement.duration,
                            source_in: clip.placement.source_in,
                            source_out: clip.placement.source_out,
                            speed: clip.placement.speed,
                            volume: clip.placement.volume,
                            transform: clip.transform.clone(),
                            effects: clip.effects.clone(),
                            video_transition_in: clip.transitions.video_in.clone(),
                            video_transition_out: clip.transitions.video_out.clone(),
                            audio_transition_in: clip.transitions.audio_in.clone(),
                            audio_transition_out: clip.transitions.audio_out.clone(),
                            text: clip.text.clone(),
                            keyframes: clip.keyframes.clone(),
                            speed_segments: clip.speed_segments.clone(),
                        })
                        .collect(),
                })
                .collect(),
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct TimedTextOverlay {
    pub text: String,
    pub start_seconds: f64,
    pub end_seconds: f64,
    pub x: f64,
    pub y: f64,
    pub font_size: f64,
    pub color: String,
    pub background: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct SingleInputTranscodeOptions {
    pub duration_seconds: f64,
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    pub has_audio: bool,
    pub fade_in_seconds: f64,
    pub fade_out_seconds: f64,
    pub overlays: Vec<TimedTextOverlay>,
    pub encoder: EncoderSelection,
    pub quality: u8,
}

impl Default for EditorRenderOptions {
    fn default() -> Self {
        Self {
            encoder: EncoderSelection {
                primary: SOFTWARE_ENCODER.to_owned(),
                fallback: None,
            },
            quality: 80,
            range_start: None,
            range_end: None,
        }
    }
}

/// Builds a shell-free audio-only extraction plan. The result is transcoded
/// to AAC so browser recordings and game captures with different codecs can
/// be placed on a common editor audio track.
///
/// # Errors
///
/// Returns an error for a missing input, invalid duration, unsafe output, or
/// a non-M4A output extension.
pub fn build_audio_extraction_plan(
    source: &Path,
    output: &Path,
    duration_seconds: f64,
) -> MediaResult<FilterPlan> {
    if !source.is_file() {
        return Err(MediaError::InvalidInput(format!(
            "audio extraction source does not exist: {}",
            source.display()
        )));
    }
    validate_finite_range(duration_seconds, 0.01, 86_400.0, "input duration")?;
    if !output
        .extension()
        .and_then(|value| value.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("m4a"))
    {
        return Err(MediaError::InvalidInput(
            "extracted audio output must use the .m4a extension".to_owned(),
        ));
    }
    let temporary = temporary_output_path(output)?;
    let command = CommandSpec::default().args([
        OsString::from("-hide_banner"),
        OsString::from("-nostdin"),
        OsString::from("-y"),
        OsString::from("-i"),
        source.as_os_str().to_os_string(),
        OsString::from("-map"),
        OsString::from("0:a:0"),
        OsString::from("-vn"),
        OsString::from("-c:a"),
        OsString::from("aac"),
        OsString::from("-b:a"),
        OsString::from("192k"),
        OsString::from("-progress"),
        OsString::from("pipe:1"),
        OsString::from("-stats_period"),
        OsString::from("0.25"),
        temporary.as_os_str().to_os_string(),
    ]);
    Ok(FilterPlan {
        command,
        fallback_command: None,
        temporary_output: temporary,
        final_output: output.to_path_buf(),
        duration_seconds,
    })
}

/// Builds a reusable one-input transcode plan for recording post-processing.
/// It supports bounded fades and timed, escaped text markers without invoking
/// a shell. The caller should use a distinct output path and can atomically
/// swap the completed file after this plan publishes it.
///
/// # Errors
///
/// Returns an error for invalid source/output paths, dimensions, timing,
/// overlays, colors, or encoders.
pub fn build_single_input_transcode_plan(
    source: &Path,
    output: &Path,
    options: &SingleInputTranscodeOptions,
) -> MediaResult<FilterPlan> {
    if !source.is_file() {
        return Err(MediaError::InvalidInput(format!(
            "input source does not exist: {}",
            source.display()
        )));
    }
    validate_dimensions(options.width, options.height, options.fps)?;
    validate_finite_range(options.duration_seconds, 0.01, 86_400.0, "input duration")?;
    for (value, name) in [
        (options.fade_in_seconds, "fade-in duration"),
        (options.fade_out_seconds, "fade-out duration"),
    ] {
        validate_finite_range(value, 0.0, options.duration_seconds, name)?;
    }
    let temporary = temporary_output_path(output)?;
    let primary = build_single_input_command(
        source,
        &temporary,
        options,
        validated_encoder(&options.encoder.primary)?,
    )?;
    let fallback_command = options
        .encoder
        .fallback
        .as_deref()
        .map(validated_encoder)
        .transpose()?
        .map(|encoder| build_single_input_command(source, &temporary, options, encoder))
        .transpose()?;
    Ok(FilterPlan {
        command: primary,
        fallback_command,
        temporary_output: temporary,
        final_output: output.to_path_buf(),
        duration_seconds: options.duration_seconds,
    })
}

fn build_single_input_command(
    source: &Path,
    temporary: &Path,
    options: &SingleInputTranscodeOptions,
    encoder: &str,
) -> MediaResult<CommandSpec> {
    let mut video = format!(
        "[0:v:0]trim=duration={:.6},setpts=PTS-STARTPTS,scale={}:{}:force_original_aspect_ratio=decrease,pad={}:{}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,fps={},format=yuv420p",
        options.duration_seconds,
        options.width,
        options.height,
        options.width,
        options.height,
        options.fps
    );
    if options.fade_in_seconds > 0.0 {
        let _ = write!(video, ",fade=t=in:st=0:d={:.6}", options.fade_in_seconds);
    }
    if options.fade_out_seconds > 0.0 {
        let start = options.duration_seconds - options.fade_out_seconds;
        let _ = write!(
            video,
            ",fade=t=out:st={start:.6}:d={:.6}",
            options.fade_out_seconds
        );
    }
    for overlay in &options.overlays {
        if !overlay.start_seconds.is_finite()
            || !overlay.end_seconds.is_finite()
            || overlay.start_seconds < 0.0
            || overlay.end_seconds <= overlay.start_seconds
            || overlay.end_seconds > options.duration_seconds + 0.001
            || !overlay.x.is_finite()
            || !overlay.y.is_finite()
        {
            return Err(MediaError::InvalidInput(
                "timed overlay has an invalid range or position".to_owned(),
            ));
        }
        validate_text_length(overlay.text.trim(), 500, "overlay text")?;
        validate_finite_range(overlay.font_size, 6.0, 256.0, "overlay font size")?;
        let text = escape_filter_value(&overlay.text)?;
        let color = ffmpeg_color(&overlay.color)?;
        let font = font_filter_option("Arial", None)?;
        let _ = write!(
            video,
            ",drawtext={font}:text='{text}':expansion=none:fontsize={:.4}:fontcolor={color}:x={:.4}:y={:.4}",
            overlay.font_size, overlay.x, overlay.y
        );
        if let Some(background) = overlay.background.as_deref() {
            let background = ffmpeg_color(background)?;
            let _ = write!(video, ":box=1:boxcolor={background}@0.7:boxborderw=10");
        }
        let _ = write!(
            video,
            ":enable='between(t,{:.6},{:.6})'",
            overlay.start_seconds, overlay.end_seconds
        );
    }
    video.push_str("[outv]");
    let mut command = CommandSpec::default().args([
        OsString::from("-hide_banner"),
        OsString::from("-nostdin"),
        OsString::from("-y"),
        OsString::from("-i"),
        source.as_os_str().to_os_string(),
        OsString::from("-filter_complex"),
        OsString::from(video),
        OsString::from("-map"),
        OsString::from("[outv]"),
    ]);
    if options.has_audio {
        command = command.args([
            OsString::from("-map"),
            OsString::from("0:a:0"),
            OsString::from("-c:a"),
            OsString::from("aac"),
            OsString::from("-b:a"),
            OsString::from("192k"),
        ]);
    } else {
        command = command.arg("-an");
    }
    command = command.args([OsString::from("-c:v"), OsString::from(encoder)]);
    command = command.args(encoder_quality_args(encoder, options.quality));
    command = command.args([
        OsString::from("-t"),
        OsString::from(format!("{:.6}", options.duration_seconds)),
        OsString::from("-progress"),
        OsString::from("pipe:1"),
        OsString::from("-stats_period"),
        OsString::from("0.25"),
        OsString::from("-movflags"),
        OsString::from("+faststart"),
        temporary.as_os_str().to_os_string(),
    ]);
    Ok(command)
}

/// Builds a complete montage plan with probed duration/audio metadata and an
/// optional software fallback command.
///
/// # Errors
///
/// Returns an error for invalid timing, transitions, text, media, or output.
/// Builds a compositing plan for video, audio, image, text, and overlay tracks.
///
/// # Errors
///
/// Returns an error for invalid timing, range, media, transform, effect,
/// transition, text style, encoder, or output.
pub fn build_project_plan_with_sources<S: BuildHasher>(
    project: &Project,
    assets: &HashMap<String, EditorMediaSource, S>,
    output: &Path,
    options: &EditorRenderOptions,
) -> MediaResult<FilterPlan> {
    project
        .validate()
        .map_err(|error| MediaError::InvalidInput(error.to_string()))?;
    let project = RenderProject::from(project);
    validate_dimensions(project.width, project.height, project.fps)?;
    if !project.duration_seconds.is_finite() || project.duration_seconds <= 0.0 {
        return Err(MediaError::InvalidInput(
            "editor duration must be finite and positive".to_owned(),
        ));
    }
    let (range_start, range_end) = validate_export_range(&project, options)?;
    let duration = range_end - range_start;
    let temporary = temporary_output_path(output)?;
    let primary_encoder = validated_encoder(&options.encoder.primary)?;
    let command = build_editor_command(
        &project,
        assets,
        &temporary,
        options,
        range_start,
        range_end,
        primary_encoder,
    )?;
    let fallback_command = options
        .encoder
        .fallback
        .as_deref()
        .map(validated_encoder)
        .transpose()?
        .map(|fallback| {
            build_editor_command(
                &project,
                assets,
                &temporary,
                options,
                range_start,
                range_end,
                fallback,
            )
        })
        .transpose()?;
    Ok(FilterPlan {
        command,
        fallback_command,
        temporary_output: temporary,
        final_output: output.to_path_buf(),
        duration_seconds: duration,
    })
}

fn validate_export_range(
    project: &RenderProject,
    options: &EditorRenderOptions,
) -> MediaResult<(f64, f64)> {
    let start = options.range_start.unwrap_or(0.0);
    let end = options.range_end.unwrap_or(project.duration_seconds);
    if !start.is_finite()
        || !end.is_finite()
        || start < 0.0
        || end <= start
        || end > project.duration_seconds + 0.001
    {
        return Err(MediaError::InvalidInput(
            "export range must be finite, ordered, and inside the project".to_owned(),
        ));
    }
    Ok((start, end.min(project.duration_seconds)))
}

fn prepare_speed_sections(
    clip: &RenderClip,
    local_start: f64,
    local_end: f64,
) -> MediaResult<Vec<PreparedSpeedSection>> {
    if clip.speed_segments.is_empty() {
        return Ok(vec![PreparedSpeedSection {
            source_start: clip.source_in + local_start * clip.speed,
            source_end: clip.source_in + local_end * clip.speed,
            speed: clip.speed,
        }]);
    }
    let mut sections = Vec::new();
    for segment in &clip.speed_segments {
        let start = local_start.max(segment.start);
        let end = local_end.min(segment.end);
        if end <= start {
            continue;
        }
        let source_start = clip.source_in + source_offset_at(&clip.speed_segments, start);
        let source_end = source_start + (end - start) * segment.speed;
        sections.push(PreparedSpeedSection {
            source_start,
            source_end,
            speed: segment.speed,
        });
    }
    if sections.is_empty() {
        Err(MediaError::InvalidInput(format!(
            "clip {} speed segments do not cover the rendered range",
            clip.id
        )))
    } else {
        Ok(sections)
    }
}

fn source_offset_at(segments: &[EditorSpeedSegment], time: f64) -> f64 {
    segments.iter().fold(0.0, |offset, segment| {
        if time <= segment.start {
            offset
        } else {
            offset + (time.min(segment.end) - segment.start).max(0.0) * segment.speed
        }
    })
}

#[derive(Debug)]
struct PreparedEditorClip<'a> {
    track_kind: TrackKind,
    clip: &'a RenderClip,
    source: Option<&'a EditorMediaSource>,
    input_index: Option<usize>,
    timeline_start: f64,
    duration: f64,
    local_start: f64,
    speed_sections: Vec<PreparedSpeedSection>,
}

#[derive(Debug, Clone, Copy)]
struct PreparedSpeedSection {
    source_start: f64,
    source_end: f64,
    speed: f64,
}

#[allow(clippy::too_many_arguments)]
fn build_editor_command<S: BuildHasher>(
    project: &RenderProject,
    assets: &HashMap<String, EditorMediaSource, S>,
    temporary: &Path,
    options: &EditorRenderOptions,
    range_start: f64,
    range_end: f64,
    encoder: &str,
) -> MediaResult<CommandSpec> {
    let duration = range_end - range_start;
    let mut command = CommandSpec::default().args(["-hide_banner", "-nostdin", "-y"]);
    let mut prepared = Vec::new();
    let mut next_input = 0_usize;
    let mut tracks = project
        .tracks
        .iter()
        .filter(|track| !track.hidden && !track.muted)
        .collect::<Vec<_>>();
    tracks.sort_by_key(|track| track.order);
    for track in tracks {
        for clip in &track.clips {
            let clip_end = clip.start + clip.duration;
            let intersection_start = clip.start.max(range_start);
            let intersection_end = clip_end.min(range_end);
            if intersection_end <= intersection_start {
                continue;
            }
            validate_editor_clip(clip)?;
            let rendered_duration = intersection_end - intersection_start;
            let local_start = intersection_start - clip.start;
            let local_end = intersection_end - clip.start;
            let speed_sections = prepare_speed_sections(clip, local_start, local_end)?;
            let source_end = speed_sections
                .last()
                .map_or(clip.source_in, |section| section.source_end);
            if source_end > clip.source_out + 0.001 {
                return Err(MediaError::InvalidInput(format!(
                    "editor clip {} exceeds its source range",
                    clip.id
                )));
            }
            let source = clip
                .asset_id
                .map(|asset_id| {
                    assets.get(&asset_id.to_string()).ok_or_else(|| {
                        MediaError::InvalidInput(format!("asset {asset_id} has no file"))
                    })
                })
                .transpose()?;
            validate_editor_media_combination(track.kind, clip, source)?;
            if source.is_none() && clip.text.is_none() {
                return Err(MediaError::InvalidInput(format!(
                    "clip {} has neither an asset nor text",
                    clip.id
                )));
            }
            let input_index = if let Some(source) = source {
                if !source.path.is_file() {
                    return Err(MediaError::InvalidInput(format!(
                        "asset source does not exist: {}",
                        source.path.display()
                    )));
                }
                if source.kind == EditorMediaKind::Image {
                    if !clip.speed_segments.is_empty() {
                        return Err(MediaError::InvalidInput(format!(
                            "image clip {} cannot use speed segments",
                            clip.id
                        )));
                    }
                    command = command.args([
                        OsString::from("-loop"),
                        OsString::from("1"),
                        OsString::from("-framerate"),
                        OsString::from(project.fps.to_string()),
                        OsString::from("-t"),
                        OsString::from(format!("{:.6}", rendered_duration * clip.speed)),
                    ]);
                }
                command =
                    command.args([OsString::from("-i"), source.path.as_os_str().to_os_string()]);
                let index = next_input;
                next_input += 1;
                Some(index)
            } else {
                None
            };
            prepared.push(PreparedEditorClip {
                track_kind: track.kind,
                clip,
                source,
                input_index,
                timeline_start: intersection_start - range_start,
                duration: rendered_duration,
                local_start,
                speed_sections,
            });
        }
    }
    if prepared.is_empty() {
        return Err(MediaError::InvalidInput(
            "editor range contains no visible clips".to_owned(),
        ));
    }

    let mut filters = vec![format!(
        "color=c=black:s={}x{}:r={}:d={duration:.6},format=rgba[base]",
        project.width, project.height, project.fps
    )];
    let mut previous_video = "base".to_owned();
    let mut audio_labels = Vec::new();
    for (index, item) in prepared.iter().enumerate() {
        let source = item.source;
        if let (Some(source), Some(input)) = (source, item.input_index) {
            if item.track_kind != TrackKind::Audio && source.kind != EditorMediaKind::Audio {
                let visual_label = format!("visual{index}");
                filters.push(build_visual_filter(project, item, input, &visual_label)?);
                let layer_label = format!("layer{index}");
                let x = keyframe_expression(
                    item.clip,
                    EditorKeyframeProperty::X,
                    &format!("t-{:.6}+{:.6}", item.timeline_start, item.local_start),
                    item.clip.transform.x,
                );
                let y = keyframe_expression(
                    item.clip,
                    EditorKeyframeProperty::Y,
                    &format!("t-{:.6}+{:.6}", item.timeline_start, item.local_start),
                    item.clip.transform.y,
                );
                filters.push(format!(
                    "[{previous_video}][{visual_label}]overlay=x='(W-w)/2+({x})':y='(H-h)/2+({y})':eval=frame:eof_action=pass:shortest=0:enable='between(t,{:.6},{:.6})'[{layer_label}]",
                    item.timeline_start,
                    item.timeline_start + item.duration
                ));
                previous_video = layer_label;
            }
            if source_has_audio(source, item.track_kind) {
                let audio_label = format!("audio{index}");
                filters.push(build_audio_filter(item, input, &audio_label)?);
                audio_labels.push(audio_label);
            }
        }
        if let Some(text) = item.clip.text.as_ref()
            && (item.clip.asset_id.is_none() || item.track_kind == TrackKind::Text)
        {
            let text_label = format!("text{index}");
            filters.push(build_text_filter(
                &previous_video,
                &text_label,
                item,
                text,
                assets,
            )?);
            previous_video = text_label;
        }
    }
    filters.push(format!("[{previous_video}]format=yuv420p[outv]"));
    match audio_labels.as_slice() {
        [] => filters.push(format!("anullsrc=r=48000:cl=stereo:d={duration:.6}[outa]")),
        [only] => filters.push(format!(
            "[{only}]apad,atrim=duration={duration:.6},alimiter=limit=0.95[outa]"
        )),
        many => {
            let labels = many.iter().fold(String::new(), |mut labels, item| {
                let _ = write!(labels, "[{item}]");
                labels
            });
            filters.push(format!(
                "{labels}amix=inputs={}:duration=longest:normalize=0:dropout_transition=0,apad,atrim=duration={duration:.6},alimiter=limit=0.95[outa]",
                many.len()
            ));
        }
    }
    command = command.args([
        OsString::from("-filter_complex"),
        OsString::from(filters.join(";")),
        OsString::from("-map"),
        OsString::from("[outv]"),
        OsString::from("-map"),
        OsString::from("[outa]"),
        OsString::from("-c:v"),
        OsString::from(encoder),
    ]);
    command = command.args(encoder_quality_args(encoder, options.quality));
    command = command.args([
        OsString::from("-c:a"),
        OsString::from("aac"),
        OsString::from("-b:a"),
        OsString::from("192k"),
        OsString::from("-t"),
        OsString::from(format!("{duration:.6}")),
        OsString::from("-progress"),
        OsString::from("pipe:1"),
        OsString::from("-stats_period"),
        OsString::from("0.25"),
        OsString::from("-movflags"),
        OsString::from("+faststart"),
        temporary.as_os_str().to_os_string(),
    ]);
    Ok(command)
}

fn validate_editor_clip(clip: &RenderClip) -> MediaResult<()> {
    if !clip.start.is_finite()
        || !clip.duration.is_finite()
        || clip.start < 0.0
        || clip.duration <= 0.0
        || !clip.source_in.is_finite()
        || !clip.source_out.is_finite()
        || clip.source_in < 0.0
        || clip.source_out <= clip.source_in
    {
        return Err(MediaError::InvalidInput(format!(
            "invalid timing for editor clip {}",
            clip.id
        )));
    }
    validate_finite_range(clip.speed, 0.05, 16.0, "clip speed")?;
    validate_finite_range(clip.volume, 0.0, 4.0, "clip volume")?;
    validate_transform(&clip.transform)?;
    for transition in [
        clip.video_transition_in.as_ref(),
        clip.video_transition_out.as_ref(),
    ]
    .into_iter()
    .flatten()
    {
        let _ = validated_transition_duration(transition, clip.duration)?;
        if transition.kind == EditorTransitionKind::ConstantPower {
            return Err(MediaError::InvalidInput(
                "constant power is an audio-only transition".to_owned(),
            ));
        }
    }
    for transition in [
        clip.audio_transition_in.as_ref(),
        clip.audio_transition_out.as_ref(),
    ]
    .into_iter()
    .flatten()
    {
        let _ = validated_transition_duration(transition, clip.duration)?;
        if !matches!(
            transition.kind,
            EditorTransitionKind::Fade | EditorTransitionKind::ConstantPower
        ) {
            return Err(MediaError::InvalidInput(
                "audio clips support fade or constant power transitions".to_owned(),
            ));
        }
    }
    for effect in &clip.effects {
        validate_effect(effect)?;
    }
    Ok(())
}

fn validate_editor_media_combination(
    track_kind: TrackKind,
    clip: &RenderClip,
    source: Option<&EditorMediaSource>,
) -> MediaResult<()> {
    let transform_properties = [
        EditorKeyframeProperty::X,
        EditorKeyframeProperty::Y,
        EditorKeyframeProperty::ScaleX,
        EditorKeyframeProperty::ScaleY,
        EditorKeyframeProperty::Rotation,
        EditorKeyframeProperty::Opacity,
    ];
    if track_kind == TrackKind::Audio && clip_has_keyframes(clip, &transform_properties) {
        return Err(MediaError::InvalidInput(format!(
            "audio clip {} cannot use visual transform keyframes",
            clip.id
        )));
    }
    if clip.text.is_some()
        && clip_has_keyframes(
            clip,
            &[
                EditorKeyframeProperty::ScaleX,
                EditorKeyframeProperty::ScaleY,
                EditorKeyframeProperty::Rotation,
                EditorKeyframeProperty::Volume,
            ],
        )
    {
        return Err(MediaError::InvalidInput(format!(
            "text clip {} supports only position and opacity keyframes",
            clip.id
        )));
    }
    if clip_has_keyframes(
        clip,
        &[
            EditorKeyframeProperty::ScaleX,
            EditorKeyframeProperty::ScaleY,
        ],
    ) && (clip.transform.rotation.abs() > 0.000_001
        || clip_has_keyframes(clip, &[EditorKeyframeProperty::Rotation]))
    {
        return Err(MediaError::InvalidInput(format!(
            "clip {} cannot combine animated scale with rotation",
            clip.id
        )));
    }
    if let Some(source) = source {
        if source.kind == EditorMediaKind::Image && !clip.speed_segments.is_empty() {
            return Err(MediaError::InvalidInput(format!(
                "image clip {} cannot use speed segments",
                clip.id
            )));
        }
        if clip_has_keyframes(clip, &[EditorKeyframeProperty::Volume])
            && (source.kind == EditorMediaKind::Image || !source.has_audio)
        {
            return Err(MediaError::InvalidInput(format!(
                "clip {} cannot animate volume because its source has no audio",
                clip.id
            )));
        }
    }
    Ok(())
}

fn clip_has_keyframes(clip: &RenderClip, properties: &[EditorKeyframeProperty]) -> bool {
    clip.keyframes
        .iter()
        .any(|keyframe| properties.contains(&keyframe.property))
}

fn keyframe_expression(
    clip: &RenderClip,
    property: EditorKeyframeProperty,
    time_variable: &str,
    fallback: f64,
) -> String {
    let points = clip
        .keyframes
        .iter()
        .filter(|keyframe| keyframe.property == property)
        .map(|keyframe| (keyframe.time, keyframe.value))
        .collect::<Vec<_>>();
    let Some(&(first_time, first_value)) = points.first() else {
        return format!("{fallback:.6}");
    };
    if points.len() == 1 {
        return format!("{first_value:.6}");
    }
    let mut expression = format!("{:.6}", points.last().expect("points are non-empty").1);
    for pair in points.windows(2).rev() {
        let (left_time, left_value) = pair[0];
        let (right_time, right_value) = pair[1];
        let slope = (right_value - left_value) / (right_time - left_time);
        let linear = format!("{left_value:.6}+({slope:.9})*(({time_variable})-{left_time:.6})");
        expression = format!("if(lt(({time_variable}),{right_time:.6}),{linear},{expression})");
    }
    format!("if(lt(({time_variable}),{first_time:.6}),{first_value:.6},{expression})")
}

fn validate_transform(transform: &Transform) -> MediaResult<()> {
    for (value, name) in [
        (transform.x, "transform x"),
        (transform.y, "transform y"),
        (transform.rotation, "rotation"),
    ] {
        if !value.is_finite() {
            return Err(MediaError::InvalidInput(format!("{name} must be finite")));
        }
    }
    validate_finite_range(transform.scale_x, 0.01, 10.0, "horizontal scale")?;
    validate_finite_range(transform.scale_y, 0.01, 10.0, "vertical scale")?;
    validate_finite_range(transform.opacity, 0.0, 1.0, "opacity")
}

fn build_visual_filter(
    project: &RenderProject,
    item: &PreparedEditorClip<'_>,
    input: usize,
    label: &str,
) -> MediaResult<String> {
    let source = item.source.expect("visual filters have a source");
    let clip = item.clip;
    let mut filters = Vec::new();
    let timing_label = format!("{label}timing");
    if item.speed_sections.len() == 1 {
        let section = item.speed_sections[0];
        let (trim_start, trim_end) = if source.kind == EditorMediaKind::Image {
            (0.0, section.source_end - section.source_start)
        } else {
            (section.source_start, section.source_end)
        };
        filters.push(format!(
            "[{input}:v:0]trim=start={trim_start:.6}:end={trim_end:.6},setpts=(PTS-STARTPTS)/{:.6}[{timing_label}]",
            section.speed
        ));
    } else {
        let split_labels = (0..item.speed_sections.len())
            .map(|section| format!("{label}vin{section}"))
            .collect::<Vec<_>>();
        let outputs = split_labels.iter().fold(String::new(), |mut value, label| {
            let _ = write!(value, "[{label}]");
            value
        });
        filters.push(format!(
            "[{input}:v:0]split={}{outputs}",
            split_labels.len()
        ));
        let mut segment_outputs = String::new();
        for (index, (input_label, section)) in
            split_labels.iter().zip(&item.speed_sections).enumerate()
        {
            let output_label = format!("{label}vsegment{index}");
            filters.push(format!(
                "[{input_label}]trim=start={:.6}:end={:.6},setpts=(PTS-STARTPTS)/{:.6}[{output_label}]",
                section.source_start, section.source_end, section.speed
            ));
            let _ = write!(segment_outputs, "[{output_label}]");
        }
        filters.push(format!(
            "{segment_outputs}concat=n={}:v=1:a=0[{timing_label}]",
            item.speed_sections.len()
        ));
    }

    let transform = &clip.transform;
    let local_time = format!("t+{:.6}", item.local_start);
    let scale_x = keyframe_expression(
        clip,
        EditorKeyframeProperty::ScaleX,
        &local_time,
        transform.scale_x,
    );
    let scale_y = keyframe_expression(
        clip,
        EditorKeyframeProperty::ScaleY,
        &local_time,
        transform.scale_y,
    );
    let animated_scale = clip_has_keyframes(
        clip,
        &[
            EditorKeyframeProperty::ScaleX,
            EditorKeyframeProperty::ScaleY,
        ],
    );
    let mut filter = format!(
        "[{timing_label}]scale={}:{}:force_original_aspect_ratio=decrease",
        project.width, project.height
    );
    if animated_scale {
        let _ = write!(
            filter,
            ",scale=w='max(2,trunc(iw*({scale_x})/2)*2)':h='max(2,trunc(ih*({scale_y})/2)*2)':eval=frame"
        );
    } else {
        let _ = write!(
            filter,
            ",scale='max(2,trunc(iw*{:.6}/2)*2)':'max(2,trunc(ih*{:.6}/2)*2)'",
            transform.scale_x, transform.scale_y
        );
    }
    for effect in clip.effects.iter().filter(|effect| effect.enabled) {
        let _ = write!(filter, ",{}", effect_filter(effect)?);
    }
    let rotation = keyframe_expression(
        clip,
        EditorKeyframeProperty::Rotation,
        &local_time,
        transform.rotation,
    );
    if clip_has_keyframes(clip, &[EditorKeyframeProperty::Rotation]) {
        let _ = write!(
            filter,
            ",format=rgba,rotate='({rotation})*PI/180':ow='hypot(iw,ih)':oh='hypot(iw,ih)':c=none"
        );
    } else if transform.rotation.abs() > 0.000_001 {
        let _ = write!(
            filter,
            ",format=rgba,rotate={:.6}*PI/180:ow=rotw({:.6}*PI/180):oh=roth({:.6}*PI/180):c=none",
            transform.rotation, transform.rotation, transform.rotation
        );
    } else {
        filter.push_str(",format=rgba");
    }
    let opacity = keyframe_expression(
        clip,
        EditorKeyframeProperty::Opacity,
        &format!("T+{:.6}", item.local_start),
        transform.opacity,
    );
    if clip_has_keyframes(clip, &[EditorKeyframeProperty::Opacity]) {
        let _ = write!(
            filter,
            ",geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='alpha(X,Y)*({opacity})'"
        );
    } else {
        let _ = write!(filter, ",colorchannelmixer=aa={:.6}", transform.opacity);
    }
    append_visual_fades(&mut filter, clip, item.duration)?;
    let _ = write!(filter, ",setpts=PTS+{:.6}/TB[{label}]", item.timeline_start);
    filters.push(filter);
    Ok(filters.join(";"))
}

fn append_visual_fades(filter: &mut String, clip: &RenderClip, duration: f64) -> MediaResult<()> {
    if let Some(transition) = clip.video_transition_in.as_ref() {
        let transition_duration = validated_transition_duration(transition, duration)?;
        append_editor_visual_transition(
            filter,
            transition.kind,
            true,
            transition_duration,
            duration,
        );
    }
    if let Some(transition) = clip.video_transition_out.as_ref() {
        let transition_duration = validated_transition_duration(transition, duration)?;
        append_editor_visual_transition(
            filter,
            transition.kind,
            false,
            transition_duration,
            duration,
        );
    }
    Ok(())
}

fn append_editor_visual_transition(
    filter: &mut String,
    transition: EditorTransitionKind,
    entering: bool,
    transition_duration: f64,
    clip_duration: f64,
) {
    let start = if entering {
        0.0
    } else {
        clip_duration - transition_duration
    };
    let fade_kind = if entering { "in" } else { "out" };
    match transition {
        EditorTransitionKind::Fade => {
            let _ = write!(
                filter,
                ",fade=t={fade_kind}:st={start:.6}:d={transition_duration:.6}:alpha=1"
            );
        }
        EditorTransitionKind::Flash | EditorTransitionKind::Dip => {
            let color = if transition == EditorTransitionKind::Flash {
                "white"
            } else {
                "black"
            };
            let _ = write!(
                filter,
                ",fade=t={fade_kind}:st={start:.6}:d={transition_duration:.6}:color={color}"
            );
        }
        EditorTransitionKind::Zoom => {
            let expression = if entering {
                format!("1+0.18*max(0\\,({transition_duration:.6}-t)/{transition_duration:.6})")
            } else {
                format!("1+0.18*max(0\\,(t-{start:.6})/{transition_duration:.6})")
            };
            let _ = write!(
                filter,
                ",scale=w='trunc(iw*({expression})/2)*2':h='trunc(ih*({expression})/2)*2':eval=frame"
            );
        }
        EditorTransitionKind::Wipe | EditorTransitionKind::Slide => {
            let progress = if entering {
                format!("min(1\\,T/{transition_duration:.6})")
            } else {
                format!("max(0\\,1-(T-{start:.6})/{transition_duration:.6})")
            };
            let feather = if transition == EditorTransitionKind::Wipe {
                2
            } else {
                48
            };
            let _ = write!(
                filter,
                ",geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='alpha(X,Y)*clip((({progress})*W-X)/{feather}\\,0\\,1)'"
            );
        }
        EditorTransitionKind::Blur => {
            let end = start + transition_duration;
            let _ = write!(
                filter,
                ",gblur=sigma=8:enable='between(t,{start:.6},{end:.6})'"
            );
        }
        EditorTransitionKind::Glitch => {
            let end = start + transition_duration;
            let _ = write!(
                filter,
                ",chromashift=cbh=8:crh=-8:edge=smear:enable='between(t,{start:.6},{end:.6})'"
            );
        }
        EditorTransitionKind::Spin => {
            let angle = if entering {
                format!("0.35*max(0\\,1-t/{transition_duration:.6})")
            } else {
                format!("0.35*max(0\\,(t-{start:.6})/{transition_duration:.6})")
            };
            let _ = write!(filter, ",rotate='{angle}':c=none:ow=iw:oh=ih");
        }
        EditorTransitionKind::ConstantPower => {}
    }
}

fn build_audio_filter(
    item: &PreparedEditorClip<'_>,
    input: usize,
    label: &str,
) -> MediaResult<String> {
    let clip = item.clip;
    let mut filters = Vec::new();
    let timing_label = format!("{label}timing");
    if item.speed_sections.len() == 1 {
        let section = item.speed_sections[0];
        let mut timing = format!(
            "[{input}:a:0]atrim=start={:.6}:end={:.6},asetpts=PTS-STARTPTS",
            section.source_start, section.source_end
        );
        for tempo in atempo_chain(section.speed) {
            let _ = write!(timing, ",atempo={tempo:.6}");
        }
        let _ = write!(timing, "[{timing_label}]");
        filters.push(timing);
    } else {
        let split_labels = (0..item.speed_sections.len())
            .map(|section| format!("{label}ain{section}"))
            .collect::<Vec<_>>();
        let outputs = split_labels.iter().fold(String::new(), |mut value, label| {
            let _ = write!(value, "[{label}]");
            value
        });
        filters.push(format!(
            "[{input}:a:0]asplit={}{outputs}",
            split_labels.len()
        ));
        let mut segment_outputs = String::new();
        for (index, (input_label, section)) in
            split_labels.iter().zip(&item.speed_sections).enumerate()
        {
            let output_label = format!("{label}asegment{index}");
            let mut timing = format!(
                "[{input_label}]atrim=start={:.6}:end={:.6},asetpts=PTS-STARTPTS",
                section.source_start, section.source_end
            );
            for tempo in atempo_chain(section.speed) {
                let _ = write!(timing, ",atempo={tempo:.6}");
            }
            let _ = write!(timing, "[{output_label}]");
            filters.push(timing);
            let _ = write!(segment_outputs, "[{output_label}]");
        }
        filters.push(format!(
            "{segment_outputs}concat=n={}:v=0:a=1[{timing_label}]",
            item.speed_sections.len()
        ));
    }
    let volume = keyframe_expression(
        clip,
        EditorKeyframeProperty::Volume,
        &format!("t+{:.6}", item.local_start),
        clip.volume,
    );
    let mut filter = format!("[{timing_label}]");
    if clip_has_keyframes(clip, &[EditorKeyframeProperty::Volume]) {
        let _ = write!(filter, "volume='{volume}':eval=frame");
    } else {
        let _ = write!(filter, "volume={:.6}", clip.volume);
    }
    if let Some(transition) = clip.audio_transition_in.as_ref() {
        let transition_duration = validated_transition_duration(transition, item.duration)?;
        let curve = if transition.kind == EditorTransitionKind::ConstantPower {
            ":curve=qsin"
        } else {
            ""
        };
        let _ = write!(filter, ",afade=t=in:st=0:d={transition_duration:.6}{curve}");
    }
    if let Some(transition) = clip.audio_transition_out.as_ref() {
        let transition_duration = validated_transition_duration(transition, item.duration)?;
        let start = item.duration - transition_duration;
        let curve = if transition.kind == EditorTransitionKind::ConstantPower {
            ":curve=qsin"
        } else {
            ""
        };
        let _ = write!(
            filter,
            ",afade=t=out:st={start:.6}:d={transition_duration:.6}{curve}"
        );
    }
    // `amix` consumes each input from sample zero; a positive PTS alone does not
    // materialize the Timeline gap. Insert sample-exact silence before mixing.
    let delay_samples = item.timeline_start * 48_000.0;
    let _ = write!(
        filter,
        ",aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,asetpts=PTS-STARTPTS,adelay=delays={delay_samples:.0}S:all=1[{label}]"
    );
    filters.push(filter);
    Ok(filters.join(";"))
}

fn build_text_filter(
    input_label: &str,
    output_label: &str,
    item: &PreparedEditorClip<'_>,
    text: &TextStyle,
    assets: &HashMap<String, EditorMediaSource, impl BuildHasher>,
) -> MediaResult<String> {
    if item.clip.video_transition_in.is_some()
        || item.clip.video_transition_out.is_some()
        || item.clip.audio_transition_in.is_some()
        || item.clip.audio_transition_out.is_some()
    {
        return Err(MediaError::InvalidInput(
            "text transitions are not supported; animate opacity on an overlay asset instead"
                .to_owned(),
        ));
    }
    validate_text_style(text)?;
    let transform = &item.clip.transform;
    if (transform.scale_x - 1.0).abs() > 0.000_001
        || (transform.scale_y - 1.0).abs() > 0.000_001
        || transform.rotation.abs() > 0.000_001
    {
        return Err(MediaError::InvalidInput(
            "text clips support position and opacity; use font size for text scale".to_owned(),
        ));
    }
    let escaped_text = escape_filter_value(&text.content)?;
    let font_path = text
        .font_asset_id
        .map(|id| {
            let source = assets
                .get(&id.to_string())
                .ok_or_else(|| MediaError::InvalidInput(format!("font asset {id} has no file")))?;
            if source.kind != EditorMediaKind::Font {
                return Err(MediaError::InvalidInput(format!(
                    "asset {id} is not a supported font"
                )));
            }
            Ok(source.path.as_path())
        })
        .transpose()?;
    let font = font_filter_option(&text.font_family, font_path)?;
    let color = ffmpeg_color(&text.color)?;
    let local_time = format!("t-{:.6}+{:.6}", item.timeline_start, item.local_start);
    let animated_x = keyframe_expression(
        item.clip,
        EditorKeyframeProperty::X,
        &local_time,
        transform.x,
    );
    let animated_y = keyframe_expression(
        item.clip,
        EditorKeyframeProperty::Y,
        &local_time,
        transform.y,
    );
    let opacity = keyframe_expression(
        item.clip,
        EditorKeyframeProperty::Opacity,
        &local_time,
        transform.opacity,
    );
    let x = match text.align.to_ascii_lowercase().as_str() {
        "left" => format!("20+({animated_x})"),
        "center" => format!("(w-text_w)/2+({animated_x})"),
        "right" => format!("w-text_w-20+({animated_x})"),
        _ => {
            return Err(MediaError::InvalidInput(
                "text align must be left, center, or right".to_owned(),
            ));
        }
    };
    let y = format!("(h-text_h)/2+({animated_y})");
    let mut filter = format!(
        "[{input_label}]drawtext={font}:text='{escaped_text}':expansion=none:fontsize={:.4}:fontcolor={color}:alpha='{opacity}':x='{x}':y='{y}'",
        text.font_size
    );
    if let Some(background) = text.background.as_deref() {
        let background = ffmpeg_color(background)?;
        let _ = write!(filter, ":box=1:boxcolor={background}@0.75:boxborderw=12");
    }
    let _ = write!(
        filter,
        ":enable='between(t,{:.6},{:.6})'[{output_label}]",
        item.timeline_start,
        item.timeline_start + item.duration
    );
    Ok(filter)
}

fn validate_text_style(text: &TextStyle) -> MediaResult<()> {
    validate_text_length(text.content.trim(), 1_000, "text content")?;
    validate_text_length(text.font_family.trim(), 100, "font family")?;
    if !text
        .font_family
        .chars()
        .all(|character| character.is_alphanumeric() || " -_".contains(character))
    {
        return Err(MediaError::InvalidInput(
            "font family contains unsupported characters".to_owned(),
        ));
    }
    validate_finite_range(text.font_size, 6.0, 512.0, "font size")?;
    ffmpeg_color(&text.color)?;
    if let Some(background) = text.background.as_deref() {
        ffmpeg_color(background)?;
    }
    Ok(())
}

fn validate_text_length(text: &str, maximum: usize, name: &str) -> MediaResult<()> {
    let length = text.chars().count();
    if length == 0 || length > maximum {
        Err(MediaError::InvalidInput(format!(
            "{name} must contain between 1 and {maximum} characters"
        )))
    } else {
        Ok(())
    }
}

fn validate_effect(effect: &EditorEffect) -> MediaResult<()> {
    if !effect.enabled {
        return Ok(());
    }
    match effect.kind.as_str() {
        "color_adjust" => {
            effect_number(&effect.parameters, "brightness", -1.0, 1.0, 0.0)?;
            effect_number(&effect.parameters, "contrast", 0.0, 3.0, 1.0)?;
            effect_number(&effect.parameters, "saturation", 0.0, 3.0, 1.0)?;
            Ok(())
        }
        "grayscale" => Ok(()),
        "blur" => effect_number(&effect.parameters, "radius", 0.0, 20.0, 0.0).map(drop),
        kind => Err(MediaError::InvalidInput(format!(
            "unsupported enabled editor effect: {kind}"
        ))),
    }
}

fn effect_filter(effect: &EditorEffect) -> MediaResult<String> {
    match effect.kind.as_str() {
        "color_adjust" => {
            let brightness = effect_number(&effect.parameters, "brightness", -1.0, 1.0, 0.0)?;
            let contrast = effect_number(&effect.parameters, "contrast", 0.0, 3.0, 1.0)?;
            let saturation = effect_number(&effect.parameters, "saturation", 0.0, 3.0, 1.0)?;
            let channel = format!("clip((val-128)*{contrast:.6}+128+{brightness:.6}*255,0,255)");
            Ok(format!(
                "lutrgb=r='{channel}':g='{channel}':b='{channel}',hue=s={saturation:.6}"
            ))
        }
        "grayscale" => Ok("hue=s=0".to_owned()),
        "blur" => {
            let radius = effect_number(&effect.parameters, "radius", 0.0, 20.0, 0.0)?;
            Ok(format!("gblur=sigma={radius:.6}"))
        }
        kind => Err(MediaError::InvalidInput(format!(
            "unsupported enabled editor effect: {kind}"
        ))),
    }
}

fn effect_number(
    parameters: &Value,
    key: &str,
    minimum: f64,
    maximum: f64,
    default: f64,
) -> MediaResult<f64> {
    let value = parameters
        .get(key)
        .map_or(default, |value| value.as_f64().unwrap_or(f64::NAN));
    validate_finite_range(value, minimum, maximum, key)?;
    Ok(value)
}

fn source_has_audio(source: &EditorMediaSource, track_kind: TrackKind) -> bool {
    match source.kind {
        EditorMediaKind::Audio => track_kind == TrackKind::Audio,
        EditorMediaKind::Video => source.has_audio,
        EditorMediaKind::Image | EditorMediaKind::Font => false,
    }
}

fn atempo_chain(mut speed: f64) -> Vec<f64> {
    let mut filters = Vec::new();
    while speed > 2.0 {
        filters.push(2.0);
        speed /= 2.0;
    }
    while speed < 0.5 {
        filters.push(0.5);
        speed /= 0.5;
    }
    if (speed - 1.0).abs() > 0.000_001 || filters.is_empty() {
        filters.push(speed);
    }
    filters
}

fn validated_transition_duration(
    transition: &EditorTransition,
    clip_duration: f64,
) -> MediaResult<f64> {
    validate_finite_range(
        transition.duration_seconds,
        0.05,
        5.0,
        "transition duration",
    )?;
    if transition.duration_seconds >= clip_duration {
        return Err(MediaError::InvalidInput(format!(
            "transition duration {:.6} is longer than the rendered clip",
            transition.duration_seconds
        )));
    }
    Ok(transition.duration_seconds)
}

fn ffmpeg_color(value: &str) -> MediaResult<String> {
    let value = value.trim();
    let hex = value.strip_prefix('#').unwrap_or(value);
    if (hex.len() == 6 || hex.len() == 8)
        && hex.chars().all(|character| character.is_ascii_hexdigit())
    {
        Ok(format!("0x{}", hex.to_ascii_uppercase()))
    } else {
        Err(MediaError::InvalidInput(
            "colors must be #RRGGBB or #RRGGBBAA".to_owned(),
        ))
    }
}

fn font_filter_option(family: &str, custom_path: Option<&Path>) -> MediaResult<String> {
    if let Some(path) = custom_path {
        let supported = path
            .extension()
            .and_then(|value| value.to_str())
            .is_some_and(|extension| {
                extension.eq_ignore_ascii_case("ttf") || extension.eq_ignore_ascii_case("otf")
            });
        if !supported || !path.is_file() {
            return Err(MediaError::InvalidInput(
                "custom font must be a managed .ttf or .otf file".to_owned(),
            ));
        }
        return Ok(format!(
            "fontfile='{}'",
            escape_filter_value(path.to_string_lossy().as_ref())?
        ));
    }
    let candidates: &[&str] = if cfg!(windows) {
        &["C:/Windows/Fonts/arial.ttf", "C:/Windows/Fonts/segoeui.ttf"]
    } else if cfg!(target_os = "macos") {
        &["/System/Library/Fonts/Supplemental/Arial.ttf"]
    } else {
        &[
            "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
            "/usr/share/fonts/TTF/DejaVuSans.ttf",
        ]
    };
    if let Some(path) = candidates.iter().find(|path| Path::new(path).is_file()) {
        return Ok(format!("fontfile='{}'", escape_filter_value(path)?));
    }
    Ok(format!("font='{}'", escape_filter_value(family)?))
}

fn escape_filter_value(value: &str) -> MediaResult<String> {
    if value.contains('\0') {
        return Err(MediaError::InvalidInput(
            "filter text cannot contain NUL".to_owned(),
        ));
    }
    let mut escaped = String::with_capacity(value.len());
    for character in value.chars() {
        match character {
            '\\' => escaped.push_str("\\\\"),
            // A typographic apostrophe is visually equivalent and avoids an
            // ambiguous quote token across FFmpeg's two filter parsing layers.
            '\'' => escaped.push('’'),
            ':' => escaped.push_str("\\:"),
            ',' => escaped.push_str("\\,"),
            ';' => escaped.push_str("\\;"),
            '[' => escaped.push_str("\\["),
            ']' => escaped.push_str("\\]"),
            '\n' | '\r' => escaped.push_str("\\n"),
            character => escaped.push(character),
        }
    }
    Ok(escaped)
}

/// Publishes a non-empty temporary file without replacing an existing output.
///
/// # Errors
///
/// Returns an error if either path is invalid, output already exists, or the
/// same-directory create-new publication fails.
pub fn publish_temporary_output(temporary: &Path, output: &Path) -> MediaResult<()> {
    let metadata = std::fs::metadata(temporary).map_err(|error| io_error(temporary, error))?;
    if !metadata.is_file() || metadata.len() == 0 {
        return Err(MediaError::EmptyOutput(temporary.to_path_buf()));
    }
    match std::fs::hard_link(temporary, output) {
        Ok(()) => {
            if let Err(error) = std::fs::remove_file(temporary) {
                let _ = std::fs::remove_file(output);
                return Err(io_error(temporary, error));
            }
            Ok(())
        }
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            Err(MediaError::OutputExists(output.to_path_buf()))
        }
        Err(error) => Err(io_error(output, error)),
    }
}

fn temporary_output_path(output: &Path) -> MediaResult<PathBuf> {
    let parent = output
        .parent()
        .ok_or_else(|| MediaError::InvalidInput("output has no parent directory".to_owned()))?;
    if !parent.is_dir() {
        return Err(MediaError::InvalidInput(format!(
            "output directory does not exist: {}",
            parent.display()
        )));
    }
    let stem = output
        .file_stem()
        .and_then(|value| value.to_str())
        .ok_or_else(|| MediaError::InvalidInput("output has no valid file name".to_owned()))?;
    let extension = output
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("mp4");
    Ok(parent.join(format!(".{stem}.partial.{}.{extension}", Uuid::new_v4())))
}

fn validate_dimensions(width: u32, height: u32, fps: u32) -> MediaResult<()> {
    if width == 0 || height == 0 || width > 16_384 || height > 16_384 || !(1..=240).contains(&fps) {
        Err(MediaError::InvalidInput(
            "invalid dimensions or frame rate".to_owned(),
        ))
    } else {
        Ok(())
    }
}

fn validate_finite_range(value: f64, minimum: f64, maximum: f64, name: &str) -> MediaResult<()> {
    if value.is_finite() && (minimum..=maximum).contains(&value) {
        Ok(())
    } else {
        Err(MediaError::InvalidInput(format!(
            "{name} must be between {minimum} and {maximum}"
        )))
    }
}

fn validated_encoder(value: &str) -> MediaResult<&'static str> {
    match value.trim().to_ascii_lowercase().as_str() {
        "libopenh264" => Ok("libopenh264"),
        "h264_mf" => Ok("h264_mf"),
        "h264_nvenc" => Ok("h264_nvenc"),
        "hevc_nvenc" => Ok("hevc_nvenc"),
        "h264_amf" => Ok("h264_amf"),
        "h264_qsv" => Ok("h264_qsv"),
        _ => Err(MediaError::InvalidInput(format!(
            "unsupported encoder: {value}"
        ))),
    }
}

const fn quality_to_crf(quality: u8) -> u8 {
    let quality = if quality > 100 { 100 } else { quality };
    35 - (quality / 4)
}

fn encoder_quality_args(encoder: &str, quality: u8) -> Vec<OsString> {
    let value = quality_to_crf(quality).to_string();
    match encoder {
        "h264_nvenc" | "hevc_nvenc" => vec![OsString::from("-cq:v"), OsString::from(value)],
        "h264_qsv" => vec![OsString::from("-global_quality"), OsString::from(value)],
        "h264_amf" => vec![
            OsString::from("-qp_i"),
            OsString::from(&value),
            OsString::from("-qp_p"),
            OsString::from(value),
        ],
        "h264_mf" => vec![
            OsString::from("-rate_control"),
            OsString::from("quality"),
            OsString::from("-quality"),
            OsString::from(quality.min(100).to_string()),
        ],
        "libopenh264" => vec![
            OsString::from("-b:v"),
            OsString::from(format!("{}k", 500 + u32::from(quality.min(100)) * 100)),
        ],
        _ => vec![OsString::from("-crf"), OsString::from(value)],
    }
}
#[cfg(test)]
mod tests {
    use chrono::Utc;

    use super::*;
    use vibe_cs_domain::{
        EditingDocument, Project, TimelineClip, TimelineClipMaterial, TimelineClipTransitions,
        TimelinePlacement, TimelineTrack,
    };

    #[test]
    fn canonical_project_is_the_only_export_document() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let source = directory.path().join("take.mp4");
        std::fs::write(&source, b"video").expect("source");
        let asset_id = Uuid::new_v4();
        let track_id = Uuid::new_v4();
        let project = Project {
            id: Uuid::new_v4(),
            name: "Canonical".to_owned(),
            revision: 1,
            document: EditingDocument {
                width: 1920,
                height: 1080,
                fps: 60,
                duration_seconds: 5.0,
                story_track_id: track_id,
                tracks: vec![TimelineTrack {
                    id: track_id,
                    name: "Story".to_owned(),
                    kind: TrackKind::Video,
                    order: 0,
                    muted: false,
                    locked: false,
                    hidden: false,
                    clips: vec![TimelineClip {
                        id: Uuid::new_v4(),
                        name: "Take".to_owned(),
                        capture_intent: None,
                        material: TimelineClipMaterial::Asset {
                            asset_id,
                            media_duration_seconds: 5.0,
                        },
                        placement: TimelinePlacement {
                            start: 0.0,
                            duration: 5.0,
                            source_in: 0.0,
                            source_out: 5.0,
                            speed: 1.0,
                            volume: 1.0,
                            enabled: true,
                        },
                        transform: Transform::default(),
                        effects: Vec::new(),
                        transitions: TimelineClipTransitions::default(),
                        text: None,
                        metadata: serde_json::json!({}),
                        group_id: None,
                        link_group_id: None,
                        keyframes: Vec::new(),
                        speed_segments: Vec::new(),
                    }],
                }],
                markers: Vec::new(),
                settings: vibe_cs_domain::EditingDocumentSettings::default(),
            },
            created_at: Utc::now(),
            updated_at: Utc::now(),
        };
        let sources = HashMap::from([(
            asset_id.to_string(),
            EditorMediaSource {
                path: source.clone(),
                kind: EditorMediaKind::Video,
                has_audio: true,
            },
        )]);
        let output = directory.path().join("final.mp4");
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
        .expect("Project render plan");

        assert!((plan.duration_seconds - 5.0).abs() < f64::EPSILON);
        assert!(plan.command.args.contains(&source.into_os_string()));
    }

    #[test]
    fn independent_audio_tracks_mix_with_gain_fades_and_mute_in_final_export() {
        let directory = tempfile::tempdir().expect("temporary directory");
        let first_source = directory.path().join("first.wav");
        let second_source = directory.path().join("second.wav");
        std::fs::write(&first_source, b"first").expect("first source");
        std::fs::write(&second_source, b"second").expect("second source");
        let story_id = Uuid::new_v4();
        let first_asset = Uuid::new_v4();
        let second_asset = Uuid::new_v4();
        let audio_clip =
            |name: &str, asset_id: Uuid, start: f64, volume: f64, fade: bool| TimelineClip {
                id: Uuid::new_v4(),
                name: name.to_owned(),
                capture_intent: None,
                material: TimelineClipMaterial::Asset {
                    asset_id,
                    media_duration_seconds: 8.0,
                },
                placement: TimelinePlacement {
                    start,
                    duration: 8.0,
                    source_in: 0.0,
                    source_out: 8.0,
                    speed: 1.0,
                    volume,
                    enabled: true,
                },
                transform: Transform::default(),
                effects: Vec::new(),
                transitions: TimelineClipTransitions {
                    video_in: None,
                    video_out: None,
                    audio_in: fade.then(|| EditorTransition {
                        kind: EditorTransitionKind::Fade,
                        duration_seconds: 1.5,
                    }),
                    audio_out: fade.then(|| EditorTransition {
                        kind: EditorTransitionKind::Fade,
                        duration_seconds: 1.5,
                    }),
                },
                text: None,
                metadata: serde_json::json!({}),
                group_id: None,
                link_group_id: None,
                keyframes: if fade {
                    vec![EditorKeyframe {
                        id: Uuid::new_v4(),
                        time: 4.0,
                        property: EditorKeyframeProperty::Volume,
                        value: 0.5,
                    }]
                } else {
                    Vec::new()
                },
                speed_segments: Vec::new(),
            };
        let mut project = Project {
            id: Uuid::new_v4(),
            name: "Audio-only export".to_owned(),
            revision: 1,
            document: EditingDocument {
                width: 1920,
                height: 1080,
                fps: 60,
                duration_seconds: 12.0,
                story_track_id: story_id,
                tracks: vec![
                    TimelineTrack {
                        id: story_id,
                        name: "Story".to_owned(),
                        kind: TrackKind::Video,
                        order: 0,
                        muted: false,
                        locked: false,
                        hidden: false,
                        clips: Vec::new(),
                    },
                    TimelineTrack {
                        id: Uuid::new_v4(),
                        name: "A1".to_owned(),
                        kind: TrackKind::Audio,
                        order: 1,
                        muted: false,
                        locked: false,
                        hidden: false,
                        clips: vec![audio_clip("First", first_asset, 0.0, 1.0, true)],
                    },
                    TimelineTrack {
                        id: Uuid::new_v4(),
                        name: "A2".to_owned(),
                        kind: TrackKind::Audio,
                        order: 2,
                        muted: false,
                        locked: false,
                        hidden: false,
                        clips: vec![audio_clip("Second", second_asset, 4.0, 0.25, false)],
                    },
                ],
                markers: Vec::new(),
                settings: vibe_cs_domain::EditingDocumentSettings::default(),
            },
            created_at: Utc::now(),
            updated_at: Utc::now(),
        };
        let sources = HashMap::from([
            (
                first_asset.to_string(),
                EditorMediaSource {
                    path: first_source.clone(),
                    kind: EditorMediaKind::Audio,
                    has_audio: true,
                },
            ),
            (
                second_asset.to_string(),
                EditorMediaSource {
                    path: second_source.clone(),
                    kind: EditorMediaKind::Audio,
                    has_audio: true,
                },
            ),
        ]);
        let options = EditorRenderOptions {
            encoder: EncoderSelection {
                primary: "libopenh264".to_owned(),
                fallback: None,
            },
            quality: 80,
            range_start: None,
            range_end: None,
        };
        let plan = build_project_plan_with_sources(
            &project,
            &sources,
            &directory.path().join("mixed.mp4"),
            &options,
        )
        .expect("mixed audio plan");
        let filter = filter_graph(&plan.command).expect("filter graph");

        assert!(filter.contains("volume='") && filter.contains("eval=frame"));
        assert!(filter.contains("afade=t=in:st=0:d=1.500000"));
        assert!(filter.contains("afade=t=out:st=6.500000:d=1.500000"));
        assert!(filter.contains("volume=0.250000"));
        assert!(filter.contains("adelay=delays=192000S:all=1"));
        assert!(filter.contains("amix=inputs=2"));
        assert!(
            plan.command
                .args
                .contains(&first_source.clone().into_os_string())
        );
        assert!(
            plan.command
                .args
                .contains(&second_source.clone().into_os_string())
        );

        project.document.tracks[2].muted = true;
        let muted = build_project_plan_with_sources(
            &project,
            &sources,
            &directory.path().join("muted.mp4"),
            &options,
        )
        .expect("muted audio plan");
        let muted_filter = filter_graph(&muted.command).expect("muted filter graph");
        assert!(!muted.command.args.contains(&second_source.into_os_string()));
        assert!(!muted_filter.contains("amix="));
        assert!(muted_filter.contains("afade=t=in"));
    }

    fn filter_graph(command: &CommandSpec) -> Option<String> {
        command
            .args
            .windows(2)
            .find(|pair| pair[0] == "-filter_complex")
            .map(|pair| pair[1].to_string_lossy().into_owned())
    }
}
