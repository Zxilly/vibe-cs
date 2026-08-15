# Architecture

Vibe CS is a native, local-first desktop application. Tauri owns the process boundary: React sends
IPC commands to managed Rust state, receives large binary results as raw IPC bytes, and reads media
through a private application protocol. The only local HTTP listener is a single authenticated
CS2 GSI ingestion route required by the game protocol; it exposes no product commands.

## Dependency direction

```text
apps/desktop ─────> agent + application + runtime + storage

agent ────────────> Rig + bounded request-local Demo/editor/audio evidence

runtime ─> application + cosmetics + demo + domain + hlae + integrations
        + media + platform-windows + recording + source-assets + storage

application ───────> demo + domain + storage
storage ───────────> domain
demo ──────────────> domain + source2-demo + pinned demoparser worker backend
cosmetics ─────────> domain + source2-demo
media ─────────────> domain
integrations ──────> domain
recording ─────────> domain + integrations + platform-windows
hlae ──────────────> typed plans + managed runtime verification + launch contracts
source-assets ─────> bounded codecs + VPK reader

apps/demo-worker ──> demo + domain
apps/web ── Tauri invoke/raw IPC/private media protocol ──> apps/desktop
```

- `domain` contains serializable records, validation and errors and performs no I/O. The current
  evidence-annotation contract binds editable user text, free-form tags and open/resolved state to
  one immutable `demo_id/evidence_id/round/tick` locator. The separate review-metadata contract
  models the CS Demo Manager-style Comment/Tags surfaces for Demo, canonical Player Steam64 and
  exact current-source Round identities; it is not an alias for Evidence Annotation.
- `storage` owns the current SQLite schema, explicit transactions, project snapshots, jobs, library
  records, durable analysis attempts and their bounded events, evidence and player-match projections,
  canonical evidence annotations, the shared review-tag catalog and Demo/Player/Round review metadata,
  and the Activity query over its four authoritative sources. Activity summary,
  filtered total and page rows come from one SQLite transaction; there is no materialized Activity
  table or compatibility view. An exact Activity read resolves one canonical lowercase
  `<kind>/<uuid>` against only that kind's authoritative source and calculates retryability and result
  availability in the same transaction; malformed or retired locators are invalid and a UUID from
  another kind is not a match. Every analysis result is bound to the exact completed producer run by
  a composite foreign key. Annotation creation verifies the locator against
  `evidence_search_items`; Demo deletion cascades to annotations.
- `demo` owns safe discovery, ZIP extraction, hashing, Source 2 parsing, entity replay, insights,
  heatmaps, highlight classification and narrowly bounded malformed-demo repair planning.
- `cosmetics` inspects and rewrites a fixed set of observed Source 2 entity fields to a new demo.
- `source-assets` provides bounded read-only VPK v2 access, overview parsing and compiled radar
  texture decoding, plus localized cosmetic catalog and inventory-image extraction.
- `media` links the FFmpeg libraries through `ffmpeg-next`, owns in-process container inspection,
  audio waveform decoding, bounded RustFFT rhythm analysis and advisory beat-alignment planning,
  and executes render plans as native codec/filter graphs. It never invokes a command shell.
- `integrations` isolates Steam HTTP, GSI payloads, launch commands, Steam AppID-based installation
  discovery and OpenAI-compatible HTTP.
- `hlae` owns bounded movie plans, application-managed release verification, deterministic bundle
  export, offline-only custom-loader invocation and the post-launch handshake protocol. It never
  invokes a shell and does not execute HLAE itself.
- `platform-windows` owns process discovery, foreground verification, typed Unicode input, direct
  process launch, Media Foundation capability/timing primitives and integrity-checked
  backup/recovery primitives.
- `recording` coordinates acknowledged game playback, evidence-backed director plans, calibrated
  overlays, job-scoped capture settings, a capture-backend-neutral recorder, cleanup and atomic
  publication. The concrete movie backend is managed HLAE capture followed by Windows Media
  Foundation encoding.
- `application` owns use-case validation, status mapping, bounded uploads and media reads,
  active-task tracking, mutation events and Activity API mapping. Activity filtering, counting and
  paging stay at the storage boundary: a kind-specific query reads only that authoritative source;
  a cross-kind query filters, orders and windows each source before the final merge, ordered by
  `updated_at DESC, activity_id ASC`. Retryability and exact result availability are calculated only
  for the download, recording and analysis rows in the returned page. The aggregate result is not an
  event-history store, a materialized unified table or a general database cursor; exact analysis-run
  detail reads its separate bounded event source. A failed or cancelled persisted Steam download
  exposes retry only when it is the latest eligible attempt, the match is not downloaded, the
  current Steam ID and 32-character
  hexadecimal Web API key are syntactically valid, and the record belongs to that current account. A
  failed or cancelled recording exposes retry only when storage can prove one unclaimed unpublished
  suffix; Activity never guesses a resumable capture tick. Activity is private to the desktop process.
- `agent` owns the in-process Rig model/tool loop, provider URL policy, streaming limits, and
  deterministic read/proposal tools. Its `video_render` proposal contains validated recording
  requests and an MP4 contract. The web host expands those requests into the recording workspace;
  the user edits the real queue, previews its current fingerprint, and explicitly confirms before
  the desktop/application boundary—not the model—executes the durable recording job. HLAE remains
  an internal runtime capture tool. The model has no filesystem, shell, or process execution tool.
