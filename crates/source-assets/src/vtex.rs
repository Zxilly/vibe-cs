use crate::{Result, SourceAssetError};

const RESOURCE_HEADER_VERSION: u16 = 12;
const RESOURCE_HEADER_LENGTH: usize = 16;
const BLOCK_DIRECTORY_ENTRY_LENGTH: usize = 12;
const TEXTURE_HEADER_LENGTH: usize = 40;
const DATA_BLOCK: u32 = u32::from_le_bytes(*b"DATA");
const FLAG_CUBE_TEXTURE: u16 = 1 << 4;
const FLAG_VOLUME_TEXTURE: u16 = 1 << 5;
const FLAG_TEXTURE_ARRAY: u16 = 1 << 6;
const FLAG_YCOCG_DXT5: u16 = 1 << 8;
const EXTRA_METADATA: u32 = 3;
const EXTRA_COMPRESSED_MIP_SIZE: u32 = 4;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct VtexDecodeLimits {
    pub max_resource_size: usize,
    pub max_blocks: usize,
    pub max_extra_entries: usize,
    pub max_mip_levels: u8,
    pub max_dimension: u16,
    pub max_pixels: usize,
    pub max_decoded_bytes: usize,
    pub max_encoded_bytes: usize,
}

impl Default for VtexDecodeLimits {
    fn default() -> Self {
        Self {
            max_resource_size: 256 * 1024 * 1024,
            max_blocks: 64,
            max_extra_entries: 64,
            max_mip_levels: 16,
            max_dimension: 8_192,
            max_pixels: 4_096 * 4_096,
            max_decoded_bytes: 64 * 1024 * 1024,
            max_encoded_bytes: 64 * 1024 * 1024,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DecodedVtexImage {
    pub width: u32,
    pub height: u32,
    pub mime_type: &'static str,
    pub bytes: Vec<u8>,
}

#[derive(Debug)]
struct TextureMetadata {
    flags: u16,
    width: u16,
    height: u16,
    actual_width: u16,
    actual_height: u16,
    format: u8,
    mip_levels: u8,
    compressed_mips: Option<Vec<usize>>,
    compressed: bool,
    payload_offset: usize,
}

#[derive(Debug, Clone, Copy)]
struct DataBlock {
    offset: usize,
    end: usize,
}

pub fn decode_vtex_to_browser_image(bytes: &[u8]) -> Result<DecodedVtexImage> {
    decode_vtex_to_browser_image_with_limits(bytes, VtexDecodeLimits::default())
}

pub fn decode_vtex_to_browser_image_with_limits(
    bytes: &[u8],
    limits: VtexDecodeLimits,
) -> Result<DecodedVtexImage> {
    enforce_limit(
        "compiled texture input",
        bytes.len(),
        limits.max_resource_size,
    )?;
    let data = parse_resource(bytes, limits)?;
    let texture = parse_texture_metadata(bytes, data, limits)?;
    validate_texture_shape(&texture, limits)?;

    if matches!(texture.format, 15..=18 | 29 | 30) {
        return decode_embedded_image(bytes, &texture, limits);
    }
    if texture.flags & FLAG_YCOCG_DXT5 != 0 {
        return Err(SourceAssetError::UnsupportedCompiledTextureFormat(
            texture.format,
        ));
    }

    let mip = read_largest_mip(bytes, &texture)?;
    let rgba = decode_pixels(&mip, &texture)?;
    let rgba = crop_rgba(
        &rgba,
        usize::from(texture.width),
        usize::from(texture.actual_width),
        usize::from(texture.actual_height),
    )?;
    let png = encode_png(texture.actual_width, texture.actual_height, &rgba, limits)?;
    Ok(DecodedVtexImage {
        width: u32::from(texture.actual_width),
        height: u32::from(texture.actual_height),
        mime_type: "image/png",
        bytes: png,
    })
}

fn parse_resource(bytes: &[u8], limits: VtexDecodeLimits) -> Result<DataBlock> {
    require_range(bytes, 0, RESOURCE_HEADER_LENGTH)?;
    let declared_size = usize_from_u32(read_u32(bytes, 0)?, 0)?;
    if declared_size < RESOURCE_HEADER_LENGTH || declared_size > bytes.len() {
        return Err(invalid_texture(
            0,
            format!(
                "declared resource length {declared_size} is outside the {} byte input",
                bytes.len()
            ),
        ));
    }
    if read_u16(bytes, 4)? != RESOURCE_HEADER_VERSION {
        return Err(invalid_texture(4, "unsupported resource header version"));
    }
    let block_directory_offset = usize_from_u32(read_u32(bytes, 8)?, 8)?;
    if block_directory_offset < 8 {
        return Err(invalid_texture(
            8,
            "block directory relative offset is smaller than its base",
        ));
    }
    let block_count = usize_from_u32(read_u32(bytes, 12)?, 12)?;
    enforce_limit(
        "compiled texture block count",
        block_count,
        limits.max_blocks,
    )?;
    let directory_start = checked_add(8, block_directory_offset, "block directory offset")?;
    let directory_length = checked_mul(
        block_count,
        BLOCK_DIRECTORY_ENTRY_LENGTH,
        "block directory length",
    )?;
    require_range_with_end(bytes, directory_start, directory_length, declared_size)?;

    let mut data_block = None;
    for index in 0..block_count {
        let entry = checked_add(
            directory_start,
            checked_mul(index, BLOCK_DIRECTORY_ENTRY_LENGTH, "block entry offset")?,
            "block entry offset",
        )?;
        let block_type = read_u32(bytes, entry)?;
        let relative_field = checked_add(entry, 4, "block relative-offset field")?;
        let relative = usize_from_u32(read_u32(bytes, relative_field)?, relative_field)?;
        let offset = checked_add(relative_field, relative, "block offset")?;
        let size = usize_from_u32(read_u32(bytes, entry + 8)?, entry + 8)?;
        let end = require_range_with_end(bytes, offset, size, declared_size)?;
        if block_type == DATA_BLOCK && data_block.replace(DataBlock { offset, end }).is_some() {
            return Err(invalid_texture(entry, "duplicate DATA block"));
        }
    }

    let data = data_block.ok_or_else(|| invalid_texture(directory_start, "missing DATA block"))?;
    if data.end != declared_size {
        return Err(invalid_texture(
            data.end,
            "texture payload does not immediately follow the DATA block",
        ));
    }
    Ok(data)
}

fn parse_texture_metadata(
    bytes: &[u8],
    data: DataBlock,
    limits: VtexDecodeLimits,
) -> Result<TextureMetadata> {
    require_range_with_end(bytes, data.offset, TEXTURE_HEADER_LENGTH, data.end)?;
    if read_u16(bytes, data.offset)? != 1 {
        return Err(invalid_texture(
            data.offset,
            "unsupported texture metadata version",
        ));
    }
    let flags = read_u16(bytes, data.offset + 2)?;
    if flags & (FLAG_CUBE_TEXTURE | FLAG_VOLUME_TEXTURE | FLAG_TEXTURE_ARRAY) != 0 {
        return Err(invalid_texture(
            data.offset + 2,
            "radar decoder accepts only two-dimensional textures",
        ));
    }
    let width = read_u16(bytes, data.offset + 20)?;
    let height = read_u16(bytes, data.offset + 22)?;
    let depth = read_u16(bytes, data.offset + 24)?;
    if depth != 1 {
        return Err(invalid_texture(
            data.offset + 24,
            format!("expected texture depth 1, got {depth}"),
        ));
    }
    let format = read_u8(bytes, data.offset + 26)?;
    let mip_levels = read_u8(bytes, data.offset + 27)?;
    if mip_levels == 0 || mip_levels > limits.max_mip_levels {
        return Err(invalid_texture(
            data.offset + 27,
            format!("invalid mip level count {mip_levels}"),
        ));
    }

    let extra_offset = usize_from_u32(read_u32(bytes, data.offset + 32)?, data.offset + 32)?;
    let extra_count = usize_from_u32(read_u32(bytes, data.offset + 36)?, data.offset + 36)?;
    enforce_limit(
        "compiled texture extra-data entry count",
        extra_count,
        limits.max_extra_entries,
    )?;
    let mut actual_width = width;
    let mut actual_height = height;
    let mut compressed_mips = None;
    let mut compressed = false;

    if extra_count > 0 {
        if extra_offset < 8 {
            return Err(invalid_texture(
                data.offset + 32,
                "extra-data relative offset is smaller than its base",
            ));
        }
        let current = checked_add(data.offset, TEXTURE_HEADER_LENGTH, "texture header end")?;
        let table = checked_add(current, extra_offset - 8, "extra-data table offset")?;
        let table_length = checked_mul(
            extra_count,
            BLOCK_DIRECTORY_ENTRY_LENGTH,
            "extra-data table length",
        )?;
        require_range_with_end(bytes, table, table_length, data.end)?;

        for index in 0..extra_count {
            let entry = checked_add(
                table,
                checked_mul(
                    index,
                    BLOCK_DIRECTORY_ENTRY_LENGTH,
                    "extra-data entry offset",
                )?,
                "extra-data entry offset",
            )?;
            let kind = read_u32(bytes, entry)?;
            let relative_field = entry + 4;
            let relative = usize_from_u32(read_u32(bytes, relative_field)?, relative_field)?;
            let payload = checked_add(relative_field, relative, "extra-data payload offset")?;
            let size = usize_from_u32(read_u32(bytes, entry + 8)?, entry + 8)?;
            require_range_with_end(bytes, payload, size, data.end)?;

            match kind {
                EXTRA_METADATA if size >= 6 => {
                    let candidate_width = read_u16(bytes, payload + 2)?;
                    let candidate_height = read_u16(bytes, payload + 4)?;
                    if candidate_width > 0
                        && candidate_height > 0
                        && candidate_width <= width
                        && candidate_height <= height
                    {
                        actual_width = candidate_width;
                        actual_height = candidate_height;
                    }
                }
                EXTRA_COMPRESSED_MIP_SIZE => {
                    if compressed_mips.is_some() {
                        return Err(invalid_texture(entry, "duplicate compressed-mip metadata"));
                    }
                    require_range_with_end(bytes, payload, 12, data.end)?;
                    let compression_flag = read_u32(bytes, payload)?;
                    if compression_flag > 1 {
                        return Err(invalid_texture(
                            payload,
                            format!("invalid compressed-mip flag {compression_flag}"),
                        ));
                    }
                    let sizes_relative =
                        usize_from_u32(read_u32(bytes, payload + 4)?, payload + 4)?;
                    let count = usize_from_u32(read_u32(bytes, payload + 8)?, payload + 8)?;
                    if count != usize::from(mip_levels) {
                        return Err(invalid_texture(
                            payload + 8,
                            format!(
                                "compressed-mip count {count} does not match {mip_levels} levels"
                            ),
                        ));
                    }
                    let sizes_start =
                        checked_add(payload + 4, sizes_relative, "compressed-mip size offset")?;
                    let sizes_length = checked_mul(count, 4, "compressed-mip size table")?;
                    require_range_with_end(bytes, sizes_start, sizes_length, data.end)?;
                    let mut sizes = Vec::with_capacity(count);
                    for mip in 0..count {
                        let offset = sizes_start + mip * 4;
                        let size = read_i32(bytes, offset)?;
                        if size <= 0 {
                            return Err(invalid_texture(
                                offset,
                                format!("invalid compressed mip size {size}"),
                            ));
                        }
                        sizes.push(usize::try_from(size).map_err(|_| {
                            invalid_texture(offset, "compressed mip size is not representable")
                        })?);
                    }
                    compressed = compression_flag == 1;
                    compressed_mips = Some(sizes);
                }
                _ => {}
            }
        }
    }

    Ok(TextureMetadata {
        flags,
        width,
        height,
        actual_width,
        actual_height,
        format,
        mip_levels,
        compressed_mips,
        compressed,
        payload_offset: data.end,
    })
}

fn validate_texture_shape(texture: &TextureMetadata, limits: VtexDecodeLimits) -> Result<()> {
    if texture.width == 0 || texture.height == 0 {
        return Err(invalid_texture(
            texture.payload_offset,
            "texture dimensions must be non-zero",
        ));
    }
    if texture.width > limits.max_dimension || texture.height > limits.max_dimension {
        return Err(SourceAssetError::LimitExceeded {
            kind: "compiled texture dimension",
            actual: u64::from(texture.width.max(texture.height)),
            limit: u64::from(limits.max_dimension),
        });
    }
    let pixels = checked_mul(
        usize::from(texture.width),
        usize::from(texture.height),
        "texture pixel count",
    )?;
    enforce_limit("compiled texture pixel count", pixels, limits.max_pixels)?;
    let decoded = checked_mul(pixels, 4, "decoded texture byte count")?;
    enforce_limit(
        "decoded compiled texture",
        decoded,
        limits.max_decoded_bytes,
    )
}

fn decode_embedded_image(
    bytes: &[u8],
    texture: &TextureMetadata,
    limits: VtexDecodeLimits,
) -> Result<DecodedVtexImage> {
    if texture.mip_levels != 1 || texture.compressed_mips.is_some() {
        return Err(invalid_texture(
            texture.payload_offset,
            "embedded browser images must contain exactly one uncompressed mip",
        ));
    }
    let tail = bytes
        .get(texture.payload_offset..)
        .ok_or_else(|| invalid_texture(texture.payload_offset, "missing texture payload"))?;
    let (mime_type, length) = match texture.format {
        15 | 17 => ("image/jpeg", validated_jpeg_length(tail)?),
        16 | 18 => ("image/png", validated_png_length(tail)?),
        29 | 30 => ("image/webp", validated_webp_length(tail)?),
        _ => {
            return Err(SourceAssetError::UnsupportedCompiledTextureFormat(
                texture.format,
            ));
        }
    };
    enforce_limit(
        "embedded compiled texture image",
        length,
        limits.max_encoded_bytes,
    )?;
    Ok(DecodedVtexImage {
        width: u32::from(texture.actual_width),
        height: u32::from(texture.actual_height),
        mime_type,
        bytes: tail[..length].to_vec(),
    })
}

fn read_largest_mip(bytes: &[u8], texture: &TextureMetadata) -> Result<Vec<u8>> {
    let mut cursor = texture.payload_offset;
    for mip in (1..texture.mip_levels).rev() {
        let raw_size = mip_size(texture.format, texture.width, texture.height, mip)?;
        let stored_size = texture
            .compressed_mips
            .as_ref()
            .map_or(raw_size, |sizes| raw_size.min(sizes[usize::from(mip)]));
        cursor = checked_add(cursor, stored_size, "mip payload offset")?;
        if cursor > bytes.len() {
            return Err(invalid_texture(cursor, "mip payload exceeds input"));
        }
    }

    let raw_size = mip_size(texture.format, texture.width, texture.height, 0)?;
    let stored_size = texture
        .compressed_mips
        .as_ref()
        .map_or(raw_size, |sizes| raw_size.min(sizes[0]));
    let stored = require_range(bytes, cursor, stored_size)?;
    if texture.compressed && stored_size < raw_size {
        let mut output = vec![0_u8; raw_size];
        let written = lz4_flex::block::decompress_into(stored, &mut output)
            .map_err(|error| SourceAssetError::TextureDecompression(error.to_string()))?;
        if written != raw_size {
            return Err(SourceAssetError::TextureDecompression(format!(
                "expected {raw_size} bytes, decoded {written}"
            )));
        }
        Ok(output)
    } else {
        if stored_size < raw_size {
            return Err(invalid_texture(
                cursor,
                "uncompressed mip is shorter than its declared format requires",
            ));
        }
        Ok(stored[..raw_size].to_vec())
    }
}

fn mip_size(format: u8, width: u16, height: u16, level: u8) -> Result<usize> {
    let width = usize::from((width >> level).max(1));
    let height = usize::from((height >> level).max(1));
    match format {
        1 | 27 => checked_mul(width.div_ceil(4), height.div_ceil(4), "BC block count")
            .and_then(|blocks| checked_mul(blocks, 8, "BC mip size")),
        2 | 19..=21 => checked_mul(width.div_ceil(4), height.div_ceil(4), "BC block count")
            .and_then(|blocks| checked_mul(blocks, 16, "BC mip size")),
        3 => checked_mul(width, height, "I8 mip size"),
        4 | 28 => checked_mul(width, height, "RGBA mip pixels")
            .and_then(|pixels| checked_mul(pixels, 4, "RGBA mip size")),
        22 => checked_mul(width, height, "IA88 mip pixels")
            .and_then(|pixels| checked_mul(pixels, 2, "IA88 mip size")),
        _ => Err(SourceAssetError::UnsupportedCompiledTextureFormat(format)),
    }
}

fn decode_pixels(bytes: &[u8], texture: &TextureMetadata) -> Result<Vec<u8>> {
    let width = usize::from(texture.width);
    let height = usize::from(texture.height);
    let pixels = checked_mul(width, height, "decoded pixel count")?;
    match texture.format {
        3 => Ok(bytes
            .iter()
            .flat_map(|value| [*value, *value, *value, 255])
            .collect()),
        4 => Ok(bytes.to_vec()),
        22 => Ok(bytes
            .chunks_exact(2)
            .flat_map(|pixel| [pixel[0], pixel[0], pixel[0], pixel[1]])
            .collect()),
        28 => Ok(bytes
            .chunks_exact(4)
            .flat_map(|pixel| [pixel[2], pixel[1], pixel[0], pixel[3]])
            .collect()),
        1 | 2 | 20 => {
            let mut decoded = vec![0_u32; pixels];
            let result = match texture.format {
                1 => texture2ddecoder::decode_bc1(bytes, width, height, &mut decoded),
                2 => texture2ddecoder::decode_bc3(bytes, width, height, &mut decoded),
                20 => texture2ddecoder::decode_bc7(bytes, width, height, &mut decoded),
                _ => unreachable!(),
            };
            result.map_err(|message| SourceAssetError::TextureDecompression(message.to_owned()))?;
            Ok(decoded
                .into_iter()
                .flat_map(|pixel| {
                    let bgra = pixel.to_le_bytes();
                    [bgra[2], bgra[1], bgra[0], bgra[3]]
                })
                .collect())
        }
        _ => Err(SourceAssetError::UnsupportedCompiledTextureFormat(
            texture.format,
        )),
    }
}

fn crop_rgba(bytes: &[u8], source_width: usize, width: usize, height: usize) -> Result<Vec<u8>> {
    if width == source_width
        && checked_mul(width, height, "cropped pixel count")?
            .checked_mul(4)
            .is_some_and(|length| length == bytes.len())
    {
        return Ok(bytes.to_vec());
    }
    let row_bytes = checked_mul(width, 4, "cropped row length")?;
    let source_row_bytes = checked_mul(source_width, 4, "source row length")?;
    let output_length = checked_mul(row_bytes, height, "cropped image length")?;
    let mut output = Vec::with_capacity(output_length);
    for row in 0..height {
        let start = checked_mul(row, source_row_bytes, "source row offset")?;
        output.extend_from_slice(require_range(bytes, start, row_bytes)?);
    }
    Ok(output)
}

fn encode_png(width: u16, height: u16, rgba: &[u8], limits: VtexDecodeLimits) -> Result<Vec<u8>> {
    let mut output = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut output, u32::from(width), u32::from(height));
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        let mut writer = encoder
            .write_header()
            .map_err(|error| SourceAssetError::PngEncoding(error.to_string()))?;
        writer
            .write_image_data(rgba)
            .map_err(|error| SourceAssetError::PngEncoding(error.to_string()))?;
        writer
            .finish()
            .map_err(|error| SourceAssetError::PngEncoding(error.to_string()))?;
    }
    enforce_limit("encoded radar PNG", output.len(), limits.max_encoded_bytes)?;
    Ok(output)
}

fn validated_png_length(bytes: &[u8]) -> Result<usize> {
    const SIGNATURE: &[u8; 8] = b"\x89PNG\r\n\x1a\n";
    if !bytes.starts_with(SIGNATURE) {
        return Err(invalid_texture(0, "embedded PNG signature is invalid"));
    }
    let mut offset = SIGNATURE.len();
    for _ in 0..4_096 {
        require_range(bytes, offset, 12)?;
        let length = usize::try_from(u32::from_be_bytes(
            bytes[offset..offset + 4]
                .try_into()
                .map_err(|_| invalid_texture(offset, "invalid PNG chunk length"))?,
        ))
        .map_err(|_| invalid_texture(offset, "PNG chunk length is not representable"))?;
        let chunk_end = checked_add(offset, checked_add(length, 12, "PNG chunk")?, "PNG")?;
        require_range(bytes, offset, chunk_end - offset)?;
        if &bytes[offset + 4..offset + 8] == b"IEND" {
            if length != 0 {
                return Err(invalid_texture(offset, "PNG IEND chunk is not empty"));
            }
            return Ok(chunk_end);
        }
        offset = chunk_end;
    }
    Err(invalid_texture(offset, "PNG contains too many chunks"))
}

fn validated_jpeg_length(bytes: &[u8]) -> Result<usize> {
    if !bytes.starts_with(&[0xff, 0xd8]) {
        return Err(invalid_texture(0, "embedded JPEG signature is invalid"));
    }
    bytes
        .windows(2)
        .rposition(|window| window == [0xff, 0xd9])
        .map(|offset| offset + 2)
        .ok_or_else(|| invalid_texture(bytes.len(), "embedded JPEG has no end marker"))
}

fn validated_webp_length(bytes: &[u8]) -> Result<usize> {
    require_range(bytes, 0, 12)?;
    if &bytes[..4] != b"RIFF" || &bytes[8..12] != b"WEBP" {
        return Err(invalid_texture(0, "embedded WebP signature is invalid"));
    }
    let size = usize_from_u32(read_u32(bytes, 4)?, 4)?;
    let length = checked_add(8, size, "WebP length")?;
    require_range(bytes, 0, length)?;
    Ok(length)
}

fn enforce_limit(kind: &'static str, actual: usize, limit: usize) -> Result<()> {
    if actual > limit {
        return Err(SourceAssetError::LimitExceeded {
            kind,
            actual: u64::try_from(actual).unwrap_or(u64::MAX),
            limit: u64::try_from(limit).unwrap_or(u64::MAX),
        });
    }
    Ok(())
}

fn checked_add(left: usize, right: usize, context: &'static str) -> Result<usize> {
    left.checked_add(right)
        .ok_or(SourceAssetError::ArithmeticOverflow(context))
}

fn checked_mul(left: usize, right: usize, context: &'static str) -> Result<usize> {
    left.checked_mul(right)
        .ok_or(SourceAssetError::ArithmeticOverflow(context))
}

fn require_range(bytes: &[u8], offset: usize, length: usize) -> Result<&[u8]> {
    let end = checked_add(offset, length, "compiled texture range")?;
    bytes
        .get(offset..end)
        .ok_or_else(|| invalid_texture(offset, "range exceeds input"))
}

fn require_range_with_end(
    bytes: &[u8],
    offset: usize,
    length: usize,
    allowed_end: usize,
) -> Result<usize> {
    let end = checked_add(offset, length, "compiled texture range")?;
    if end > allowed_end {
        return Err(invalid_texture(
            offset,
            "range exceeds its containing block",
        ));
    }
    require_range(bytes, offset, length)?;
    Ok(end)
}

fn read_u8(bytes: &[u8], offset: usize) -> Result<u8> {
    require_range(bytes, offset, 1).map(|value| value[0])
}

fn read_u16(bytes: &[u8], offset: usize) -> Result<u16> {
    let value = require_range(bytes, offset, 2)?;
    Ok(u16::from_le_bytes([value[0], value[1]]))
}

fn read_u32(bytes: &[u8], offset: usize) -> Result<u32> {
    let value = require_range(bytes, offset, 4)?;
    Ok(u32::from_le_bytes([value[0], value[1], value[2], value[3]]))
}

fn read_i32(bytes: &[u8], offset: usize) -> Result<i32> {
    let value = require_range(bytes, offset, 4)?;
    Ok(i32::from_le_bytes([value[0], value[1], value[2], value[3]]))
}

fn usize_from_u32(value: u32, offset: usize) -> Result<usize> {
    usize::try_from(value)
        .map_err(|_| invalid_texture(offset, "32-bit value is not representable on this platform"))
}

fn invalid_texture(offset: usize, message: impl Into<String>) -> SourceAssetError {
    SourceAssetError::InvalidCompiledTexture {
        offset,
        message: message.into(),
    }
}

#[cfg(test)]
mod tests {
    use std::io::Cursor;

