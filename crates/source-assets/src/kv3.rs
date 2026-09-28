//! Bounded binary KV3 v5 reader for locally installed Source 2 physics.
//!
//! Format reference: `ValveResourceFormat` `BinaryKV3.cs`, revision
//! b20af3819872f010da71c74c47e79191bb070c97 (MIT).
//! See ../licenses/ValveResourceFormat-MIT.txt. Older versions are explicitly
//! rejected; this is not a text KV3 parser or a compatibility layer.
use std::collections::BTreeMap;

use crate::{Result, SourceAssetError};

// Inferno's current PHYS blob alone is 141,610,742 bytes. The total remains
// bounded before decompression; smaller maps allocate only their declared size.
const MAX_BYTES: usize = 256 * 1024 * 1024;
const MAX_VALUES: usize = 4_000_000;
const TRAILER: u32 = 0xffee_dd00;

#[derive(Debug, Clone, PartialEq)]
pub enum Kv3Value {
    Null,
    Bool(bool),
    Integer(i64),
    Unsigned(u64),
    Float(f64),
    String(String),
    Blob(Vec<u8>),
    Array(Vec<Self>),
    Object(BTreeMap<String, Self>),
}

fn invalid(message: impl Into<String>) -> SourceAssetError {
    SourceAssetError::InvalidPhysics(message.into())
}

#[derive(Default)]
struct Reader<'a> {
    bytes: &'a [u8],
    position: usize,
}

impl<'a> Reader<'a> {
    fn new(bytes: &'a [u8]) -> Self {
        Self { bytes, position: 0 }
    }
    fn take(&mut self, size: usize) -> Result<&'a [u8]> {
        let end = self
            .position
            .checked_add(size)
            .ok_or_else(|| invalid("offset overflow"))?;
        let value = self
            .bytes
            .get(self.position..end)
            .ok_or_else(|| invalid("truncated data"))?;
        self.position = end;
        Ok(value)
    }
    fn number<const N: usize>(&mut self) -> Result<[u8; N]> {
        self.take(N)?
            .try_into()
            .map_err(|_| invalid("invalid number"))
    }
    fn byte(&mut self) -> Result<u8> {
        Ok(self.take(1)?[0])
    }
    fn u32(&mut self) -> Result<u32> {
        Ok(u32::from_le_bytes(self.number()?))
    }
    fn count(&mut self) -> Result<usize> {
        let count = self.u32()? as usize;
        if count > MAX_BYTES {
            return Err(invalid(format!(
                "count {count} at byte {} exceeds physics allocation limit {MAX_BYTES}",
                self.position - 4
            )));
        }
        Ok(count)
    }
    fn align(&mut self, alignment: usize) -> Result<()> {
        let padding = (alignment - self.position % alignment) % alignment;
        self.take(padding)?;
        Ok(())
    }
    fn empty(&self) -> bool {
        self.position == self.bytes.len()
    }
}

#[derive(Default)]
struct Lanes<'a> {
    one: Reader<'a>,
    two: Reader<'a>,
    four: Reader<'a>,
    eight: Reader<'a>,
}

impl<'a> Lanes<'a> {
    fn read(reader: &mut Reader<'a>, counts: [usize; 4]) -> Result<Self> {
        let mut lanes = Vec::with_capacity(4);
        for (count, width) in counts.into_iter().zip([1, 2, 4, 8]) {
            if count > 0 {
                reader.align(width)?;
            }
            lanes.push(Reader::new(
                reader.take(
                    count
                        .checked_mul(width)
                        .ok_or_else(|| invalid("lane size overflow"))?,
                )?,
            ));
        }
        let mut lanes = lanes.into_iter();
        Ok(Self {
            one: lanes.next().unwrap(),
            two: lanes.next().unwrap(),
            four: lanes.next().unwrap(),
            eight: lanes.next().unwrap(),
        })
    }
    fn empty(&self) -> bool {
        self.one.empty() && self.two.empty() && self.four.empty() && self.eight.empty()
    }
}

