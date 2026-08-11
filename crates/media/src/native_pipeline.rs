use std::{ffi::OsStr, path::Path, sync::Arc, time::Duration};

use ez_ffmpeg::{FfmpegContext, Input, Output};

use crate::{
    CommandSpec, FfmpegProgress, FilterPlan, MediaError, MediaResult, ProcessCancellation,
    ProgressCallback, publish_temporary_output,
};

#[derive(Debug, Default)]
struct PendingInput {
    format: Option<String>,
    duration_us: Option<i64>,
    loop_image: Option<String>,
    framerate: Option<i32>,
    stream_loop: Option<i32>,
}

impl PendingInput {
    fn is_configured(&self) -> bool {
        self.format.is_some()
            || self.duration_us.is_some()
            || self.loop_image.is_some()
            || self.framerate.is_some()
            || self.stream_loop.is_some()
    }

    fn apply(self, source: String) -> Input {
        let mut input = Input::from(source);
        if let Some(format) = self.format {
            input = input.set_format(format);
        }
        if let Some(duration) = self.duration_us {
            input = input.set_recording_time_us(duration);
        }
        if let Some(value) = self.loop_image {
            input = input.set_format_opt("loop", value);
        }
        if let Some(framerate) = self.framerate {
            input = input.set_framerate(framerate, 1);
        }
        if let Some(count) = self.stream_loop {
            input = input.set_stream_loop(count);
        }
        input
    }
}

#[derive(Default)]
struct NativeJob {
    inputs: Vec<Input>,
    filter: Option<String>,
    maps: Vec<String>,
    video_codec: Option<String>,
    audio_codec: Option<String>,
    video_options: Vec<(String, String)>,
    video_bitrate: Option<String>,
    audio_bitrate: Option<String>,
    duration_us: Option<i64>,
    disable_video: bool,
    disable_audio: bool,
    movflags: Option<String>,
}

impl NativeJob {
    fn from_command(command: &CommandSpec, output: &Path) -> MediaResult<Self> {
        let mut job = Self::default();
        let mut pending = PendingInput::default();
        let mut index = 0_usize;
        while index < command.args.len() {
            let token = command.args[index].to_string_lossy();
            match token.as_ref() {
                "-hide_banner" | "-nostdin" | "-y" => index += 1,
                "-f" => {
                    pending.format = Some(value(command, index + 1, "input format")?);
                    index += 2;
                }
                "-loop" => {
                    pending.loop_image = Some(value(command, index + 1, "input loop")?);
                    index += 2;
                }
                "-framerate" => {
                    pending.framerate = Some(parse_value(command, index + 1, "input frame rate")?);
                    index += 2;
                }
                "-stream_loop" => {
                    pending.stream_loop =
                        Some(parse_value(command, index + 1, "input loop count")?);
                    index += 2;
                }
                "-i" => {
                    let source = value(command, index + 1, "input path")?;
                    job.inputs.push(std::mem::take(&mut pending).apply(source));
                    index += 2;
                }
                "-filter_complex" => {
                    job.filter = Some(value(command, index + 1, "filter graph")?);
                    index += 2;
                }
                "-map" => {
                    job.maps.push(value(command, index + 1, "stream map")?);
                    index += 2;
                }
                "-c:v" => {
                    job.video_codec = Some(value(command, index + 1, "video codec")?);
                    index += 2;
                }
                "-c:a" => {
                    job.audio_codec = Some(value(command, index + 1, "audio codec")?);
                    index += 2;
                }
                "-b:v" => {
                    job.video_bitrate = Some(value(command, index + 1, "video bitrate")?);
                    index += 2;
                }
                "-b:a" => {
                    job.audio_bitrate = Some(value(command, index + 1, "audio bitrate")?);
                    index += 2;
                }
                "-an" => {
                    job.disable_audio = true;
                    index += 1;
                }
                "-vn" => {
                    job.disable_video = true;
                    index += 1;
                }
                "-t" => {
                    let duration = parse_seconds(command, index + 1, "duration")?;
                    if pending.is_configured() {
                        pending.duration_us = Some(duration);
                    } else {
                        job.duration_us = Some(duration);
                    }
                    index += 2;
                }
                "-movflags" => {
                    job.movflags = Some(value(command, index + 1, "movflags")?);
                    index += 2;
                }
                "-crf" | "-global_quality" | "-qp_i" | "-qp_p" | "-quality" | "-rate_control"
                | "-cq:v" => {
                    let key = token
                        .trim_start_matches('-')
                        .trim_end_matches(":v")
                        .to_owned();
                    job.video_options
                        .push((key, value(command, index + 1, "video codec option")?));
                    index += 2;
                }
                "-progress" | "-stats_period" => index += 2,
                _ if index + 1 == command.args.len()
                    && Path::new(OsStr::new(token.as_ref())) == output =>
                {
                    index += 1;
                }
                _ => {
                    return Err(MediaError::InvalidInput(format!(
                        "native renderer does not support generated option: {token}"
                    )));
                }
            }
        }
        if !pending.is_configured() && job.inputs.is_empty() {
            return Err(MediaError::InvalidInput(
                "native render plan has no inputs".to_owned(),
            ));
        }
        Ok(job)
    }

