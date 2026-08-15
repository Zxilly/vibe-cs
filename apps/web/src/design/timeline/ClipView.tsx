/*
 * Design system, layer 1 of 3 — multi-track timeline prototype (spec §0.5).
 *
 * One clip. The artboard's:
 *
 *   <div style="position:absolute;left:506px;top:8px;height:46px;width:336px;
 *               border:2px solid var(--color-accent-900);
 *               background:color-mix(in srgb,var(--color-accent) 26%,transparent);
 *               font-size:11px;padding:5px 8px">Aurora_R13_ace.mp4 · 已选中</div>
 *
 * with three changes, all of them deliberate:
 *
 *   · `left` and `width` become `--tl-t0` / `--tl-dur` in *seconds*, and the
 *     stylesheet multiplies by `--tl-pps`. A zoom then rewrites one property on
 *     the container instead of two on every clip, and a drag rewrites only
 *     `--tl-dx` — spec §0.5's 「用 transform 平移，不要每帧改 left/width」.
 *   · it is a `<button>`, not a `<div>`. A clip is the thing you select, nudge,
 *     cut and delete; if it cannot be focused, none of that is reachable from
 *     the keyboard, and §6.1 lists timeline editing among the interaction
 *     contracts that have to be testable.
 *   · 「· 已选中」 is dropped from the visible label and stated in `aria-pressed`
 *     plus an `sr-only` word. The border already says it, in colour and weight.
 *
 * The colour is decided by the *track kind*, not by the clip: 「时间轴颜色只表达
 * 轨道类型」 on the artboard's own caption. (The artboard contradicts itself by
 * drawing V2's name plates in neutral; the caption wins — see README.md.)
 */

import { t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent, Ref } from 'react';

import { CLIP_INSET_PX } from './geometry';
import { timelineStyle } from './style';
import { clipEnd, clipSourceOut, type Clip, type TrackKind } from './timelineModel';
import { formatFrameTimecode, formatTimecode } from './timeScale';

import './timeline.css';

export interface ClipViewProps {
  clip: Clip;
  /** The kind of the lane it currently sits on; decides its colour. */
  kind: TrackKind;
  selected?: boolean;
  /** Its A/V partner is the selected one. */
  linked?: boolean;
  /** The live drag would be refused if dropped here. */
  blocked?: boolean;
  dragging?: boolean;
  /** Live pointer offset, px. Written every pointermove and nothing else. */
  dragOffsetPx?: number;
  /** Show the source in / out points instead of the timeline position. */
  showSourceWindow?: boolean;
  onPointerDown?: (event: ReactPointerEvent<HTMLButtonElement>) => void;
  onKeyDown?: (event: ReactKeyboardEvent<HTMLButtonElement>) => void;
  onFocus?: () => void;
  ref?: Ref<HTMLButtonElement>;
  className?: string;
}

export function ClipView({
  clip,
  kind,
  selected = false,
  linked = false,
  blocked = false,
  dragging = false,
  dragOffsetPx = 0,
  showSourceWindow = false,
  onPointerDown,
  onKeyDown,
  onFocus,
  ref,
  className = '',
}: ClipViewProps) {
  const from = formatTimecode(clip.start);
  const to = formatTimecode(clipEnd(clip));

  return (
    <button
      ref={ref}
      type="button"
      className={`tl-clip ${className}`.trimEnd()}
      data-clip={clip.id}
      data-kind={kind}
      data-selected={String(selected)}
      data-linked={String(linked)}
      data-blocked={String(blocked)}
      data-dragging={String(dragging)}
      data-start={clip.start}
      data-duration={clip.duration}
      data-source-in={clip.sourceIn}
      aria-pressed={selected}
      aria-label={t`${clip.label}，${from} 至 ${to}`}
      style={timelineStyle({
        '--tl-t0': clip.start,
        '--tl-dur': clip.duration,
        '--tl-inset': CLIP_INSET_PX[kind],
        '--tl-dx': dragOffsetPx,
      })}
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
      onFocus={onFocus}
    >
      <span className="tl-clip-label">{clip.label}</span>
      <span className="tl-clip-meta">
        {showSourceWindow
          ? `${formatFrameTimecode(clip.sourceIn)} / ${formatFrameTimecode(clipSourceOut(clip))}`
          : `${from}–${to}`}
      </span>
      {selected ? (
        <span className="sr-only">
          <Trans>已选中</Trans>
        </span>
      ) : null}
      {blocked ? (
        <span className="sr-only">
          <Trans>不能放在这里</Trans>
        </span>
      ) : null}
    </button>
  );
}
