/*
 * pages/editor — the timeline, 「10 多轨编辑器」's lower half.
 *
 * The artboard's toolbar (选择 · 剃刀 · 滑移 · 波纹删除 · 吸附 · 标记 · 撤销 ·
 * 重做), the head column, the ruler, the lanes, and the status line that reads
 * 「选中 1 个片段 · 标记 3 · 缩放 1 秒 = 12 px」.
 *
 * ── what this is not ──────────────────────────────────────────────────────
 *
 * It is **not** `design/timeline`'s `TimelinePrototype` with data plugged in.
 * The prototype owns its own document and its own editor; this panel owns
 * neither — `EditorPage` does, because the Inspector edits the same selection
 * and a save recombines the same timeline. What this file holds is the *view*,
 * and the two differ in three ways that matter:
 *
 *   · **restrictions.** A clip carrying a speed ramp cannot be cut or trimmed
 *     by this editor without corrupting the ramp (`clipRestrictions`). The
 *     prototype has no wire document and therefore no such notion; here a
 *     restricted clip renders without trim handles and the toolbar's razor is
 *     disabled *with the reason attached*.
 *   · **markers are real.** They come from `EditorMarker`, colour and all, and
 *     the 标记 button adds one at the playhead.
 *   · **the empty state.** A project with no clips is an ordinary state — it
 *     is what 「新建工程」 produces — and it says what to do next rather than
 *     drawing five empty lanes.
 */

