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
  one immutable `demo_id/evidence_id/round/tick` locator.
- `storage` owns the current SQLite schema, explicit transactions, project snapshots, jobs, library
  records, durable analysis attempts and their bounded events, evidence projections, canonical
  evidence annotations and the Activity query over its four authoritative sources. Activity summary,
  filtered total and page rows come from one SQLite transaction; there is no materialized Activity
  table or compatibility view. Every analysis result is bound to the exact completed producer run by
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
  deterministic read/proposal tools. It has no filesystem, shell, or process execution tool.
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
  been cancelled. The player directory builds one cached, bounded catalog from at most 1,000 Demos,
  then applies server filtering, stable enum-selected sort with a SteamID tie-break, and finally
  pagination. It reports the scanned count and completeness; sorting one returned page never stands
  in for the catalog-wide operation. The current-only player comparison route requires two distinct,
  valid Steam64 IDs that both belong to that catalog and returns them in the requested order; malformed
  or duplicate IDs are rejected, a missing member returns no partial comparison, and the client rejects
  an out-of-order response. The UI retains at most two explicit IDs across page, search, sort and layout
  changes, replacing the oldest ID when a third is selected. If a comparison becomes missing, exact
  profile reads remove only identities proven absent. This is explicit selection, not select-all or a
  filtered-set promise, and a one-page catalog does not establish cross-page or multi-match behavior.
  Evidence Search has an exact participant filter that matches an actor, target or indexed highlight
  victim by normalized player ID or name. The Player profile uses that persistent query for a first-ten
  cross-match evidence preview with total/index completeness, Round/Replay links that retain the
  inspected player, and a link to the exact full search; it is not a complete profile analytics model.
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
  attempt. It polls that run rather than inferring its progress from Demo lifecycle and fetches its
  completed result through the producer-bound run endpoint; an already-ready Demo opened without a
  run can still use the Demo result route, whose row is producer-bound in storage. Activity uses
  `analysis:<run_id>`, displays the persisted stage, input fingerprint, error and ordered events, and
  starts retry as a new run without rewriting the failed or interrupted attempt. It never invents an
  analysis percentage.

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
`input_revalidation_started`, `projection_started`, `completed`, `failed` and `interrupted`.
`analyses.producer_run_id` and its completed producer status bind a result to that exact attempt;
Demo ID alone is not sufficient provenance for the run-result endpoint.

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

On startup, queued/running analysis attempts become `interrupted` with a durable terminal event. A
Demo moves to `failed` only if it is still owned by that attempt's `analyzing` lifecycle; a concurrent
`missing`, newly discovered fingerprint or ready result is not overwritten. Ownerless indexing or
analyzing Demo lifecycle is also terminalized. If either durable recovery read/write fails, runtime
composition fails and the desktop does not begin serving an unrecovered active attempt.

Analysis currently has no cancel endpoint, heartbeat/lease or synthetic percentage. A hard host crash
can still leave an OS worker process or request/response/repair artifacts in `worker-tasks/`; startup
run recovery does not prove those physical artifacts were reaped. The recorded SHA-256/size values are
two observations of the Demo source path before and after parsing, not proof that one immutable file
handle supplied every parser byte. In particular, terminal-tail recovery parses a bounded repair copy,
and the copy's separate byte provenance is not recorded in the run events. This narrow physical-file
TOCTOU boundary remains explicit.

The completed-run success path has passed a fresh real-Major product gate at exact source
`d733b6cf8690996db516a08edc0e0df37b41851c`. The isolated
`app.vibecs.analysisrun-audit` desktop executable had SHA-256
`dafa01d17351d9b0730816b6e6bf320a509be201f102679a922d1f2e22100d1d`, and its paired demo worker had
SHA-256 `2e99e8e365b7047dcd39eebc305d79e84438ea7d58757e2fb1eed4cb14c87255`.
`agent-browser` connected directly to the Tauri WebView2 CDP endpoint; Computer Use was not used.
The fresh database completed all three Major runs. The accepted M1 evidence proves six ordered
persistent events, exact input fingerprint/size, `result_available=true`, a URL retaining both Demo
and run IDs, and the matching `analysis:<run_id>` Activity/Open Analysis path. Activity had no
document overflow at 2560×1392 or 1100×700; at 1100 it retained a 698.7px table and 300px independently
scrollable inspector. This is a success-path product gate only: no analysis failure, interruption,
retry or cancel was executed, and startup/concurrency recovery remains deterministic-test evidence.

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
  Product audits that must preserve an earlier default data tree use a separate build-time Tauri
  identifier and fresh application-data directory. That isolation is not a migration or compatibility
  path.
