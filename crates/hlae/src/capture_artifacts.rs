//! Validation and decoding boundary for one completed HLAE `afxClassic` take.

use std::{
    fs,
    io::Read as _,
    path::{Path, PathBuf},
};

use thiserror::Error;

use crate::{CaptureSettings, HlaeError, HlaePlan, validate_hlae_plan};

/// Maximum number of frames accepted from one HLAE take.
pub const HLAE_TAKE_MAX_FRAMES: usize = 2_160_000;
/// Hard upper bound for raw image-sequence and PCM staging from one job.
pub const HLAE_TAKE_MAX_ESTIMATED_BYTES: u64 = 512 * 1_024 * 1_024 * 1_024;
const HLAE_TGA_HEADER_BYTES: usize = 18;
const HLAE_TGA_MAX_DECODED_BYTES: usize = 256 * 1_024 * 1_024;
const HLAE_FRAME_COUNT_LOWER_TOLERANCE: usize = 2;
const HLAE_FRAME_COUNT_UPPER_TOLERANCE: usize = 3;

/// Bounded frame-count evidence derived from the ticks HLAE actually observed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct HlaeFrameCountBounds {
    pub minimum: usize,
    pub maximum: usize,
}

/// Converts an observed demo-tick span into a strict but scheduler-tolerant
/// image-sequence frame range.
///
/// HLAE command callbacks can be observed a small number of ticks after their
/// scheduled point, so callers must use the actual accepted start/end ticks.
/// Two frames of tolerance cover a late start. The upper bound allows three:
/// HLAE can write an inclusive terminal frame after the end callback, as proven
/// by real 60 fps capture evidence. A materially shorter or longer take remains
/// a hard failure.
///
/// # Errors
///
/// Returns [`HlaeError`] for an empty/reversed span, invalid tick rate/FPS, a
/// numeric overflow, or a result beyond the process-wide take ceiling.
pub fn hlae_frame_count_bounds(
    observed_start_tick: u32,
    observed_end_tick: u32,
    tick_rate: f64,
    fps: u32,
) -> Result<HlaeFrameCountBounds, HlaeError> {
    if observed_start_tick >= observed_end_tick
        || !tick_rate.is_finite()
        || !(1.0..=256.0).contains(&tick_rate)
        || !(1..=1_000).contains(&fps)
    {
        return Err(HlaeError::InvalidPlan(
            "observed capture span, tick rate, or FPS is invalid".to_owned(),
        ));
    }
    let ticks = observed_end_tick - observed_start_tick;
    let nominal = (f64::from(ticks) / tick_rate) * f64::from(fps);
    let hard_maximum = u32::try_from(HLAE_TAKE_MAX_FRAMES - HLAE_FRAME_COUNT_UPPER_TOLERANCE)
        .map_err(|_| HlaeError::InvalidPlan("capture frame ceiling is unsupported".to_owned()))?;
    if !nominal.is_finite() || nominal <= 0.0 || nominal.ceil() > f64::from(hard_maximum) {
        return Err(HlaeError::InvalidPlan(format!(
            "observed capture exceeds the {HLAE_TAKE_MAX_FRAMES} frame budget"
        )));
    }
    #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
    let floor = usize::try_from(nominal.floor() as u32).map_err(|_| {
        HlaeError::InvalidPlan("observed capture frame count is unsupported".to_owned())
    })?;
    #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
    let ceil = usize::try_from(nominal.ceil() as u32).map_err(|_| {
        HlaeError::InvalidPlan("observed capture frame count is unsupported".to_owned())
    })?;
    Ok(HlaeFrameCountBounds {
        minimum: floor
            .saturating_sub(HLAE_FRAME_COUNT_LOWER_TOLERANCE)
            .max(1),
        maximum: ceil + HLAE_FRAME_COUNT_UPPER_TOLERANCE,
    })
}

/// Conservative preflight estimate for one deterministic HLAE capture.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct HlaeCaptureResourceEstimate {
    pub maximum_frame_count: usize,
    pub layer_count: u8,
    pub video_bytes: u64,
    pub audio_bytes: u64,
    pub total_bytes: u64,
}

/// Estimates worst-case TGA/depth and PCM staging before HLAE is launched.
///
/// # Errors
///
/// Returns [`HlaeError`] when the plan is invalid or the estimate overflows.
pub fn estimate_hlae_capture_resources(
    plan: &HlaePlan,
) -> Result<HlaeCaptureResourceEstimate, HlaeError> {
    validate_hlae_plan(plan)?;
    estimate_validated_hlae_capture_resources(plan)
}

