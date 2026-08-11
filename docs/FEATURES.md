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
- Cache replay payloads in a bounded, versioned, hash-keyed store with concurrent generation
  deduplication, integrity repair, status and explicit cleanup.
- Serve the same replay through a bounded ARPL binary transport for the interactive client while
  retaining the JSON route for compatibility. Player/team/event/floor heatmap dimensions and
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

## Recording

- Build deterministic recording plans with validated demos, tick ranges, per-demo tick rates,
  pre/post-roll, playback speed, stable player identities and bounded output names. Any queue edit
  invalidates the previously validated plan.
- Preview an evidence-backed director plan before capture. Camera switches are coalesced into
  bounded segments and victim perspectives are offered only when the analysis identifies the
  corresponding stable player.
- Preflight the game executable, foreground process, managed recovery journal, fresh command/GSI
  evidence, OBS WebSocket state and managed output directory before capture starts.
- Execute a persisted, cancellable queue through typed Windows input and OBS WebSocket v5. Each
  segment acknowledges playback commands, keeps one verified game process, stops OBS on all exit
  paths and restores timescale, pause, radar visibility and voice volume to explicit saved values.
- Apply validated camera FOV, viewmodel FOV, flash alpha, grenade trajectory, HUD/radar and
  per-player voice capture settings for the whole recording job, then restore the exact configured
  prior values on success, failure or cancellation. Optional first-person HUD resources require an
  explicit license acknowledgement, hash verification and journaled installation/recovery.
- Drive optional OBS kill media and keyboard-state sources from bounded event/input buses. A
  manual latency calibration records samples and applies only the resulting bounded delay; missing
  evidence disables the effect rather than generating input.
- Select a victim perspective only when analysis supplies a stable victim identity. Optional
  keyboard and kill-event overlays are derived from timeline evidence and rendered during a real
  FFmpeg post-process together with fades; missing input evidence does not produce a fabricated
  overlay.
- Probe hardware encoders for post-processing, fall back to LGPL `libopenh264` after an actual hardware
  session failure, publish a verified non-empty output atomically and register the completed clip
  with duration, request and tick metadata.

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
  keyframed supported properties and validated speed segments.
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
- Configure local paths, language, appearance, recording defaults, Steam, OBS and an
  OpenAI-compatible provider. Blank secret placeholders retain an existing saved secret and all
  configuration responses redact secret values.
- Diagnose and start OBS from saved local settings, choose a verified scene, plan output-resolution
  and frame-rate changes, explicitly apply a fingerprinted plan, and restore or delete one of the
  bounded integrity-checked OBS video-setting backups. Changes are refused while recording and a
  failed verification triggers rollback.
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
- On an explicitly configured first startup, import a previous data directory through a consistent
  SQLite snapshot and bounded no-clobber copies of managed recordings, exports, uploads, packages,
  proxies and caches. Stored JSON and scalar paths below the previous root are remapped in one
  database transaction; an initialized target is never overwritten.

## Deliberate boundaries

- The service and desktop host are local-first and loopback-only. There is no cloud account,
  collaborative project service or public network API.
- Demo bytes that are corrupt or from an unsupported format are rejected. A narrowly defined
  compatibility action may create a separate copy by removing only an incomplete terminal message
  after a complete file-info message has been verified; it never changes the source or invents
  match evidence.
- Positioned replay and heatmaps depend on trustworthy entity or event coordinates. The UI states
  when only non-spatial timeline evidence is available.
- Media probing, waveform decoding, filters, encoding and muxing run in-process through
  `ffmpeg-next`/`ez-ffmpeg` and a bundled LGPL FFmpeg shared build. No media operation launches an
  FFmpeg executable or command shell. Verified game capture requires
  Windows, a Steam-discovered or manually selected local game installation, a fresh GSI heartbeat
  and OBS WebSocket.
- Steam public data and AI review are optional external integrations. Their absence never blocks
  local demo parsing, analysis or editing.
