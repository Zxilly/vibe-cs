# Full Product Verification — Tauri Desktop

| Field | Value |
|---|---|
| Date | 2026-08-20 |
| Surface | Real Tauri WebView2 via CDP |
| Browser driver | `agent-browser`, session `vibe-tauri` |
| Viewports | 1100×700, 1440×900, 2560×1392 CSS px |
| Data | Restored real Major M1, persisted Kimi K3 plan, real local runtime state |
| Core story | Demo + one sentence → analysis → Agent shot list → recording → Take/Composition → playable export |

## Verdict

The complete application surface is visually verified at all three target sizes: 29 pages or first-class subviews × 3 viewports, with no document horizontal overflow, out-of-bounds controls, loading state left behind, or page error in the accepted captures.

The real-data story now completes end to end. The restored Major M1 was analyzed, Kimi K3 produced a persisted FalleN R20 shot, managed HLAE 2.191.1 recorded it, the native encoder published a verified Take, the application assembled and exported a confirmed Composition, and the final H.264/AAC MP4 is reachable from both the task and project output surfaces.

## Route and state matrix

| Surface | States/views | 1100×700 | 1440×900 | 2560×1392 | Result |
|---|---|---:|---:|---:|---|
| Workbench | real attention state | captured | captured | captured | pass |
| Library | Demo, Steam | 2/2 | 2/2 | 2/2 | pass |
| Player directory/profile | list, real FalleN profile | 2/2 | 2/2 | 2/2 | pass |
| Evidence | search/results | captured | captured | captured | pass |
| Match workspace | overview, rounds, players, duels, utility, replay, highlights, review, teams | 9/9 | 9/9 | 9/9 | pass |
| Projects | list | captured | captured | captured | pass |
| Project workspace | select, Agent/shot list, recording, exported result | 4/4 | 4/4 | 4/4 | pass |
| Delivery | outputs, recording task workflow | 2/2 | 2/2 | 2/2 | pass |
| Settings | app, files/Steam, game, AI, advanced | 5/5 | 5/5 | 5/5 | pass |
| Recovery / Guide / Not found | route states | 3/3 | 3/3 | 3/3 | pass |
| Project export | confirmed Composition and playable output | captured | captured | captured | pass |

Accepted compact and medium matrices are visible in [contact-sheet-1100x700.png](contact-sheet-1100x700.png) and [contact-sheet-1440x900.png](contact-sheet-1440x900.png). The `01`–`12` captures are the individually inspected maximized states. Loading/rejected captures such as `04-players` and `09c-project-record` remain as audit history; `04b` and `09c3` are their accepted replacements.

## Browser checks

- All accepted 1100×700 and 1440×900 targets reported `scrollWidth === innerWidth` and no interactive element outside the viewport.
- Accepted maximized targets were inspected individually for content clipping, overlap, inert lower regions, and missing next actions.
- Deep links restored settings items and match subviews directly.
- The work-mode menu, compact sidebar, pagination, filters, dialogs, and primary route transitions were exercised from the accessibility tree.
- No current page exception or failed resource request remained after the final reload. Historic Vite HMR reconnect warnings in the long-lived console were caused by Rust-triggered Desktop restarts and were not counted as page failures.
- After the fixes, Steam history, files/Steam settings, advanced diagnostics, recovery, highlights, and Review were captured again at all three sizes as `final-*.png`; all 18 states reported zero horizontal overflow, zero out-of-bounds interactive controls, zero busy regions, and no unexpected alert.
- The completed project Export step, Agent workflow task, and Finished files were then recaptured at all three sizes. The compact output-card action row and async export deep link were corrected; the accepted nine final states have zero horizontal overflow, zero out-of-bounds controls, and no busy state.

## Fixed findings

### ISSUE-001 — Steam history leaked a backend dependency error — fixed

The Steam history empty/error state now uses Chinese product copy and a direct `打开 Steam 设置` recovery action. The settings deep link opens a complete local Steam configuration block without exposing stored secrets.

- Before: [issue-001-steam-raw-error.png](screenshots/issue-001-steam-raw-error.png)
- After: [issue-001-fixed-localized-history-error.png](screenshots/issue-001-fixed-localized-history-error.png), [issue-001-fixed-steam-settings.png](screenshots/issue-001-fixed-steam-settings.png)

### ISSUE-002 — Analyzer English and raw Steam IDs appeared in analysis UI — fixed

Known highlight descriptions now use player names and Chinese typed descriptions. Review capability diagnostics translate the analyzer's closed English vocabulary while retaining unknown future reasons verbatim.

- Before: [issue-002-analysis-raw-english.png](screenshots/issue-002-analysis-raw-english.png)
- After: [issue-002-003-fixed-highlights-1100x700.png](screenshots/issue-002-003-fixed-highlights-1100x700.png), [issue-002-fixed-review-1100x700.png](screenshots/issue-002-fixed-review-1100x700.png)

### ISSUE-003 — Highlights mounted all 457 rows — fixed

