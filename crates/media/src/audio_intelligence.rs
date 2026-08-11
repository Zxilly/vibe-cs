#![allow(
    clippy::cast_possible_truncation,
    clippy::cast_precision_loss,
    clippy::cast_sign_loss
)]

use std::{cmp::Ordering, collections::HashSet, f32::consts::PI, path::Path};

use ffmpeg_next as ffmpeg;
use rustfft::{FftPlanner, num_complex::Complex32};
use vibe_cs_domain::{
    AudioAnalysis, AudioAnalysisOptions, AudioBeat, AudioEnergyPoint, AudioOnset, AudioSection,
    BeatAlignedClip, BeatAlignmentDraft, BeatAlignmentRequest,
};

use crate::{MediaError, MediaResult, ProcessCancellation};

const FRAME_SIZE: usize = 1_024;
const HOP_SIZE: usize = 256;
const MINIMUM_TEMPO_BPM: f64 = 60.0;
const MAXIMUM_TEMPO_BPM: f64 = 200.0;
const MAXIMUM_ANALYSIS_SAMPLES: usize = 24_000_000;
const MAXIMUM_ALIGNMENT_BEATS: usize = 8_192;
const MAXIMUM_ALIGNMENT_CLIPS: usize = 1_024;
const MAXIMUM_TIMELINE_SECONDS: f64 = 24.0 * 60.0 * 60.0;

/// Decodes an audio stream through linked libav libraries and performs bounded,
/// deterministic rhythm and energy analysis locally.
///
/// # Errors
///
/// Returns an error when options are invalid, the input has no decodable audio,
/// analysis limits are exceeded, or cancellation is requested.
pub fn analyze_native_audio(
    media: &Path,
    options: AudioAnalysisOptions,
    cancellation: &ProcessCancellation,
) -> MediaResult<AudioAnalysis> {
    validate_analysis_options(options)?;
    if cancellation.is_cancelled() {
        return Err(MediaError::Cancelled);
    }
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
    let declared_duration = input.duration();
    if declared_duration > 0 {
        let seconds = declared_duration as f64 / f64::from(ffmpeg::ffi::AV_TIME_BASE);
        if seconds > options.maximum_duration_seconds {
            return Err(MediaError::InvalidInput(format!(
                "audio duration {seconds:.1}s exceeds the {:.1}s analysis limit",
                options.maximum_duration_seconds
            )));
        }
    }
    let stream = input
        .streams()
        .best(ffmpeg::media::Type::Audio)
        .ok_or_else(|| MediaError::InvalidInput("media has no audio stream".to_owned()))?;
    let stream_index = stream.index();
    let context = ffmpeg::codec::context::Context::from_parameters(stream.parameters())
        .map_err(native_error)?;
    let mut decoder = context.decoder().audio().map_err(native_error)?;
    let input_rate = decoder.rate();
    if input_rate == 0 {
        return Err(MediaError::NativeFfmpeg(
            "decoded audio stream has no sample rate".to_owned(),
        ));
    }
    let analysis_rate = input_rate.min(options.sample_rate);
    let duration_sample_limit = duration_sample_limit(options, analysis_rate)?;
    let mut downsampler = Downsampler::new(input_rate, analysis_rate, duration_sample_limit);

    for (packet_stream, packet) in input.packets() {
        if cancellation.is_cancelled() {
            return Err(MediaError::Cancelled);
        }
        if packet_stream.index() != stream_index {
            continue;
        }
        decoder.send_packet(&packet).map_err(native_error)?;
        drain_audio_frames(&mut decoder, &mut downsampler, cancellation)?;
    }
    decoder.send_eof().map_err(native_error)?;
    drain_audio_frames(&mut decoder, &mut downsampler, cancellation)?;
    let samples = downsampler.finish()?;
    analyze_samples(&samples, analysis_rate, options, cancellation)
}

