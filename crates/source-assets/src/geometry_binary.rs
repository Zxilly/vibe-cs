//! VMAP v1: 32-byte header, then zlib-compressed delta/zigzag varints.
//! All integers are little endian. Vertices are quantized to 1/16 Source unit.
//! Header: magic, u16 version, u16 scale, u32 vertex/triangle/included/excluded
//! counts, u32 inflated byte count, u32 CRC32 of the inflated bytes.
use std::io::Write;

use flate2::{Compression, Decompress, FlushDecompress, Status, write::ZlibEncoder};

use crate::{MapGeometry, Result, SourceAssetError};

const HEADER: usize = 32;
const MAX_BYTES: usize = 128 * 1024 * 1024;
const MAX_VERTICES: usize = 2_000_000;
const MAX_TRIANGLES: usize = 4_000_000;
const SCALE: f32 = 16.0;

fn invalid(message: impl Into<String>) -> SourceAssetError {
    SourceAssetError::InvalidPhysics(format!("VMAP: {}", message.into()))
}

fn write_delta(bytes: &mut Vec<u8>, value: i32, previous: &mut i32) -> Result<()> {
    let delta = i64::from(value) - i64::from(*previous);
    let mut encoded =
        u32::try_from((delta << 1) ^ (delta >> 63)).map_err(|_| invalid("delta overflow"))?;
    while encoded >= 128 {
        bytes.push(u8::try_from(encoded & 127).expect("seven bits") | 128);
        encoded >>= 7;
    }
    bytes.push(u8::try_from(encoded).expect("seven bits"));
    *previous = value;
    Ok(())
}

#[allow(
    clippy::cast_possible_truncation,
    reason = "bounded finite coordinate is explicitly quantized before integer conversion"
)]
fn quantized(value: f32) -> Result<i32> {
    if !value.is_finite() || value.abs() > 1_000_000.0 {
        return Err(invalid("invalid coordinate"));
    }
    Ok((value * SCALE).round() as i32)
}

fn counts(vertices: usize, triangles: usize) -> Result<()> {
    if vertices == 0 || triangles == 0 || vertices > MAX_VERTICES || triangles > MAX_TRIANGLES {
        return Err(invalid("geometry counts outside limits"));
    }
    Ok(())
}

/// Encode the canonical geometry for disk cache and browser transport.
pub fn encode_map_geometry(geometry: &MapGeometry) -> Result<Vec<u8>> {
    counts(geometry.vertices.len(), geometry.triangles.len())?;
    let mut payload = Vec::new();
    let mut previous = [0; 3];
    for vertex in &geometry.vertices {
        for (value, previous) in vertex.iter().zip(&mut previous) {
            write_delta(&mut payload, quantized(*value)?, previous)?;
        }
    }
    let mut previous_index = 0;
    for index in geometry.triangles.iter().flatten() {
        if *index as usize >= geometry.vertices.len() {
            return Err(invalid("triangle index outside vertex table"));
        }
        write_delta(
            &mut payload,
            i32::try_from(*index).map_err(|_| invalid("index overflow"))?,
            &mut previous_index,
        )?;
    }
    if payload.len() > MAX_BYTES {
        return Err(invalid("payload exceeds limit"));
    }
    let mut output = b"VMAP\x01\0\x10\0".to_vec();
    for count in [
        geometry.vertices.len(),
        geometry.triangles.len(),
        geometry.included_shapes,
        geometry.excluded_shapes,
        payload.len(),
    ] {
        output.extend_from_slice(
            &u32::try_from(count)
                .map_err(|_| invalid("header count overflow"))?
                .to_le_bytes(),
        );
    }
    output.extend_from_slice(&crc32fast::hash(&payload).to_le_bytes());
    let mut compressor = ZlibEncoder::new(output, Compression::default());
    compressor
        .write_all(&payload)
        .map_err(|error| invalid(error.to_string()))?;
    compressor
        .finish()
        .map_err(|error| invalid(error.to_string()))
}

struct Deltas<'a> {
    bytes: &'a [u8],
    offset: usize,
}

impl Deltas<'_> {
    fn next(&mut self, previous: &mut i32) -> Result<i32> {
        let mut value = 0_u32;
        for shift in [0, 7, 14, 21, 28] {
            let byte = *self
                .bytes
                .get(self.offset)
                .ok_or_else(|| invalid("truncated delta"))?;
            self.offset += 1;
            if shift == 28 && byte > 15 {
                return Err(invalid("delta overflow"));
            }
            value |= u32::from(byte & 127) << shift;
            if byte & 128 == 0 {
                if shift != 0 && byte == 0 {
                    return Err(invalid("noncanonical delta"));
                }
                let delta = i64::from(value >> 1) ^ -i64::from(value & 1);
                *previous = i32::try_from(i64::from(*previous) + delta)
                    .map_err(|_| invalid("coordinate/index overflow"))?;
                return Ok(*previous);
            }
        }
        Err(invalid("unterminated delta"))
    }
}

