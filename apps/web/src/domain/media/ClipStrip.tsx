/*
 * Domain layer, layer 2 of 3 — media: one strip of clips, in order.
 *
 * The 「09 快速合辑」artboard's 片段顺序 row: 210px tiles, a hatched poster area
 * with the position badge top-left and the running time bottom-right, title
 * and subtitle beneath, and a dashed 「＋ 添加片段」 cell at the end. The panel
 * header states the contract in words — 「拖拽排序」.
 *
 * Ordering is `clipOrder.ts`; this file only binds events to it. Two ways to
 * reorder, both of them real:
 *
 *   pointer    press a tile and move. `pointermove` / `pointerup` are bound to
 *              the *window*, not to the tile, for the reason `design/timeline`
 *              gives in `useTimelineEditor.ts`: the pointer leaves a 210px tile
 *              on any real drag, and `setPointerCapture` is not implemented in
 *              jsdom, so a captured drag could not be tested at all. The cost
 *              is the same one recorded in that README's gap 5 — releasing the
 *              button outside the window strands the gesture.
 *   keyboard   Ctrl/⌘ + ← → moves the focused tile; plain ← → walks the strip.
 *              Not a nicety: 简报 §15.3 requires the whole flow to be reachable
 *              from the keyboard, and it is also what makes reordering
 *              assertable in jsdom, where nothing has a bounding box and the
 *              pointer path therefore refuses to move anything (`dropIndex`).
 *
 * The strip is presentational. It never mutates `clips`; `onReorder` receives
 * the new array and the move that produced it, and the caller decides.
 */