/// Produces a deterministic advisory timing draft. This function never writes
/// to an editor project or mutates source media.
///
/// # Errors
///
/// Returns an error for malformed beat grids, invalid clip constraints, or
/// request collections above their documented bounds.
pub fn plan_clip_alignment(request: &BeatAlignmentRequest) -> MediaResult<BeatAlignmentDraft> {
    validate_alignment_request(request)?;
    let beats = &request.beats;
    let options = request.options;
    let mut clips = Vec::with_capacity(request.clips.len());
    let mut unplaced = Vec::new();
    let mut cursor = options.timeline_start_seconds;

    for clip in &request.clips {
        let Some(start_position) = beats
            .iter()
            .position(|beat| beat.time_seconds + f64::EPSILON >= cursor)
        else {
            unplaced.push(clip.clip_id.clone());
            continue;
        };
        let source_duration = clip.source_duration_seconds;
        let default_minimum = source_duration * (1.0 - options.maximum_duration_change_ratio);
        let default_maximum = source_duration * (1.0 + options.maximum_duration_change_ratio);
        let minimum = clip.minimum_duration_seconds.unwrap_or(default_minimum);
        let maximum = clip.maximum_duration_seconds.unwrap_or(default_maximum);
        if !minimum.is_finite() || !maximum.is_finite() || minimum <= 0.0 || maximum < minimum {
            return Err(MediaError::InvalidInput(format!(
                "clip {} has invalid duration constraints",
                clip.clip_id
            )));
        }

        let start = beats[start_position].time_seconds;
        let preferred_span = clip.preferred_beats.map(usize::from);
        let target_duration = preferred_span
            .and_then(|span| beats.get(start_position.saturating_add(span)))
            .map_or(source_duration, |beat| beat.time_seconds - start);
        let candidate = beats
            .iter()
            .enumerate()
            .skip(start_position + 1)
            .take_while(|(_, beat)| beat.time_seconds - start <= maximum + f64::EPSILON)
            .filter(|(_, beat)| beat.time_seconds - start >= minimum - f64::EPSILON)
            .map(|(position, beat)| {
                let duration = beat.time_seconds - start;
                let duration_score = (duration - target_duration).abs() / source_duration;
                let preferred_score = preferred_span.map_or(0.0, |span| {
                    let actual = position - start_position;
                    actual.abs_diff(span) as f64 / f64::from(span.max(1) as u32)
                });
                let strength_bonus = if options.prefer_strong_boundaries {
                    f64::from(beat.strength) * 0.15
                } else {
                    0.0
                };
                let phrase_bonus = if (position - start_position)
                    .is_multiple_of(usize::from(options.beats_per_phrase))
                {
                    0.1
                } else {
                    0.0
                };
                (
                    position,
                    duration_score + preferred_score * 0.75 - strength_bonus - phrase_bonus,
                )
            })
            .min_by(|left, right| {
                left.1
                    .partial_cmp(&right.1)
                    .unwrap_or(Ordering::Equal)
                    .then_with(|| left.0.cmp(&right.0))
            });

        let Some((end_position, _)) = candidate else {
            unplaced.push(clip.clip_id.clone());
            continue;
        };
        let end = beats[end_position].time_seconds;
        let duration = end - start;
        let mut rationale = vec![format!(
            "Snapped to beat {} through beat {}.",
            beats[start_position].index, beats[end_position].index
        )];
        if let Some(preferred_beats) = clip.preferred_beats {
            rationale.push(format!(
                "Preferred a {preferred_beats}-beat span while respecting duration bounds."
            ));
        } else {
            rationale.push("Minimized the change from source duration.".to_owned());
        }
        if options.prefer_strong_boundaries {
            rationale
                .push("Favored stronger musical boundaries when scores were close.".to_owned());
        }
        clips.push(BeatAlignedClip {
            clip_id: clip.clip_id.clone(),
            timeline_start_seconds: start,
            timeline_end_seconds: end,
            planned_duration_seconds: duration,
            source_duration_seconds: source_duration,
            duration_change_ratio: (duration - source_duration) / source_duration,
            start_beat_index: beats[start_position].index,
            end_beat_index: beats[end_position].index,
            rationale,
        });
        cursor = end;
    }

    Ok(BeatAlignmentDraft {
        advisory_only: true,
        clips,
        unplaced_clip_ids: unplaced,
        constraints: vec![
            "The draft does not modify the editor project or source files.".to_owned(),
            format!(
                "Each duration stays within explicit clip bounds or ±{:.0}% of its source duration.",
                options.maximum_duration_change_ratio * 100.0
            ),
            "Clip order is preserved and cuts are selected from the supplied beat grid.".to_owned(),
        ],
    })
}

fn validate_analysis_options(options: AudioAnalysisOptions) -> MediaResult<()> {
    if !(4_000..=48_000).contains(&options.sample_rate)
        || !options.maximum_duration_seconds.is_finite()
        || !(1.0..=3_600.0).contains(&options.maximum_duration_seconds)
        || !(1..=8_192).contains(&options.maximum_beats)
        || !(1..=8_192).contains(&options.maximum_onsets)
        || !(16..=2_048).contains(&options.energy_points)
        || !(1..=64).contains(&options.maximum_sections)
    {
        return Err(MediaError::InvalidInput(
            "invalid or unbounded audio analysis options".to_owned(),
        ));
    }
    Ok(())
}

#[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
fn duration_sample_limit(options: AudioAnalysisOptions, sample_rate: u32) -> MediaResult<usize> {
    let requested = (options.maximum_duration_seconds * f64::from(sample_rate)).ceil() as usize;
    if requested > MAXIMUM_ANALYSIS_SAMPLES {
        return Err(MediaError::InvalidInput(format!(
            "analysis settings require {requested} samples; maximum is {MAXIMUM_ANALYSIS_SAMPLES}"
        )));
    }
    Ok(requested)
}