import { t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { useMemo, type KeyboardEvent as ReactKeyboardEvent } from 'react';

import { Empty } from '../../design/data';
import { Alert } from '../../design/feedback';
import { OverflowMenu, type OverflowMenuItem } from '../../design/layout';
import { Button, Seg, Toggle } from '../../design/primitives';
import {
  ClipView,
  MarkerLayer,
  Playhead,
  TimeRuler,
  TrackHead,
  TRACK_HEIGHT_PX,
  formatTimecode,
  nudgeStep,
  timelineStyle,
  type TimelineTool,
} from '../../design/timeline';
import { clipAllows, clipRestrictions } from './editorDocument';
import { mintUuid } from './editorIds';
import { firstRestrictionMessage, refusalMessage } from './editorMessages';
import type { EditorPanelProps } from './editorContract';

const NUDGE_SECONDS = 0.1;

export function EditorTimelinePanel({ desk, service }: EditorPanelProps) {
  const { editor, document } = desk;
  const { timeline, scale, drag, selectedClipId, linkedClipIds } = editor;

  const currentTrackId =
    drag?.mode === 'move'
      ? drag.trackId
      : timeline.clips.find((clip) => clip.id === selectedClipId)?.trackId;

  /* Which clips this editor may not cut or trim. Computed once per render for
     the whole document rather than per clip inside the lane loop, which would
     walk the shadow map once per clip per frame of a drag. */
  const restricted = useMemo(() => {
    if (document === null) return new Map<string, string | undefined>();
    const map = new Map<string, string | undefined>();
    for (const clip of timeline.clips) {
      const reasons = clipRestrictions(document, clip.id);
      if (reasons.length > 0) map.set(clip.id, firstRestrictionMessage(reasons));
    }
    return map;
  }, [document, timeline.clips]);

  const canRazor = document === null || selectedClipId === null || clipAllows(document, selectedClipId, 'razor');
  const razorReason = selectedClipId === null ? undefined : restricted.get(selectedClipId);

  const toolOptions: Array<{ value: TimelineTool; label: React.ReactNode }> = [
    { value: 'select', label: <Trans>选择</Trans> },
    { value: 'razor', label: <Trans>剃刀</Trans> },
    { value: 'slip', label: <Trans>滑移</Trans> },
  ];

  /**
   * 「新建轨道」 — one item per `TrackKind`.
   *
   * A menu rather than a single button because the four lanes are not
   * interchangeable: an overlay lane and a subtitle lane hold different clips,
   * and a button that always added a video lane would make the other three
   * unreachable. The role word beside the code is the same vocabulary the
   * artboard uses for the lanes it drew.
   *
   * The id is a real uuid from the start, so the adapter has nothing to mint
   * and the lane keeps one identity across the save.
   */
  const laneMenu: OverflowMenuItem[] = [
    { kind: 'video' as const, role: t`叠加`, label: <Trans>视频轨</Trans> },
    { kind: 'audio' as const, role: t`音乐`, label: <Trans>音频轨</Trans> },
    { kind: 'text' as const, role: t`字幕`, label: <Trans>字幕轨</Trans> },
    { kind: 'overlay' as const, role: t`图形`, label: <Trans>叠加轨</Trans> },
  ].map(({ kind, role, label }) => ({
    id: kind,
    label,
    onSelect: () => {
      const id = mintUuid();
      // `name` is the lane code the head column shows, and it is recomputed
      // from the stack on every load (`laneCodes`), so anything written here is
      // a placeholder until the next save round trip.
      editor.addTrack({ id, kind, name: '', role });
    },
  }));

  const handleClipKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    const step = nudgeStep(NUDGE_SECONDS, event.shiftKey && !event.altKey);
    switch (event.key) {
      case 'ArrowLeft':
        if (event.altKey) editor.trimSelection(event.shiftKey ? 'out' : 'in', -step);
        else if (editor.tool === 'slip') editor.slipSelection(-step);
        else editor.nudgeSelection(-step);
        break;
      case 'ArrowRight':
        if (event.altKey) editor.trimSelection(event.shiftKey ? 'out' : 'in', step);
        else if (editor.tool === 'slip') editor.slipSelection(step);
        else editor.nudgeSelection(step);
        break;
      case 'ArrowUp':
        editor.moveSelectionToAdjacentTrack(-1);
        break;
      case 'ArrowDown':
        editor.moveSelectionToAdjacentTrack(1);
        break;
      case 'Delete':
      case 'Backspace':
        if (event.shiftKey) editor.rippleDeleteSelection();
        else editor.deleteSelection();
        break;
      case 's':
      case 'S':
        editor.splitSelectionAtPlayhead();
        break;
      default:
        return;
    }
    event.preventDefault();
  };

  return (
    <section
      className="tl flex min-h-0 flex-1 flex-col"
      aria-label={t`时间轴`}
      style={timelineStyle({ '--tl-pps': scale.pixelsPerSecond })}
    >
      <div className="flex flex-none flex-wrap items-center gap-3 border-b border-divider px-4 py-2">
        <Seg
          name="editor-tool"
          value={editor.tool}
          options={toolOptions}
          onChange={editor.setTool}
          size="sm"
          aria-label={t`工具`}
        />
        <Button
          variant="secondary"
          size="sm"
          disabled={!canRazor || service.blocked}
          disabledReason={razorReason ?? service.buttonProps.disabledReason ?? t`请先选择播放头下可切分的片段`}
          onClick={editor.razorAtPlayhead}
        >
          <Trans>在播放头切开</Trans>
        </Button>
        <Button
          variant="secondary"
          size="sm"
          disabled={selectedClipId === null}
          disabledReason={t`先选中一个片段`}
          onClick={editor.rippleDeleteSelection}
        >
          <Trans>波纹删除</Trans>
        </Button>
        <label className="flex items-center gap-2 text-sm">
          <Trans>吸附</Trans>
          <Toggle checked={editor.snapEnabled} onChange={editor.setSnapEnabled} aria-label={t`吸附`} />
        </label>
        <Button
          variant="secondary"
          size="sm"
          onClick={() =>
            editor.addMarker({
              id: mintUuid(),
              time: timeline.playhead,
              // The artboard's markers are named for the moment they mark
              // (「入场」 / 「残局开始」). There is no way to know that here, so
              // the timecode is the label — a name the user can read off the
              // ruler and rename later, rather than 「标记 1」, which says
              // nothing and collides on the second one.
              label: formatTimecode(timeline.playhead),
            })
          }
        >
          <Trans>标记</Trans>
        </Button>
        <OverflowMenu label={t`新建轨道`} triggerLabel={<Trans>新建轨道</Trans>} items={laneMenu} />
        <Button
          variant="secondary"
          size="sm"
          disabled={!editor.canUndo}
          disabledReason={t`没有可撤销的操作`}
          onClick={editor.undo}
        >
          <Trans>撤销</Trans>
        </Button>
        <Button
          variant="secondary"
          size="sm"
          disabled={!editor.canRedo}
          disabledReason={t`没有可重做的操作`}
          onClick={editor.redo}
        >
          <Trans>重做</Trans>
        </Button>

        <span className="flex-1" />

        <Button variant="secondary" size="sm" icon aria-label={t`缩小`} onClick={() => editor.zoomBy(-1)}>
          −
        </Button>
        <span className="font-mono text-xs text-neutral-700" data-testid="editor-zoom">
          {t`1 秒 = ${scale.pixelsPerSecond} px`}
        </span>
        <Button variant="secondary" size="sm" icon aria-label={t`放大`} onClick={() => editor.zoomBy(1)}>
          +
        </Button>
      </div>

      <div className="flex flex-none items-center gap-3 border-b border-divider px-4 py-1 text-xs text-neutral-700">
        <span data-testid="editor-selection">
          {selectedClipId === null ? <Trans>未选中片段</Trans> : <Trans>已选中 1 个片段</Trans>}
        </span>
        <span>·</span>
        <span>
          <Trans>标记 {timeline.markers.length}</Trans>
        </span>
        <span className="font-mono" data-testid="editor-playhead">
          {formatTimecode(timeline.playhead)}
        </span>
      </div>

      {editor.refusal === null ? null : (
        <Alert
          variant="warning"
          action={{ label: <Trans>知道了</Trans>, onAction: editor.dismissRefusal }}
          onDismiss={editor.dismissRefusal}
        >
          {refusalMessage(editor.refusal)}
        </Alert>
      )}

      {timeline.tracks.length === 0 ? (
        <Empty
          title={t`这个工程还没有内容`}
          description={t`在左侧素材库里选一个素材，按「添加到时间轴」——第一条轨道会随它一起建好。`}
          actions={
            <Button variant="secondary" onClick={desk.importAssets} disabled={desk.importing}>
              <Trans>导入素材</Trans>
            </Button>
          }
        />
      ) : (
        <div className="tl-body min-h-0 flex-1">
          <div className="tl-heads">
            <div className="tl-head-gutter" style={timelineStyle({ '--tl-lane-h': 26 }, { height: 26 })} />
            {timeline.tracks.map((track) => (
              <TrackHead key={track.id} track={track} current={track.id === currentTrackId} />
            ))}
          </div>

          <div className="tl-viewport" ref={editor.viewportRef}>
            <div
              className="tl-canvas"
              style={timelineStyle({ '--tl-length': editor.lengthSeconds, '--tl-scroll': editor.scrollPx })}
            >
              <TimeRuler
                scale={scale}
                lengthSeconds={editor.lengthSeconds}
                playhead={timeline.playhead}
                onPlayheadChange={editor.setPlayhead}
              />

              {timeline.tracks.map((track) => (
                <div
                  key={track.id}
                  className="tl-lane"
                  data-track={track.id}
                  data-kind={track.kind}
                  data-current={String(track.id === currentTrackId)}
                  data-locked={String(track.locked === true)}
                  style={timelineStyle({ '--tl-lane-h': TRACK_HEIGHT_PX[track.kind] })}
                >
                  {editor.mountedClips
                    .filter((clip) => clip.trackId === track.id)
                    .map((clip) => {
                      const moving =
                        drag !== null && drag.mode === 'move' && linkedClipIds.has(clip.id) ? drag : null;
                      const trimming =
                        drag !== null && drag.mode === 'trim' && drag.trim !== null && linkedClipIds.has(clip.id)
                          ? drag
                          : null;
                      const delta = trimming?.trim?.appliedDelta ?? 0;
                      const trimmable = document === null || clipAllows(document, clip.id, 'trim');
                      return (
                        <ClipView
                          key={clip.id}
                          clip={clip}
                          kind={track.kind}
                          selected={clip.id === selectedClipId}
                          linked={clip.id !== selectedClipId && linkedClipIds.has(clip.id)}
                          dragging={drag?.clipId === clip.id}
                          blocked={moving !== null && moving.refusal !== null}
                          dragOffsetPx={moving?.offsetPx ?? 0}
                          showSourceWindow={editor.tool === 'slip' || trimming !== null}
                          trimmingEdge={trimming?.edge ?? null}
                          {...(trimming === null
                            ? {}
                            : trimming.edge === 'in'
                              ? { previewStart: clip.start + delta, previewDuration: clip.duration - delta }
                              : { previewStart: clip.start, previewDuration: clip.duration + delta })}
                          onPointerDown={(event) => editor.beginClipDrag(clip.id, event)}
                          /* No handles at all on a clip that must not be
                             trimmed — a handle that refuses on release is
                             worse than one that was never offered, because
                             the gesture has already been made. The reason is
                             in the Inspector, where the user is looking when
                             they ask why. */
                          {...(trimmable
                            ? {
                                onTrimPointerDown: (edge, event) => editor.beginTrimDrag(clip.id, edge, event),
                              }
                            : {})}
                          onKeyDown={handleClipKeyDown}
                          onFocus={() => editor.select(clip.id)}
                        />
                      );
                    })}
                </div>
              ))}

              <MarkerLayer markers={timeline.markers} />
              <Playhead timeSeconds={timeline.playhead} label={t`播放头 ${formatTimecode(timeline.playhead)}`} />
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
