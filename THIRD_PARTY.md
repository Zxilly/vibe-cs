# Third-party software

Vibe CS uses open-source Rust and JavaScript packages through Cargo and pnpm. Exact versions and checksums are recorded in `Cargo.lock` and `pnpm-lock.yaml`.

Demo decoding and bounded cosmetic field rewriting use the crates.io `source2-demo` 0.5.8 public parser/writer API under its MIT OR Apache-2.0 license. No modified or separately sourced parser code is vendored. FFmpeg and OBS are optional external programs discovered on the user's machine; they are not bundled by this repository.

The Windows adapter uses Microsoft's `windows` Rust crate under its MIT OR Apache-2.0 license to call documented Win32 APIs without shell command construction.

Compiled radar textures are decoded with `lz4_flex` (MIT), `png` (MIT OR Apache-2.0), and `texture2ddecoder` (MIT OR Apache-2.0). The bounded resource-container and texture-metadata reader is an independent Rust implementation informed by the publicly documented format behavior in ValveResourceFormat (MIT); no implementation code or game assets are vendored.

Loose radar files and managed playback launch paths are compared by operating-system file identity through `same-file` (MIT OR Unlicense), so a path cannot silently resolve to a different file between validation and use.

Managed editor-file quarantine and playback-cache operations use Bytecode Alliance `cap-std` (Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT) so journal, move, restore, publish, validation, and cleanup remain relative to opened directory capabilities on Windows and Unix.

The Editor timeline uses `@xzdarcy/react-timeline-editor` 1.0.0 (MIT). The selected-audio inspector loads `wavesurfer.js` 7.12.11 (BSD-3-Clause) on demand. Neither package is used as a renderer: persisted projects remain Vibe CS domain records and final media is still produced by the bounded Rust/FFmpeg pipeline.

Installation-scoped OBS backup authentication uses RustCrypto `hmac` (MIT OR Apache-2.0) with `sha2`, while operating-system random key material is obtained through `getrandom` (MIT OR Apache-2.0).

Before redistributing a packaged build, generate a dependency license report and include the applicable notices. If FFmpeg is bundled, its build configuration determines the corresponding LGPL or GPL obligations.