fn validate_alignment_request(request: &BeatAlignmentRequest) -> MediaResult<()> {
    let options = request.options;
    if request.beats.len() < 2
        || request.beats.len() > MAXIMUM_ALIGNMENT_BEATS
        || request.clips.is_empty()
        || request.clips.len() > MAXIMUM_ALIGNMENT_CLIPS
        || !options.timeline_start_seconds.is_finite()
        || !(0.0..=MAXIMUM_TIMELINE_SECONDS).contains(&options.timeline_start_seconds)
        || !options.maximum_duration_change_ratio.is_finite()
        || !(0.0..=0.9).contains(&options.maximum_duration_change_ratio)
        || !(1..=16).contains(&options.beats_per_phrase)
    {
        return Err(MediaError::InvalidInput(
            "invalid or unbounded beat alignment request".to_owned(),
        ));
    }
    let valid_beats = request.beats.iter().enumerate().all(|(position, beat)| {
        beat.time_seconds.is_finite()
            && beat.time_seconds >= 0.0
            && beat.time_seconds <= MAXIMUM_TIMELINE_SECONDS
            && beat.strength.is_finite()
            && (0.0..=1.0).contains(&beat.strength)
            && position
                .checked_sub(1)
                .is_none_or(|previous| request.beats[previous].time_seconds < beat.time_seconds)
    });
    let mut clip_ids = HashSet::with_capacity(request.clips.len());
    let valid_clips = request.clips.iter().all(|clip| {
        let valid_optional_duration = |duration: Option<f64>| {
            duration.is_none_or(|value| {
                value.is_finite() && (f64::EPSILON..=MAXIMUM_TIMELINE_SECONDS).contains(&value)
            })
        };
        !clip.clip_id.trim().is_empty()
            && clip.clip_id.len() <= 256
            && clip_ids.insert(clip.clip_id.as_str())
            && clip.source_duration_seconds.is_finite()
            && (f64::EPSILON..=MAXIMUM_TIMELINE_SECONDS).contains(&clip.source_duration_seconds)
            && valid_optional_duration(clip.minimum_duration_seconds)
            && valid_optional_duration(clip.maximum_duration_seconds)
            && clip
                .minimum_duration_seconds
                .zip(clip.maximum_duration_seconds)
                .is_none_or(|(minimum, maximum)| minimum <= maximum)
            && clip
                .preferred_beats
                .is_none_or(|beats| beats > 0 && beats <= 256)
    });
    if !valid_beats || !valid_clips {
        return Err(MediaError::InvalidInput(
            "beat grid or clip inputs are malformed".to_owned(),
        ));
    }
    Ok(())
}

struct Downsampler {
    input_rate: u32,
    output_rate: u32,
    phase: u64,
    sum: f64,
    count: u32,
    maximum_samples: usize,
    samples: Vec<f32>,
}

impl Downsampler {
    fn new(input_rate: u32, output_rate: u32, maximum_samples: usize) -> Self {
        Self {
            input_rate,
            output_rate,
            phase: 0,
            sum: 0.0,
            count: 0,
            maximum_samples,
            samples: Vec::with_capacity(maximum_samples.min(1_000_000)),
        }
    }

    fn push(&mut self, sample: f32) -> MediaResult<()> {
        self.sum += f64::from(sample);
        self.count = self.count.saturating_add(1);
        self.phase = self.phase.saturating_add(u64::from(self.output_rate));
        if self.phase >= u64::from(self.input_rate) {
            self.phase -= u64::from(self.input_rate);
            if self.samples.len() >= self.maximum_samples {
                return Err(MediaError::OutputLimit {
                    limit: self.maximum_samples.saturating_mul(size_of::<f32>()),
                });
            }
            self.samples.push((self.sum / f64::from(self.count)) as f32);
            self.sum = 0.0;
            self.count = 0;
        }
        Ok(())
    }

    fn finish(mut self) -> MediaResult<Vec<f32>> {
        if self.count > 0 {
            if self.samples.len() >= self.maximum_samples {
                return Err(MediaError::OutputLimit {
                    limit: self.maximum_samples.saturating_mul(size_of::<f32>()),
                });
            }
            self.samples.push((self.sum / f64::from(self.count)) as f32);
        }
        if self.samples.len() < FRAME_SIZE {
            return Err(MediaError::InvalidInput(
                "audio is too short for rhythm analysis".to_owned(),
            ));
        }
        Ok(self.samples)
    }
}

fn drain_audio_frames(
    decoder: &mut ffmpeg::codec::decoder::Audio,
    downsampler: &mut Downsampler,
    cancellation: &ProcessCancellation,
) -> MediaResult<()> {
    let mut frame = ffmpeg::frame::Audio::empty();
    while decoder.receive_frame(&mut frame).is_ok() {
        if cancellation.is_cancelled() {
            return Err(MediaError::Cancelled);
        }
        append_mono_frame(&frame, downsampler)?;
    }
    Ok(())
}