/// Extract and decode the PHYS block of a compiled world physics model.
pub fn decode_physics_kv3(resource: &[u8]) -> Result<Kv3Value> {
    if resource.len() > MAX_BYTES {
        return Err(invalid("resource exceeds physics input limit"));
    }
    let mut header = Reader::new(resource);
    let size = header.count()?;
    if size != resource.len() {
        return Err(invalid("resource length does not match header"));
    }
    if u16::from_le_bytes(header.number()?) != 12 {
        return Err(invalid("unsupported resource header version"));
    }
    header.take(2)?;
    let directory = header
        .count()?
        .checked_add(8)
        .ok_or_else(|| invalid("directory offset overflow"))?;
    let count = header.count()?;
    if count > 64 || directory < 16 {
        return Err(invalid("invalid resource block directory"));
    }
    header.take(directory - 16)?;
    let directory_end = directory + count * 12;
    let mut physics = None;
    for _ in 0..count {
        let kind = header.take(4)?;
        let base = header.position;
        let offset = header
            .count()?
            .checked_add(base)
            .ok_or_else(|| invalid("block offset overflow"))?;
        let length = header.count()?;
        let end = offset
            .checked_add(length)
            .ok_or_else(|| invalid("block length overflow"))?;
        if offset < directory_end {
            return Err(invalid("resource block overlaps directory"));
        }
        let data = resource
            .get(offset..end)
            .ok_or_else(|| invalid("resource block outside input"))?;
        if kind == b"PHYS" && physics.replace(data).is_some() {
            return Err(invalid("duplicate PHYS block"));
        }
    }
    decode(physics.ok_or_else(|| invalid("missing PHYS block"))?)
}

fn decompress(input: &mut Reader<'_>, method: u32, packed: usize, size: usize) -> Result<Vec<u8>> {
    if size > MAX_BYTES {
        return Err(invalid("decompressed buffer exceeds limit"));
    }
    let bytes = input.take(if method == 0 { size } else { packed })?;
    let out = match method {
        0 => bytes.to_vec(),
        1 => {
            lz4_flex::block::decompress(bytes, size).map_err(|error| invalid(error.to_string()))?
        }
        2 => zstd::bulk::decompress(bytes, size).map_err(|error| invalid(error.to_string()))?,
        _ => return Err(invalid("unsupported KV3 compression")),
    };
    if out.len() != size {
        return Err(invalid("decompressed buffer size mismatch"));
    }
    Ok(out)
}

