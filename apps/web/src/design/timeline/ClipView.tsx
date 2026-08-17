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
 * ## The trim handles (phase 3f-2)
 *
 * Two 6px strips at the edges, and they are `<span>`s inside the button rather
 * than buttons of their own. A button inside a button is invalid HTML and the
 * browser un-nests it; a focusable handle would also put two extra tab stops
 * in front of every clip, which for a hundred-clip sequence is two hundred
 * stops between the user and the next lane.
 *
 * The keyboard reaches trimming the way it reaches everything else — through
 * the clip itself, with a modifier (see `TimelinePrototype`'s key handler) —
 * so nothing here is mouse-only. That is the same arrangement the razor has:
 * a pointer gesture on the clip body, and `S` on the keyboard.
 *
 * While a trim drags, the clip draws `previewStart` / `previewDuration`
 * instead of its own numbers. The document has not changed yet — the whole
 * point of the preview — so the edge follows the cursor and stops where the
 * trim will stop, which is how the user learns the source ran out before they
 * let go.
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
import type { Clip, TrackKind } from './timelineModel';
import { formatFrameTimecode, formatTimecode } from './timeScale';
import type { TrimEdge } from './trim';

import './timeline.css';
import { cn } from '../cn';

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
  /** Where a live trim would put the clip's left edge, seconds. */
  previewStart?: number;
  /** …and how long it would be. Both or neither. */
  previewDuration?: number;
  /** Which edge a live trim has hold of, for the handle's active state. */
  trimmingEdge?: TrimEdge | null;
  onPointerDown?: (event: ReactPointerEvent<HTMLButtonElement>) => void;
  /** Absent means the clip cannot be trimmed and no handles are drawn. */
  onTrimPointerDown?: (edge: TrimEdge, event: ReactPointerEvent<HTMLSpanElement>) => void;
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
  previewStart,
  previewDuration,
  trimmingEdge = null,
  onPointerDown,
  onTrimPointerDown,
  onKeyDown,
  onFocus,
  ref,
  className,
}: ClipViewProps) {
  const start = previewStart ?? clip.start;
  const duration = previewDuration ?? clip.duration;
  const from = formatTimecode(start);
  const to = formatTimecode(start + duration);
  const sourceIn = clip.sourceIn + (start - clip.start) * clip.speed;

  return (
    <button
      ref={ref}
      type="button"
      className={cn('tl-clip', className)}
      data-clip={clip.id}
      data-kind={kind}
      data-selected={String(selected)}
      data-linked={String(linked)}
      data-blocked={String(blocked)}
      data-dragging={String(dragging)}
      data-trimming={trimmingEdge ?? 'false'}
      data-start={start}
      data-duration={duration}
      data-source-in={sourceIn}
      data-speed={clip.speed}
      aria-pressed={selected}
      aria-label={t`${clip.label}，${from} 至 ${to}`}
      style={timelineStyle({
        '--tl-t0': start,
        '--tl-dur': duration,
        '--tl-inset': CLIP_INSET_PX[kind],
        '--tl-dx': dragOffsetPx,
      })}
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
      onFocus={onFocus}
    >
      {onTrimPointerDown === undefined ? null : (
        <span
          className="tl-clip-handle"
          data-edge="in"
          data-testid={`trim-in-${clip.id}`}
          // Not focusable and not a button — see the module comment. The label
          // is still announced, because a pointer user with a screen reader
          // exists and 「不隐藏」 applies to the handles too.
          aria-hidden="true"
          onPointerDown={(event) => {
            // Without this the clip's own pointerdown starts a move as well,
            // and the gesture would be a trim and a drag at once.
            event.stopPropagation();
            onTrimPointerDown('in', event);
          }}
        />
      )}
      <span className="tl-clip-label">{clip.label}</span>
      <span className="tl-clip-meta">
        {showSourceWindow
          ? `${formatFrameTimecode(sourceIn)} / ${formatFrameTimecode(sourceIn + duration * clip.speed)}`
          : `${from}–${to}`}
      </span>
      {clip.speed === 1 ? null : (
        <span className="tl-clip-speed" data-testid={`speed-${clip.id}`}>
          {t`${Math.round(clip.speed * 100)}%`}
        </span>
      )}
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
      {onTrimPointerDown === undefined ? null : (
        <span
          className="tl-clip-handle"
          data-edge="out"
          data-testid={`trim-out-${clip.id}`}
          aria-hidden="true"
          onPointerDown={(event) => {
            event.stopPropagation();
            onTrimPointerDown('out', event);
          }}
        />
      )}
    </button>
  );
}
