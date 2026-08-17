/*
 * Domain layer, layer 2 of 3 — media: the thumbnail strip.
 *
 * Evenly spaced frames along a piece of media, for scrubbing and for previewing
 * what is under a stretch of timeline. **It decodes no video.** Thumbnails come
 * in as `{time, src}`; a cell with no `src` draws the artboard's hatched
 * placeholder, which is also the whole strip's appearance before the first
 * thumbnail exists.
 *
 * Cell size, from §3.5 and `design/tokens.data.ts`: the reference draws its
 * media thumbnails at 132×74, and `theme.css` records that `--w-track-head`
 * (132px) covers both the timeline's track head and those thumbnails — 「Same
 * width, one token — otherwise the thumbnail has to reach for a bare value the
 * layer lint would reject」. The height is *not* a token, and 74 / 132 = 0.5606
 * against 16:9's 0.5625, so the cell is `aspect-video` on that width: 74.25px
 * against the artboard's 74, a quarter of a pixel, and the frames then keep the
 * aspect ratio of the footage they show instead of squashing it by 0.3%.
 */

import { t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { Film } from 'lucide-react';
import { useRef, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';

import { EmptyState, Skeleton } from '../../design/data';
import { cn } from '../../design/primitives';
import { formatTimecode } from '../../design/timeline';

import { frameIndexAtTime, placeholderFrames } from './filmFrames';
import type { FilmFrame } from './types';

/** 132px — §3.5 `--w-track-head`, which also carries the 132×74 thumbnail. */
export const FILM_CELL_WIDTH_CLASS = 'w-[var(--w-track-head)]';

/** How many placeholder cells a strip with no thumbnails draws. */
export const DEFAULT_PLACEHOLDER_CELLS = 8;

/** The artboard's hatch, shared with `ClipStrip`'s posterless tile. */
const HATCH_CLASS =
  'bg-[repeating-linear-gradient(135deg,transparent,transparent_7px,color-mix(in_srgb,var(--color-text)_7%,transparent)_7px,color-mix(in_srgb,var(--color-text)_7%,transparent)_8px)]';

export interface FilmStripProps {
  /** Thumbnails, ascending by time. Empty falls back to placeholders. */
  readonly frames?: readonly FilmFrame[];
  /** Seconds. Only needed to place placeholder cells. */
  readonly durationSeconds?: number;
  readonly placeholderCount?: number;
  /** Seconds. Marks the cell the playhead is inside. */
  readonly currentTime?: number;
  readonly loading?: boolean;
  /** Makes the cells buttons. Without it the strip is a static preview. */
  readonly onSeek?: (seconds: number) => void;
  /** Recovery action for the empty state; see the note in `Waveform`. */
  readonly emptyAction?: ReactNode;
  readonly label?: string;
  readonly className?: string;
}

export function FilmStrip({
  frames,
  durationSeconds = 0,
  placeholderCount = DEFAULT_PLACEHOLDER_CELLS,
  currentTime,
  loading = false,
  onSeek,
  emptyAction,
  label,
  className,
}: FilmStripProps) {
  const cells = useRef<(HTMLButtonElement | null)[]>([]);

  if (loading) {
    return (
      <div
        className={cn('flex gap-1 overflow-x-auto overscroll-x-contain', className)}
        aria-busy="true"
        aria-label={t`正在生成缩略图`}
      >
        {Array.from({ length: placeholderCount }, (_, index) => (
          <div
            key={index}
            className={cn(FILM_CELL_WIDTH_CLASS, 'flex aspect-video flex-none flex-col justify-end gap-1 border border-divider p-1')}
          >
            <Skeleton width="100%" />
            <Skeleton width="60%" />
          </div>
        ))}
      </div>
    );
  }

  const strip: readonly FilmFrame[] =
    frames !== undefined && frames.length > 0 ? frames : placeholderFrames(durationSeconds, placeholderCount);

  if (strip.length === 0) {
    return (
      <EmptyState
        icon={<Film className="size-8 text-neutral-500" strokeWidth={1.5} aria-hidden="true" />}
        title={<Trans>还没有缩略图</Trans>}
        description={<Trans>录制完成后会自动抽帧；也可以先在时间轴上按时间预览。</Trans>}
        actions={emptyAction ?? null}
        className={className}
      />
    );
  }

  const times = strip.map((frame) => frame.time);
  const current = currentTime === undefined ? -1 : frameIndexAtTime(times, currentTime);
  const interactive = onSeek !== undefined;

  function handleKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>, index: number) {
    const delta = event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowRight' ? 1 : 0;
    if (delta === 0) return;
    event.preventDefault();
    cells.current[index + delta]?.focus();
  }

  return (
    <ul
      role="list"
      aria-label={label ?? t`缩略图条，共 ${strip.length} 帧`}
      /*
       * Same rule as `ClipStrip`: 132px `flex-none` cells, one every two seconds
       * of footage, so the 「09 快速合辑」 montage (「2 分 04 秒」) is 62 cells and
       * ~8200px. Seven fit at the §8 fold. The strip scrolls; the page does not.
       */
      className={cn('flex items-start gap-1 overflow-x-auto overscroll-x-contain', className)}
    >
      {strip.map((frame, index) => {
        const stamp = formatTimecode(frame.time);
        const isCurrent = index === current;
        const content = (
          <>
            {frame.src === undefined ? (
              <span className={cn('block size-full', HATCH_CLASS)} aria-hidden="true" />
            ) : (
              <img
                src={frame.src}
                alt={frame.alt ?? t`${stamp} 的画面`}
                loading="lazy"
                className="block size-full object-cover"
              />
            )}
            <span className="absolute bottom-0 left-0 bg-bg px-1 font-mono text-2xs" aria-hidden="true">
              {stamp}
            </span>
          </>
        );

        const cellClass = cn(
          FILM_CELL_WIDTH_CLASS,
          'relative block aspect-video overflow-hidden border',
          isCurrent ? 'border-accent outline-2 outline-accent -outline-offset-2' : 'border-divider',
        );

        return (
          <li key={`${frame.time}-${index}`} className="flex-none">
            {interactive ? (
              <button
                type="button"
                ref={(node) => {
                  cells.current[index] = node;
                }}
                aria-label={t`跳到 ${stamp}`}
                aria-current={isCurrent ? 'true' : undefined}
                data-time={frame.time}
                data-current={isCurrent ? 'true' : 'false'}
                onClick={() => onSeek?.(frame.time)}
                onKeyDown={(event) => handleKeyDown(event, index)}
                className={cn(
                  cellClass,
                  'focus-visible:outline-2 focus-visible:outline-accent focus-visible:-outline-offset-2',
                )}
              >
                {content}
              </button>
            ) : (
              <span data-time={frame.time} data-current={isCurrent ? 'true' : 'false'} className={cellClass}>
                {content}
              </span>
            )}
          </li>
        );
      })}
    </ul>
  );
}