- `runtime` composes concrete analysis, review, player, cosmetics, export, recording, integration,
  media, cache and source-asset ports.
- `desktop` owns application-data resolution, Tauri managed state, IPC, the media protocol and
  process lifecycle.
- `web` keeps DTOs at the desktop command boundary and uses feature-local state for analysis, queue,
  editor and settings workflows. Library query and current column-visibility state are URL-owned;
  the column contract accepts only unique keys for fields present in the current DTO and exposes
  unavailable data such as file size as a capability gap instead of a placeholder column. Search,
  filter, stable sort and page selection stay at the SQLite boundary and never imply a client-side
  full-library sort. Library batch Analysis selection keeps at most twelve explicit canonical IDs in
  component state across page, page-size, sort, column and view changes; search, map or lifecycle
  changes clear it. It never means every filtered row. Before navigation, the client refetches each
  exact Demo and verifies its identity and current analyzable lifecycle; a partial rejection stops for
  explicit confirmation, while a non-404 read failure fails the whole preflight. Match History
  similarly owns one exact `q/page/page_size` URL contract; result-set changes reset the page, and an
  asynchronous response is committed only while its request still matches the current URL and has not
  been cancelled. The player directory reads a persistent SQLite player-match projection instead of
  scanning or deserializing a bounded Demo catalog in runtime memory. Analysis completion validates
  unique canonical Steam64 identities and finite non-negative ADR/K/D values, then commits
  `player_match_items`, `player_match_projection_state`, the result/evidence projections and Demo
  `ready` state in one transaction. Queries admit only a projection whose recorded analysis timestamp
  and player-row count still match the authoritative analysis; search, enum-selected stable sort,
  count and pagination remain at the SQLite boundary. Directory, profile, match-page and comparison
  responses all expose `projected_demos`, `total_analyses` and `projection_complete`. An absent exact
  player is `404` only when coverage is complete; incomplete coverage makes absence unavailable rather
  than turning a partial projection into a false not-found result. A profile returns at most 32 stored
  aliases while `aliases_total` reports the complete distinct total.
  Player match dates are read by joining the current Demo row, not copied into the projection:
  nullable `match_date`/`last_match_date` mean a trusted competition time, while required
  `cataloged_at`/`last_cataloged_at` mean local catalog time and never substitute for it. Known match
  dates sort first; catalog time is only a stable fallback among unknown dates, which the UI labels
  unavailable. The current-only comparison route requires two distinct valid Steam64 IDs, returns
  them in request order and never returns a partial pair. The strict Player URL owns
  `q/page/sort/direction/player/compare/matches_page/maps_page/heatmap_map/heatmap_kind/inspector`;
  only `inspector=1` means open. Search
  debounce and server page correction replace history, user selection/paging/sort actions push it,
  and Reload/Back restore the exact single-player, ordered-pair and compact-drawer state. The UI keeps
  at most two explicit IDs, replacing the oldest when a third is selected; exact reconciliation removes
  only identities proven absent. This is explicit selection, not select-all or a filtered-set promise.
  Evidence Search has an exact participant filter that matches an actor, target or indexed highlight
  victim by normalized player ID or name. The Player profile uses that persistent query for a first-ten
  cross-match evidence preview with total/index completeness, Round/Replay links that retain the
  inspected player, and a link to the exact full search; it is not a complete profile analytics model.
  The same profile can request one exact map-scoped cross-match heatmap. Its read model reuses the
  producer-bound Evidence Search projection: completion stores finite attacker and victim role
  coordinates, while the query admits only evidence and player projections whose producer timestamp
  and row counts still match the current Analysis. Kills use the canonical attacker coordinate and
  deaths use the canonical victim coordinate. Responses are capped at 5,000 points; an over-limit
  response reports the exact total but returns no partial point set. The renderer loads the complete
  bounded artifact once, filters kill/death visibility locally so relative fallback coordinates do not
  drift, and keeps every point bound to exact Demo/evidence/round/tick/player Round and Replay URLs.
  A verified local radar transform is preferred; otherwise the UI labels an aspect-preserving relative
  coordinate plane and does not infer visibility, paths, regions, map control or win probability.
  Evidence Search also exposes canonical
  annotation records through a global index whose URL owns bounded `q/tag/state/page` selection and
  whose rows deep-link back to Round or Replay. Canonical Highlight cards read the same records,
  distinguish unavailable annotation state from a true zero, show open/resolved summaries and reuse
  the existing annotation CRUD drawer; successful mutations refresh the card even if the drawer was
  already closed. This is not an accepted/rejected review queue. The Openings workspace is a
  deterministic projection of the loaded analysis: it
  accepts only the earliest kill by tick in each round, resolves both participants through canonical
  player IDs, and marks the round unavailable when that first event cannot be verified. Its 10-by-10
  directional matrix is row-actor/column-target; selecting a cell filters the same canonical atomic
  evidence. It never promotes a later kill or infers trades, KAST or rating.
  Man Advantage Review is a separate current-analysis projection. It requires two stable five-player
  summary rosters, one exact ten-player roster for every uniquely numbered round, one in-bounds
  canonical round-end, unique canonical event IDs and resolvable death targets. It starts each round
  from the roster and subtracts parsed death targets; deaths at one tick are one atomic transition,
  an actorless death remains attributable only to its target, and a team kill decrements the target's
  team. A repeated target or duplicate same-tick target makes that round unavailable. Its two-by-two
  matrix is first-lead Team A/B by final winner Team A/B. This is a remaining-uneliminated projection,
  not health/alive/disconnect evidence, a win probability, trade, KAST or rating.
  Objective Review is another deterministic current-analysis projection over the exact producer-bound
  Analysis document emitted by the existing pinned demoparser worker; it adds no parser field, schema or
  spatial decoder. It requires stable five-player Team A/B summary rosters, one exact ten-player roster
  for every uniquely positive-numbered source round, one canonical plant in each published plant round,
  one unique in-bounds `round_end` at or after that plant, and nonblank event IDs that are globally unique
  for every published atom. The canonical window is inclusive:
  `plant.tick <= atom.tick <= round_end.tick`. Atoms sharing a tick are one atomic group; source-ID order
  makes rendering deterministic but never claims an order within that tick. The planter must be a
  canonical T-side player, every non-null combat actor and every target must resolve through the exact
  round roster, a defuse actor must be canonical CT, and an explosion actor is either null or canonical.
  Any recognized actor, target, terminal or round-winner side alias that is present but null, invalid,
  internally conflicting or inconsistent with roster truth makes the round unavailable. A terminal
  event must be unique, inside the plant window and consistent with the verified winner; its absence is
  presented only as no canonical terminal recorded.
  Objective Review publishes canonical plant, kill, damage, defuse, explode and distinct actorless
  `round_end` atoms. Raw site metadata is accepted only as a non-negative safe-integer number or bounded
  decimal string and is labelled as a raw code, never as bombsite A/B or spatial evidence. Round, Replay,
  Watch and Production actions are rebuilt from the current source; Add requires a canonical actor, so
  the `round_end` boundary has no POV action. This projection does not infer retakes, saves, trades, KAST,
  rating, bomb position or within-tick chronology.
  The Team Round workspace is another deterministic projection. It opens only when two exact
  five-player summary rosters and every exact ten-player round roster prove stable Team A/B identity,
  teammate/opponent sides, an A/B winner and an in-bounds canonical `round_end`. Its 2-by-2 cells are
  Team A/B by T/CT and report round wins over rounds played, never a win rate. A selected cell filters
  kills plus the same canonical round-end evidence; raw T/CT summaries fail closed and no organization
  entity is inferred. Team Economy reuses that exact stable-match context. It accepts only unique,
  in-round purchase events with a canonical actor; any explicit event-side field must agree with the
  actor's roster side. Its four Team A/B by T/CT cells report rounds, accepted purchases, item counts
  and only explicitly decoded non-negative cost. Missing cost retains the purchase count while making
  spend partial and null. The detail table is bounded to 50 rows, the cell preview shows the three most
  frequent item groups plus a remainder, and evidence actions are rebuilt from the canonical source so
  a forged cost cannot create an executable action. Clutch Review is likewise a current-analysis
  projection: it accepts a highlight
  only when an exact win/attempt outcome, one unambiguous `1vN` tag, canonical player and round,
  in-range ticks and opponent relationships all agree; inconsistent candidates are rejected rather
  than coerced into a scenario. Production previews the bounded persisted Activity read model rather
  than mock progress. Outputs treats staged cleanup as an independent recovery capability, so a
  true-zero output collection can hide collection controls while retaining that action. An export row
  with a source project links to the Editor by exact project ID; an absent requested project fails
  closed to an explicit notice and blank document instead of selecting another project.
  Analysis navigation preserves an exact `run=<uuid>` identity for a started or explicitly selected
  attempt. An XState v5 machine owns only the renderer request/observation lifecycle
  (`loading -> observing -> ready | cancelled | failed | unavailable`), aborts stale route work and
  publishes the exact observed run; it does not own durable task truth or infer a terminal outcome
  from Demo lifecycle. Durable run state remains Rust/SQLite authority. The machine fetches a
  completed result through the producer-bound run endpoint; an already-ready Demo opened without a
  run can still use the Demo result route, whose row is producer-bound in storage. Activity uses
  `analysis:<run_id>`, displays the persisted stage, input fingerprint, error and ordered events, and
  starts retry as a new run without rewriting the failed or interrupted attempt. It never invents an
  analysis percentage. Activity selection is independently URL-owned as
  `activity=<kind:canonical-lowercase-uuid>` and is read through the exact endpoint even when the
  selected row is outside the current search, filter or page. The strict client parser binds kind,
  activity ID and job ID to the request. The exact observer retains the last good item during transient
  failures, backs off from 1.5 seconds through 15 seconds, treats 404 as unavailable without selecting
  another row, and aborts stale requests on context change or unmount. Production's recent rows use
  the same exact deep link. Action responses may select a newly created durable task, but a late
  response cannot hijack a changed or unmounted selection, and a queued action receipt is dismissed
  once that exact task advances to a different persisted status or stage.

