# Vibe CS

Vibe CS is a local-first desktop workspace for competitive match review and video creation. It combines a watched demo library, match and player analysis, evidence-backed 2D replay, highlight planning, HLAE movie planning, optional AI review, and a multi-track editor. A managed HLAE and native Windows encoding pipeline is under end-to-end validation and remains fail-closed until its real capture gates pass.

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

Development requirements: Rust 1.88+, Node.js 22+, pnpm 10+, and PowerShell on Windows. The desktop build
bootstraps a checksum-pinned FFmpeg 8.1.2 LGPL shared SDK and links it through `ffmpeg-next` and
`ez-ffmpeg`; probing, waveform decoding, filters, encoding and muxing all run inside the Rust process
without an FFmpeg executable. Movie capture does not use or require OBS: it uses an
application-managed, integrity-pinned portable HLAE release for deterministic Source 2 frame and
game-audio capture, followed by Windows Media Foundation H.264/AAC encoding. HLAE preparation is
an explicit action that downloads the unmodified archive from the reviewed AdvancedFX GitHub release;
the project does not redistribute the HLAE binary. The managed archive, launch compiler, and native
encoder capability/timing contracts are implemented; production capture remains fail-closed until a
real CS2 + managed HLAE MP4 gate passes. CS2 is located from Steam app 730 manifests across Steam
library folders. Local CS2 assets supply map-overview metadata when available. Users install only
CS2; Vibe CS acquires and verifies the reviewed HLAE runtime and uses Windows media APIs itself.

```powershell
corepack pnpm install
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/bootstrap-ffmpeg-sdk.ps1
pnpm demo-worker:sidecar
```

Start the native desktop development host:

```powershell
corepack pnpm desktop:dev
```

The React client calls Tauri commands through IPC. Replay payloads use raw IPC bytes, uploads use
bounded raw-byte commands, and video/audio/image resources are served by the private
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
analysis performs a second selected-tick pass for exact per-round rosters. It keeps
dense entity replay explicitly unavailable; positioned events still provide sparse replay and
heatmaps through the unchanged worker protocol.

Update checks are opt-in and manual. Configure a public HTTPS manifest URL in Settings. The Rust
integration rejects redirects and non-public endpoints, bounds connection time and response size, and
only returns a validated download page; it never downloads or executes an update.

For desktop development, install the Tauri platform prerequisites, then use the workspace
scripts. The web build and desktop configuration are resolved automatically:

```powershell
corepack pnpm desktop:dev
# or build an installer/bundle
corepack pnpm desktop:build
```

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
