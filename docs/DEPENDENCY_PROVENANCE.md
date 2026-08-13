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

The integrity-pinned demo worker selects this vendored backend by default. Its
adapter uses owned, re-hashed input bytes, bounded parser resources, an event
pass, and a selected-tick roster pass. The in-process engine remains on the
cooperatively cancellable Source 2 backend, and the worker accepts only an explicit
`VIBE_CS_DEMO_BACKEND=cooperative` diagnostic override. Parser errors are returned
by the selected backend without retrying the other implementation. Any future upstream update
must pin and audit a new full commit, repeat the mechanical import, review
licensing and generated inputs, and regenerate both hash manifests.

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
