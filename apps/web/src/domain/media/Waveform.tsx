/*
 * Domain layer, layer 2 of 3 — media: the audio waveform.
 *
 * The 「09 快速合辑」artboard's 配乐与节拍 panel, whose waveform is drawn as an
 * SVG `<path>` in a `viewBox="0 0 1000 100" preserveAspectRatio="none"` box
 * with a centre line and a playhead over it. This component reproduces that,
 * and adds the in/out selection the montage page needs.
 *
 * **Nothing here decodes audio.** `peaks` arrives already computed — spec §1.2
 * puts the analysis in the Rust `media` crate, and neither test environment
 * has Web Audio to do it with. See `waveformPeaks.ts` for the downsampling.
 *
 * Why SVG rather than canvas, since either could draw this:
 *
 *   · a canvas is opaque to `renderToStaticMarkup`. The markup test could
 *     assert that a `<canvas>` exists and nothing about what is on it, so the
 *     contract 「每个组件都要能在没有真实后端的情况下被静态渲染」 would be
 *     satisfied in letter only;
 *   · a canvas has to be re-drawn on every resize, which means a
 *     `ResizeObserver` and an effect. `preserveAspectRatio="none"` stretches
 *     the path for free, and the envelope is a shape whose vertical meaning
 *     survives being stretched horizontally;
 *   · the artboard itself is SVG.
 *
 * The playhead and the in/out edges are *not* in the SVG: they are absolutely
 * positioned elements at a percentage offset, exactly as the artboard draws
 * them (`position:absolute;left:24%;top:0;bottom:0;width:2px`). Inside a
 * non-uniformly scaled SVG a 2px rule would be stretched into a wedge whose
 * width depended on the panel size.
 */