pub(crate) fn estimate_validated_hlae_capture_resources(
    plan: &HlaePlan,
) -> Result<HlaeCaptureResourceEstimate, HlaeError> {
    let first_tick = plan
        .shots
        .first()
        .ok_or_else(|| HlaeError::InvalidPlan("a capture must contain a shot".into()))?
        .start_tick;
    let last_tick = plan
        .shots
        .last()
        .ok_or_else(|| HlaeError::InvalidPlan("a capture must contain a shot".into()))?
        .end_tick;
    let first_tick = u32::try_from(first_tick)
        .map_err(|_| HlaeError::InvalidPlan("capture start tick is unsupported".to_owned()))?;
    let last_tick = u32::try_from(last_tick)
        .map_err(|_| HlaeError::InvalidPlan("capture tick span is unsupported".to_owned()))?;
    estimate_hlae_capture_span_resources(first_tick, last_tick, plan.tick_rate, &plan.capture)
}

/// Estimates worst-case staging for an explicit, already bounded capture
/// span. Managed runtimes use this with the permitted scheduler-overshoot end
/// tick so disk preflight covers every protocol-accepted take.
///
/// # Errors
///
/// Returns [`HlaeError`] for invalid ticks, tick rate, FPS, dimensions, layer
/// count, or any numeric/resource-budget overflow.
pub fn estimate_hlae_capture_span_resources(
    first_tick: u32,
    last_tick: u32,
    tick_rate: f64,
    capture: &CaptureSettings,
) -> Result<HlaeCaptureResourceEstimate, HlaeError> {
    if !(320..=4_096).contains(&capture.width)
        || !(240..=2_304).contains(&capture.height)
        || !capture.width.is_multiple_of(2)
        || !capture.height.is_multiple_of(2)
        || !(1..=1_000).contains(&capture.fps)
        || (!capture.layers.screen && !capture.layers.world && !capture.layers.depth)
    {
        return Err(HlaeError::InvalidPlan(
            "capture settings are outside the native staging contract".to_owned(),
        ));
    }
    let maximum_frame_count =
        hlae_frame_count_bounds(first_tick, last_tick, tick_rate, capture.fps)?.maximum;
    let layer_count = u8::from(capture.layers.screen)
        + u8::from(capture.layers.world)
        + u8::from(capture.layers.depth);
    let pixels = u64::from(capture.width)
        .checked_mul(u64::from(capture.height))
        .ok_or_else(|| HlaeError::InvalidPlan("capture pixel count overflow".to_owned()))?;
    let bytes_per_frame_and_layer = pixels
        .checked_mul(4)
        .and_then(|bytes| bytes.checked_add(18_u64))
        .ok_or_else(|| HlaeError::InvalidPlan("capture frame bytes overflow".to_owned()))?;
    let video_bytes =
        bytes_per_frame_and_layer
            .checked_mul(u64::try_from(maximum_frame_count).map_err(|_| {
                HlaeError::InvalidPlan("capture frame count is unsupported".to_owned())
            })?)
            .and_then(|bytes| bytes.checked_mul(u64::from(layer_count)))
            .ok_or_else(|| HlaeError::InvalidPlan("capture video bytes overflow".to_owned()))?;
    let audio_bytes = if capture.record_wav {
        // PCM16 stereo at 48 kHz is the conservative managed WAV budget.
        u64::try_from(maximum_frame_count)
            .ok()
            .and_then(|frames| frames.checked_mul(192_000))
            .and_then(|bytes| bytes.checked_add(u64::from(capture.fps) - 1))
            .map(|bytes| bytes / u64::from(capture.fps))
            .and_then(|bytes| bytes.checked_add(44))
            .ok_or_else(|| HlaeError::InvalidPlan("capture audio bytes overflow".to_owned()))?
    } else {
        0
    };
    let total_bytes = video_bytes
        .checked_add(audio_bytes)
        .ok_or_else(|| HlaeError::InvalidPlan("capture total bytes overflow".to_owned()))?;
    if total_bytes > HLAE_TAKE_MAX_ESTIMATED_BYTES {
        return Err(HlaeError::InvalidPlan(format!(
            "capture exceeds the {HLAE_TAKE_MAX_ESTIMATED_BYTES} byte staging budget"
        )));
    }
    Ok(HlaeCaptureResourceEstimate {
        maximum_frame_count,
        layer_count,
        video_bytes,
        audio_bytes,
        total_bytes,
    })
}

