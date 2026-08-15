/*
 * Domain layer, layer 2 of 3 — media: the playback control bar.
 *
 * Drawn on two artboards, identically apart from the icon set:
 *   「08 录制计划与镜头预览」 ◀ ▶ ▶| with `00:13.1 / 00:42.0`
 *   「10 多轨编辑器」        |◀ ▶ ▶| with `00:00:31:12 / 00:02:04:00`
 *
 * **This component is controlled, and it does not own time.** `currentTime`
 * and `playing` arrive as props; every action is reported upward and nothing
 * is assumed to have happened until the props come back changed. There is no
 * `requestAnimationFrame` and no `setInterval` in this file, and there must
 * never be one: advancing the playhead is the playback engine's job, and a
 * control bar that also ran a clock would be a second source of truth for the
 * same number. The same rule is why `design/timeline`'s playhead is a number
 * on the document rather than a ticking state.
 *
 * Timecode comes from `design/timeline/timeScale.ts` — `formatFrameTimecode`
 * for the frame form, `formatTimecode` for the clock form. Neither is copied.
 * (Artboard 08's third form, `00:13.1`, is expressible by neither; see the
 * module note below.)
 *
 * Keyboard, on the group rather than on any one button, so the shortcuts work
 * wherever focus sits inside the bar:
 *
 *   Space         play / pause
 *   ← →           one frame back / forward (Shift ×10, `nudgeStep`)
 *   Home / End    first / last frame
 *
 * Space needs care: the browser already turns Space on a focused `<button>`
 * into a click, so the group handler ignores it when the event started on a
 * button — otherwise pressing Space on 播放 would toggle twice and land back
 * where it started. Arrow keys are ignored when the event started on an
 * `<input>`, which is the rate `Seg`'s radio group navigating itself.
 */

