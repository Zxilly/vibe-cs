/*
 * Design system, layer 1 of 3 — multi-track timeline prototype (spec §0.5).
 *
 * The assembled prototype: the 「10 多轨编辑器」timeline panel, wired to the pure
 * model through `useTimelineEditor`.
 *
 * Spec §0.5 says this only has to prove the interactions are buildable, not
 * that the pixels are final, so the surrounding chrome of the artboard (素材库,
 * 节目监看, 属性 Inspector) is out of scope; what is here is the toolbar, the
 * track column, the ruler and the lanes.
 *
 * Everything the toolbar needs already exists in `design/`, so nothing is
 * rebuilt: `Seg` for 选择 / 剃刀 / 滑移, `Toggle` for 吸附, `Button` for the
 * actions and the zoom stepper, `Notice` for a refused edit — 「不隐藏、不静默
 * 失败」, which is exactly what an overlap or a wrong-lane drop has to be.
 *
 * The heights come from spec §3.3 rather than from the artboard's `height:30px`
 * buttons: decision 5 lifts every control to a 32px floor, no exceptions, and
 * this toolbar is named in §3.3 as one of the places that changes.
 */

import { t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';

import { Alert } from '../feedback';
import { Button, Seg, Toggle } from '../primitives';
import { ClipView } from './ClipView';
import { TRACK_HEIGHT_PX } from './geometry';
import { MarkerLayer, Playhead } from './Playhead';
import { TimeRuler } from './TimeRuler';
import { TrackHead } from './TrackHead';
import { timelineStyle } from './style';
import { getClip, type EditRefusal, type Timeline } from './timelineModel';
import { formatTimecode } from './timeScale';
import { nudgeStep, useTimelineEditor, type TimelineTool } from './useTimelineEditor';

import './timeline.css';
import { cn } from '../cn';

export interface TimelinePrototypeProps {
  /** The document to edit. The prototype owns it from then on. */
  initial: Timeline;
  /** Seconds per arrow-key nudge. Shift multiplies by ten. */
  nudgeSeconds?: number;
  className?: string;
}

function refusalMessage(reason: EditRefusal): string {
  switch (reason) {
    case 'overlap':
      return t`这里已经有片段了，没有移动`;
    case 'track-kind-mismatch':
      return t`轨道类型不同，视频不能放到音频轨上`;
    case 'track-locked':
      return t`轨道已锁定`;
    case 'out-of-bounds':
      return t`这个位置没有可以操作的片段`;
    case 'no-headroom':
      return t`素材已经到头了，没有可以滑移的余量`;
    case 'too-short':
      return t`再修剪就不足一帧了`;
    case 'speed-out-of-range':
      return t`速度只能在 5% 到 1600% 之间`;
    case 'unknown-clip':
    case 'unknown-track':
      return t`片段不在时间轴上`;
    case 'no-change':
      return t`没有变化`;
  }
}

export function TimelinePrototype({ initial, nudgeSeconds = 0.1, className }: TimelinePrototypeProps) {
  const editor = useTimelineEditor({ initial, nudgeSeconds });
  const { timeline, scale, drag, selectedClipId, linkedClipIds } = editor;

  const selectedClip = selectedClipId === null ? undefined : getClip(timeline, selectedClipId);
  const currentTrackId = drag?.mode === 'move' ? drag.trackId : selectedClip?.trackId;

  const toolOptions: Array<{ value: TimelineTool; label: React.ReactNode }> = [
    { value: 'select', label: <Trans>选择</Trans> },
    { value: 'razor', label: <Trans>剃刀</Trans> },
    { value: 'slip', label: <Trans>滑移</Trans> },
  ];

  // A keydown on a clip implies focus, and focus has already selected it, so
  // every command below reads the selection rather than taking the clip id.
  //
  // Alt is the trim modifier: Alt+← / Alt+→ move the in point, and adding
  // Shift moves the out point instead. That pairing is deliberate — trimming
  // is the one gesture with two targets, and a separate key for each edge
  // would need four bindings where the hand already knows two.
  const handleClipKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    const step = nudgeStep(nudgeSeconds, event.shiftKey && !event.altKey);
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
    // Every branch above is an edit; none of them may also scroll the lane.
    event.preventDefault();
  };

  return (
    <section
      className={cn('tl', className)}
      aria-label={t`多轨时间轴`}
      style={timelineStyle({ '--tl-pps': scale.pixelsPerSecond })}
    >
      {/* ── toolbar ───────────────────────────────────────────────────── */}
      <div className="flex flex-none items-center gap-3 border-b border-divider px-4 py-2">
        <Seg
          name="timeline-tool"
          value={editor.tool}
          options={toolOptions}
          onChange={editor.setTool}
          size="sm"
          aria-label={t`工具`}
        />
        <Button variant="secondary" size="sm" onClick={editor.razorAtPlayhead}>
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
        <span className="font-mono text-xs text-neutral-700" data-testid="zoom-readout">
          {t`1 秒 = ${scale.pixelsPerSecond} px`}
        </span>
        <Button variant="secondary" size="sm" icon aria-label={t`放大`} onClick={() => editor.zoomBy(1)}>
          +
        </Button>
      </div>

      {/* ── status line ───────────────────────────────────────────────── */}
      <div className="flex flex-none items-center gap-3 border-b border-divider px-4 py-1 text-xs text-neutral-700">
        <span data-testid="selection-readout">
          {selectedClip === undefined ? (
            <Trans>未选中片段</Trans>
          ) : (
            <Trans>已选中 {selectedClip.label}</Trans>
          )}
        </span>
        <span data-testid="playhead-readout" className="font-mono">
          {formatTimecode(timeline.playhead)}
        </span>
        {drag?.snap == null ? null : (
          <span data-testid="snap-readout">
            <Trans>已吸附</Trans>
          </span>
        )}
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

      {/* ── tracks ────────────────────────────────────────────────────── */}
      <div className="tl-body">
        <div className="tl-heads">
          <div className="tl-head-gutter" style={timelineStyle({ '--tl-lane-h': 26 }, { height: 26 })} />
          {timeline.tracks.map((track) => (
            <TrackHead key={track.id} track={track} current={track.id === currentTrackId} />
          ))}
        </div>

        <div className="tl-viewport" ref={editor.viewportRef}>
          <div className="tl-canvas" style={timelineStyle({ '--tl-length': editor.lengthSeconds, '--tl-scroll': editor.scrollPx })}>
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
                    const dragging = drag?.clipId === clip.id;
                    // The whole link group follows the pointer, not just the
                    // clip under it — that is what 「音视频可链接」 looks like.
                    const moving = drag !== null && drag.mode === 'move' && linkedClipIds.has(clip.id) ? drag : null;
                    // A trim moves the group too, and by the same delta, so
                    // the partner's preview is derived from its own numbers
                    // rather than copied from the clip under the pointer.
                    const trimming =
                      drag !== null && drag.mode === 'trim' && drag.trim !== null && linkedClipIds.has(clip.id)
                        ? drag
                        : null;
                    const delta = trimming?.trim?.appliedDelta ?? 0;
                    return (
                      <ClipView
                        key={clip.id}
                        clip={clip}
                        kind={track.kind}
                        selected={clip.id === selectedClipId}
                        linked={clip.id !== selectedClipId && linkedClipIds.has(clip.id)}
                        dragging={dragging}
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
                        onTrimPointerDown={(edge, event) => editor.beginTrimDrag(clip.id, edge, event)}
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
    </section>
  );
}