The match now mounts a bounded 50-row page with 10-page navigation. Selection is scoped to the visible page, filtering resets to page 1, and a deep-linked highlight moves to its containing page.

- Evidence: [issue-002-003-fixed-highlights-1100x700.png](screenshots/issue-002-003-fixed-highlights-1100x700.png)

### ISSUE-004 — Recovery and runtime disagreed about the CS2 path — fixed

Recovery/GSI routes now use the integration layer's authoritative runtime discovery rather than rejecting the request because a legacy `cs2_path` was not persisted.

- Before: [issue-004-recovery-stale-game-path.png](screenshots/issue-004-recovery-stale-game-path.png)
- After: [issue-004-fixed-recovery-status.png](screenshots/issue-004-fixed-recovery-status.png)

### ISSUE-005 — Missing managed HLAE had no recovery action — fixed

Advanced settings now exposes `准备采集组件`, calls the existing reviewed download/verify/install command, refreshes status after success, and renders a retryable failure in place.

- Before: [issue-005-hlae-no-prepare-action.png](screenshots/issue-005-hlae-no-prepare-action.png)
- After: [issue-005-fixed-prepare-action.png](screenshots/issue-005-fixed-prepare-action.png), [issue-005-fixed-hlae-ready.png](screenshots/issue-005-fixed-hlae-ready.png)

### ISSUE-006 — Steam startup failure was misreported as an HLAE bridge timeout — fixed

The original CS2 console proved that `-steam` exited before processing any `mirv_*` command when the Steam client was absent. The managed runtime now ensures `steam.exe` and its client helper are ready before HLAE launch, starts Steam silently when needed, and applies a bounded 30-second readiness deadline.

### ISSUE-007 — Highlight handles crossed an authoritative round boundary — fixed

The R20 request expanded through the R21 full-packet boundary at tick `161630`. HLAE temporarily left Demo playback there and the bridge correctly refused to fabricate a capture-end tick. Highlight-bound capture handles are now clamped to the persisted round, while the bridge also requires five seconds of continuous playback loss before declaring the Demo gone. Authenticated bridge failure reasons are preserved through Runtime instead of collapsing to `Failed`.

- Completed workflow: [final-real-workflow-complete-1440x900.png](screenshots/final-real-workflow-complete-1440x900.png)
- Finished files: [final-real-export-1440x900.png](screenshots/final-real-export-1440x900.png)
- Project export: [final-project-export-1440x900.png](screenshots/final-project-export-1440x900.png)

## Real end-to-end boundary status

| Boundary | Status | Evidence |
|---|---|---|
| UI entry → Demo | pass | Real M1 imported and addressed as `c17559d6-0ee6-4465-b913-ec403326dd62` |
| Demo → analysis | pass | `de_mirage`, 21 rounds, 10 players, 457 highlights |
| Analysis → Agent evidence/tools | pass | Kimi K3 grounded FalleN R20 and called cinematic-context/plan tools |
| Agent → persisted shot list | pass | Plan `dd0b7b7d-de81-41ac-88ca-57d1ae265f73`, one bound R20 shot |
| Shot list → recording preflight | pass | CS2, managed HLAE, Demo identity, encoders, output path and observer evidence pass; collision remains a documented non-blocking warning |
| Preflight → HLAE/CS2 capture | pass | Recording job `2e3dee81-2bb0-4589-aafa-d4ed1e5ff88e` completed through managed HLAE 2.191.1 |
| Capture → Take/Composition | pass | Take `2e9bc7c7-f640-4cee-8ba4-be00137ac021`; Composition `a86bf42c-f363-4aef-aedd-2c8f35b43a83` |
| Composition → playable export | pass | Export `2b8732b3-f3c1-49ee-acfe-02764e0e8d4e`; 1920×1080, 60 fps, H.264 + 48 kHz stereo AAC, 8.55 s, 9,280,863 bytes |

The earlier stable/prerelease bridge-timeout experiments are retained as diagnostic history, but their compatibility conclusion is superseded. The hook and official script runtime work on this CS2 build; Steam absence prevented command execution, and a cross-round capture window exposed a second state-boundary error.

## Automated regression

- Web: 361 files / 4,310 tests pass.
- Web lint: strict Lingui compile, layer check over 1,097 source files, and TypeScript pass.
- Web production build: 2,339 modules transformed successfully.
- Rust: application 329 pass; storage 163 pass / 1 real-data test ignored; HLAE 69 pass / 1 official-archive test ignored; runtime 251 pass / 5 environment-dependent tests ignored; integration and doc tests pass.
- Strict Clippy passes for the changed HLAE and Runtime targets using an isolated target directory; the repository-wide dependency lint still contains unrelated pre-existing domain warnings.
- Package-scoped Rust formatting and `git diff --check` pass. Workspace-wide `cargo fmt --all -- --check` still reports pre-existing formatting drift inside vendored `vendor/demoparser`; no vendor file was rewritten for this UI/runtime fix.