    fn into_context(self, output_path: &Path) -> MediaResult<FfmpegContext> {
        let output_path = utf8_path(output_path)?;
        let mut output = Output::from(output_path);
        for map in self.maps {
            output = output.add_stream_map(map);
        }
        if let Some(codec) = self.video_codec {
            output = output.set_video_codec(codec);
        }
        if let Some(codec) = self.audio_codec {
            output = output.set_audio_codec(codec);
        }
        for (key, value) in self.video_options {
            output = output.set_video_codec_opt(key, value);
        }
        if let Some(bitrate) = self.video_bitrate {
            output = output.set_video_bitrate(bitrate);
        }
        if let Some(bitrate) = self.audio_bitrate {
            output = output.set_audio_bitrate(bitrate);
        }
        if let Some(duration) = self.duration_us {
            output = output.set_recording_time_us(duration);
        }
        if self.disable_video {
            output = output.disable_video();
        }
        if self.disable_audio {
            output = output.disable_audio();
        }
        if let Some(flags) = self.movflags {
            output = output.set_format_opt("movflags", flags.trim_start_matches('+'));
        }

        let mut builder = FfmpegContext::builder().inputs(self.inputs);
        if let Some(filter) = self.filter {
            builder = builder.filter_desc(filter);
        }
        builder
            .output(output)
            .build()
            .map_err(|error| MediaError::NativeFfmpeg(error.to_string()))
    }
}

