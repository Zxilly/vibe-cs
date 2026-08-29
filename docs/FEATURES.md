# Current product surface

This document describes executable behavior that is wired through the desktop or web client,
the loopback API, a concrete runtime adapter, and persistent storage where applicable. A control
is not presented as successful when the local evidence or dependency needed to execute it is
missing.

## Demo library and local playback

- Import individual `.dem` files or bounded ZIP bundles from the browser or desktop file picker.
  Imports validate Source 2 magic, regular-file type, size, path safety and SHA-256 before an
  atomic database batch is committed. Duplicate bytes are not stored twice.
- Add watched directories. A resident `notify` watcher debounces file events, reconciles changes
  periodically, survives a temporarily missing root, rejects symbolic-link roots and exposes
  status plus an explicit rescan action.
- Search, filter, sort, annotate, rename, remove and page library records. Missing watched files
  have an explicit state and can return to the library when the same path becomes available.
- Run a non-launching playback preflight that revalidates the complete demo hash, bounded tick,
  spectator identity and timescale, then reports the discovered game executable and fresh GSI
  evidence. A launch repeats the content check and uses a structured argument vector without a
  shell. Playback and recording acquire one atomic local-runtime session. A launch token remains
  exclusive through validation and playback, and is released only after an explicit, verified
  stop (or host restart), never by guessing that a long or paused demo has ended. An explicit stop
  requires confirmation because it closes the exact game process started for that managed playback.
- Synchronize recent matches through configured Steam credentials, persist bounded match and
  download-job records, stream a cancellable replay download, decompress it with byte limits,
  validate the resulting demo and import it through the same content-identity rules.

## Match analysis, replay and player evidence

- Parse teams, player statistics, rounds and timeline events including kills, damage, purchases,
  objectives and grenades. Parsing runs in a bounded worker when available and otherwise through
  the same bounded Rust parser in-process.
- Select up to twelve library demos for one bounded analysis workspace. Two analyses run in
  parallel, per-demo progress remains visible, and switching the active match never substitutes
  preview data for a failed analysis.
- Detect multi-kills, one-taps, wallbangs, no-scopes, knife/taser moments, defuses, roster-backed
  clutch wins and failed clutch attempts. Highlights, rounds and ordered compilations can be
  added to the recording queue.
- Derive evidence-backed match-point, deciding-round, economy-upset, low-health, long-distance,
  moving-kill, self-damage and team-damage labels. Cross-round kill, death and repeated-opponent
  collections remain ordered collections of real intervals rather than one invented continuous clip.
- Derive purchase summaries, evidence-backed spend, utility lifecycle/damage/flash effects,
  economy observations and directional player matchups. Missing event classes remain explicitly
  unavailable instead of being estimated.
- Sample controller/pawn entities for positioned replay frames and preserve grenade and bomb
  lifecycles. Event-only evidence remains visible when a complete lifecycle cannot be paired.
  Spatial views return an explicit unavailable result when no trustworthy world coordinates exist.
- Cache replay payloads in a bounded, hash-keyed store with concurrent generation
  deduplication, integrity repair, status and explicit cleanup.
- Serve replay through the bounded ARPL binary transport for the interactive client. Player/team/event/floor heatmap dimensions and
  trustworthy smoke, fire, projectile and bomb lifecycle evidence survive both transports.
- Read overview metadata and radar resources from loose files or VPK v2. Compiled Source 2 radar
  textures are decoded in Rust with bounded dimensions and buffers; supported raw, LZ4, BC1,
  BC3 and BC7 formats are emitted as browser-safe PNG. Unsupported texture layouts are never
  presented with a false image MIME type.
- Inspect allow-listed cosmetic fields from a stored demo, validate requested edits against the
  observed field types, write a new demo through the Source 2 rewriter and import the new content
  as a separate library record. Source files are never edited in place.
- Build a localized item and paint catalog from the installed game's bounded item schema and VPK
  inventory textures. Compatible finishes have real PNG previews, and per-demo edit plans can be
  created, loaded and removed without widening the four-field rewrite allow-list.
- Generate an optional AI review only after an explicit user action. The client supplies a scope,
  not an arbitrary prompt; the runtime constructs a bounded evidence document and requires every
  returned evidence identifier to belong to that document.
