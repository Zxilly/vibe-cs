# Architecture

Vibe CS is a loopback-only, local-first application. The HTTP boundary gives the React client,
desktop shell, standalone host and integration tests one contract; it is not a public service
boundary.

## Dependency direction

```text
apps/desktop ─┐
apps/server  ─┴─> api + runtime + storage

runtime ─> api + cosmetics + demo + domain + integrations + media
        + platform-windows + recording + source-assets + storage

api ───────────────> demo + domain + storage
storage ───────────> domain
demo ──────────────> domain + source2-demo
cosmetics ─────────> domain + source2-demo
media ─────────────> domain
integrations ──────> domain
recording ─────────> domain + integrations + platform-windows
source-assets ─────> bounded codecs + VPK reader

apps/demo-worker ──> demo + domain
apps/web ── HTTP/SSE ──> api
```

- `domain` contains serializable records, validation and errors and performs no I/O.
- `storage` owns SQLite migrations, explicit transactions, project snapshots, jobs and library
  records.
- `demo` owns safe discovery, ZIP extraction, hashing, Source 2 parsing, entity replay, insights,
  heatmaps, highlight classification and narrowly bounded compatibility-copy planning.
- `cosmetics` inspects and rewrites a fixed set of observed Source 2 entity fields to a new demo.
- `source-assets` provides bounded read-only VPK v2 access, overview parsing and compiled radar
  texture decoding, plus localized cosmetic catalog and inventory-image extraction.
- `media` owns ffprobe inspection, waveform generation and deterministic FFmpeg argument/filter
  plans. It never invokes a shell.
- `integrations` isolates OBS WebSocket v5, Steam HTTP, GSI payloads, launch commands and
  OpenAI-compatible HTTP.
- `platform-windows` owns process discovery, foreground verification, typed Unicode input, direct
  process launch and integrity-checked backup/recovery primitives.
- `recording` coordinates acknowledged game playback, evidence-backed director plans, calibrated
  overlays, job-scoped capture settings, OBS capture, cleanup and atomic publication.
- `api` owns request validation, status mapping, loopback/origin enforcement, bounded uploads and
  streaming, active-task tracking and mutation events.
- `runtime` composes concrete analysis, review, player, cosmetics, export, recording, integration,
  media, cache and source-asset ports.
- `server` and `desktop` own application-data resolution, composition and process lifecycle.
- `web` keeps wire DTOs at the API boundary and uses feature-local state for analysis, queue,
  editor and settings workflows.

Platform commands and process spawning do not appear in route handlers or domain records.

## Runtime data

The standalone host resolves a standard per-user directory unless `--data-dir` is supplied; the
desktop host uses Tauri's application-data resolver. The resulting tree is created lazily:

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
  obs-backups/
  recovery/
  cleanup/editor-projects/
  .output-trash/
```

Configuration, projects, jobs, cosmetic plans and library metadata live in SQLite. External source demos and media
files are read-only; browser uploads and imported portable-package assets become managed files.
Temporary files are created in the target filesystem and become visible only after validation and
an atomic or no-clobber publication step. Replay and avatar caches have entry and byte ceilings;
proxy ownership and cleanup are persisted explicitly.

## Request and task flow

The API validates identity and wire shape before calling a narrow port. A concrete runtime port
loads persistent state, performs filesystem/network/process work through a bounded adapter and
persists the resulting domain record. The React client never chooses an arbitrary executable,
remote avatar origin, OBS setting field or LLM evidence document at request time.

Recording, export and Steam-download records are persisted and polled over HTTP. Cancellation is
cooperative and job-scoped. A normal lifecycle is:

```text
queued -> preparing -> running -> completed
                         |
                         +-> cancelling -> cancelled
                         +-> failed
```

Exports, recordings and Steam downloads left active by a stopped host are reconciled to a terminal
state on the next startup; capture and downloads are not resumed from an ambiguous point. Route
mutations emit SSE change events. Background render/capture progress is read from persistent job
records. Demo parsing uses a bounded worker process when available and otherwise the same bounded
parser in-process.

Local playback and recording share an atomic runtime-session state. Playback moves from a unique
launching token to an active token and then an exclusive stopping token without a guessed timeout;
recording owns the state for the persisted job lifetime. A verified stop is bound to that token and
exact child-process handle, and releases only the matching session after that process has
stopped. A stale completion therefore cannot stop or clear a newer playback.

Editor saves use an optimistic revision in an immediate SQLite transaction. The current document
and its bounded snapshot are written together. Proxy and package workflows keep generating/staging
state separate from ready state so a crash cannot make a partial media file look complete.

## Safety boundaries

- Hosts bind only to loopback and reject non-loopback `Host` values and untrusted `Origin` values,
  including simple requests that do not trigger a browser preflight.
- Multipart and archive names are reduced to safe relative components. Request, file, entry,
  expansion, compression-ratio and total sizes are bounded, and partial batches are rolled back.
- Secrets are accepted on write, redacted from responses and debug output, and preserved when a
  client sends a recognized empty placeholder. Managed backups never include integration secrets.
- Steam profile/avatar and remote AI clients use constrained URL policies, redirects are disabled,
  time and response sizes are bounded, and response structure/MIME is validated before use.
- Managed GSI, OBS tuning, output deletion and recording prerequisites use explicit confirmation,
  fingerprints or integrity-checked recovery artifacts as appropriate.
- Executables receive structured program/argument vectors. User values are not interpolated into
  a command shell or FFmpeg command string.
- External files are never deleted by a record-only action. Physical delete and rename are limited
  to canonical managed roots, reject symbolic links, and use staging/rollback where database and
  filesystem state must change together.
- Security-sensitive cache publication and editor quarantine/recovery keep operations relative to
  already-opened directory capabilities. Validation is not followed by a fresh ambient path lookup
  that could be redirected through a concurrently replaced junction or symbolic link.
- Multi-row writes, snapshot restore, conditional revision changes and schema migrations use
  explicit transactions; SQLite schema versions are monotonic.
- Previous-data import is a pre-open startup operation. SQLite backup provides a consistent source
  snapshot, managed file trees are copied through bounded staging with no-clobber publication, and
  stored paths below the previous root are remapped transactionally before the new database is
  published. Existing target databases are an explicit stop condition.