Platform commands and process spawning do not appear in route handlers or domain records.

## Runtime data

The desktop host uses Tauri's per-user application-data resolver. The resulting tree is created lazily:

```text
<data-dir>/
  vibe-cs.db
  .gsi-auth-token
  worker-tasks/
  uploads/
    demos/
    assets/
  downloads/steam/
  exports/
  recordings/
  cosmetics/
  proxies/
  packages/
  package-uploads/
  portable-assets/
  playback-cache/
  replay-cache/
  avatar-cache/
  runtimes/
    hlae/
      v2.191.1/
  recovery/
  cleanup/editor-projects/
  .output-trash/
```

Configuration, projects, jobs, cosmetic plans and library metadata live in SQLite. External source demos and media
files are read-only; browser uploads and imported portable-package assets become managed files.
Temporary files are created in the target filesystem and become visible only after validation and
an atomic or no-clobber publication step. Replay and avatar caches have entry and byte ceilings;
proxy ownership and cleanup are persisted explicitly.

Analysis attempts live in current-only `analysis_runs` rows. A run carries one required nullable
SHA-256/size pair, exact status and stage, a required nullable terminal error, and created/updated
timestamps. `analysis_run_events` is ordered from sequence zero, permits at most 32 rows per run and
bounds event detail and terminal error to 2,000 characters. Its message-code/stage pairs are fixed to
`input_validation_started`, `input_verified`, `parser_started`,
  `input_revalidation_started`, `projection_started`, `completed`, `failed`, `interrupted` and
  `cancelled`.