    use super::*;

    #[test]
    fn decodes_bgra_texture_and_preserves_rgba_pixels() {
        let resource = build_resource(
            &texture_header(2, 1, 28, 1, &[]),
            &[0, 0, 255, 255, 0, 255, 0, 128],
        );
        let decoded = decode_vtex_to_browser_image(&resource).expect("decode BGRA texture");

        assert_eq!((decoded.width, decoded.height), (2, 1));
        assert_eq!(decoded.mime_type, "image/png");
        assert_eq!(
            decode_png(&decoded.bytes),
            vec![255, 0, 0, 255, 0, 255, 0, 128]
        );
    }

    #[test]
    fn decompresses_lz4_mip_with_declared_output_bound() {
        let raw = [0, 0, 255, 255].repeat(16);
        let compressed = lz4_flex::block::compress(&raw);
        assert!(compressed.len() < raw.len());
        let extra = compressed_mip_extra(compressed.len());
        let resource = build_resource(&texture_header(4, 4, 28, 1, &extra), &compressed);

        let decoded = decode_vtex_to_browser_image(&resource).expect("decode LZ4 texture");
        assert_eq!(decode_png(&decoded.bytes), [255, 0, 0, 255].repeat(16));
    }

    #[test]
    fn decodes_a_bc1_block_without_native_code() {
        let red_block = [0x00, 0xf8, 0x00, 0x00, 0, 0, 0, 0];
        let resource = build_resource(&texture_header(4, 4, 1, 1, &[]), &red_block);
        let decoded = decode_vtex_to_browser_image(&resource).expect("decode BC1 texture");
        let pixels = decode_png(&decoded.bytes);

        assert_eq!(&pixels[..4], &[255, 0, 0, 255]);
        assert!(
            pixels
                .chunks_exact(4)
                .all(|pixel| pixel == [255, 0, 0, 255])
        );
    }