fn append_mono_frame(frame: &ffmpeg::frame::Audio, output: &mut Downsampler) -> MediaResult<()> {
    let channels = usize::from(frame.channels());
    if channels == 0 || frame.samples() == 0 {
        return Ok(());
    }
    let format = frame.format();
    if format.bytes() == 0 {
        return Err(MediaError::NativeFfmpeg(
            "decoded audio frame has an unsupported sample format".to_owned(),
        ));
    }
    for sample_index in 0..frame.samples() {
        let mut mono = 0.0_f32;
        for channel in 0..channels {
            let (data, index) = if format.is_planar() {
                (frame.data(channel), sample_index)
            } else {
                (
                    frame.data(0),
                    sample_index
                        .saturating_mul(channels)
                        .saturating_add(channel),
                )
            };
            mono += decode_sample(format, data, index)?;
        }
        output.push((mono / f32::from(frame.channels())).clamp(-1.0, 1.0))?;
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
            f32::from(i16::from_ne_bytes(bytes.try_into().expect("two bytes")))
                / f32::from(i16::MAX)
        }
        ffmpeg::format::Sample::I32(_) => {
            i32::from_ne_bytes(bytes.try_into().expect("four bytes")) as f32 / i32::MAX as f32
        }
        ffmpeg::format::Sample::I64(_) => {
            (i64::from_ne_bytes(bytes.try_into().expect("eight bytes")) as f64 / i64::MAX as f64)
                as f32
        }
        ffmpeg::format::Sample::F32(_) => f32::from_ne_bytes(bytes.try_into().expect("four bytes")),
        ffmpeg::format::Sample::F64(_) => {
            f64::from_ne_bytes(bytes.try_into().expect("eight bytes")) as f32
        }
        ffmpeg::format::Sample::None => {
            return Err(MediaError::NativeFfmpeg(
                "decoded audio frame has no sample format".to_owned(),
            ));
        }
    };
    Ok(if value.is_finite() { value } else { 0.0 })
}

#[allow(clippy::cast_precision_loss)]
fn analyze_samples(
    samples: &[f32],
    sample_rate: u32,
    options: AudioAnalysisOptions,
    cancellation: &ProcessCancellation,
) -> MediaResult<AudioAnalysis> {
    let frame_count = 1 + (samples.len() - FRAME_SIZE) / HOP_SIZE;
    let mut planner = FftPlanner::<f32>::new();
    let fft = planner.plan_fft_forward(FRAME_SIZE);
    let mut previous = vec![0.0_f32; FRAME_SIZE / 2 + 1];
    let mut flux = Vec::with_capacity(frame_count);
    let mut frame_rms = Vec::with_capacity(frame_count);
    let mut frame_peaks = Vec::with_capacity(frame_count);
    let hann = (0..FRAME_SIZE)
        .map(|index| 0.5 - 0.5 * (2.0 * PI * index as f32 / (FRAME_SIZE - 1) as f32).cos())
        .collect::<Vec<_>>();
    let mut spectrum = vec![Complex32::new(0.0, 0.0); FRAME_SIZE];

    for start in (0..=samples.len() - FRAME_SIZE).step_by(HOP_SIZE) {
        if flux.len().is_multiple_of(128) && cancellation.is_cancelled() {
            return Err(MediaError::Cancelled);
        }
        let frame = &samples[start..start + FRAME_SIZE];
        let mut square_sum = 0.0_f64;
        let mut peak = 0.0_f32;
        for (index, sample) in frame.iter().copied().enumerate() {
            square_sum += f64::from(sample) * f64::from(sample);
            peak = peak.max(sample.abs());
            spectrum[index] = Complex32::new(sample * hann[index], 0.0);
        }
        fft.process(&mut spectrum);
        let mut frame_flux = 0.0_f32;
        for (bin, value) in spectrum[..=FRAME_SIZE / 2].iter().enumerate() {
            let magnitude = value.norm().ln_1p();
            frame_flux += (magnitude - previous[bin]).max(0.0);
            previous[bin] = magnitude;
        }
        flux.push(frame_flux);
        frame_rms.push((square_sum / FRAME_SIZE as f64).sqrt() as f32);
        frame_peaks.push(peak.clamp(0.0, 1.0));
    }

    normalize(&mut flux);
    let duration_seconds = samples.len() as f64 / f64::from(sample_rate);
    let mut limitations = vec![
        "Tempo is a single global 60–200 BPM estimate; expressive tempo changes are not modeled."
            .to_owned(),
        "Phrase positions assume four beats and are not downbeat classification.".to_owned(),
        "Section names are energy-change heuristics, not semantic music labels.".to_owned(),
    ];
    let all_onsets = detect_onsets(&flux, sample_rate);
    let (bpm, tempo_confidence) = estimate_tempo(&flux, all_onsets.len(), sample_rate);
    if bpm.is_none() {
        limitations.push(
            "No stable global tempo passed the confidence floor; the beat grid is empty."
                .to_owned(),
        );
    }
    let mut beats = bpm.map_or_else(Vec::new, |tempo| {
        build_beat_grid(&flux, &all_onsets, tempo, duration_seconds, sample_rate)
    });
    let mut onsets = all_onsets;
    if beats.len() > options.maximum_beats {
        beats.truncate(options.maximum_beats);
        limitations.push(format!(
            "Beat grid was truncated to {} points by the requested output bound.",
            options.maximum_beats
        ));
    }
    if onsets.len() > options.maximum_onsets {
        retain_strongest_chronological(&mut onsets, options.maximum_onsets);
        limitations.push(format!(
            "Onsets were reduced to the {} strongest points by the requested output bound.",
            options.maximum_onsets
        ));
    }
    let energy = build_energy_curve(&frame_rms, &frame_peaks, sample_rate, options.energy_points);
    let sections = build_sections(&energy, duration_seconds, options.maximum_sections);
    Ok(AudioAnalysis {
        duration_seconds,
        analysis_sample_rate: sample_rate,
        bpm,
        tempo_confidence,
        beats,
        onsets,
        energy,
        sections,
        limitations,
    })
}