`analyses.producer_run_id` and its completed producer status bind a result to that exact attempt;
Demo ID alone is not sufficient provenance for the run-result endpoint.

Player-match projection state is also current-only SQLite data. A zero-valid-player analysis still
writes its projection-state row, so completeness is not inferred from the existence of player rows.
Replacing or deleting an Analysis removes its player projection through the same transactional or
foreign-key boundary; no startup scan of serialized Analysis documents is the normal query path.

Evidence annotations also live in SQLite as current-schema records. Their body, tags and review
state can change without changing the canonical locator. They survive a normal desktop restart,
are page-queryable with bounded `q`, tag, review-state, Demo and evidence-ID filters, and are removed
with their owning Demo. The server query contract is implemented and tested, and the global
annotation-index UI exposes `q/tag/state/page`, pagination and Round/Replay links. In the fresh
`app.vibecs.currentaudit-workflows` product check, one canonical M1 Highlight annotation was created,
its card summary refreshed to one open review, and the exact body and tags were read back after a full
application restart. That check does not establish a non-empty or multi-page global-index gate, and
the close-during-pending race remains a deterministic test rather than a visual observation.
Annotations are not aliases for the older Demo remark field, an algorithmic highlight tag, or an
Agent thread; Agent, Round, Editor, Library and Player-profile review surfaces still do not all
consume them.

CS Demo Manager-style Comment/Tags use a separate current-only SQLite model. `review_tags` is the
shared catalog. Demo assignments remain attached to the Demo catalog identity; Player metadata is
keyed by one canonical Steam64 and therefore survives Analysis replacement; Round metadata is keyed
by `demo_id/source_sha256/round` and is readable or writable only when the current completed producer,
Demo fingerprint and unique round all agree. A same-ID content replacement therefore cannot carry an
old Round comment onto different bytes. The renderer uses one strict, abortable editor for Player and
Round subjects, while Library retains the Demo editor. Evidence Annotation continues to bind one
canonical evidence locator and open/resolved state; it is a Vibe-native review workflow and is not
counted as CS Demo Manager Comment/Tags parity.

## Command and task flow

The application dispatcher validates identity and command shape before calling a narrow port. A concrete runtime port
loads persistent state, performs filesystem/network/process work through a bounded adapter and
persists the resulting domain record. The React client never chooses an arbitrary executable,
remote avatar origin or LLM evidence document at request time.

Analysis uses one current-only durable attempt contract:

```text
validating_input -> parser_queued -> parser_running
  -> verifying_input_after_parse -> projecting -> completed
          |                  |              |
          +------------------+--------------+-> failed
          +------------------+--------------+-> interrupted on startup recovery
          +------------------+--------------+-> cancelled after owner cleanup
```

`POST /api/demos/{demo_id}/analysis-runs` atomically creates the run, its sequence-zero event and the
Demo `analyzing` lifecycle, then returns `202` after a background owner has accepted the claim. A
duplicate start returns the already-active run and does not start a second parser. The owner validates
and binds the source-path SHA-256/size before parser admission, records `parser_started` only after the
parser task/process starts, observes the source path again after parsing, then atomically commits the
completed run/event, producer-bound analysis and evidence projection, and Demo `ready` state. Exact
state is read through `GET /api/demos/{demo_id}/analysis-runs/active`,
`GET /api/analysis-runs/{run_id}` and `GET /api/analysis-runs/{run_id}/result`; the last endpoint never
returns a result produced by a different attempt.

`POST /api/analysis-runs/{run_id}/cancel` addresses one exact active run. The process-local owner
registry moves that owner from Running to Cancelling, signals validation/parser/sidecar work and waits
until those futures/processes have stopped and request/response/repair artifacts have been reaped.
Only then does SQLite atomically persist terminal `cancelled`, the reserved terminal event and a
truthful Demo lifecycle; an owner already in Committing rejects late cancellation with `409`. Concurrent
requests against the live owner share its terminal result; a later request for an already-cancelled exact
run idempotently returns the persisted detail without requiring an owner. Other terminal states and an
active run without its exact owner return `409`. Cleanup debt, an owner panic or permanent persistence
failure returns a non-success response and is reconciled as failure where storage remains writable;
it is never reported as a successful cancellation. A latest cancelled attempt is retryable as a new
run, leaving the cancelled run and its events unchanged. Activity exposes cancelled as its own summary,
filter, row and Inspector state rather than grouping it with failure.

