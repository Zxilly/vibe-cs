use std::path::Path;

use ffmpeg_next as ffmpeg;

use crate::{MediaError, MediaResult, ProcessCancellation, io_error};

#[derive(Debug, Clone, Copy)]
pub struct WaveformOptions {
    pub buckets: usize,
    pub maximum_input_bytes: u64,
    pub sample_rate: u32,
}

impl Default for WaveformOptions {
    fn default() -> Self {
        Self {
            buckets: 1_000,
            maximum_input_bytes: 256 * 1024 * 1024,
            sample_rate: 8_000,
        }
    }
}

/// Reads a bounded PCM16 or float32 WAV file and aggregates peak buckets.
///
/// # Errors
///
/// Returns an error for invalid options, oversized input, I/O failure, or an
/// unsupported/truncated WAV structure.
pub fn read_wav_waveform(path: &Path, options: WaveformOptions) -> MediaResult<Vec<f32>> {
    validate_options(options)?;
    let metadata = std::fs::metadata(path).map_err(|error| io_error(path, error))?;
    if metadata.len() > options.maximum_input_bytes {
        return Err(MediaError::InvalidInput(format!(
            "WAV exceeds {} bytes",
            options.maximum_input_bytes
        )));
    }
    let bytes = std::fs::read(path).map_err(|error| io_error(path, error))?;
    parse_wav(&bytes, options.buckets)
}

/// Decodes audio in-process with libavcodec/libswresample and returns bounded
/// peak-amplitude buckets.
///
/// # Errors
///
/// Returns an error for invalid options, missing audio, cancellation, decoder
/// failure, or decoded samples exceeding the configured memory bound.
pub fn generate_native_waveform(
    media: &Path,
    options: WaveformOptions,
    cancellation: &ProcessCancellation,
) -> MediaResult<Vec<f32>> {
    validate_options(options)?;
    crate::native_ffmpeg_info()?;
    if !media.is_file() {
        return Err(MediaError::InvalidInput(format!(
            "media file does not exist: {}",
            media.display()
        )));
    }
    let interrupt = cancellation.clone();
    let mut input = ffmpeg::format::input_with_interrupt(media, move || interrupt.is_cancelled())
        .map_err(native_error)?;
    let stream = input
        .streams()
        .best(ffmpeg::media::Type::Audio)
        .ok_or_else(|| MediaError::InvalidInput("media has no audio stream".to_owned()))?;
    let stream_index = stream.index();
    let context = ffmpeg::codec::context::Context::from_parameters(stream.parameters())
        .map_err(native_error)?;
    let mut decoder = context.decoder().audio().map_err(native_error)?;
    let sample_limit = usize::try_from(options.maximum_input_bytes / 4).unwrap_or(usize::MAX);
    let mut samples = Vec::new();
    for (packet_stream, packet) in input.packets() {
        if cancellation.is_cancelled() {
            return Err(MediaError::Cancelled);
        }
        if packet_stream.index() != stream_index {
            continue;
        }
        decoder.send_packet(&packet).map_err(native_error)?;
        drain_audio_frames(&mut decoder, &mut samples, sample_limit, cancellation)?;
    }
    decoder.send_eof().map_err(native_error)?;
    drain_audio_frames(&mut decoder, &mut samples, sample_limit, cancellation)?;
    Ok(bucket_samples(&samples, options.buckets))
}

fn drain_audio_frames(
    decoder: &mut ffmpeg::codec::decoder::Audio,
    samples: &mut Vec<f32>,
    sample_limit: usize,
    cancellation: &ProcessCancellation,
) -> MediaResult<()> {
    let mut decoded_frame = ffmpeg::frame::Audio::empty();
    while decoder.receive_frame(&mut decoded_frame).is_ok() {
        if cancellation.is_cancelled() {
            return Err(MediaError::Cancelled);
        }
        append_decoded_samples(&decoded_frame, samples, sample_limit)?;
    }
    Ok(())
}