/// Expected shape of one application-managed HLAE take.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct HlaeTakeExpectation {
    pub width: u32,
    pub height: u32,
    pub require_audio: bool,
    pub maximum_frames: usize,
}

/// A validated, contiguous HLAE screen sequence and its optional game mix.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HlaeTakeInventory {
    pub directory: PathBuf,
    pub frames: Vec<PathBuf>,
    pub audio_wav: Option<PathBuf>,
    pub width: u32,
    pub height: u32,
}

/// Errors raised while binding or decoding HLAE capture output.
#[derive(Debug, Error)]
pub enum HlaeCaptureArtifactError {
    #[error("invalid HLAE take: {0}")]
    Invalid(String),
    #[error("unable to read HLAE take artifact: {0}")]
    Io(#[from] std::io::Error),
}

/// Binds a reported HLAE take directory to the application's managed root.
///
/// # Errors
///
/// Returns an error when the take escapes the managed root, contains anything
/// other than a contiguous `00000.tga` sequence and optional `audio.wav`, or
/// disagrees with the expected dimensions and audio contract.
pub fn inspect_hlae_take(
    managed_output_root: &Path,
    reported_take_directory: &Path,
    expectation: HlaeTakeExpectation,
) -> Result<HlaeTakeInventory, HlaeCaptureArtifactError> {
    validate_expectation(expectation)?;
    let managed_output_root = fs::canonicalize(managed_output_root)?;
    let take_directory = fs::canonicalize(reported_take_directory)?;
    if !managed_output_root.is_dir()
        || !take_directory.is_dir()
        || take_directory == managed_output_root
        || !take_directory.starts_with(&managed_output_root)
    {
        return invalid("take directory must be a strict descendant of the managed root");
    }

    let mut indexed_frames = Vec::new();
    let mut audio_wav = None;
    for entry in fs::read_dir(&take_directory)? {
        let entry = entry?;
        let path = entry.path();
        let metadata = fs::symlink_metadata(&path)?;
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            return invalid(format!(
                "unexpected non-file take artifact: {}",
                path.display()
            ));
        }
        let name = entry.file_name().into_string().map_err(|_| {
            HlaeCaptureArtifactError::Invalid("take artifact names must be UTF-8".into())
        })?;
        if name == "audio.wav" {
            if audio_wav.replace(path).is_some() {
                return invalid("duplicate audio.wav artifact");
            }
            continue;
        }
        let Some(stem) = name.strip_suffix(".tga") else {
            return invalid(format!("unexpected take artifact: {name}"));
        };
        if stem.len() < 5 || !stem.bytes().all(|byte| byte.is_ascii_digit()) {
            return invalid(format!("invalid HLAE frame name: {name}"));
        }
        let index = stem.parse::<usize>().map_err(|_| {
            HlaeCaptureArtifactError::Invalid(format!("invalid HLAE frame index: {name}"))
        })?;
        if format!("{index:05}") != stem {
            return invalid(format!("non-canonical HLAE frame name: {name}"));
        }
        if indexed_frames.len() >= expectation.maximum_frames {
            return invalid(format!(
                "HLAE take exceeds the {} frame limit",
                expectation.maximum_frames
            ));
        }
        validate_tga_file(&path, expectation.width, expectation.height)?;
        indexed_frames.push((index, path));
    }
    indexed_frames.sort_by_key(|(index, _)| *index);
    if indexed_frames.is_empty() {
        return invalid("HLAE take contains no screen frames");
    }
    for (expected, (actual, _)) in indexed_frames.iter().enumerate() {
        if expected != *actual {
            return invalid(format!(
                "HLAE frame sequence has a gap: expected {expected:05}, found {actual:05}"
            ));
        }
    }
    if expectation.require_audio && audio_wav.is_none() {
        return invalid("HLAE take is missing required audio.wav");
    }
    if let Some(audio) = &audio_wav {
        validate_wav_marker(audio)?;
    }
    Ok(HlaeTakeInventory {
        directory: take_directory,
        frames: indexed_frames.into_iter().map(|(_, path)| path).collect(),
        audio_wav,
        width: expectation.width,
        height: expectation.height,
    })
}