- Build a player directory from persistent analyses, including aliases, aggregate statistics and
  recent matches. When a Steam Web API key is configured, public summaries and avatars are fetched
  through fixed HTTPS endpoints; avatar bytes are MIME-checked and served from a bounded local
  cache rather than exposing a remote image origin to the browser.

## Agent video generation

- Keep the Agent on structured Vibe CS objects only. Video, edit, and beat alignment each publish a
  distinct workflow-positioned confirmation linked to the matching proposal from that turn.
- Render confirmations as conversation cards. Users can inspect risks, preview and execute edits, or
  reject and return that decision to the Agent. Successful edit results are sent back with project,
  revision and inserted-clip identities.
- Offer an explicit Auto switch in the Agent composer. Auto is off by default. When Auto is on,
  highlight-edit and beat-alignment confirmations run the same signed preview/apply transaction
  without pausing and return the structured execution result directly to the tool loop.
- Ask the in-process Rust Agent for a complete highlight video from an analyzed Demo. The Agent
  selects only persisted evidence and returns a typed `video_render` proposal containing concrete
  recording requests and an MP4 output contract.
- Preview revalidates the Demo, highlight IDs, players, ticks and managed HLAE readiness locally.
  Explicit confirmation starts the durable recording job; the Agent surface follows launch, seek,
  capture, stabilization and encode stages and links the published output.
- HLAE is an internal offline capture dependency. It is never presented as the final Agent artifact,
  and the model cannot provide raw console commands, arbitrary paths, or process arguments.

## Recording

- Build deterministic recording plans with validated demos, tick ranges, per-demo tick rates,
  pre/post-roll, playback speed, stable player identities and bounded output names. Any queue edit
  invalidates the previously validated plan.
- Preview an evidence-backed director plan before capture. Camera switches are coalesced into
  bounded segments and victim perspectives are offered only when the analysis identifies the
  corresponding stable player.
- Preflight the verified CS2 executable, managed HLAE archive, exact demo content, observer
  evidence, Media Foundation H.264/AAC candidates and managed output directory before capture.
- Execute a persisted, cancellable queue through the managed HLAE backend. Each segment is bound to
  a stable player identity and spectator slot; the authenticated bridge continuously verifies the
  observer mode and identity instead of treating a console command as proof.
- Attach each verified Take through the canonical Timeline Clip. If seek overshoot makes the real
  file a few frames shorter than the planned source range, preserve Timeline duration by fitting
  source-out and constant speed to the probed media truth; files that still cannot cover the range
  remain visibly stale and require another recording.
- Edit a planned clip's capture camera, tick range and pre/post-roll in the same Timeline Inspector.
  A recorded clip with a Capture Intent can be returned to Planned for a verified re-record without
  deleting the old media file. Recording terminal state refreshes both the Project Head and Project
  Media projection, so partial queues immediately show their recorded prefix and remaining suffix.
- Apply validated camera FOV, viewmodel FOV, flash alpha, HUD/radar and voice policy for the whole
  capture. The isolated process and job-scoped configuration are torn down on success, failure or
  cancellation.
- Model only the playback speed, overlays, effects and transitions that the native capture backend
  implements, so unsupported settings cannot enter a plan or become fabricated output.
- Plan exact Media Foundation 100ns video/audio timestamps and discover registered Windows H.264/AAC
  candidates without presenting candidate enumeration as readiness. End-to-end native MP4 output is
  enabled only after a real Sink Writer session succeeds and the result is read back; publication is
  atomic and records duration, request and tick metadata.

## Montage and timeline editing

- Analyze a managed BGM through in-process libav decoding and bounded local spectral analysis.
  The result exposes a global BPM estimate and confidence, beat grid, onsets, energy curve,
  heuristic sections and explicit limitations. A deterministic beat-alignment action returns an
  explainable advisory clip-timing draft; it never mutates an editor project by itself.
- Search recorded clips, assemble and reorder a montage, trim every source, retain original audio,
  render cut/fade/slide transitions, mix looped background music, and render configurable intro
  and per-clip name cards.
- Apply typed montage themes, player-avatar name cards and an optional outro. Uploaded packaging
  media remains managed, bounded and explicitly selected by the user.
- Select resolution, frame rate and encoder policy, submit a persistent export, observe machine
  progress reported by the in-process scheduler, cancel cooperatively and retry the complete render with `libopenh264`
  when an auto-selected QSV/NVENC/AMF encoder fails.
