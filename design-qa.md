# Project workbench design QA

final result: passed

## Comparison target

- Source visual truth: `C:\Users\12009\.codex\generated_images\01a044dc-e4a6-7103-b96a-31a535e92c75\exec-ca7332d7-3c66-46b6-bda2-70884c3912ff.png`
- Browser-rendered implementation: `target/design-qa-workbench/implementation-v14.png`
- Same-input comparison: `target/design-qa-workbench/comparison-v2.png`
- Route/state: Project `9ee43da6-8d88-4428-b54f-e2420a6f0a3a`, first recorded clip selected, persisted Agent session loaded, export HITL pending.

## Viewport and normalization

- Source: 1639 × 964 px.
- Implementation capture: 2724 × 1350 px from the real Tauri WebView2.
- Implementation CSS viewport: 1816 × 900 at device pixel ratio 1.5.
- Normalization: implementation was proportionally resized to 1639 × 812 and vertically padded to 1639 × 964. No horizontal stretching or content crop was used. The source remained at 1639 × 964.
- The different desktop aspect ratios are therefore visible as neutral padding rather than being misreported as spacing drift.

## Full-view comparison

The final composition matches the selected source at the product-structure level:

- compact project/revision/status header;
- one docked video/tactical split with a draggable divider;
- PR-style before/Agent change summary;
- unified timeline with recorded/unrecorded state;
- one chronological Agent/tool/HITL column at roughly one quarter of the viewport;
- no global side navigation, search field, editing-mode switch, top-level record/export controls, or per-history undo button inside the focused workbench.

No actionable P0, P1, or P2 mismatch remains.

## Focused-region evidence

- Preview region: `target/design-qa-workbench/implementation-v14.png` shows a real recorded Take beside the locally parsed Mirage radar. The tactical panel contains replay-derived paths and player markers for the selected Capture Intent.
- Timeline: the same capture shows real video thumbnails, explicit materialization state, and derived event rows rather than empty placeholder tracks.
- Agent/HITL: the right column is scrolled to the latest tool result and inline `允许导出 / 拒绝` request. Human editing remains separate and opens only through the on-demand clip Drawer.
- Interaction checks in the real WebView2: divider keyboard adjustment changed 52 → 54; double-clicking a clip opened `片段属性`; Escape closed the Drawer; browser page errors were empty.

## Required fidelity surfaces

- Fonts and typography: existing Barlow / Barlow Condensed product tokens are retained. Hierarchy, compact metadata, monospace time/revision labels, wrapping, and truncation follow the source's dense desktop-editor character.
- Spacing and layout rhythm: main region proportions, divider, 150 px change summary, multi-row timeline, and 24 vw Agent column align with the source. Square corners and hairline borders follow the repository design system.
- Colors and visual tokens: neutral surfaces, charcoal preview stage, restrained accent blue, green applied/recorded state, amber pending state, and red prior-version state map to existing tokens.
- Image quality and asset fidelity: video thumbnails and preview use real recorded media. The radar is decoded read-only from the installed CS2 `de_mirage_radar_psd.vtex_c`; no generated map, handmade SVG, or placeholder art remains.
- Copy and content: project revision, real 3/11 recording state, actual Agent messages/tool outputs, Delivery Gate warning, and HITL actions are authoritative runtime content rather than mock copy.

## Comparison history

1. `implementation-v1.png` — blocked by P1 legacy shell chrome and persistent action clutter. Fixed by focused project shell, compact title bar, removal of duplicate mode/record/export/undo controls, and on-demand clip properties.
2. `implementation-v2.png` — blocked by P1 tactical radar clipping and P2 sparse timeline/old conversation position. The radar parser was checked against CS Demo Manager and a real local VTEX probe. The actual cause was an implicit max-content grid track: preview width 2013 px inside a 1380 px column. Fixed with an explicit `minmax(0, 1fr)` track and `min-width: 0` at preview seams. Timeline thumbnails/status/event rows and Agent auto-scroll were added.
3. `implementation-v14.png` — post-fix capture. Preview width equals its owning column, no overlap with the Agent panel, the complete radar is visible, and the latest HITL is in view. Passed.

## Accepted constraints and P3 follow-up

- The implementation uses the authentic CS2 overview rather than the mock's simplified tactical drawing. This is intentional and more accurate.
- The current Project has no editable audio track, so the timeline uses real materialization and event rows instead of inventing a waveform. When an audio track exists, its native track row should render normally.
- The 28 px native drag/window-control strip remains above the project header; it is required by the frameless Tauri window and is intentionally excluded from product-content fidelity.

## Implementation checklist

- [x] Remove legacy workbench chrome and redundant buttons.
- [x] Match source region proportions and information hierarchy.
- [x] Parse and render the real local CS2 radar.
- [x] Overlay selected-clip replay paths and player positions.
- [x] Keep tool calls, HITL, and delivery inside one Agent stream.
- [x] Verify primary interactions and browser errors in Tauri WebView2.