    #[test]
    fn rejects_unknown_formats_and_out_of_bounds_blocks() {
        let resource = build_resource(&texture_header(1, 1, 99, 1, &[]), &[0; 4]);
        assert!(matches!(
            decode_vtex_to_browser_image(&resource),
            Err(SourceAssetError::UnsupportedCompiledTextureFormat(99))
        ));

        let mut corrupt = resource;
        corrupt[20..24].copy_from_slice(&u32::MAX.to_le_bytes());
        assert!(matches!(
            decode_vtex_to_browser_image(&corrupt),
            Err(SourceAssetError::ArithmeticOverflow(_)
                | SourceAssetError::InvalidCompiledTexture { .. })
        ));
    }

    #[test]
    fn enforces_decode_limits_before_allocation() {
        let resource = build_resource(&texture_header(2, 2, 28, 1, &[]), &[0; 16]);
        let limits = VtexDecodeLimits {
            max_pixels: 3,
            ..VtexDecodeLimits::default()
        };
        assert!(matches!(
            decode_vtex_to_browser_image_with_limits(&resource, limits),
            Err(SourceAssetError::LimitExceeded {
                kind: "compiled texture pixel count",
                ..
            })
        ));
    }

    fn texture_header(
        width: u16,
        height: u16,
        format: u8,
        mip_levels: u8,
        extra: &[u8],
    ) -> Vec<u8> {
        let mut data = Vec::with_capacity(TEXTURE_HEADER_LENGTH + extra.len());
        data.extend_from_slice(&1_u16.to_le_bytes());
        data.extend_from_slice(&0_u16.to_le_bytes());
        data.extend_from_slice(&[0; 16]);
        data.extend_from_slice(&width.to_le_bytes());
        data.extend_from_slice(&height.to_le_bytes());
        data.extend_from_slice(&1_u16.to_le_bytes());
        data.push(format);
        data.push(mip_levels);
        data.extend_from_slice(&0_u32.to_le_bytes());
        data.extend_from_slice(&(if extra.is_empty() { 0_u32 } else { 8 }).to_le_bytes());
        data.extend_from_slice(&u32::from(!extra.is_empty()).to_le_bytes());
        data.extend_from_slice(extra);
        data
    }

