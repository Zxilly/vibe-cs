# Project workbench design QA

final result: blocked

## Comparison target

- Source visual truth: `C:\Users\12009\.codex\generated_images\01a044dc-e4a6-7103-b96a-31a535e92c75\exec-ca7332d7-3c66-46b6-bda2-70884c3912ff.png`.
- Normalized source: `target/design-qa-workbench/reference-normalized-1639x964.png`.
- Browser-rendered implementation: `target/design-qa-workbench/timeline-waveform-v3.png`.
- Full same-input comparison: `target/design-qa-workbench/comparison-timeline-fidelity-v3.png`.
- Exact timeline comparison: `target/design-qa-workbench/timeline-comparison-v3.png`.
- Route: Project `9ee43da6-8d88-4428-b54f-e2420a6f0a3a`, persisted Agent session `71ba4057-3c14-427d-a359-5dc3c88cc07f`.

## Viewport and normalization

- Source pixels: 1635 x 962, normalized without crop to 1639 x 964.
- Implementation CSS viewport and screenshot: 1639 x 964 at device pixel ratio 1 in the real Tauri WebView2.
- Exact timeline crop for both sides: x 0, y 676, width 1213, height 288.
- Theme and route match. Product state does not yet match: the source depicts a fully recorded timeline, while the live Project has three recorded and eight planned clips.

## Findings

- [P1] Eight planned clips cannot show the reference's thumbnails and audio envelopes.
  - Location: timeline video and audio tracks after 00:48.
  - Evidence: the source contains recorded thumbnails and waveforms across the complete three-minute proposal; the implementation truthfully shows media only for three compatible Takes and empty planned ranges for eight clips.
  - Impact: a claim of complete visual equality would require fabricated media or a different product state.
  - Fix: run the eight pending recordings after explicit human confirmation, then recapture the same state and repeat the exact comparison.

No other actionable P0, P1, or P2 timeline mismatch remains.

## Fixed timeline fidelity surfaces

- Layout: title and ruler bands, 190 px track gutter, video/audio/marker/event proportions, 50 px footer, section borders, and full panel bounds now align with the exact source crop.
- Track heads: video camera/visibility/lock, audio add/volume/lock, marker, and event controls follow the source ordering and density.
- Clip strip: duration-proportional cells, thumbnail crop, overlay glyphs, title strip, selection ring, and planned state share one implementation path.
- Waveform: recorded Takes now render real peak buckets as a symmetric blue envelope; the timeline no longer displays a large empty-state card.
- Marker and event rows: the marker row reads actual `EditingDocument.markers` and no longer mislabels recording state as markers; events retain the clip-derived editorial categories.
- Playhead: the blue rule and time chip use the real selected clip position plus current preview time.
- Footer: exact duration including milliseconds, recorded/planned legend, blocking view, settings, grid, and list controls are present.

## Waveform defect diagnosis and proof

- Original live repro: all three recorded Takes returned HTTP-style 500 command failures with `native FFmpeg operation failed: truncated decoded audio frame`.
- External FFmpeg decoded the same AAC stereo stream successfully.
- Instrumentation showed `F32(Planar)`, 1024 samples, two channels, plane lengths `[8192, 0]`: both planar channels were stored contiguously in the primary buffer while the second plane pointer was empty.
- The shared native audio-frame reader now accepts a valid independent plane first and falls back to bounded contiguous primary storage. Waveform and audio-intelligence callers use the same implementation.
- Original live repro after the fix: all three Take endpoints returned 120 real buckets. Maximum amplitudes were approximately 0.303, 0.328, and 0.437.
- Debug instrumentation and the throwaway probe were removed.

## Required fidelity surfaces

- Fonts and typography: system sans, compact UI weights, timestamp hierarchy, truncation, and timecode typography match the source.
- Spacing and layout rhythm: exact viewport and timeline crop were compared side by side; persistent bands and gutters align.
- Colors and visual tokens: blue waveform/playhead, neutral grid, dark thumbnail captions, semantic green events, and muted planned state match the selected design language.
- Image and asset fidelity: every visible thumbnail and waveform comes from a real compatible Take. No waveform, thumbnail, or tactical asset is fabricated for planned clips.
- Copy and content: duration, recording counts, event categories, marker content, and playback time are runtime data, not mock values from the source image.

## Comparison history

1. `implementation-v14.png`: blocked by P1 self-designed workbench and timeline styling.
2. `implementation-fidelity-final.png`: main composition aligned, but the timeline still had wrong row heights, no visible waveform, recording state in the marker row, two missing footer controls, and no playhead.
3. `timeline-waveform-v1.png`: exposed the real backend waveform failure rather than treating the empty UI as a design-only problem.
4. `timeline-waveform-v2.png`: real symmetric waveforms appeared, but the timeline band heights and marker semantics still differed.
5. `timeline-waveform-v3.png`: all timeline styling and available-media rendering issues are fixed. The remaining P1 is the explicit product-state mismatch named above.

## Verification

- `cargo test -p vibe-cs-media`: 22 passed.
- `cargo clippy -p vibe-cs-media --all-targets -- -D warnings`: passed.
- `cargo fmt --check`: passed.
- Web suite: 250 files, 2857 tests passed.
- Strict i18n compile, web layer check, TypeScript, and production build passed.
- Tauri WebView2 page errors are empty.

## Blocking next action

Explicit human confirmation is required before CS2/HLAE records the eight planned clips. After those Takes exist, reload the Project, verify all eleven real envelopes and thumbnails, recapture at 1639 x 964, and change `final result` to `passed` only if the exact comparison has no P0/P1/P2 finding.