/// Decode an untrusted cache payload with allocation, index and checksum bounds.
#[allow(
    clippy::cast_precision_loss,
    reason = "quantized values are bounded to +/-16 million, exact as f32"
)]
pub fn decode_map_geometry(bytes: &[u8]) -> Result<MapGeometry> {
    if bytes.len() < HEADER || bytes.len() > MAX_BYTES || &bytes[..8] != b"VMAP\x01\0\x10\0" {
        return Err(invalid("unsupported or truncated header"));
    }
    let header = |offset| {
        u32::from_le_bytes([
            bytes[offset],
            bytes[offset + 1],
            bytes[offset + 2],
            bytes[offset + 3],
        ])
    };
    let vertices = header(8) as usize;
    let triangles = header(12) as usize;
    counts(vertices, triangles)?;
    let expected = header(24) as usize;
    if expected > MAX_BYTES || expected < (vertices + triangles) * 3 {
        return Err(invalid("inflated length outside limits"));
    }
    let mut decoder = Decompress::new(true);
    let mut payload = Vec::with_capacity(expected + 1);
    let status = decoder
        .decompress_vec(&bytes[HEADER..], &mut payload, FlushDecompress::Finish)
        .map_err(|error| invalid(error.to_string()))?;
    if status != Status::StreamEnd
        || payload.len() != expected
        || decoder.total_in() != (bytes.len() - HEADER) as u64
    {
        return Err(invalid("compressed stream length mismatch"));
    }
    if crc32fast::hash(&payload) != header(28) {
        return Err(invalid("checksum mismatch"));
    }
    let mut deltas = Deltas {
        bytes: &payload,
        offset: 0,
    };
    let mut geometry = MapGeometry {
        vertices: Vec::with_capacity(vertices),
        triangles: Vec::with_capacity(triangles),
        included_shapes: header(16) as usize,
        excluded_shapes: header(20) as usize,
    };
    let mut previous = [0; 3];
    for _ in 0..vertices {
        let mut vertex = [0.0; 3];
        for (out, previous) in vertex.iter_mut().zip(&mut previous) {
            let value = deltas.next(previous)?;
            if !(-16_000_000..=16_000_000).contains(&value) {
                return Err(invalid("coordinate outside world bounds"));
            }
            *out = value as f32 / SCALE;
        }
        geometry.vertices.push(vertex);
    }
    let mut previous_index = 0;
    for _ in 0..triangles {
        let mut triangle = [0; 3];
        for index in &mut triangle {
            let value = deltas.next(&mut previous_index)?;
            *index = u32::try_from(value).map_err(|_| invalid("negative triangle index"))?;
            if *index as usize >= vertices {
                return Err(invalid("triangle index outside vertex table"));
            }
        }
        geometry.triangles.push(triangle);
    }
    if deltas.offset != payload.len() {
        return Err(invalid("trailing geometry values"));
    }
    Ok(geometry)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mesh() -> MapGeometry {
        MapGeometry {
            vertices: vec![
                [-2000.0, 16.0, -256.0],
                [0.0625, 32.0, 48.0],
                [1024.0, 0.0, 256.0],
            ],
            triangles: vec![[0, 2, 1], [2, 0, 1]],
            included_shapes: 2,
            excluded_shapes: 3,
        }
    }

    #[test]
    fn round_trips_negative_coordinates_and_reused_triangle_indices() {
        let geometry = mesh();
        let bytes = encode_map_geometry(&geometry).unwrap();
        assert_eq!(decode_map_geometry(&bytes).unwrap(), geometry);
        for length in 0..bytes.len() {
            assert!(
                decode_map_geometry(&bytes[..length]).is_err(),
                "prefix {length}"
            );
        }
    }

    #[test]
    fn rejects_bombs_bad_checksums_versions_and_extra_stream_bytes() {
        let original = encode_map_geometry(&mesh()).unwrap();
        for (offset, replacement) in [
            (4, 2_u32),
            (8, u32::MAX),
            (12, u32::MAX),
            (24, u32::MAX),
            (28, 0),
        ] {
            let mut bytes = original.clone();
            bytes[offset..offset + 4].copy_from_slice(&replacement.to_le_bytes());
            assert!(decode_map_geometry(&bytes).is_err(), "offset {offset}");
        }
        let mut extra = original;
        extra.push(0);
        assert!(decode_map_geometry(&extra).is_err());
    }

    #[test]
    fn rejects_noncanonical_varints_and_invalid_mesh_input() {
        for bytes in [
            &[0x80, 0][..],
            &[0xff, 0xff, 0xff, 0xff, 0x10][..],
            &[0x80][..],
        ] {
            let mut deltas = Deltas { bytes, offset: 0 };
            assert!(deltas.next(&mut 0).is_err());
        }
        let mut geometry = mesh();
        geometry.triangles[0][0] = 3;
        assert!(encode_map_geometry(&geometry).is_err());
        geometry.triangles[0][0] = 0;
        geometry.vertices[0][0] = f32::NAN;
        assert!(encode_map_geometry(&geometry).is_err());
    }
}