/// Decodes one validated HLAE TGA frame into tightly packed top-down BGRA.
///
/// # Errors
///
/// Returns an error when the file is not the expected uncompressed HLAE TGA
/// shape, has changed since inspection, or cannot be read.
pub fn decode_hlae_tga_bgra(
    frame: &Path,
    width: u32,
    height: u32,
) -> Result<Vec<u8>, HlaeCaptureArtifactError> {
    let bytes = fs::read(frame)?;
    let header = validate_tga_bytes(&bytes, width, height)?;
    let source = &bytes[HLAE_TGA_HEADER_BYTES..];
    if header.top_down && header.bytes_per_pixel == 4 {
        return Ok(source.to_vec());
    }
    let source_stride = header
        .width
        .checked_mul(header.bytes_per_pixel)
        .ok_or_else(|| HlaeCaptureArtifactError::Invalid("TGA row size overflow".into()))?;
    let output_len = header
        .width
        .checked_mul(header.height)
        .and_then(|pixels| pixels.checked_mul(4))
        .ok_or_else(|| HlaeCaptureArtifactError::Invalid("TGA output size overflow".into()))?;
    let mut output = vec![0_u8; output_len];
    for output_y in 0..header.height {
        let source_y = if header.top_down {
            output_y
        } else {
            header.height - output_y - 1
        };
        let source_row = &source[source_y * source_stride..(source_y + 1) * source_stride];
        let output_start = output_y * header.width * 4;
        let output_row = &mut output[output_start..output_start + header.width * 4];
        if header.bytes_per_pixel == 4 {
            output_row.copy_from_slice(source_row);
            continue;
        }
        for (source_pixel, output_pixel) in source_row
            .chunks_exact(3)
            .zip(output_row.chunks_exact_mut(4))
        {
            output_pixel[..3].copy_from_slice(source_pixel);
            output_pixel[3] = u8::MAX;
        }
    }
    Ok(output)
}

#[derive(Debug, Clone, Copy)]
struct TgaHeader {
    width: usize,
    height: usize,
    bytes_per_pixel: usize,
    top_down: bool,
}

fn validate_expectation(expectation: HlaeTakeExpectation) -> Result<(), HlaeCaptureArtifactError> {
    if expectation.width == 0
        || expectation.height == 0
        || expectation.width > u32::from(u16::MAX)
        || expectation.height > u32::from(u16::MAX)
        || expectation.maximum_frames == 0
        || expectation.maximum_frames > HLAE_TAKE_MAX_FRAMES
    {
        return invalid("HLAE take expectation is outside bounded limits");
    }
    Ok(())
}

fn validate_tga_file(path: &Path, width: u32, height: u32) -> Result<(), HlaeCaptureArtifactError> {
    let metadata = fs::symlink_metadata(path)?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return invalid("HLAE frame must be a regular non-link file");
    }
    let mut file = fs::File::open(path)?;
    let file_bytes = usize::try_from(file.metadata()?.len())
        .map_err(|_| HlaeCaptureArtifactError::Invalid("TGA file length is unsupported".into()))?;
    let mut header_bytes = [0_u8; HLAE_TGA_HEADER_BYTES];
    file.read_exact(&mut header_bytes)?;
    let header = parse_tga_header(&header_bytes, width, height)?;
    if expected_tga_file_bytes(header)? != file_bytes {
        return invalid("HLAE TGA byte length does not match its dimensions");
    }
    Ok(())
}

fn validate_tga_bytes(
    bytes: &[u8],
    width: u32,
    height: u32,
) -> Result<TgaHeader, HlaeCaptureArtifactError> {
    let header = parse_tga_header(bytes, width, height)?;
    if expected_tga_file_bytes(header)? != bytes.len() {
        return invalid("HLAE TGA byte length does not match its dimensions");
    }
    Ok(header)
}

fn parse_tga_header(
    bytes: &[u8],
    width: u32,
    height: u32,
) -> Result<TgaHeader, HlaeCaptureArtifactError> {
    if bytes.len() < HLAE_TGA_HEADER_BYTES {
        return invalid("HLAE frame has a truncated TGA header");
    }
    let actual_width = usize::from(u16::from_le_bytes([bytes[12], bytes[13]]));
    let actual_height = usize::from(u16::from_le_bytes([bytes[14], bytes[15]]));
    let (bytes_per_pixel, expected_attribute_bits) = match bytes[16] {
        24 => (3, 0),
        32 => (4, 8),
        other => return invalid(format!("unsupported HLAE TGA bit depth: {other}")),
    };
    if bytes[0] != 0
        || bytes[1] != 0
        || bytes[2] != 2
        || bytes[3..12] != [0; 9]
        || bytes[17] & 0b0001_0000 != 0
        || bytes[17] & 0b0000_1111 != expected_attribute_bits
        || actual_width != usize::try_from(width).unwrap_or(usize::MAX)
        || actual_height != usize::try_from(height).unwrap_or(usize::MAX)
    {
        return invalid("HLAE frame is not the expected uncompressed true-color TGA");
    }
    Ok(TgaHeader {
        width: actual_width,
        height: actual_height,
        bytes_per_pixel,
        top_down: bytes[17] & 0b0010_0000 != 0,
    })
}

