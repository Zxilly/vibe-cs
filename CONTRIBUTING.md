# Contributing

Keep changes focused on one vertical capability and preserve the dependency direction described in `docs/ARCHITECTURE.md`.

## Expectations

- Run `scripts/check.ps1` before opening a change for review.
- Add behavior tests with production changes; long-running integrations must have a deterministic fake adapter.
- Do not invoke a shell to run external tools. Build a program and argument list explicitly.
- Never log access tokens, API keys, OBS passwords, or complete signed URLs.
- Treat demo and media files as untrusted input and enforce input, memory, output, and time limits.
- Keep the single current transport contract synchronized across Rust, desktop, and Web callers.
- UI changes must remain keyboard-operable, readable at 1100×700, and respectful of reduced-motion preferences.

## Desktop UI automation with CDP

Debug builds can expose the Tauri WebView2 target on a loopback Chrome DevTools Protocol port.
Start the desktop host from a fresh process with an explicit port (ports below 1024 are rejected):

```powershell
$env:VIBE_CS_CDP_PORT = '9333'
corepack pnpm desktop:dev
```

After the `vibe-cs-desktop.exe` window opens, attach `agent-browser` to that port and inspect the
available target before interacting:

```powershell
agent-browser --session vibe-cs connect 9333
agent-browser --session vibe-cs tab
agent-browser --session vibe-cs snapshot -i
```

Use the normal snapshot, action, and re-snapshot loop. In PowerShell, quote element references so
`@e24` is passed literally instead of being parsed as splatting syntax:

```powershell
agent-browser --session vibe-cs click '@e24'
agent-browser --session vibe-cs snapshot -i
```

CDP is a development-only path: release builds ignore `VIBE_CS_CDP_PORT`, and the debug listener is
bound to `127.0.0.1`. If the desktop app is already running, close it and relaunch it with the
environment variable set before connecting.

## TypeScript bindings

Rust wire types carrying `#[derive(TS)]` and `#[ts(export)]` are the source of truth for
`apps/web/src/shared/desktop/generated/`. Running `cargo test --workspace` regenerates those files;
never edit generated bindings by hand.

The workspace keeps `ts-rs` Serde compatibility enabled so supported `#[serde(...)]` attributes
continue to shape the generated TypeScript. It also enables `no-serde-warnings`: project-specific
deserializers and strict `deny_unknown_fields` validation do not change the TypeScript shape, and
`ts-rs` otherwise prints compiler-like diagnostics for those unsupported attributes. Do not remove
the Serde validation attributes to silence the generator. Run
`scripts/check-ts-binding-config.ps1` to verify that every binding-producing crate resolves the
shared quiet configuration; the full local check and CI both enforce it.

## Commit messages

Use Conventional Commits with a concise scope, for example `feat(library): add recursive demo scan` or `fix(export): cancel owned ffmpeg process`.
