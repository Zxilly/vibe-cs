/*
 * Domain layer, layer 2 of 3 — media: reordering a clip strip.
 *
 * No React, no DOM. `ClipStrip` binds pointer and keyboard events; every
 * decision about *where a clip lands* is made here, so it can be exhausted in
 * the node project — the same split `design/timeline` uses for `dragMove`.
 *
 * `dropIndex` takes measured rectangles rather than reading them itself. That
 * is not only layering: jsdom's `getBoundingClientRect` returns zeros for
 * everything, so a drop rule that measured its own DOM could not be tested at
 * all. Given zero-width rectangles this function refuses to move anything,
 * which is also the right behaviour in a real browser before first layout.
 */

/** The horizontal span of one tile, in client coordinates. */
export interface TileSpan {
  readonly left: number;
  readonly right: number;
}

/**
 * `items` with the entry at `from` moved to `to`.
 *
 * Always returns a new array, even when nothing moves: a caller that pushes
 * the result into state should not have to care whether the identity changed,
 * and `ClipStrip` decides whether to call `onReorder` by comparing indices,
 * not references.
 *
 * An out-of-range `from` is a no-op — it means the strip changed underneath a
 * gesture, and dropping the gesture is better than moving an innocent clip.
 * An out-of-range `to` is clamped, because that one is just a pointer past the
 * end of the row.
 */
export function moveItem<T>(items: readonly T[], from: number, to: number): T[] {
  const next = [...items];
  if (!Number.isInteger(from) || from < 0 || from >= next.length) return next;

  const target = clampIndex(to, next.length);
  if (target === from) return next;

  const [moved] = next.splice(from, 1);
  next.splice(target, 0, moved as T);
  return next;
}

/** `index` folded into `[0, length - 1]`; `-1` for an empty list. */
export function clampIndex(index: number, length: number): number {
  if (length <= 0) return -1;
  if (!Number.isFinite(index)) return 0;
  return Math.min(length - 1, Math.max(0, Math.trunc(index)));
}

/**
 * The slot a pointer at `pointerX` is asking for, given where the tiles are.
 *
 * The rule is "the tile you are over wins", not "the nearest gap", because the
 * strip is a row of equal tiles with no visible gaps to aim at — 「拖拽排序」on
 * the 「09 快速合辑」artboard. A pointer in the padding between two tiles takes
 * the nearer of the two; a pointer past either end takes that end.
 *
 * `from` is returned unchanged when nothing can be measured, so a drag in a
 * layout-less environment ends where it started rather than jumping to 0.
 */
export function dropIndex(spans: readonly TileSpan[], pointerX: number, from: number): number {
  if (spans.length === 0 || !Number.isFinite(pointerX)) return from;
  if (!spans.some((span) => span.right > span.left)) return from;

  const first = spans[0] as TileSpan;
  const last = spans[spans.length - 1] as TileSpan;
  if (pointerX <= first.left) return 0;
  if (pointerX >= last.right) return spans.length - 1;

  for (let index = 0; index < spans.length; index += 1) {
    const span = spans[index] as TileSpan;
    if (pointerX >= span.left && pointerX <= span.right) return index;
  }

  // In a gap: take whichever neighbour's edge is closer.
  let best = from;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let index = 0; index < spans.length; index += 1) {
    const span = spans[index] as TileSpan;
    const distance = Math.min(Math.abs(pointerX - span.left), Math.abs(pointerX - span.right));
    if (distance < bestDistance) {
      bestDistance = distance;
      best = index;
    }
  }
  return best;
}

/** Total running time of a strip, seconds. Non-finite durations count as 0. */
export function totalDurationSeconds(clips: readonly { readonly durationSeconds: number }[]): number {
  return clips.reduce((sum, clip) => sum + (Number.isFinite(clip.durationSeconds) ? clip.durationSeconds : 0), 0);
}