fn decode(bytes: &[u8]) -> Result<Kv3Value> {
    let mut input = Reader::new(bytes);
    if input.u32()? != 0x4b56_3305 {
        return Err(invalid("only binary KV3 version 5 is supported"));
    }
    input.take(16)?; // format GUID
    let method = input.u32()?;
    let dictionary = u16::from_le_bytes(input.number()?);
    let frame_size = usize::from(u16::from_le_bytes(input.number()?));
    if dictionary != 0 || !matches!((method, frame_size), (0 | 2, 0) | (1, 16384)) {
        return Err(invalid("unsupported KV3 compression parameters"));
    }
    let one = input.count()?;
    let four = input.count()?;
    let eight = input.count()?;
    let type_count = input.count()?;
    input.take(4)?; // legacy object and array counters
    let total_size = input.count()?;
    let packed_total = input.count()?;
    let blob_count = input.count()?;
    let blob_size = input.count()?;
    let two = input.count()?;
    let block_sizes_bytes = input.count()?;
    let size1 = input.count()?;
    let packed1 = input.count()?;
    let size2 = input.count()?;
    let packed2 = input.count()?;
    let counts2 = [
        input.count()?,
        input.count()?,
        input.count()?,
        input.count()?,
    ];
    input.take(4)?;
    let object_count = input.count()?;
    input.take(8)?;
    if size1 + size2 != total_size || total_size + blob_size > MAX_BYTES {
        return Err(invalid(
            "KV3 total decompressed size exceeds limit or disagrees with buffers",
        ));
    }
    let buffer1 = decompress(&mut input, method, packed1, size1)?;
    let buffer2 = decompress(&mut input, method, packed2, size2)?;
    let mut first = Reader::new(&buffer1);
    let mut auxiliary = Lanes::read(&mut first, [one, two, four, eight])?;
    let string_count = auxiliary.four.count()?;
    if string_count > MAX_VALUES {
        return Err(invalid("too many KV3 strings"));
    }
    let mut strings = Vec::new();
    for _ in 0..string_count {
        let remaining = &auxiliary.one.bytes[auxiliary.one.position..];
        let length = remaining
            .iter()
            .position(|byte| *byte == 0)
            .ok_or_else(|| invalid("unterminated KV3 string"))?;
        strings.push(
            std::str::from_utf8(auxiliary.one.take(length)?)
                .map_err(|_| invalid("invalid KV3 UTF-8"))?
                .to_owned(),
        );
        auxiliary.one.take(1)?;
    }
    if !first.empty() {
        return Err(invalid("unexpected bytes in first KV3 buffer"));
    }
    let mut second = Reader::new(&buffer2);
    let objects = Reader::new(second.take(object_count * 4)?);
    let lanes = Lanes::read(&mut second, counts2)?;
    let types = Reader::new(second.take(type_count)?);
    let lengths = Reader::new(second.take(blob_count * 4)?);
    if second.u32()? != TRAILER {
        return Err(invalid("invalid KV3 buffer trailer"));
    }
    let mut blobs = Vec::new();
    if blob_count > 0 {
        if method == 1 {
            let mut frame_lengths = Reader::new(second.take(block_sizes_bytes)?);
            while blobs.len() < blob_size {
                let packed = usize::from(u16::from_le_bytes(frame_lengths.number()?));
                let size = frame_size.min(blob_size - blobs.len());
                let dictionary_start = blobs.len().saturating_sub(65536);
                let block = lz4_flex::block::decompress_with_dict(
                    input.take(packed)?,
                    size,
                    &blobs[dictionary_start..],
                )
                .map_err(|error| invalid(error.to_string()))?;
                if block.len() != size {
                    return Err(invalid("LZ4 blob frame size mismatch"));
                }
                blobs.extend_from_slice(&block);
            }
            if !frame_lengths.empty() {
                return Err(invalid("unused LZ4 blob frames"));
            }
        } else {
            if block_sizes_bytes != 0 {
                return Err(invalid("unexpected blob frame table"));
            }
            let packed = if method == 0 {
                0
            } else {
                packed_total
                    .checked_sub(packed1 + packed2)
                    .ok_or_else(|| invalid("invalid compressed total"))?
            };
            blobs = decompress(&mut input, method, packed, blob_size)?;
        }
        if input.u32()? != TRAILER {
            return Err(invalid("invalid KV3 blob trailer"));
        }
    } else if blob_size != 0 || block_sizes_bytes != 0 {
        return Err(invalid("blob bytes without blobs"));
    }
    if !second.empty() || !input.empty() {
        return Err(invalid("trailing KV3 bytes"));
    }
    let mut context = Context {
        lanes,
        auxiliary,
        types,
        objects,
        lengths,
        blobs: Reader::new(&blobs),
        strings,
        remaining: MAX_VALUES,
        string_bytes_remaining: MAX_BYTES,
    };
    let kind = context.kind()?;
    let value = context.value(kind, 0)?;
    if !context.lanes.empty()
        || !context.auxiliary.empty()
        || !context.types.empty()
        || !context.objects.empty()
        || !context.lengths.empty()
        || !context.blobs.empty()
    {
        return Err(invalid("unconsumed KV3 values"));
    }
    Ok(value)
}

struct Context<'a> {
    lanes: Lanes<'a>,
    auxiliary: Lanes<'a>,
    types: Reader<'a>,
    objects: Reader<'a>,
    lengths: Reader<'a>,
    blobs: Reader<'a>,
    strings: Vec<String>,
    remaining: usize,
    string_bytes_remaining: usize,
}

