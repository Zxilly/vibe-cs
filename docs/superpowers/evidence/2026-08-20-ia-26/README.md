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

Real-data continuation through the running Tauri bridge:

- Counter-Strike 2: `ready` (`E:\SteamLibrary\steamapps\common\Counter-Strike Global Offensive\game/bin/win64/cs2.exe`)
- Restored Demo: official M1 Mirage, archive and Demo SHA-256 matched the local acceptance tracker
- Product analysis: `de_mirage`, 21 rounds, 10 players, 457 highlights
- Agent runtime: OpenCode `kimi-for-coding/k3` credential supplied only to the Desktop process; `configured: true`
- Real Kimi turn: 101,653 input / 3,593 output / 105,246 total tokens; exact FalleN R20 four-kill evidence; `read_cinematic_context` + `draft_video_plan`
- Materialized plan: one bound shot, 3.5s pre-roll + 3.0s post-roll, estimated recording duration 14.5625s
- HLAE: managed `v2.191.1`; automatic CS2 discovery now completes the typed launch profile
- Video encoders: `ready` (hardware and software choices reported)
- Recording layout: the 504px centre panel now uses a 455px container-adaptive two-column check grid (217px cells), capped at 55% height; document horizontal overflow remains zero
- Real recording: blocked at `[HLAE_BRIDGE_TIMEOUT]`; `AfxHookSource2.dll` loads but no PID-bound loopback connection is opened on current CS2 build `24701871`

The former “missing Demo/model” blocker is resolved. The remaining acceptance gap is the real HLAE-to-current-CS2 bridge compatibility; no MP4, Take or Composition is claimed until that handshake succeeds.

Additional local evidence (ignored by Git): `target/real-data/agent-k3-real/recording-layout-fixed.png` and `REAL_DATA_TEST_TRACKER.local.md`.
