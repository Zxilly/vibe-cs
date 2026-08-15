use std::{
    fs,
    io::{Read, Seek, SeekFrom},
    path::{Path, PathBuf},
};

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::{PlatformError, PlatformResult};

/// Media Foundation timestamps are expressed in 100-nanosecond units.
pub const MEDIA_FOUNDATION_TICKS_PER_SECOND: u64 = 10_000_000;

const MAX_SEQUENCE_FRAME_COUNT: u64 = 36_000_000;
const MAX_SEQUENCE_DURATION_SECONDS: u64 = 12 * 60 * 60;
const MAX_FRAME_RATE_DENOMINATOR: u32 = 1_000_000;
const MAX_FRAME_RATE: u32 = 1_000;
const MIN_AUDIO_SAMPLE_RATE_HZ: u32 = 8_000;
const MAX_AUDIO_SAMPLE_RATE_HZ: u32 = 768_000;
const AAC_LC_SAMPLE_FRAMES_PER_ACCESS_UNIT: u64 = 1_024;
const MIN_NATIVE_MP4_DIMENSION: u32 = 48;
const MAX_NATIVE_MP4_WIDTH: u32 = 4_096;
const MAX_NATIVE_MP4_HEIGHT: u32 = 2_304;
const MIN_NATIVE_MP4_BITRATE_BPS: u32 = 100_000;
const MAX_NATIVE_MP4_BITRATE_BPS: u32 = 100_000_000;
const MAX_PCM_WAV_CHUNK_COUNT: u32 = 256;
const MAX_PCM_WAV_FILE_BYTES: u64 = u32::MAX as u64 + 8;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RationalFrameRate {
    pub numerator: u32,
    pub denominator: u32,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HlaeSequenceAudioTiming {
    pub sample_rate_hz: u32,
    /// PCM sample frames, independent of channel count.
    pub sample_frame_count: u64,
}

/// Timing evidence extracted from one completed HLAE sequence and optional WAV.
///
/// This is a planning contract only. It does not imply that native MP4 encoding
/// has been attempted or verified.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HlaeSequenceTimingRequest {
    pub frame_count: u64,
    pub frame_rate: RationalFrameRate,
    pub audio: Option<HlaeSequenceAudioTiming>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum HlaeAudioLengthAdjustment {
    Exact,
    /// Append this many silent PCM sample frames.
    PadEnd {
        sample_frame_count: u64,
    },
    /// Discard this many PCM sample frames from the tail.
    TrimEnd {
        sample_frame_count: u64,
    },
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HlaeSequenceAudioPlan {
    pub sample_rate_hz: u32,
    pub input_sample_frame_count: u64,
    pub output_sample_frame_count: u64,
    pub adjustment: HlaeAudioLengthAdjustment,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MediaFoundationSampleTiming {
    pub sample_index: u64,
    pub presentation_time_100ns: u64,
    pub duration_100ns: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HlaeSequenceTimingPlan {
    pub time_base_ticks_per_second: u64,
    pub frame_count: u64,
    pub frame_rate: RationalFrameRate,
    pub video_duration_100ns: u64,
    pub audio: Option<HlaeSequenceAudioPlan>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum HlaeSequenceEncoderProbeStatus {
    Unsupported,
    MediaFoundationUnavailable,
    NoH264EncoderRegistered,
    EncoderCandidatesRegistered,
}

/// A conservative runtime inventory of Media Foundation encoder candidates.
///
/// Candidate registration is not an end-to-end encode guarantee. This probe
/// performs no file I/O, so its final field remains false; callers that need
/// proof must use the real writer and Source Reader inspection APIs below.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HlaeSequenceEncoderCapabilityReport {
    pub status: HlaeSequenceEncoderProbeStatus,
    pub media_foundation_started: bool,
    pub registered_h264_encoder_count: u32,
    pub registered_hardware_h264_encoder_count: u32,
    pub registered_aac_encoder_count: u32,
    pub end_to_end_mp4_encode_verified: bool,
    pub detail: String,
}

/// Configuration for the native Media Foundation MP4 writer.
///
/// Input frames are tightly packed, top-down BGRA bytes. The alpha byte is
/// ignored by the `MFVideoFormat_RGB32` input transform. [`NativeMp4VideoWriter::create`]
/// authors video-only output; [`NativeMp4VideoWriter::create_with_pcm_wav`]
/// adds a strict PCM-to-AAC stream.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeMp4VideoConfig {
    pub width: u32,
    pub height: u32,
    pub frame_count: u64,
    pub frame_rate: RationalFrameRate,
    pub target_bitrate_bps: u32,
}

/// Evidence returned only after a complete MP4 has been finalized, flushed,
/// and atomically published at the requested destination.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeMp4VideoSummary {
    pub output_path: PathBuf,
    pub output_bytes: u64,
    pub frame_count: u64,
    pub video_duration_100ns: u64,
    /// True only after an AAC stream was authored and passed Source Reader
    /// read-back verification together with the H.264 stream.
    pub audio_stream_included: bool,
}

/// Read-back evidence produced by Media Foundation's Source Reader.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[allow(clippy::struct_excessive_bools)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeMp4VideoInspection {
    pub video_subtype_is_h264: bool,
    pub audio_stream_is_aac: bool,
    pub width: u32,
    pub height: u32,
    pub frame_rate: RationalFrameRate,
    pub sample_count: u64,
    pub audio_sample_count: u64,
    pub first_presentation_time_100ns: i64,
    pub last_presentation_time_100ns: i64,
    pub video_duration_100ns: i64,
    pub audio_duration_100ns: i64,
    pub timestamps_are_monotonic: bool,
    pub audio_timestamps_are_monotonic: bool,
}

/// Strict metadata accepted from an HLAE `startMovieWav` file.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativePcmWavInfo {
    pub sample_rate_hz: u32,
    pub channel_count: u16,
    pub bits_per_sample: u16,
    pub sample_frame_count: u64,
    pub data_bytes: u64,
}

#[derive(Debug)]
#[cfg_attr(not(windows), allow(dead_code))]
struct NativePcmWavSource {
    file: fs::File,
    path: PathBuf,
    info: NativePcmWavInfo,
    data_offset: u64,
}

/// Incremental, bounded BGRA-to-H.264 MP4 writer backed by Media Foundation.
///
/// Frames are streamed one at a time. The final path never becomes visible
/// until the exact configured frame count has been finalized and flushed. If
/// the writer is cancelled, errors, or is dropped, its unpublished temporary
/// file is removed. Callers may select that exact path for crash recovery.
pub struct NativeMp4VideoWriter {
    output_path: PathBuf,
    temporary_path: PathBuf,
    config: NativeMp4VideoConfig,
    #[cfg(windows)]
    timing_plan: HlaeSequenceTimingPlan,
    #[cfg(windows)]
    expected_frame_bytes: usize,
    frames_written: u64,
    published: bool,
    #[cfg(windows)]
    state: Option<native_mp4_windows::WriterState>,
    audio: Option<NativeMp4AudioSource>,
}

#[derive(Debug)]
#[cfg_attr(not(windows), allow(dead_code))]
struct NativeMp4AudioSource {
    wav: NativePcmWavSource,
    timing: HlaeSequenceAudioPlan,
}

impl std::fmt::Debug for NativeMp4VideoWriter {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("NativeMp4VideoWriter")
            .field("output_path", &self.output_path)
            .field("temporary_path", &self.temporary_path)
            .field("config", &self.config)
            .field("frames_written", &self.frames_written)
            .field("has_audio", &self.audio.is_some())
            .field("published", &self.published)
            .finish_non_exhaustive()
    }
}

impl NativeMp4VideoWriter {
    /// Creates a video-only MP4 writer for a new absolute destination.
    ///
    /// # Errors
    ///
    /// Returns [`PlatformError::InvalidInput`] for unsafe output paths or
    /// unsupported bounded media settings, [`PlatformError::RecoveryPending`]
    /// when the destination already exists, [`PlatformError::Unsupported`] on
    /// non-Windows systems, or [`PlatformError::Windows`] when Media Foundation
    /// cannot create an H.264 pipeline.
    pub fn create(output_path: &Path, config: NativeMp4VideoConfig) -> PlatformResult<Self> {
        let temporary_path = native_mp4_temporary_path(output_path)?;
        Self::create_internal(output_path, &temporary_path, config, None)
    }

    /// Creates a video-only writer at one caller-selected unpublished path.
    ///
    /// The explicit path lets the caller persist the exact partial artifact in
    /// a crash-recovery lease before Media Foundation creates it. Both paths
    /// must be direct children of the same existing canonical, non-reparse
    /// directory, and the partial path must end in `.partial.mp4`.
    ///
    /// # Errors
    ///
    /// Returns the same errors as [`Self::create`], and rejects an unsafe,
    /// existing, or differently rooted temporary path before opening a sink.
    pub fn create_at_temporary_path(
        output_path: &Path,
        temporary_path: &Path,
        config: NativeMp4VideoConfig,
    ) -> PlatformResult<Self> {
        Self::create_internal(output_path, temporary_path, config, None)
    }

    /// Creates an H.264/AAC MP4 writer using one strict HLAE PCM WAV input.
    /// The WAV is kept open from validation through finalization, preventing a
    /// path replacement from changing the encoded content mid-operation.
    ///
    /// # Errors
    ///
    /// Returns the same errors as [`Self::create`], plus
    /// [`PlatformError::InvalidInput`] for malformed or unsupported WAV input.
    pub fn create_with_pcm_wav(
        output_path: &Path,
        config: NativeMp4VideoConfig,
        wav_path: &Path,
    ) -> PlatformResult<Self> {
        let temporary_path = native_mp4_temporary_path(output_path)?;
        Self::create_with_pcm_wav_at_temporary_path(output_path, &temporary_path, config, wav_path)
    }

    /// Creates an H.264/AAC writer at one caller-selected unpublished path.
    ///
    /// # Errors
    ///
    /// Returns the same errors as [`Self::create_at_temporary_path`], plus
    /// [`PlatformError::InvalidInput`] for malformed or unsupported WAV input.
    pub fn create_with_pcm_wav_at_temporary_path(
        output_path: &Path,
        temporary_path: &Path,
        config: NativeMp4VideoConfig,
        wav_path: &Path,
    ) -> PlatformResult<Self> {
        let wav = open_native_pcm_wav(wav_path)?;
        let audio = Some(NativeMp4AudioSource {
            timing: plan_audio(
                config.frame_count,
                config.frame_rate,
                HlaeSequenceAudioTiming {
                    sample_rate_hz: wav.info.sample_rate_hz,
                    sample_frame_count: wav.info.sample_frame_count,
                },
            )?,
            wav,
        });
        Self::create_internal(output_path, temporary_path, config, audio)
    }

    fn create_internal(
        output_path: &Path,
        temporary_path: &Path,
        config: NativeMp4VideoConfig,
        audio: Option<NativeMp4AudioSource>,
    ) -> PlatformResult<Self> {
        let (timing_plan, expected_frame_bytes) = validate_native_mp4_config(config)?;
        let (output_path, temporary_path) = validate_new_mp4_paths(output_path, temporary_path)?;

        #[cfg(windows)]
        {
            let state = match native_mp4_windows::WriterState::create(
                &temporary_path,
                config,
                audio.as_ref().map(|audio| audio.wav.info),
            ) {
                Ok(state) => state,
                Err(error) => {
                    let _ = fs::remove_file(&temporary_path);
                    return Err(error);
                }
            };
            Ok(Self {
                output_path,
                temporary_path,
                config,
                timing_plan,
                expected_frame_bytes,
                frames_written: 0,
                published: false,
                state: Some(state),
                audio,
            })
        }
        #[cfg(not(windows))]
        {
            let _ = (
                output_path,
                temporary_path,
                timing_plan,
                expected_frame_bytes,
                audio,
            );
            Err(PlatformError::Unsupported)
        }
    }

    /// Writes one tightly packed top-down BGRA frame.
    ///
    /// # Errors
    ///
    /// Returns an error when cancellation is requested, the frame byte length
    /// differs from `width * height * 4`, too many frames are supplied, or the
    /// Media Foundation writer rejects the sample.
    pub fn write_bgra_frame(
        &mut self,
        frame: &[u8],
        cancellation: &crate::ProcessCancellation,
    ) -> PlatformResult<MediaFoundationSampleTiming> {
        #[cfg(not(windows))]
        {
            let _ = (frame, cancellation);
            Err(PlatformError::Unsupported)
        }
        #[cfg(windows)]
        {
            if cancellation.is_cancelled() {
                return Err(PlatformError::Cancelled { process_id: None });
            }
            if self.frames_written >= self.config.frame_count {
                return Err(PlatformError::InvalidInput(format!(
                    "received more than the configured {} video frames",
                    self.config.frame_count
                )));
            }
            if frame.len() != self.expected_frame_bytes {
                return Err(PlatformError::InvalidInput(format!(
                    "BGRA frame contains {} bytes; expected {}",
                    frame.len(),
                    self.expected_frame_bytes
                )));
            }
            let timing = self.timing_plan.frame_timing(self.frames_written)?;
            self.state
                .as_ref()
                .ok_or_else(|| PlatformError::Windows("MP4 writer is no longer active".to_owned()))?
                .write_bgra_frame(frame, timing)?;
            self.frames_written += 1;
            Ok(timing)
        }
    }