/// Executes an editor/render plan in-process through libavformat, libavfilter,
/// and libavcodec. No `FFmpeg` executable or command shell is started.
///
/// # Errors
///
/// Returns an error for unsupported generated options, native pipeline
/// failures, cancellation, invalid output, or publication failure.
pub async fn execute_native_filter_plan_with_progress(
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
    let primary = plan.command.clone();
    let temporary = plan.temporary_output.clone();
    let cancellation_for_worker = cancellation.clone();
    let progress_for_worker = Arc::clone(&progress);
    let mut execution = tokio::task::spawn_blocking(move || {
        run_native_job(
            &primary,
            &temporary,
            &cancellation_for_worker,
            &progress_for_worker,
        )
    })
    .await
    .map_err(|error| MediaError::NativeFfmpeg(format!("native render task failed: {error}")))?;

    if execution.is_err()
        && !cancellation.is_cancelled()
        && let Some(fallback) = plan.fallback_command.clone()
    {
        let _ = std::fs::remove_file(&plan.temporary_output);
        progress(FfmpegProgress::default());
        let temporary = plan.temporary_output.clone();
        let cancellation_for_worker = cancellation.clone();
        let progress_for_worker = Arc::clone(&progress);
        execution = tokio::task::spawn_blocking(move || {
            run_native_job(
                &fallback,
                &temporary,
                &cancellation_for_worker,
                &progress_for_worker,
            )
        })
        .await
        .map_err(|error| MediaError::NativeFfmpeg(format!("native render task failed: {error}")))?;
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

/// Executes an in-process editor/render plan without observing progress.
///
/// # Errors
///
/// Returns the same failures as [`execute_native_filter_plan_with_progress`].
pub async fn execute_native_filter_plan(
    plan: &FilterPlan,
    cancellation: &ProcessCancellation,
) -> MediaResult<()> {
    execute_native_filter_plan_with_progress(plan, cancellation, Arc::new(|_| {})).await
}

fn run_native_job(
    command: &CommandSpec,
    output: &Path,
    cancellation: &ProcessCancellation,
    callback: &ProgressCallback,
) -> MediaResult<()> {
    if cancellation.is_cancelled() {
        return Err(MediaError::Cancelled);
    }
    let context = NativeJob::from_command(command, output)?.into_context(output)?;
    let scheduler = context
        .start()
        .map_err(|error| MediaError::NativeFfmpeg(error.to_string()))?;
    let progress = scheduler.progress_handle();
    while !progress.is_ended() {
        if cancellation.is_cancelled() {
            scheduler.abort();
            return Err(MediaError::Cancelled);
        }
        let snapshot = progress.snapshot();
        let out_time_seconds = snapshot
            .outputs()
            .first()
            .and_then(ez_ffmpeg::core::scheduler::progress::OutputProgress::out_time_us)
            .map_or(0.0, progress_seconds);
        callback(FfmpegProgress {
            out_time_seconds,
            completed: false,
        });
        std::thread::sleep(Duration::from_millis(100));
    }
    scheduler
        .wait()
        .map_err(|error| MediaError::NativeFfmpeg(error.to_string()))?;
    callback(FfmpegProgress {
        out_time_seconds: progress
            .snapshot()
            .outputs()
            .first()
            .and_then(ez_ffmpeg::core::scheduler::progress::OutputProgress::out_time_us)
            .map_or(0.0, progress_seconds),
        completed: true,
    });
    Ok(())
}

fn value(command: &CommandSpec, index: usize, name: &str) -> MediaResult<String> {
    command
        .args
        .get(index)
        .map(|value| value.to_string_lossy().into_owned())
        .ok_or_else(|| MediaError::InvalidInput(format!("native render plan is missing {name}")))
}

fn parse_value<T>(command: &CommandSpec, index: usize, name: &str) -> MediaResult<T>
where
    T: std::str::FromStr,
{
    value(command, index, name)?
        .parse()
        .map_err(|_| MediaError::InvalidInput(format!("native render plan has invalid {name}")))
}

fn parse_seconds(command: &CommandSpec, index: usize, name: &str) -> MediaResult<i64> {
    let seconds: f64 = parse_value(command, index, name)?;
    if !seconds.is_finite() || !(0.0..=86_400.0).contains(&seconds) {
        return Err(MediaError::InvalidInput(format!(
            "native render plan has invalid {name}"
        )));
    }
    i64::try_from(Duration::from_secs_f64(seconds).as_micros())
        .map_err(|_| MediaError::InvalidInput(format!("native render plan has invalid {name}")))
}

fn progress_seconds(microseconds: i64) -> f64 {
    u64::try_from(microseconds)
        .map(Duration::from_micros)
        .map_or(0.0, |duration| duration.as_secs_f64())
}

fn utf8_path(path: &Path) -> MediaResult<String> {
    path.to_str().map(ToOwned::to_owned).ok_or_else(|| {
        MediaError::InvalidInput(format!("media path is not UTF-8: {}", path.display()))
    })
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicBool, Ordering};

    use super::*;
    use crate::{build_audio_extraction_plan, native_probe_media};

    #[test]
    fn converts_generated_audio_extraction_to_a_native_job() {
        let command = CommandSpec::new("unused-ffmpeg-program").args([
            "-hide_banner",
            "-nostdin",
            "-y",
            "-i",
            "source.wav",
            "-map",
            "0:a:0",
            "-vn",
            "-c:a",
            "aac",
            "-b:a",
            "192k",
            "-progress",
            "pipe:1",
            "-stats_period",
            "0.25",
            "output.m4a",
        ]);
        let job = NativeJob::from_command(&command, Path::new("output.m4a")).unwrap();
        assert_eq!(job.inputs.len(), 1);
        assert_eq!(job.maps, ["0:a:0"]);
        assert_eq!(job.audio_codec.as_deref(), Some("aac"));
        assert!(job.disable_video);
    }

    #[test]
    fn rejects_options_outside_the_generated_native_contract() {
        let command =
            CommandSpec::new("unused").args(["-i", "source.mp4", "-shell", "bad", "out.mp4"]);
        assert!(NativeJob::from_command(&command, Path::new("out.mp4")).is_err());
    }

    #[tokio::test]
    async fn extracts_audio_in_process_and_publishes_a_valid_m4a() {
        let directory = tempfile::tempdir().unwrap();
        let source = directory.path().join("source.wav");
        let output = directory.path().join("audio.m4a");
        write_test_wav(&source);

        let cancellation = ProcessCancellation::default();
        let plan =
            build_audio_extraction_plan(Path::new("native-libav"), &source, &output, 0.5).unwrap();
        execute_native_filter_plan(&plan, &cancellation)
            .await
            .unwrap();

        let probe = native_probe_media(&output, &cancellation).unwrap();
        assert!(probe.streams.iter().any(|stream| stream.kind == "audio"));
        assert!(std::fs::metadata(output).unwrap().len() > 128);
    }

    #[tokio::test]
    async fn failed_primary_codec_retries_the_native_software_plan() {
        let directory = tempfile::tempdir().unwrap();
        let source = directory.path().join("source.wav");
        let output = directory.path().join("audio.m4a");
        write_test_wav(&source);
        let mut plan =
            build_audio_extraction_plan(Path::new("native-libav"), &source, &output, 0.5).unwrap();
        let fallback = plan.command.clone();
        let codec = plan
            .command
            .args
            .iter()
            .position(|value| value == "aac")
            .unwrap();
        plan.command.args[codec] = "definitely_missing_encoder".into();
        plan.fallback_command = Some(fallback);

        execute_native_filter_plan(&plan, &ProcessCancellation::default())
            .await
            .unwrap();
        assert!(output.is_file());
    }

    #[tokio::test]
    async fn destination_created_during_render_is_never_overwritten() {
        let directory = tempfile::tempdir().unwrap();
        let source = directory.path().join("source.wav");
        let output = directory.path().join("audio.m4a");
        write_test_wav(&source);
        let plan =
            build_audio_extraction_plan(Path::new("native-libav"), &source, &output, 0.5).unwrap();
        let created = Arc::new(AtomicBool::new(false));
        let output_for_callback = output.clone();
        let created_for_callback = Arc::clone(&created);
        let error = execute_native_filter_plan_with_progress(
            &plan,
            &ProcessCancellation::default(),
            Arc::new(move |_| {
                if !created_for_callback.swap(true, Ordering::SeqCst) {
                    std::fs::write(&output_for_callback, b"racing writer").unwrap();
                }
            }),
        )
        .await
        .expect_err("racing destination must win without overwrite");
        assert!(matches!(error, MediaError::OutputExists(_)));
        assert_eq!(std::fs::read(output).unwrap(), b"racing writer");
        assert!(!plan.temporary_output.exists());
    }

    fn write_test_wav(source: &Path) {
        let sample_count = 4_000_u32;
        let data_size = sample_count * 2;
        let mut wav = b"RIFF".to_vec();
        wav.extend_from_slice(&(36 + data_size).to_le_bytes());
        wav.extend_from_slice(b"WAVEfmt ");
        wav.extend_from_slice(&16_u32.to_le_bytes());
        wav.extend_from_slice(&1_u16.to_le_bytes());
        wav.extend_from_slice(&1_u16.to_le_bytes());
        wav.extend_from_slice(&8_000_u32.to_le_bytes());
        wav.extend_from_slice(&16_000_u32.to_le_bytes());
        wav.extend_from_slice(&2_u16.to_le_bytes());
        wav.extend_from_slice(&16_u16.to_le_bytes());
        wav.extend_from_slice(b"data");
        wav.extend_from_slice(&data_size.to_le_bytes());
        for sample in 0..sample_count {
            let value = if sample % 32 < 16 {
                12_000_i16
            } else {
                -12_000_i16
            };
            wav.extend_from_slice(&value.to_le_bytes());
        }
        std::fs::write(source, wav).unwrap();
    }
}
