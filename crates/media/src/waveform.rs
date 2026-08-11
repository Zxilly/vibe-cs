use std::{ffi::OsString, path::Path};

use crate::{CommandSpec, MediaError, MediaResult, ProcessCancellation, ProcessRunner, io_error};

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

/// Decodes audio with `FFmpeg` and returns bounded peak-amplitude buckets.
///
/// # Errors
///
/// Returns an error for invalid options, missing media, cancellation, process
/// failure, or output exceeding the configured bound.
pub async fn generate_waveform(
    runner: &dyn ProcessRunner,
    ffmpeg: &Path,
    media: &Path,
    options: WaveformOptions,
    cancellation: &ProcessCancellation,
) -> MediaResult<Vec<f32>> {
    validate_options(options)?;
    if !media.is_file() {
        return Err(MediaError::InvalidInput(format!(
            "media file does not exist: {}",
            media.display()
        )));
    }
    let command = CommandSpec::new(ffmpeg).args([
        OsString::from("-hide_banner"),
        OsString::from("-nostdin"),
        OsString::from("-v"),
        OsString::from("error"),
        OsString::from("-i"),
        media.as_os_str().to_os_string(),
        OsString::from("-vn"),
        OsString::from("-ac"),
        OsString::from("1"),
        OsString::from("-ar"),
        OsString::from(options.sample_rate.to_string()),
        OsString::from("-f"),
        OsString::from("f32le"),
        OsString::from("pipe:1"),
    ]);
    let output = runner.run(&command, cancellation).await?.ensure_success()?;
    let maximum_input_bytes = usize::try_from(options.maximum_input_bytes).unwrap_or(usize::MAX);
    if output.stdout.len() > maximum_input_bytes {
        return Err(MediaError::OutputLimit {
            limit: maximum_input_bytes,
        });
    }
    let samples = output
        .stdout
        .chunks_exact(4)
        .filter_map(|bytes| <[u8; 4]>::try_from(bytes).ok())
        .map(f32::from_le_bytes)
        .filter(|sample| sample.is_finite())
        .collect::<Vec<_>>();
    Ok(bucket_samples(&samples, options.buckets))
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
}