    /// Finalizes and atomically publishes the new MP4 destination.
    ///
    /// # Errors
    ///
    /// Returns an error when cancellation is requested, fewer than the exact
    /// configured number of frames were written, finalization or flushing
    /// fails, or another file wins the destination publication race.
    pub fn finish(
        self,
        cancellation: &crate::ProcessCancellation,
    ) -> PlatformResult<NativeMp4VideoSummary> {
        if cancellation.is_cancelled() {
            return Err(PlatformError::Cancelled { process_id: None });
        }
        if self.frames_written != self.config.frame_count {
            return Err(PlatformError::InvalidInput(format!(
                "cannot finalize MP4 after {} frames; expected {}",
                self.frames_written, self.config.frame_count
            )));
        }

        #[cfg(windows)]
        {
            let mut writer = self;
            let state = writer.state.take().ok_or_else(|| {
                PlatformError::Windows("MP4 writer is no longer active".to_owned())
            })?;
            if let Some(audio) = writer.audio.as_mut() {
                state.write_pcm_audio(audio, cancellation)?;
            }
            state.finalize()?;
            let temporary_file = fs::OpenOptions::new()
                .read(true)
                .write(true)
                .open(&writer.temporary_path)
                .map_err(|error| {
                    crate::io_error("opening finalized MP4", &writer.temporary_path, error)
                })?;
            temporary_file.sync_all().map_err(|error| {
                crate::io_error("flushing finalized MP4", &writer.temporary_path, error)
            })?;
            let output_bytes = temporary_file
                .metadata()
                .map_err(|error| {
                    crate::io_error(
                        "reading finalized MP4 metadata",
                        &writer.temporary_path,
                        error,
                    )
                })?
                .len();
            drop(temporary_file);
            let inspection = inspect_native_h264_mp4(&writer.temporary_path)?;
            let inspected_duration = u64::try_from(inspection.video_duration_100ns).ok();
            let expected_audio = writer.audio.as_ref().map(|audio| audio.timing);
            // MP4 sample durations are integer 100ns values; Media Foundation
            // can round each fractional-rate frame independently on read-back.
            let maximum_video_rounding_error = writer.frames_written;
            if !inspection.video_subtype_is_h264
                || inspection.width != writer.config.width
                || inspection.height != writer.config.height
                || inspection.frame_rate != writer.config.frame_rate
                || inspection.sample_count != writer.frames_written
                || inspection.audio_stream_is_aac != expected_audio.is_some()
                || expected_audio.is_some_and(|audio| {
                    let expected_duration = sample_boundary_100ns(
                        audio.output_sample_frame_count,
                        audio.sample_rate_hz,
                    )
                    .ok();
                    inspection.audio_sample_count == 0
                        || !inspection.audio_timestamps_are_monotonic
                        || expected_duration.is_none_or(|duration| {
                            u64::try_from(inspection.audio_duration_100ns).map_or(true, |actual| {
                                audio_read_back_duration_tolerance_100ns(
                                    audio.sample_rate_hz,
                                    writer.config.frame_rate,
                                    inspection.audio_sample_count,
                                )
                                .is_none_or(|tolerance| actual.abs_diff(duration) > tolerance)
                            })
                        })
                })
                || inspected_duration.is_none_or(|duration| {
                    duration.abs_diff(writer.timing_plan.video_duration_100ns)
                        > maximum_video_rounding_error
                })
                || !inspection.timestamps_are_monotonic
            {
                return Err(PlatformError::Windows(format!(
                    "finalized MP4 failed read-back validation: H.264={}, AAC={}, size={}x{}, rate={}/{}, samples={}/{}, audioSamples={}, duration={}/{}, audioDuration={}, monotonic={}/{},",
                    inspection.video_subtype_is_h264,
                    inspection.audio_stream_is_aac,
                    inspection.width,
                    inspection.height,
                    inspection.frame_rate.numerator,
                    inspection.frame_rate.denominator,
                    inspection.sample_count,
                    writer.frames_written,
                    inspection.audio_sample_count,
                    inspection.video_duration_100ns,
                    writer.timing_plan.video_duration_100ns,
                    inspection.audio_duration_100ns,
                    inspection.timestamps_are_monotonic,
                    inspection.audio_timestamps_are_monotonic,
                )));
            }
            native_mp4_windows::publish_new(&writer.temporary_path, &writer.output_path)?;
            writer.published = true;
            Ok(NativeMp4VideoSummary {
                output_path: writer.output_path.clone(),
                output_bytes,
                frame_count: writer.frames_written,
                video_duration_100ns: writer.timing_plan.video_duration_100ns,
                audio_stream_included: writer.audio.is_some(),
            })
        }
        #[cfg(not(windows))]
        {
            Err(PlatformError::Unsupported)
        }
    }
}

/// Media Foundation's AAC-LC encoder can expose one padded access unit at the
/// tail of a finalized stream. Source Reader also rounds each compressed sample
/// duration independently to the 100ns time base. Keep validation strict to one
/// AAC access unit plus that bounded per-sample rounding, while preserving the
/// historical one-video-frame allowance at lower frame rates.
fn audio_read_back_duration_tolerance_100ns(
    sample_rate_hz: u32,
    frame_rate: RationalFrameRate,
    encoded_sample_count: u64,
) -> Option<u64> {
    let video_frame = frame_boundary_100ns(1, frame_rate).ok()?;
    let aac_access_unit =
        sample_boundary_100ns(AAC_LC_SAMPLE_FRAMES_PER_ACCESS_UNIT, sample_rate_hz).ok()?;
    Some(video_frame.max(aac_access_unit.saturating_add(encoded_sample_count)))
}

/// Opens a finalized MP4 through Media Foundation and inspects its compressed
/// video stream without decoding frame payloads.
///
/// # Errors
///
/// Returns an error for unsafe paths, unavailable Media Foundation runtime,
/// missing video streams, read failures, empty samples, or excessive sample
/// counts. On non-Windows targets this returns [`PlatformError::Unsupported`].
pub fn inspect_native_h264_mp4(path: &Path) -> PlatformResult<NativeMp4VideoInspection> {
    if !path.is_absolute() || !path.is_file() {
        return Err(PlatformError::InvalidInput(
            "native MP4 inspection requires an existing absolute file".to_owned(),
        ));
    }
    #[cfg(windows)]
    {
        native_mp4_windows::inspect(path)
    }
    #[cfg(not(windows))]
    {
        Err(PlatformError::Unsupported)
    }
}

/// Parses and validates a bounded RIFF/WAVE PCM file suitable for native AAC
/// encoding. Only 16-bit mono/stereo PCM at 44.1 or 48 kHz is accepted.
///
/// # Errors
///
/// Returns [`PlatformError::InvalidInput`] for non-absolute paths, malformed or
/// unsupported WAV structures, duplicate/missing mandatory chunks, truncated
/// chunk padding, unaligned PCM data, or media longer than the sequence limit.
pub fn inspect_native_pcm_wav(path: &Path) -> PlatformResult<NativePcmWavInfo> {
    Ok(open_native_pcm_wav(path)?.info)
}

fn open_native_pcm_wav(path: &Path) -> PlatformResult<NativePcmWavSource> {
    if !path.is_absolute() || path.file_name().is_none() {
        return Err(PlatformError::InvalidInput(
            "PCM WAV input must be an absolute file path".to_owned(),
        ));
    }
    let file = fs::File::open(path)
        .map_err(|error| crate::io_error("opening PCM WAV input", path, error))?;
    parse_native_pcm_wav(file, path)
}

fn parse_native_pcm_wav(mut file: fs::File, path: &Path) -> PlatformResult<NativePcmWavSource> {
    let file_bytes = file
        .metadata()
        .map_err(|error| crate::io_error("reading PCM WAV metadata", path, error))?
        .len();
    if !(12..=MAX_PCM_WAV_FILE_BYTES).contains(&file_bytes) {
        return Err(PlatformError::InvalidInput(format!(
            "PCM WAV file length must be between 12 and {MAX_PCM_WAV_FILE_BYTES} bytes"
        )));
    }
    let mut riff_header = [0_u8; 12];
    file.read_exact(&mut riff_header)
        .map_err(|error| crate::io_error("reading PCM WAV RIFF header", path, error))?;
    if &riff_header[0..4] != b"RIFF" || &riff_header[8..12] != b"WAVE" {
        return Err(PlatformError::InvalidInput(
            "PCM WAV must use a RIFF/WAVE header".to_owned(),
        ));
    }
    let riff_payload_bytes = u64::from(u32::from_le_bytes(
        riff_header[4..8]
            .try_into()
            .expect("four-byte RIFF size slice"),
    ));
    let riff_end = riff_payload_bytes
        .checked_add(8)
        .ok_or_else(|| PlatformError::InvalidInput("PCM WAV RIFF length overflowed".to_owned()))?;
    if riff_end != file_bytes {
        return Err(PlatformError::InvalidInput(format!(
            "PCM WAV RIFF length {riff_end} does not match file length {file_bytes}"
        )));
    }

    let mut cursor = 12_u64;
    let mut chunk_count = 0_u32;
    let mut format = None;
    let mut data = None;
    while cursor < riff_end {
        chunk_count += 1;
        if chunk_count > MAX_PCM_WAV_CHUNK_COUNT {
            return Err(PlatformError::InvalidInput(format!(
                "PCM WAV contains more than {MAX_PCM_WAV_CHUNK_COUNT} chunks"
            )));
        }
        if riff_end - cursor < 8 {
            return Err(PlatformError::InvalidInput(
                "PCM WAV ends inside a chunk header".to_owned(),
            ));
        }
        file.seek(SeekFrom::Start(cursor))
            .and_then(|_| {
                let mut header = [0_u8; 8];
                file.read_exact(&mut header).map(|()| header)
            })
            .map_err(|error| crate::io_error("reading PCM WAV chunk header", path, error))
            .and_then(|header| {
                let chunk_id: [u8; 4] = header[0..4]
                    .try_into()
                    .expect("four-byte WAV chunk id slice");
                let chunk_bytes = u64::from(u32::from_le_bytes(
                    header[4..8]
                        .try_into()
                        .expect("four-byte WAV chunk size slice"),
                ));
                let data_offset = cursor + 8;
                let data_end = data_offset.checked_add(chunk_bytes).ok_or_else(|| {
                    PlatformError::InvalidInput("PCM WAV chunk length overflowed".to_owned())
                })?;
                let padded_end = data_end.checked_add(chunk_bytes % 2).ok_or_else(|| {
                    PlatformError::InvalidInput("PCM WAV chunk padding overflowed".to_owned())
                })?;
                if padded_end > riff_end {
                    return Err(PlatformError::InvalidInput(
                        "PCM WAV chunk extends beyond the RIFF container".to_owned(),
                    ));
                }
                match &chunk_id {
                    b"fmt " => {
                        if format.is_some() {
                            return Err(PlatformError::InvalidInput(
                                "PCM WAV contains duplicate fmt chunks".to_owned(),
                            ));
                        }
                        if chunk_bytes != 16 {
                            return Err(PlatformError::InvalidInput(
                                "PCM WAV fmt chunk must use the 16-byte PCM layout".to_owned(),
                            ));
                        }
                        let mut bytes = [0_u8; 16];
                        file.seek(SeekFrom::Start(data_offset))
                            .and_then(|_| file.read_exact(&mut bytes))
                            .map_err(|error| {
                                crate::io_error("reading PCM WAV fmt chunk", path, error)
                            })?;
                        format = Some(parse_pcm_format(bytes)?);
                    }
                    b"data" => {
                        if data.is_some() {
                            return Err(PlatformError::InvalidInput(
                                "PCM WAV contains duplicate data chunks".to_owned(),
                            ));
                        }
                        data = Some((data_offset, chunk_bytes));
                    }
                    _ => {}
                }
                cursor = padded_end;
                Ok(header)
            })?;
    }
    let format = format.ok_or_else(|| {
        PlatformError::InvalidInput("PCM WAV is missing its fmt chunk".to_owned())
    })?;
    let (data_offset, data_bytes) = data.ok_or_else(|| {
        PlatformError::InvalidInput("PCM WAV is missing its data chunk".to_owned())
    })?;
    let block_alignment = u64::from(format.channel_count) * 2;
    if data_bytes == 0 || !data_bytes.is_multiple_of(block_alignment) {
        return Err(PlatformError::InvalidInput(
            "PCM WAV data must contain whole non-empty sample frames".to_owned(),
        ));
    }
    let sample_frame_count = data_bytes / block_alignment;
    let maximum_sample_frames = u64::from(format.sample_rate_hz) * MAX_SEQUENCE_DURATION_SECONDS;
    if sample_frame_count > maximum_sample_frames {
        return Err(PlatformError::InvalidInput(format!(
            "PCM WAV exceeds the {MAX_SEQUENCE_DURATION_SECONDS}-second limit"
        )));
    }
    Ok(NativePcmWavSource {
        file,
        path: path.to_path_buf(),
        info: NativePcmWavInfo {
            sample_rate_hz: format.sample_rate_hz,
            channel_count: format.channel_count,
            bits_per_sample: 16,
            sample_frame_count,
            data_bytes,
        },
        data_offset,
    })
}

#[derive(Debug, Clone, Copy)]
struct ParsedPcmFormat {
    sample_rate_hz: u32,
    channel_count: u16,
}

fn parse_pcm_format(bytes: [u8; 16]) -> PlatformResult<ParsedPcmFormat> {
    let encoding = u16::from_le_bytes([bytes[0], bytes[1]]);
    let channel_count = u16::from_le_bytes([bytes[2], bytes[3]]);
    let sample_rate_hz = u32::from_le_bytes([bytes[4], bytes[5], bytes[6], bytes[7]]);
    let byte_rate = u32::from_le_bytes([bytes[8], bytes[9], bytes[10], bytes[11]]);
    let block_alignment = u16::from_le_bytes([bytes[12], bytes[13]]);
    let bits_per_sample = u16::from_le_bytes([bytes[14], bytes[15]]);
    if encoding != 1
        || !matches!(channel_count, 1 | 2)
        || !matches!(sample_rate_hz, 44_100 | 48_000)
        || bits_per_sample != 16
    {
        return Err(PlatformError::InvalidInput(
            "PCM WAV must be 16-bit mono/stereo integer PCM at 44.1 or 48 kHz".to_owned(),
        ));
    }
    let expected_block_alignment = channel_count * 2;
    let expected_byte_rate = sample_rate_hz * u32::from(expected_block_alignment);
    if block_alignment != expected_block_alignment || byte_rate != expected_byte_rate {
        return Err(PlatformError::InvalidInput(
            "PCM WAV byte rate or block alignment is inconsistent".to_owned(),
        ));
    }
    Ok(ParsedPcmFormat {
        sample_rate_hz,
        channel_count,
    })
}

