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

## Commit messages

Use Conventional Commits with a concise scope, for example `feat(library): add recursive demo scan` or `fix(export): cancel owned ffmpeg process`.