fn normalize(values: &mut [f32]) {
    let maximum = values
        .iter()
        .copied()
        .filter(|value| value.is_finite())
        .fold(0.0_f32, f32::max);
    if maximum > f32::EPSILON {
        for value in values {
            *value = (*value / maximum).clamp(0.0, 1.0);
        }
    }
}

#[allow(clippy::cast_precision_loss)]
fn detect_onsets(flux: &[f32], sample_rate: u32) -> Vec<AudioOnset> {
    let minimum_gap = ((0.08 * f64::from(sample_rate) / HOP_SIZE as f64).round() as usize).max(1);
    let mut result: Vec<AudioOnset> = Vec::new();
    let radius = 8;
    let mut last_position = None;
    for position in 1..flux.len().saturating_sub(1) {
        let start = position.saturating_sub(radius);
        let end = (position + radius + 1).min(flux.len());
        let local = &flux[start..end];
        let mean = local.iter().sum::<f32>() / local.len() as f32;
        let deviation = (local
            .iter()
            .map(|value| (*value - mean).powi(2))
            .sum::<f32>()
            / local.len() as f32)
            .sqrt();
        let value = flux[position];
        if value < 0.05
            || value < mean + deviation * 0.65
            || value < flux[position - 1]
            || value <= flux[position + 1]
        {
            continue;
        }
        if last_position.is_some_and(|last| position - last < minimum_gap) {
            if let Some(last) = result.last_mut()
                && value > last.strength
            {
                last.time_seconds = position as f64 * HOP_SIZE as f64 / f64::from(sample_rate);
                last.strength = value;
                last_position = Some(position);
            }
            continue;
        }
        result.push(AudioOnset {
            time_seconds: position as f64 * HOP_SIZE as f64 / f64::from(sample_rate),
            strength: value,
        });
        last_position = Some(position);
    }
    result
}

#[allow(clippy::cast_precision_loss, clippy::cast_possible_truncation)]
fn estimate_tempo(flux: &[f32], onset_count: usize, sample_rate: u32) -> (Option<f64>, f32) {
    if onset_count < 4 || flux.len() < 32 {
        return (None, 0.0);
    }
    let frames_per_second = f64::from(sample_rate) / HOP_SIZE as f64;
    let minimum_lag = (frames_per_second * 60.0 / MAXIMUM_TEMPO_BPM).floor() as usize;
    let maximum_lag = (frames_per_second * 60.0 / MINIMUM_TEMPO_BPM).ceil() as usize;
    let scores = (minimum_lag..=maximum_lag)
        .map(|lag| autocorrelation(flux, lag))
        .collect::<Vec<_>>();
    let Some((relative_lag, best_score)) =
        scores.iter().copied().enumerate().max_by(|left, right| {
            let weighted = |(relative, score): &(usize, f32)| {
                let lag = minimum_lag + *relative;
                let bpm = 60.0 * frames_per_second / lag as f64;
                let octave_distance = (bpm / 120.0).log2();
                let prior = (-0.5 * (octave_distance / 0.75).powi(2)).exp();
                f64::from(*score) * (0.5 + 0.5 * prior)
            };
            weighted(left)
                .partial_cmp(&weighted(right))
                .unwrap_or(Ordering::Equal)
        })
    else {
        return (None, 0.0);
    };
    let lag = minimum_lag + relative_lag;
    let previous = relative_lag
        .checked_sub(1)
        .and_then(|index| scores.get(index))
        .copied()
        .unwrap_or(best_score);
    let next = scores.get(relative_lag + 1).copied().unwrap_or(best_score);
    let denominator = previous - 2.0 * best_score + next;
    let adjustment = if denominator.abs() > f32::EPSILON {
        (0.5 * (previous - next) / denominator).clamp(-0.5, 0.5)
    } else {
        0.0
    };
    let refined_lag = lag as f64 + f64::from(adjustment);
    let bpm = 60.0 * frames_per_second / refined_lag;
    let density_confidence = (onset_count as f32 / 12.0).min(1.0);
    let confidence = (best_score * density_confidence).clamp(0.0, 1.0);
    if confidence < 0.08 {
        (None, confidence)
    } else {
        (Some(bpm), confidence)
    }
}

