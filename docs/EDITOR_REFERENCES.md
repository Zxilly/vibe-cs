# Editor reference audit

The reference repositories were shallow-cloned under `E:\Temp` for local architecture and interaction review. They are not vendored into Vibe CS.

| Reference | Local checkout | License decision | Use in Vibe CS |
| --- | --- | --- | --- |
| [FlexLayout React](https://github.com/caplin/FlexLayout) | `E:\Temp\vibe-cs-dock-libraries\flexlayout` | MIT | Direct dependency for dock, tab, split, maximize, and workspace serialization |
| [Dockview](https://dockview.dev/docs/overview/introduction/) | `E:\Temp\vibe-cs-dock-libraries\dockview` | MIT | Evaluated for docking; not used because FlexLayout's JSON row/tab tree directly matches the required full-height side docks and nested editing column |
| React Timeline Editor | `E:\Temp\react-timeline-editor` | MIT | Timeline interaction reference only; no runtime dependency |
| [Kdenlive](https://invent.kde.org/multimedia/kdenlive) | `E:\Temp\vibe-cs-editor-refs-20260831\kdenlive` | GPL-3.0-or-later | Timeline navigation and direct-manipulation reference only; no copied code |
| wavesurfer.js | `E:\Temp\wavesurfer.js` | BSD-3-Clause | Waveform interaction reference only; no runtime dependency |
| OpenTimelineIO | `E:\Temp\OpenTimelineIO` | Apache-2.0 | Interchange model reference; no runtime dependency yet |
| WannaCut | `E:\Temp\WannaCut` | GPL-3.0 | Product and interaction reference only; no copied code |
| OpenVideo React Video Editor | `E:\Temp\openvideo-react-video-editor` | custom dual-tier license | Architecture reference only; no copied code |
| Remotion | `E:\Temp\remotion` | custom company/free-tier license | Template-rendering reference only; no runtime dependency |

The former `openvideodev/openvideo` URL returned 404 during the audit, so the current `openvideodev/react-video-editor` repository was reviewed instead.

## Timeline navigation contract

- Adobe Premiere's [sequence navigation](https://helpx.adobe.com/premiere/desktop/edit-projects/change-clip-sequence/navigate-sequences-in-the-timeline.html), [Timeline preferences](https://helpx.adobe.com/premiere/desktop/get-started/preferences-and-settings/timeline-preferences.html), and [navigation controls](https://helpx.adobe.com/premiere/desktop/edit-projects/change-clip-sequence/navigation-controls-in-the-timeline.html) define the product behavior: Windows wheel input scrolls horizontally, Ctrl temporarily scrolls vertically, Alt-wheel zooms around the pointer, Page Up/Down moves one view, and the bottom zoom scroll bar pans from its centre and zooms from either edge without moving the playhead.
- Fit is a real terminal state, including for multi-hour sequences; it may use a scale below the ordinary interactive zoom ladder. Expanding the bottom range to its full width and the `\` shortcut both return to that state.
- Playback uses Premiere's page-scroll behavior: the viewport changes only after the playhead leaves the visible page. Paused navigation minimally reveals a moved playhead. Manually panning the bottom range never moves the playhead or immediately snaps the viewport back.
- Wheel input belongs to the whole Timeline panel, including the ruler and track headers, rather than only the clip viewport. The Windows default is horizontal; `Ctrl` temporarily scrolls tracks vertically. `Page Up` and `Page Down` move one visible page left and right. `+`/`=` and `-` zoom, while the bottom zoom scroll bar pans from its centre, zooms from either edge, and fits the whole sequence when fully expanded.
- Premiere's [default shortcut table](https://helpx.adobe.com/premiere/desktop/get-started/keyboard-shortcuts/default-keyboard-shortcuts.html) is authoritative for implemented Timeline commands: Left/Right moves the playhead one frame, Shift+Left/Right moves five frames, `S` toggles snapping, `Ctrl+K` adds an edit, `Ctrl+Shift+K` adds an edit to all targeted tracks, `Alt+Left/Right` nudges selected clips one frame, `Alt+Shift+Left/Right` nudges five frames, `Ctrl+Alt+Left/Right` slips one frame, and `Alt+,` / `Alt+.` slides one frame. Shift adds the five-frame step to slip and slide. Marker deletion uses `Ctrl+Alt+M`, not bare `Alt+M`.
- Dragging the playhead is frame-aligned. Holding `Shift` while dragging temporarily snaps it to clip edges and sequence markers, matching Premiere's documented playhead interaction; this is separate from the persistent `S` snapping toggle used by edit gestures.
- Kdenlive's `Timeline.qml` confirms two implementation details that also apply here: zoom-on-mouse preserves the content time under the pointer, and the viewport owns one shared `contentX` used by ruler, clips, playhead, drag geometry, and the bottom zoom bar. Vibe CS keeps those rules in `design/timeline/timeScale` and the one `ProjectTimeline` module rather than importing a second timeline runtime.

## Timeline transition contract

- Premiere's [transition handles](https://helpx.adobe.com/premiere/desktop/add-video-effects/apply-video-transitions/video-transitions-using-clip-handles.html) and [duration editing](https://helpx.adobe.com/premiere/desktop/add-video-effects/apply-video-transitions/change-transition-duration-using-the-effect-controls-panel.html) make transitions selectable Timeline objects whose rendered width is their duration. Dragging an inner edge changes that duration visually; double-clicking opens the existing property surface.
- Vibe CS follows that interaction for all four canonical `TimelineClip.transitions` channels. A selected empty edge exposes a small drag target for creating the channel's default transition; an applied edge renders a duration-sized patterned block. Pointer movement previews only, and pointer release produces exactly one Project Patch.
- The previous video corner triangles and separate audio fade-circle UI were deleted. Timeline, Program preview, Inspector, persistence, and FFmpeg export now consume the same typed transition and duration. Adjacent outgoing and incoming edges remain independently editable because the current Editing Document models two explicit single-sided transitions; no unpersisted alignment model is invented in the view.

## Product boundary

- `/studio/editor` is the editing workspace and is entered from Studio, not a top-level product area.
- Desktop editor commands own projects, snapshots, presets, portable packages, and project exports.
- The private media protocol owns reusable asset streams; typed commands own waveforms, proxies,
  relinking, and extraction.
- FlexLayout owns only personal workspace geometry. Its saved JSON may move, tab, maximize, or resize the Project, Program, Tactical, Timeline, and Agent panels; it never contains Project Head or Timeline content.
- Popout is disabled because a Tauri WebView cannot preserve the same media, transport, and Edit Lease authorities in a detached browser window. Docking, tab merging, splitting, resizing, and maximizing remain enabled.
- `domain/editing/ProjectTimeline` remains the only production Timeline interaction module. SQLite remains the project source of truth, and Rust/FFmpeg remains the only final rendering pipeline.
- Portable editor packages use the `.vcep` extension and the `vibe-cs-editor` format identifier.