import { t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { Pause, Play, SkipBack, SkipForward, StepBack, StepForward } from 'lucide-react';
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react';
import { useId } from 'react';

import { Button, Seg, cx } from '../../design/primitives';
import { formatFrameTimecode, formatTimecode, nudgeStep } from '../../design/timeline';

import {
  DEFAULT_FPS,
  DEFAULT_PLAYBACK_RATES,
  clampTime,
  formatRate,
  stepFrames,
} from './transportModel';
import type { TimecodeFormat } from './types';

export interface TransportProps {
  /** Seconds. Owned by the caller — see the module note. */
  readonly currentTime: number;
  /** Seconds. Zero disables every action. */
  readonly durationSeconds: number;
  readonly playing: boolean;
  /** Seconds. Where 跳到入点 goes; defaults to the start of the media. */
  readonly inPoint?: number;
  /** Seconds. Where 跳到出点 goes; defaults to the end of the media. */
  readonly outPoint?: number;
  readonly fps?: number;
  /** `hh:mm:ss:ff` (the editor's monitor) or `mm:ss` (the ruler's form). */
  readonly timecode?: TimecodeFormat;
  /** Omit to hide the rate control; the recording preview has no rate. */
  readonly rate?: number;
  readonly rates?: readonly number[];
  /** Disables every control, e.g. while the preview is being rebuilt. */
  readonly disabled?: boolean;
  /** Why. Reaches assistive technology through `Button`'s `disabledReason`. */
  readonly disabledReason?: string;
  /** Trailing slot: the artboard puts a zoom `Seg` here. */
  readonly children?: ReactNode;
  readonly onTogglePlay?: () => void;
  /** Absolute seek, already clamped to `[0, durationSeconds]`. */
  readonly onSeek?: (seconds: number) => void;
  readonly onRateChange?: (rate: number) => void;
  readonly className?: string;
}

export function Transport({
  currentTime,
  durationSeconds,
  playing,
  inPoint,
  outPoint,
  fps = DEFAULT_FPS,
  timecode = 'frames',
  rate,
  rates = DEFAULT_PLAYBACK_RATES,
  disabled = false,
  disabledReason,
  children,
  onTogglePlay,
  onSeek,
  onRateChange,
  className,
}: TransportProps) {
  const rateName = useId();
  const ready = durationSeconds > 0;
  const inactive = disabled || !ready;
  const reason = disabledReason ?? (ready ? undefined : t`还没有可播放的素材`);

  const at = clampTime(currentTime, durationSeconds);
  const format = timecode === 'clock' ? formatTimecode : (seconds: number) => formatFrameTimecode(seconds, fps);
  const start = clampTime(inPoint ?? 0, durationSeconds);
  const end = clampTime(outPoint ?? durationSeconds, durationSeconds);

  const seek = (seconds: number) => onSeek?.(clampTime(seconds, durationSeconds));
  const step = (frames: number) => seek(stepFrames(at, frames, { fps, durationSeconds }));

  function handleKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (inactive) return;
    const tag = (event.target as HTMLElement | null)?.tagName;

    if (event.key === ' ' || event.key === 'Spacebar') {
      // The browser turns this into a click on a focused button already.
      if (tag === 'BUTTON') return;
      event.preventDefault();
      onTogglePlay?.();
      return;
    }

    // Inside the rate radio group the arrows belong to the group.
    if (tag === 'INPUT') return;

    switch (event.key) {
      case 'ArrowLeft':
        event.preventDefault();
        step(-nudgeStep(1, event.shiftKey));
        return;
      case 'ArrowRight':
        event.preventDefault();
        step(nudgeStep(1, event.shiftKey));
        return;
      case 'Home':
        event.preventDefault();
        seek(0);
        return;
      case 'End':
        event.preventDefault();
        seek(durationSeconds);
        return;
      default:
    }
  }

  return (
    <div
      role="group"
      aria-label={t`播放控制`}
      data-playing={playing ? 'true' : 'false'}
      onKeyDown={handleKeyDown}
      className={cx('flex items-center gap-3', className)}
    >
      <div className="flex items-center gap-2">
        <Button
          variant="secondary"
          icon
          size="sm"
          aria-label={t`跳到入点`}
          disabled={inactive}
          {...(reason === undefined ? {} : { disabledReason: reason })}
          onClick={() => seek(start)}
        >
          <SkipBack className="size-4" aria-hidden="true" />
        </Button>
        <Button
          variant="secondary"
          icon
          size="sm"
          aria-label={t`上一帧`}
          disabled={inactive}
          {...(reason === undefined ? {} : { disabledReason: reason })}
          onClick={() => step(-1)}
        >
          <StepBack className="size-4" aria-hidden="true" />
        </Button>
        <Button
          variant="primary"
          icon
          size="sm"
          aria-label={playing ? t`暂停` : t`播放`}
          aria-pressed={playing}
          disabled={inactive}
          {...(reason === undefined ? {} : { disabledReason: reason })}
          onClick={() => onTogglePlay?.()}
        >
          {playing ? <Pause className="size-4" aria-hidden="true" /> : <Play className="size-4" aria-hidden="true" />}
        </Button>
        <Button
          variant="secondary"
          icon
          size="sm"
          aria-label={t`下一帧`}
          disabled={inactive}
          {...(reason === undefined ? {} : { disabledReason: reason })}
          onClick={() => step(1)}
        >
          <StepForward className="size-4" aria-hidden="true" />
        </Button>
        <Button
          variant="secondary"
          icon
          size="sm"
          aria-label={t`跳到出点`}
          disabled={inactive}
          {...(reason === undefined ? {} : { disabledReason: reason })}
          onClick={() => seek(end)}
        >
          <SkipForward className="size-4" aria-hidden="true" />
        </Button>
      </div>

      {/* The artboard's `00:00:31:12 / 00:02:04:00`. `aria-live` is off on
          purpose: a readout that announced itself sixty times a second would
          make the rest of the page unhearable. */}
      <p className="flex items-baseline gap-1 font-mono text-sm tabular-nums" aria-live="off">
        <span className="sr-only">
          <Trans>当前时间</Trans>
        </span>
        <span data-current-time={at}>{format(at)}</span>
        <span aria-hidden="true" className="text-neutral-600">
          /
        </span>
        <span className="sr-only">
          <Trans>总时长</Trans>
        </span>
        <span className="text-neutral-700" data-duration={durationSeconds}>
          {format(durationSeconds)}
        </span>
      </p>

      {rate === undefined ? null : (
        <Seg
          name={rateName}
          aria-label={t`播放速率`}
          value={String(rate)}
          options={rates.map((value) => ({
            value: String(value),
            label: formatRate(value),
            disabled: inactive,
          }))}
          onChange={(value) => onRateChange?.(Number(value))}
        />
      )}

      {children === undefined ? null : <div className="ml-auto flex items-center gap-2">{children}</div>}
    </div>
  );
}
