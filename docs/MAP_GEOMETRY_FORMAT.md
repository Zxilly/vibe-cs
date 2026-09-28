# VMAP map geometry

VMAP is the local cache and browser transport for Vibe CS's simplified Source 2
world geometry. The implementation is `crates/source-assets/src/geometry_binary.rs`.
It contains locally extracted collision geometry, never bundled game assets.

Coordinates remain Source game units, with Z up. Each component is rounded to
1/16 unit before welding. Decoding restores `f32` vertices and `u32` triangle
indices; it must not apply a map radar transform. Scene rendering handles the
Source-to-view coordinate basis separately.

The 32-byte header uses little-endian integers:

| Offset | Type | Meaning |
|---:|---|---|
| 0 | 4 bytes | ASCII `VMAP` |
| 4 | u16 | Version `1` |
| 6 | u16 | Coordinate scale `16` |
| 8 | u32 | Vertex count, 1–2,000,000 |
| 12 | u32 | Triangle count, 1–4,000,000 |
| 16 | u32 | Included physics shape count |
| 20 | u32 | Excluded physics shape count |
| 24 | u32 | Decompressed payload byte length, at most 128 MiB |
| 28 | u32 | CRC32/IEEE of the decompressed payload |

The remaining bytes are one complete **zlib** stream (DEFLATE with zlib wrapper,
not gzip or raw DEFLATE). Browsers can use `DecompressionStream('deflate')`.
Decoders must enforce the declared output bound while inflating, require stream
completion, reject trailing compressed bytes, and verify the CRC.

The decompressed payload consists of canonical unsigned base-128 varints:

1. `vertex_count * 3` coordinate values in XYZ order. Maintain three signed
   integer accumulators, initially zero. Zigzag-decode each value, add it to the
   corresponding axis accumulator, and divide by 16 to get the coordinate.
2. `triangle_count * 3` indices. Maintain one signed integer accumulator,
   initially zero. Zigzag-decode each value and add it to the accumulator. The
   result is the next zero-based vertex index.

Zigzag decoding is `(value >> 1) ^ -(value & 1)`. Each varint uses at most five
bytes; its fifth byte must be at most 15. Overlong encodings are rejected.
Decoded quantized coordinates must remain in `[-16,000,000, 16,000,000]` and
indices in `[0, vertex_count)`. No payload bytes may remain after all records.
Unsupported versions return an error; there is no compatibility reader.

For a reproducible local export and persisted round-trip check:

```powershell
cargo run --release --locked -p vibe-cs-source-assets --example geometry_export -- PATH_TO_MAP.vpk artifacts/simple-3d/map.vmap
```

The example prints counts, file size and the VPK-read-to-write time. It then
reads the file back and compares all quantized vertices, indices and shape
counts. Timing is measured with no Vibe CS geometry-cache lookup; operating
system file caches can still be warm.
