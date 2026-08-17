/*
 * Design system, layer 1 of 3 — multi-track timeline prototype (spec §0.5).
 *
 * The ruler strip.
 *
 * The artboard draws it as a repeating gradient behind twelve fixed
 * `width:120px` labels, which is only correct at exactly 12 px/s. Here the
 * ticks come from `rulerTicks`, so the same strip reads correctly at every
 * zoom — and each tick is placed by the same `--tl-pps` multiplication a clip
 * uses, which is what makes 「缩放后片段位置、播放头、标尺刻度同步正确」 true by
 * construction rather than by agreement between two code paths.
 *
 * It is also the playhead's control. §0.5 wants the razor drivable at a chosen
 * instant and the artboard gives the playhead no widget of its own, so the
 * strip is a real `role="slider"`: ← → step, Home / End jump, a pointer scrub
 * sets it directly. That is the only reason this component takes a callback.
 */

import { t } from '@lingui/core/macro';
import type { PointerEvent as ReactPointerEvent, Ref } from 'react';

import { RULER_HEIGHT_PX } from './geometry';
import { timelineStyle } from './style';
import { formatTimecode, rulerTicks, type TimeScale } from './timeScale';

import './timeline.css';
import { cn } from '../cn';

export interface TimeRulerProps {
  scale: TimeScale;
  /** Sequence length in seconds: how far ticks are drawn. */
  lengthSeconds: number;
  playhead: number;
  /** Omitted: the strip is decoration and takes no focus. */
  onPlayheadChange?: (seconds: number) => void;
  /** Seconds per arrow press. Shift multiplies by ten. */
  stepSeconds?: number;
  ref?: Ref<HTMLDivElement>;
  className?: string;
}

export function TimeRuler({
  scale,
  lengthSeconds,
  playhead,
  onPlayheadChange,
  stepSeconds = 1,
  ref,
  className,
}: TimeRulerProps) {
  const ticks = rulerTicks(scale, { toSeconds: lengthSeconds });
  const interactive = onPlayheadChange !== undefined;

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (onPlayheadChange === undefined) return;
    const step = event.shiftKey ? stepSeconds * 10 : stepSeconds;
    switch (event.key) {
      case 'ArrowLeft':
        onPlayheadChange(Math.max(0, playhead - step));
        break;
      case 'ArrowRight':
        onPlayheadChange(playhead + step);
        break;
      case 'Home':
        onPlayheadChange(0);
        break;
      case 'End':
        onPlayheadChange(lengthSeconds);
        break;
      default:
        return;
    }
    event.preventDefault();
  };

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (onPlayheadChange === undefined) return;
    const rect = event.currentTarget.getBoundingClientRect();
    onPlayheadChange(Math.max(0, (event.clientX - rect.left) / scale.pixelsPerSecond));
  };

  return (
    <div
      ref={ref}
      className={cn('tl-ruler', className)}
      style={timelineStyle({ '--tl-ruler-h': RULER_HEIGHT_PX })}
      role={interactive ? 'slider' : undefined}
      tabIndex={interactive ? 0 : undefined}
      aria-label={interactive ? t`播放头` : undefined}
      aria-valuemin={interactive ? 0 : undefined}
      aria-valuemax={interactive ? Math.max(lengthSeconds, playhead) : undefined}
      aria-valuenow={interactive ? playhead : undefined}
      aria-valuetext={interactive ? formatTimecode(playhead) : undefined}
      onKeyDown={interactive ? handleKeyDown : undefined}
      onPointerDown={interactive ? handlePointerDown : undefined}
    >
      {ticks.map((tick) => (
        <div
          key={tick.time}
          className="tl-tick"
          data-major={String(tick.major)}
          data-time={tick.time}
          style={timelineStyle({ '--tl-t': tick.time })}
        >
          {tick.label === undefined ? null : <span className="tl-tick-label">{tick.label}</span>}
        </div>
      ))}
    </div>
  );
}
