# Project workbench design QA

final result: passed

## Comparison target

- Source visual truth: `C:\Users\12009\AppData\Local\Temp\codex-clipboard-de94fa37-f56a-4c67-afe4-ea1a74e37d2f.png`.
- Browser-rendered implementation: `target/design-qa-workbench/14-final-1635x962.png`.
- Full same-input comparison: `target/design-qa-workbench/14-reference-comparison.png`.
- Focused timeline comparison: `target/design-qa-workbench/14-timeline-comparison.png`.
- Route/state: Project `9ee43da6-8d88-4428-b54f-e2420a6f0a3a`, revision 11, 11/11 Timeline Clips materialized, playhead at 02:17.467, clean Agent session `17131bd0-02fa-4935-966a-01250c3640d1`.

## Viewport and normalization

- Source pixels: 1635 x 962.
- Implementation CSS viewport and screenshot: 1635 x 962 at device pixel ratio 1, set through the active WebView2 CDP session.
- No crop, stretch, or density conversion in the full comparison.
- Focused timeline crop for both sides: x 0, y 672, width 1208, height 290.

## Findings

No actionable P0, P1, or P2 visual mismatch remains.

- The 74/26 review-workbench split, 56 px header, dual preview, 182 px Change Summary, Project Timeline, Agent rail, borders, neutral surfaces, and compact density align at the exact source viewport.
- The Project Timeline now has one synchronized time geometry for ruler, clips, waveforms, markers, events, horizontal scroll, zoom, and the draggable playhead.
- The source uses illustrative Mirage frames, edit regions, events, and a staged Agent workflow. The implementation intentionally renders the current Project Head: a real selected Inferno Take/radar path, the authoritative Change Group, real Take thumbnails/waveforms, and a verified read-only Agent turn.
- The source's blue playhead is 02:17.482; the browser-tested implementation is 02:17.467, a one-frame difference at 60 fps.
- Agent Markdown now renders as typography/lists instead of literal punctuation. Tool calls, HITL cards, External Execution status, human-only decisions, the Edit Lease read-only state, and delivery actions remain one conversation flow.

## Required fidelity surfaces

- Fonts and typography: system sans and mono stacks, compact weights, line heights, timecodes, truncation, Agent Markdown, and tool-card hierarchy match the source density.
- Spacing and layout rhythm: exact viewport comparison confirms panel insets, preview split, summary bands, track head, ruler, track rows, footer, and Agent rail.
- Colors and visual tokens: all workbench surfaces use `theme.css` tokens; the compact timeline zoom scrubber is design-system owned.
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

## Verification

- Focused web interaction tests: Project/workbench and Timeline interaction tests passed.
- Agent crate: 10 tests passed, including unbounded tool-loop, confirmation-only execution, and current-turn checkpoint regression.
- Full web suite, strict i18n/layer lint, production build, Rust formatting and Clippy are recorded in the final task handoff.