On startup, queued/running analysis attempts become `interrupted` with a durable terminal event. A
Demo moves to `failed` only if it is still owned by that attempt's `analyzing` lifecycle; a concurrent
`missing`, newly discovered fingerprint or ready result is not overwritten. Ownerless indexing or
analyzing Demo lifecycle is also terminalized. If either durable recovery read/write fails, runtime
composition fails and the desktop does not begin serving an unrecovered active attempt.

Analysis still has no heartbeat/lease or synthetic percentage, and cancellation is not generalized to
other job kinds by this contract. A hard host crash can still leave an OS worker process or
request/response/repair artifacts in `worker-tasks/`; startup run recovery does not prove those
physical artifacts were reaped. The recorded SHA-256/size values are
two observations of the Demo source path before and after parsing, not proof that one immutable file
handle supplied every parser byte. In particular, terminal-tail recovery parses a bounded repair copy,
and the copy's separate byte provenance is not recorded in the run events. This narrow physical-file
TOCTOU boundary remains explicit.

The completed-run success path first passed a fresh real-Major product gate at exact source
`d733b6cf8690996db516a08edc0e0df37b41851c`. The isolated
`app.vibecs.analysisrun-audit` desktop executable had SHA-256
`dafa01d17351d9b0730816b6e6bf320a509be201f102679a922d1f2e22100d1d`, and its paired demo worker had
SHA-256 `2e99e8e365b7047dcd39eebc305d79e84438ea7d58757e2fb1eed4cb14c87255`.
`agent-browser` connected directly to the Tauri WebView2 CDP endpoint; Computer Use was not used.
The fresh database completed all three Major runs. The accepted M1 evidence proves six ordered
persistent events, exact input fingerprint/size, `result_available=true`, a URL retaining both Demo
and run IDs, and the matching `analysis:<run_id>` Activity/Open Analysis path. Activity had no
document overflow at 2560×1392 or 1100×700; at 1100 it retained a 698.7px table and 300px independently
scrollable inspector. That was a success-path product gate only: no analysis failure, interruption,
retry or cancel was executed there.

The later `app.vibecs.manadv-activity-audit` gate used `agent-browser` directly against Tauri
WebView2 CDP port 9341, not Computer Use. Its initial exact-HEAD `2d73e7f` executable had SHA-256
`c7b1af286654ee988fe2f3a927e639d68bb9873258de41bb2ac1b92585b517ca`; screenshots 01–07 and the
fresh database came from that build and identifier. Real Mirage Demo
`97221743-7c59-4ae3-bdfd-7eb427c0e75d` / run
`47499075-333f-4cac-803d-ae7dbfbc12de` proved a 21/21 Man Advantage workspace whose first-lead/final-
winner matrix was `7/3/1/10`, with 17 first leads won, four lost and five rounds containing a lead
change. The same product run proved Production-to-Activity exact deep linking, selection retained
while filtered out and after reload, and accepted 2560×1392 and 1100×700 layouts.

The host was then deliberately stopped immediately after starting a real Inferno analysis. On the
next startup, run `4ded8b20-59e9-4e14-961e-e2e44995e497` was durably reconciled to `interrupted`; its
retry created distinct run `02a7df9d-6a5c-456c-baac-6a461fb4e200`, left the old run intact and
completed against the same Demo. This is product evidence for one analysis startup-recovery and retry
path, not for cancel, concurrency, physical worker-artifact cleanup, Steam download retry, recording
retry, export mutation, CS2 or HLAE. That run also exposed a stale queued action receipt after the new
task had already completed. Commit `fc80c5f` fixed the client to retire a receipt only when the same
exact activity advances. Its exact-build executable SHA-256 was
`b77b0a458d1e4ccdc034d44404bca7b0d759364a5676436099698b64f3721ad8`; the embedded Web build
transformed 2,600 modules, and the paired worker remained
`2e99e8e365b7047dcd39eebc305d79e84438ea7d58757e2fb1eed4cb14c87255`. The full Web gate passed
619 tests with three skipped, plus lint, typecheck and build. Screenshot 08 is the separate focused
`fc80c5f` product check: loading an exact completed Activity showed no stale receipt. It did not run a
second same-session retry; automatic dismissal when one exact task advances is supported by the new
deterministic TDD and 24-test focused gate, not claimed as a repeated visual observation.

The later Analysis cancellation/XState product gate used exact source
`adf4d08f7b4524a9f451362d30b44bc05ac51db9`, fresh identifier
`app.vibecs.analysiscancel-xstate-audit`, desktop SHA-256
`b64c6a94da0e0c9d4259ddc0959a945473a5a343534e72ede2243d71618c3c3` and paired worker/manifest
SHA-256 `f7f37918e9eca55c58743853649a3ef582dbbaefdd68bd24078062efff589958`.
`agent-browser` connected directly to Tauri WebView2 CDP; Computer Use was not used. Real M2 run
`3133c56c-b932-4d9d-bd9f-0c0bd098a262` was cancelled during `validating_input`, then retry created
distinct run `c08ada94-3d5e-403f-adad-2102e07e6d70` and completed without rewriting the cancelled
attempt. More importantly, real M3 run `96009b44-b7ca-4bf1-9d20-ae2d4e872192` was observed at
`running/parser_running`; exact cancel changed worker count `1 -> 0`, task-artifact count `1 -> 0`
and persisted zero result rows. Its Demo returned to `Discovered` with the original SHA-256 preserved,
and its event tail was `cancelled/cancelled` with detail `analysis_cancelled_by_user`. Activity exact
selection survived a full restart, the cancelled-only filter returned the cancelled attempts, and the
Analysis XState terminal notice linked to that exact Activity run. Accepted screenshots are
`target-currentaudit-next/analysiscancel-xstate-visual/screenshots/06-activity-parser-running-cancellable-max.png`,
`07-activity-parser-cancelled-max.png`, `08-activity-parser-cancelled-1100.png`,
`09-activity-cancelled-restart-1100.png`, `10-activity-cancelled-filter-1100.png` and
`11-analysis-cancelled-1100.png`; structured product evidence is
`target-currentaudit-next/analysiscancel-xstate-visual/evidence.json` and build evidence is
`target-currentaudit-next/analysiscancel-xstate-build-evidence.json`. Same-viewport comparisons at
`comparison-activity-max.png` and `comparison-activity-1100.png` passed while preserving the existing
information hierarchy and Inspector geometry. Both checked viewports had no document overflow and
console/page errors were empty; the desktop, worker and CDP listener were all zero after the gate was
closed. This gate did not test heartbeat/lease,
concurrent retry, cancellation for other job kinds, permanent database-corruption quarantine, Watch,
CS2 or HLAE.

