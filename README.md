# Vibe CS

Vibe CS is a local-first desktop workspace for reviewing CS2 matches and creating videos from Demo files. It provides a watched Demo library, match and player analysis, tactical replay, optional AI review, and a multitrack editor. Human and Agent edits use the same Project timeline, which also supplies the clips for recording and export.

The application core is implemented as a Rust workspace. The user interface is TypeScript + React and runs inside the Tauri desktop shell.

## Workspace

```text
apps/
  demo-worker/  isolated demo-analysis worker
  desktop/      Tauri 2 desktop host
  web/          TypeScript + React application
crates/
  application/  in-process use cases, validation and desktop command dispatch
  cosmetics/    bounded cosmetic inspection and demo rewrite library
  demo/         demo discovery, indexing, parsing and analysis
  domain/       shared models and errors
  integrations/ Steam, game and LLM adapters
  media/        FFmpeg probing, composition and export planning
  platform-windows/ safe Windows process, input and recovery primitives
  recording/    verified CS2 playback and capture-backend-neutral orchestration
  runtime/      concrete ports and long-running job orchestration
  source-assets/ bounded VPK, radar and localized cosmetic-catalog access
  storage/      SQLite persistence, explicit transactions and recovery
```

## Development

Development uses Rust 1.99.1, Node.js 26.12.1, pnpm 12.15.0, and PowerShell on Windows.
Install the Tauri platform prerequisites before starting the desktop host.

```powershell
corepack pnpm install
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/bootstrap-ffmpeg-sdk.ps1
pnpm demo-worker:sidecar
```

Start the native desktop development host, or build an installer:

```powershell
corepack pnpm desktop:dev
# or build an installer/bundle
corepack pnpm desktop:build
```

Both desktop commands prepare the FFmpeg SDK and Demo worker before launching Tauri.
The standalone setup commands above are useful when preparing those dependencies separately.

For browser UI development, run `corepack pnpm dev`. It serves the React interface with a
fixture-backed IPC bridge; it does not read local Demo files or run recording jobs. Use the desktop
host to verify native file dialogs, analysis, recording and export.

## Media and desktop runtime

The desktop build downloads and verifies the FFmpeg 8.1.3 LGPL shared SDK, then links it through
`ffmpeg-next` and `ez-ffmpeg`. Probing, waveform decoding, filters, encoding and muxing run inside
the Rust process without an FFmpeg executable.

Recording uses an application-managed, integrity-pinned portable HLAE release to capture
Source 2 frames and game audio, followed by Windows Media Foundation H.264/AAC encoding. HLAE
preparation is an explicit action that downloads the unmodified archive from the reviewed
AdvancedFX GitHub release; the project does not redistribute the binary. CS2 is located from
Steam app 730 manifests across Steam library folders. Local CS2 assets supply map-overview
metadata when available. OBS is not required.

The recording pipeline checks its dependencies and validates captured frames and audio before
publishing an MP4. Registered encoders and component tests do not establish that a complete
CS2/HLAE recording will succeed; verify that path with the installed game and managed runtime.

The React client calls Tauri commands through IPC. Demo import uses native file selection or
native file-drop paths, so match-sized files are read by Rust without crossing WebView memory.
Replay payloads use raw IPC bytes, media uploads use bounded raw-byte commands, and video/audio/image resources are served by the private
`vibe-cs-media` protocol with range support. No product API origin or CORS policy exists. The only
loopback listener is the narrow, token-authenticated CS2 GSI receiver required by the game itself;
it exposes no UI or product commands.

The sidecar script builds the isolated analysis worker, publishes it under Tauri's target-triple
name, and records its SHA-256 digest. Desktop builds bundle that exact worker; the runtime locks
and revalidates it immediately before every launch. The isolated worker defaults to the bounded,
multithreaded vendored demoparser backend; `VIBE_CS_DEMO_BACKEND=cooperative` is its only explicit
diagnostic parser override. Fast-parser errors are returned directly and never retry another parser.
Development runs the cooperative Source 2 parser in-process only when no generated worker manifest
is present. Release builds fail instead of silently dropping the worker isolation boundary. Fast
analysis performs a second selected-tick pass for exact per-round rosters. Replay positions are
extracted on demand from the verified Demo and cached, with separate whole-match and round
requests. Positioned events also supply sparse replay and heatmap data.

Update checks are opt-in and manual. Configure a public HTTPS manifest URL in Settings. The Rust
integration rejects redirects and non-public endpoints, bounds connection time and response size, and
only returns a validated download page; it never downloads or executes an update.

## Quality gates

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/check-rust-format.ps1
cargo check --workspace --all-targets
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
corepack pnpm typecheck
corepack pnpm test
corepack pnpm build
```
