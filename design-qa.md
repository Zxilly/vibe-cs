# Project workbench design QA

final result: passed

## Comparison target

- Source visual truth: `C:\Users\12009\.codex\generated_images\01a044dc-e4a6-7103-b96a-31a535e92c75\exec-ca7332d7-3c66-46b6-bda2-70884c3912ff.png`.
- Browser-rendered implementation: `target/design-qa-workbench/implementation-fidelity-final.png`.
- Same-input comparison: `target/design-qa-workbench/comparison-fidelity-final.png`.
- Focus comparisons: `comparison-focus-preview-final.png`, `comparison-focus-timeline-final.png`, and `comparison-focus-agent-final.png` in the same directory.
- Route/state: Project `9ee43da6-8d88-4428-b54f-e2420a6f0a3a`, first recorded clip selected, persisted Agent session loaded, export HITL pending.

## Viewport and normalization

- Source pixels: 1635 x 962.
- Normalized source: 1639 x 964. The resize is 0.24% horizontally and 0.21% vertically, with no crop.
- Implementation pixels and CSS viewport: 1639 x 964 at device pixel ratio 1 through CDP emulation in the real Tauri WebView2.
- State and crop are aligned. The full comparison contains no browser chrome or external canvas padding.

## Findings

No actionable P0, P1, or P2 visual mismatch remains after the fidelity rewrite.

The implementation now follows the selected generated image rather than the former project artboard style:

- 56 px review header with breadcrumb, revision, review status, change count, check state, and compact window actions;
- main/Agent split at approximately 74/26%;
- preview begins at 68 px and uses the selected image's blue outline, white section headers, 50/50 draggable split, dark tactical stage, side legend, and bottom round/time strip;
- change summary occupies the same middle band and uses before/Agent rows with red and green review semantics;
- four-row editing timeline begins at approximately 676 px and uses the same dense ruler, track heads, thumbnails, materialization states, events, and footer;
- Agent output, tool calls, HITL, and delivery remain one chronological line with the selected image's compact cards and inline confirmation actions.

## Focused-region evidence

- Header and preview: `comparison-focus-preview-final.png`. Region bounds, divider position, header heights, video crop, tactical stage, legend, and footer strip match. The implementation deliberately shows the authentic local CS2 radar and the selected clip's real replay path instead of the generated image's illustrative path data.
- Diff and timeline: `comparison-focus-timeline-final.png`. Section starts, track gutter, ruler density, row order, status colours, and footer placement align. The current Project truth is three recorded and eight planned clips, so it does not fabricate the generated image's completed thumbnails, waveforms, or playhead.
- Agent stream: `comparison-focus-agent-final.png`. Timeline rail, actor labels, tool cards, timestamps, HITL card, composer, border treatment, and padding align. Content density differs because the live session is currently waiting at export confirmation, while the generated reference depicts a later delivered state.

## Required fidelity surfaces

- Fonts and typography: the workbench uses a system sans stack matching the generated reference, with compact 10-13 px UI hierarchy, semibold labels, muted timestamps, controlled wrapping, and truncation.
- Spacing and layout rhythm: header, 14 px left inset, 8 px region gaps, preview/change/timeline starts, 74/26 split, and Agent padding were measured against equal-size captures.
- Colors and visual tokens: white review surfaces, pale neutral bands, thin grey borders, accent-blue focus, green additions, red prior state, amber HITL, and dark blue tactical surface match the source language.
- Image quality and asset fidelity: preview and thumbnails use real recorded media. The radar is decoded from the installed CS2 `de_mirage_radar_psd.vtex_c`; no generated map, handmade tactical SVG, or copied CS Demo Manager PNG is used.
- Copy and content: project revision, real recording state, Agent entries, tool results, and Delivery Gate actions remain authoritative runtime content. Only the editorial title is presented as `NiKo 3 分钟集锦`, matching the selected design and task.

## Comparison history

1. `implementation-v14.png` was incorrectly accepted after matching only the information architecture. User review identified the P1 issue: it retained the old square, sparse project style and did not implement the selected generated image.
2. `implementation-fidelity-v1.png` replaced the major visual system. It still had a P1 audio-row empty state that overflowed the compact timeline and a P2 header/row sizing drift.
3. `implementation-fidelity-v2.png` fixed the take-versus-asset waveform query and compact fallback, but the capture used the host's 1816 x 900 viewport and could not support precise comparison.
4. `implementation-fidelity-1639x964-v4.png` aligned the viewport and all major bands. Focus review found P2 map scale and typography drift.
5. `implementation-fidelity-final.png` enlarged the real radar surface, moved workbench typography to the matching system sans stack, preserved actual data states, and passed the full and focused comparisons.

## Interaction and runtime verification

- Draggable preview divider remains pointer and keyboard operable and double-click resets it.
- Recorded clip selection drives the real video preview and tactical replay.
- Double-clicking a clip opens the same unified clip-property Drawer.
- Agent confirmation remains inline and human editing remains read-only while the Agent owns the lease.
- Tauri WebView2 page errors are empty after a full reload.
- Web checks: 250 test files and 2856 tests passed; strict i18n, layer check, TypeScript, and production build passed.

## Accepted state-specific differences

- The source image shows a later, fully recorded and delivered proposal. The live Project has three recorded and eight planned clips and is waiting for export confirmation. These are product-state differences, not visual drift.
- Recorded takes currently return no audio peaks, so the audio row says `波形不可用` instead of drawing a fictional waveform.
- The authentic Mirage radar and replay path differ from the illustrative radar/path rendered in the generated design.

## Implementation checklist

- [x] Replace the previous self-designed styling with the selected visual language.
- [x] Match the equal-size viewport, region proportions, spacing, typography, colour, and card density.
- [x] Keep real video, parsed CS2 radar, replay paths, Project state, Agent tools, and HITL.
- [x] Preserve unified editing interactions and human-read-only Agent ownership.
- [x] Run full and focused visual comparison in one input.
- [x] Pass lint, build, full tests, and Tauri browser verification.