import { t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { GripVertical, Plus } from 'lucide-react';
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';

import { EmptyState, Skeleton } from '../../design/data';
import { cn } from '../../design/primitives';
import { formatTimecode } from '../../design/timeline';

import { dropIndex, moveItem, totalDurationSeconds, type TileSpan } from './clipOrder';
import type { MediaClip } from './types';

/**
 * 210px, the artboard's tile. Not a §3.5 panel width — those are layout
 * columns (`flex:none` with a border) and this is a card in a scrolling row,
 * which is why the width extractor never saw it. Kept as a component constant
 * so the number is written once.
 */
export const CLIP_TILE_WIDTH_CLASS = 'w-[210px]';

/** 112px, the artboard's poster area inside that tile. */
const CLIP_POSTER_CLASS = 'h-[112px]';

/**
 * The artboard's hatched fill for a tile with no poster yet. A `color-mix` on
 * `--color-text` rather than a literal, so it inverts with the theme.
 */
const HATCH_CLASS =
  'bg-[repeating-linear-gradient(135deg,transparent,transparent_7px,color-mix(in_srgb,var(--color-text)_7%,transparent)_7px,color-mix(in_srgb,var(--color-text)_7%,transparent)_8px)]';

export interface ClipReorder {
  readonly from: number;
  readonly to: number;
}

export interface ClipStripProps {
  readonly clips: readonly MediaClip[];
  readonly selectedId?: string | null;
  readonly loading?: boolean;
  /** Renders the trailing dashed 「＋ 添加片段」 cell when given. */
  readonly onAdd?: () => void;
  readonly onSelect?: (id: string) => void;
  /** The reordered array, plus the move that produced it. */
  readonly onReorder?: (clips: readonly MediaClip[], move: ClipReorder) => void;
  /** Recovery action for the empty state; see the note in `Waveform`. */
  readonly emptyAction?: ReactNode;
  readonly label?: string;
  readonly className?: string;
}

interface DragState {
  readonly id: string;
  readonly from: number;
  readonly to: number;
}

export function ClipStrip({
  clips,
  selectedId = null,
  loading = false,
  onAdd,
  onSelect,
  onReorder,
  emptyAction,
  label,
  className,
}: ClipStripProps) {
  const hintId = useId();
  const tiles = useRef(new Map<string, HTMLLIElement>());
  const buttons = useRef(new Map<string, HTMLButtonElement>());
  const [drag, setDrag] = useState<DragState | null>(null);
  /** Set by a keyboard move so focus can follow the tile to its new index. */
  const pendingFocus = useRef<string | null>(null);

  useEffect(() => {
    const id = pendingFocus.current;
    if (id === null) return;
    pendingFocus.current = null;
    buttons.current.get(id)?.focus();
  }, [clips]);

  const spans = useCallback(
    (): TileSpan[] =>
      clips.map((clip) => {
        const rect = tiles.current.get(clip.id)?.getBoundingClientRect();
        return { left: rect?.left ?? 0, right: rect?.right ?? 0 };
      }),
    [clips],
  );

  const commit = useCallback(
    (from: number, to: number) => {
      if (from === to || onReorder === undefined) return;
      onReorder(moveItem(clips, from, to), { from, to });
    },
    [clips, onReorder],
  );

  const dragId = drag?.id ?? null;
  useEffect(() => {
    if (dragId === null) return undefined;

    const handleMove = (event: PointerEvent) => {
      setDrag((current) => {
        if (current === null) return current;
        const to = dropIndex(spans(), event.clientX, current.from);
        return to === current.to ? current : { ...current, to };
      });
    };
    const handleUp = () => {
      setDrag((current) => {
        if (current !== null) commit(current.from, current.to);
        return null;
      });
    };
    const handleCancel = () => setDrag(null);

    window.addEventListener('pointermove', handleMove);
    window.addEventListener('pointerup', handleUp);
    window.addEventListener('pointercancel', handleCancel);
    return () => {
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup', handleUp);
      window.removeEventListener('pointercancel', handleCancel);
    };
  }, [commit, dragId, spans]);

  function handlePointerDown(event: ReactPointerEvent<HTMLButtonElement>, index: number, id: string) {
    // Only the primary button starts a gesture; a secondary press is a menu.
    if (event.button !== 0) return;
    setDrag({ id, from: index, to: index });
  }

  function handleKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>, index: number, id: string) {
    const back = event.key === 'ArrowLeft';
    const forward = event.key === 'ArrowRight';
    if (!back && !forward) return;

    event.preventDefault();
    const delta = back ? -1 : 1;

    if (event.ctrlKey || event.metaKey) {
      const to = Math.min(clips.length - 1, Math.max(0, index + delta));
      if (to === index) return;
      pendingFocus.current = id;
      commit(index, to);
      return;
    }

    const neighbour = clips[index + delta];
    if (neighbour !== undefined) buttons.current.get(neighbour.id)?.focus();
  }

  if (loading) {
    return (
      <div
        className={cn('flex gap-3 overflow-x-auto overscroll-x-contain', className)}
        aria-busy="true"
        aria-label={t`正在读取片段`}
      >
        {[0, 1, 2, 3].map((index) => (
          <div
            key={index}
            className={cn(CLIP_TILE_WIDTH_CLASS, 'flex flex-none flex-col gap-2 border border-divider p-2')}
          >
            <div className={cn(CLIP_POSTER_CLASS, 'flex flex-col justify-end gap-2')}>
              <Skeleton width="100%" />
              <Skeleton width="64%" />
            </div>
            <Skeleton width="82%" />
            <Skeleton width="55%" />
          </div>
        ))}
      </div>
    );
  }

  if (clips.length === 0) {
    return (
      <EmptyState
        title={<Trans>还没有片段</Trans>}
        description={<Trans>从录制结果里挑几段，它们会按这里的顺序拼成视频。</Trans>}
        actions={emptyAction ?? null}
        className={className}
      />
    );
  }

  const count = clips.length;
  const total = formatTimecode(totalDurationSeconds(clips));

  return (
    <div className={className}>
      {/* Said once, not once per tile: an accessible name that repeated the
          shortcut on every card would bury the clip titles under it. */}
      <p id={hintId} className="sr-only">
        <Trans>按住 Ctrl 与左右方向键可以调整片段顺序。</Trans>
      </p>
      <ul
        role="list"
        aria-label={label ?? t`片段顺序，共 ${count} 段，合计 ${total}`}
        aria-describedby={hintId}
        data-dragging={drag === null ? 'false' : 'true'}
        /*
         * The scroll lives on the strip, not on the window. Tiles are 210px and
         * `flex-none`, so at the §8 fold (996px of content, less the panel's
         * 28px of padding) exactly four fit — and a montage of one match's
         * highlights is 18 to 24 of them (`densityFixtures.HIGHLIGHTS_PER_MATCH`).
         * Without this the row was ~5000px wide and the whole page scrolled
         * sideways, which phase 1's AppShell ruled out. `overscroll-x-contain`
         * keeps a trackpad flick from walking out to the page behind it.
         */
        className="flex items-stretch gap-3 overflow-x-auto overscroll-x-contain"
      >
        {clips.map((clip, index) => {
          const position = index + 1;
          const selected = clip.id === selectedId;
          const missing = clip.status === 'missing';
          const dragging = drag?.id === clip.id;
          const target = drag !== null && drag.to === index && drag.id !== clip.id;
          const seconds = clip.durationSeconds.toFixed(1);

          return (
            <li
              key={clip.id}
              ref={(node) => {
                if (node === null) tiles.current.delete(clip.id);
                else tiles.current.set(clip.id, node);
              }}
              className={cn(CLIP_TILE_WIDTH_CLASS, 'flex-none')}
            >
              <button
                type="button"
                ref={(node) => {
                  if (node === null) buttons.current.delete(clip.id);
                  else buttons.current.set(clip.id, node);
                }}
                aria-pressed={selected}
                aria-label={t`第 ${position} 段：${clip.title}，${seconds} 秒`}
                data-clip={clip.id}
                data-index={index}
                data-dragging={dragging ? 'true' : 'false'}
                data-drop-target={target ? 'true' : 'false'}
                onPointerDown={(event) => handlePointerDown(event, index, clip.id)}
                onKeyDown={(event) => handleKeyDown(event, index, clip.id)}
                onClick={() => onSelect?.(clip.id)}
                className={cn(
                  'flex size-full touch-none flex-col border text-left',
                  'focus-visible:outline-2 focus-visible:outline-accent focus-visible:-outline-offset-2',
                  missing ? 'border-fail-border' : selected ? 'border-accent bg-accent-100' : 'border-divider',
                  dragging && 'opacity-60',
                  target && 'outline-2 outline-dashed outline-accent -outline-offset-2',
                )}
              >
                <span className={cn(CLIP_POSTER_CLASS, 'relative block border-b border-divider')}>
                  {clip.posterSrc === undefined ? (
                    <span className={cn('block size-full', HATCH_CLASS)} aria-hidden="true" />
                  ) : (
                    <img src={clip.posterSrc} alt="" loading="lazy" className="block size-full object-cover" />
                  )}
                  <span className="absolute left-2 top-2 bg-bg px-1 font-mono text-2xs" aria-hidden="true">
                    {String(position).padStart(2, '0')}
                  </span>
                  <span className="absolute bottom-2 right-2 bg-bg px-1 font-mono text-2xs" aria-hidden="true">
                    {`${seconds}s`}
                  </span>
                  <GripVertical aria-hidden="true" className="absolute right-2 top-2 size-4 text-neutral-500" />
                </span>
                <span className="flex flex-col gap-0.5 px-3 py-2">
                  <span className="truncate text-sm">{clip.title}</span>
                  {clip.subtitle === undefined ? null : (
                    <span className="truncate text-xs text-neutral-700">{clip.subtitle}</span>
                  )}
                  {missing ? (
                    <span className="text-xs text-fail-text">
                      <Trans>需要重新定位</Trans>
                    </span>
                  ) : null}
                </span>
              </button>
            </li>
          );
        })}

        {onAdd === undefined ? null : (
          <li className={cn(CLIP_TILE_WIDTH_CLASS, 'flex-none')}>
            <button
              type="button"
              onClick={onAdd}
              className={cn(
                'flex size-full flex-col items-center justify-center gap-2 border border-dashed border-neutral-400',
                'text-sm text-neutral-600 hover:border-accent hover:text-accent',
                'focus-visible:outline-2 focus-visible:outline-accent focus-visible:-outline-offset-2',
              )}
            >
              <Plus className="size-4" aria-hidden="true" />
              <Trans>添加片段</Trans>
            </button>
          </li>
        )}
      </ul>
    </div>
  );
}