impl Context<'_> {
    fn kind(&mut self) -> Result<u8> {
        let mut kind = self.types.byte()?;
        if kind & 0x80 != 0 {
            kind &= 0x3f;
            self.types.byte()?;
        }
        Ok(kind)
    }
    fn string(&mut self) -> Result<String> {
        let index = self.lanes.four.u32()?;
        if index == u32::MAX {
            return Ok(String::new());
        }
        let value = self
            .strings
            .get(index as usize)
            .ok_or_else(|| invalid("KV3 string index outside table"))?;
        self.string_bytes_remaining = self
            .string_bytes_remaining
            .checked_sub(value.len())
            .ok_or_else(|| invalid("expanded KV3 strings exceed allocation budget"))?;
        Ok(value.clone())
    }
    fn value(&mut self, kind: u8, depth: usize) -> Result<Kv3Value> {
        if depth > 64 || self.remaining == 0 {
            return Err(invalid("KV3 nesting or value limit exceeded"));
        }
        self.remaining -= 1;
        Ok(match kind {
            1 => Kv3Value::Null,
            2 => Kv3Value::Bool(self.lanes.one.byte()? == 1),
            3 => Kv3Value::Integer(i64::from_le_bytes(self.lanes.eight.number()?)),
            4 => Kv3Value::Unsigned(u64::from_le_bytes(self.lanes.eight.number()?)),
            5 => Kv3Value::Float(f64::from_le_bytes(self.lanes.eight.number()?)),
            6 => Kv3Value::String(self.string()?),
            7 => {
                let length = self.lengths.count()?;
                Kv3Value::Blob(self.blobs.take(length)?.to_vec())
            }
            8 | 10 | 24 | 25 => {
                let count = if kind >= 24 {
                    usize::from(self.lanes.one.byte()?)
                } else {
                    self.lanes.four.count()?
                };
                if count > self.remaining {
                    return Err(invalid(format!(
                        "KV3 array type {kind} count {count} exceeds remaining value budget {}",
                        self.remaining
                    )));
                }
                let subtype = if kind == 8 { None } else { Some(self.kind()?) };
                if kind == 25 {
                    std::mem::swap(&mut self.lanes, &mut self.auxiliary);
                }
                let mut array = Vec::new();
                for _ in 0..count {
                    let child = if let Some(subtype) = subtype {
                        subtype
                    } else {
                        self.kind()?
                    };
                    array.push(self.value(child, depth + 1)?);
                }
                if kind == 25 {
                    std::mem::swap(&mut self.lanes, &mut self.auxiliary);
                }
                Kv3Value::Array(array)
            }
            9 => {
                let count = self.objects.count()?;
                if count > self.remaining {
                    return Err(invalid("KV3 object exceeds value budget"));
                }
                let mut object = BTreeMap::new();
                for _ in 0..count {
                    let child = self.kind()?;
                    let name = self.string()?;
                    if object.insert(name, self.value(child, depth + 1)?).is_some() {
                        return Err(invalid("duplicate KV3 object key"));
                    }
                }
                Kv3Value::Object(object)
            }
            11 => Kv3Value::Integer(i64::from(i32::from_le_bytes(self.lanes.four.number()?))),
            12 => Kv3Value::Unsigned(u64::from(self.lanes.four.u32()?)),
            13 | 14 => Kv3Value::Bool(kind == 13),
            15 | 16 => Kv3Value::Integer(i64::from(kind - 15)),
            17 | 18 => Kv3Value::Float(f64::from(kind - 17)),
            19 => Kv3Value::Float(f64::from(f32::from_le_bytes(self.lanes.four.number()?))),
            20 => Kv3Value::Integer(i64::from(i16::from_le_bytes(self.lanes.two.number()?))),
            21 => Kv3Value::Unsigned(u64::from(u16::from_le_bytes(self.lanes.two.number()?))),
            23 => Kv3Value::Integer(i64::from(self.lanes.one.byte()?)),
            _ => return Err(invalid(format!("unsupported KV3 node type {kind}"))),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // A PHYS object with one named binary blob. The format is assembled here
    // independently of the decoder, including both compressed buffers.
    fn fixture(method: u32, payload: &[u8]) -> Vec<u8> {
        let mut first = b"mesh\0".to_vec();
        first.resize(8, 0);
        first.extend_from_slice(&1_u32.to_le_bytes());
        let mut second = 1_u32.to_le_bytes().to_vec();
        second.extend_from_slice(&0_u32.to_le_bytes());
        second.extend_from_slice(&[9, 7]);
        second.extend_from_slice(&u32::try_from(payload.len()).unwrap().to_le_bytes());
        second.extend_from_slice(&TRAILER.to_le_bytes());
        let pack = |bytes: &[u8]| match method {
            0 => bytes.to_vec(),
            1 => lz4_flex::block::compress(bytes),
            2 => zstd::bulk::compress(bytes, 1).unwrap(),
            _ => unreachable!(),
        };
        let blob = pack(payload);
        if method == 1 {
            second.extend_from_slice(&u16::try_from(blob.len()).unwrap().to_le_bytes());
        }
        let packed_first = pack(&first);
        let packed_second = pack(&second);
        let packed = |size: usize| {
            if method == 0 {
                0
            } else {
                u32::try_from(size).unwrap()
            }
        };
        let mut header = vec![0x4b56_3305];
        header.extend([0; 4]); // GUID
        header.extend([
            method,
            if method == 1 { 16384 << 16 } else { 0 },
            5,
            1,
            0,
            2,
            1,
            u32::try_from(first.len() + second.len()).unwrap(),
            packed(packed_first.len() + packed_second.len() + blob.len()),
            1,
            u32::try_from(payload.len()).unwrap(),
            0,
            if method == 1 { 2 } else { 0 },
            u32::try_from(first.len()).unwrap(),
            packed(packed_first.len()),
            u32::try_from(second.len()).unwrap(),
            packed(packed_second.len()),
            0,
            0,
            1,
            0,
            0,
            1,
            0,
            0,
        ]);
        let mut bytes: Vec<u8> = header.into_iter().flat_map(u32::to_le_bytes).collect();
        bytes.extend(packed_first);
        bytes.extend(packed_second);
        bytes.extend(blob);
        bytes.extend(TRAILER.to_le_bytes());
        bytes
    }

    fn resource(physics: &[u8]) -> Vec<u8> {
        let mut bytes = u32::try_from(28 + physics.len())
            .unwrap()
            .to_le_bytes()
            .to_vec();
        bytes.extend_from_slice(&[12, 0, 1, 0]);
        bytes.extend_from_slice(&8_u32.to_le_bytes());
        bytes.extend_from_slice(&1_u32.to_le_bytes());
        bytes.extend_from_slice(b"PHYS");
        bytes.extend_from_slice(&8_u32.to_le_bytes());
        bytes.extend_from_slice(&u32::try_from(physics.len()).unwrap().to_le_bytes());
        bytes.extend_from_slice(physics);
        bytes
    }

    #[test]
    fn decodes_physics_blobs_for_all_supported_compression_methods() {
        let payload = b"real geometry is stored in binary blobs";
        for method in 0..=2 {
            let value = decode_physics_kv3(&resource(&fixture(method, payload))).unwrap();
            assert_eq!(
                value,
                Kv3Value::Object(BTreeMap::from([(
                    "mesh".to_owned(),
                    Kv3Value::Blob(payload.to_vec())
                )]))
            );
        }
    }

    #[test]
    fn rejects_every_truncated_prefix_without_panicking() {
        for method in 0..=2 {
            let bytes = fixture(method, b"geometry");
            for length in 0..bytes.len() {
                assert!(
                    decode(&bytes[..length]).is_err(),
                    "method {method}, prefix {length}"
                );
            }
        }
    }

    #[test]
    fn rejects_unknown_versions_allocation_bombs_and_corrupt_trailers() {
        let valid = fixture(2, b"geometry");
        for (offset, value) in [
            (0, 0x4b56_3304),
            (20, 99),
            (48, u32::MAX),
            (64, u32::MAX),
            (72, u32::MAX),
        ] {
            let mut bytes = valid.clone();
            bytes[offset..offset + 4].copy_from_slice(&value.to_le_bytes());
            assert!(decode(&bytes).is_err(), "header offset {offset}");
        }
        let mut bytes = valid;
        *bytes.last_mut().unwrap() = 0;
        assert!(decode(&bytes).is_err());
    }

    #[test]
    fn rejects_blocks_overlapping_resource_directory() {
        let mut bytes = resource(&fixture(0, b"geometry"));
        bytes[20..24].copy_from_slice(&0_u32.to_le_bytes());
        assert!(decode_physics_kv3(&bytes).is_err());
    }

    #[test]
    #[ignore = "requires VIBE_CS2_INSTALL pointing at a real CS2 installation"]
    fn decodes_real_mirage_physics() {
        let root = std::path::PathBuf::from(
            std::env::var_os("VIBE_CS2_INSTALL").expect("VIBE_CS2_INSTALL"),
        );
        let archive = crate::VpkArchive::open(root.join("game/csgo/maps/de_mirage.vpk")).unwrap();
        let bytes = archive.read("maps/de_mirage/world_physics.vmdl_c").unwrap();
        let Kv3Value::Object(fields) = decode_physics_kv3(&bytes).unwrap() else {
            panic!("physics object")
        };
        assert!(matches!(fields.get("m_parts"), Some(Kv3Value::Array(parts)) if !parts.is_empty()));
        assert!(
            matches!(fields.get("m_collisionAttributes"), Some(Kv3Value::Array(attributes)) if !attributes.is_empty())
        );
    }
}