fn expected_tga_file_bytes(header: TgaHeader) -> Result<usize, HlaeCaptureArtifactError> {
    let pixel_bytes = header
        .width
        .checked_mul(header.height)
        .and_then(|pixels| pixels.checked_mul(header.bytes_per_pixel))
        .ok_or_else(|| HlaeCaptureArtifactError::Invalid("TGA byte size overflow".into()))?;
    if pixel_bytes > HLAE_TGA_MAX_DECODED_BYTES {
        return invalid("HLAE TGA decoded size exceeds the resource limit");
    }
    HLAE_TGA_HEADER_BYTES
        .checked_add(pixel_bytes)
        .ok_or_else(|| HlaeCaptureArtifactError::Invalid("TGA file size overflow".into()))
}

fn validate_wav_marker(path: &Path) -> Result<(), HlaeCaptureArtifactError> {
    let metadata = fs::symlink_metadata(path)?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return invalid("audio.wav must be a regular non-link file");
    }
    let mut file = fs::File::open(path)?;
    let mut marker = [0_u8; 12];
    file.read_exact(&mut marker)?;
    if &marker[..4] != b"RIFF" || &marker[8..12] != b"WAVE" {
        return invalid("audio.wav is not a RIFF/WAVE artifact");
    }
    Ok(())
}

fn invalid<T>(message: impl Into<String>) -> Result<T, HlaeCaptureArtifactError> {
    Err(HlaeCaptureArtifactError::Invalid(message.into()))
}

#[cfg(test)]
mod tests {
    use std::fs;

    use super::*;

    #[test]
    fn derives_scheduler_tolerant_frame_bounds_from_the_observed_tick_span() {
        assert_eq!(
            hlae_frame_count_bounds(1_000, 1_640, 64.0, 60).unwrap(),
            HlaeFrameCountBounds {
                minimum: 598,
                maximum: 603,
            }
        );
    }

    #[test]
    fn allows_the_inclusive_terminal_frame_seen_in_real_hlae_capture() {
        assert_eq!(
            hlae_frame_count_bounds(1_000, 1_788, 64.0, 60).unwrap(),
            HlaeFrameCountBounds {
                minimum: 736,
                maximum: 742,
            }
        );
    }

    #[test]
    fn keeps_a_short_observed_capture_non_empty() {
        assert_eq!(
            hlae_frame_count_bounds(1_000, 1_001, 64.0, 60).unwrap(),
            HlaeFrameCountBounds {
                minimum: 1,
                maximum: 4,
            }
        );
    }

    #[test]
    fn rejects_invalid_or_unbounded_observed_capture_spans() {
        for result in [
            hlae_frame_count_bounds(1_000, 1_000, 64.0, 60),
            hlae_frame_count_bounds(1_001, 1_000, 64.0, 60),
            hlae_frame_count_bounds(0, 64, f64::NAN, 60),
            hlae_frame_count_bounds(0, u32::MAX, 1.0, 1_000),
        ] {
            assert!(matches!(result, Err(HlaeError::InvalidPlan(_))));
        }
    }

    fn write_tga(path: &Path, width: u16, height: u16, pixels_bgr: &[u8]) {
        let mut bytes = vec![0_u8; 18];
        bytes[2] = 2;
        bytes[12..14].copy_from_slice(&width.to_le_bytes());
        bytes[14..16].copy_from_slice(&height.to_le_bytes());
        bytes[16] = 24;
        bytes[17] = 1 << 5;
        bytes.extend_from_slice(pixels_bgr);
        fs::write(path, bytes).unwrap();
    }

    fn write_bgra_tga(path: &Path, width: u16, height: u16, top_down: bool, pixels_bgra: &[u8]) {
        let mut bytes = vec![0_u8; 18];
        bytes[2] = 2;
        bytes[12..14].copy_from_slice(&width.to_le_bytes());
        bytes[14..16].copy_from_slice(&height.to_le_bytes());
        bytes[16] = 32;
        bytes[17] = 8 | if top_down { 1 << 5 } else { 0 };
        bytes.extend_from_slice(pixels_bgra);
        fs::write(path, bytes).unwrap();
    }

