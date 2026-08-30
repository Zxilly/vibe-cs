use std::{path::Path, time::Duration};

use ffmpeg::{Rescale, rescale};
use ffmpeg_next as ffmpeg;

use crate::{MediaError, MediaResult, ProcessCancellation};

const MAXIMUM_DECODED_FRAMES: usize = 600;
const MAXIMUM_THUMBNAIL_BYTES: usize = 2 * 1024 * 1024;

#[derive(Debug, Clone, Copy)]
pub struct ThumbnailOptions {
    pub time_seconds: f64,
    pub maximum_width: u32,
    pub maximum_height: u32,
}

/// Decodes one bounded video frame and returns an RGB PNG thumbnail.
///
/// # Errors
///
/// Returns an error for invalid bounds, missing video, cancellation, decode or
/// scale failure, an unreachable requested frame, or an oversized PNG.
pub fn generate_native_thumbnail(
    media: &Path,
    options: ThumbnailOptions,
    cancellation: &ProcessCancellation,
) -> MediaResult<Vec<u8>> {
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
        .best(ffmpeg::media::Type::Video)
        .ok_or_else(|| MediaError::InvalidInput("media has no video stream".to_owned()))?;
    let stream_index = stream.index();
    let stream_time_base = stream.time_base();
    let context = ffmpeg::codec::context::Context::from_parameters(stream.parameters())
        .map_err(native_error)?;
    let mut decoder = context.decoder().video().map_err(native_error)?;
    let (width, height) = fitted_dimensions(
        decoder.width(),
        decoder.height(),
        options.maximum_width,
        options.maximum_height,
    )?;
    let mut scaler = ffmpeg::software::scaling::context::Context::get(
        decoder.format(),
        decoder.width(),
        decoder.height(),
        ffmpeg::format::Pixel::RGB24,
        width,
        height,
        ffmpeg::software::scaling::flag::Flags::BILINEAR,
    )
    .map_err(native_error)?;
    let target_base = seconds_to_base_timestamp(options.time_seconds)?;
    let target_stream = target_base.rescale(rescale::TIME_BASE, stream_time_base);
    if target_base > 0 {
        input
            .seek(target_base, ..target_base)
            .map_err(native_error)?;
        decoder.flush();
    }

    let mut decoded_frames = 0_usize;
    for (packet_stream, packet) in input.packets() {
        if cancellation.is_cancelled() {
            return Err(MediaError::Cancelled);
        }
        if packet_stream.index() != stream_index {
            continue;
        }
        decoder.send_packet(&packet).map_err(native_error)?;
        if let Some(png) = drain_thumbnail_frames(
            &mut decoder,
            &mut scaler,
            target_stream,
            width,
            height,
            &mut decoded_frames,
            cancellation,
        )? {
            return Ok(png);
        }
    }
    decoder.send_eof().map_err(native_error)?;
    drain_thumbnail_frames(
        &mut decoder,
        &mut scaler,
        target_stream,
        width,
        height,
        &mut decoded_frames,
        cancellation,
    )?
    .ok_or_else(|| {
        MediaError::InvalidInput("media has no decodable frame at the requested time".to_owned())
    })
}

fn drain_thumbnail_frames(
    decoder: &mut ffmpeg::codec::decoder::Video,
    scaler: &mut ffmpeg::software::scaling::context::Context,
    target_timestamp: i64,
    width: u32,
    height: u32,
    decoded_frames: &mut usize,
    cancellation: &ProcessCancellation,
) -> MediaResult<Option<Vec<u8>>> {
    let mut frame = ffmpeg::frame::Video::empty();
    while decoder.receive_frame(&mut frame).is_ok() {
        if cancellation.is_cancelled() {
            return Err(MediaError::Cancelled);
        }
        *decoded_frames = decoded_frames.saturating_add(1);
        if *decoded_frames > MAXIMUM_DECODED_FRAMES {
            return Err(MediaError::InvalidInput(format!(
                "thumbnail seek exceeded {MAXIMUM_DECODED_FRAMES} decoded frames"
            )));
        }
        if frame
            .timestamp()
            .is_some_and(|timestamp| timestamp < target_timestamp)
        {
            continue;
        }
        let mut rgb = ffmpeg::frame::Video::empty();
        scaler.run(&frame, &mut rgb).map_err(native_error)?;
        return encode_png(&rgb, width, height).map(Some);
    }
    Ok(None)
}