    fn compressed_mip_extra(compressed_size: usize) -> Vec<u8> {
        let mut extra = Vec::new();
        extra.extend_from_slice(&EXTRA_COMPRESSED_MIP_SIZE.to_le_bytes());
        extra.extend_from_slice(&8_u32.to_le_bytes());
        extra.extend_from_slice(&12_u32.to_le_bytes());
        extra.extend_from_slice(&1_u32.to_le_bytes());
        extra.extend_from_slice(&8_u32.to_le_bytes());
        extra.extend_from_slice(&1_u32.to_le_bytes());
        extra.extend_from_slice(
            &u32::try_from(compressed_size)
                .expect("compressed fixture size")
                .to_le_bytes(),
        );
        extra
    }

    fn build_resource(data: &[u8], payload: &[u8]) -> Vec<u8> {
        let data_offset = 28_usize;
        let declared_size = data_offset + data.len();
        let mut resource = Vec::with_capacity(declared_size + payload.len());
        resource.extend_from_slice(
            &u32::try_from(declared_size)
                .expect("fixture resource size")
                .to_le_bytes(),
        );
        resource.extend_from_slice(&RESOURCE_HEADER_VERSION.to_le_bytes());
        resource.extend_from_slice(&1_u16.to_le_bytes());
        resource.extend_from_slice(&8_u32.to_le_bytes());
        resource.extend_from_slice(&1_u32.to_le_bytes());
        resource.extend_from_slice(&DATA_BLOCK.to_le_bytes());
        resource.extend_from_slice(&8_u32.to_le_bytes());
        resource.extend_from_slice(
            &u32::try_from(data.len())
                .expect("fixture DATA size")
                .to_le_bytes(),
        );
        resource.extend_from_slice(data);
        resource.extend_from_slice(payload);
        resource
    }

    fn decode_png(bytes: &[u8]) -> Vec<u8> {
        let decoder = png::Decoder::new(Cursor::new(bytes));
        let mut reader = decoder.read_info().expect("read PNG header");
        let mut output = vec![0; reader.output_buffer_size().expect("PNG output bound")];
        let info = reader.next_frame(&mut output).expect("decode PNG");
        output.truncate(info.buffer_size());
        output
    }
}
