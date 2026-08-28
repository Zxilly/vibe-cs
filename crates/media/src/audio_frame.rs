use ffmpeg_next as ffmpeg;

use crate::{MediaError, MediaResult};

pub(crate) fn planar_channel_data(
    frame: &ffmpeg::frame::Audio,
    channel: usize,
) -> MediaResult<&[u8]> {
    let bytes_per_sample = frame.format().bytes();
    let channel_bytes = frame
        .samples()
        .checked_mul(bytes_per_sample)
        .ok_or_else(|| MediaError::NativeFfmpeg("audio plane size overflow".to_owned()))?;
    let requested = if channel < frame.planes() {
        frame.data(channel)
    } else {
        &[]
    };
    select_planar_channel(
        frame.data(0),
        requested,
        channel,
        usize::from(frame.channels()),
        channel_bytes,
    )
}

fn select_planar_channel<'a>(
    primary: &'a [u8],
    requested: &'a [u8],
    channel: usize,
    channels: usize,
    channel_bytes: usize,
) -> MediaResult<&'a [u8]> {
    if requested.len() >= channel_bytes {
        return Ok(&requested[..channel_bytes]);
    }
    let start = channel
        .checked_mul(channel_bytes)
        .ok_or_else(|| MediaError::NativeFfmpeg("audio plane offset overflow".to_owned()))?;
    let end = start
        .checked_add(channel_bytes)
        .ok_or_else(|| MediaError::NativeFfmpeg("audio plane offset overflow".to_owned()))?;
    if channel < channels && primary.len() >= channel_bytes.saturating_mul(channels) {
        return Ok(&primary[start..end]);
    }
    Err(MediaError::NativeFfmpeg(format!(
        "truncated decoded audio plane: channel {channel}/{channels}, expected {channel_bytes} bytes, got {} (primary {})",
        requested.len(),
        primary.len(),
    )))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_missing_planar_channel_from_contiguous_primary_storage() {
        let primary = [1_u8, 2, 3, 4, 5, 6, 7, 8];
        let selected = select_planar_channel(&primary, &[], 1, 2, 4).unwrap();
        assert_eq!(selected, [5, 6, 7, 8]);
    }

    #[test]
    fn prefers_the_requested_audio_plane_when_present() {
        let primary = [1_u8, 2, 3, 4];
        let requested = [5_u8, 6, 7, 8];
        let selected = select_planar_channel(&primary, &requested, 1, 2, 4).unwrap();
        assert_eq!(selected, requested);
    }
}