fn autocorrelation(values: &[f32], lag: usize) -> f32 {
    if lag == 0 || lag >= values.len() {
        return 0.0;
    }
    let mut dot = 0.0_f64;
    let mut left_energy = 0.0_f64;
    let mut right_energy = 0.0_f64;
    for index in lag..values.len() {
        let left = f64::from(values[index]);
        let right = f64::from(values[index - lag]);
        dot += left * right;
        left_energy += left * left;
        right_energy += right * right;
    }
    let norm = (left_energy * right_energy).sqrt();
    if norm <= f64::EPSILON {
        0.0
    } else {
        (dot / norm).clamp(0.0, 1.0) as f32
    }
}

#[allow(
    clippy::cast_precision_loss,
    clippy::cast_possible_truncation,
    clippy::cast_sign_loss
)]
fn build_beat_grid(
    flux: &[f32],
    onsets: &[AudioOnset],
    bpm: f64,
    duration_seconds: f64,
    sample_rate: u32,
) -> Vec<AudioBeat> {
    if onsets.is_empty() {
        return Vec::new();
    }
    let period = 60.0 / bpm;
    let candidates = onsets.iter().take(128);
    let phase = candidates
        .map(|candidate| {
            let phase = candidate.time_seconds.rem_euclid(period);
            let score = onsets
                .iter()
                .map(|onset| {
                    let raw = (onset.time_seconds - phase).rem_euclid(period);
                    let distance = raw.min(period - raw);
                    f64::from(onset.strength) * (-0.5 * (distance / (period * 0.12)).powi(2)).exp()
                })
                .sum::<f64>();
            (phase, score)
        })
        .max_by(|left, right| left.1.partial_cmp(&right.1).unwrap_or(Ordering::Equal))
        .map_or(0.0, |candidate| candidate.0);
    let mut time = phase;
    while time - period >= 0.0 {
        time -= period;
    }
    let hop_seconds = HOP_SIZE as f64 / f64::from(sample_rate);
    let mut beats = Vec::new();
    while time <= duration_seconds + f64::EPSILON {
        let frame = (time / hop_seconds).round() as usize;
        let strength = flux.get(frame).copied().unwrap_or(0.0);
        let index = beats.len();
        beats.push(AudioBeat {
            index,
            time_seconds: time,
            strength,
            phrase_position: u8::try_from(index % 4 + 1).expect("phrase position is bounded"),
        });
        time += period;
    }
    beats
}

fn retain_strongest_chronological(onsets: &mut Vec<AudioOnset>, maximum: usize) {
    onsets.sort_by(|left, right| {
        right
            .strength
            .partial_cmp(&left.strength)
            .unwrap_or(Ordering::Equal)
            .then_with(|| {
                left.time_seconds
                    .partial_cmp(&right.time_seconds)
                    .unwrap_or(Ordering::Equal)
            })
    });
    onsets.truncate(maximum);
    onsets.sort_by(|left, right| {
        left.time_seconds
            .partial_cmp(&right.time_seconds)
            .unwrap_or(Ordering::Equal)
    });
}

#[allow(clippy::cast_precision_loss)]
fn build_energy_curve(
    rms: &[f32],
    peaks: &[f32],
    sample_rate: u32,
    maximum_points: usize,
) -> Vec<AudioEnergyPoint> {
    let count = maximum_points.min(rms.len());
    (0..count)
        .map(|bucket| {
            let start = bucket * rms.len() / count;
            let end = ((bucket + 1) * rms.len() / count).max(start + 1);
            let bucket_rms = rms[start..end].iter().sum::<f32>() / (end - start) as f32;
            let peak = peaks[start..end].iter().copied().fold(0.0_f32, f32::max);
            let center = (start + end) as f64 * 0.5 * HOP_SIZE as f64 / f64::from(sample_rate);
            AudioEnergyPoint {
                time_seconds: center,
                rms: bucket_rms.clamp(0.0, 1.0),
                peak: peak.clamp(0.0, 1.0),
            }
        })
        .collect()
}

