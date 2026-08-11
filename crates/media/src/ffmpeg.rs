use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::{CommandSpec, MediaError, MediaResult, ProcessCancellation, ProcessRunner};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ToolInfo {
    pub path: PathBuf,
    pub version: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct FfmpegInfo {
    pub tool: ToolInfo,
    pub encoders: Vec<String>,
}

/// Resolves a configured executable or searches the current process `PATH`.
///
/// # Errors
///
/// Returns an error for invalid names or when no executable file is found.
pub fn find_executable(name: &str, configured: Option<&Path>) -> MediaResult<PathBuf> {
    if name.is_empty() || name.contains(['/', '\\', '\0']) {
        return Err(MediaError::InvalidInput(
            "invalid executable name".to_owned(),
        ));
    }
    if let Some(path) = configured.filter(|path| !path.as_os_str().is_empty()) {
        return path
            .is_file()
            .then(|| path.to_path_buf())
            .ok_or_else(|| MediaError::ExecutableNotFound(path.display().to_string()));
    }
    let candidates = executable_names(name);
    std::env::var_os("PATH")
        .into_iter()
        .flat_map(|path| std::env::split_paths(&path).collect::<Vec<_>>())
        .flat_map(|directory| {
            candidates
                .iter()
                .map(move |candidate| directory.join(candidate))
        })
        .find(|candidate| candidate.is_file())
        .ok_or_else(|| MediaError::ExecutableNotFound(name.to_owned()))
}

fn executable_names(name: &str) -> Vec<String> {
    if cfg!(windows) {
        vec![format!("{name}.exe"), name.to_owned()]
    } else {
        vec![name.to_owned()]
    }
}

/// Reads the `FFmpeg` version and encoder registry through a process runner.
///
/// # Errors
///
/// Returns an error if execution fails, is cancelled, or output is malformed.
pub async fn inspect_ffmpeg(
    runner: &dyn ProcessRunner,
    path: PathBuf,
    cancellation: &ProcessCancellation,
) -> MediaResult<FfmpegInfo> {
    let version_output = runner
        .run(&CommandSpec::new(&path).arg("-version"), cancellation)
        .await?
        .ensure_success()?;
    let version = parse_tool_version(&version_output.stdout)?;
    let encoders_output = runner
        .run(
            &CommandSpec::new(&path).args(["-hide_banner", "-encoders"]),
            cancellation,
        )
        .await?
        .ensure_success()?;
    let mut encoders = parse_ffmpeg_encoders(&String::from_utf8_lossy(&encoders_output.stdout));
    encoders.sort();
    encoders.dedup();
    Ok(FfmpegInfo {
        tool: ToolInfo { path, version },
        encoders,
    })
}

/// Reads the `ffprobe` version through a process runner.
///
/// # Errors
///
/// Returns an error if execution fails, is cancelled, or output is malformed.
pub async fn inspect_ffprobe(
    runner: &dyn ProcessRunner,
    path: PathBuf,
    cancellation: &ProcessCancellation,
) -> MediaResult<ToolInfo> {
    let output = runner
        .run(&CommandSpec::new(&path).arg("-version"), cancellation)
        .await?
        .ensure_success()?;
    Ok(ToolInfo {
        path,
        version: parse_tool_version(&output.stdout)?,
    })
}

fn parse_tool_version(output: &[u8]) -> MediaResult<String> {
    let first = String::from_utf8_lossy(output)
        .lines()
        .next()
        .unwrap_or_default()
        .trim()
        .to_owned();
    if first.is_empty() {
        Err(MediaError::InvalidToolOutput(
            "missing version line".to_owned(),
        ))
    } else {
        Ok(first)
    }
}

#[must_use]
pub fn parse_ffmpeg_encoders(output: &str) -> Vec<String> {
    output
        .lines()
        .filter_map(|line| {
            let mut columns = line.split_whitespace();
            let flags = columns.next()?;
            let name = columns.next()?;
            (flags.len() == 6
                && flags
                    .chars()
                    .all(|character| character == '.' || character.is_ascii_uppercase())
                && name
                    .chars()
                    .all(|character| character.is_ascii_alphanumeric() || character == '_'))
            .then(|| name.to_owned())
        })
        .collect()
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct MediaProbe {
    pub path: PathBuf,
    pub duration_seconds: Option<f64>,
    pub size_bytes: Option<u64>,
    pub streams: Vec<MediaStream>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct MediaStream {
    pub index: u32,
    pub kind: String,
    pub codec: String,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub sample_rate: Option<u32>,
    pub channels: Option<u32>,
}

#[derive(Debug, Deserialize)]
struct RawProbe {
    #[serde(default)]
    streams: Vec<RawStream>,
    #[serde(default)]
    format: RawFormat,
}

#[derive(Debug, Deserialize)]
struct RawStream {
    index: u32,
    #[serde(default)]
    codec_type: String,
    #[serde(default)]
    codec_name: String,
    width: Option<u32>,
    height: Option<u32>,
    sample_rate: Option<String>,
    channels: Option<u32>,
}

#[derive(Debug, Default, Deserialize)]
struct RawFormat {
    duration: Option<String>,
    size: Option<String>,
}

/// Probes one local media file into a transport-safe model.
///
/// # Errors
///
/// Returns an error for a missing input, process failure, cancellation, or
/// malformed probe JSON.
pub async fn probe_media(
    runner: &dyn ProcessRunner,
    ffprobe: &Path,
    media: &Path,
    cancellation: &ProcessCancellation,
) -> MediaResult<MediaProbe> {
    if !media.is_file() {
        return Err(MediaError::InvalidInput(format!(
            "media file does not exist: {}",
            media.display()
        )));
    }
    let command = CommandSpec::new(ffprobe).args([
        "-v".into(),
        "error".into(),
        "-show_entries".into(),
        "format=duration,size:stream=index,codec_type,codec_name,width,height,sample_rate,channels"
            .into(),
        "-of".into(),
        "json".into(),
        media.as_os_str().to_os_string(),
    ]);
    let output = runner.run(&command, cancellation).await?.ensure_success()?;
    parse_probe_json(media, &output.stdout)
}

/// Decodes `ffprobe` JSON without performing I/O.
///
/// # Errors
///
/// Returns an error when the JSON payload does not match the expected schema.
pub fn parse_probe_json(path: &Path, bytes: &[u8]) -> MediaResult<MediaProbe> {
    let raw: RawProbe = serde_json::from_slice(bytes)?;
    let duration_seconds = raw
        .format
        .duration
        .as_deref()
        .and_then(|value| value.parse().ok());
    let size_bytes = raw
        .format
        .size
        .as_deref()
        .and_then(|value| value.parse().ok());
    Ok(MediaProbe {
        path: path.to_path_buf(),
        duration_seconds,
        size_bytes,
        streams: raw
            .streams
            .into_iter()
            .map(|stream| MediaStream {
                index: stream.index,
                kind: stream.codec_type,
                codec: stream.codec_name,
                width: stream.width,
                height: stream.height,
                sample_rate: stream.sample_rate.and_then(|value| value.parse().ok()),
                channels: stream.channels,
            })
            .collect(),
    })
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use crate::{ProcessOutput, testing::FakeRunner};

    use super::*;

    #[test]
    fn parses_encoder_table_without_banner_noise() {
        let output = "Encoders:\n V..... libx264 H.264\n V....D h264_nvenc NVIDIA\n ------\n";
        assert_eq!(parse_ffmpeg_encoders(output), ["libx264", "h264_nvenc"]);
    }

    #[test]
    fn parses_probe_payload() {
        let probe = parse_probe_json(
            Path::new("clip.mp4"),
            br#"{"streams":[{"index":0,"codec_type":"video","codec_name":"h264","width":1920,"height":1080}],"format":{"duration":"12.5","size":"42"}}"#,
        )
        .unwrap();
        assert_eq!(probe.duration_seconds, Some(12.5));
        assert_eq!(probe.streams[0].codec, "h264");
    }

    #[tokio::test]
    async fn inspection_uses_argument_vectors() {
        let runner = FakeRunner {
            output: Mutex::new(ProcessOutput {
                status: 0,
                stdout: b"ffmpeg version 7.1\n V..... libx264 encoder\n".to_vec(),
                stderr: Vec::new(),
            }),
            ..FakeRunner::default()
        };
        let info = inspect_ffmpeg(
            &runner,
            PathBuf::from("ffmpeg"),
            &ProcessCancellation::default(),
        )
        .await
        .unwrap();
        assert_eq!(info.tool.version, "ffmpeg version 7.1");
        assert_eq!(runner.commands.lock().unwrap().len(), 2);
    }
}
