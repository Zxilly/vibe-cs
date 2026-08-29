# Project workbench design QA

final result: passed

## Comparison target

- Source visual truth: `C:\Users\12009\.codex\generated_images\01a044dc-e4a6-7103-b96a-31a535e92c75\exec-e64a95ce-7302-4770-b145-796da6f17a24.png`.
- Browser-rendered implementation: `target/complete-preview/02-fixed.png`.
- Functional editor pass: `target/editor-iteration/03-transition.png`.
- Timeline snapping pass: `target/editor-iteration/04-snap-guide.png`.
- Overwrite and marker pass: `target/editor-iteration/05-overwrite-marker.png`.
- Full same-input comparison: `target/complete-preview/02-full-comparison.png`.
- Focused timeline comparison: `target/premiere-light/07-timeline-comparison.png`.
- Route: `http://localhost:5173/#/projects/9ee43da6-8d88-4428-b54f-e2420a6f0a3a`.
- State: real Project revision 11, Hook change Δ1 selected, transport at 01:48.967 on Anubis R13, 11/11 Story clips materialized.

## Viewport and normalization

- Source pixels: 1635 x 962.
- Implementation CSS viewport and screenshot: 1635 x 962 at device pixel ratio 1 through the active Tauri WebView2 CDP session.
- Full comparison uses both uncropped images at their native pixels.
- Focused comparison crop for both sides: x 0, y 486, width 1208, height 476.

## Findings

No actionable P0, P1, or P2 mismatch remains.

- One production Project Timeline Module now fills the entire lower workspace. The former page-level Change Summary, its old/current strips, and its private geometry are deleted.
- Agent changes are rendered against the canonical Story Track: change pins share the ruler and scroll transform; additions, removals, prior positions, old out points, duration deltas, and downstream ripple shifts decorate real clips rather than a second timeline.
- The timeline exposes only working tools: same-track additive selection, split at playhead, copy, paste, ripple-delete, and Change Group undo. Space, S, Delete, Ctrl/Cmd+C, Ctrl/Cmd+V, and Ctrl/Cmd+Z invoke the same Interfaces.
- Video, audio, and text tracks can be created through canonical `insert_track` operations; non-Story tracks can be removed through `remove_track`. Story audio remains a derived read-only waveform while independent audio clips use the normal move, trim, inspect, and delete path.
- The clip inspector exposes the transition vocabulary already consumed by the production renderer. Saved in/out transitions are visible on the canonical clip, not in a separate effects model.
- Timeline snapping follows a screen-space threshold like the reference editors: ten pixels are converted through the shared time scale; candidates include other clip edges, markers, and the playhead; moving clips compare both edges; Shift bypasses snapping; the active guide shares ruler geometry.
- Additive selection can span tracks. Batch delete and paste submit one Project Patch containing per-track replacements, with Story ripple semantics and free positioning preserved per track. Non-Story tracks can be reordered through the canonical `reorder_tracks` operation.
- Project media exposes distinct insert and overwrite edits. Insert keeps Story ripple semantics; overwrite removes only the covered interval, preserves surviving source ranges, and does not move the later timeline.
- Markers are editable canonical `EditingDocument.markers`: M or the visible tool adds one at the playhead; clicking seeks; double-clicking edits label, frame-snapped time, and colour; save and delete both use `replace_markers`.
- The Program Monitor and tactical view use a fixed equal split with one divider pixel. No separator role, drag handle, pointer capture, double-click reset, or keyboard resize path remains.
- Video uses `object-fit: contain` in a dedicated 594.83 x 344.84 canvas; its 40 px transport bar is outside that canvas with zero overlap. Radar and tactical overlay use the same centered 384.84 px square with no transform scaling.
- The editor has no inert footer controls. Project media, record-missing, and export are real human actions; imported media enters the canonical Story Track at transport time and ripples the split tail.
- The selected source depicts a staged `18.000s → 28.400s` replacement. The current managed Project contains a real full Story replacement instead. The non-equal replacement state is verified in `timelineChangeProjection.test.ts` and the page interaction fixture; no database or screenshot data was fabricated.
- The source depicts a pale generated radar while the implementation renders the actual decoded CS2 overview. Keeping the real radar is an intentional asset-fidelity constraint.
- The source depicts a populated Agent delivery session while this route was opened without a session query. The rail correctly renders its real empty-session state; conversation behavior is covered independently.

## Required fidelity surfaces