The later Player projection product gate used exact source
`1f7397ec857dc592d4e8525fc9ac4bf299d34db7`, fresh identifier
`app.vibecs.playerprojection-audit`, desktop SHA-256
`792eca8491d4ae36dfbfcc5ff3c9fed322edd1d72e58e0e7dc1abb85e1bfad01` and worker SHA-256
`2e99e8e365b7047dcd39eebc305d79e84438ea7d58757e2fb1eed4cb14c87255`.
`agent-browser` connected directly to the Tauri WebView2 CDP endpoint; Computer Use was not used.
A fresh product flow discovered and completed Analysis for the real Major M1/M2/M3 files, then showed
ten directory players with projection coverage `3/3`. FalleN had three exact local match rows and
aggregate `37/44/17`, ADR `89.1`, damage `5,615`; every source Demo had `match_date=NULL`, so all three
rows said that the match date was unavailable and separately labelled local catalog time. The gate
also retained one exact profile and one exact FalleN/NiKo pair across Reload, then used Back to restore
the closed single-selection bar. Screenshots `01-players-max-profile-top.png`,
`02-players-max-match-history.png`, `03-players-1100-profile-drawer.png` and
`04-players-1100-pair-drawer.png` are under
`target-playerprojection-audit-20260814/visual/screenshots/`; 2560x1392 and 1100x700 had no document
overflow, and console/page errors were empty. This establishes the current persistent projection,
truthful unknown-date presentation and URL-owned drawer flow for a three-Demo database. It is not a
real multi-page/large-library performance result, did not start Watch/CS2/HLAE and did not execute a
Steam network download.

The later cross-match Player heatmap gate used exact feature commit
`ba06e65`, identifier `app.vibecs.playerheatmap-audit` and desktop SHA-256
`c16d49785b7eec8fd9292fd8ed0ce31393d2c4a48038b5c43acec82e6a8e51e5`.
The isolated current-schema profile was created by the current app, then seeded with the three
previously product-gated Major Analysis/player rows while deliberately omitting evidence projection;
current startup rebuilt all `11,548` evidence rows from those persisted real Analysis documents. This
is a current-code projection/rebuild and UI gate, not a fresh parser run. FalleN
`76561197960690195` returned Mirage `9` kill and `14` death points, Anubis `18/15`, and Inferno
`10/15`, with no invalid coordinates. At `1440x900` the maximized Inspector was about `525px` wide,
the radar was `292.4x292.4`, and the document had no horizontal overflow. At `1100x700` the same
capability moved into the existing Drawer, the radar was `352.3x352.3`, and the document again had no
horizontal overflow. Reload preserved the nine-point kill filter, Back restored all 23 Mirage points,
and the selected R13/tick 110004 point stayed at `25.0797%, 27.3389%` across the filter change.
Accepted local screenshots are `target-currentaudit-next/player-heatmap-ba06e65-max.png` and
`target-currentaudit-next/player-heatmap-ba06e65-1100.png`; they are audit artifacts and are not
tracked. The gate did not reparse M1/M2/M3, start Watch/CS2/HLAE, or establish Team heatmaps,
intensity normalization, region aggregation, rank history or a large-library performance result.

The later Objective Review product gate used exact source
`fbc9c6a2c80fb44099bb62eec6b7e7b322afb58d` / tree
`ef344b8d699c2088f66ff0db2c3f77066437f31b`, fresh identifier
`app.vibecs.objective-audit`, desktop SHA-256
`ab3a18edd0993e2d8f1920dea40f9e30f32cf1b9582e01bf5e71c2f82a4f7c29` and worker SHA-256
`2e99e8e365b7047dcd39eebc305d79e84438ea7d58757e2fb1eed4cb14c87255`.
The fresh profile used the real product directory watch/discovery path to find all three Major files,
but analyzed only M1 Mirage. Demo `12f8900f-5ef4-4e50-b338-2f44f0a7dc45` / run
`03fda7f2-89d5-4578-a4f8-37d8b20b7bbc` completed with an exact producer-bound result. Its Objective
Review showed 8/8 verified plant rounds, planting-team wins/losses `7/1`,
defuse/explode/no-canonical-terminal `1/3/4`, 19 kill atoms and 55 damage-event atoms. R6 showed
molodoy as Team A / T planter at tick 39930, Team B as winner, a canonical defuse and the distinct
`round_end` at inclusive boundary tick 40691, and raw site code `407` without an A/B interpretation.
At 2560x1392 the three-column workspace had no overlap or document overflow. At 1100x700 the desktop
Inspector was hidden, its trigger remained visible, and the same evidence and enabled footer actions
were available in a 430x700 drawer; all four actions were enabled for the selected plant atom. Console
and page errors were empty. `agent-browser` connected
directly to the Tauri WebView2 CDP endpoint; Computer Use was not used.

