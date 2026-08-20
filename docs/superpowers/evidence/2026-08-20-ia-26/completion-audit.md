# One-sentence video completion audit

Audited against PRD user stories 51-62, decisions D9-D17, and IA-19 through IA-26.

| Requirement | Current evidence | Result |
| --- | --- | --- |
| Demo + one sentence are the only user inputs | Library action creates an empty bound project; `useEnsureDemoAnalysis` joins/starts analysis; empty plans send `hlae`; Desktop materializes `video_render` into the plan | Proven in software |
| First sentence creates and keeps a session | `useAgentChatStream` creates user + streaming assistant entries before model execution and shares the durable session id with the embedded thread | Proven |
| Explicit Demo/work/plan context | `AgentChatInput` carries Demo, project, plan id/revision; Desktop re-reads and conditionally validates the selected plan | Proven |
| Analysis is automatic | discovered/failed starts one analysis; indexing/analyzing joins it; polling waits for `ready`; only a physically missing Demo blocks | Proven |
| Initial model result becomes a real shot list | Desktop converts the unique `video_render` proposal into typed bound shots and conditionally writes the empty plan | Proven |
| Agent baseline is real | the same transaction replaces the empty baseline with the generated shots and increments the authoritative revision | Proven |
| Subsequent Agent modifications are real and reviewable | `draft_agent_plan_changes` accepts only real selected shot ids and supports applicable shorten/delete changes; local code computes before/after and Desktop validates the bound plan/revision | Proven |
| Decisions and turn lifecycle survive reload | proposal decisions and conditional turn states live in session storage; retries link with `retry_of` | Proven |
| Proposal revision authority | Desktop stamps plan id/base revision and storage rejects stale proposal application | Proven |
| Preview | recorded result first, read-only CS2 preview fallback, no mutation until explicit accept | Proven |
| Take / Composition | relational storage, exact shot/take/order bindings, protected referenced Takes, confirmed-only export | Proven |
| One confirmation then automatic completion | recording execution registers Takes, confirms Composition and auto-starts export when an encoder exists | Proven |
| Failure/restart recovery | recording suffix retry preserves the run binding; workflow reconciliation is idempotent after database reopen | Proven |
| Model/token/cost metadata | provider/model/usage persist per completed turn; missing authoritative price is rendered as unknown | Proven |
| Accessibility | polite transcript/workflow announcements and decision announcements; focus advances to the next pending change | Proven |
| Production-mode boundaries | one-way copy graph `Agent → Quick → Multitrack`; source remains untouched; unsupported reverse conversions explain information loss | Proven |
| Real Tauri UI | WebView2 CDP verifies migration, one-sentence gate, settings deep link and conversion dialog at 1440×900 | Proven |
| Real user Demo → real CS2 recording → real final MP4 | Current machine has no imported Demo or configured model credential; no placeholder data was inserted | Pending external input |

## Vertical executable proof

Desktop test `one_sentence_materializes_a_plan_and_reaches_a_persisted_final_video` runs one isolated chain:

1. persisted analyzed Demo and empty Agent plan;
2. one natural-language request through a loopback streaming model;
3. `draft_video_plan` and typed shot-list materialization;
4. explicit recording-plan execution;
5. recorded Take registration;
6. confirmed Composition;
7. final MP4 export;
8. database reopen proving plan baseline, Take, Composition and output association survive restart.

The recording and export adapters in this test are deterministic test adapters, so this proves all software-owned orchestration and persistence but does not replace the outstanding real CS2/HLAE hardware acceptance.
