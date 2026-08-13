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
  records, evidence projections and canonical evidence annotations. Annotation creation verifies the
  locator against `evidence_search_items`; Demo deletion cascades to annotations.
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
  active-task tracking, mutation events and the Activity read model. Activity merges persisted
  recording, export, download and analysis facts, then applies stable ordering, filters and a bounded
  page; it is not an event-history store or a database cursor. Failed or cancelled persisted Steam
  downloads expose retry and match-history actions. Retry persists a new queued job before background
  work starts and does not rewrite the old job, error or byte counts. Activity is private to the
  desktop process.
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
  full-library sort. Match History similarly owns one exact `q/page/page_size` URL contract; result-set
  changes reset the page, and an asynchronous response is committed only while its request still
  matches the current URL and has not been cancelled. The player directory builds one cached,
  bounded catalog from at most 1,000 Demos, then applies server filtering, stable enum-selected sort
  with a SteamID tie-break, and finally pagination. It reports the scanned count and completeness;
  sorting one returned page never stands in for the catalog-wide operation. Evidence Search exposes
  the canonical annotation records through a global index whose URL owns bounded `q/tag/state/page`
  selection and whose rows deep-link back to Round or Replay. The Openings workspace is a
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
  entity is inferred. Clutch Review is likewise a current-analysis projection: it accepts a highlight
  only when an exact win/attempt outcome, one unambiguous `1vN` tag, canonical player and round,
  in-range ticks and opponent relationships all agree; inconsistent candidates are rejected rather
  than coerced into a scenario. Production previews the bounded persisted Activity read model rather
  than mock progress. Outputs treats staged cleanup as an independent recovery capability, so a
  true-zero output collection can hide collection controls while retaining that action. An export row
  with a source project links to the Editor by exact project ID; an absent requested project fails
  closed to an explicit notice and blank document instead of selecting another project.

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

Evidence annotations also live in SQLite as current-schema records. Their body, tags and review
state can change without changing the canonical locator. They survive a normal desktop restart,
are page-queryable with bounded `q`, tag, review-state, Demo and evidence-ID filters, and are removed
with their owning Demo. The server query contract is implemented and tested, and the global
annotation-index UI exposes `q/tag/state/page`, pagination and Round/Replay links. The currentaudit
product check covered its 1100×700 zero-result state in a fresh database; it does not establish a
non-empty or multi-page product gate. Annotations are not aliases for the older Demo remark field,
an algorithmic highlight tag, or an Agent thread.

## Command and task flow

The application dispatcher validates identity and command shape before calling a narrow port. A concrete runtime port
loads persistent state, performs filesystem/network/process work through a bounded adapter and
persists the resulting domain record. The React client never chooses an arbitrary executable,
remote avatar origin or LLM evidence document at request time.

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
progress.

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
