# Third-party software

Vibe CS uses open-source Rust and JavaScript packages through Cargo and pnpm. Exact versions and checksums are recorded in `Cargo.lock` and `pnpm-lock.yaml`.

Demo decoding and bounded cosmetic field rewriting currently use the crates.io `source2-demo` 0.5.8 public parser/writer API under its MIT OR Apache-2.0 license.

The Rust `parser` 0.1.1 and `csgoproto` 0.1.5 packages from LaihoE/demoparser are source-pinned under `vendor/demoparser` at commit `266a831f08b0264dd722b017a5c05d765206a7ed` under the MIT license. The snapshot consumes protocol/map Rust modules already generated and committed upstream; local packaging patches disable mutable network generation, add a bounded local Rayon pool and hard resource limits, and are covered by the checked-in tree manifest. The integrity-pinned desktop demo worker uses this backend by default, while the in-process recovery parser remains `source2-demo`. The upstream MIT text retains placeholder copyright fields, so redistribution requires release/legal review. See `docs/DEPENDENCY_PROVENANCE.md` and `vendor/demoparser/UPSTREAM.md` for exact provenance, exclusions, hashes, and patch policy.

The Rust media layer uses `ffmpeg-next` 8.1.0 (WTFPL) and `ez-ffmpeg` 0.17.1 (MIT OR Apache-2.0 OR MPL-2.0) to call the FFmpeg libraries in-process. Windows builds use the checksum-pinned BtbN FFmpeg 8.1.2 `win64-lgpl-shared` SDK under LGPL v2.1-or-later; its license is bundled with the application. The selected LGPL build includes NVENC, Intel QSV, AMD AMF, Media Foundation, and OpenH264 encoders but excludes GPL-only libx264/libx265. Steam and CS2 AppID 730 discovery use `steamlocate` 2.1.0 (MIT) and still validate the resolved executable before launch.

Local BGM rhythm analysis uses `rustfft` 6.4.1 (MIT OR Apache-2.0) for spectral-flux onset and tempo features after in-process libav decoding. It does not invoke an audio-analysis executable or download a model.

The Windows adapter uses Microsoft's `windows` Rust crate under its MIT OR Apache-2.0 license to call documented Win32 APIs without shell command construction.

Compiled radar textures are decoded with `lz4_flex` (MIT), `png` (MIT OR Apache-2.0), and `texture2ddecoder` (MIT OR Apache-2.0). The bounded resource-container and texture-metadata reader is an independent Rust implementation informed by the publicly documented format behavior in ValveResourceFormat (MIT); no implementation code or game assets are vendored.

Loose radar files and managed playback launch paths are compared by operating-system file identity through `same-file` (MIT OR Unlicense), so a path cannot silently resolve to a different file between validation and use.

Managed editor-file quarantine and playback-cache operations use Bytecode Alliance `cap-std` (Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT) so journal, move, restore, publish, validation, and cleanup remain relative to opened directory capabilities on Windows and Unix.

The Editor timeline uses `@xzdarcy/react-timeline-editor` 1.0.0 (MIT). The selected-audio inspector loads `wavesurfer.js` 7.12.11 (BSD-3-Clause) on demand. Neither package is used as a renderer: persisted projects remain Vibe CS domain records and final media is still produced by the bounded Rust/FFmpeg pipeline.

Confirmation tokens for bounded application proposals use RustCrypto `hmac` (MIT OR Apache-2.0) with `sha2`. Session and confirmation key material is obtained through `getrandom` (MIT OR Apache-2.0).

Before redistributing a packaged build, generate a dependency license report and include the applicable notices. If FFmpeg is bundled, its build configuration determines the corresponding LGPL or GPL obligations.