fn append_decoded_samples(
    decoded: &ffmpeg::frame::Audio,
    samples: &mut Vec<f32>,
    sample_limit: usize,
) -> MediaResult<()> {
    if decoded.samples() == 0 {
        return Ok(());
    }
    let next_len = samples
        .len()
        .checked_add(decoded.samples())
        .ok_or(MediaError::OutputLimit {
            limit: sample_limit.saturating_mul(4),
        })?;
    if next_len > sample_limit {
        return Err(MediaError::OutputLimit {
            limit: sample_limit.saturating_mul(4),
        });
    }
    let channel_count = decoded.channels();
    let channels = usize::from(channel_count);
    if channels == 0 {
        return Err(MediaError::NativeFfmpeg(
            "decoded audio frame has no channels".to_owned(),
        ));
    }
    let format = decoded.format();
    let bytes_per_sample = format.bytes();
    if bytes_per_sample == 0 {
        return Err(MediaError::NativeFfmpeg(
            "decoded audio frame has an unsupported sample format".to_owned(),
        ));
    }
    if format.is_planar() {
        for index in 0..decoded.samples() {
            let peak = (0..channels)
                .map(|channel| decode_sample(format, decoded.data(channel), index))
                .collect::<MediaResult<Vec<_>>>()?
                .into_iter()
                .map(f32::abs)
                .sum::<f32>()
                / f32::from(channel_count);
            samples.push(peak.clamp(0.0, 1.0));
        }
    } else {
        let data = decoded.data(0);
        for index in 0..decoded.samples() {
            let peak = (0..channels)
                .map(|channel| {
                    decode_sample(
                        format,
                        data,
                        index.saturating_mul(channels).saturating_add(channel),
                    )
                })
                .collect::<MediaResult<Vec<_>>>()?
                .into_iter()
                .map(f32::abs)
                .sum::<f32>()
                / f32::from(channel_count);
            samples.push(peak.clamp(0.0, 1.0));
        }
    }
    Ok(())
}

#[allow(clippy::cast_possible_truncation, clippy::cast_precision_loss)]
fn decode_sample(format: ffmpeg::format::Sample, data: &[u8], index: usize) -> MediaResult<f32> {
    let width = format.bytes();
    let start = index
        .checked_mul(width)
        .ok_or_else(|| MediaError::NativeFfmpeg("audio sample offset overflow".to_owned()))?;
    let bytes = data
        .get(start..start.saturating_add(width))
        .ok_or_else(|| MediaError::NativeFfmpeg("truncated decoded audio frame".to_owned()))?;
    let value = match format {
        ffmpeg::format::Sample::U8(_) => (f32::from(bytes[0]) - 128.0) / 128.0,
        ffmpeg::format::Sample::I16(_) => {
            f32::from(i16::from_ne_bytes(
                bytes.try_into().expect("two-byte sample"),
            )) / f32::from(i16::MAX)
        }
        ffmpeg::format::Sample::I32(_) => {
            i32::from_ne_bytes(bytes.try_into().expect("four-byte sample")) as f32 / i32::MAX as f32
        }
        ffmpeg::format::Sample::I64(_) => {
            (i64::from_ne_bytes(bytes.try_into().expect("eight-byte sample")) as f64
                / i64::MAX as f64) as f32
        }
        ffmpeg::format::Sample::F32(_) => {
            f32::from_ne_bytes(bytes.try_into().expect("four-byte sample"))
        }
        ffmpeg::format::Sample::F64(_) => {
            f64::from_ne_bytes(bytes.try_into().expect("eight-byte sample")) as f32
        }
        ffmpeg::format::Sample::None => {
            return Err(MediaError::NativeFfmpeg(
                "decoded audio frame has no sample format".to_owned(),
            ));
        }
    };
    Ok(value)
}

fn native_error(error: ffmpeg::Error) -> MediaError {
    MediaError::NativeFfmpeg(error.to_string())
}

fn validate_options(options: WaveformOptions) -> MediaResult<()> {
    if options.buckets == 0
        || options.buckets > 100_000
        || options.sample_rate == 0
        || options.sample_rate > 192_000
    {
        Err(MediaError::InvalidInput(
            "invalid waveform options".to_owned(),
        ))
    } else {
        Ok(())
    }
}