#[allow(clippy::cast_precision_loss)]
fn build_sections(
    energy: &[AudioEnergyPoint],
    duration_seconds: f64,
    maximum_sections: usize,
) -> Vec<AudioSection> {
    if energy.is_empty() {
        return Vec::new();
    }
    let radius = 4;
    let mut novelty = vec![0.0_f32; energy.len()];
    for position in radius..energy.len().saturating_sub(radius) {
        let before = energy[position - radius..position]
            .iter()
            .map(|point| point.rms)
            .sum::<f32>()
            / radius as f32;
        let after = energy[position..position + radius]
            .iter()
            .map(|point| point.rms)
            .sum::<f32>()
            / radius as f32;
        novelty[position] = (after - before).abs();
    }
    let mean = novelty.iter().sum::<f32>() / novelty.len() as f32;
    let deviation = (novelty
        .iter()
        .map(|value| (*value - mean).powi(2))
        .sum::<f32>()
        / novelty.len() as f32)
        .sqrt();
    let maximum_novelty = novelty.iter().copied().fold(0.0_f32, f32::max);
    let mut candidates = (1..energy.len().saturating_sub(1))
        .filter(|position| {
            novelty[*position] >= mean + deviation * 0.75
                && novelty[*position] >= novelty[*position - 1]
                && novelty[*position] > novelty[*position + 1]
                && energy[*position].time_seconds >= 6.0
                && duration_seconds - energy[*position].time_seconds >= 6.0
        })
        .collect::<Vec<_>>();
    candidates.sort_by(|left, right| {
        novelty[*right]
            .partial_cmp(&novelty[*left])
            .unwrap_or(Ordering::Equal)
            .then_with(|| left.cmp(right))
    });
    let mut boundaries = Vec::new();
    for candidate in candidates {
        let time = energy[candidate].time_seconds;
        if boundaries
            .iter()
            .all(|other: &usize| (energy[*other].time_seconds - time).abs() >= 8.0)
        {
            boundaries.push(candidate);
            if boundaries.len() + 1 >= maximum_sections {
                break;
            }
        }
    }
    boundaries.sort_unstable();
    let overall = energy.iter().map(|point| point.rms).sum::<f32>() / energy.len() as f32;
    let mut starts = vec![0];
    starts.extend(boundaries.iter().copied());
    let mut ends = boundaries;
    ends.push(energy.len());
    starts
        .into_iter()
        .zip(ends)
        .map(|(start, end)| {
            let points = &energy[start..end];
            let mean_energy =
                points.iter().map(|point| point.rms).sum::<f32>() / points.len() as f32;
            let split = (points.len() / 2).max(1);
            let first = points[..split].iter().map(|point| point.rms).sum::<f32>() / split as f32;
            let second_points = &points[split.min(points.len())..];
            let second = if second_points.is_empty() {
                first
            } else {
                second_points.iter().map(|point| point.rms).sum::<f32>()
                    / second_points.len() as f32
            };
            let character = if mean_energy < overall * 0.65 {
                "quiet"
            } else if mean_energy > overall * 1.35 {
                "peak"
            } else if second > first * 1.18 {
                "build"
            } else if first > second * 1.18 {
                "release"
            } else {
                "steady"
            };
            let confidence = if start == 0 || maximum_novelty <= f32::EPSILON {
                0.35
            } else {
                (novelty[start] / maximum_novelty).clamp(0.0, 1.0)
            };
            AudioSection {
                start_seconds: if start == 0 {
                    0.0
                } else {
                    energy[start].time_seconds
                },
                end_seconds: if end == energy.len() {
                    duration_seconds
                } else {
                    energy[end].time_seconds
                },
                character: character.to_owned(),
                mean_energy,
                confidence,
            }
        })
        .collect()
}

