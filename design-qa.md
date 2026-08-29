# Project workbench design QA

final result: passed

## Comparison target

- Source visual truth: `C:\Users\12009\.codex\generated_images\01a044dc-e4a6-7103-b96a-31a535e92c75\exec-e64a95ce-7302-4770-b145-796da6f17a24.png`.
- Browser-rendered implementation: `target/complete-preview/02-fixed.png`.
- Functional editor pass: `target/editor-iteration/03-transition.png`.
- Timeline snapping pass: `target/editor-iteration/04-snap-guide.png`.
- Overwrite and marker pass: `target/editor-iteration/05-overwrite-marker.png`.
- In/Out range pass: `target/editor-iteration/06-in-out.png`.
- Ripple trim pass: `target/editor-iteration/07-ripple-trim.png`.
- Transport and track-target pass: `target/editor-iteration/08-transport-target.png`.
- Track layout pass: `target/editor-iteration/09-track-layout.png`.
- Marquee selection pass: `target/editor-iteration/10-marquee.png`.
- Clip gain pass: `target/editor-iteration/11-clip-gain.png`.
- Clip fade pass: `target/editor-iteration/12-clip-fade.png`.
- Playback page-scroll pass: `target/editor-iteration/13-playback-scroll.png`.
- Edit drag auto-scroll pass: `target/editor-iteration/14-drag-scroll.png`.
- Marquee auto-scroll pass: `target/editor-iteration/15-marquee-scroll.png`.
- Linked selection pass: `target/editor-iteration/16-linked-selection.png`.
- Linked group trim pass: `target/editor-iteration/17-linked-trim.png`.
- Transform keyframe pass: `target/editor-iteration/18-transform-keyframes.png`.
- Transform preview pass: `target/editor-iteration/19-transform-preview.png`.
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
- I/O or the visible header controls mark a frame-aligned time range on the shared ruler geometry. Extract removes that range from the current target: Story closes the interval while free tracks retain absolute later placements.
- Premiere Q/W ripple trims use the same selected Story clip, transport playhead, trim constraints, and `replace_track_clips` commit path as pointer trimming. Trimming the first Story clip now preserves the original track origin.
- One Timeline Transport now owns J/K/L shuttle state, 1×/2×/4× direction changes, pause, frame stepping, and previous/next edit-point navigation. Forward playback drives the warm media pool; reverse playback advances the same timeline through an rAF clock without assigning an invalid negative HTML video rate.
- Exact sequence end retains the last clip and presented frame, so transport controls remain available for reverse playback. Continuous playback time is frame-snapped only at edit commit seams, keeping monitoring smooth while preventing sub-frame placements and markers.
- V/A/T track-head badges are real target controls. Single-group paste and In/Out extraction use the explicit target; multi-track clipboard groups retain their original tracks. Targeting remains navigational while an Agent edit lease makes mutation read-only.
- Rendered tracks have independent production heights instead of fractional squeeze: video 84px, audio 64px, text 52px, marker/event 44px. The track viewport scrolls vertically when their sum exceeds available space; each editable row can collapse to 32px or resize between 32px and 180px through its shared separator.
- Shift-click selects the contiguous clip range from the primary anchor without acquiring a move gesture. Ctrl/Cmd+A selects every clip on the explicit target track; Ctrl/Cmd additive selection remains cross-track.
- Background drag uses the reference editor's five-pixel activation threshold to separate click-to-seek from marquee selection. The live selection box intersects real clip DOM geometry across visible tracks; Ctrl/Cmd preserves the pre-drag set, while buttons and height separators cannot start a box gesture.
- Dragging an already-selected member preserves the group. Story groups move as one ordered ripple block; free-track groups share one frame-snapped delta and retain their internal gaps. A completed group drag still commits one `replace_track_clips` operation.
- Audio clips expose a canonical gain rubber-band over the real waveform. Linear renderer volume 0–4 maps to −60dB through +12.04dB; pointer drag previews dB continuously and commits one `replace_clip` on release, while Arrow and Shift+Arrow nudge 1dB and 3dB. Story's derived waveform permits gain edits without becoming independently movable or trimmable.
- Audio waveform corners expose renderer-backed fade-in/out handles. Dragging previews the triangular envelope and stores `transition_in/out = fade` plus frame-snapped `metadata.transition_duration` only on release; keyboard adjusts by one frame or 0.25 seconds. Dual fades remain at least one frame below half the clip duration.
- Adjacent fade-out/fade-in handles use separate vertical corners. Waveforms are pointer-transparent and clip parents do not create isolated stacking contexts, so both handles remain hittable at a shared edit boundary.
- During transport playback, the horizontal viewport follows an off-screen playhead to an 80% forward or 20% reverse anchor in one page-scroll step. Paused seeks and edits preserve the user's scroll position. Timeline track heads are sticky within the same scroll authority while ruler, review lane, clips, range, snap guide, and playhead continue sharing `scrollLeft`.
- Active move/trim gestures run a bounded rAF edge-scroll loop over a 48px hot zone. Gesture time uses pointer delta plus scroll delta, so a stationary captured pointer keeps advancing the visual draft as the viewport moves. Pointer-up cancels the loop and commits once; a window mouse-up fallback handles releases over scrollbar/browser chrome with the latest draft ref.
- Active marquee gestures reuse bounded edge velocity on both axes. Their box and clip intersections are resolved in timeline content coordinates rather than stale client rectangles, so clips entering through horizontal or vertical scroll join the selection immediately. Window mouse-up clears the box and both scroll loops without a Project edit.
- Canonical `link_group_id` now drives Linked Selection across click, Shift, Ctrl/Cmd, marquee, and target-track select-all. Ctrl/Cmd+L or the visible action atomically links/unlinks selected clips. Dragging any member submits Story ripple reordering and free-track movement together in one multi-track Project Patch; disabling Linked Selection leaves link data intact but stops automatic expansion.
- Multi-selection trim computes one frame-snapped delta constrained by every member's source start, media end, and one-frame minimum. Story members apply that delta then reflow once; free-track members keep absolute semantics. Linked cross-track trims submit all affected tracks in one Project Patch, and start extension can no longer produce a negative `source_in`.
- Clip Inspector now exposes renderer-supported Transform properties by track kind and authors canonical linear keyframes at clip-local frame times. Same-property frames are unique and sorted; values hold before the first keyframe, interpolate linearly, and hold after the last exactly like the production FFmpeg expression. Timeline diamonds group properties at one time and seek the shared transport when activated.
- Program Monitor evaluates the same canonical Transform keyframes at its clip-local transport time and applies X/Y, Scale, Rotation, and Opacity to the existing pooled video. The project stage uses container-query geometry to retain the exact project aspect ratio; transform style changes do not mount media or mutate `src`.
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
- A fourth live pass marked `00:00.000–00:01.000` and extracted it as revision 31, reducing the sequence to 27 seconds and clearing the range. Q then ripple-trimmed another second as revision 32, producing a 13.8-second first clip and 26-second sequence. Page errors remained empty.
- A fifth live pass shuttled forward at 2× to the 26-second endpoint, retained the last frame and controls, then reversed across clips to 18.71 seconds at −1×. A new audio track became the explicit target and received the selected Build clip at frame-aligned 2.600 seconds as revision 34. Page errors remained empty.
- A sixth live pass added a fourth rendered track as revision 35. Its 295px viewport contained 352px of explicit rows and scrolled vertically; the new video row resized from 84px to 124px through the separator without a Project revision. Collapsing the audio row changed only its local layout from 64px to 32px. Page errors remained empty.
- The same revision-35 workspace then marquee-selected both Story clips and the independent audio clip by dragging from the empty video track across their rendered bounds. The box and three selections updated live, no Project revision was created, and page errors remained empty.
- A seventh live pass raised the independent audio clip from 0dB to +3dB by keyboard as revision 36. Dragging the Story-derived Build gain line five pixels previewed +5.6dB while revision stayed 36, then committed exactly revision 37 on pointer-up. Page errors remained empty.
- An eighth live pass enabled a 0.05-second independent-audio fade-in by keyboard as revision 38. The first boundary probe exposed overlapping handle/stacking bugs; after correcting the shared z hierarchy, dragging the Story Build fade-out previewed 0.527 seconds while revision stayed 38 and committed exactly revision 39 on release. Page errors remained empty.
- A ninth live pass used 2.25× zoom (`scrollWidth=2411`, viewport `1177`). Starting playback at 26 seconds page-scrolled to `scrollLeft=1234`; all track heads stayed at x=48.67px. While paused, navigating to zero preserved 1234; starting reverse playback at zero returned scrollLeft to 0. No Project revision or page error was produced.
- A tenth live pass held the independent audio clip against the right edge until scrollLeft reached 1234 and its visual left reached 1850.62px. After committing revision 40, the reverse drag held at the left edge auto-scrolled 1234→0 and moved the draft to 0px; window mouse-up committed exactly revision 41. Page errors remained empty.
- An eleventh live pass began a marquee at vertical scrollTop 104 on the empty video track and held at the upper-right edge under 2.25× zoom. It reached scrollLeft 1234 and scrollTop 0, expanded to 1429×279px in content space, and selected both Story clips plus the independent audio clip. Mouse-up stopped both axes, removed the box, preserved revision 41, and left page errors empty.
- A twelfth live pass linked Story Build and independent-audio Build as one revision 42. Selecting Story Build after Hook expanded to exactly the two linked Build clips. Dragging the Story member then reordered Story to Hook→Build and moved the audio member in the same revision 43, with page errors empty.
- A thirteenth live pass dragged the linked audio primary's start handle 30px. Both Story Build and audio Build changed from 13.8 to 12.9 seconds; Story remained ripple-closed after Hook while the audio absolute start moved right by the same delta. The two track replacements committed only revision 44, with page errors empty.
- A fourteenth live pass authored Story Build X keyframes at clip-local 0s=100 and 1s=200 through Effect Controls, committing one revision 45. Two canonical timeline diamonds appeared; activating the 0s diamond sought global transport to the Build start at 12.2333333 seconds. Page errors remained empty.
- A fifteenth live pass measured the 1920×1080 Program stage at 594.82×334.58 (ratio 1.7778). At the 0s diamond active X was 100; activating 1s produced X=199.999997 and a 10.4167% translation. The warm pool remained two videos with identical source URLs and no page errors.

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
13. `target/editor-iteration/06-in-out.png`: the one-second In/Out overlay shares the ruler and all track rows without intercepting editing.
14. `target/editor-iteration/07-ripple-trim.png`: the live Q trim closes the Story gap while keeping the playhead and marker independent.
15. `target/editor-iteration/08-transport-target.png`: the Program Monitor exposes the shared shuttle controls while an independently targeted audio track receives a frame-aligned paste.
16. `target/editor-iteration/09-track-layout.png`: explicit per-track heights preserve readable waveforms and thumbnails while overflow becomes a real vertical track viewport.
17. `target/editor-iteration/10-marquee.png`: one marquee crosses video and audio rows and selects three canonical clips without moving them.
18. `target/editor-iteration/11-clip-gain.png`: the derived Story waveform shows its live +5.6dB rubber-band value before the single commit.
19. `target/editor-iteration/12-clip-fade.png`: the Story waveform renders its live fade-out triangle and 0.527-second handle value at the shared edit boundary.
20. `target/editor-iteration/13-playback-scroll.png`: the zoomed timeline follows the end playhead while every V/A track head remains fixed on the left.
21. `target/editor-iteration/14-drag-scroll.png`: a captured audio clip remains under edit while the timeline auto-scrolls back to its zero boundary.
22. `target/editor-iteration/15-marquee-scroll.png`: one content-space marquee grows across horizontal and vertical pages while newly revealed clips join the selection.
23. `target/editor-iteration/16-linked-selection.png`: the linked Story and audio members remain selected while one gesture prepares their cross-track move.
24. `target/editor-iteration/17-linked-trim.png`: the linked Story and free-track Build clips preview the same constrained start trim before their single commit.
25. `target/editor-iteration/18-transform-keyframes.png`: two keyframe diamonds sit on the canonical Build clip while Program Monitor and timeline share its global transport position.
26. `target/editor-iteration/19-transform-preview.png`: the exact-ratio Program stage previews the second canonical X keyframe without replacing either pooled video.

## Verification

- Focused keyframe editing and Project workbench tests: 54 passed.
- Full web suite: 257 files and 2933 tests passed.
- Strict i18n/layer lint and TypeScript build passed.
- Production Vite build passed.