impl Drop for NativeMp4VideoWriter {
    fn drop(&mut self) {
        #[cfg(windows)]
        drop(self.state.take());
        if !self.published {
            let _ = fs::remove_file(&self.temporary_path);
        }
    }
}

/// Probes registered Media Foundation H.264/AAC transform candidates.
///
/// This performs no file I/O and deliberately does not report a successful
/// MP4 encode. On non-Windows targets the report status is `Unsupported`.
pub fn probe_hlae_sequence_encoder_capabilities() -> HlaeSequenceEncoderCapabilityReport {
    #[cfg(windows)]
    {
        windows_impl::probe()
    }
    #[cfg(not(windows))]
    {
        HlaeSequenceEncoderCapabilityReport {
            status: HlaeSequenceEncoderProbeStatus::Unsupported,
            media_foundation_started: false,
            registered_h264_encoder_count: 0,
            registered_hardware_h264_encoder_count: 0,
            registered_aac_encoder_count: 0,
            end_to_end_mp4_encode_verified: false,
            detail: "Windows Media Foundation is unavailable on this operating system".to_owned(),
        }
    }
}

impl HlaeSequenceTimingPlan {
    /// Returns the exact Media Foundation PTS and duration for one source frame.
    ///
    /// # Errors
    ///
    /// Returns [`PlatformError::InvalidInput`] when `sample_index` is outside
    /// this plan's frame range or the timestamp cannot be represented.
    pub fn frame_timing(&self, sample_index: u64) -> PlatformResult<MediaFoundationSampleTiming> {
        if self.time_base_ticks_per_second != MEDIA_FOUNDATION_TICKS_PER_SECOND {
            return Err(PlatformError::InvalidInput(
                "Media Foundation timing-plan time base is invalid".to_owned(),
            ));
        }
        validate_video_timing(self.frame_count, self.frame_rate)?;
        if sample_index >= self.frame_count {
            return Err(PlatformError::InvalidInput(format!(
                "frame index {sample_index} is outside a {}-frame sequence",
                self.frame_count
            )));
        }
        let presentation_time_100ns = frame_boundary_100ns(sample_index, self.frame_rate)?;
        let next_boundary = frame_boundary_100ns(sample_index + 1, self.frame_rate)?;
        let duration_100ns = next_boundary
            .checked_sub(presentation_time_100ns)
            .ok_or_else(|| {
                PlatformError::InvalidInput("video frame timestamp order is invalid".to_owned())
            })?;
        Ok(MediaFoundationSampleTiming {
            sample_index,
            presentation_time_100ns,
            duration_100ns,
        })
    }
}

/// Plans drift-free Media Foundation timestamps and end-only WAV alignment.
///
/// # Errors
///
/// Returns [`PlatformError::InvalidInput`] for an empty or unbounded sequence,
/// an invalid frame rate, invalid audio timing, or an unrepresentable timestamp.
pub fn plan_hlae_sequence_timing(
    request: HlaeSequenceTimingRequest,
) -> PlatformResult<HlaeSequenceTimingPlan> {
    validate_timing_request(request)?;
    let video_duration_100ns = frame_boundary_100ns(request.frame_count, request.frame_rate)?;
    let audio = request
        .audio
        .map(|audio| plan_audio(request.frame_count, request.frame_rate, audio))
        .transpose()?;
    Ok(HlaeSequenceTimingPlan {
        time_base_ticks_per_second: MEDIA_FOUNDATION_TICKS_PER_SECOND,
        frame_count: request.frame_count,
        frame_rate: request.frame_rate,
        video_duration_100ns,
        audio,
    })
}

fn validate_native_mp4_config(
    config: NativeMp4VideoConfig,
) -> PlatformResult<(HlaeSequenceTimingPlan, usize)> {
    let timing_plan = plan_hlae_sequence_timing(HlaeSequenceTimingRequest {
        frame_count: config.frame_count,
        frame_rate: config.frame_rate,
        audio: None,
    })?;
    if config.width < MIN_NATIVE_MP4_DIMENSION
        || config.width > MAX_NATIVE_MP4_WIDTH
        || config.height < MIN_NATIVE_MP4_DIMENSION
        || config.height > MAX_NATIVE_MP4_HEIGHT
        || !config.width.is_multiple_of(2)
        || !config.height.is_multiple_of(2)
    {
        return Err(PlatformError::InvalidInput(format!(
            "native MP4 dimensions must be even and within {MIN_NATIVE_MP4_DIMENSION}x{MIN_NATIVE_MP4_DIMENSION} to {MAX_NATIVE_MP4_WIDTH}x{MAX_NATIVE_MP4_HEIGHT}"
        )));
    }
    if !(MIN_NATIVE_MP4_BITRATE_BPS..=MAX_NATIVE_MP4_BITRATE_BPS)
        .contains(&config.target_bitrate_bps)
    {
        return Err(PlatformError::InvalidInput(format!(
            "native MP4 target bitrate must be between {MIN_NATIVE_MP4_BITRATE_BPS} and {MAX_NATIVE_MP4_BITRATE_BPS} bits per second"
        )));
    }
    let expected_frame_bytes = u64::from(config.width)
        .checked_mul(u64::from(config.height))
        .and_then(|pixels| pixels.checked_mul(4))
        .and_then(|bytes| usize::try_from(bytes).ok())
        .ok_or_else(|| {
            PlatformError::InvalidInput("BGRA frame byte length overflowed".to_owned())
        })?;
    u32::try_from(expected_frame_bytes).map_err(|_| {
        PlatformError::InvalidInput("BGRA frame is too large for Media Foundation".to_owned())
    })?;
    Ok((timing_plan, expected_frame_bytes))
}

fn validate_new_mp4_paths(
    output_path: &Path,
    temporary_path: &Path,
) -> PlatformResult<(PathBuf, PathBuf)> {
    if !output_path.is_absolute() || output_path.file_name().is_none() {
        return Err(PlatformError::InvalidInput(
            "native MP4 output must be an absolute file path".to_owned(),
        ));
    }
    if !output_path
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("mp4"))
    {
        return Err(PlatformError::InvalidInput(
            "native Media Foundation output must use the .mp4 extension".to_owned(),
        ));
    }
    if !temporary_path.is_absolute() || temporary_path.file_name().is_none() {
        return Err(PlatformError::InvalidInput(
            "native MP4 temporary output must be an absolute file path".to_owned(),
        ));
    }
    let temporary_name = temporary_path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| {
            PlatformError::InvalidInput(
                "native MP4 temporary output must have a Unicode file name".to_owned(),
            )
        })?;
    if !temporary_name.ends_with(".partial.mp4") {
        return Err(PlatformError::InvalidInput(
            "native MP4 temporary output must end with .partial.mp4".to_owned(),
        ));
    }

    let output_parent = output_path.parent().ok_or_else(|| {
        PlatformError::InvalidInput("native MP4 output has no parent directory".to_owned())
    })?;
    let temporary_parent = temporary_path.parent().ok_or_else(|| {
        PlatformError::InvalidInput(
            "native MP4 temporary output has no parent directory".to_owned(),
        )
    })?;
    let canonical_output_parent =
        canonical_non_reparse_directory(output_parent, "native MP4 output parent")?;
    let canonical_temporary_parent =
        canonical_non_reparse_directory(temporary_parent, "native MP4 temporary output parent")?;
    if canonical_output_parent != canonical_temporary_parent {
        return Err(PlatformError::InvalidInput(
            "native MP4 output and temporary output must share one canonical parent".to_owned(),
        ));
    }

    let output_path = canonical_output_parent.join(
        output_path
            .file_name()
            .expect("validated native MP4 output file name"),
    );
    let temporary_path = canonical_output_parent.join(
        temporary_path
            .file_name()
            .expect("validated native MP4 temporary file name"),
    );
    if paths_match_for_native_output(&output_path, &temporary_path) {
        return Err(PlatformError::InvalidInput(
            "native MP4 output and temporary output must be different files".to_owned(),
        ));
    }
    ensure_new_native_mp4_path(&output_path)?;
    ensure_new_native_mp4_path(&temporary_path)?;
    Ok((output_path, temporary_path))
}

fn canonical_non_reparse_directory(path: &Path, label: &str) -> PlatformResult<PathBuf> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Err(PlatformError::InvalidInput(format!(
                "{label} must be an existing non-reparse directory"
            )));
        }
        Err(error) => {
            return Err(crate::io_error("reading native MP4 parent", path, error));
        }
    };
    if !metadata.is_dir() || metadata_is_reparse_point(&metadata) {
        return Err(PlatformError::InvalidInput(format!(
            "{label} must be an existing non-reparse directory"
        )));
    }
    let canonical = fs::canonicalize(path)
        .map_err(|error| crate::io_error("canonicalizing native MP4 parent", path, error))?;
    let canonical_metadata = fs::symlink_metadata(&canonical).map_err(|error| {
        crate::io_error("reading canonical native MP4 parent", &canonical, error)
    })?;
    if !canonical_metadata.is_dir() || metadata_is_reparse_point(&canonical_metadata) {
        return Err(PlatformError::InvalidInput(format!(
            "{label} resolved to a reparse point or non-directory"
        )));
    }
    Ok(canonical)
}

fn metadata_is_reparse_point(metadata: &fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;

        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0000_0400;
        metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
    }
    #[cfg(not(windows))]
    {
        metadata.file_type().is_symlink()
    }
}

fn paths_match_for_native_output(left: &Path, right: &Path) -> bool {
    if left == right {
        return true;
    }
    #[cfg(windows)]
    {
        left.to_string_lossy()
            .eq_ignore_ascii_case(&right.to_string_lossy())
    }
    #[cfg(not(windows))]
    {
        false
    }
}

fn ensure_new_native_mp4_path(path: &Path) -> PlatformResult<()> {
    match fs::symlink_metadata(path) {
        Ok(_) => Err(PlatformError::RecoveryPending),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(crate::io_error(
            "checking native MP4 destination",
            path,
            error,
        )),
    }
}

fn native_mp4_temporary_path(output_path: &Path) -> PlatformResult<PathBuf> {
    let file_name = output_path.file_name().ok_or_else(|| {
        PlatformError::InvalidInput("native MP4 output has no file name".to_owned())
    })?;
    let mut temporary_name = std::ffi::OsString::from(".");
    temporary_name.push(file_name);
    temporary_name.push(format!(".{}.partial.mp4", Uuid::new_v4()));
    Ok(output_path.with_file_name(temporary_name))
}

fn validate_timing_request(request: HlaeSequenceTimingRequest) -> PlatformResult<()> {
    validate_video_timing(request.frame_count, request.frame_rate)?;
    if let Some(audio) = request.audio {
        if !(MIN_AUDIO_SAMPLE_RATE_HZ..=MAX_AUDIO_SAMPLE_RATE_HZ).contains(&audio.sample_rate_hz) {
            return Err(PlatformError::InvalidInput(format!(
                "audio sample rate must be between {MIN_AUDIO_SAMPLE_RATE_HZ} and {MAX_AUDIO_SAMPLE_RATE_HZ} Hz"
            )));
        }
        let maximum_samples = u64::from(audio.sample_rate_hz) * MAX_SEQUENCE_DURATION_SECONDS;
        if audio.sample_frame_count > maximum_samples {
            return Err(PlatformError::InvalidInput(format!(
                "audio sample-frame count exceeds the {MAX_SEQUENCE_DURATION_SECONDS}-second limit"
            )));
        }
    }
    Ok(())
}

fn validate_video_timing(frame_count: u64, frame_rate: RationalFrameRate) -> PlatformResult<()> {
    if frame_count == 0 || frame_count > MAX_SEQUENCE_FRAME_COUNT {
        return Err(PlatformError::InvalidInput(format!(
            "frame count must be between 1 and {MAX_SEQUENCE_FRAME_COUNT}"
        )));
    }
    if frame_rate.numerator == 0
        || frame_rate.denominator == 0
        || frame_rate.denominator > MAX_FRAME_RATE_DENOMINATOR
        || u64::from(frame_rate.numerator) < u64::from(frame_rate.denominator)
        || u64::from(frame_rate.numerator)
            > u64::from(frame_rate.denominator) * u64::from(MAX_FRAME_RATE)
    {
        return Err(PlatformError::InvalidInput(format!(
            "frame rate must be between 1 and {MAX_FRAME_RATE} frames per second"
        )));
    }
    if u128::from(frame_count) * u128::from(frame_rate.denominator)
        > u128::from(frame_rate.numerator) * u128::from(MAX_SEQUENCE_DURATION_SECONDS)
    {
        return Err(PlatformError::InvalidInput(format!(
            "sequence duration must not exceed {MAX_SEQUENCE_DURATION_SECONDS} seconds"
        )));
    }
    Ok(())
}

fn frame_boundary_100ns(frame_index: u64, frame_rate: RationalFrameRate) -> PlatformResult<u64> {
    rounded_ratio_to_u64(
        u128::from(frame_index)
            * u128::from(frame_rate.denominator)
            * u128::from(MEDIA_FOUNDATION_TICKS_PER_SECOND),
        u128::from(frame_rate.numerator),
        "video timestamp",
    )
}

#[cfg_attr(not(windows), allow(dead_code))]
fn sample_boundary_100ns(sample_frame_index: u64, sample_rate_hz: u32) -> PlatformResult<u64> {
    rounded_ratio_to_u64(
        u128::from(sample_frame_index) * u128::from(MEDIA_FOUNDATION_TICKS_PER_SECOND),
        u128::from(sample_rate_hz),
        "audio timestamp",
    )
}