- Fonts and typography: native Chinese system sans and mono timecode stacks, 11–14 px hierarchy, weights, truncation, and compact labels match the target density.
- Spacing and layout rhythm: 56 px review header, 420 px Agent rail, split Program Monitor, full-height Timeline Module, annotation band, V1/A1 track heads, and footer align at the exact viewport.
- Colors and tokens: the entire workbench uses the light `.review-workbench` semantic palette from `theme.css`; additions, removals, focus, tool state, waveforms, and dividers retain semantic contrast.
- Image quality and assets: Program Monitor, real Take thumbnails, real waveforms, decoded radar, replay paths, and event positions use product data. No screenshot crop, custom SVG, CSS illustration, or placeholder asset substitutes them.
- Copy and content: revision, Change Group operation count, clip names, material state, sequence duration, and Agent state are runtime truth. Static interface copy follows the selected design.

## Interaction verification

- Dragged the global playhead across multiple clips through CDP. Final value was 111.35 seconds; `window.getSelection().toString()` remained empty.
- Transport time, transport clip, and edit selection are independent. A scrub from Hook to Anubis R13 kept Hook and Δ1 selected while Program Monitor and radar followed the Anubis transport location; revision stayed at 11.
- During a multi-stop scrub, the preview pool recorded 0 video mounts, 0 video removals, and 0 `src` mutations. Video element count remained 22 and the retained radar stayed visible.
- Timeline pointer gestures use `user-select: none`, `touch-action: none`, `preventDefault`, pointer capture, and requestAnimationFrame seek coalescing.
- Clip move/trim still commits one revision-bound Human Edit on pointer-up; pointer-move intermediates are not persisted.
- The inline change filter and previous/next navigation select the real changed clip and seek the shared transport.
- Browser page errors were empty after a final reload and interaction pass.
- The project media drawer listed 11 real assets with per-asset insert actions. Export opened a real confirmation dialog; recording was correctly disabled because the current Project had no planned clips.
- A live editor pass advanced the real development Project from revision 21 to 26: inserted one media asset, selected it, copied and pasted it at the playhead, added and removed a text track, and saved a `fade` transition. Every action produced one Project revision and the final page error list was empty.
- A second live pass reordered the two Story clips as revision 27, then held a clip five pixels off its neighbour. The editor visibly snapped it back to `00:14.000`; releasing the unchanged placement created no extra revision. Page errors remained empty.
- A third live pass overwrote the first 15.767 seconds at revision 28. Sequence duration stayed exactly 28 seconds and the covered Hook tail became 12.233 seconds without ripple. Revisions 29 and 30 added a marker and edited it to `开场` at `00:03.000`; page errors remained empty.

## Comparison history

1. `01-current.png`: independent Change Summary had been removed, but the first HMR state was incomplete.
2. `02-current.png`: inline changes worked, but zero-duration legacy placeholders consumed change numbers and the floating card obscured the video row.
3. `03-dragged.png`: zero-duration changes were removed and a shared-time annotation band prevented overlap.
4. `04-final.png`: the working left tool strip was added using existing Timeline Interfaces.
5. `05-final.png`: track-head truncation was corrected.
6. `07-final.png`: V1/A1 source-patch badges, real-media preview, exact playhead state, and the final light layout passed.
7. `target/transport-selection/01-fixed.png`: transport/selection coupling was removed and the preview split was made fixed; real scrub kept Δ1 stationary while preview advanced to Anubis R13.
8. `target/complete-preview/02-fixed.png`: video, radar, and tactical overlay were changed from cropped/zoomed presentation to complete contained presentation with non-overlapping transport chrome.
9. `target/editor-foundation/01-media-bin.png`: inert footer controls were removed and the human media/record/export workflow was verified in the live Tauri app.
10. `target/editor-iteration/03-transition.png`: real media insert, copy/paste, track add/remove, editable audio separation, and renderer-backed transition controls passed in Tauri.
11. `target/editor-iteration/04-snap-guide.png`: the shared time geometry renders the active snap guide at the real adjacent clip boundary.
12. `target/editor-iteration/05-overwrite-marker.png`: the live sequence preserves duration after overwrite and renders the edited `开场` marker at three seconds.

## Verification

- Focused timeline editing and workbench interaction tests: 40 passed.
- Full web suite: 256 files and 2895 tests passed.
- Strict i18n/layer lint and TypeScript build passed.
- Production Vite build passed.
