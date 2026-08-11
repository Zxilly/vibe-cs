# Vibe CS

Vibe CS is a local-first desktop workspace for competitive match review and video creation. It combines a watched demo library, match and player analysis, evidence-backed 2D replay, highlight planning, OBS-assisted recording, montage assembly, optional AI review, and a multi-track editor.

The backend is implemented as a Rust workspace. The user interface is TypeScript + React and can run in a browser during development or inside the desktop shell.

## Workspace

```text
apps/
  demo-worker/  isolated demo-analysis worker
  desktop/      Tauri 2 desktop host
  server/       standalone HTTP service entry point
  web/          TypeScript + React application
crates/
  api/          HTTP routes and application state
  cosmetics/    bounded cosmetic inspection and demo rewrite library
  demo/         demo discovery, indexing, parsing and analysis
  domain/       shared models and errors
  integrations/ OBS, Steam, game and LLM adapters
  media/        FFmpeg probing, composition and export planning
  platform-windows/ safe Windows process, input and recovery primitives
  recording/    verified CS2 playback and OBS capture orchestration
  runtime/      concrete ports and long-running job orchestration
  source-assets/ bounded VPK, radar and localized cosmetic-catalog access
  storage/      SQLite persistence and migrations
```

## Development

Requirements: Rust 1.88+, Node.js 22+, and pnpm 10+. FFmpeg/ffprobe are required
for media probing, waveform generation, recording post-processing, and exports. Recording
also requires a local CS2 installation and OBS with WebSocket enabled. Local CS2 assets supply
map-overview metadata when available.

```powershell
corepack pnpm install
cargo build -p vibe-cs-demo-worker
```

Start the two development processes in separate terminals:

```powershell
# Terminal 1
cargo run -p vibe-cs-server

# Terminal 2
corepack pnpm dev
```

The web client uses the versioned `/api/v1` contract, proxied to `http://127.0.0.1:47831`
during development. A packaged desktop build talks to that fixed loopback service directly.
`VITE_API_URL` is an optional,
build-time HTTP(S) override.

The analysis worker is discovered beside the server or desktop executable. Set
`VIBE_CS_DEMO_WORKER` only when it is installed elsewhere; development falls back to the
same bounded parser in-process if the worker binary has not been built yet.

To import a previous application-data directory into an uninitialized target, set
`VIBE_CS_PREVIOUS_DATA_DIR` to an absolute path before the first start. The importer takes a
consistent SQLite snapshot, copies managed recordings, exports, uploads, packages, proxies and
caches without overwriting a target, and transactionally remaps stored paths. It refuses to run
after the target database exists. Versioned replay-cache entries are still validated on first use;
incompatible entries are invalidated and rebuilt. Remove the environment variable after a
successful first start so later starts use the imported database normally.

Update checks are opt-in and manual. Configure a public HTTPS manifest URL in Settings. The local
service rejects redirects and non-public endpoints, bounds connection time and response size, and
only returns a validated download page; it never downloads or executes an update.

For desktop development, install the Tauri platform prerequisites, then use the workspace
scripts. The local CLI, web build, embedded loopback service, and desktop configuration are
resolved automatically:

```powershell
corepack pnpm desktop:dev
# or build an installer/bundle
corepack pnpm desktop:build
```

## Quality gates

```powershell
cargo fmt --all --check
cargo check --workspace --all-targets
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
corepack pnpm typecheck
corepack pnpm test
corepack pnpm build
```