fn plan_audio(
    frame_count: u64,
    frame_rate: RationalFrameRate,
    audio: HlaeSequenceAudioTiming,
) -> PlatformResult<HlaeSequenceAudioPlan> {
    let output_sample_frame_count = rounded_ratio_to_u64(
        u128::from(frame_count)
            * u128::from(frame_rate.denominator)
            * u128::from(audio.sample_rate_hz),
        u128::from(frame_rate.numerator),
        "aligned audio sample count",
    )?;
    let adjustment = match audio.sample_frame_count.cmp(&output_sample_frame_count) {
        std::cmp::Ordering::Equal => HlaeAudioLengthAdjustment::Exact,
        std::cmp::Ordering::Less => HlaeAudioLengthAdjustment::PadEnd {
            sample_frame_count: output_sample_frame_count - audio.sample_frame_count,
        },
        std::cmp::Ordering::Greater => HlaeAudioLengthAdjustment::TrimEnd {
            sample_frame_count: audio.sample_frame_count - output_sample_frame_count,
        },
    };
    Ok(HlaeSequenceAudioPlan {
        sample_rate_hz: audio.sample_rate_hz,
        input_sample_frame_count: audio.sample_frame_count,
        output_sample_frame_count,
        adjustment,
    })
}

fn rounded_ratio_to_u64(
    numerator: u128,
    denominator: u128,
    value_name: &str,
) -> PlatformResult<u64> {
    let rounded = numerator
        .checked_add(denominator / 2)
        .ok_or_else(|| PlatformError::InvalidInput(format!("{value_name} overflowed")))?
        / denominator;
    u64::try_from(rounded)
        .map_err(|_| PlatformError::InvalidInput(format!("{value_name} exceeds u64")))
}

#[cfg(windows)]
mod windows_impl {
    use std::{ffi::c_void, ptr};

    use windows::{
        Win32::{
            Media::MediaFoundation::{
                IMFAttributes, MF_VERSION, MFAudioFormat_AAC, MFMediaType_Audio, MFMediaType_Video,
                MFSTARTUP_FULL, MFShutdown, MFStartup, MFT_CATEGORY_AUDIO_ENCODER,
                MFT_CATEGORY_VIDEO_ENCODER, MFT_ENUM_FLAG, MFT_ENUM_FLAG_ALL,
                MFT_ENUM_FLAG_HARDWARE, MFT_ENUM_FLAG_SORTANDFILTER, MFT_REGISTER_TYPE_INFO,
                MFTEnum, MFVideoFormat_H264,
            },
            System::Com::CoTaskMemFree,
        },
        core::{Error, GUID},
    };

    use super::{HlaeSequenceEncoderCapabilityReport, HlaeSequenceEncoderProbeStatus};

    #[derive(Debug, Clone, Copy)]
    struct CandidateCounts {
        h264: u32,
        hardware_h264: u32,
        aac: u32,
    }

    struct MediaFoundationSession;

    impl MediaFoundationSession {
        fn start() -> windows::core::Result<Self> {
            // SAFETY: starts Media Foundation for this process; the guard always
            // balances a successful call with `MFShutdown`.
            unsafe { MFStartup(MF_VERSION, MFSTARTUP_FULL)? };
            Ok(Self)
        }
    }

    impl Drop for MediaFoundationSession {
        fn drop(&mut self) {
            // SAFETY: this guard exists only after one successful `MFStartup`.
            let _ = unsafe { MFShutdown() };
        }
    }

    pub(super) fn probe() -> HlaeSequenceEncoderCapabilityReport {
        let session = match MediaFoundationSession::start() {
            Ok(session) => session,
            Err(error) => return failed_report(false, "starting Media Foundation", &error),
        };
        let counts = match enumerate_candidates() {
            Ok(counts) => counts,
            Err((operation, error)) => {
                drop(session);
                return failed_report(true, operation, &error);
            }
        };
        let status = if counts.h264 == 0 {
            HlaeSequenceEncoderProbeStatus::NoH264EncoderRegistered
        } else {
            HlaeSequenceEncoderProbeStatus::EncoderCandidatesRegistered
        };
        let detail = if counts.h264 == 0 {
            "Media Foundation started, but no registered H.264 encoder candidate was found"
                .to_owned()
        } else {
            "Registered encoder candidates were found; this inventory probe does not perform an end-to-end MP4 encode"
                .to_owned()
        };
        HlaeSequenceEncoderCapabilityReport {
            status,
            media_foundation_started: true,
            registered_h264_encoder_count: counts.h264,
            registered_hardware_h264_encoder_count: counts.hardware_h264,
            registered_aac_encoder_count: counts.aac,
            end_to_end_mp4_encode_verified: false,
            detail,
        }
    }

    fn enumerate_candidates() -> Result<CandidateCounts, (&'static str, Error)> {
        let h264_output = MFT_REGISTER_TYPE_INFO {
            guidMajorType: MFMediaType_Video,
            guidSubtype: MFVideoFormat_H264,
        };
        let aac_output = MFT_REGISTER_TYPE_INFO {
            guidMajorType: MFMediaType_Audio,
            guidSubtype: MFAudioFormat_AAC,
        };
        Ok(CandidateCounts {
            h264: enumerate_transform_count(
                MFT_CATEGORY_VIDEO_ENCODER,
                MFT_ENUM_FLAG_ALL | MFT_ENUM_FLAG_SORTANDFILTER,
                &h264_output,
            )
            .map_err(|error| ("enumerating H.264 encoders", error))?,
            hardware_h264: enumerate_transform_count(
                MFT_CATEGORY_VIDEO_ENCODER,
                MFT_ENUM_FLAG_HARDWARE | MFT_ENUM_FLAG_SORTANDFILTER,
                &h264_output,
            )
            .map_err(|error| ("enumerating hardware H.264 encoders", error))?,
            aac: enumerate_transform_count(
                MFT_CATEGORY_AUDIO_ENCODER,
                MFT_ENUM_FLAG_ALL | MFT_ENUM_FLAG_SORTANDFILTER,
                &aac_output,
            )
            .map_err(|error| ("enumerating AAC encoders", error))?,
        })
    }

    fn enumerate_transform_count(
        category: GUID,
        flags: MFT_ENUM_FLAG,
        output_type: &MFT_REGISTER_TYPE_INFO,
    ) -> windows::core::Result<u32> {
        let mut class_ids = ptr::null_mut::<GUID>();
        let mut count = 0;
        // SAFETY: output pointers are valid for the duration of the call. The
        // returned CoTaskMem buffer is released below without dereferencing it.
        let result = unsafe {
            MFTEnum(
                category,
                flags.0.cast_unsigned(),
                None,
                Some(ptr::from_ref(output_type)),
                None::<&IMFAttributes>,
                &raw mut class_ids,
                &raw mut count,
            )
        };
        if !class_ids.is_null() {
            // SAFETY: `MFTEnum` allocates this buffer with CoTaskMemAlloc and
            // transfers ownership to the caller, including on a zero count.
            unsafe { CoTaskMemFree(Some(class_ids.cast::<c_void>().cast_const())) };
        }
        result.map(|()| count)
    }

    fn failed_report(
        media_foundation_started: bool,
        operation: &str,
        error: &Error,
    ) -> HlaeSequenceEncoderCapabilityReport {
        HlaeSequenceEncoderCapabilityReport {
            status: HlaeSequenceEncoderProbeStatus::MediaFoundationUnavailable,
            media_foundation_started,
            registered_h264_encoder_count: 0,
            registered_hardware_h264_encoder_count: 0,
            registered_aac_encoder_count: 0,
            end_to_end_mp4_encode_verified: false,
            detail: format!(
                "{operation} failed (HRESULT {:#010x}): {error}",
                error.code().0.cast_unsigned()
            ),
        }
    }
}

#[cfg(windows)]
mod native_mp4_windows {
    use std::{
        io::{Read, Seek, SeekFrom},
        os::windows::ffi::OsStrExt,
        path::Path,
        ptr,
    };

    use windows::{
        Win32::{
            Foundation::RPC_E_CHANGED_MODE,
            Media::MediaFoundation::{
                CODECAPI_AVEncMPVDefaultBPictureCount, IMFMediaBuffer, IMFMediaType, IMFSinkWriter,
                MF_E_INVALIDSTREAMNUMBER, MF_MT_AAC_PAYLOAD_TYPE, MF_MT_ALL_SAMPLES_INDEPENDENT,
                MF_MT_AUDIO_AVG_BYTES_PER_SECOND, MF_MT_AUDIO_BITS_PER_SAMPLE,
                MF_MT_AUDIO_BLOCK_ALIGNMENT, MF_MT_AUDIO_NUM_CHANNELS,
                MF_MT_AUDIO_SAMPLES_PER_SECOND, MF_MT_AVG_BITRATE, MF_MT_DEFAULT_STRIDE,
                MF_MT_FIXED_SIZE_SAMPLES, MF_MT_FRAME_RATE, MF_MT_FRAME_SIZE, MF_MT_INTERLACE_MODE,
                MF_MT_MAJOR_TYPE, MF_MT_MPEG2_PROFILE, MF_MT_PIXEL_ASPECT_RATIO, MF_MT_SUBTYPE,
                MF_READWRITE_ENABLE_HARDWARE_TRANSFORMS, MF_SINK_WRITER_DISABLE_THROTTLING,
                MF_SOURCE_READER_FIRST_AUDIO_STREAM, MF_SOURCE_READER_FIRST_VIDEO_STREAM,
                MF_SOURCE_READERF_ENDOFSTREAM, MF_VERSION, MFAudioFormat_AAC, MFAudioFormat_PCM,
                MFCreateAttributes, MFCreateMediaType, MFCreateMemoryBuffer, MFCreateSample,
                MFCreateSinkWriterFromURL, MFCreateSourceReaderFromURL, MFMediaType_Audio,
                MFMediaType_Video, MFSTARTUP_FULL, MFShutdown, MFStartup, MFVideoFormat_H264,
                MFVideoFormat_RGB32, MFVideoInterlace_Progressive, eAVEncH264VProfile_Main,
            },
            Storage::FileSystem::{MOVEFILE_WRITE_THROUGH, MoveFileExW},
            System::Com::{COINIT_MULTITHREADED, CoInitializeEx, CoUninitialize},
        },
        core::{Error, PCWSTR},
    };

    use super::{
        MAX_SEQUENCE_FRAME_COUNT, MediaFoundationSampleTiming, NativeMp4VideoConfig,
        NativeMp4VideoInspection, PlatformError, PlatformResult,
    };

    pub(super) struct WriterState {
        sink_writer: IMFSinkWriter,
        video_stream_index: u32,
        audio_stream_index: Option<u32>,
        _runtime: MediaFoundationRuntime,
    }

