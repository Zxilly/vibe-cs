# Dependency and navigation review — 2026-10-22

## Navigation

The sidebar now contains destinations for the current mode only. The mode menu
is the single place to switch between editing and analysis. Shared destinations
retain their DOM identity and order when moving between pages, including the
collapsed sidebar.

Before the change, the analysis player destination moved vertically by 263 px
when entering analysis from editing. Browser checks at 1440 × 900 and
1000 × 700 confirmed stable destination positions after the change. The editor
was also checked with the updated dependencies at both widths, and analysis was
checked in English with the dark theme.

## Dependency updates

All direct JavaScript package requirements were checked against their published
stable registry versions. Rust requirements and the lockfile were refreshed,
including the vendored parser's standalone dependencies. The main changes are:

| Component | Updated version |
| --- | --- |
| Node.js / pnpm | 26.12.1 / 12.15.0 |
| Rust toolchain | 1.99.1 |
| React / TypeScript | 19.3.1 / 7.0.2 |
| Vite / Vitest | 8.3.5 / 5.0.5 |
| Lingui | 6.10.1 |
| FlexLayout | 0.11.1 |
| Tauri JavaScript API / CLI | 2.12.4 |
| Rig agent, core and HTTP client | 0.45.0 |
| ez-ffmpeg / native FFmpeg SDK | 0.19.3 / 8.1.3 |
| HLAE managed runtime | 2.192.8 |
| Source 2 demo backend | 0.5.10 |
| Vendored demoparser source | `45ca85aeac8fb0de9d385124d2c7fe0e7b8ff0c8` |

Vite and Vitest use Lingui's native macro transform. The old Babel transform
dependencies and the FlexLayout sourcemap patch were removed. FlexLayout's
translation callback uses the current API. pnpm's build permissions allow
`esbuild`; release-age exceptions name only the exact Lingui and Zustand
versions reviewed in this update.

The Rust Agent uses Rig's current model, request and stream interfaces. It keeps
the existing tool host, cancellation, inactivity timeout, conversation projection
and edit authority. Its provider tests cover streamed text, tool lifecycle events
and reported token usage.

`ffmpeg-next` remains at 8.1.0: ez-ffmpeg 0.19.3 requires the 8.1 FFmpeg bindings,
and Cargo rejects linking both the 8.1 and 9.0 native libraries. The native SDK is
pinned to a checksum-verified retained monthly FFmpeg 8.1.3 build. This constraint
is documented in the manifest and [dependency provenance](DEPENDENCY_PROVENANCE.md).

The transitive `pest` dependency remains at 2.9.2. Resolving 2.9.4 was checked and
fails because its exact `psm` 0.1.24 requirement conflicts with the current
dependency graph's 0.1.32 requirement. No override was added to force that graph.

## Demo parser

The latest published `demoparser2` Python release remains 0.42.0. The audited
upstream source includes ten later commits, through 2026-10-05; this update does
not claim a new Python package release.

The source update includes 14-bit entity handles, sparse UserCmd reconstruction,
UTF-8 event keys, tick-filtered velocity sampling, and updated protocol and
cosmetic tables. The original upstream file hashes were verified before import.
All existing local patches remain documented, with additional bounds for UserCmd
baseline storage and velocity history. The final vendor manifest verifies 46
files. Details and both source manifests are in
[`vendor/demoparser`](../vendor/demoparser/UPSTREAM.md).

## Native media and recording dependencies

The ez-ffmpeg update exposed a real export regression: an image overlay ended
early because the demuxer's frame rate was being set through the output retiming
interface. The existing acceptance test passed with ez-ffmpeg 0.17.1, failed
with 0.19.3, and passed after setting the image demuxer's `framerate` option.
Both the mixed audio/overlay/fade export and the Chinese font export passed after
the fix. Opt-in acceptance evidence is now preserved even when a test fails.

HLAE 2.192.8 includes the upstream Source 2 hook fix for recording freezes at
round or match end. Its official portable archive was checked against the release
SHA-256 and its detached signature verified against the previously reviewed full
key fingerprint. The application continues to enforce its archive hash, size and
extracted-file integrity. Runtime OpenPGP verification is not added.

## Validation

- Web: 315 test files, 3,349 tests passed and 2 skipped with Vitest 5; strict
  Lingui compilation, dependency layers, TypeScript and the production build passed.
- Rust workspace: 1,383 tests passed, none failed and 43 explicit environment or
  acceptance tests were ignored by the ordinary suite. Strict Clippy across the
  workspace and all targets, and the repository Rust format check passed.
- Vendor: all 46 parser tests passed; the protocol library and generator targets
  compiled; both vendor hash manifests were verified.
- Demo crate: 69 tests passed and 5 explicit real-demo tests were excluded from
  the ordinary suite. Separately, the default parser passed the full verified
  summary oracles for three real Major-final demos, including rounds, players,
  kills, ticks, rosters and economy results.
- Native export: both real encoding acceptance tests passed with the updated SDK.
- HLAE: the separate ignored acceptance test installed the reviewed official
  2.192.8 archive and verified managed discovery and the executable/hook layout.
- Rust-to-TypeScript binding generation and configuration checks passed, with no
  changes to the generated interface files.
- GitHub Actions definitions passed actionlint 1.7.12.
- JavaScript production audit reported zero vulnerabilities. Rust audit reported
  zero vulnerability findings and seven advisory warnings: six unmaintained
  transitive packages and the `glib` iterator unsoundness advisory. These remain
  visible in the audit logs; no advisory ignore list was added.

Using the same current RustSec advisory database, the previous lockfile reported
18 vulnerabilities and 13 warnings. The updated lockfile resolves those 18
vulnerability findings. The remaining `glib` warning still describes a memory
safety issue in the affected upstream iterator; the audit's warning category is
not a claim that this issue is harmless.

The `glib` and `proc-macro-error` warnings come from Tauri's GTK/WebKitGTK chain;
the three zbus/zvariant warnings come from its Linux desktop integration. Cargo
does not select these five packages for the Windows target. `paste` comes from
`texture2ddecoder`, and `smartstring` from the ts-rs TypeScript formatter's SWC
dependencies; these two packages are also selected on Windows. The direct
dependencies introducing them are already at their current stable versions.

Rust and JavaScript audits run as independent CI jobs, so a Rust failure cannot
skip JavaScript auditing. The Rust job uses the checksum-verified official
`cargo-audit` 0.22.2 binary and requires only repository read permission.

Browser checks use the development mock backend. No live CS2 recording session
was performed as part of this update.

## Upstream references

- [demoparser source revision](https://github.com/LaihoE/demoparser/commit/45ca85aeac8fb0de9d385124d2c7fe0e7b8ff0c8)
- [demoparser2 published packages](https://pypi.org/project/demoparser2/)
- [HLAE 2.192.8](https://github.com/advancedfx/advancedfx/releases/tag/v2.192.8)
- [Retained FFmpeg SDK build](https://github.com/BtbN/FFmpeg-Builds/releases/tag/autobuild-2026-09-30-13-08)
- [cargo-audit 0.22.2](https://github.com/rustsec/rustsec/releases/tag/cargo-audit/v0.22.2)