import { t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { useMemo, type ReactNode } from 'react';

import { EmptyState, Skeleton } from '../../design/data';
import { Notice, type NoticeAction } from '../../design/feedback';
import { cn } from '../../design/primitives';
import { formatTimecode } from '../../design/timeline';

import { progressPercent } from './transportModel';
import type { PeakData } from './types';
import {
  DEFAULT_PEAK_COLUMNS,
  PEAK_VIEW_HEIGHT,
  PEAK_VIEW_WIDTH,
  downsamplePeaks,
  peakEnvelopePath,
} from './waveformPeaks';

/**
 * 168px, the artboard's `min-height` for the waveform box. Kept as a component
 * constant rather than a global token for the reason `EmptyState` keeps its
 * 172px one: it is a content box, not a bar, and §3.4's inventory is bars.
 */
export const WAVEFORM_MIN_HEIGHT_CLASS = 'min-h-[168px]';

export interface WaveformFailure {
  readonly message: ReactNode;
  readonly detail?: ReactNode;
  /** Required by `Notice`: 「每条都带一个主要恢复动作」. */
  readonly action: NoticeAction;
}

export interface WaveformProps {
  /** Already-computed amplitudes in [-1, 1]. Never decoded here. */
  readonly peaks: PeakData;
  /** Seconds the peaks span. Drives the selection and playhead offsets. */
  readonly durationSeconds: number;
  readonly columns?: number;
  /** Seconds. Draws the playhead when given. */
  readonly currentTime?: number;
  /** Seconds. Everything outside [in, out] is dimmed. */
  readonly inPoint?: number;
  readonly outPoint?: number;
  readonly loading?: boolean;
  /** Rendered instead of the waveform, as a `Notice`. */
  readonly failure?: WaveformFailure;
  /**
   * The recovery action for the empty state. `EmptyState` requires one and
   * this component cannot supply it — "重新分析音频" is a page capability, not
   * a waveform one — so the caller passes it in. Omitted, the empty state
   * renders without an action, which is the one place this directory bends
   * the 「每条都带一个主要恢复动作」 rule and it is recorded here.
   */
  readonly emptyAction?: ReactNode;
  /** Overrides the generated accessible name. */
  readonly label?: string;
  readonly className?: string;
}

export function Waveform({
  peaks,
  durationSeconds,
  columns = DEFAULT_PEAK_COLUMNS,
  currentTime,
  inPoint,
  outPoint,
  loading = false,
  failure,
  emptyAction,
  label,
  className,
}: WaveformProps) {
  const envelope = useMemo(() => peakEnvelopePath(downsamplePeaks(peaks, columns)), [peaks, columns]);

  if (failure !== undefined) {
    return (
      <Notice
        tone="danger"
        action={failure.action}
        {...(failure.detail === undefined ? {} : { detail: failure.detail })}
        {...(className === undefined ? {} : { className })}
      >
        {failure.message}
      </Notice>
    );
  }

  if (loading) {
    return (
      <div
        className={cn(
          WAVEFORM_MIN_HEIGHT_CLASS,
          'flex flex-col justify-center gap-3 border border-divider px-4',
          className,
        )}
        aria-busy="true"
        aria-label={t`正在读取波形`}
        role="img"
      >
        {LOADING_BAR_WIDTHS.map((width) => (
          <Skeleton key={width} width={width} />
        ))}
      </div>
    );
  }

  if (envelope === '') {
    return (
      <EmptyState
        title={<Trans>还没有波形</Trans>}
        description={<Trans>这段素材还没有分析出峰值，或者它本来就没有声音。</Trans>}
        actions={emptyAction ?? null}
        className={className}
      />
    );
  }

  const hasSelection = inPoint !== undefined || outPoint !== undefined;
  const from = inPoint ?? 0;
  const to = outPoint ?? durationSeconds;

  return (
    <div
      role="img"
      aria-label={label ?? describe(durationSeconds, hasSelection ? { from, to } : undefined)}
      data-selected={hasSelection ? 'true' : 'false'}
      className={cn(WAVEFORM_MIN_HEIGHT_CLASS, 'relative overflow-hidden border border-divider', className)}
    >
      <svg
        viewBox={`0 0 ${PEAK_VIEW_WIDTH} ${PEAK_VIEW_HEIGHT}`}
        preserveAspectRatio="none"
        aria-hidden="true"
        className="absolute inset-0 block size-full"
      >
        <path d={envelope} className="fill-[color-mix(in_srgb,var(--color-accent)_50%,transparent)]" />
        {/* The artboard's `M0 50 H1000` zero line. */}
        <path
          d={`M0 ${PEAK_VIEW_HEIGHT / 2} H${PEAK_VIEW_WIDTH}`}
          className="stroke-accent-700"
          strokeWidth={0.6}
          vectorEffect="non-scaling-stroke"
        />
      </svg>

      {hasSelection ? (
        <>
          <div
            data-region="before-in"
            className="absolute inset-y-0 left-0 bg-[color-mix(in_srgb,var(--color-text)_12%,transparent)]"
            style={{ width: progressPercent(from, durationSeconds) }}
          />
          <div
            data-region="after-out"
            className="absolute inset-y-0 right-0 bg-[color-mix(in_srgb,var(--color-text)_12%,transparent)]"
            style={{ width: progressPercent(durationSeconds - to, durationSeconds) }}
          />
          <div
            data-edge="in"
            className="absolute inset-y-0 w-px bg-accent-700"
            style={{ left: progressPercent(from, durationSeconds) }}
          />
          <div
            data-edge="out"
            className="absolute inset-y-0 w-px bg-accent-700"
            style={{ left: progressPercent(to, durationSeconds) }}
          />
        </>
      ) : null}

      {currentTime === undefined ? null : (
        <div
          data-playhead="true"
          className="absolute inset-y-0 w-0.5 bg-text"
          style={{ left: progressPercent(currentTime, durationSeconds) }}
        />
      )}
    </div>
  );
}

/**
 * The loading placeholder: `Skeleton` bars, not a spinner — the same rhythm
 * `design/data/Skeleton` uses for a table, because a waveform that is still
 * being computed has no percentage to show either.
 */
const LOADING_BAR_WIDTHS = ['100%', '86%', '94%', '72%'] as const;

function describe(durationSeconds: number, selection?: { from: number; to: number }): string {
  const total = formatTimecode(durationSeconds);
  if (selection === undefined) return t`音频波形，全长 ${total}`;
  const from = formatTimecode(selection.from);
  const to = formatTimecode(selection.to);
  return t`音频波形，全长 ${total}，已选 ${from} 至 ${to}`;
}
