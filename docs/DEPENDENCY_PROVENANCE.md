# Dependency provenance

## Vendored demoparser Rust packages

Vibe CS vendors the Rust parser packages from
[`LaihoE/demoparser`](https://github.com/LaihoE/demoparser) at the immutable Git
commit `266a831f08b0264dd722b017a5c05d765206a7ed`. The imported packages are
`parser` 0.1.1 and `csgoproto` 0.1.5; the corresponding upstream Python release
is `demoparser2` 0.42.0.

The source is stored in `vendor/demoparser`. The import contains the required
Rust sources, generated protocol/map modules, build metadata, documentation, and
the upstream MIT license. It deliberately excludes Git metadata, language
bindings, lockfiles, build products, test demos, update scripts, and the mutable
`GameTracking-CS2` checkout that upstream build scripts would otherwise clone.

For deterministic offline compilation, local packaging patches disable protocol
and map regeneration and add standalone Cargo workspace boundaries. These
patches use only generated Rust files already committed in the audited upstream
revision. Exact scope, redistribution caveats, patch policy, per-file upstream
hashes, and final tree hashes are recorded beside the sources in `UPSTREAM.md`,
`UPSTREAM_FILES.sha256`, and `MANIFEST.sha256`.

Upstream demoparser already parallelizes work with Rayon. Multithreading is not a
vendoring justification and Vibe does not claim it as one. The audited fork is
kept because the product contract also needs deterministic offline compilation,
hard parser resource/decompression limits and checked decode, the
`player_userids` to `spectator_slot` projection used by POV capture, exact-roster
and identity corrections, and the reviewed performance patches. Pointing Cargo
at a bare upstream Git revision would discard those audited inputs and behavior.

The integrity-pinned demo worker selects this vendored backend by default. Its
adapter uses owned, re-hashed input bytes, bounded parser resources, an event
pass, and a selected-tick roster pass. The in-process engine remains on the
cooperatively cancellable Source 2 backend, and the worker accepts only an explicit
`VIBE_CS_DEMO_BACKEND=cooperative` diagnostic override. Parser errors are returned
by the selected backend without retrying the other implementation. Any future
upstream update must pin and audit a new full commit, repeat the mechanical import,
review licensing and generated inputs, reapply only still-required local patches,
and regenerate both hash manifests.

## Application-managed HLAE runtime

HLAE is not vendored into this repository and must not be bundled into a Vibe CS installer without
separate redistribution review. AdvancedFX's top-level source repository is MIT-licensed, but that
license explicitly excludes submodules and the working Source 2 hook includes code from the
separately maintained `advancedfx-prop` repository. Vibe CS therefore prepares HLAE only after an
explicit user action by downloading the unmodified portable archive from the official AdvancedFX
GitHub release.

The reviewed runtime is HLAE `v2.191.1`:

- release page: <https://github.com/advancedfx/advancedfx/releases/tag/v2.191.1>
- archive: `hlae_2_191_1.zip`
- size: `8,957,941` bytes
- SHA-256: `307ba9170b151a7df9b7e5604b335c2d8b8df5bf5cb8d6700ae3fd01069da514`
- reviewed detached-signature fingerprint:
  `7707 F418 7976 6E34 1A24 99D3 60C1 5927 55AE 313F`

The fingerprint records the identity used during release review; the application currently enforces
the fixed HTTPS URL, exact byte length, SHA-256, safe archive shape and complete extracted-file
integrity. It does not claim to perform runtime OpenPGP verification. The immutable archive is kept
beside the extracted version so every discovery or launch can rederive and compare every artifact.
Unknown, missing, linked, reparse-point, same-size modified or extra files invalidate the runtime.

HLAE is used only for offline demo movie work. Every launch profile requires `-insecure`, a fresh CS2
process, an isolated per-job config root and managed output paths. The product never attaches HLAE to
an existing CS2 process and never treats a loader exit code as proof that a hook or capture succeeded.

## Self-hosted Barlow web fonts

The web interface ships Barlow and Barlow Condensed (SIL Open Font License 1.1, designer Jeremy
Tribby, `Copyright 2017 The Barlow Project Authors`) as application assets rather than loading them
from a font service. The Industry design kit this interface is built from opens its stylesheet with
`@import url('https://fonts.googleapis.com/css2?family=Barlow…')`, which cannot work here: the
desktop content security policy in `apps/desktop/src-tauri/tauri.conf.json` pins `font-src` to
`'self' vibe-cs-media: … data:`, so both the stylesheet request and the font request are blocked and
the interface would silently fall back to the system stack. The faces are therefore vendored and
declared by `@font-face` in `apps/web/src/design/fonts.css`.

The source is the Google Fonts repository [`google/fonts`](https://github.com/google/fonts) at the
immutable Git commits `6cdf01867df0813c2390f90dff7dc66c87f14cf7` (`ofl/barlow`) and
`60824dce48f7dd28fe7d65559f2da1f6e04e585b` (`ofl/barlowcondensed`). Only the five faces the design
system actually uses were imported — the kit's `--font-body` needs 400/500/700 and its
`--font-heading` needs 400/600. Upstream publishes static TrueType only, so each file was
re-flavoured to woff2 with `fontTools` 4.63.0. That step rewrites the container and recompresses the
tables; it does not subset, hint, rename or otherwise touch a glyph, so `unicode-range` is absent
from the declarations and every file carries the family's full Latin, Latin-Extended and Vietnamese
coverage. The interface copy is Simplified Chinese, which Barlow does not cover at all and which
resolves through the OS-resident fallbacks named in `--font-body` / `--font-heading`.

The imported files, all reporting `Version 1.408`, live in `apps/web/public/fonts/`:

| file | bytes | SHA-256 | upstream TrueType SHA-256 |
| --- | --- | --- | --- |
| `Barlow-Regular.woff2` | `38,496` | `072e970953fa18d7416581dd3908ad3c2f19311d8aa272c58bd19e9584c90683` | `95aa02c7c43096e0dd44d787ba6216864a67157e402adab59b35572e0c1577ea` |
| `Barlow-Medium.woff2` | `38,540` | `80fd4cafd5716473ab08426c4cd3b10d140cf3dd00c4ce16a7727fd84e933c2f` | `f8906f762cb73dca441da034bc363b2d8e2e68bc10d5c05e58717646c20cc4b4` |
| `Barlow-Bold.woff2` | `39,820` | `67515154290de50a14b3f5892709b9222f469b24114a171c6f0b22d93b482e5b` | `84e6a4d61e7c3e21f3c50ea6a4f7e5303a3467864c038be6ea3759bab8d547f9` |
| `BarlowCondensed-Regular.woff2` | `37,292` | `2d218a57e4c2ab6cc9ee51b3ad6b27612452d8c18aa1df132baf852f98632a5c` | `583cec5da3b84bc4dc7c9c72e2a565c94d34e431518b19d7e250b7830ad5f996` |
| `BarlowCondensed-SemiBold.woff2` | `39,148` | `e7a6a15d02127962a28858fb90ec3ab1e524a7a88070343b8ca1820812d93a85` | `7b619d14bc2327509a9ef32b0890f709626f7ecc9ff61191c2a4314c5499d2d9` |

The upstream TrueType hashes are recorded so the conversion can be reproduced and re-checked without
trusting the woff2 blobs: re-download the two pinned paths, compare the right-hand column, re-flavour,
and compare the left. The OFL text is imported unmodified as `apps/web/public/fonts/OFL.txt`
(`4,377` bytes) so the licence travels with the files it covers, and the packaged application
therefore carries the notice the OFL requires. The licence permits redistribution of the fonts,
bundled or not, provided the copyright notice and licence text accompany them and neither font is
sold on its own; nothing here is renamed, so the reserved-font-name clause is not engaged.

`apps/web/src/design/theme.test.ts` asserts that every declared face resolves to a same-origin
`/fonts/*.woff2` that exists on disk and begins with the `wOF2` signature, and that no design-layer
stylesheet references an external origin. A future font update must pin new upstream commits, repeat
the mechanical import, and regenerate both hash columns.