Accepted screenshots `01-objective-max.png`, `02-objective-1100.png` and
`03-objective-1100-inspector.png` are under
`target-objective-audit-20260814/visual/screenshots/`; structured measurements are in
`target-objective-audit-20260814/visual/evidence.json`. A separate deterministic, environment-gated,
read-only SQLite audit reconstructed all three persisted Major analyses as 34 verified plant rounds,
planting-team wins/losses `29/5`, defuse/explode/no-canonical-terminal `5/16/13`, 80 kill atoms and
247 damage-event atoms. M2 and M3 remained only discovered in the fresh visual profile, so that
three-map oracle is not presented as fresh-product visual evidence. The product check did not click
Round, Replay, Watch or Add and did not start CS2 or HLAE. Alias conflicts, out-of-window terminals,
inclusive same-tick boundaries, exact action recanonicalization and non-plant round selection are
deterministic TDD facts, not claims derived from the screenshots. Neither gate establishes bombsite
A/B or spatial meaning, retake/save/trade/KAST/rating semantics, or real playback/capture success.

Recording, export and Steam-download records are persisted and queried through Tauri commands. Cancellation is
cooperative and job-scoped. A normal lifecycle is:

```text
queued -> preparing -> running -> completed
                         |
                         +-> cancelling -> cancelled
                         +-> failed
```

Exports, recordings and Steam downloads left active by a stopped host are reconciled to a terminal
state on the next startup; capture and downloads are not resumed from an ambiguous point. Mutations
publish desktop change events. Background render/capture progress is read from persistent job
records. The runtime state exposes the durable active recording job ID separately from the richer
job document, so the renderer can still address cancellation while status hydration is pending or
temporarily unavailable. Startup recovery verifies job-scoped staging/publication evidence: a
provably published output may complete, while ambiguous running/cancelling work is terminalized.
This is fail-safe reconciliation, not continuation from an assumed capture tick.
Creating a download retry is a new durable job transition, not mutation or continuation of the
terminal job. The old record remains available for diagnosis while the new queued job owns any later
progress. Before persisting that new job, the runtime revalidates the syntactic Steam ID/Web API key
requirements and exact account ownership. Missing configuration or a previous account's record is
rejected without creating a job or mutating the match record; this does not prove that the key is
accepted by Steam or that a later network request will succeed.

Demo content identity is current-schema, content-addressed truth: every non-null SHA-256 has one
catalog owner. Upload, local import, Watch discovery and Steam import validate bytes outside the
SQLite writer transaction, then atomically claim, merge or recover that identity. Replacing bytes for
one Demo invalidates its Analysis and dependent projections in the same transaction; a same-hash
duplicate cannot create a second owner. A Steam download claim creates the active job and moves its
match record to `downloading` in one immediate transaction while capturing any linked Demo identity.
Import and completion compare that claim-time identity and the verified path/hash/size again, so a
stale worker cannot overwrite a concurrently restored Demo or its completed Analysis. Job/record
terminal state commits together, cancellation wins over stale completion, progress is monotonic,
worker panic is supervised, transient terminal writes remain owned and retry with capped backoff, and
startup atomically terminalizes orphaned active downloads or fails composition.

Steam match time has a separate trust boundary. The current share-code synchronization supplies
`played_at=None` and never derives it from sync time, Demo catalog time or download time. Merge keeps
an existing trusted value and rejects conflicting known values; only an explicitly trusted
`played_at=Some(...)` may populate a Demo's nullable `match_date`. These content/download/date
contracts have deterministic storage/runtime coverage, but the Player projection product gate did
not perform a real Steam network download.

Creating a recording retry is likewise a new durable job, with an immutable `retry_of` link to one
failed or cancelled parent. The domain accepts only the unpublished suffix whose published prefix,
request IDs and cursor agree exactly; ambiguous lineage fails closed, the parent and its published
clips remain unchanged, and storage atomically permits only one child. A short-lived retry plan binds
the parent ID, parent `updated_at` and eligible-suffix SHA-256, and execution revalidates that binding
before claiming the child. Rejecting native recording consent creates no child. If startup is
interrupted after a normal or retry row becomes durable, the runtime cleanup guard stops the backend
and terminalizes any nonterminal row before releasing the active session. These contracts are covered
by deterministic tests; they do not establish a real CS2/HLAE suffix retry.

Release demo parsing runs in a single globally-admitted, integrity-pinned worker process;
the desktop locks the worker and its parent across process creation, and the worker enforces parser
thread, segment, decompression and aggregate-event budgets. Development without a generated worker
manifest uses only the cooperative Source 2 parser in-process. Upstream demoparser already uses
Rayon; multithreading is therefore not a reason to carry a local copy. The worker defaults to the
audited vendored fork because the current release contract additionally requires deterministic
offline-generated inputs, hard resource limits, checked decode, `spectator_slot`/exact-roster and
identity output, and the reviewed performance envelope. A bare upstream Git revision cannot supply
that contract. The worker follows its event pass with a bounded selected-tick pass for exact round
rosters. `VIBE_CS_DEMO_BACKEND=cooperative` is the only explicit worker diagnostic override; Fast
parser errors are returned without retrying the cooperative parser. The in-process `DemoEngine`
default stays on the cooperative parser so cancellation never depends on interrupting an in-process
parallel parse. Fast statistics do not embed dense entity snapshots; replay and heatmap use
positioned events as their explicit sparse fallback.

