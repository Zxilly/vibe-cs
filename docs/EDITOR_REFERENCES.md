# Editor reference audit

The reference repositories were shallow-cloned under `E:\Temp` for local architecture and interaction review. They are not vendored into Vibe CS.

| Reference | Local checkout | License decision | Use in Vibe CS |
| --- | --- | --- | --- |
| [FlexLayout React](https://github.com/caplin/FlexLayout) | `E:\Temp\vibe-cs-dock-libraries\flexlayout` | MIT | Direct dependency for dock, tab, split, maximize, and workspace serialization |
| [Dockview](https://dockview.dev/docs/overview/introduction/) | `E:\Temp\vibe-cs-dock-libraries\dockview` | MIT | Evaluated for docking; not used because FlexLayout's JSON row/tab tree directly matches the required full-height side docks and nested editing column |
| React Timeline Editor | `E:\Temp\react-timeline-editor` | MIT | Timeline interaction reference only; no runtime dependency |
| wavesurfer.js | `E:\Temp\wavesurfer.js` | BSD-3-Clause | Waveform interaction reference only; no runtime dependency |
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
- FlexLayout owns only personal workspace geometry. Its saved JSON may move, tab, maximize, or resize the Project, Program, Tactical, Timeline, and Agent panels; it never contains Project Head or Timeline content.
- Popout is disabled because a Tauri WebView cannot preserve the same media, transport, and Edit Lease authorities in a detached browser window. Docking, tab merging, splitting, resizing, and maximizing remain enabled.
- `domain/editing/ProjectTimeline` remains the only production Timeline interaction module. SQLite remains the project source of truth, and Rust/FFmpeg remains the only final rendering pipeline.
- Portable editor packages use the `.vcep` extension and the `vibe-cs-editor` format identifier.