    #[test]
    fn binds_a_contiguous_managed_take_and_decodes_bgra() {
        let temporary = tempfile::tempdir().unwrap();
        let managed = temporary.path().join("captures");
        let take = managed.join("job-1").join("take0000");
        fs::create_dir_all(&take).unwrap();
        write_tga(&take.join("00000.tga"), 2, 1, &[1, 2, 3, 4, 5, 6]);
        write_tga(&take.join("00001.tga"), 2, 1, &[7, 8, 9, 10, 11, 12]);
        fs::write(take.join("audio.wav"), b"RIFF----WAVE").unwrap();

        let inventory = inspect_hlae_take(
            &managed,
            &take,
            HlaeTakeExpectation {
                width: 2,
                height: 1,
                require_audio: true,
                maximum_frames: 60,
            },
        )
        .unwrap();

        assert_eq!(inventory.frames.len(), 2);
        assert_eq!(
            inventory.audio_wav,
            Some(fs::canonicalize(take.join("audio.wav")).unwrap())
        );
        assert_eq!(
            decode_hlae_tga_bgra(&inventory.frames[0], 2, 1).unwrap(),
            vec![1, 2, 3, 255, 4, 5, 6, 255]
        );
    }

    #[test]
    fn rejects_a_take_with_a_missing_frame_instead_of_encoding_partial_video() {
        let temporary = tempfile::tempdir().unwrap();
        let managed = temporary.path().join("captures");
        let take = managed.join("job-1").join("take0000");
        fs::create_dir_all(&take).unwrap();
        write_tga(&take.join("00000.tga"), 1, 1, &[1, 2, 3]);
        write_tga(&take.join("00002.tga"), 1, 1, &[4, 5, 6]);

        let error = inspect_hlae_take(
            &managed,
            &take,
            HlaeTakeExpectation {
                width: 1,
                height: 1,
                require_audio: false,
                maximum_frames: 60,
            },
        )
        .unwrap_err();

        assert!(error.to_string().contains("expected 00001, found 00002"));
    }

    #[test]
    fn decodes_bottom_up_bgra_without_losing_alpha() {
        let temporary = tempfile::tempdir().unwrap();
        let frame = temporary.path().join("00000.tga");
        // HLAE stores the lower row first when the top-down descriptor bit is absent.
        write_bgra_tga(&frame, 1, 2, false, &[10, 20, 30, 40, 1, 2, 3, 4]);

        assert_eq!(
            decode_hlae_tga_bgra(&frame, 1, 2).unwrap(),
            vec![1, 2, 3, 4, 10, 20, 30, 40]
        );
    }

    #[test]
    fn preserves_top_down_bgra_without_per_pixel_rewriting() {
        let temporary = tempfile::tempdir().unwrap();
        let frame = temporary.path().join("00000.tga");
        let pixels = [1, 2, 3, 4, 10, 20, 30, 40];
        write_bgra_tga(&frame, 2, 1, true, &pixels);

        assert_eq!(decode_hlae_tga_bgra(&frame, 2, 1).unwrap(), pixels);
    }

    #[test]
    fn rejects_unexpected_artifacts_and_non_hlae_alpha_descriptors() {
        let temporary = tempfile::tempdir().unwrap();
        let managed = temporary.path().join("captures");
        let take = managed.join("job-1").join("take0000");
        fs::create_dir_all(&take).unwrap();
        write_tga(&take.join("00000.tga"), 1, 1, &[1, 2, 3]);
        fs::write(take.join("capture.log"), b"not part of an HLAE take").unwrap();

        let error = inspect_hlae_take(
            &managed,
            &take,
            HlaeTakeExpectation {
                width: 1,
                height: 1,
                require_audio: false,
                maximum_frames: 60,
            },
        )
        .unwrap_err();
        assert!(error.to_string().contains("unexpected take artifact"));

        fs::remove_file(take.join("capture.log")).unwrap();
        let mut invalid = fs::read(take.join("00000.tga")).unwrap();
        invalid[17] = 8;
        fs::write(take.join("00000.tga"), invalid).unwrap();
        let error = inspect_hlae_take(
            &managed,
            &take,
            HlaeTakeExpectation {
                width: 1,
                height: 1,
                require_audio: false,
                maximum_frames: 60,
            },
        )
        .unwrap_err();
        assert!(
            error
                .to_string()
                .contains("expected uncompressed true-color TGA")
        );
    }
}
