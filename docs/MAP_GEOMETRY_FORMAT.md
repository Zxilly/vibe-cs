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
| 4 | u16 | Version `3` |
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
3. Convex-solid count, then a vertex count and vertex-index sequence for each
   original convex hull. Every count is a zigzag varint relative to zero;
   each solid's index accumulator starts at zero. A solid has at least three
   vertices; total references are bounded by 12,000,000.
4. Closed-mesh count, then a triangle count and triangle-index sequence for
   each original physics mesh. Counts and sequences use the same reset rules.
   Each group has at least four triangles. Triangle references must be in
   range and unique across all groups. Original winding is preserved, including
   oppositely oriented inner shells that represent cavities.

Both group counts are bounded by the included shape count. The native runtime
uses this membership for solid-interior queries. The browser validates it,
then retains only the vertex/index render arrays.

Zigzag decoding is `(value >> 1) ^ -(value & 1)`. Each varint uses at most five
bytes; its fifth byte must be at most 15. Overlong encodings are rejected.
Decoded quantized coordinates must remain in `[-16,000,000, 16,000,000]` and
indices in `[0, vertex_count)`. No payload bytes may remain after all records.
Unsupported versions return an error; there is no compatibility reader.

## Collision filtering

The extractor retains default world collision and explicit `solid`,
`CONTENTS_SOLID`, or `blocklos` geometry. It excludes window/no-LOS, sky,
player/NPC/navigation/grenade/drone-only clips and light/sound-only tools.
`passbullets` alone is used for grates and railings and does not establish an
opaque barrier; an explicit solid tag still takes precedence unless a no-LOS
tag is also present. Unknown interaction tags fail extraction.

Surface properties provide a second, independent filter. The installed CS2
`toolsblockbullets_cs` material is invisible (`mapbuilder.nodraw=1`) and uses
the `blockbullets` surface token (`2711388870`). Those faces are excluded even
inside a default solid mesh. A mesh's nonempty `m_Materials` table specifies
one surface index per triangle; otherwise the descriptor's surface applies.
Indices and table lengths are checked before use. Closed-shell membership is
computed after filtering so removed tool faces cannot seal an interior.

Extraction revision `vibe-map-geometry-4` invalidates earlier cached filtering
results; the wire format remains VMAP v3. This is static collision-based
previsualization: it does not reconstruct material alpha, individual grate
holes, moving doors, breakable-state changes or rendered smoke opacity.

For a reproducible local export and persisted round-trip check:

```powershell
cargo run --release --locked -p vibe-cs-source-assets --example geometry_export -- PATH_TO_MAP.vpk artifacts/simple-3d/map.vmap
```

The example prints counts, file size and the VPK-read-to-write time. It then
reads the file back and compares all quantized vertices, indices and shape
counts. Timing is measured with no Vibe CS geometry-cache lookup; operating
system file caches can still be warm.

## Application cache and routes

The runtime stores each map below `app-data/map-geometry/<map>/`. The filename
is a SHA-256 key over the extraction/format revision, canonical installation
path, VPK byte length and nanosecond modification time. A changed package is
rebuilt on its next geometry request. Publication is atomic; obsolete files
for that map are retired only after a replacement is complete. Directory
capabilities prevent reads, writes and cleanup from following cache junctions
into unrelated files. Damaged content is checked and regenerated on load.

These are internal application-dispatcher routes, carried through Tauri IPC:

- `GET /api/source-assets/map-geometry`: generated cache file count and total
  bytes, independent of the current CS2 installation.
- `GET /api/source-assets/map-geometry/<map>`: a verified VMAP, generated when
  missing or stale. MIME is `application/vnd.vibe-cs.map-geometry`; `no-store`
  prevents a browser HTTP cache from hiding package updates.
- `DELETE /api/source-assets/map-geometry`: clear generated disk files and the
  resident camera BVH. Returns 204 when complete. The next consumer regenerates
  the map automatically.

Settings expose only usage and one cleanup action. Cache inspection does not
extract maps. Cleanup shares the generation lock, including when a requesting
view closes during extraction; workers cannot publish old data after cleanup.
Only generated VMAP files are removed, with directory junctions skipped and
file identities verified. The complete payload, checksum and indices are
validated before serving cached bytes.

The browser decodes VMAP only in `data/mapGeometryBinary.ts`, yielding a
`Float32Array` of XYZ positions and a `Uint32Array` of triangle indices.
`data/mapGeometry.ts` owns query caching and cleanup invalidation. Active views
retain their presented mesh until it is needed again rather than immediately
recreating a just-cleared cache. Changes to CS2 configuration invalidate both
cache usage and geometry queries. Typed arrays
skip JSON structural sharing and unused map data expires after one minute.

The development map is an original floor/wall/boxes fixture generated through
the Rust production extractor; see `crates/source-assets/tests/fixtures/README.md`.
