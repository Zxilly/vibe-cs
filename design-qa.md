# Project workbench design QA

final result: passed

## Comparison target

- Interaction reference: Adobe Premiere's official Project panel / Source Monitor Insert and Overwrite workflow: <https://helpx.adobe.com/premiere/desktop/edit-projects/intro-to-editing/add-or-remove-clips.html>.
- Open-source reference: FreeCut `4d62e8082c5eb387a96275bcbd323d28f6e41a62`, especially `media-library.tsx`, `media-grid.tsx`, `source-monitor.tsx`, and `source-edit-actions.ts`. Only the proven Project panel selection/filter/source-edit semantics were adopted; its separate store/runtime was not copied.
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
- Direct Program transform pass: `target/editor-iteration/20-program-direct-transform.png`.
- Program scale/rotation pass: `target/editor-iteration/21-program-scale-rotation.png`.
- Volume keyframe pass: `target/editor-iteration/22-volume-keyframes.png`.
- Clip effects pass: `target/editor-iteration/23-effects.png`.
- Slip edit pass: `target/editor-iteration/24-slip-preview.png`.
- Rolling edit pass: `target/editor-iteration/25-rolling-preview.png`.
- Rate Stretch pass: `target/editor-iteration/26-rate-stretch.png`.
- Slide edit pass: `target/editor-iteration/27-slide-preview.png`.
- Docked Project Media pass: `target/editor-iteration/30-project-media-panel-empty-fixed.png`.
- Compact Project Media overlay pass: `target/editor-iteration/31-project-media-panel-1100-overlay.png`.
- V/A media routing pass: `target/editor-iteration/34-audio-authoritative-id.png`.
- Project Media drag preview pass: `target/editor-iteration/37-media-drag-mode.png`.
- Project Media drop commit pass: `target/editor-iteration/36-media-drop-complete.png`.
- Project Media management pass: `target/editor-iteration/38-media-management-actions.png`.
- Project Media delete confirmation pass: `target/editor-iteration/39-media-delete-confirm.png`.
- Missing recorded media pass: `target/editor-iteration/40-missing-recorded-media.png`.
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
- Project Media is now a production dock rather than a transient file drawer. It projects canonical Story clips and unreferenced imported assets as one project-facing library: planned clips read `TimelineClip.material = planned`, recorded clips retain the same clip identity and resolve their media, and already-referenced assets are not duplicated as raw files. Search and the planned/recorded/imported filter operate on that projection; selecting a timeline item also selects and seeks the canonical clip. A planned item can request recording for its exact clip ID through the same explicit CS2/HLAE confirmation used by the all-missing action.
- Imported sources expose Premiere-style Insert and Overwrite through the same callbacks as `,` and `.`. The source surface is a still-frame monitor without native playback controls. It keeps the previous decoded source mounted until the newly selected asset reports `loadeddata`, uses `object-fit: contain`, and never takes authority from Timeline Transport or Program Monitor.
- Project Media routes by real target-track kind. Video on Story uses ripple Insert; non-Story video and audio preserve free positions, while Overwrite trims only the covered interval without moving later placements. An audio source falls back to the current audio target or creates one audio track and its first clip in the same Project Patch. The action surface names `Story（波纹）`, the exact target, or `新建音频轨道` before commit.
- Inserted track and clip identities are backend-owned. After an `insert_track` Patch, the UI resolves the real Track/Clip UUIDs from the returned Project Head before targeting or selecting them; it never keeps the provisional frontend UUIDs that Storage deliberately replaces. Project Media reads every non-text Timeline Track, so an inserted audio asset becomes one recorded timeline item rather than remaining duplicated as an imported file.
- Unused imported sources can be dragged from Project Media directly onto real Timeline rows. The bounded custom payload carries only asset identity, V/A kind, and preview duration; the page re-resolves the asset before editing. Timeline owns track-kind/lock/derived-row admission plus the drop time from its current ruler, zoom, scroll, track-head offset, and frame snapping. Default drag is Overwrite; Ctrl/Cmd switches the same gesture to Insert, and the ghost labels the mode, media kind, and duration before release.
- Unreferenced imported assets expose working Relink and Remove actions. Relink keeps the stable asset ID, rejects a shorter replacement, clears cached waveform/analysis over the old bytes, refreshes Project Media, and remounts its source monitor. Remove uses a destructive confirmation that explicitly preserves the disk source file. Canonical Timeline items never expose either raw-asset action.
- The delete route independently scans every current Project Head and rejects any Asset/Take material reference with `409 media_asset_in_use`; UI filtering is not the integrity boundary. Removing an unused record does not create a Project revision and never deletes the external source file.
- Media list/detail responses now project current filesystem availability without overwriting persisted probe truth. A missing/non-file/unreadable source becomes an explicit unavailable asset with a bounded relink instruction; restoring the file makes the next read ready again. Unavailable imports cannot Insert, Overwrite, or drag.
- Timeline-recorded items resolve their stable source asset separately from raw imported-item privileges. They expose Relink even while unavailable, but never Delete or Place-again actions. Relink keeps clip identities and Project revision unchanged while the source monitor is remounted against the repaired stream.
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
- When the visible Program clip is the primary selection, paused, and writable, one transparent stage overlay supports direct X/Y movement and keyboard nudging. CSS deltas convert through measured stage dimensions into project pixels; animated properties upsert the current local keyframe while static properties update base Transform. Linked-selection click promotion preserves the group but makes the explicitly clicked member primary.
- The Program overlay also exposes a uniform corner Scale handle and center Rotation handle with pointer and keyboard control. Scale is constrained to 0.01–10×; Rotation nudges 1°/15°. Inspector and canvas mirror the renderer rule that animated Scale cannot coexist with non-zero or animated Rotation, while static Scale+Rotation remains valid.
- Volume is a first-class keyframe property in Effect Controls and the waveform rubber-band. Static clips update placement volume; animated clips upsert the current local frame and display evaluated dB as transport moves. Program audio evaluates canonical volume times fade envelope, applies the browser's 0–1 portion, and preserves >1 gain for exact FFmpeg export.
- Clip effects use one closed renderer-backed vocabulary shared by the Inspector and Program Monitor: Color Adjust, Grayscale, and Blur. The Inspector adds, enables, orders, deletes, and constrains their canonical parameters; enabled unknown effects block save instead of creating a preview/export mismatch. The canonical video clip shows the enabled count as an `fxN` badge, and Program evaluates the ordered stack without remounting pooled media.
- Slip is an independent Premiere-style timeline tool rather than an alias for move or trim. V selects Selection and Y selects Slip; dragging changes source In/Out by one shared frame-snapped delta while timeline start/duration stay fixed. Linked multi-track selections intersect every media boundary, locked/planned/full-range clips cannot pretend to move, and the completed gesture submits one Project Patch. The transient draft is projected into the existing Program Monitor without changing clip identity or media `src`, then discarded before persistence.
- Rolling Edit is a distinct N-key tool over one real adjacent cut. The shared handle trims the outgoing Out and incoming In by the same frame delta, preserves both outer edges and their combined duration, snaps through the common timeline geometry, edge-scrolls, and commits one `replace_track_clips` operation. Gaps and variable-speed clips do not expose a false rolling point. During the gesture Program reuses the same two pooled media elements as a decoded outgoing/incoming Trim Monitor; stable half-width overflow slots preserve canonical Transform/effects without allowing either frame to cross the center boundary, and media `timeupdate` never becomes transport authority.
- Rate Stretch is a distinct R-key tool backed by one constant-speed invariant. Dragging a right edge retains source In/Out, derives speed from source span / frame-snapped duration, proportionally retimes clip keyframes, and live-ripples the Story Track; free tracks additionally expose the left edge without inventing Story gaps. Program and FFmpeg share the canonical `0.0625×–16×` range, while Rust rejects speed/duration/source documents that disagree. Inspector duration and speed call the same Rate Stretch operation; `speed_segments` explicitly require the separate time-remapping editor instead of being overwritten.
- Slide is a distinct U-key tool over one contiguous three-clip window. Moving the middle clip keeps its source In/Out and duration fixed, adds the same frame delta to the previous Out and next In, preserves all outer edges and total duration, and submits one `replace_track_clips` operation. Program maintains stable `program/trim` roles per Story clip; only the four Slide roles decode as previous Out / selected In / selected Out / next In, each in an isolated 25% slot without changing `src`. Preview readiness is identity-keyed rather than effect-order-dependent, and paused stale media frames cannot move transport until they match the current desired source frame; playing media remains authoritative.
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
- A sixteenth live pass selected linked Story Build as primary at local 0 and dragged the Program overlay by 60×30 CSS pixels. The draft preview reached project X=293.671 and Y=96.837 while revision remained 45; mouse-up updated the existing X keyframe and static Y in exactly revision 46. Page errors remained empty.
- A seventeenth live pass used the Program Scale handle to change 1.00→1.10 as revision 47, then the Rotation handle to set 15° as revision 48. The live style combined translate(15.2954%, 8.96638%), rotate(15deg), and scale(1.1) without changing the warm media pool or producing page errors.
- An eighteenth live pass authored Story Build Volume keyframes at local 0s=1.911661 (+5.6dB) and 1s=1.0 (0dB), committing one revision 49. Both timeline diamonds grouped two properties; Program canonical/output data and the Story rubber-band switched together while browser volume clamped at 1. Page errors remained empty.
- A nineteenth live pass added Color Adjust (brightness 0.2, contrast 1.2, saturation 0.8) and Blur (radius 4), reordered Blur before Color Adjust, and saved exactly revision 50. Program exposed `blur,color_adjust` and the matching ordered CSS filter while retaining two pooled videos; the canonical clip displayed `fx2` and page errors remained empty.
- A twentieth live pass selected Slip and dragged Hook 50 CSS pixels right. While held, revision remained 50; source In/Out previewed `1.7666667–14.0 → 0.2666667–12.5`, Program source time became `0.2666667`, and timeline `left=0px` / `width=408.375px` stayed exact. The warm pool retained two identical URLs. Release alone committed revision 51; V restored Selection and both trim handles, with no page errors.
- A twenty-first live pass fully reloaded Tauri, selected Rolling Edit, and moved the Hook/Build cut by −0.450 seconds. While held, revision remained 54, duration stayed `00:29.567`, the shared playhead/cut moved to `12.5333333`, and both canonical clip blocks/source bounds updated in place. Program showed two decoded `297.40625px` slots with exact `left/right` identities, `overflow:hidden`, and the original two URLs. Release alone committed revision 55, restored normal Program mode, and retained the new cut as transport position with no page errors.
- A twenty-second live pass restarted Tauri after the Rust invariant change, selected Rate Stretch, and dragged Hook's right edge. While held, revision remained 56; duration changed `11.033s → 11.783s`, speed previewed `1.063649× / 106.4%`, source In/Out stayed `0.2666667–12.8`, and Build rippled to the exact new boundary. Program exposed the same draft speed while retaining two identical URLs. Release alone committed revision 57; the independent audio kept overall Project duration at `00:29.567`, and page errors remained empty.
- A twenty-third live pass used Project Media at the exact Story end to insert a real Anubis clip as revision 58, producing a three-clip Story and six stable `program/trim` video roles. A cold-reload Slide initially exposed an effect-order readiness race; after identity-keyed readiness, four decoded `124.28125px` slots appeared immediately. The final −0.633-second Slide held revision 61 and duration `00:38.340`; the middle clip retained source `3.200000033–15.7666667` and duration, while adjacent source bounds compensated. Release alone committed revision 62, restored normal Program, and kept transport at the exact previewed start `11.9333333`. All six role URLs remained unchanged and page errors were empty.
- A twenty-fourth live pass replaced the old media drawer with the docked Project Media projection. At 1440×900 it occupied 280px and left the canonical Timeline 711px; hiding it restored the Timeline to 998px. At 1100×700 a fresh load kept the Timeline at 658px and the document at zero horizontal overflow; opening media produced a 340px workspace overlay without changing Timeline width. A final reload had no browser errors or console failures.
- A twenty-fifth live pass imported an eight-second WAV extracted from an existing NiKo recording into the empty development Project. Insert created one independent audio track while Story stayed empty. Two undo/reinsert probes exposed first a stale-head target reset and then Storage's intentional UUID reallocation; after resolving identities from the returned Project Head, revision 8 showed `目标：音频轨道 1`, only the new A-track target was pressed, the waveform rendered on that track, and Project Media contained exactly one recorded item. Page errors were empty.
- A twenty-sixth live pass imported a second reference to the same eight-second NiKo WAV and dragged its Project Media row to the exact end of the real A track. While held, revision stayed 10 and a dashed `覆盖 · 音频 · 00:08.000` ghost occupied the Timeline-computed range. Release alone committed revision 11, removed the ghost, preserved the first source through 7.750 seconds, placed the new eight-second source at that boundary, and extended the Project to 15.750 seconds. Target stayed A1 and page errors were empty.
- A twenty-seventh live pass restarted Tauri on the new backend and proved both asset-management boundaries. Direct deletion of the Timeline-referenced drag source returned `409 media_asset_in_use`. A third unused NiKo WAV exposed Relink/Remove controls; its destructive dialog stated that the disk file would remain. Confirming removed the record without changing Project revision 11, while `Test-Path` still returned true. A separate relink to a copied path retained the exact asset ID and eight-second duration. Page errors were empty.
- A twenty-eighth live pass temporarily moved the source WAV shared by two recorded Timeline items. A fresh Tauri read immediately labeled both `已录制 · 不可用`, made both non-draggable, and exposed only Relink on selection; no Delete/Insert/Overwrite action appeared. Relinking the first stable asset ID to the moved copy restored only that item, while the other stayed unavailable. Restoring the original file made the remaining item ready on the next reload. Project stayed at revision 11 and page errors were empty.

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
27. `target/editor-iteration/20-program-direct-transform.png`: the selected Program clip previews its project-pixel X/Y draft under the direct manipulation border before commit.
28. `target/editor-iteration/21-program-scale-rotation.png`: the Program frame shows the selected clip with canonical 1.1× scale and 15° rotation controls.
29. `target/editor-iteration/22-volume-keyframes.png`: the Build clip shows two-property diamonds while Program and waveform evaluate the local 1-second Volume keyframe.
30. `target/editor-iteration/23-effects.png`: the Build clip and Program Monitor show the same enabled two-effect stack after one canonical save.
31. `target/editor-iteration/24-slip-preview.png`: Hook keeps its exact timeline geometry while the live In/Out overlay and Program frame preview a negative 1.5-second Slip draft before commit.
32. `target/editor-iteration/25-rolling-preview.png`: the common Hook/Build cut and playhead move together while the existing Program pool presents effect-correct outgoing and incoming frames in isolated half-width slots.
33. `target/editor-iteration/26-rate-stretch.png`: Hook displays the live `106.4%` duration tooltip while its fixed source range, downstream Story ripple, waveform, and stable Program frame remain visible together.
34. `target/editor-iteration/27-slide-preview.png`: four real source frames label previous Out, selected In/Out, and next In while the same three canonical timeline blocks preview one Slide delta.
35. `target/editor-iteration/30-project-media-panel-empty-fixed.png`: the docked Project Media panel reserves complete source-preview, action, and library regions beside the unchanged canonical Timeline.
36. `target/editor-iteration/31-project-media-panel-1100-overlay.png`: the compact workspace opens Project Media as a bounded overlay while the full Timeline geometry remains available underneath.
37. `target/editor-iteration/34-audio-authoritative-id.png`: one imported audio source appears once in Project Media and once on the targeted free-positioned A track, with the returned backend identity selected.
38. `target/editor-iteration/37-media-drag-mode.png`: the held native drag shows an Overwrite audio ghost at the exact A-track boundary before any Project revision.
39. `target/editor-iteration/36-media-drop-complete.png`: releasing the same drag replaces only the covered free-track interval and projects both resulting recorded sources without duplicate imported rows.
40. `target/editor-iteration/38-media-management-actions.png`: an unused imported source exposes only the real Relink, Remove, Insert, and Overwrite actions above the unchanged Timeline.
41. `target/editor-iteration/39-media-delete-confirm.png`: the destructive confirmation names the exact record-only blast radius and explicitly preserves the disk file.
42. `target/editor-iteration/40-missing-recorded-media.png`: a recorded Timeline item with a missing source is visibly unavailable and offers only the stable-ID Relink repair.

## Verification

- Focused keyframe editing and Project workbench tests: 62 passed.
- Focused clip-effects and Project workbench tests: 60 passed.
- Focused Slip interaction and Project workbench tests: 74 passed.
- Focused Rolling/Slip interaction and Project workbench tests: 78 passed.
- Focused Rate Stretch/Rolling/Slip interaction and Project workbench tests: 83 passed.
- Focused Slide/Rate Stretch/Rolling/Slip interaction and Project workbench tests: 88 passed.
- Focused Project Media, routing, and Project workbench interaction tests: 87 passed.
- Focused Project Media drag/drop and Project workbench interaction tests: 73 passed.
- Focused Project Media management/data/workbench interaction tests: 82 passed.
- Focused availability, media data, drag, and workbench interaction tests: 84 passed.
- Full web suite: 260 files and 2979 tests passed.
- Domain Project invariants: 210 tests passed; scoped Domain/Application rustfmt passed.
- Full Rust workspace tests and doc-tests passed; only explicitly environment-gated tests remained ignored.
- Strict i18n/layer lint and TypeScript build passed.
- Production Vite build passed.
