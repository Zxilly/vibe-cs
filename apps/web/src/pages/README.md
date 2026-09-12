# Product modules

Page ownership follows the Figma groups **剪辑模式**, **分析模式**, and **共享功能**.

| Group | Directory | Responsibility |
| --- | --- | --- |
| Editing | `editing/workspace` | Workbench and actionable project activity |
| Editing | `editing/projects` | Project library |
| Editing | `editing/editor` | Project workspace, human edits, Agent, recording and export confirmation |
| Editing | `editing/delivery` | Finished files and recorded media |
| Analysis | `analysis/match` | Match overview, rounds, players, duels, utility/economy, replay, highlights and review |
| Analysis | `analysis/players` | Player directory, comparisons and profile |
| Analysis | `analysis/evidence` | Cross-match evidence and annotations |
| Shared | `shared/library` | Demo import, library and Steam match history |
| Shared | `shared/tasks` | Task center and task detail |
| Shared | `shared/settings` | Configuration, diagnostics and recovery |
| Shared | `shared/onboarding` | First-run selection and environment readiness |
| Shared | `shared/navigation` | Router-aware links and query parsing |

The two modes may use shared pages but must not import each other. Shared pages
must not depend on either mode. `scripts/check-web-layers.mjs` enforces these
dependencies alongside the existing design, domain and data layers.

`domain/editing/ProjectTimeline` remains the only editable timeline. Its geometry
comes from `design/timeline`, and the Program Monitor samples the same Timeline
Transport. `domain/map` owns replay geometry used by both modes.

`domain/project/AddToProjectDialog` owns the shared evidence-to-project action.
`domain/task` owns task presentation, actions, polling vocabulary and the activity
drawer used by the app shell. Pages compose these modules through `data/*`;
they do not create separate editing, Agent or task state authorities.

The root `routes.tsx` composes the shell and page entry points. Shared tasks use
`/tasks` and `/tasks/:taskId`, preserving the current workspace mode. File delivery
uses `/delivery`; a `project` query selects that Project's outputs.

## Round economy

`crates/demo` samples equipment value and balance at the observed freeze-end
tick. `crates/domain/src/round_equipment.rs` aggregates the five players of each
stable team and derives the buy type. The frontend displays that classification;
it does not infer it from purchase-event counts or current CT/T labels.

The competitive classification follows the equipment and cash thresholds in
[cs-demo-analyzer](https://github.com/akiver/cs-demo-analyzer/blob/main/pkg/api/economy.go):
eco at team equipment of $5,000 or less; full buy at $20,000 for T or $22,500 for
CT; otherwise a lost preceding round and less than $2,000 remaining cash imply
a force buy, with semi buy for the remaining cases. Round one and the first
observed regulation side swap are pistol rounds; later overtime swaps are not.
The half detection requires contiguous round evidence from round one. Missing
equipment, cash, result or side-history evidence remains unavailable whenever
that evidence is required to classify the round.

The parser's real-demo regression checks all rounds of three Major final maps,
including complete equipment, buy types and the observed pistol rounds.
