use std::{
    collections::HashMap,
    ffi::OsString,
    fmt::Write as _,
    hash::BuildHasher,
    path::{Path, PathBuf},
    sync::Arc,
};

use serde_json::Value;
use uuid::Uuid;
use vibe_cs_domain::{
    EditorClip, EditorEffect, EditorKeyframeProperty, EditorProject, EditorSpeedSegment,
    MontageBrandingTheme, MontageClip, MontageProject, TextStyle, TrackKind, Transform,
};

use crate::{
    CommandSpec, FfmpegProgress, MediaError, MediaResult, ProcessCancellation, ProcessRunner,
    ProgressCallback, io_error,
};

const SOFTWARE_ENCODER: &str = "libx264";
const HARDWARE_ENCODERS: &[&str] = &["h264_qsv", "h264_nvenc", "h264_amf"];
const DEFAULT_TRANSITION_SECONDS: f64 = 0.35;

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
/// always keeps `libx264` as the runtime fallback.
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

#[derive(Debug, Clone, PartialEq)]
pub struct MontageSource {
    pub path: PathBuf,
    pub duration_seconds: Option<f64>,
    pub has_audio: bool,
    pub avatar_path: Option<PathBuf>,
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
    ffmpeg: &Path,
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
    let command = CommandSpec::new(ffmpeg).args([
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
    ffmpeg: &Path,
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
        ffmpeg,
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
        .map(|encoder| build_single_input_command(ffmpeg, source, &temporary, options, encoder))
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
    ffmpeg: &Path,
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
    let mut command = CommandSpec::new(ffmpeg).args([
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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Transition {
    Cut,
    Fade,
    Flash,
    Dip,
    Zoom,
    Wipe,
    Slide,
    Blur,
    Glitch,
    Spin,
}

/// Builds a shell-free montage plan. This compatibility entry point treats
/// supplied files as video-with-audio and uses their explicit trim end.
///
/// # Errors
///
/// Returns an error for missing sources, unsafe settings, unsupported values,
/// or an invalid output location.
pub fn build_montage_plan<S: BuildHasher>(
    ffmpeg: &Path,
    project: &MontageProject,
    sources: &HashMap<String, PathBuf, S>,
    output: &Path,
) -> MediaResult<FilterPlan> {
    let expanded = sources
        .iter()
        .map(|(id, path)| {
            (
                id.clone(),
                MontageSource {
                    path: path.clone(),
                    duration_seconds: None,
                    has_audio: true,
                    avatar_path: None,
                },
            )
        })
        .collect::<HashMap<_, _>>();
    let encoder = select_video_encoder(&project.settings.encoder, &[])?;
    build_montage_plan_with_sources(ffmpeg, project, &expanded, output, &encoder)
}

/// Builds a complete montage plan with probed duration/audio metadata and an
/// optional software fallback command.
///
/// # Errors
///
/// Returns an error for invalid timing, transitions, text, media, or output.
pub fn build_montage_plan_with_sources<S: BuildHasher>(
    ffmpeg: &Path,
    project: &MontageProject,
    sources: &HashMap<String, MontageSource, S>,
    output: &Path,
    encoder: &EncoderSelection,
) -> MediaResult<FilterPlan> {
    validate_dimensions(
        project.settings.width,
        project.settings.height,
        project.settings.fps,
    )?;
    if project.clips.is_empty() {
        return Err(MediaError::InvalidInput("montage has no clips".to_owned()));
    }
    validate_montage_settings(project)?;
    let temporary = temporary_output_path(output)?;
    let prepared = prepare_montage_clips(project, sources)?;
    let primary = build_montage_command(
        ffmpeg,
        project,
        &prepared,
        &temporary,
        validated_encoder(&encoder.primary)?,
    )?;
    let fallback_command = encoder
        .fallback
        .as_deref()
        .map(validated_encoder)
        .transpose()?
        .map(|fallback| build_montage_command(ffmpeg, project, &prepared, &temporary, fallback))
        .transpose()?;
    let duration_seconds = montage_duration(project, &prepared)?;
    Ok(FilterPlan {
        command: primary,
        fallback_command,
        temporary_output: temporary,
        final_output: output.to_path_buf(),
        duration_seconds,
    })
}

#[derive(Debug)]
struct PreparedMontageClip<'a> {
    clip: &'a MontageClip,
    source: &'a MontageSource,
    duration: f64,
    transition: Transition,
}

fn prepare_montage_clips<'a, S: BuildHasher>(
    project: &'a MontageProject,
    sources: &'a HashMap<String, MontageSource, S>,
) -> MediaResult<Vec<PreparedMontageClip<'a>>> {
    let mut sorted = project.clips.iter().collect::<Vec<_>>();
    sorted.sort_by_key(|clip| clip.order);
    let mut prepared = Vec::with_capacity(sorted.len());
    for clip in sorted {
        if !clip.trim_start.is_finite() || clip.trim_start < 0.0 {
            return Err(MediaError::InvalidInput(
                "clip trim_start must be finite and non-negative".to_owned(),
            ));
        }
        let source = sources.get(&clip.clip_id.to_string()).ok_or_else(|| {
            MediaError::InvalidInput(format!("missing source for clip {}", clip.clip_id))
        })?;
        if !source.path.is_file() {
            return Err(MediaError::InvalidInput(format!(
                "clip source does not exist: {}",
                source.path.display()
            )));
        }
        let trim_end = clip.trim_end.or(source.duration_seconds).ok_or_else(|| {
            MediaError::InvalidInput(format!(
                "clip {} requires trim_end or probed duration",
                clip.clip_id
            ))
        })?;
        if !trim_end.is_finite() || trim_end <= clip.trim_start {
            return Err(MediaError::InvalidInput(
                "clip trim_end must be after trim_start".to_owned(),
            ));
        }
        if source
            .duration_seconds
            .is_some_and(|duration| trim_end > duration + 0.001)
        {
            return Err(MediaError::InvalidInput(format!(
                "clip {} trim exceeds source duration",
                clip.clip_id
            )));
        }
        prepared.push(PreparedMontageClip {
            clip,
            source,
            duration: trim_end - clip.trim_start,
            transition: parse_transition(&clip.transition)?,
        });
    }
    Ok(prepared)
}

fn validate_montage_settings(project: &MontageProject) -> MediaResult<()> {
    let settings = &project.settings;
    validate_finite_range(
        settings.transition_seconds,
        0.05,
        5.0,
        "transition duration",
    )?;
    validate_finite_range(settings.music_volume, 0.0, 2.0, "background music volume")?;
    validate_finite_range(settings.intro_duration_seconds, 0.0, 30.0, "intro duration")?;
    validate_finite_range(settings.outro_duration_seconds, 0.0, 30.0, "outro duration")?;
    validate_finite_range(
        settings.name_card_duration_seconds,
        0.1,
        15.0,
        "name card duration",
    )?;
    if settings.intro_duration_seconds > 0.0 {
        let title = settings
            .intro_title
            .as_deref()
            .map(str::trim)
            .filter(|title| !title.is_empty())
            .ok_or_else(|| {
                MediaError::InvalidInput("intro duration requires an intro title".to_owned())
            })?;
        validate_text_length(title, 200, "intro title")?;
    }
    if settings.outro_duration_seconds > 0.0 {
        let title = settings
            .outro_title
            .as_deref()
            .map(str::trim)
            .filter(|title| !title.is_empty())
            .ok_or_else(|| {
                MediaError::InvalidInput("outro duration requires an outro title".to_owned())
            })?;
        validate_text_length(title, 200, "outro title")?;
    }
    if let Some(path) = settings.background_music.as_deref()
        && !Path::new(path).is_file()
    {
        return Err(MediaError::InvalidInput(format!(
            "background music does not exist: {path}"
        )));
    }
    Ok(())
}

fn montage_duration(
    project: &MontageProject,
    prepared: &[PreparedMontageClip<'_>],
) -> MediaResult<f64> {
    let mut duration = project.settings.intro_duration_seconds;
    for (index, item) in prepared.iter().enumerate() {
        if index > 0 && item.transition != Transition::Cut {
            let transition = project.settings.transition_seconds;
            if transition >= duration || transition >= item.duration {
                return Err(MediaError::InvalidInput(format!(
                    "transition before clip {} is longer than an adjacent segment",
                    item.clip.clip_id
                )));
            }
            duration -= transition;
        }
        duration += item.duration;
    }
    duration += project.settings.outro_duration_seconds;
    Ok(duration)
}

fn build_montage_command(
    ffmpeg: &Path,
    project: &MontageProject,
    prepared: &[PreparedMontageClip<'_>],
    temporary: &Path,
    encoder: &str,
) -> MediaResult<CommandSpec> {
    let mut command = CommandSpec::new(ffmpeg).args(["-hide_banner", "-nostdin", "-y"]);
    let mut inputs = Vec::with_capacity(prepared.len());
    let mut next_input = 0_usize;
    for item in prepared {
        command = command.args([
            OsString::from("-i"),
            item.source.path.as_os_str().to_os_string(),
        ]);
        let video_input = next_input;
        next_input += 1;
        let (audio_input, silent) = if item.source.has_audio {
            (video_input, false)
        } else {
            command = command.args([
                OsString::from("-f"),
                OsString::from("lavfi"),
                OsString::from("-t"),
                OsString::from(format!("{:.6}", item.duration)),
                OsString::from("-i"),
                OsString::from("anullsrc=r=48000:cl=stereo"),
            ]);
            let input = next_input;
            next_input += 1;
            (input, true)
        };
        let avatar_input = if let Some(path) = item.source.avatar_path.as_deref() {
            if !path.is_file() {
                return Err(MediaError::InvalidInput(format!(
                    "avatar source does not exist: {}",
                    path.display()
                )));
            }
            command = command.args([
                OsString::from("-loop"),
                OsString::from("1"),
                OsString::from("-framerate"),
                OsString::from(project.settings.fps.to_string()),
                OsString::from("-i"),
                path.as_os_str().to_os_string(),
            ]);
            let input = next_input;
            next_input += 1;
            Some(input)
        } else {
            None
        };
        inputs.push((video_input, audio_input, silent, avatar_input));
    }
    let music_input = if let Some(music) = project.settings.background_music.as_deref() {
        command = command.args([
            OsString::from("-stream_loop"),
            OsString::from("-1"),
            OsString::from("-i"),
            Path::new(music).as_os_str().to_os_string(),
        ]);
        Some(next_input)
    } else {
        None
    };

    let mut filters = Vec::new();
    let mut segments = Vec::new();
    if project.settings.intro_duration_seconds > 0.0 {
        let duration = project.settings.intro_duration_seconds;
        let title = project.settings.intro_title.as_deref().unwrap_or_default();
        let (background, _) = montage_theme_colors(project.settings.branding_theme);
        filters.push(format!(
            "color=c={background}:s={}x{}:r={}:d={duration:.6},settb=AVTB,{}[intro_v]",
            project.settings.width,
            project.settings.height,
            project.settings.fps,
            montage_drawtext(
                title,
                true,
                duration,
                project.settings.height,
                project.settings.branding_theme,
            )?
        ));
        filters.push(format!(
            "anullsrc=r=48000:cl=stereo:d={duration:.6},asettb=1/48000[intro_a]"
        ));
        segments.push((
            "intro_v".to_owned(),
            "intro_a".to_owned(),
            duration,
            Transition::Cut,
        ));
    }
    for (index, (item, (video_input, audio_input, silent, avatar_input))) in
        prepared.iter().zip(inputs).enumerate()
    {
        let trim_end = item.clip.trim_start + item.duration;
        let mut video = format!(
            "[{video_input}:v:0]trim=start={:.6}:end={trim_end:.6},setpts=PTS-STARTPTS,scale={}:{}:force_original_aspect_ratio=decrease,pad={}:{}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,fps={},settb=AVTB,format=yuv420p",
            item.clip.trim_start,
            project.settings.width,
            project.settings.height,
            project.settings.width,
            project.settings.height,
            project.settings.fps
        );
        if project.settings.include_name_cards
            && let Some(title) = item
                .clip
                .title
                .as_deref()
                .filter(|title| !title.trim().is_empty())
        {
            validate_text_length(title, 200, "name card")?;
            let visible = item
                .duration
                .min(project.settings.name_card_duration_seconds);
            if let Some(avatar_input) = avatar_input {
                let base_label = format!("clip_base{index}");
                let avatar_label = format!("avatar{index}");
                let card_label = format!("clip_card{index}");
                let _ = write!(video, "[{base_label}]");
                filters.push(video);
                filters.push(format!(
                    "[{avatar_input}:v:0]scale=96:96:force_original_aspect_ratio=increase,crop=96:96,format=rgba[{avatar_label}]"
                ));
                filters.push(format!(
                    "[{base_label}][{avatar_label}]overlay=x=48:y=H-h-48:enable='between(t,0,{visible:.6})'[{card_label}]"
                ));
                video = format!(
                    "[{card_label}]{}",
                    montage_drawtext(
                        title,
                        false,
                        visible,
                        project.settings.height,
                        project.settings.branding_theme,
                    )?
                );
            } else {
                let _ = write!(
                    video,
                    ",{}",
                    montage_drawtext(
                        title,
                        false,
                        visible,
                        project.settings.height,
                        project.settings.branding_theme,
                    )?
                );
            }
        }
        let video_label = format!("clip_v{index}");
        let _ = write!(video, "[{video_label}]");
        filters.push(video);

        let (audio_start, audio_end) = if silent {
            (0.0, item.duration)
        } else {
            (item.clip.trim_start, trim_end)
        };
        let audio_label = format!("clip_a{index}");
        filters.push(format!(
            "[{audio_input}:a:0]atrim=start={audio_start:.6}:end={audio_end:.6},asetpts=PTS-STARTPTS,aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,asettb=1/48000[{audio_label}]"
        ));
        segments.push((video_label, audio_label, item.duration, item.transition));
    }

    if project.settings.outro_duration_seconds > 0.0 {
        let duration = project.settings.outro_duration_seconds;
        let title = project.settings.outro_title.as_deref().unwrap_or_default();
        let (background, _) = montage_theme_colors(project.settings.branding_theme);
        filters.push(format!(
            "color=c={background}:s={}x{}:r={}:d={duration:.6},settb=AVTB,{}[outro_v]",
            project.settings.width,
            project.settings.height,
            project.settings.fps,
            montage_drawtext(
                title,
                true,
                duration,
                project.settings.height,
                project.settings.branding_theme,
            )?
        ));
        filters.push(format!(
            "anullsrc=r=48000:cl=stereo:d={duration:.6},asettb=1/48000[outro_a]"
        ));
        segments.push((
            "outro_v".to_owned(),
            "outro_a".to_owned(),
            duration,
            Transition::Cut,
        ));
    }

    let mut previous_video = segments[0].0.clone();
    let mut previous_audio = segments[0].1.clone();
    let mut elapsed = segments[0].2;
    for (index, (video, audio, duration, transition)) in segments.iter().enumerate().skip(1) {
        let next_video = format!("sequence_v{index}");
        let next_audio = format!("sequence_a{index}");
        match transition {
            Transition::Cut => {
                filters.push(format!(
                    "[{previous_video}][{video}]concat=n=2:v=1:a=0[{next_video}]"
                ));
                filters.push(format!(
                    "[{previous_audio}][{audio}]concat=n=2:v=0:a=1[{next_audio}]"
                ));
                elapsed += duration;
            }
            Transition::Fade
            | Transition::Flash
            | Transition::Dip
            | Transition::Zoom
            | Transition::Wipe
            | Transition::Slide
            | Transition::Blur
            | Transition::Glitch
            | Transition::Spin => {
                let transition_duration = project.settings.transition_seconds;
                if transition_duration >= elapsed || transition_duration >= *duration {
                    return Err(MediaError::InvalidInput(
                        "transition is longer than an adjacent segment".to_owned(),
                    ));
                }
                let kind = match transition {
                    Transition::Fade => "fade",
                    Transition::Flash => "fadewhite",
                    Transition::Dip => "fadeblack",
                    Transition::Zoom => "zoomin",
                    Transition::Wipe => "wipeleft",
                    Transition::Slide => "slideleft",
                    Transition::Blur => "smoothleft",
                    Transition::Glitch => "pixelize",
                    Transition::Spin => "radial",
                    Transition::Cut => unreachable!("cut handled above"),
                };
                let offset = elapsed - transition_duration;
                filters.push(format!(
                    "[{previous_video}][{video}]xfade=transition={kind}:duration={transition_duration:.6}:offset={offset:.6}[{next_video}]"
                ));
                filters.push(format!(
                    "[{previous_audio}][{audio}]acrossfade=d={transition_duration:.6}:c1=tri:c2=tri[{next_audio}]"
                ));
                elapsed += duration - transition_duration;
            }
        }
        previous_video = next_video;
        previous_audio = next_audio;
    }
    filters.push(format!("[{previous_video}]null[outv]"));
    if let Some(input) = music_input {
        let fade_start = (elapsed - 1.0).max(0.0);
        filters.push(format!(
            "[{input}:a:0]atrim=duration={elapsed:.6},asetpts=PTS-STARTPTS,volume={:.4},afade=t=out:st={fade_start:.6}:d={:.6},aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo[music]",
            project.settings.music_volume,
            elapsed.min(1.0)
        ));
        filters.push(format!(
            "[{previous_audio}][music]amix=inputs=2:duration=first:dropout_transition=0,alimiter=limit=0.95[outa]"
        ));
    } else {
        filters.push(format!("[{previous_audio}]anull[outa]"));
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
    command = command.args(encoder_quality_args(encoder, project.settings.quality));
    command = command.args([
        OsString::from("-c:a"),
        OsString::from("aac"),
        OsString::from("-b:a"),
        OsString::from("192k"),
        OsString::from("-t"),
        OsString::from(format!("{elapsed:.6}")),
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

fn montage_drawtext(
    text: &str,
    centered: bool,
    visible_seconds: f64,
    height: u32,
    theme: MontageBrandingTheme,
) -> MediaResult<String> {
    let escaped = escape_filter_value(text)?;
    let font = font_filter_option("Arial", None)?;
    let font_size = if centered {
        (height / 14).clamp(28, 160)
    } else {
        (height / 28).clamp(22, 80)
    };
    let (x, y) = if centered {
        ("(w-text_w)/2", "(h-text_h)/2")
    } else {
        ("48", "h-text_h-48")
    };
    let (_, accent) = montage_theme_colors(theme);
    Ok(format!(
        "drawtext={font}:text='{escaped}':expansion=none:fontsize={font_size}:fontcolor={accent}:box=1:boxcolor=black@0.72:boxborderw=18:x={x}:y={y}:enable='between(t,0,{visible_seconds:.6})'"
    ))
}

fn montage_theme_colors(theme: MontageBrandingTheme) -> (&'static str, &'static str) {
    match theme {
        MontageBrandingTheme::Vibe => ("0x080b10", "white"),
        MontageBrandingTheme::Broadcast => ("0x111827", "0xF59E0B"),
        MontageBrandingTheme::Minimal => ("0xF3F4F6", "0x111827"),
        MontageBrandingTheme::Neon => ("0x070A12", "0x22D3EE"),
    }
}

/// Builds a shell-free editor plan using video-with-audio compatibility
/// sources and a full-timeline range.
///
/// # Errors
///
/// Returns an error for invalid timing, missing assets, unsupported encoders,
/// or an invalid output location.
pub fn build_editor_plan<S: BuildHasher>(
    ffmpeg: &Path,
    project: &EditorProject,
    assets: &HashMap<String, PathBuf, S>,
    output: &Path,
    encoder: &str,
) -> MediaResult<FilterPlan> {
    let expanded = assets
        .iter()
        .map(|(id, path)| {
            (
                id.clone(),
                EditorMediaSource {
                    path: path.clone(),
                    kind: EditorMediaKind::Video,
                    has_audio: true,
                },
            )
        })
        .collect::<HashMap<_, _>>();
    let options = EditorRenderOptions {
        encoder: select_video_encoder(encoder, &[])?,
        ..EditorRenderOptions::default()
    };
    build_editor_plan_with_sources(ffmpeg, project, &expanded, output, &options)
}

/// Builds a compositing plan for video, audio, image, text, and overlay tracks.
///
/// # Errors
///
/// Returns an error for invalid timing, range, media, transform, effect,
/// transition, text style, encoder, or output.
pub fn build_editor_plan_with_sources<S: BuildHasher>(
    ffmpeg: &Path,
    project: &EditorProject,
    assets: &HashMap<String, EditorMediaSource, S>,
    output: &Path,
    options: &EditorRenderOptions,
) -> MediaResult<FilterPlan> {
    project
        .validate()
        .map_err(|error| MediaError::InvalidInput(error.to_string()))?;
    validate_dimensions(project.width, project.height, project.fps)?;
    if !project.duration_seconds.is_finite() || project.duration_seconds <= 0.0 {
        return Err(MediaError::InvalidInput(
            "editor duration must be finite and positive".to_owned(),
        ));
    }
    let (range_start, range_end) = validate_export_range(project, options)?;
    let duration = range_end - range_start;
    let temporary = temporary_output_path(output)?;
    let primary_encoder = validated_encoder(&options.encoder.primary)?;
    let command = build_editor_command(
        ffmpeg,
        project,
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
                ffmpeg,
                project,
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
    project: &EditorProject,
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
    clip: &EditorClip,
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
    clip: &'a EditorClip,
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
    ffmpeg: &Path,
    project: &EditorProject,
    assets: &HashMap<String, EditorMediaSource, S>,
    temporary: &Path,
    options: &EditorRenderOptions,
    range_start: f64,
    range_end: f64,
    encoder: &str,
) -> MediaResult<CommandSpec> {
    let duration = range_end - range_start;
    let mut command = CommandSpec::new(ffmpeg).args(["-hide_banner", "-nostdin", "-y"]);
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

fn validate_editor_clip(clip: &EditorClip) -> MediaResult<()> {
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
    for transition in [&clip.transition_in, &clip.transition_out] {
        if let Some(transition) = transition.as_deref() {
            let _ = parse_transition(transition)?;
        }
    }
    for effect in &clip.effects {
        validate_effect(effect)?;
    }
    Ok(())
}

fn validate_editor_media_combination(
    track_kind: TrackKind,
    clip: &EditorClip,
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

fn clip_has_keyframes(clip: &EditorClip, properties: &[EditorKeyframeProperty]) -> bool {
    clip.keyframes
        .iter()
        .any(|keyframe| properties.contains(&keyframe.property))
}

fn keyframe_expression(
    clip: &EditorClip,
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
    project: &EditorProject,
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

fn append_visual_fades(filter: &mut String, clip: &EditorClip, duration: f64) -> MediaResult<()> {
    let transition_duration = editor_transition_duration(clip, duration)?;
    if let Some(transition) = parsed_optional_transition(clip.transition_in.as_deref())? {
        append_editor_visual_transition(filter, transition, true, transition_duration, duration);
    }
    if let Some(transition) = parsed_optional_transition(clip.transition_out.as_deref())? {
        append_editor_visual_transition(filter, transition, false, transition_duration, duration);
    }
    Ok(())
}

fn append_editor_visual_transition(
    filter: &mut String,
    transition: Transition,
    entering: bool,
    transition_duration: f64,
    clip_duration: f64,
) {
    if transition == Transition::Cut {
        return;
    }
    let start = if entering {
        0.0
    } else {
        clip_duration - transition_duration
    };
    let fade_kind = if entering { "in" } else { "out" };
    match transition {
        Transition::Cut => {}
        Transition::Fade => {
            let _ = write!(
                filter,
                ",fade=t={fade_kind}:st={start:.6}:d={transition_duration:.6}:alpha=1"
            );
        }
        Transition::Flash | Transition::Dip => {
            let color = if transition == Transition::Flash {
                "white"
            } else {
                "black"
            };
            let _ = write!(
                filter,
                ",fade=t={fade_kind}:st={start:.6}:d={transition_duration:.6}:color={color}"
            );
        }
        Transition::Zoom => {
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
        Transition::Wipe | Transition::Slide => {
            let progress = if entering {
                format!("min(1\\,T/{transition_duration:.6})")
            } else {
                format!("max(0\\,1-(T-{start:.6})/{transition_duration:.6})")
            };
            let feather = if transition == Transition::Wipe {
                2
            } else {
                48
            };
            let _ = write!(
                filter,
                ",geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='alpha(X,Y)*clip((({progress})*W-X)/{feather}\\,0\\,1)'"
            );
        }
        Transition::Blur => {
            let end = start + transition_duration;
            let _ = write!(
                filter,
                ",gblur=sigma=8:enable='between(t,{start:.6},{end:.6})'"
            );
        }
        Transition::Glitch => {
            let end = start + transition_duration;
            let _ = write!(
                filter,
                ",chromashift=cbh=8:crh=-8:edge=smear:enable='between(t,{start:.6},{end:.6})'"
            );
        }
        Transition::Spin => {
            let angle = if entering {
                format!("0.35*max(0\\,1-t/{transition_duration:.6})")
            } else {
                format!("0.35*max(0\\,(t-{start:.6})/{transition_duration:.6})")
            };
            let _ = write!(filter, ",rotate='{angle}':c=none:ow=iw:oh=ih");
        }
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
    let transition_duration = editor_transition_duration(clip, item.duration)?;
    if transition_is_active(clip.transition_in.as_deref())? {
        let _ = write!(filter, ",afade=t=in:st=0:d={transition_duration:.6}");
    }
    if transition_is_active(clip.transition_out.as_deref())? {
        let start = item.duration - transition_duration;
        let _ = write!(
            filter,
            ",afade=t=out:st={start:.6}:d={transition_duration:.6}"
        );
    }
    let _ = write!(
        filter,
        ",aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,asetpts=PTS+{:.6}/TB[{label}]",
        item.timeline_start
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
    if transition_is_active(item.clip.transition_in.as_deref())?
        || transition_is_active(item.clip.transition_out.as_deref())?
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
        "color_adjust" => Ok(format!(
            "eq=brightness={:.6}:contrast={:.6}:saturation={:.6}",
            effect_number(&effect.parameters, "brightness", -1.0, 1.0, 0.0)?,
            effect_number(&effect.parameters, "contrast", 0.0, 3.0, 1.0)?,
            effect_number(&effect.parameters, "saturation", 0.0, 3.0, 1.0)?
        )),
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

fn editor_transition_duration(clip: &EditorClip, duration: f64) -> MediaResult<f64> {
    let configured = clip
        .metadata
        .get("transition_duration")
        .and_then(Value::as_f64)
        .unwrap_or(DEFAULT_TRANSITION_SECONDS);
    validate_finite_range(configured, 0.05, 5.0, "transition duration")?;
    if configured * 2.0 >= duration
        && transition_is_active(clip.transition_in.as_deref())?
        && transition_is_active(clip.transition_out.as_deref())?
    {
        return Err(MediaError::InvalidInput(format!(
            "clip {} is too short for both transitions",
            clip.id
        )));
    }
    if configured >= duration
        && (transition_is_active(clip.transition_in.as_deref())?
            || transition_is_active(clip.transition_out.as_deref())?)
    {
        return Err(MediaError::InvalidInput(format!(
            "clip {} transition is longer than the rendered clip",
            clip.id
        )));
    }
    Ok(configured)
}

fn parsed_optional_transition(value: Option<&str>) -> MediaResult<Option<Transition>> {
    value.map(parse_transition).transpose()
}

fn transition_is_active(value: Option<&str>) -> MediaResult<bool> {
    parsed_optional_transition(value)
        .map(|transition| transition.is_some_and(|transition| transition != Transition::Cut))
}

fn parse_transition(value: &str) -> MediaResult<Transition> {
    match value.trim().to_ascii_lowercase().as_str() {
        "" | "none" | "cut" => Ok(Transition::Cut),
        "fade" | "dissolve" => Ok(Transition::Fade),
        "flash" => Ok(Transition::Flash),
        "dip" => Ok(Transition::Dip),
        "zoom" => Ok(Transition::Zoom),
        "wipe" => Ok(Transition::Wipe),
        "whip" | "slide" | "slideleft" => Ok(Transition::Slide),
        "blur" => Ok(Transition::Blur),
        "glitch" => Ok(Transition::Glitch),
        "spin" => Ok(Transition::Spin),
        _ => Err(MediaError::InvalidInput(format!(
            "unsupported transition: {value}"
        ))),
    }
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

/// Executes a plan, streams machine-readable progress, retries a failed GPU
/// command with the planned software encoder, and atomically publishes output.
///
/// # Errors
///
/// Returns an error on cancellation, process failure, invalid output, or I/O
/// failure. Failed temporary outputs are removed when possible.
pub async fn execute_filter_plan_with_progress(
    runner: &dyn ProcessRunner,
    plan: &FilterPlan,
    cancellation: &ProcessCancellation,
    progress: ProgressCallback,
) -> MediaResult<()> {
    if plan.final_output.exists() {
        return Err(MediaError::OutputExists(plan.final_output.clone()));
    }
    if plan.temporary_output.exists() {
        return Err(MediaError::OutputExists(plan.temporary_output.clone()));
    }
    let mut execution = runner
        .run_with_progress(&plan.command, cancellation, Arc::clone(&progress))
        .await
        .and_then(|output| output.ensure_success().map(drop));
    if matches!(execution, Err(MediaError::ProcessFailed { .. }))
        && !cancellation.is_cancelled()
        && let Some(fallback) = plan.fallback_command.as_ref()
    {
        let _ = std::fs::remove_file(&plan.temporary_output);
        progress(FfmpegProgress::default());
        execution = runner
            .run_with_progress(fallback, cancellation, progress)
            .await
            .and_then(|output| output.ensure_success().map(drop));
    }
    if let Err(error) = execution {
        let _ = std::fs::remove_file(&plan.temporary_output);
        return Err(error);
    }
    if cancellation.is_cancelled() {
        let _ = std::fs::remove_file(&plan.temporary_output);
        return Err(MediaError::Cancelled);
    }
    let publication = publish_temporary_output(&plan.temporary_output, &plan.final_output);
    if publication.is_err() {
        let _ = std::fs::remove_file(&plan.temporary_output);
    }
    publication
}

/// Executes a plan without observing intermediate progress.
///
/// # Errors
///
/// Returns the same failures as [`execute_filter_plan_with_progress`].
pub async fn execute_filter_plan(
    runner: &dyn ProcessRunner,
    plan: &FilterPlan,
    cancellation: &ProcessCancellation,
) -> MediaResult<()> {
    execute_filter_plan_with_progress(runner, plan, cancellation, Arc::new(|_| {})).await
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
        "libx264" => Ok("libx264"),
        "libx265" => Ok("libx265"),
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
        _ => vec![OsString::from("-crf"), OsString::from(value)],
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use async_trait::async_trait;
    use serde_json::json;

    use super::*;
    use crate::ProcessOutput;

    fn montage_project(clip_id: &str) -> MontageProject {
        serde_json::from_value(json!({
            "id": "00000000-0000-4000-8000-000000000002",
            "name": "test",
            "clips": [{
                "clip_id": clip_id,
                "order": 0,
                "trim_start": 1.0,
                "trim_end": 3.0,
                "transition": "cut",
                "title": "Player's ace; [safe]"
            }],
            "settings": {
                "width": 1280,
                "height": 720,
                "fps": 60,
                "encoder": "libx264",
                "quality": 80,
                "background_music": null,
                "music_volume": 0.25,
                "transition_seconds": 0.35,
                "intro_title": null,
                "intro_duration_seconds": 0.0,
                "include_name_cards": true,
                "name_card_duration_seconds": 2.5
            },
            "created_at": "2026-01-01T00:00:00Z",
            "updated_at": "2026-01-01T00:00:00Z"
        }))
        .unwrap()
    }

    #[test]
    fn atomic_publish_refuses_existing_destination() {
        let root = tempfile::tempdir().unwrap();
        let temporary = root.path().join("partial.mp4");
        let output = root.path().join("final.mp4");
        std::fs::write(&temporary, b"video").unwrap();
        std::fs::write(&output, b"old").unwrap();
        assert!(matches!(
            publish_temporary_output(&temporary, &output),
            Err(MediaError::OutputExists(_))
        ));
        assert_eq!(std::fs::read(&output).unwrap(), b"old");
    }

    #[test]
    fn encoder_values_cannot_inject_filter_arguments() {
        assert!(select_video_encoder("libx264 -y injected", &[]).is_err());
    }

    #[test]
    fn auto_encoder_prefers_gpu_and_keeps_cpu_fallback() {
        let selection =
            select_video_encoder("auto", &["h264_amf".to_owned(), "h264_qsv".to_owned()]).unwrap();
        assert_eq!(selection.primary, "h264_qsv");
        assert_eq!(selection.fallback.as_deref(), Some("libx264"));
    }

    #[test]
    fn montage_plan_keeps_paths_as_distinct_arguments_and_escapes_titles() {
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("clip with spaces.mp4");
        std::fs::write(&source, b"media").unwrap();
        let clip_id = "00000000-0000-4000-8000-000000000001";
        let project = montage_project(clip_id);
        let sources = HashMap::from([(clip_id.to_owned(), source.clone())]);
        let plan = build_montage_plan(
            Path::new("ffmpeg"),
            &project,
            &sources,
            &root.path().join("result.mp4"),
        )
        .unwrap();
        assert!(
            plan.command
                .args
                .iter()
                .any(|argument| argument == source.as_os_str())
        );
        let graph = plan
            .command
            .args
            .iter()
            .find_map(|argument| {
                let value = argument.to_string_lossy();
                value.contains("drawtext").then_some(value.into_owned())
            })
            .unwrap_or_else(|| {
                plan.command
                    .args
                    .iter()
                    .map(|value| value.to_string_lossy())
                    .find(|value| value.contains("drawtext"))
                    .unwrap()
                    .into_owned()
            });
        assert!(graph.contains("Player’s ace\\; \\[safe\\]"));
        assert!(plan.command.args.iter().any(|item| item == "pipe:1"));
    }

    #[test]
    fn editor_plan_supports_range_audio_text_transform_and_color() {
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("clip.mp4");
        std::fs::write(&source, b"media").unwrap();
        let asset_id = Uuid::new_v4();
        let now = chrono::Utc::now();
        let project = EditorProject {
            id: Uuid::new_v4(),
            name: "Editor".to_owned(),
            width: 1280,
            height: 720,
            fps: 60,
            duration_seconds: 10.0,
            tracks: vec![vibe_cs_domain::EditorTrack {
                id: Uuid::new_v4(),
                name: "Video".to_owned(),
                kind: TrackKind::Video,
                order: 0,
                muted: false,
                locked: false,
                hidden: false,
                clips: vec![EditorClip {
                    id: Uuid::new_v4(),
                    asset_id: Some(asset_id),
                    name: "Clip".to_owned(),
                    start: 1.0,
                    duration: 8.0,
                    source_in: 2.0,
                    source_out: 12.0,
                    speed: 1.0,
                    volume: 0.8,
                    transform: Transform {
                        x: 20.0,
                        y: -10.0,
                        scale_x: 0.8,
                        scale_y: 0.8,
                        rotation: 5.0,
                        opacity: 0.9,
                    },
                    effects: vec![EditorEffect {
                        id: "color".to_owned(),
                        kind: "color_adjust".to_owned(),
                        enabled: true,
                        parameters: json!({"brightness": 0.1, "contrast": 1.2, "saturation": 0.9}),
                    }],
                    transition_in: Some("fade".to_owned()),
                    transition_out: None,
                    text: None,
                    metadata: json!({"transition_duration": 0.25}),
                    group_id: None,
                    link_group_id: None,
                    keyframes: vec![
                        vibe_cs_domain::EditorKeyframe {
                            id: Uuid::new_v4(),
                            time: 0.0,
                            property: EditorKeyframeProperty::X,
                            value: 0.0,
                        },
                        vibe_cs_domain::EditorKeyframe {
                            id: Uuid::new_v4(),
                            time: 0.0,
                            property: EditorKeyframeProperty::Opacity,
                            value: 0.2,
                        },
                        vibe_cs_domain::EditorKeyframe {
                            id: Uuid::new_v4(),
                            time: 0.0,
                            property: EditorKeyframeProperty::Volume,
                            value: 0.3,
                        },
                        vibe_cs_domain::EditorKeyframe {
                            id: Uuid::new_v4(),
                            time: 8.0,
                            property: EditorKeyframeProperty::X,
                            value: 60.0,
                        },
                        vibe_cs_domain::EditorKeyframe {
                            id: Uuid::new_v4(),
                            time: 8.0,
                            property: EditorKeyframeProperty::Opacity,
                            value: 0.9,
                        },
                        vibe_cs_domain::EditorKeyframe {
                            id: Uuid::new_v4(),
                            time: 8.0,
                            property: EditorKeyframeProperty::Volume,
                            value: 0.8,
                        },
                    ],
                    speed_segments: vec![
                        EditorSpeedSegment {
                            id: Uuid::new_v4(),
                            start: 0.0,
                            end: 4.0,
                            speed: 0.5,
                        },
                        EditorSpeedSegment {
                            id: Uuid::new_v4(),
                            start: 4.0,
                            end: 8.0,
                            speed: 2.0,
                        },
                    ],
                }],
            }],
            markers: Vec::new(),
            settings: Value::Null,
            revision: 1,
            created_at: now,
            updated_at: now,
        };
        let assets = HashMap::from([(
            asset_id.to_string(),
            EditorMediaSource {
                path: source,
                kind: EditorMediaKind::Video,
                has_audio: true,
            },
        )]);
        let options = EditorRenderOptions {
            encoder: EncoderSelection {
                primary: "h264_nvenc".to_owned(),
                fallback: Some("libx264".to_owned()),
            },
            quality: 85,
            range_start: Some(2.0),
            range_end: Some(8.0),
        };
        let plan = build_editor_plan_with_sources(
            Path::new("ffmpeg"),
            &project,
            &assets,
            &root.path().join("result.mp4"),
            &options,
        )
        .unwrap();
        let graph = plan
            .command
            .args
            .iter()
            .map(|item| item.to_string_lossy())
            .find(|item| item.contains("eq=brightness"))
            .or_else(|| {
                plan.command
                    .args
                    .iter()
                    .map(|item| item.to_string_lossy())
                    .find(|item| item.contains("color=c=black"))
            })
            .unwrap();
        assert!(graph.contains("eq=brightness=0.100000"));
        assert!(graph.contains("split=2"));
        assert!(graph.contains("concat=n=2:v=1:a=0"));
        assert!(graph.contains("atempo=0.500000"));
        assert!(graph.contains("geq="));
        assert!(graph.contains("volume='"));
        assert!(graph.contains("fade=t=in"));
        assert!((plan.duration_seconds - 6.0).abs() < f64::EPSILON);
        assert!(plan.fallback_command.is_some());

        let mut unsupported = project.clone();
        let clip = &mut unsupported.tracks[0].clips[0];
        clip.keyframes = vec![vibe_cs_domain::EditorKeyframe {
            id: Uuid::new_v4(),
            time: 0.0,
            property: EditorKeyframeProperty::ScaleX,
            value: 0.8,
        }];
        let error = build_editor_plan_with_sources(
            Path::new("ffmpeg"),
            &unsupported,
            &assets,
            &root.path().join("unsupported.mp4"),
            &options,
        )
        .expect_err("animated scale plus rotation must be rejected");
        assert!(error.to_string().contains("animated scale with rotation"));
    }

    #[derive(Debug)]
    struct FallbackRunner {
        commands: Mutex<Vec<CommandSpec>>,
    }

    #[derive(Debug)]
    struct PublicationRaceRunner {
        output: PathBuf,
    }

    #[async_trait]
    impl ProcessRunner for FallbackRunner {
        async fn run(
            &self,
            command: &CommandSpec,
            _cancellation: &ProcessCancellation,
        ) -> MediaResult<ProcessOutput> {
            self.commands.lock().unwrap().push(command.clone());
            let is_cpu = command.args.iter().any(|item| item == "libx264");
            if is_cpu {
                let output = command.args.last().expect("output path");
                std::fs::write(Path::new(output), b"rendered")
                    .map_err(|error| io_error(Path::new(output), error))?;
                Ok(ProcessOutput::default())
            } else {
                Err(MediaError::ProcessFailed {
                    status: 1,
                    message: "hardware session unavailable".to_owned(),
                })
            }
        }
    }

    #[async_trait]
    impl ProcessRunner for PublicationRaceRunner {
        async fn run(
            &self,
            command: &CommandSpec,
            _cancellation: &ProcessCancellation,
        ) -> MediaResult<ProcessOutput> {
            let temporary = PathBuf::from(command.args.last().expect("temporary output"));
            std::fs::write(&temporary, b"rendered").map_err(|error| io_error(&temporary, error))?;
            std::fs::write(&self.output, b"racing writer")
                .map_err(|error| io_error(&self.output, error))?;
            Ok(ProcessOutput::default())
        }
    }

    #[tokio::test]
    async fn output_created_after_render_is_never_overwritten_at_publication() {
        let root = tempfile::tempdir().unwrap();
        let temporary = root.path().join(".partial.mp4");
        let output = root.path().join("result.mp4");
        let plan = FilterPlan {
            command: CommandSpec::new("ffmpeg").arg(temporary.as_os_str()),
            fallback_command: None,
            temporary_output: temporary.clone(),
            final_output: output.clone(),
            duration_seconds: 1.0,
        };
        let error = execute_filter_plan(
            &PublicationRaceRunner {
                output: output.clone(),
            },
            &plan,
            &ProcessCancellation::default(),
        )
        .await
        .expect_err("racing destination must win without overwrite");
        assert!(matches!(error, MediaError::OutputExists(_)));
        assert_eq!(std::fs::read(output).unwrap(), b"racing writer");
        assert!(!temporary.exists());
    }

    #[tokio::test]
    async fn failed_gpu_command_retries_software_and_publishes_atomically() {
        let root = tempfile::tempdir().unwrap();
        let temporary = root.path().join(".partial.mp4");
        let output = root.path().join("result.mp4");
        let plan = FilterPlan {
            command: CommandSpec::new("ffmpeg").args([
                OsString::from("-c:v"),
                OsString::from("h264_qsv"),
                temporary.as_os_str().to_os_string(),
            ]),
            fallback_command: Some(CommandSpec::new("ffmpeg").args([
                OsString::from("-c:v"),
                OsString::from("libx264"),
                temporary.as_os_str().to_os_string(),
            ])),
            temporary_output: temporary,
            final_output: output.clone(),
            duration_seconds: 1.0,
        };
        let runner = FallbackRunner {
            commands: Mutex::new(Vec::new()),
        };
        execute_filter_plan(&runner, &plan, &ProcessCancellation::default())
            .await
            .unwrap();
        assert_eq!(std::fs::read(output).unwrap(), b"rendered");
        assert_eq!(runner.commands.lock().unwrap().len(), 2);
    }

    #[test]
    fn advanced_transitions_have_distinct_real_ffmpeg_filters() {
        let cases = [
            (Transition::Flash, "color=white"),
            (Transition::Dip, "color=black"),
            (Transition::Zoom, "scale=w="),
            (Transition::Wipe, "geq="),
            (Transition::Slide, "geq="),
            (Transition::Blur, "gblur="),
            (Transition::Glitch, "chromashift="),
            (Transition::Spin, "rotate="),
        ];
        for (transition, expected) in cases {
            let mut filter = String::new();
            append_editor_visual_transition(&mut filter, transition, true, 0.35, 2.0);
            assert!(
                filter.contains(expected),
                "{transition:?} should use {expected}: {filter}"
            );
        }
    }

    #[test]
    fn audio_extraction_plan_is_audio_only_and_no_clobber() {
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("capture.webm");
        std::fs::write(&source, b"source").unwrap();
        let output = root.path().join("voice.m4a");
        let plan = build_audio_extraction_plan(Path::new("ffmpeg"), &source, &output, 12.5)
            .expect("audio extraction plan");
        assert!(plan.command.args.iter().any(|arg| arg == "-vn"));
        assert!(plan.command.args.iter().any(|arg| arg == "0:a:0"));
        assert_eq!(plan.final_output, output);
        assert_ne!(plan.temporary_output, plan.final_output);
    }
}