fn encode_png(frame: &ffmpeg::frame::Video, width: u32, height: u32) -> MediaResult<Vec<u8>> {
    let row_bytes = usize::try_from(width)
        .ok()
        .and_then(|width| width.checked_mul(3))
        .ok_or_else(|| MediaError::InvalidInput("thumbnail row is too wide".to_owned()))?;
    let height_usize = usize::try_from(height)
        .map_err(|_| MediaError::InvalidInput("thumbnail height is invalid".to_owned()))?;
    let packed_len = row_bytes.checked_mul(height_usize).ok_or_else(|| {
        MediaError::InvalidInput("thumbnail pixel buffer is too large".to_owned())
    })?;
    let source = frame.data(0);
    let stride = frame.stride(0);
    if stride < row_bytes || source.len() < stride.saturating_mul(height_usize) {
        return Err(MediaError::NativeFfmpeg(
            "decoded thumbnail frame has truncated RGB rows".to_owned(),
        ));
    }
    let mut packed = Vec::with_capacity(packed_len);
    for row in 0..height_usize {
        let start = row * stride;
        packed.extend_from_slice(&source[start..start + row_bytes]);
    }
    let mut png = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut png, width, height);
        encoder.set_color(png::ColorType::Rgb);
        encoder.set_depth(png::BitDepth::Eight);
        let mut writer = encoder
            .write_header()
            .map_err(|error| MediaError::NativeFfmpeg(format!("PNG header failed: {error}")))?;
        writer
            .write_image_data(&packed)
            .map_err(|error| MediaError::NativeFfmpeg(format!("PNG encoding failed: {error}")))?;
    }
    if png.len() > MAXIMUM_THUMBNAIL_BYTES {
        return Err(MediaError::OutputLimit {
            limit: MAXIMUM_THUMBNAIL_BYTES,
        });
    }
    Ok(png)
}

fn seconds_to_base_timestamp(seconds: f64) -> MediaResult<i64> {
    let duration = Duration::try_from_secs_f64(seconds).map_err(|_| {
        MediaError::InvalidInput("thumbnail time is outside the supported range".to_owned())
    })?;
    i64::try_from(duration.as_micros()).map_err(|_| {
        MediaError::InvalidInput("thumbnail time is outside the supported range".to_owned())
    })
}

fn fitted_dimensions(
    source_width: u32,
    source_height: u32,
    maximum_width: u32,
    maximum_height: u32,
) -> MediaResult<(u32, u32)> {
    if source_width == 0 || source_height == 0 {
        return Err(MediaError::InvalidInput(
            "video stream has no frame dimensions".to_owned(),
        ));
    }
    if source_width > 16_384
        || source_height > 16_384
        || u64::from(source_width) * u64::from(source_height) > 100_000_000
    {
        return Err(MediaError::InvalidInput(
            "video frame dimensions exceed the thumbnail decoder limit".to_owned(),
        ));
    }
    if source_width <= maximum_width && source_height <= maximum_height {
        return Ok((source_width, source_height));
    }
    let source_width = u64::from(source_width);
    let source_height = u64::from(source_height);
    let maximum_width = u64::from(maximum_width);
    let maximum_height = u64::from(maximum_height);
    let (width, height) = if source_width * maximum_height > source_height * maximum_width {
        (
            maximum_width,
            (source_height * maximum_width + source_width / 2) / source_width,
        )
    } else {
        (
            (source_width * maximum_height + source_height / 2) / source_height,
            maximum_height,
        )
    };
    Ok((
        u32::try_from(width.max(1)).map_err(|_| {
            MediaError::InvalidInput("thumbnail width is outside the supported range".to_owned())
        })?,
        u32::try_from(height.max(1)).map_err(|_| {
            MediaError::InvalidInput("thumbnail height is outside the supported range".to_owned())
        })?,
    ))
}

fn validate_options(options: ThumbnailOptions) -> MediaResult<()> {
    if !options.time_seconds.is_finite() || options.time_seconds < 0.0 {
        return Err(MediaError::InvalidInput(
            "thumbnail time must be a finite non-negative number".to_owned(),
        ));
    }
    if !(32..=640).contains(&options.maximum_width) || !(18..=360).contains(&options.maximum_height)
    {
        return Err(MediaError::InvalidInput(
            "thumbnail bounds must be within 32x18 and 640x360".to_owned(),
        ));
    }
    Ok(())
}

fn native_error(error: ffmpeg::Error) -> MediaError {
    MediaError::NativeFfmpeg(error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dimensions_fit_without_distorting_the_source() {
        assert_eq!(fitted_dimensions(1920, 1080, 320, 180).unwrap(), (320, 180));
        assert_eq!(fitted_dimensions(1080, 1920, 320, 180).unwrap(), (101, 180));
        assert_eq!(fitted_dimensions(160, 90, 320, 180).unwrap(), (160, 90));
        assert!(fitted_dimensions(20_000, 20_000, 320, 180).is_err());
    }

    #[test]
    fn options_reject_unbounded_decode_requests() {
        assert!(
            validate_options(ThumbnailOptions {
                time_seconds: f64::NAN,
                maximum_width: 320,
                maximum_height: 180,
            })
            .is_err()
        );
        assert!(
            validate_options(ThumbnailOptions {
                time_seconds: 0.0,
                maximum_width: 1920,
                maximum_height: 1080,
            })
            .is_err()
        );
    }
}