- Create multi-track editor projects with video, audio, image, text and overlay tracks. Rendering
  supports source trim, transform, opacity, volume, colour adjustment, fades, bounded export ranges,
  keyframed supported properties and validated speed segments. Audio carried by sequential video or
  audio clips is positioned with sample-exact silence before mixing; clip audio therefore follows
  Timeline placement instead of overlapping at zero and padding the remainder of the export silent.
- Create projects from typed templates, duplicate projects or clips with fresh identities, record
  bounded microphone narration, import validated custom fonts, or atomically detach a source audio
  stream into a linked, time-aligned audio clip while muting the source video. Repeated detach is an
  explicit idempotent conflict. Clips can align against evidence-backed kill ticks. Additional
  transitions are exposed only when the FFmpeg render graph implements the corresponding composition.
- Edit with undo/redo, effective snapping, markers, ripple operations, source slip, multi-selection,
  grouping and linked movement. Locked related tracks prevent an operation instead of partially
  applying it. An explicit, bounded project tail can extend beyond the last clip; shortening it
  removes out-of-range markers in the same undoable edit and duration-only changes are persisted.
- Store typed, revision-safe presets and apply one to a clip atomically. Project saves use optimistic
  revisions, a bounded snapshot history and explicit conflict recovery; autosave is debounced and
  guarded against stale project/session completions.
- Relink a source through a canonical desktop path or a validated browser upload. Generate real
  H.264 proxies with persisted generating/ready/failed states, bounded range streaming, retry and
  ownership-aware cleanup.
- Export and import portable project packages with a manifest, fresh IDs, SHA-256 for every asset,
  entry/size/path limits, staging validation and atomic no-overwrite publication.

## Outputs, integrations and settings

- Browse recording and export outputs together, filter availability and job state, rename only
  managed files, reveal a path through the desktop shell, remove records independently of external
  files, delete managed files with rollback staging, perform bounded batch deletion and clean stale
  records or staged trash.
- Inspect detected CS2 and application-managed movie-engine readiness; configure language,
  appearance, recording defaults, Steam and an
  OpenAI-compatible provider. Blank secret placeholders retain an existing saved secret and all
  configuration responses redact secret values.
- Prepare an immutable HLAE release from its fixed official URL after explicit user action; verify
  the archive and every extracted artifact before discovery or launch. Users install only CS2; no
  capture host, scene, password, FFmpeg path or encoder selector is part of the workflow.
- Receive authenticated CS2 GSI events only on the loopback API, reject stale timestamps, and keep
  durable recovery information for every managed configuration change.
- Inspect dependency and storage readiness, clear replay/avatar/proxy caches through ownership-aware
  operations, and expose recovery state without returning credentials.
- Switch the main navigation, guide, primary workflow headings/actions/empty states, editor toolbar,
  montage packaging controls and core settings between typed Simplified Chinese and English
  resources. Locale and theme drafts become active only after the local configuration save succeeds.
- Manually check an administrator-configured public HTTPS update manifest with redirects disabled,
  pinned public DNS results, strict time/size limits and semantic-version validation. A validated
  download page may be opened by the user; update payloads are never downloaded or executed.
- Write daily local logs with a fourteen-file retention window, open service-owned data/log/recording/export directories through the
  desktop shell, and export a redacted diagnostic JSON snapshot. Browser mode reports its boundary
  instead of pretending it opened a local directory.

## Deliberate boundaries

- The service and desktop host are local-first and loopback-only. There is no cloud account,
  collaborative project service or public network API.
- Demo bytes that are corrupt or from an unsupported format are rejected. A narrowly defined
  recovery action may create a separate copy by removing only an incomplete terminal message
  after a complete file-info message has been verified; it never changes the source or invents
  match evidence.
- Positioned replay and heatmaps depend on trustworthy entity or event coordinates. The UI states
  when only non-spatial timeline evidence is available.
- General media probing, waveform decoding, filters, encoding and muxing run in-process through
  `ffmpeg-next`/`ez-ffmpeg` and a bundled LGPL FFmpeg shared build. No media operation launches an
  FFmpeg executable or command shell. The deterministic movie path is Windows-only and targets a
  verified managed HLAE process plus Media Foundation; until its handshake and MP4 readback gates
  pass, the product must report capture as unavailable rather than falling back to an unverified
  external dependency.
- Steam public data and AI review are optional external integrations. Their absence never blocks
  local demo parsing, analysis or editing.
