# Project workbench design QA

final result: passed

## Comparison target

- Source visual truth: `C:\Users\12009\AppData\Local\Temp\codex-clipboard-f218d2ec-1f55-4b8c-aff1-43f59dcdd8d7.png`.
- Browser-rendered implementation: `target/visual-align/06-current.png`.
- Full same-input comparison: `target/visual-align/06-full-comparison.png`.
- Focused timeline comparison: `target/visual-align/06-timeline-comparison.png`.
- Focused Agent-rail comparison: `target/visual-align/06-agent-comparison.png`.
- Route/state: Project `9ee43da6-8d88-4428-b54f-e2420a6f0a3a`, revision 11, 11/11 Timeline Clips materialized, playhead at 02:17.517, existing Agent session `71ba4057-3c14-427d-a359-5dc3c88cc07f`.

## Viewport and normalization

- Source pixels: 1635 x 962.
- Implementation CSS viewport and screenshot: 1635 x 962 at device pixel ratio 1, set through the active WebView2 CDP session.
- No crop, stretch, or density conversion in the full comparison.
- Focused timeline crop for both sides: x 14, y 677, width 1207, height 285.
- Focused Agent crop for both sides: x 1215, y 56, width 420, height 906.

## Findings

No actionable P0, P1, or P2 visual mismatch remains.

- The 1215/420 review-workbench split, 56 px header, dual preview, 182 px Change Summary, 285 px Project Timeline, Agent rail, borders, neutral surfaces, and compact density align at the exact source viewport.
- Timeline measurements now match the reference structure: 32 px title bar, 27.2 px ruler, 51.7/39.3/42.8/42.8 px rows, and 47.6 px footer.
- The workbench selects one contextual design-system palette: white review canvas, #e1e5ec dividers, high-saturation review blue, and the shared neutral ramp. Page components do not carry local colour literals.
- The Project Timeline now has one synchronized time geometry for ruler, clips, waveforms, markers, events, horizontal scroll, zoom, and the draggable playhead.
- The source uses illustrative Mirage frames, edit regions, events, and a staged Agent workflow. The implementation intentionally renders the current Project Head: a real selected Inferno Take/radar path, the authoritative Change Group, real Take thumbnails/waveforms, and a verified read-only Agent turn.
- The source's blue playhead is 02:17.482; the browser-tested implementation is 02:17.517, a two-frame difference at 60 fps.
- The supplied visual includes a staged independent-looking video progress bar. The implementation intentionally omits that bar because the accepted product rule makes the Timeline Transport authoritative; the Program Monitor exposes only global play/pause and the global time readout.
- Agent Markdown now renders as typography/lists instead of literal punctuation. Tool calls, HITL cards, External Execution status, human-only decisions, the Edit Lease read-only state, and delivery actions remain one conversation flow.

## Required fidelity surfaces

- Fonts and typography: system sans and mono stacks, compact weights, line heights, timecodes, truncation, Agent Markdown, and tool-card hierarchy match the source density.
- Spacing and layout rhythm: exact viewport comparison confirms panel insets, preview split, summary bands, track head, ruler, track rows, footer, and Agent rail.
- Colors and visual tokens: all workbench surfaces use the contextual `.review-workbench` semantic tokens in `theme.css`; the compact timeline zoom scrubber is design-system owned.
- Image quality and asset fidelity: video previews/thumbnails, waveform peaks, decoded CS2 radar, replay paths, and event positions are real local media/data rather than placeholders.
- Copy and content: revision, clip counts, materialization, task status, tool results, Agent response, and timeline time values are runtime truth.

## Interaction verification

- Dragged the playhead through CDP from 00:00 to 01:02.500 and later to 02:17.467; selection, preview and tactical context followed it.
- Pointer drag commits one revision-bound `replace_clip`; selected clips expose start/end trim handles.
- Arrow keys nudge by one frame; Shift+Arrow nudges by one second.
- Ruler and empty timeline clicks seek; zoom, ruler and tracks remain synchronized.
- Track output/mute and lock controls write the canonical Editing Document and honor the Agent Edit Lease.
- During an Agent turn, human editing becomes read-only and is restored after lease release.
- Missing Agent configuration blocks send and links to model settings rather than persisting a doomed turn.
- OpenCode `kimi-for-coding / k3` was saved without exposing the key, connection-tested, and exercised in a real read-only turn.
- Browser console and page errors were empty after the final reload.

## Scrub and preview performance regression

- Baseline trace: `target/scrub-baseline-profile.json`; one head-to-tail scrub rewrote the visible Program Monitor `src` 10 times and emitted 10 `emptied/loadstart` cycles. The video stayed at source time 0 and exposed native controls.
- Final trace: `target/scrub-final4-profile.json`; the same pointer trajectory produced 0 video mounts, 0 removals, 0 `src` changes, 0 visible `emptied/loadstart/waiting` events, and no radar-empty rendered frames.
- Renderer main-thread maximum task fell from 130.31 ms to 48.85 ms. Tasks over 16 ms fell from 14 to 7; tasks over 50 ms fell from 1 to 0 on the repeat final run.
- The Program Monitor keeps stable clip-keyed media slots, coalesces seeks, presents the selected source time, and retains the previous decoded frame until the new target is ready. Radar images use the same retained-pool handoff.
- The visible video no longer has an independent progress bar. Space/play-pause drives the global Timeline Transport, and a real Tauri playback check advanced the playhead and active video together.
- Story Track now supports ripple drag/trim, split, delete-and-close-gap, and Change Group undo through visible controls plus Space, S, Delete, and Ctrl/Cmd+Z.

## Agent architecture decision

- CopilotKit / AG-UI is not introduced: it would duplicate the existing Rust Rig loop, Tauri Channel, AgentSession, Edit Lease, Project Patch, and HITL lifecycle.
- assistant-ui remains a later presentation-only spike candidate through `ExternalStoreRuntime`, after the Agent Turn Runtime projection is fully typed. It is not needed to fix the current correctness bugs.
- The current-turn host checkpoint is authoritative over stale conversation facts. A real regression changed the Agent answer from stale `3 recorded / 8 planned` to current `revision 11 / 11 recorded / 0 planned` without modifying the Project.
- External recording/export tasks now render in the conversation and automatically return their terminal outcome to the Agent for the next turn.

## Comparison history

1. `01-current-before.png`: playhead was decorative, clips had no direct manipulation, tool calls were mislabeled as running, and Agent configuration was not guarded.
2. `03-playhead-dragged.png`: real playhead drag reached 01:02.500.
3. `05-agent-working-turn.png`: UI flow worked, but the Agent exposed stale project facts from history.
4. `08-final-1635x962-reload.png`: exact viewport aligned, but the fit timeline still showed a horizontal scrollbar.
5. `11-final-markdown.png`: Agent Markdown and the fit timeline were corrected.
6. `14-final-1635x962.png`: final exact-viewport visual and interaction state passed.
7. `target/visual-align/06-current.png`: aligned the latest supplied visual truth, including the 420 px Agent rail, bright review palette, preview split, compact Change Summary bands, and production timeline row geometry.

## Verification

- Focused web interaction tests: Project/workbench and Timeline interaction tests passed.
- Agent crate: 10 tests passed, including unbounded tool-loop, confirmation-only execution, and current-turn checkpoint regression.
- Full web suite, strict i18n/layer lint, production build, Rust formatting and Clippy are recorded in the final task handoff.