Exact selected-round replay is a separate producer-bound operation rather than an implicit upgrade
of that sparse fallback. `GET /api/analysis-runs/{run_id}/replay/rounds/{round}/replay.bin` binds the
completed run, current Analysis and Demo SHA-256/size before the worker reopens that source and
samples the verified ten-player roster every 16 ticks plus canonical event ticks. Every frame must
contain exactly the same ten Steam64 identities with finite position/yaw and bounded health, armor,
life-state and economy values; weapon is explicitly nullable. Its cache key includes the source
fingerprint, producer run, round and sampling contract, and corrupt or provenance-mismatched entries
are rejected and regenerated. These are exact samples without interpolation; they do not prove
shots, visibility, audio, inventory or continuous movement between samples.

The desktop, worker binary and worker manifest form one current release contract. They must be built
from the same source. A worker response missing a current required field is rejected; the unreleased
product does not add versioned response shells or fallback decoding for stale sidecars.

Movie capture is moving to an offline deterministic pipeline:

```text
confirmed edit evidence
  -> immutable HLAE bundle and launch profile
  -> verified managed HLAE + a newly created `-insecure` CS2 process
  -> authenticated in-game handshake
  -> bounded TGA frame sequence + game WAV in a job staging directory
  -> Windows Media Foundation H.264/AAC Sink Writer
  -> atomic MP4 publication
```

The managed HLAE cache is not part of the installer. A user action downloads one reviewed,
immutable archive from the official AdvancedFX GitHub release. The archive has a pinned size and
SHA-256, is extracted with entry/count/size/path limits, and every extracted file is revalidated
before discovery or launch. The reviewed release signature fingerprint is recorded as provenance;
runtime PGP verification is not claimed. HLAE loader exit success is only a transition to
`HookHandshaking`; it never proves that the hook, demo, seek, or capture succeeded. Those claims
require typed messages from the job-scoped, loopback-only session protocol.

Local playback and recording share an atomic runtime-session state. Playback moves from a unique
launching token to an active token and then an exclusive stopping token without a guessed timeout;
recording owns the state for the persisted job lifetime. A verified stop is bound to that token and
exact child-process handle, and releases only the matching session after that process has
stopped. A stale completion therefore cannot stop or clear a newer playback.

Editor saves use an optimistic revision in an immediate SQLite transaction. The current document
and its bounded snapshot are written together. Proxy and package workflows keep generating/staging
state separate from ready state so a crash cannot make a partial media file look complete. Editor
URL selection is exact-current-only: `project=<id>` selects that project or reports that exact ID as
missing and initializes a blank document; it never falls back to the first available project.

## Safety boundaries

- IPC commands are registered explicitly, media paths stay inside the private protocol namespace,
  and upload targets are allowlisted before bytes are parsed. The separate loopback GSI receiver
  accepts only the bounded, token-authenticated CS2 state payload route.
- Multipart and archive names are reduced to safe relative components. Request, file, entry,
  expansion, compression-ratio and total sizes are bounded, and partial batches are rolled back.
- Secrets are accepted on write, redacted from responses and debug output, and preserved when a
  client sends a recognized empty placeholder. Managed backups never include integration secrets.
- Steam profile/avatar and remote AI clients use constrained URL policies, redirects are disabled,
  time and response sizes are bounded, and response structure/MIME is validated before use.
- Managed GSI, HLAE preparation, output deletion and recording prerequisites use explicit
  confirmation, fingerprints or integrity-checked recovery artifacts as appropriate.
- HLAE always starts a new verified CS2 process with `-insecure`, isolated configuration and a
  managed output root. It never attaches to an existing process, joins a network server, accepts
  arbitrary console text from the UI/agent, or treats a loader exit code as a capture handshake.
- Executables receive structured program/argument vectors. User values are not interpolated into
  a command shell or FFmpeg command string.
- External files are never deleted by a record-only action. Physical delete and rename are limited
  to canonical managed roots, reject symbolic links, and use staging/rollback where database and
  filesystem state must change together.
- Security-sensitive cache publication and editor quarantine/recovery keep operations relative to
  already-opened directory capabilities. Validation is not followed by a fresh ambient path lookup
  that could be redirected through a concurrently replaced junction or symbolic link.
- Multi-row writes, snapshot restore and conditional revision changes use explicit transactions.
- SQLite has one exact schema fingerprint for the current unreleased product. A non-empty database
  that does not match it is rejected with an instruction to use a fresh data directory; the runtime
  does not import, rewrite or upgrade earlier experimental data.
  Analysis terminalization retries only errors classified as transient. A permanent database-health
  failure stops cancellation/failure persistence at an explicit health boundary; there is no current
  quarantine mechanism that can guarantee removal of an active/no-owner row from a permanently
  corrupted database.
  Product audits that must preserve an earlier default data tree use a separate build-time Tauri
  identifier and fresh application-data directory. That isolation is not a migration or compatibility
  path.