fn native_error(error: ffmpeg::Error) -> MediaError {
    MediaError::NativeFfmpeg(error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use vibe_cs_domain::{BeatAlignmentClip, BeatAlignmentOptions};

    fn write_click_track(path: &Path, bpm: f64, duration_seconds: u32) {
        const RATE: u32 = 44_100;
        let sample_count = RATE * duration_seconds;
        let beat_samples = (60.0 * f64::from(RATE) / bpm).round() as u32;
        let click_samples = RATE / 80;
        let mut pcm = Vec::with_capacity(sample_count as usize * 2);
        for index in 0..sample_count {
            let beat_offset = index % beat_samples;
            let sample = if beat_offset < click_samples {
                let envelope = 1.0 - beat_offset as f32 / click_samples as f32;
                let phase = 2.0 * PI * 1_500.0 * index as f32 / RATE as f32;
                (phase.sin() * envelope * 0.9 * f32::from(i16::MAX)) as i16
            } else {
                0
            };
            pcm.extend_from_slice(&sample.to_le_bytes());
        }
        let data_size = u32::try_from(pcm.len()).unwrap();
        let mut wav = b"RIFF".to_vec();
        wav.extend_from_slice(&(36 + data_size).to_le_bytes());
        wav.extend_from_slice(b"WAVEfmt ");
        wav.extend_from_slice(&16_u32.to_le_bytes());
        wav.extend_from_slice(&1_u16.to_le_bytes());
        wav.extend_from_slice(&1_u16.to_le_bytes());
        wav.extend_from_slice(&RATE.to_le_bytes());
        wav.extend_from_slice(&(RATE * 2).to_le_bytes());
        wav.extend_from_slice(&2_u16.to_le_bytes());
        wav.extend_from_slice(&16_u16.to_le_bytes());
        wav.extend_from_slice(b"data");
        wav.extend_from_slice(&data_size.to_le_bytes());
        wav.extend_from_slice(&pcm);
        std::fs::write(path, wav).unwrap();
    }

    fn beat(index: usize, time_seconds: f64, strength: f32) -> AudioBeat {
        AudioBeat {
            index,
            time_seconds,
            strength,
            phrase_position: u8::try_from(index % 4 + 1).unwrap(),
        }
    }

    #[test]
    fn alignment_is_deterministic_advisory_and_bounded() {
        let request = BeatAlignmentRequest {
            beats: (0..20)
                .map(|index| {
                    beat(
                        index,
                        index as f64 * 0.5,
                        if index % 4 == 0 { 1.0 } else { 0.4 },
                    )
                })
                .collect(),
            clips: vec![
                BeatAlignmentClip {
                    clip_id: "opening".to_owned(),
                    source_duration_seconds: 2.1,
                    minimum_duration_seconds: None,
                    maximum_duration_seconds: None,
                    preferred_beats: Some(4),
                },
                BeatAlignmentClip {
                    clip_id: "action".to_owned(),
                    source_duration_seconds: 1.1,
                    minimum_duration_seconds: Some(0.9),
                    maximum_duration_seconds: Some(1.6),
                    preferred_beats: Some(2),
                },
            ],
            options: BeatAlignmentOptions::default(),
        };
        let first = plan_clip_alignment(&request).unwrap();
        let second = plan_clip_alignment(&request).unwrap();
        assert_eq!(first, second);
        assert!(first.advisory_only);
        assert_eq!(first.clips.len(), 2);
        assert!((first.clips[0].planned_duration_seconds - 2.0).abs() < f64::EPSILON);
        assert!((first.clips[1].planned_duration_seconds - 1.0).abs() < f64::EPSILON);
        assert!(first.unplaced_clip_ids.is_empty());
    }

    #[test]
    fn malformed_grids_are_rejected() {
        let request = BeatAlignmentRequest {
            beats: vec![beat(0, 1.0, 1.0), beat(1, 0.5, 1.0)],
            clips: vec![BeatAlignmentClip {
                clip_id: "clip".to_owned(),
                source_duration_seconds: 1.0,
                minimum_duration_seconds: None,
                maximum_duration_seconds: None,
                preferred_beats: None,
            }],
            options: BeatAlignmentOptions::default(),
        };
        assert!(matches!(
            plan_clip_alignment(&request),
            Err(MediaError::InvalidInput(_))
        ));
    }

    #[test]
    fn duplicate_ids_and_unbounded_timing_are_rejected() {
        let clip = BeatAlignmentClip {
            clip_id: "duplicate".to_owned(),
            source_duration_seconds: 1.0,
            minimum_duration_seconds: None,
            maximum_duration_seconds: None,
            preferred_beats: None,
        };
        let mut request = BeatAlignmentRequest {
            beats: vec![beat(0, 0.0, 1.0), beat(1, 0.5, 1.0)],
            clips: vec![clip.clone(), clip],
            options: BeatAlignmentOptions::default(),
        };
        assert!(matches!(
            plan_clip_alignment(&request),
            Err(MediaError::InvalidInput(_))
        ));

        request.clips.truncate(1);
        request.clips[0].source_duration_seconds = f64::INFINITY;
        assert!(matches!(
            plan_clip_alignment(&request),
            Err(MediaError::InvalidInput(_))
        ));

        request.clips[0].source_duration_seconds = MAXIMUM_TIMELINE_SECONDS + 1.0;
        assert!(matches!(
            plan_clip_alignment(&request),
            Err(MediaError::InvalidInput(_))
        ));
    }

    #[test]
    fn pre_cancelled_analysis_stops_before_file_access() {
        let cancellation = ProcessCancellation::default();
        cancellation.cancel();
        assert!(matches!(
            analyze_native_audio(
                Path::new("not-accessed.wav"),
                AudioAnalysisOptions::default(),
                &cancellation,
            ),
            Err(MediaError::Cancelled)
        ));
    }

    #[test]
    fn native_decoder_analyzes_a_real_pcm_click_track() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("click-track.wav");
        write_click_track(&path, 120.0, 12);
        let analysis = analyze_native_audio(
            &path,
            AudioAnalysisOptions {
                maximum_duration_seconds: 60.0,
                maximum_beats: 128,
                maximum_onsets: 128,
                energy_points: 64,
                maximum_sections: 8,
                ..AudioAnalysisOptions::default()
            },
            &ProcessCancellation::default(),
        )
        .unwrap();
        let bpm = analysis.bpm.expect("click track has a stable tempo");
        assert!((bpm - 120.0).abs() < 5.0, "detected {bpm:.2} BPM");
        assert!(analysis.tempo_confidence > 0.1);
        assert!(analysis.beats.len() >= 20);
        assert!(analysis.onsets.len() >= 20);
        assert_eq!(analysis.energy.len(), 64);
        assert!(!analysis.sections.is_empty());
        assert_eq!(analysis.analysis_sample_rate, 11_025);
    }
}