fn parse_wav(bytes: &[u8], buckets: usize) -> MediaResult<Vec<f32>> {
    if bytes.len() < 12 || &bytes[..4] != b"RIFF" || &bytes[8..12] != b"WAVE" {
        return Err(MediaError::UnsupportedWave(
            "missing RIFF/WAVE header".to_owned(),
        ));
    }
    let mut offset = 12_usize;
    let mut format = None;
    let mut data = None;
    while offset.saturating_add(8) <= bytes.len() {
        let id = &bytes[offset..offset + 4];
        let size = u32::from_le_bytes(
            bytes[offset + 4..offset + 8]
                .try_into()
                .expect("four bytes"),
        ) as usize;
        let start = offset + 8;
        let end = start
            .checked_add(size)
            .ok_or_else(|| MediaError::UnsupportedWave("chunk size overflow".to_owned()))?;
        if end > bytes.len() {
            return Err(MediaError::UnsupportedWave("truncated chunk".to_owned()));
        }
        if id == b"fmt " && size >= 16 {
            format = Some((
                u16::from_le_bytes(bytes[start..start + 2].try_into().expect("two bytes")),
                u16::from_le_bytes(bytes[start + 2..start + 4].try_into().expect("two bytes")),
                u16::from_le_bytes(bytes[start + 14..start + 16].try_into().expect("two bytes")),
            ));
        } else if id == b"data" {
            data = Some(&bytes[start..end]);
        }
        offset = end.saturating_add(size & 1);
    }
    let (encoding, channels, bits) =
        format.ok_or_else(|| MediaError::UnsupportedWave("missing fmt chunk".to_owned()))?;
    if channels == 0 {
        return Err(MediaError::UnsupportedWave("zero channels".to_owned()));
    }
    let data = data.ok_or_else(|| MediaError::UnsupportedWave("missing data chunk".to_owned()))?;
    let samples = match (encoding, bits) {
        (1, 16) => data
            .chunks_exact(2)
            .map(|bytes| {
                f32::from(i16::from_le_bytes(bytes.try_into().expect("two bytes")))
                    / f32::from(i16::MAX)
            })
            .collect::<Vec<_>>(),
        (3, 32) => data
            .chunks_exact(4)
            .map(|bytes| f32::from_le_bytes(bytes.try_into().expect("four bytes")))
            .filter(|sample| sample.is_finite())
            .collect::<Vec<_>>(),
        _ => {
            return Err(MediaError::UnsupportedWave(format!(
                "format {encoding}, {bits} bit"
            )));
        }
    };
    let mono = samples
        .chunks(usize::from(channels))
        .map(|frame| frame.iter().map(|sample| sample.abs()).sum::<f32>() / f32::from(channels))
        .collect::<Vec<_>>();
    Ok(bucket_samples(&mono, buckets))
}

#[must_use]
pub fn bucket_samples(samples: &[f32], buckets: usize) -> Vec<f32> {
    if samples.is_empty() || buckets == 0 {
        return Vec::new();
    }
    let count = buckets.min(samples.len());
    (0..count)
        .map(|bucket| {
            let start = bucket * samples.len() / count;
            let end = ((bucket + 1) * samples.len() / count).max(start + 1);
            samples[start..end]
                .iter()
                .filter(|sample| sample.is_finite())
                .map(|sample| sample.abs())
                .fold(0.0_f32, f32::max)
                .clamp(0.0, 1.0)
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn buckets_use_peak_amplitude() {
        let points = bucket_samples(&[0.1, -0.8, 0.2, 0.4], 2);
        assert_eq!(points, [0.8, 0.4]);
    }

    #[test]
    fn reads_pcm16_wave() {
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
        let result = parse_wav(&wav, 2).unwrap();
        assert_eq!(result, [1.0, 0.0]);
    }

    #[test]
    fn native_waveform_decodes_without_a_helper_process() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("sample.wav");
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
        std::fs::write(&path, wav).unwrap();
        let points = generate_native_waveform(
            &path,
            WaveformOptions {
                buckets: 2,
                maximum_input_bytes: 1024,
                sample_rate: 8_000,
            },
            &ProcessCancellation::default(),
        )
        .unwrap();
        assert_eq!(points.len(), 2);
        assert!(points[0] > 0.9);
    }
}
