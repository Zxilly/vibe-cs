use std::{
    path::{Path, PathBuf},
    sync::OnceLock,
};

use ffmpeg_next as ffmpeg;
use serde::{Deserialize, Serialize};

use crate::{MediaError, MediaResult, ProcessCancellation};

const ENCODER_CANDIDATES: &[&str] = &[
    "h264_nvenc",
    "h264_qsv",
    "h264_amf",
    "h264_mf",
    "libopenh264",
    "hevc_nvenc",
    "hevc_qsv",
    "hevc_amf",
    "hevc_mf",
    "av1_nvenc",
    "av1_qsv",
    "av1_amf",
    "libsvtav1",
    "libaom-av1",
];

static INITIALIZED: OnceLock<Result<(), String>> = OnceLock::new();

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct MediaProbe {
    pub path: PathBuf,
    pub duration_seconds: Option<f64>,
    pub size_bytes: Option<u64>,
    pub timecode: Option<String>,
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
    /// Frames per second, as a rational reduced to a string (`"60"`,
    /// `"30000/1001"`). Kept exact rather than converted to a float: 29.97 is
    /// 30000/1001 and printing it as `29.97 fps` loses the distinction between
    /// NTSC rates and the round numbers a capture actually uses.
    pub frame_rate: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct NativeFfmpegInfo {
    pub backend: String,
    pub avcodec_version: String,
    pub license: String,
    pub configuration: String,
    pub encoders: Vec<String>,
}

fn initialize() -> MediaResult<()> {
    INITIALIZED
        .get_or_init(|| ffmpeg::init().map_err(|error| error.to_string()))
        .clone()
        .map_err(MediaError::NativeFfmpeg)
}

/// Reports the linked libavcodec build and the encoders compiled into it.
///
/// The registry result describes compiled capabilities. Hardware encoders are
/// opened again when a render starts because driver and device availability can
/// change independently of the linked `FFmpeg` build.
///
/// # Errors
///
/// Returns an error if `FFmpeg` global initialization fails.
pub fn native_ffmpeg_info() -> MediaResult<NativeFfmpegInfo> {
    initialize()?;
    let version = ffmpeg::codec::version();
    let encoders = ENCODER_CANDIDATES
        .iter()
        .filter(|name| ffmpeg::encoder::find_by_name(name).is_some())
        .map(|name| (*name).to_owned())
        .collect();
    Ok(NativeFfmpegInfo {
        backend: "ffmpeg-next".to_owned(),
        avcodec_version: format!(
            "{}.{}.{}",
            version >> 16,
            (version >> 8) & 0xff,
            version & 0xff
        ),
        license: ffmpeg::codec::license().to_owned(),
        configuration: ffmpeg::codec::configuration().to_owned(),
        encoders,
    })
}

/// Probes a local media file through libavformat/libavcodec without launching a
/// helper process.
///
/// # Errors
///
/// Returns an error for missing input, cancellation, `FFmpeg` initialization, or
/// an unreadable/unsupported container.
#[allow(clippy::cast_precision_loss)]
pub fn native_probe_media(
    media: &Path,
    cancellation: &ProcessCancellation,
) -> MediaResult<MediaProbe> {
    initialize()?;
    if cancellation.is_cancelled() {
        return Err(MediaError::Cancelled);
    }
    if !media.is_file() {
        return Err(MediaError::InvalidInput(format!(
            "media file does not exist: {}",
            media.display()
        )));
    }
    let interrupt = cancellation.clone();
    let context = ffmpeg::format::input_with_interrupt(media, move || interrupt.is_cancelled())
        .map_err(|error| MediaError::NativeFfmpeg(error.to_string()))?;
    if cancellation.is_cancelled() {
        return Err(MediaError::Cancelled);
    }

    let duration_seconds = (context.duration() > 0)
        .then(|| context.duration() as f64 / f64::from(ffmpeg::ffi::AV_TIME_BASE));
    let size_bytes = std::fs::metadata(media).ok().map(|metadata| metadata.len());
    let timecode = context
        .metadata()
        .get("timecode")
        .map(str::to_owned)
        .or_else(|| {
            context
                .streams()
                .find_map(|stream| stream.metadata().get("timecode").map(str::to_owned))
        });
    let streams = context
        .streams()
        .map(|stream| native_stream(&stream))
        .collect();
    Ok(MediaProbe {
        path: media.to_path_buf(),
        duration_seconds,
        size_bytes,
        timecode,
        streams,
    })
}

fn native_stream(stream: &ffmpeg::Stream<'_>) -> MediaStream {
    let parameters = stream.parameters();
    let medium = parameters.medium();
    let codec = parameters.id().name().to_owned();
    let mut result = MediaStream {
        index: u32::try_from(stream.index()).unwrap_or(u32::MAX),
        kind: medium_name(medium).to_owned(),
        codec,
        width: None,
        height: None,
        sample_rate: None,
        channels: None,
        frame_rate: None,
    };
    if medium == ffmpeg::media::Type::Video {
        // `avg_frame_rate` over `r_frame_rate`: the average is what the file
        // actually contains, while `r` is the smallest rate every timestamp is
        // a multiple of — for a VFR capture that can be 1000/1.
        let rate = stream.avg_frame_rate();
        if rate.denominator() > 0 && rate.numerator() > 0 {
            result.frame_rate = Some(if rate.denominator() == 1 {
                rate.numerator().to_string()
            } else {
                format!("{}/{}", rate.numerator(), rate.denominator())
            });
        }
    }
    let Ok(context) = ffmpeg::codec::context::Context::from_parameters(parameters) else {
        return result;
    };
    match medium {
        ffmpeg::media::Type::Video => {
            if let Ok(decoder) = context.decoder().video() {
                result.width = Some(decoder.width());
                result.height = Some(decoder.height());
            }
        }
        ffmpeg::media::Type::Audio => {
            if let Ok(decoder) = context.decoder().audio() {
                result.sample_rate = Some(decoder.rate());
                result.channels = Some(u32::from(decoder.channels()));
            }
        }
        _ => {}
    }
    result
}

fn medium_name(medium: ffmpeg::media::Type) -> &'static str {
    match medium {
        ffmpeg::media::Type::Video => "video",
        ffmpeg::media::Type::Audio => "audio",
        ffmpeg::media::Type::Subtitle => "subtitle",
        ffmpeg::media::Type::Data => "data",
        ffmpeg::media::Type::Attachment => "attachment",
        ffmpeg::media::Type::Unknown => "unknown",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reports_the_linked_native_backend() {
        let info = native_ffmpeg_info().unwrap();
        assert_eq!(info.backend, "ffmpeg-next");
        assert!(!info.avcodec_version.is_empty());
        assert!(info.encoders.iter().any(|name| name == "h264_mf"));
    }

    #[test]
    fn cancelled_probe_does_not_open_the_input() {
        let cancellation = ProcessCancellation::default();
        cancellation.cancel();
        assert!(matches!(
            native_probe_media(Path::new("missing.mp4"), &cancellation),
            Err(MediaError::Cancelled)
        ));
    }

    #[test]
    fn probes_a_wav_through_libavformat() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("sample.wav");
        std::fs::write(&path, wav_fixture()).unwrap();
        let probe = native_probe_media(&path, &ProcessCancellation::default()).unwrap();
        assert!(probe.streams.iter().any(|stream| {
            stream.kind == "audio"
                && stream.sample_rate == Some(8_000)
                && stream.channels == Some(1)
        }));
    }

    fn wav_fixture() -> Vec<u8> {
        let mut wav = b"RIFF".to_vec();
        wav.extend_from_slice(&40_u32.to_le_bytes());
        wav.extend_from_slice(b"WAVEfmt ");
        wav.extend_from_slice(&16_u32.to_le_bytes());
        wav.extend_from_slice(&1_u16.to_le_bytes());
        wav.extend_from_slice(&1_u16.to_le_bytes());
        wav.extend_from_slice(&8_000_u32.to_le_bytes());
        wav.extend_from_slice(&16_000_u32.to_le_bytes());
        wav.extend_from_slice(&2_u16.to_le_bytes());
        wav.extend_from_slice(&16_u16.to_le_bytes());
        wav.extend_from_slice(b"data");
        wav.extend_from_slice(&4_u32.to_le_bytes());
        wav.extend_from_slice(&i16::MAX.to_le_bytes());
        wav.extend_from_slice(&0_i16.to_le_bytes());
        wav
    }
}
