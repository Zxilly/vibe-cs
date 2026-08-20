# IA-26 Tauri Desktop verification

- Host: real Tauri WebView2, connected through CDP port 9222 with `agent-browser` session `vibe-tauri`.
- Viewport: 1440 × 900 CSS px, device pixel ratio 1.5.
- Service: online after the existing database migrated to the Take/Composition schema; no startup or browser runtime error was reported.
- One-sentence start: the new-project Agent canvas shows only the readiness gate and one instruction composer. With the current local data it honestly blocks on both missing Demo and missing model instead of inserting sample data.
- Deep link: the readiness action opened `#/settings?section=ai&item=model` and focused the Model section while keeping the complete settings layout intact.
- Production-mode boundary: selecting Quick Edit before a Composition exists opens a keyboard-modal explanation and does not create an empty project.
- Browser console: only Vite development refresh/debug messages and the React DevTools development notice; no application exception.

Evidence:

- `one-sentence-start.png`
- `settings-deep-link-model.png`
- `mode-conversion-boundary.png`

The current machine has no imported Demo and no configured model credential, so launching CS2 and producing a user-owned real video was not attempted. The full recording → Take → Composition → export path is covered by the application integration test `agent_recording_registers_a_take_and_exports_the_exact_composition`; a real user Demo remains the final hardware/data-dependent acceptance input.

Completion-audit addition:

- Desktop integration test `one_sentence_materializes_a_plan_and_reaches_a_persisted_final_video` uses an isolated persisted database, an analyzed Demo, a loopback streaming model, and deterministic recording/export adapters.
- It proves the whole software-owned chain in one test: one sentence → `video_render` tool → non-empty Agent plan → immutable Agent baseline → recording plan → recorded Take → confirmed Composition → MP4 export → database reopen with the same plan, Take, Composition, and output association.
- This test caught and closed the previous gap where `video_render` was stored in the conversation but never materialized into the empty shot list.
- Analysis is now an automatic pre-chat stage for discovered/in-flight/failed Demos; only a physically missing Demo remains a blocking input error.
