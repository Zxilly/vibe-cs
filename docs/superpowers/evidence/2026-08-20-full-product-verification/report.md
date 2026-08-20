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

The complete application surface is visually verified at all three target sizes: 29 pages or first-class subviews × 3 viewports, with no document horizontal overflow, out-of-bounds controls, loading state left behind, or page error in the accepted captures. The real-data flow passes from Demo import through analysis, a real Kimi K3 turn, persisted shot list, and recording preflight.

The last native boundary is still blocked: current Steam CS2 build `24701871` loads `AfxHookSource2.dll`, but neither managed HLAE 2.191.1 nor the official 2.192.1 prerelease executes the generated `mirv_script_load` bridge far enough to connect to the PID-bound loopback listener. Therefore no real Take, Composition, or MP4 is claimed.

## Route and state matrix

| Surface | States/views | 1100×700 | 1440×900 | 2560×1392 | Result |
|---|---|---:|---:|---:|---|
| Workbench | real attention state | captured | captured | captured | pass |
| Library | Demo, Steam | 2/2 | 2/2 | 2/2 | pass |
| Player directory/profile | list, real FalleN profile | 2/2 | 2/2 | 2/2 | pass |
| Evidence | search/results | captured | captured | captured | pass |
| Match workspace | overview, rounds, players, duels, utility, replay, highlights, review, teams | 9/9 | 9/9 | 9/9 | pass |
| Projects | list | captured | captured | captured | pass |
| Project workspace | select, Agent/shot list, recording | 3/3 | 3/3 | 3/3 | pass |
| Delivery | outputs, failed recording task detail | 2/2 | 2/2 | 2/2 | pass |
| Settings | app, files/Steam, game, AI, advanced | 5/5 | 5/5 | 5/5 | pass |
| Recovery / Guide / Not found | route states | 3/3 | 3/3 | 3/3 | pass |
| Project export | requires a real confirmed Composition | blocked | blocked | blocked | blocked by native capture |

Accepted compact and medium matrices are visible in [contact-sheet-1100x700.png](contact-sheet-1100x700.png) and [contact-sheet-1440x900.png](contact-sheet-1440x900.png). The `01`–`12` captures are the individually inspected maximized states. Loading/rejected captures such as `04-players` and `09c-project-record` remain as audit history; `04b` and `09c3` are their accepted replacements.

## Browser checks

- All accepted 1100×700 and 1440×900 targets reported `scrollWidth === innerWidth` and no interactive element outside the viewport.
- Accepted maximized targets were inspected individually for content clipping, overlap, inert lower regions, and missing next actions.
- Deep links restored settings items and match subviews directly.
- The work-mode menu, compact sidebar, pagination, filters, dialogs, and primary route transitions were exercised from the accessibility tree.
- No current page exception or failed resource request remained after the final reload. Historic Vite HMR reconnect warnings in the long-lived console were caused by Rust-triggered Desktop restarts and were not counted as page failures.

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

## Real end-to-end boundary status

| Boundary | Status | Evidence |
|---|---|---|
| UI entry → Demo | pass | Real M1 imported and addressed as `c17559d6-0ee6-4465-b913-ec403326dd62` |
| Demo → analysis | pass | `de_mirage`, 21 rounds, 10 players, 457 highlights |
| Analysis → Agent evidence/tools | pass | Kimi K3 grounded FalleN R20 and called cinematic-context/plan tools |
| Agent → persisted shot list | pass | Plan `dd0b7b7d-de81-41ac-88ca-57d1ae265f73`, one bound R20 shot |
| Shot list → recording preflight | pass | CS2, managed HLAE, Demo identity, encoders, output path and observer evidence pass; collision remains a documented non-blocking warning |
| Preflight → HLAE/CS2 capture | fail — external compatibility | Stable and official prerelease both time out before the managed bridge connects |
| Capture → Take/Composition | blocked | No capture was fabricated, so no Take/Composition exists |
| Composition → playable export | blocked | Export correctly refuses to advance without a confirmed Composition |

Bounded prerelease experiment evidence is retained as `40`–`42`; it does not replace the reviewed stable pin. Failed jobs `b48dd450-85a3-4995-8996-8fb4a7a5f0ed`, `1245a6ab-23e7-4203-8ebf-635d680c111f`, and `83a34e27-3d36-402a-8716-57477c39825f` all ended at `[HLAE_BRIDGE_TIMEOUT]`. The experimental eager-bridge source changes and prerelease pin were reverted after proving the generated script never executed, and no CS2/HLAE process was intentionally left running.

## Automated regression

- Web: 361 files / 4,308 tests pass.
- Web lint: strict Lingui compile, layer check over 1,097 source files, and TypeScript pass.
- Web production build: 2,339 modules transformed successfully.
- Rust: application 329 pass; HLAE 69 pass / 1 official-archive test ignored; runtime 247 pass / 5 environment-dependent tests ignored; integration and doc tests pass.
- Package-scoped Rust formatting and `git diff --check` pass. Workspace-wide `cargo fmt --all -- --check` still reports pre-existing formatting drift inside vendored `vendor/demoparser`; no vendor file was rewritten for this UI/runtime fix.
