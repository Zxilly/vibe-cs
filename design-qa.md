# Project workbench design QA

final result: passed

## Comparison target

- Source visual truth: `C:\Users\12009\.codex\generated_images\01a044dc-e4a6-7103-b96a-31a535e92c75\exec-ca7332d7-3c66-46b6-bda2-70884c3912ff.png`.
- Normalized source: `target/design-qa-workbench/reference-normalized-1639x964.png`.
- Browser-rendered implementation: `target/design-qa-workbench/production-all-recorded-final.png`.
- Full same-input comparison: `target/design-qa-workbench/production-comparison-final.png`.
- Exact timeline comparison: `target/design-qa-workbench/production-timeline-comparison-final.png`.
- Route/state: Project `9ee43da6-8d88-4428-b54f-e2420a6f0a3a`, revision 11, all 11 Timeline Clips materialized, first clip selected, real Agent session loaded.

## Viewport and normalization

- Source pixels: 1635 x 962, normalized without crop to 1639 x 964.
- Implementation CSS viewport and screenshot: 1639 x 964 at device pixel ratio 1 in the real Tauri WebView2.
- Exact timeline crop for both sides: x 0, y 676, width 1213, height 288.
- Both source and implementation depict a fully recorded three-minute proposal.

## Findings

No actionable P0, P1, or P2 visual mismatch remains.

- The complete video row contains eleven real Take thumbnails.
- The complete audio row contains eleven real, symmetric waveforms; no planned placeholder or fabricated envelope remains.
- Header/ruler bands, track head, video/audio/marker/event proportions, footer, zoom controls, playhead, and review actions share the selected source's density and hierarchy.
- The source's red/green edit regions and mid-timeline playhead are illustrative content states. The implementation renders the authoritative revision-11 Change Group, events, and current playhead instead of copying mock values.
- The source tactical image is illustrative. The implementation uses the locally decoded CS2 radar and real replay path.

## Unified design system

- `design/review/ReviewPanel` owns the repeated PR-style panel Interface used by preview, diff, and Project Timeline.
- `theme.css` owns the system font stack, closed 3/4/6/full radius scale, and 190 px track-head token.
- `design/timeline/timeScale.ts` is the only time geometry for ruler ticks, Timeline Placement, markers, events, zoom, and playhead.
- The layer lint permits only named radius tokens and rejects arbitrary radius values.
- The page-private `workbenchReview.css`, Barlow font declarations, five unused WOFF2 files, and their license file were deleted.

## Production Module structure

- `domain/editing/ProjectTimeline` is a deep Module over the canonical Editing Document. Its Interface receives the document, selection, preview time, and selection/inspect callbacks; it does not create another editable timeline.
- Every visible Timeline Track produces a visible row. The former accessibility-only `Story · Music` assertion path was deleted.
- `domain/editing/timelineMaterial` is the shared material seam used by Program Monitor and Project Timeline. Imported assets and recorded Takes are the two real adapters; planned is a Materialization state, not an adapter.
- `ProjectWorkspacePage.tsx` no longer owns ruler math, clip widths, waveform resolution, track interpretation, or footer/playhead formatting.
- `CONTEXT.md` defines Project Timeline and `AGENTS.md` prohibits page-private timeline geometry/styles.

## Recording and waveform proof

- The Project now reports 11 recorded and 0 planned Timeline Clips at revision 11.
- All eleven waveform queries resolve real Take peak buckets.
- Native AAC waveform decoding accepts valid contiguous planar channel storage.
- HLAE bridge reasserts observer lock before validation, reports exact record-start failures, ignores late duplicate start events, and uses the fixed closed command's capture-stop tick.
- Dropped image-sequence frames are retimed to authoritative `startMovieWav` duration; a 75% floor still rejects materially incomplete Takes.
- Media Foundation read-back accepts equivalent rational frame-rate normalization within one per mille.
- Duplicate HLAE take directories are fully revalidated inside the managed capture root before recoverable cleanup.
- Anubis R10 sustained POV observer drift after retry. Per the disclosed direct-edit rule, revision 10 changed only that Capture Intent from `pov` to `tracking` in Change Group `e6126eef-99ce-402e-9418-b4c1736a6af0`; the final tracking Take then completed.

## Required fidelity surfaces

- Fonts and typography: one system sans stack, compact weights, timecode hierarchy, wrapping, and truncation are design-system owned.
- Spacing and layout rhythm: exact viewport/crop comparison confirms the header, 74/26 split, panel insets, timeline bands, track gutter, and footer placement.
- Colors and visual tokens: neutral review surfaces, accent focus/playhead/waveforms, semantic diff colours, warning HITL, and dark tactical surface use named tokens.
- Image and asset fidelity: every visible video thumbnail, waveform, and radar is real local media or parsed CS2 data.
- Copy and content: revision, materialization counts, Agent entries, tool results, markers, events, and time values are runtime truth.

## Comparison history

1. `implementation-v14.png`: blocked by the self-designed workbench and timeline.
2. `timeline-waveform-v3.png`: timeline structure aligned and three real waveforms appeared; eight planned clips still blocked a same-state comparison.
3. `production-timeline-v1.png`: all available tracks moved behind the ProjectTimeline Interface and page-private styling was removed; five clips were still planned.
4. `production-all-recorded-final.png`: all eleven Takes, thumbnails, and waveforms are present under the unified design system. Full and focused comparisons passed.

## Verification

- Web suite: 253 files, 2856 tests passed.
- Strict i18n compile, layer check, TypeScript, and production build passed.
- `cargo fmt --check` passed.
- Clippy with warnings denied passed for `vibe-cs-hlae`, `vibe-cs-runtime`, and `vibe-cs-platform-windows`.
- HLAE bridge suite: 19 passed.
- Tauri WebView2 page errors are empty.
