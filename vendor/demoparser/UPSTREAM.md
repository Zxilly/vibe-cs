# LaihoE/demoparser upstream record

This directory is a source-pinned vendor snapshot. It is not generated from the
current upstream branch during a Vibe CS build.

- Repository: <https://github.com/LaihoE/demoparser>
- Audited commit: `266a831f08b0264dd722b017a5c05d765206a7ed`
- Upstream release at that commit: `demoparser2` 0.42.0
- Vendored Rust package versions: `parser` 0.1.1 and `csgoproto` 0.1.5
- License: MIT; see `LICENSE`. The upstream license text at the pinned commit
  retains placeholder copyright fields, so release/legal review is still
  required before redistribution.

## Included and excluded content

Only the Rust `src/parser` and `src/csgoproto` package sources, their Cargo/build
files, README/rustfmt files, generated Rust protocol tables, and the repository
license are included. Bindings, `.git`, lockfiles, build output, the 60 MiB test
demo, the protocol update helper, and the unpinned `GameTracking-CS2` checkout
are excluded.

`UPSTREAM_FILES.sha256` records every mechanically copied upstream file before
local packaging changes. `MANIFEST.sha256` records the final vendored tree and
ends with a tree hash over its sorted file-hash records; the manifest excludes
itself to avoid a circular digest.

Run the checked-in verifier from the repository root before accepting or
shipping a vendor change:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\vendor\demoparser\verify-manifest.ps1
```

After reviewing an intentional change, regenerate the manifest with the same
script and `-Update`. The script hashes every non-ignored regular file, including
itself, sorts complete `<sha256>  <slash-separated-path>` records using ordinal
comparison, and hashes their UTF-8 (no BOM), LF-terminated body for
`TREE_SHA256`. `MANIFEST.sha256`, any `Cargo.lock`, and any `target` directory
are the only ignored paths. Links/reparse points are rejected. Consequently an
unexpected source, generated file, or documentation file makes verification
fail rather than silently falling outside the tree hash.

## Local packaging patches

The following narrow changes are permitted in this snapshot:

1. Both package manifests have an empty `[workspace]` table so each crate can be
   checked independently while remaining outside the Vibe CS root workspace.
2. `csgoproto/build.rs` consumes the generated `src/protobuf.rs` committed at the
   audited revision instead of cloning mutable `GameTracking-CS2` data at build
   time. The now-unused `prost-build` build dependency is removed.
3. `parser/build.rs` watches the committed generated protocol/map modules instead
   of invoking the `csgoproto` generator during compilation.
4. `parser::parse_demo` owns an explicit local Rayon pool. The public resource
   options default to at most eight threads, reject thread counts outside
   `1..=16`, and bound full-packet fan-out, aggregate game-event retention, and
   decompressed frame/message/string-table sizes before untrusted input can drive
   allocation. Snappy output lengths are checked before allocating their buffers.
5. The parser validates the complete 17-bit Huffman lookup table at construction,
   uses checked and tail-padded Huffman lookups with checked consumption, bounds
   entity identifiers, and returns typed resource-limit errors. Bit and byte reads
   fail closed at end-of-input before allocation; frame and message ranges use
   checked arithmetic instead of wrapping attacker-controlled sizes.
6. The optional mmap helper is now `unsafe` with an explicit stability contract;
   application code is expected to parse an owned byte buffer for untrusted demos.
7. Multi-threaded segments share one atomic event budget, so the configured limit
   applies to the whole parse rather than once per segment. String-table Snappy
   output is bounded before allocation and retained string-table bytes share one
   aggregate parser budget, including embedded full-packet baseline copies.
   Large first-pass baselines/string tables/player maps are shared by `Arc`; each
   segment keeps only its full-packet baseline delta instead of cloning the seed.
8. Purchase/sell-back correlation groups and sorts relevant events instead of
   repeatedly scanning the full event set, reducing the post-process from
   quadratic to `O(n log n)` while tolerating incomplete malformed events.
9. `parser/src/bin/parse_bench.rs` accepts an explicit Rayon thread count and emits
   a deterministic output checksum for real-demo resource/performance matrices.
10. The upstream 60 MiB `test_demo.dem` fixture is intentionally excluded. Default
   `cargo test --lib` runs the self-contained resource and malformed-input tests;
   the original upstream suite is gated by `--features upstream-fixture-tests`
   and may only be enabled after restoring the exact fixture from audited commit
   `266a831f08b0264dd722b017a5c05d765206a7ed` and verifying its provenance/hash.
11. Voice retention is explicit opt-in (off by default) and shares an aggregate
    encoded-byte budget across parallel segments. Inventory skins/item drops are
    skipped unless inventory was explicitly requested; requested inventory also
    shares an aggregate encoded-byte budget. End-of-match player identity remains
    available when inventory retention is disabled and is covered by that same
    retained-message budget.
12. Every collected player/dataframe row claims from a parser-wide atomic budget
    before any columns are appended. The configurable limit may be zero for
    event-only passes, is shared by all parallel segments, and prevents a demo
    with many fabricated player controllers from multiplying selected ticks into
    unbounded column storage.
13. First-pass `CMsgPlayerInfo.userid` evidence is retained by SteamID using the
    protocol's low byte. Conflicting observations remain explicitly unavailable
    instead of guessing a spectator slot; the application converts only unique,
    bounded evidence into CS2 `spec_player` input.

These parser hardening and resource-control changes are intentionally local and
covered by focused tests plus the ignored real-demo benchmark report. Future
functional patches must be isolated, tested, documented here, and represented in
the final hash manifest. Upstream updates require a new full commit hash,
provenance review, mechanical re-import, and regenerated manifests; never merge
an unreviewed moving branch into this directory.
