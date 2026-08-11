# Editor reference audit

The reference repositories were shallow-cloned under `E:\Temp` for local architecture and interaction review. They are not vendored into Vibe CS.

| Reference | Local checkout | License decision | Use in Vibe CS |
| --- | --- | --- | --- |
| React Timeline Editor | `E:\Temp\react-timeline-editor` | MIT | Direct dependency for virtualized timeline interaction |
| wavesurfer.js | `E:\Temp\wavesurfer.js` | BSD-3-Clause | Direct, lazy-loaded dependency for the selected-audio waveform |
| OpenTimelineIO | `E:\Temp\OpenTimelineIO` | Apache-2.0 | Interchange model reference; no runtime dependency yet |
| WannaCut | `E:\Temp\WannaCut` | GPL-3.0 | Product and interaction reference only; no copied code |
| OpenVideo React Video Editor | `E:\Temp\openvideo-react-video-editor` | custom dual-tier license | Architecture reference only; no copied code |
| Remotion | `E:\Temp\remotion` | custom company/free-tier license | Template-rendering reference only; no runtime dependency |

The former `openvideodev/openvideo` URL returned 404 during the audit, so the current `openvideodev/react-video-editor` repository was reviewed instead.

## Product boundary

- `/studio/editor` is the editing workspace and is entered from Studio, not a top-level product area.
- Desktop editor commands own projects, snapshots, presets, portable packages, and project exports.
- The private media protocol owns reusable asset streams; typed commands own waveforms, proxies,
  relinking, and extraction.
- React Timeline Editor and wavesurfer.js only provide interaction and visualization. SQLite remains the project source of truth, and Rust/FFmpeg remains the only final rendering pipeline.
- Portable editor packages use the `.vcep` extension and the `vibe-cs-editor` format identifier.
