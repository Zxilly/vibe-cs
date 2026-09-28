# ARPL v2 · dense replay

ARPL v2 is the only whole-match replay wire format. The application writer is
`crates/application/src/replay_binary.rs`; the browser reader is
`apps/web/src/data/replayBinary.ts`. Version 1 is rejected, with no conversion path.
The separate producer-bound round replay contract remains RRPL.

## Source and sampling

`ReplayRequest::from_analysis` selects canonical player identities, round and
highlight bounds, event ticks and utility events. It omits statistics and embedded
analysis projections so the isolated worker request stays small. Extraction reads
the original Demo, verifies its analyzed size, SHA-256 and header tick metadata,
then samples player entities every 16 ticks and every 8 ticks inside highlights.
Event ticks and range endpoints are also requested. Missing packet ticks align to
the nearest actual packet within the requested bounds, at most 16 ticks away;
ties choose the earlier packet and duplicates collapse. Larger holes fail explicitly.

Whole-match and selected-round extraction share the player snapshot reader,
including pitch. A separate bounded grenade pass is necessary because the vendored
parser's projectile collection does not also collect player rows. Flying identity
contains both entity slot and wire serial, so slot reuse cannot join two flights.
Effect events provide smoke/fire lifetimes and bomb state. Approximate smoke/fire
circles are presentation aids, not reconstructed smoke volume or exact fire patches.

## Envelope

All fixed-width numbers are little endian. The 16-byte header contains:

| Offset | Type | Value |
|---|---|---|
| 0 | 4 bytes | `ARPL` |
| 4 | u16 | version 2 |
| 6 | u16 | flags 1: zlib |
| 8 | u32 | exact inflated payload length |
| 12 | u32 | CRC32 of inflated payload |

The remaining bytes are one zlib stream. Both compressed and inflated data are
bounded to 128 MiB. Readers reject truncation, trailing bytes, wrong lengths and CRC.

## Payload

1. Cache metadata: u32 JSON byte count, then UTF-8 JSON (at most 64 KiB).
2. Fidelity metadata: the same JSON framing.
3. Shared strings: u16 count, then each string as u16 byte count + UTF-8 bytes.
   At most 16,384 unique strings, each at most 512 bytes.
4. Roster: u16 count, then `(u16 id index, u16 name index, u8 team)`.
   Team 0 is A, 1 is B. At most 64 unique identities; names and teams stay stable.
5. Frames: u32 count, followed by the records below.

An optional string index is `0xffff` for null. Other indices must reference the
string table. Frame ticks strictly increase and match the fidelity start/end ticks.
At most 100,000 frames, 1,000,000 player records and 1,000,000 projectile records
are accepted across a stream.

### Frame

- u32 tick; u8 player count.
- For each player: u8 roster index; XYZ coordinate deltas; i16 yaw; i16 pitch;
  u8 health; u8 armor; u8 alive; u16 weapon index; u16 input mask.
- u16 projectile count (at most 512 in one frame).
- For each projectile: u16 id index; u16 kind index; optional u16 owner index;
  u8 flags; XYZ deltas; f32 radius; u32 start tick; u32 end tick.
- u8 bomb-present flag. When present: XYZ deltas; u16 state index;
  optional u16 carrier index.

Player indices and projectile identities cannot repeat within one frame. Boolean
fields accept only 0 or 1. Projectile flags are active=1, masks-vision=2, effect=4;
without effect the phase is flying. Radius NaN means null; finite radii are 0–4096.

Coordinates are rounded to 1/16 Source unit, then encoded as zigzag unsigned
varints of the difference from the previous quantized coordinate. Each roster
identity and projectile identity has its own XYZ accumulator; the bomb has one.
Accumulators start at zero and persist across frames where an identity is absent.
Coordinates are bounded to +/-1,000,000 units. Varints use at most five bytes and
must have their shortest encoding. Angles normalize to [-180,180), then use
1/128-degree fixed point. Input bits 0–9 are forward, left, backward, right, jump,
crouch, walk, reload, fire and secondary fire; `0xffff` means input unavailable.

## Cache and presentation

The runtime cache key includes the v2 extraction salt and source/analysis identity.
Its bounded JSON artifact is an internal storage representation, not another wire
version. Worker response and cache artifact limits are 512 MiB; cache eviction
retains the existing 512 MiB total budget. A real dense match occupies about 79 MB
before ARPL compression, so the previous 128 MiB artifact limit was insufficient
for longer matches.

Replay and highlight preview share one presentation interpolation function:
linear XYZ, shortest-path angles, preceding-sample discrete state, no interpolation
across respawns, death, teleports or large sample gaps. Effects expire at their
recorded lifetime even when the next frame is unavailable. A shared elapsed-time
clock retains fractional ticks and requests presentation updates about every 32 ms;
published URL positions and editing boundaries remain integer ticks.

## Verification

The committed synthetic `apps/web/src/data/test/fixtures/replay-v2.bin` is written
by the production Rust encoder. It covers negative/delta coordinates, pitch,
wraparound yaw, input masks, flights, effects and planted bomb state. Browser tests
read it and reject every truncated prefix, old versions, corruption and bad bounds.

Real files stay under ignored `artifacts/simple-3d/`. Opt-in tests use
`VIBE_REPLAY_V2_BIN` for browser decoding and `VIBE_DENSE_REPLAY_JSON`,
`VIBE_BASELINE_OUTPUT`, `VIBE_DENSE_REPLAY_BINARY` for the native size comparison.
`crates/demo/examples/replay_probe.rs` runs production extraction from a Demo and
normalized analysis JSON. Runtime's `real_major_m1_whole_replay_is_dense_and_reuses_its_cache`
uses `VIBE_CS_REAL_DEMO_DIR`, `VIBE_CS_REAL_ANALYSIS_JSON`, `VIBE_CS_REAL_WORKER`;
it creates an in-memory database and temporary cache, leaving user app data intact.