    impl std::fmt::Debug for WriterState {
        fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            formatter
                .debug_struct("WriterState")
                .field("video_stream_index", &self.video_stream_index)
                .field("audio_stream_index", &self.audio_stream_index)
                .finish_non_exhaustive()
        }
    }

    impl WriterState {
        pub(super) fn create(
            temporary_path: &Path,
            config: NativeMp4VideoConfig,
            audio: Option<super::NativePcmWavInfo>,
        ) -> PlatformResult<Self> {
            let runtime = MediaFoundationRuntime::start()?;
            let wide_path = wide_path(temporary_path)?;
            let attributes = create_writer_attributes()?;
            // SAFETY: the path is NUL terminated and lives for the call. Null
            // byte-stream delegates file creation to the sink writer.
            let sink_writer = unsafe {
                MFCreateSinkWriterFromURL(PCWSTR(wide_path.as_ptr()), None, Some(&attributes))
            }
            .map_err(|error| mf_error("creating the MP4 sink writer", &error))?;

            let output_type = create_video_media_type(
                MFVideoFormat_H264,
                config,
                Some(config.target_bitrate_bps),
            )?;
            // SAFETY: the media type remains valid for the COM call.
            let video_stream_index = unsafe { sink_writer.AddStream(&output_type) }
                .map_err(|error| mf_error("adding the H.264 output stream", &error))?;

            let input_type = create_video_media_type(MFVideoFormat_RGB32, config, None)?;
            let stride = config.width.checked_mul(4).ok_or_else(|| {
                PlatformError::InvalidInput("RGB32 input stride overflowed".to_owned())
            })?;
            // SAFETY: attributes are set before writing begins.
            unsafe { input_type.SetUINT32(&MF_MT_DEFAULT_STRIDE, stride) }
                .map_err(|error| mf_error("setting the RGB32 input stride", &error))?;
            let encoding_parameters = create_encoding_parameters()?;
            // SAFETY: both media types and the writer are alive for the call.
            unsafe {
                sink_writer.SetInputMediaType(
                    video_stream_index,
                    &input_type,
                    Some(&encoding_parameters),
                )
            }
            .map_err(|error| mf_error("selecting the RGB32 input media type", &error))?;
            let audio_stream_index = audio
                .map(|info| configure_audio_stream(&sink_writer, info))
                .transpose()?;
            // SAFETY: the writer has one completely configured stream.
            unsafe { sink_writer.BeginWriting() }
                .map_err(|error| mf_error("beginning MP4 writing", &error))?;

            Ok(Self {
                sink_writer,
                video_stream_index,
                audio_stream_index,
                _runtime: runtime,
            })
        }

        pub(super) fn write_bgra_frame(
            &self,
            frame: &[u8],
            timing: MediaFoundationSampleTiming,
        ) -> PlatformResult<()> {
            let byte_length = u32::try_from(frame.len()).map_err(|_| {
                PlatformError::InvalidInput("BGRA frame exceeds Media Foundation limits".to_owned())
            })?;
            // SAFETY: requests an owned Media Foundation memory buffer.
            let buffer = unsafe { MFCreateMemoryBuffer(byte_length) }
                .map_err(|error| mf_error("allocating a video sample buffer", &error))?;
            copy_frame_to_buffer(&buffer, frame)?;
            // SAFETY: creates a fresh owned sample.
            let sample = unsafe { MFCreateSample() }
                .map_err(|error| mf_error("creating a video sample", &error))?;
            // SAFETY: buffer and sample remain valid through the write call.
            unsafe { sample.AddBuffer(&buffer) }
                .map_err(|error| mf_error("attaching the video sample buffer", &error))?;
            let presentation_time =
                i64::try_from(timing.presentation_time_100ns).map_err(|_| {
                    PlatformError::InvalidInput("video sample timestamp exceeds i64".to_owned())
                })?;
            let duration = i64::try_from(timing.duration_100ns).map_err(|_| {
                PlatformError::InvalidInput("video sample duration exceeds i64".to_owned())
            })?;
            // SAFETY: timing is validated by the public rational timing plan.
            unsafe { sample.SetSampleTime(presentation_time) }
                .map_err(|error| mf_error("assigning video sample time", &error))?;
            unsafe { sample.SetSampleDuration(duration) }
                .map_err(|error| mf_error("assigning video sample duration", &error))?;
            // SAFETY: the stream is configured and writing has begun.
            unsafe {
                self.sink_writer
                    .WriteSample(self.video_stream_index, &sample)
            }
            .map_err(|error| mf_error("encoding a video sample", &error))
        }

        pub(super) fn write_pcm_audio(
            &self,
            audio: &mut super::NativeMp4AudioSource,
            cancellation: &crate::ProcessCancellation,
        ) -> PlatformResult<()> {
            const PCM_CHUNK_SAMPLE_FRAMES: usize = 4_096;
            let stream_index = self.audio_stream_index.ok_or_else(|| {
                PlatformError::Windows("MP4 writer has no configured AAC stream".to_owned())
            })?;
            let block_alignment = usize::from(audio.wav.info.channel_count) * 2;
            let output_sample_frames = audio.timing.output_sample_frame_count;
            audio
                .wav
                .file
                .seek(SeekFrom::Start(audio.wav.data_offset))
                .map_err(|error| crate::io_error("seeking PCM WAV data", &audio.wav.path, error))?;

            let mut bytes = vec![0_u8; PCM_CHUNK_SAMPLE_FRAMES * block_alignment];
            let mut output_frame = 0_u64;
            while output_frame < output_sample_frames {
                if cancellation.is_cancelled() {
                    return Err(PlatformError::Cancelled { process_id: None });
                }
                let chunk_frames = (output_sample_frames - output_frame)
                    .min(u64::try_from(PCM_CHUNK_SAMPLE_FRAMES).expect("constant fits u64"));
                let chunk_bytes = usize::try_from(chunk_frames)
                    .ok()
                    .and_then(|frames| frames.checked_mul(block_alignment))
                    .ok_or_else(|| {
                        PlatformError::InvalidInput("PCM audio chunk length overflowed".to_owned())
                    })?;
                let source_remaining = audio
                    .wav
                    .info
                    .sample_frame_count
                    .saturating_sub(output_frame);
                let source_frames = chunk_frames.min(source_remaining);
                let source_bytes = usize::try_from(source_frames)
                    .ok()
                    .and_then(|frames| frames.checked_mul(block_alignment))
                    .ok_or_else(|| {
                        PlatformError::InvalidInput("PCM source chunk length overflowed".to_owned())
                    })?;
                audio
                    .wav
                    .file
                    .read_exact(&mut bytes[..source_bytes])
                    .map_err(|error| {
                        crate::io_error("reading PCM WAV data", &audio.wav.path, error)
                    })?;
                bytes[source_bytes..chunk_bytes].fill(0);
                let presentation_time =
                    super::sample_boundary_100ns(output_frame, audio.wav.info.sample_rate_hz)?;
                let next_time = super::sample_boundary_100ns(
                    output_frame + chunk_frames,
                    audio.wav.info.sample_rate_hz,
                )?;
                self.write_pcm_sample(
                    stream_index,
                    &bytes[..chunk_bytes],
                    presentation_time,
                    next_time - presentation_time,
                )?;
                output_frame += chunk_frames;
            }
            Ok(())
        }

        fn write_pcm_sample(
            &self,
            stream_index: u32,
            pcm: &[u8],
            presentation_time_100ns: u64,
            duration_100ns: u64,
        ) -> PlatformResult<()> {
            let byte_length = u32::try_from(pcm.len()).map_err(|_| {
                PlatformError::InvalidInput("PCM sample exceeds Media Foundation limits".to_owned())
            })?;
            // SAFETY: requests an owned Media Foundation memory buffer.
            let buffer = unsafe { MFCreateMemoryBuffer(byte_length) }
                .map_err(|error| mf_error("allocating an audio sample buffer", &error))?;
            copy_frame_to_buffer(&buffer, pcm)?;
            // SAFETY: creates a fresh owned sample.
            let sample = unsafe { MFCreateSample() }
                .map_err(|error| mf_error("creating an audio sample", &error))?;
            unsafe { sample.AddBuffer(&buffer) }
                .map_err(|error| mf_error("attaching the audio sample buffer", &error))?;
            let presentation_time = i64::try_from(presentation_time_100ns).map_err(|_| {
                PlatformError::InvalidInput("audio timestamp exceeds i64".to_owned())
            })?;
            let duration = i64::try_from(duration_100ns).map_err(|_| {
                PlatformError::InvalidInput("audio duration exceeds i64".to_owned())
            })?;
            unsafe { sample.SetSampleTime(presentation_time) }
                .map_err(|error| mf_error("assigning audio sample time", &error))?;
            unsafe { sample.SetSampleDuration(duration) }
                .map_err(|error| mf_error("assigning audio sample duration", &error))?;
            unsafe { self.sink_writer.WriteSample(stream_index, &sample) }
                .map_err(|error| mf_error("encoding an audio sample", &error))
        }

        pub(super) fn finalize(self) -> PlatformResult<()> {
            // SAFETY: finalizes the active sink writer exactly once. COM object
            // destruction and MF shutdown follow when this value is consumed.
            unsafe { self.sink_writer.Finalize() }
                .map_err(|error| mf_error("finalizing the MP4 sink writer", &error))
        }
    }

    struct MediaFoundationRuntime {
        com_uninitialize: bool,
    }

    impl MediaFoundationRuntime {
        fn start() -> PlatformResult<Self> {
            // SAFETY: initializes COM for the current synchronous worker thread.
            let result = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
            let com_uninitialize = if result.is_ok() {
                true
            } else if result == RPC_E_CHANGED_MODE {
                false
            } else {
                return Err(mf_error(
                    "initializing COM for Media Foundation",
                    &Error::from(result),
                ));
            };
            // SAFETY: starts Media Foundation for this process. The guard
            // balances a successful startup with shutdown.
            if let Err(error) = unsafe { MFStartup(MF_VERSION, MFSTARTUP_FULL) } {
                if com_uninitialize {
                    // SAFETY: balances this function's successful CoInitializeEx.
                    unsafe { CoUninitialize() };
                }
                return Err(mf_error("starting Media Foundation", &error));
            }
            Ok(Self { com_uninitialize })
        }
    }

    impl Drop for MediaFoundationRuntime {
        fn drop(&mut self) {
            // SAFETY: balances this guard's successful MFStartup.
            let _ = unsafe { MFShutdown() };
            if self.com_uninitialize {
                // SAFETY: balances this guard's successful CoInitializeEx.
                unsafe { CoUninitialize() };
            }
        }
    }

    fn create_writer_attributes()
    -> PlatformResult<windows::Win32::Media::MediaFoundation::IMFAttributes> {
        let mut attributes = None;
        // SAFETY: receives one owned attributes COM interface.
        unsafe { MFCreateAttributes(&raw mut attributes, 2) }
            .map_err(|error| mf_error("creating MP4 sink writer attributes", &error))?;
        let attributes = attributes.ok_or_else(|| {
            PlatformError::Windows("Media Foundation returned no sink writer attributes".to_owned())
        })?;
        // Hardware transforms are allowed, not required. This never claims that
        // the selected encoder is hardware-backed.
        unsafe { attributes.SetUINT32(&MF_READWRITE_ENABLE_HARDWARE_TRANSFORMS, 1) }
            .map_err(|error| mf_error("allowing hardware transforms", &error))?;
        unsafe { attributes.SetUINT32(&MF_SINK_WRITER_DISABLE_THROTTLING, 1) }
            .map_err(|error| mf_error("disabling sink writer throttling", &error))?;
        Ok(attributes)
    }

    fn create_encoding_parameters()
    -> PlatformResult<windows::Win32::Media::MediaFoundation::IMFAttributes> {
        let mut attributes = None;
        // SAFETY: receives one owned attributes COM interface.
        unsafe { MFCreateAttributes(&raw mut attributes, 1) }
            .map_err(|error| mf_error("creating H.264 encoding parameters", &error))?;
        let attributes = attributes.ok_or_else(|| {
            PlatformError::Windows(
                "Media Foundation returned no H.264 encoding parameters".to_owned(),
            )
        })?;
        // Prevent B-frame reordering so compressed MP4 PTS is deterministic
        // and monotonic for timeline validation and clip seeking.
        unsafe { attributes.SetUINT32(&CODECAPI_AVEncMPVDefaultBPictureCount, 0) }
            .map_err(|error| mf_error("disabling H.264 B frames", &error))?;
        Ok(attributes)
    }

    fn configure_audio_stream(
        sink_writer: &IMFSinkWriter,
        info: super::NativePcmWavInfo,
    ) -> PlatformResult<u32> {
        let output_type = create_audio_media_type(MFAudioFormat_AAC, info, true)?;
        // SAFETY: the media type remains alive for the COM call.
        let stream_index = unsafe { sink_writer.AddStream(&output_type) }
            .map_err(|error| mf_error("adding the AAC output stream", &error))?;
        let input_type = create_audio_media_type(MFAudioFormat_PCM, info, false)?;
        // SAFETY: input and writer remain alive for the synchronous call.
        unsafe { sink_writer.SetInputMediaType(stream_index, &input_type, None) }
            .map_err(|error| mf_error("selecting the PCM input media type", &error))?;
        Ok(stream_index)
    }

    fn create_audio_media_type(
        subtype: windows::core::GUID,
        info: super::NativePcmWavInfo,
        encoded: bool,
    ) -> PlatformResult<IMFMediaType> {
        // SAFETY: creates a fresh owned media type.
        let media_type = unsafe { MFCreateMediaType() }
            .map_err(|error| mf_error("creating an audio media type", &error))?;
        let block_alignment = u32::from(info.channel_count) * 2;
        let configure = || -> windows::core::Result<()> {
            // SAFETY: all attributes are set before offering the type.
            unsafe {
                media_type.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Audio)?;
                media_type.SetGUID(&MF_MT_SUBTYPE, &raw const subtype)?;
                media_type.SetUINT32(&MF_MT_AUDIO_BITS_PER_SAMPLE, 16)?;
                media_type.SetUINT32(&MF_MT_AUDIO_SAMPLES_PER_SECOND, info.sample_rate_hz)?;
                media_type.SetUINT32(&MF_MT_AUDIO_NUM_CHANNELS, u32::from(info.channel_count))?;
                if encoded {
                    // 160 kbit/s AAC-LC is supported for mono and stereo by the
                    // built-in Microsoft encoder at both accepted sample rates.
                    media_type.SetUINT32(&MF_MT_AUDIO_AVG_BYTES_PER_SECOND, 20_000)?;
                    media_type.SetUINT32(&MF_MT_AVG_BITRATE, 160_000)?;
                    media_type.SetUINT32(&MF_MT_AAC_PAYLOAD_TYPE, 0)?;
                    media_type.SetUINT32(&MF_MT_AUDIO_BLOCK_ALIGNMENT, 1)?;
                    media_type.SetUINT32(&MF_MT_ALL_SAMPLES_INDEPENDENT, 0)?;
                } else {
                    media_type.SetUINT32(&MF_MT_AUDIO_BLOCK_ALIGNMENT, block_alignment)?;
                    media_type.SetUINT32(
                        &MF_MT_AUDIO_AVG_BYTES_PER_SECOND,
                        info.sample_rate_hz * block_alignment,
                    )?;
                    media_type.SetUINT32(&MF_MT_FIXED_SIZE_SAMPLES, 1)?;
                    media_type.SetUINT32(&MF_MT_ALL_SAMPLES_INDEPENDENT, 1)?;
                }
            }
            Ok(())
        };
        configure().map_err(|error| mf_error("configuring an audio media type", &error))?;
        Ok(media_type)
    }

    fn create_video_media_type(
        subtype: windows::core::GUID,
        config: NativeMp4VideoConfig,
        target_bitrate_bps: Option<u32>,
    ) -> PlatformResult<IMFMediaType> {
        // SAFETY: creates a fresh owned media type.
        let media_type = unsafe { MFCreateMediaType() }
            .map_err(|error| mf_error("creating a video media type", &error))?;
        let frame_size = pack_ratio(config.width, config.height);
        let frame_rate = pack_ratio(config.frame_rate.numerator, config.frame_rate.denominator);
        let pixel_aspect = pack_ratio(1, 1);
        // SAFETY: all attributes are assigned before the type is offered to the
        // writer; ratio attributes use Media Foundation's packed UINT64 form.
        let configure = || -> windows::core::Result<()> {
            // SAFETY: all attributes are assigned before the type is offered to
            // the writer.
            unsafe {
                media_type.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video)?;
                media_type.SetGUID(&MF_MT_SUBTYPE, &raw const subtype)?;
                media_type.SetUINT64(&MF_MT_FRAME_SIZE, frame_size)?;
                media_type.SetUINT64(&MF_MT_FRAME_RATE, frame_rate)?;
                media_type.SetUINT32(
                    &MF_MT_INTERLACE_MODE,
                    MFVideoInterlace_Progressive.0.cast_unsigned(),
                )?;
                media_type.SetUINT64(&MF_MT_PIXEL_ASPECT_RATIO, pixel_aspect)?;
                if let Some(target_bitrate_bps) = target_bitrate_bps {
                    media_type.SetUINT32(&MF_MT_AVG_BITRATE, target_bitrate_bps)?;
                    media_type.SetUINT32(
                        &MF_MT_MPEG2_PROFILE,
                        eAVEncH264VProfile_Main.0.cast_unsigned(),
                    )?;
                }
            }
            Ok(())
        };
        configure().map_err(|error| mf_error("configuring a video media type", &error))?;
        Ok(media_type)
    }

    fn copy_frame_to_buffer(buffer: &IMFMediaBuffer, frame: &[u8]) -> PlatformResult<()> {
        let mut destination = ptr::null_mut();
        let mut maximum_length = 0;
        // SAFETY: output pointers are valid; successful Lock is balanced below.
        unsafe { buffer.Lock(&raw mut destination, Some(&raw mut maximum_length), None) }
            .map_err(|error| mf_error("locking a video sample buffer", &error))?;
        let copy_result = if destination.is_null()
            || usize::try_from(maximum_length).unwrap_or(0) < frame.len()
        {
            Err(PlatformError::Windows(
                "Media Foundation returned an undersized video sample buffer".to_owned(),
            ))
        } else {
            // SAFETY: Lock guarantees at least maximum_length writable bytes,
            // checked above to cover the exact source slice.
            unsafe { ptr::copy_nonoverlapping(frame.as_ptr(), destination, frame.len()) };
            Ok(())
        };
        // SAFETY: balances the successful Lock regardless of copy outcome.
        let unlock_result = unsafe { buffer.Unlock() }
            .map_err(|error| mf_error("unlocking a video sample buffer", &error));
        copy_result?;
        unlock_result?;
        // SAFETY: the copied bytes exactly match the sample payload.
        unsafe {
            buffer.SetCurrentLength(u32::try_from(frame.len()).expect("validated frame size"))
        }
        .map_err(|error| mf_error("setting video sample buffer length", &error))
    }

    pub(super) fn publish_new(source: &Path, destination: &Path) -> PlatformResult<()> {
        if destination.exists() {
            return Err(PlatformError::RecoveryPending);
        }
        let source_wide = wide_path(source)?;
        let destination_wide = wide_path(destination)?;
        // SAFETY: both NUL-terminated buffers live for the call. Without
        // REPLACE_EXISTING this cannot overwrite a concurrent destination.
        unsafe {
            MoveFileExW(
                PCWSTR(source_wide.as_ptr()),
                PCWSTR(destination_wide.as_ptr()),
                MOVEFILE_WRITE_THROUGH,
            )
        }
        .map_err(|error| PlatformError::Windows(format!("atomically publishing MP4: {error}")))
    }

    pub(super) fn inspect(path: &Path) -> PlatformResult<NativeMp4VideoInspection> {
        let _runtime = MediaFoundationRuntime::start()?;
        let wide_path = source_reader_wide_path(path)?;
        // SAFETY: the NUL-terminated file path lives through the call.
        let reader = unsafe { MFCreateSourceReaderFromURL(PCWSTR(wide_path.as_ptr()), None) }
            .map_err(|error| mf_error("opening finalized MP4 with Source Reader", &error))?;
        let stream_index = MF_SOURCE_READER_FIRST_VIDEO_STREAM.0.cast_unsigned();
        // SAFETY: requests the first advertised native type for the video stream.
        let native_type = unsafe { reader.GetNativeMediaType(stream_index, 0) }
            .map_err(|error| mf_error("reading the finalized MP4 video type", &error))?;
        // SAFETY: reads a GUID-valued media-type attribute.
        let subtype = unsafe { native_type.GetGUID(&MF_MT_SUBTYPE) }
            .map_err(|error| mf_error("reading the finalized MP4 video subtype", &error))?;
        let (width, height) = unpack_ratio(
            unsafe { native_type.GetUINT64(&MF_MT_FRAME_SIZE) }
                .map_err(|error| mf_error("reading the finalized MP4 frame size", &error))?,
        );
        let (frame_rate_numerator, frame_rate_denominator) = unpack_ratio(
            unsafe { native_type.GetUINT64(&MF_MT_FRAME_RATE) }
                .map_err(|error| mf_error("reading the finalized MP4 frame rate", &error))?,
        );

        let mut sample_count = 0_u64;
        let mut first_presentation_time = None;
        let mut last_presentation_time = None;
        let mut video_duration = 0_i64;
        let mut timestamps_are_monotonic = true;
        loop {
            let mut stream_flags = 0_u32;
            let mut presentation_time = 0_i64;
            let mut sample = None;
            // SAFETY: all optional output pointers refer to initialized storage
            // that outlives the synchronous call.
            unsafe {
                reader.ReadSample(
                    stream_index,
                    0,
                    None,
                    Some(&raw mut stream_flags),
                    Some(&raw mut presentation_time),
                    Some(&raw mut sample),
                )
            }
            .map_err(|error| mf_error("reading a finalized MP4 video sample", &error))?;
            if let Some(sample) = sample {
                let sample_time = unsafe { sample.GetSampleTime() }.unwrap_or(presentation_time);
                let sample_duration = unsafe { sample.GetSampleDuration() }
                    .map_err(|error| mf_error("reading finalized MP4 sample duration", &error))?;
                let sample_end = sample_time.checked_add(sample_duration).ok_or_else(|| {
                    PlatformError::Windows("finalized MP4 sample timing overflowed".to_owned())
                })?;
                video_duration = video_duration.max(sample_end);
                if let Some(previous) = last_presentation_time {
                    timestamps_are_monotonic &= sample_time >= previous;
                } else {
                    first_presentation_time = Some(sample_time);
                }
                last_presentation_time = Some(sample_time);
                sample_count = sample_count.checked_add(1).ok_or_else(|| {
                    PlatformError::Windows("finalized MP4 sample count overflowed".to_owned())
                })?;
                if sample_count > MAX_SEQUENCE_FRAME_COUNT {
                    return Err(PlatformError::InvalidInput(format!(
                        "finalized MP4 exceeds the {MAX_SEQUENCE_FRAME_COUNT}-sample validation limit"
                    )));
                }
            }
            if stream_flags & MF_SOURCE_READERF_ENDOFSTREAM.0.cast_unsigned() != 0 {
                break;
            }
        }
        let first_presentation_time_100ns = first_presentation_time.ok_or_else(|| {
            PlatformError::Windows("finalized MP4 contains no video samples".to_owned())
        })?;
        let audio_evidence = inspect_audio_stream(&reader)?;
        Ok(NativeMp4VideoInspection {
            video_subtype_is_h264: subtype == MFVideoFormat_H264,
            audio_stream_is_aac: audio_evidence
                .as_ref()
                .is_some_and(|evidence| evidence.subtype_is_aac),
            width,
            height,
            frame_rate: super::RationalFrameRate {
                numerator: frame_rate_numerator,
                denominator: frame_rate_denominator,
            },
            sample_count,
            audio_sample_count: audio_evidence
                .as_ref()
                .map_or(0, |evidence| evidence.sample_count),
            first_presentation_time_100ns,
            last_presentation_time_100ns: last_presentation_time
                .expect("first timestamp implies last timestamp"),
            video_duration_100ns: video_duration,
            audio_duration_100ns: audio_evidence
                .as_ref()
                .map_or(0, |evidence| evidence.duration_100ns),
            timestamps_are_monotonic,
            audio_timestamps_are_monotonic: audio_evidence
                .is_none_or(|evidence| evidence.timestamps_are_monotonic),
        })
    }

    #[derive(Debug, Clone, Copy)]
    struct AudioInspection {
        subtype_is_aac: bool,
        sample_count: u64,
        duration_100ns: i64,
        timestamps_are_monotonic: bool,
    }

    fn inspect_audio_stream(
        reader: &windows::Win32::Media::MediaFoundation::IMFSourceReader,
    ) -> PlatformResult<Option<AudioInspection>> {
        let stream_index = MF_SOURCE_READER_FIRST_AUDIO_STREAM.0.cast_unsigned();
        let native_type = match unsafe { reader.GetNativeMediaType(stream_index, 0) } {
            Ok(media_type) => media_type,
            Err(error) if error.code() == MF_E_INVALIDSTREAMNUMBER => return Ok(None),
            Err(error) => {
                return Err(mf_error("reading the finalized MP4 audio type", &error));
            }
        };
        let subtype = unsafe { native_type.GetGUID(&MF_MT_SUBTYPE) }
            .map_err(|error| mf_error("reading the finalized MP4 audio subtype", &error))?;
        let mut sample_count = 0_u64;
        let mut last_time = None;
        let mut duration = 0_i64;
        let mut timestamps_are_monotonic = true;
        loop {
            let mut stream_flags = 0_u32;
            let mut presentation_time = 0_i64;
            let mut sample = None;
            unsafe {
                reader.ReadSample(
                    stream_index,
                    0,
                    None,
                    Some(&raw mut stream_flags),
                    Some(&raw mut presentation_time),
                    Some(&raw mut sample),
                )
            }
            .map_err(|error| mf_error("reading a finalized MP4 audio sample", &error))?;
            if let Some(sample) = sample {
                let sample_time = unsafe { sample.GetSampleTime() }.unwrap_or(presentation_time);
                let sample_duration = unsafe { sample.GetSampleDuration() }
                    .map_err(|error| mf_error("reading finalized AAC sample duration", &error))?;
                if let Some(previous) = last_time {
                    timestamps_are_monotonic &= sample_time >= previous;
                }
                last_time = Some(sample_time);
                duration =
                    duration.max(sample_time.checked_add(sample_duration).ok_or_else(|| {
                        PlatformError::Windows("finalized AAC sample timing overflowed".to_owned())
                    })?);
                sample_count = sample_count.checked_add(1).ok_or_else(|| {
                    PlatformError::Windows("finalized AAC sample count overflowed".to_owned())
                })?;
                if sample_count > MAX_SEQUENCE_FRAME_COUNT {
                    return Err(PlatformError::InvalidInput(format!(
                        "finalized AAC exceeds the {MAX_SEQUENCE_FRAME_COUNT}-sample validation limit"
                    )));
                }
            }
            if stream_flags & MF_SOURCE_READERF_ENDOFSTREAM.0.cast_unsigned() != 0 {
                break;
            }
        }
        if sample_count == 0 {
            return Err(PlatformError::Windows(
                "finalized MP4 advertises AAC but contains no audio samples".to_owned(),
            ));
        }
        Ok(Some(AudioInspection {
            subtype_is_aac: subtype == MFAudioFormat_AAC,
            sample_count,
            duration_100ns: duration,
            timestamps_are_monotonic,
        }))
    }

    fn wide_path(path: &Path) -> PlatformResult<Vec<u16>> {
        let wide: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
        if wide.len() > 32_768 || wide[..wide.len().saturating_sub(1)].contains(&0) {
            return Err(PlatformError::InvalidInput(
                "native MP4 path is too long or contains NUL".to_owned(),
            ));
        }
        Ok(wide)
    }

    pub(super) fn source_reader_wide_path(path: &Path) -> PlatformResult<Vec<u16>> {
        use std::path::{Component, Prefix};

        let mut components = path.components();
        let source_path = match components.next() {
            Some(Component::Prefix(prefix)) => match prefix.kind() {
                Prefix::VerbatimDisk(drive) => {
                    let drive = char::from(drive);
                    if !drive.is_ascii_alphabetic() {
                        return Err(PlatformError::InvalidInput(
                            "native MP4 source has an invalid verbatim drive prefix".to_owned(),
                        ));
                    }
                    let mut local =
                        std::path::PathBuf::from(format!("{}:\\", drive.to_ascii_uppercase()));
                    for component in components {
                        match component {
                            Component::RootDir | Component::CurDir => {}
                            Component::Normal(part) => local.push(part),
                            Component::ParentDir | Component::Prefix(_) => {
                                return Err(PlatformError::InvalidInput(
                                    "native MP4 source contains an unsafe verbatim path component"
                                        .to_owned(),
                                ));
                            }
                        }
                    }
                    local
                }
                Prefix::Disk(_) => path.to_path_buf(),
                Prefix::VerbatimUNC(..) | Prefix::UNC(..) => {
                    return Err(PlatformError::InvalidInput(
                        "native MP4 Source Reader does not accept network output paths".to_owned(),
                    ));
                }
                Prefix::Verbatim(_) | Prefix::DeviceNS(_) => {
                    return Err(PlatformError::InvalidInput(
                        "native MP4 Source Reader requires a local drive path".to_owned(),
                    ));
                }
            },
            _ => {
                return Err(PlatformError::InvalidInput(
                    "native MP4 Source Reader requires an absolute local drive path".to_owned(),
                ));
            }
        };
        wide_path(&source_path)
    }

    const fn pack_ratio(numerator: u32, denominator: u32) -> u64 {
        (numerator as u64) << 32 | denominator as u64
    }

    const fn unpack_ratio(packed: u64) -> (u32, u32) {
        let bytes = packed.to_be_bytes();
        (
            u32::from_be_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]),
            u32::from_be_bytes([bytes[4], bytes[5], bytes[6], bytes[7]]),
        )
    }

    fn mf_error(operation: &str, error: &Error) -> PlatformError {
        PlatformError::Windows(format!(
            "{operation} failed (HRESULT {:#010x}): {error}",
            error.code().0.cast_unsigned()
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(windows)]
    #[test]
    fn source_reader_uses_a_local_drive_path_for_a_canonical_verbatim_file() {
        let wide = native_mp4_windows::source_reader_wide_path(Path::new(
            r"\\?\C:\Users\测试用户\AppData\Local\Temp\clip.partial.mp4",
        ))
        .expect("verbatim local path");
        let decoded = String::from_utf16(&wide[..wide.len() - 1]).expect("UTF-16 path");

        assert_eq!(
            decoded,
            r"C:\Users\测试用户\AppData\Local\Temp\clip.partial.mp4"
        );
    }

    #[test]
    fn integer_frame_rate_produces_drift_free_media_foundation_timestamps() {
        let plan = plan_hlae_sequence_timing(HlaeSequenceTimingRequest {
            frame_count: 120,
            frame_rate: RationalFrameRate {
                numerator: 60,
                denominator: 1,
            },
            audio: Some(HlaeSequenceAudioTiming {
                sample_rate_hz: 48_000,
                sample_frame_count: 96_000,
            }),
        })
        .expect("valid sequence timing");

        assert_eq!(plan.video_duration_100ns, 20_000_000);
        assert_eq!(plan.frame_timing(0).unwrap().presentation_time_100ns, 0);
        assert_eq!(
            plan.frame_timing(119).unwrap().presentation_time_100ns,
            19_833_333
        );
        assert_eq!(plan.frame_timing(119).unwrap().duration_100ns, 166_667);
        assert_eq!(
            plan.audio.unwrap().adjustment,
            HlaeAudioLengthAdjustment::Exact
        );
    }

    #[test]
    fn aac_read_back_tolerance_accepts_one_tail_access_unit_at_sixty_fps() {
        let frame_rate = RationalFrameRate {
            numerator: 60,
            denominator: 1,
        };
        let tolerance = audio_read_back_duration_tolerance_100ns(48_000, frame_rate, 723)
            .expect("valid AAC tolerance");
        let expected_duration = 167_666_667_u64;
        let observed_duration = 167_880_271_u64;

        assert_eq!(tolerance, 214_056);
        assert!(observed_duration.abs_diff(expected_duration) <= tolerance);
        assert!(
            expected_duration
                .saturating_add(tolerance)
                .saturating_add(1)
                .abs_diff(expected_duration)
                > tolerance
        );
    }

    #[test]
    fn aac_read_back_tolerance_keeps_one_video_frame_at_thirty_fps() {
        let tolerance = audio_read_back_duration_tolerance_100ns(
            48_000,
            RationalFrameRate {
                numerator: 30,
                denominator: 1,
            },
            20,
        )
        .expect("valid AAC tolerance");

        assert_eq!(tolerance, 333_333);
    }

    #[test]
    fn fractional_frame_rate_uses_rational_boundaries_and_pads_short_audio() {
        let plan = plan_hlae_sequence_timing(HlaeSequenceTimingRequest {
            frame_count: 300,
            frame_rate: RationalFrameRate {
                numerator: 30_000,
                denominator: 1_001,
            },
            audio: Some(HlaeSequenceAudioTiming {
                sample_rate_hz: 48_000,
                sample_frame_count: 480_000,
            }),
        })
        .expect("valid NTSC-rate sequence timing");

        assert_eq!(plan.video_duration_100ns, 100_100_000);
        let last = plan.frame_timing(299).unwrap();
        assert_eq!(last.presentation_time_100ns, 99_766_333);
        assert_eq!(last.duration_100ns, 333_667);
        assert_eq!(
            plan.audio.unwrap().adjustment,
            HlaeAudioLengthAdjustment::PadEnd {
                sample_frame_count: 480
            }
        );
    }

    #[test]
    fn overlong_audio_is_trimmed_only_at_the_sequence_end() {
        let plan = plan_hlae_sequence_timing(HlaeSequenceTimingRequest {
            frame_count: 120,
            frame_rate: RationalFrameRate {
                numerator: 60,
                denominator: 1,
            },
            audio: Some(HlaeSequenceAudioTiming {
                sample_rate_hz: 48_000,
                sample_frame_count: 96_010,
            }),
        })
        .expect("valid sequence timing");

        let audio = plan.audio.unwrap();
        assert_eq!(audio.output_sample_frame_count, 96_000);
        assert_eq!(
            audio.adjustment,
            HlaeAudioLengthAdjustment::TrimEnd {
                sample_frame_count: 10
            }
        );
        assert_eq!(
            serde_json::to_value(audio.adjustment).unwrap(),
            serde_json::json!({ "kind": "trimEnd", "sampleFrameCount": 10 })
        );
    }

    #[test]
    fn deserialized_timing_plan_cannot_bypass_frame_rate_validation() {
        let mut plan = plan_hlae_sequence_timing(HlaeSequenceTimingRequest {
            frame_count: 1,
            frame_rate: RationalFrameRate {
                numerator: 60,
                denominator: 1,
            },
            audio: None,
        })
        .unwrap();
        plan.frame_rate.numerator = 0;

        assert!(matches!(
            plan.frame_timing(0),
            Err(PlatformError::InvalidInput(_))
        ));
    }

    #[test]
    fn capability_probe_does_not_claim_an_unverified_mp4_encode() {
        let report = probe_hlae_sequence_encoder_capabilities();

        assert!(!report.end_to_end_mp4_encode_verified);
        assert_eq!(
            serde_json::to_value(&report).unwrap()["endToEndMp4EncodeVerified"],
            false
        );
    }

    #[test]
    fn sequence_encoder_json_has_one_current_shape_and_rejects_retired_fields() {
        let request = HlaeSequenceTimingRequest {
            frame_count: 60,
            frame_rate: RationalFrameRate {
                numerator: 60,
                denominator: 1,
            },
            audio: None,
        };
        let plan = plan_hlae_sequence_timing(request).expect("current timing plan");
        let config = NativeMp4VideoConfig {
            width: 320,
            height: 240,
            frame_count: 60,
            frame_rate: request.frame_rate,
            target_bitrate_bps: 500_000,
        };
        let report = probe_hlae_sequence_encoder_capabilities();

        assert_rejects_unknown_json(&request);
        assert_rejects_unknown_json(&plan);
        assert_rejects_unknown_json(&config);
        assert_rejects_unknown_json(&report);
    }

    fn assert_rejects_unknown_json<T>(value: &T)
    where
        T: serde::Serialize + serde::de::DeserializeOwned,
    {
        let current = serde_json::to_value(value).expect("current JSON");
        let mut invalid = current;
        invalid
            .as_object_mut()
            .expect("object")
            .insert("unexpected".to_owned(), serde_json::json!(true));
        assert!(serde_json::from_value::<T>(invalid).is_err());
    }

    #[test]
    fn native_mp4_writer_rejects_unbounded_media_before_creating_a_file() {
        let directory = tempfile::tempdir().unwrap();
        let output = directory.path().join("invalid.mp4");
        let error = NativeMp4VideoWriter::create(
            &output,
            NativeMp4VideoConfig {
                width: MAX_NATIVE_MP4_WIDTH + 2,
                height: 64,
                frame_count: 1,
                frame_rate: RationalFrameRate {
                    numerator: 30,
                    denominator: 1,
                },
                target_bitrate_bps: 500_000,
            },
        )
        .expect_err("oversized frame must be rejected");

        assert!(matches!(error, PlatformError::InvalidInput(_)));
        assert!(!output.exists());
        assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 0);
    }

    #[test]
    fn native_mp4_writer_rejects_an_explicit_partial_outside_the_output_parent() {
        let output_directory = tempfile::tempdir().unwrap();
        let partial_directory = tempfile::tempdir().unwrap();
        let output = output_directory.path().join("result.mp4");
        let partial = partial_directory.path().join("result.partial.mp4");

        let error = NativeMp4VideoWriter::create_at_temporary_path(
            &output,
            &partial,
            NativeMp4VideoConfig {
                width: 64,
                height: 64,
                frame_count: 1,
                frame_rate: RationalFrameRate {
                    numerator: 30,
                    denominator: 1,
                },
                target_bitrate_bps: 500_000,
            },
        )
        .expect_err("an explicit partial must share the output's canonical parent");

        assert!(matches!(error, PlatformError::InvalidInput(_)));
        assert!(!output.exists());
        assert!(!partial.exists());
    }

    #[test]
    fn native_mp4_audio_writer_applies_the_explicit_partial_path_contract() {
        let output_directory = tempfile::tempdir().unwrap();
        let partial_directory = tempfile::tempdir().unwrap();
        let output = output_directory.path().join("result.mp4");
        let partial = partial_directory.path().join("result.partial.mp4");
        let wav = output_directory.path().join("audio.wav");
        std::fs::write(&wav, pcm16_wav_bytes(48_000, 2, 1_600)).unwrap();

        let error = NativeMp4VideoWriter::create_with_pcm_wav_at_temporary_path(
            &output,
            &partial,
            NativeMp4VideoConfig {
                width: 64,
                height: 64,
                frame_count: 1,
                frame_rate: RationalFrameRate {
                    numerator: 30,
                    denominator: 1,
                },
                target_bitrate_bps: 500_000,
            },
            &wav,
        )
        .expect_err("audio encoding must use the same explicit partial path contract");

        assert!(matches!(error, PlatformError::InvalidInput(_)));
        assert!(!output.exists());
        assert!(!partial.exists());
    }

    #[test]
    fn native_mp4_writer_rejects_unsafe_explicit_partial_names() {
        let directory = tempfile::tempdir().unwrap();
        let output = directory.path().join("result.mp4");
        let config = valid_native_mp4_config();

        for partial in [
            PathBuf::from("relative.partial.mp4"),
            directory.path().join("result.temporary.mp4"),
        ] {
            let error = NativeMp4VideoWriter::create_at_temporary_path(&output, &partial, config)
                .expect_err(
                    "unsafe explicit partial paths must fail before Media Foundation starts",
                );
            assert!(matches!(error, PlatformError::InvalidInput(_)));
        }

        let identical = directory.path().join("result.partial.mp4");
        let error = NativeMp4VideoWriter::create_at_temporary_path(&identical, &identical, config)
            .expect_err("the final and partial paths must identify different files");
        assert!(matches!(error, PlatformError::InvalidInput(_)));

        let error = NativeMp4VideoWriter::create_at_temporary_path(
            Path::new("relative.mp4"),
            &directory.path().join("relative.partial.mp4"),
            config,
        )
        .expect_err("the final path must be absolute");
        assert!(matches!(error, PlatformError::InvalidInput(_)));
    }

    #[test]
    fn native_mp4_writer_preserves_an_existing_explicit_partial() {
        let directory = tempfile::tempdir().unwrap();
        let output = directory.path().join("result.mp4");
        let partial = directory.path().join("result.partial.mp4");
        std::fs::write(&partial, b"crash evidence").unwrap();

        let error = NativeMp4VideoWriter::create_at_temporary_path(
            &output,
            &partial,
            valid_native_mp4_config(),
        )
        .expect_err("an existing leased partial must not be truncated");

        assert!(matches!(error, PlatformError::RecoveryPending));
        assert_eq!(std::fs::read(&partial).unwrap(), b"crash evidence");
        assert!(!output.exists());
    }

    #[test]
    fn native_mp4_writer_treats_a_missing_parent_as_invalid_input() {
        let directory = tempfile::tempdir().unwrap();
        let missing_parent = directory.path().join("missing");
        let error = NativeMp4VideoWriter::create_at_temporary_path(
            &missing_parent.join("result.mp4"),
            &missing_parent.join("result.partial.mp4"),
            valid_native_mp4_config(),
        )
        .expect_err("both native MP4 parents must already exist");

        assert!(matches!(error, PlatformError::InvalidInput(_)));
        assert!(!missing_parent.exists());
    }

    #[cfg(windows)]
    #[test]
    fn native_mp4_writer_rejects_an_explicit_partial_under_a_junction_parent() {
        let directory = tempfile::tempdir().unwrap();
        let external = tempfile::tempdir().unwrap();
        let junction = directory.path().join("recordings-link");
        let status = std::process::Command::new("cmd")
            .args([
                "/d",
                "/c",
                "mklink",
                "/J",
                &junction.to_string_lossy(),
                &external.path().to_string_lossy(),
            ])
            .status()
            .expect("invoke mklink");
        if !status.success() {
            return;
        }

        let output = junction.join("result.mp4");
        let partial = junction.join("result.partial.mp4");
        let error = NativeMp4VideoWriter::create_at_temporary_path(
            &output,
            &partial,
            valid_native_mp4_config(),
        )
        .expect_err("a reparse-point parent must fail closed");

        assert!(matches!(error, PlatformError::InvalidInput(_)));
        assert_eq!(std::fs::read_dir(external.path()).unwrap().count(), 0);
    }

    #[test]
    fn native_mp4_writer_never_overwrites_an_existing_destination() {
        let directory = tempfile::tempdir().unwrap();
        let output = directory.path().join("existing.mp4");
        std::fs::write(&output, b"keep me").unwrap();
        let error = NativeMp4VideoWriter::create(
            &output,
            NativeMp4VideoConfig {
                width: 64,
                height: 64,
                frame_count: 1,
                frame_rate: RationalFrameRate {
                    numerator: 30,
                    denominator: 1,
                },
                target_bitrate_bps: 500_000,
            },
        )
        .expect_err("existing output must be preserved");

        assert!(matches!(error, PlatformError::RecoveryPending));
        assert_eq!(std::fs::read(&output).unwrap(), b"keep me");
        assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 1);
    }

    fn valid_native_mp4_config() -> NativeMp4VideoConfig {
        NativeMp4VideoConfig {
            width: 64,
            height: 64,
            frame_count: 1,
            frame_rate: RationalFrameRate {
                numerator: 30,
                denominator: 1,
            },
            target_bitrate_bps: 500_000,
        }
    }

    #[test]
    fn native_pcm_wav_inspection_accepts_bounded_stereo_pcm16() {
        let directory = tempfile::tempdir().unwrap();
        let wav = directory.path().join("movie.wav");
        std::fs::write(&wav, pcm16_wav_bytes(48_000, 2, 4_800)).unwrap();

        let info = inspect_native_pcm_wav(&wav).expect("valid HLAE-style PCM WAV");

        assert_eq!(info.sample_rate_hz, 48_000);
        assert_eq!(info.channel_count, 2);
        assert_eq!(info.bits_per_sample, 16);
        assert_eq!(info.sample_frame_count, 4_800);
        assert_eq!(info.data_bytes, 19_200);
    }

    #[test]
    fn native_pcm_wav_inspection_rejects_truncated_and_inconsistent_chunks() {
        let directory = tempfile::tempdir().unwrap();
        let truncated = directory.path().join("truncated.wav");
        let mut bytes = pcm16_wav_bytes(48_000, 2, 100);
        bytes.truncate(bytes.len() - 1);
        std::fs::write(&truncated, &bytes).unwrap();
        let error = inspect_native_pcm_wav(&truncated).unwrap_err();
        assert!(matches!(error, PlatformError::InvalidInput(_)));

        let inconsistent = directory.path().join("inconsistent.wav");
        let mut bytes = pcm16_wav_bytes(48_000, 2, 100);
        bytes[28..32].copy_from_slice(&1_u32.to_le_bytes());
        std::fs::write(&inconsistent, &bytes).unwrap();
        let error = inspect_native_pcm_wav(&inconsistent).unwrap_err();
        assert!(matches!(error, PlatformError::InvalidInput(_)));
    }

    #[test]
    fn native_pcm_wav_inspection_rejects_unsupported_format_before_encoding() {
        let directory = tempfile::tempdir().unwrap();
        let wav = directory.path().join("unsupported.wav");
        let bytes = pcm16_wav_bytes(32_000, 2, 100);
        std::fs::write(&wav, &bytes).unwrap();

        let error = inspect_native_pcm_wav(&wav).unwrap_err();

        assert!(matches!(error, PlatformError::InvalidInput(_)));
    }

    fn pcm16_wav_bytes(sample_rate_hz: u32, channel_count: u16, frames: u32) -> Vec<u8> {
        let block_alignment = channel_count * 2;
        let data_bytes = frames * u32::from(block_alignment);
        let riff_size = 4 + 8 + 16 + 8 + data_bytes;
        let mut wav = Vec::with_capacity(usize::try_from(riff_size + 8).unwrap());
        wav.extend_from_slice(b"RIFF");
        wav.extend_from_slice(&riff_size.to_le_bytes());
        wav.extend_from_slice(b"WAVEfmt ");
        wav.extend_from_slice(&16_u32.to_le_bytes());
        wav.extend_from_slice(&1_u16.to_le_bytes());
        wav.extend_from_slice(&channel_count.to_le_bytes());
        wav.extend_from_slice(&sample_rate_hz.to_le_bytes());
        wav.extend_from_slice(&(sample_rate_hz * u32::from(block_alignment)).to_le_bytes());
        wav.extend_from_slice(&block_alignment.to_le_bytes());
        wav.extend_from_slice(&16_u16.to_le_bytes());
        wav.extend_from_slice(b"data");
        wav.extend_from_slice(&data_bytes.to_le_bytes());
        wav.resize(usize::try_from(riff_size + 8).unwrap(), 0);
        wav
    }

    #[cfg(windows)]
    #[test]
    fn windows_capability_probe_reports_media_foundation_runtime_evidence() {
        let report = probe_hlae_sequence_encoder_capabilities();

        assert_ne!(report.status, HlaeSequenceEncoderProbeStatus::Unsupported);
        if report.status == HlaeSequenceEncoderProbeStatus::EncoderCandidatesRegistered {
            assert!(report.media_foundation_started);
            assert!(report.registered_h264_encoder_count > 0);
            assert!(
                report.registered_hardware_h264_encoder_count
                    <= report.registered_h264_encoder_count
            );
        }
    }

    #[cfg(windows)]
    #[test]
    #[ignore = "writes a real H.264 MP4 under target/ignored and requires Windows Media Foundation codecs"]
    fn native_sink_writer_publishes_a_readable_h264_mp4() {
        let output_directory = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("..")
            .join("target")
            .join("ignored");
        std::fs::create_dir_all(&output_directory).expect("create ignored output directory");
        let output = output_directory.join(format!("mf-h264-smoke-{}.mp4", uuid::Uuid::new_v4()));
        let config = NativeMp4VideoConfig {
            width: 64,
            height: 64,
            frame_count: 12,
            frame_rate: RationalFrameRate {
                numerator: 30,
                denominator: 1,
            },
            target_bitrate_bps: 500_000,
        };
        let cancellation = crate::ProcessCancellation::default();
        let mut writer = NativeMp4VideoWriter::create(&output, config)
            .expect("create Media Foundation MP4 writer");
        for frame_index in 0..config.frame_count {
            let frame = synthetic_bgra_frame(config.width, config.height, frame_index);
            let timing = writer
                .write_bgra_frame(&frame, &cancellation)
                .expect("write BGRA frame");
            assert_eq!(timing.sample_index, frame_index);
        }
        let summary = writer.finish(&cancellation).expect("publish MP4");

        assert_eq!(summary.frame_count, config.frame_count);
        assert_eq!(summary.video_duration_100ns, 4_000_000);
        assert!(!summary.audio_stream_included);
        assert!(summary.output_bytes > 1_024);
        assert!(output.is_file());

        let evidence = inspect_native_h264_mp4(&output)
            .expect("Media Foundation Source Reader accepts encoded MP4");
        assert!(evidence.video_subtype_is_h264);
        assert_eq!(
            (evidence.width, evidence.height),
            (config.width, config.height)
        );
        assert_eq!(evidence.frame_rate, config.frame_rate);
        assert_eq!(evidence.sample_count, config.frame_count);
        assert!(evidence.timestamps_are_monotonic);
        assert!(evidence.video_duration_100ns.abs_diff(4_000_000) <= 1);
    }

    #[cfg(windows)]
    #[test]
    #[ignore = "writes a real fractional-rate H.264 MP4 under target/ignored"]
    fn native_sink_writer_preserves_fractional_frame_rate_and_duration() {
        let output_directory = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("..")
            .join("target")
            .join("ignored");
        std::fs::create_dir_all(&output_directory).unwrap();
        let output = output_directory.join(format!(
            "mf-h264-fractional-smoke-{}.mp4",
            uuid::Uuid::new_v4()
        ));
        let config = NativeMp4VideoConfig {
            width: 64,
            height: 64,
            frame_count: 30,
            frame_rate: RationalFrameRate {
                numerator: 30_000,
                denominator: 1_001,
            },
            target_bitrate_bps: 500_000,
        };
        let cancellation = crate::ProcessCancellation::default();
        let mut writer = NativeMp4VideoWriter::create(&output, config).unwrap();
        for frame_index in 0..config.frame_count {
            writer
                .write_bgra_frame(
                    &synthetic_bgra_frame(config.width, config.height, frame_index),
                    &cancellation,
                )
                .unwrap();
        }
        let summary = writer.finish(&cancellation).unwrap();
        let inspection = inspect_native_h264_mp4(&output).unwrap();

        assert_eq!(summary.video_duration_100ns, 10_010_000);
        assert_eq!(inspection.frame_rate, config.frame_rate);
        assert_eq!(inspection.sample_count, config.frame_count);
        assert!(inspection.timestamps_are_monotonic);
        assert!(
            inspection.video_duration_100ns.abs_diff(10_010_000)
                <= i64::try_from(config.frame_count).unwrap().cast_unsigned()
        );
    }

    #[cfg(windows)]
    #[test]
    #[ignore = "writes and reads back a real H.264/AAC MP4 under target/ignored"]
    fn native_sink_writer_muxes_pcm_wav_as_aac_and_pads_the_tail() {
        let output_directory = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("..")
            .join("target")
            .join("ignored");
        std::fs::create_dir_all(&output_directory).unwrap();
        let id = uuid::Uuid::new_v4();
        let wav = output_directory.join(format!("mf-aac-source-{id}.wav"));
        let output = output_directory.join(format!("mf-h264-aac-smoke-{id}.mp4"));
        // 200 sample frames short of the 19,200 frames required by 12/30s.
        std::fs::write(&wav, pcm16_wav_bytes(48_000, 2, 19_000)).unwrap();
        let config = NativeMp4VideoConfig {
            width: 64,
            height: 64,
            frame_count: 12,
            frame_rate: RationalFrameRate {
                numerator: 30,
                denominator: 1,
            },
            target_bitrate_bps: 500_000,
        };
        let cancellation = crate::ProcessCancellation::default();
        let mut writer = NativeMp4VideoWriter::create_with_pcm_wav(&output, config, &wav).unwrap();
        for frame_index in 0..config.frame_count {
            writer
                .write_bgra_frame(
                    &synthetic_bgra_frame(config.width, config.height, frame_index),
                    &cancellation,
                )
                .unwrap();
        }
        let summary = writer.finish(&cancellation).unwrap();
        let inspection = inspect_native_h264_mp4(&output).unwrap();

        assert!(summary.audio_stream_included);
        assert!(inspection.video_subtype_is_h264);
        assert!(inspection.audio_stream_is_aac);
        assert_eq!(inspection.sample_count, 12);
        assert!(inspection.audio_sample_count > 0);
        assert!(inspection.timestamps_are_monotonic);
        assert!(inspection.audio_timestamps_are_monotonic);
        let one_video_frame = 333_333_i64;
        assert!(
            inspection
                .audio_duration_100ns
                .abs_diff(inspection.video_duration_100ns)
                <= one_video_frame.cast_unsigned()
        );
    }

    #[cfg(windows)]
    #[test]
    #[ignore = "writes and reads back a real trimmed H.264/AAC MP4 under target/ignored"]
    fn native_sink_writer_trims_pcm_wav_at_the_video_boundary() {
        let output_directory = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("..")
            .join("target")
            .join("ignored");
        std::fs::create_dir_all(&output_directory).unwrap();
        let id = uuid::Uuid::new_v4();
        let wav = output_directory.join(format!("mf-aac-trim-source-{id}.wav"));
        let output = output_directory.join(format!("mf-h264-aac-trim-smoke-{id}.mp4"));
        // 4,800 sample frames longer than the 19,200-frame video timeline.
        std::fs::write(&wav, pcm16_wav_bytes(48_000, 2, 24_000)).unwrap();
        let config = NativeMp4VideoConfig {
            width: 64,
            height: 64,
            frame_count: 12,
            frame_rate: RationalFrameRate {
                numerator: 30,
                denominator: 1,
            },
            target_bitrate_bps: 500_000,
        };
        let cancellation = crate::ProcessCancellation::default();
        let mut writer = NativeMp4VideoWriter::create_with_pcm_wav(&output, config, &wav).unwrap();
        assert_eq!(
            writer.audio.as_ref().unwrap().timing.adjustment,
            HlaeAudioLengthAdjustment::TrimEnd {
                sample_frame_count: 4_800
            }
        );
        for frame_index in 0..config.frame_count {
            writer
                .write_bgra_frame(
                    &synthetic_bgra_frame(config.width, config.height, frame_index),
                    &cancellation,
                )
                .unwrap();
        }
        let summary = writer.finish(&cancellation).unwrap();
        let inspection = inspect_native_h264_mp4(&output).unwrap();

        assert!(summary.audio_stream_included);
        assert!(inspection.audio_stream_is_aac);
        assert!(inspection.audio_timestamps_are_monotonic);
        assert!(
            inspection
                .audio_duration_100ns
                .abs_diff(inspection.video_duration_100ns)
                <= 333_333
        );
    }

    #[cfg(windows)]
    #[test]
    #[ignore = "writes and reads back a real 44.1-kHz mono H.264/AAC MP4"]
    fn native_sink_writer_muxes_44100_hz_mono_pcm_as_aac() {
        let output_directory = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("..")
            .join("target")
            .join("ignored");
        std::fs::create_dir_all(&output_directory).unwrap();
        let id = uuid::Uuid::new_v4();
        let wav = output_directory.join(format!("mf-aac-44100-source-{id}.wav"));
        let output = output_directory.join(format!("mf-h264-aac-44100-smoke-{id}.mp4"));
        std::fs::write(&wav, pcm16_wav_bytes(44_100, 1, 8_820)).unwrap();
        let config = NativeMp4VideoConfig {
            width: 64,
            height: 64,
            frame_count: 6,
            frame_rate: RationalFrameRate {
                numerator: 30,
                denominator: 1,
            },
            target_bitrate_bps: 500_000,
        };
        let cancellation = crate::ProcessCancellation::default();
        let mut writer = NativeMp4VideoWriter::create_with_pcm_wav(&output, config, &wav).unwrap();
        for frame_index in 0..config.frame_count {
            writer
                .write_bgra_frame(
                    &synthetic_bgra_frame(config.width, config.height, frame_index),
                    &cancellation,
                )
                .unwrap();
        }
        assert!(writer.finish(&cancellation).unwrap().audio_stream_included);
        let inspection = inspect_native_h264_mp4(&output).unwrap();

        assert!(inspection.audio_stream_is_aac);
        assert!(inspection.audio_sample_count > 0);
        assert!(inspection.audio_timestamps_are_monotonic);
        assert!(
            inspection
                .audio_duration_100ns
                .abs_diff(inspection.video_duration_100ns)
                <= 333_333
        );
    }

    #[cfg(windows)]
    #[test]
    #[ignore = "opens a real Windows Media Foundation H.264 pipeline"]
    fn cancelled_native_sink_writer_removes_its_unpublished_partial_file() {
        let directory = tempfile::tempdir().unwrap();
        let output = directory.path().join("cancelled.mp4");
        let config = NativeMp4VideoConfig {
            width: 64,
            height: 64,
            frame_count: 2,
            frame_rate: RationalFrameRate {
                numerator: 30,
                denominator: 1,
            },
            target_bitrate_bps: 500_000,
        };
        let mut writer = NativeMp4VideoWriter::create(&output, config).unwrap();
        let partial = writer.temporary_path.clone();
        assert!(partial.is_file());
        let cancellation = crate::ProcessCancellation::default();
        cancellation.cancel();

        let error = writer
            .write_bgra_frame(
                &synthetic_bgra_frame(config.width, config.height, 0),
                &cancellation,
            )
            .expect_err("cancelled write must stop before accepting a frame");
        assert!(matches!(
            error,
            PlatformError::Cancelled { process_id: None }
        ));
        drop(writer);

        assert!(!partial.exists());
        assert!(!output.exists());
        assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 0);
    }

    #[cfg(windows)]
    fn synthetic_bgra_frame(width: u32, height: u32, frame_index: u64) -> Vec<u8> {
        let mut frame = vec![0_u8; (width * height * 4) as usize];
        let frame_modulo = u32::try_from(frame_index % 256).expect("modulo fits u32");
        for y in 0..height {
            for x in 0..width {
                let offset = ((y * width + x) * 4) as usize;
                frame[offset] = u8::try_from((x + frame_modulo * 3) % 256).expect("modulo fits u8");
                frame[offset + 1] =
                    u8::try_from((y * 4 + frame_modulo * 7) % 256).expect("modulo fits u8");
                frame[offset + 2] =
                    u8::try_from((x + y + frame_modulo * 11) % 256).expect("modulo fits u8");
                frame[offset + 3] = 255;
            }
        }
        frame
    }

    #[cfg(not(windows))]
    #[test]
    fn non_windows_capability_probe_is_explicitly_unsupported() {
        let report = probe_hlae_sequence_encoder_capabilities();

        assert_eq!(report.status, HlaeSequenceEncoderProbeStatus::Unsupported);
        assert!(!report.media_foundation_started);
        assert!(!report.end_to_end_mp4_encode_verified);
    }
}
