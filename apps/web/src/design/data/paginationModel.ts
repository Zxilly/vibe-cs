/**
 * Design system, layer 1 of 3 — the pure half of `Pagination`.
 *
 * The design reference draws no pager (every table artboard shows a single
 * screenful), so the only authority here is spec §15.4: a large table is either
 * windowed or *stably* paged. Stable means the control never reflows as the
 * page moves — the number of slots is constant, and an elided run collapses
 * into one ellipsis rather than shrinking the row.
 */

export type PaginationSlot = number | 'ellipsis';

export interface PaginationRangeOptions {
  /** Page buttons kept on each side of the current page. */
  readonly siblings?: number | undefined;
}

/** Widest run this function can emit: first, last, current, 2×siblings, 2×ellipsis. */
export function paginationSlotCount(siblings = 1): number {
  return 2 * siblings + 5;
}

/**
 * The page buttons to draw, in order. Always starts at 1 and ends at
 * `pageCount`; the runs that do not fit become a single `'ellipsis'` each.
 *
 * The length is `min(pageCount, paginationSlotCount(siblings))` for every input,
 * which is the stability §15.4 is after: walking 1 → 2 → 3 … never changes how
 * much horizontal room the bar takes.
 */
export function paginationRange(
  page: number,
  pageCount: number,
  { siblings = 1 }: PaginationRangeOptions = {},
): readonly PaginationSlot[] {
  const last = Math.max(1, Math.trunc(pageCount));
  const current = Math.min(Math.max(Math.trunc(page), 1), last);
  const slots = paginationSlotCount(siblings);

  if (last <= slots) return numbers(1, last);

  // Two ellipses only appear when both ends are far away; otherwise the freed
  // slot is spent on a page number so the count stays put.
  const leftGap = current - siblings > 2;
  const rightGap = current + siblings < last - 1;

  if (!leftGap && rightGap) return [...numbers(1, slots - 2), 'ellipsis', last];
  if (leftGap && !rightGap) return [1, 'ellipsis', ...numbers(last - (slots - 3), last)];
  return [1, 'ellipsis', ...numbers(current - siblings, current + siblings), 'ellipsis', last];
}

function numbers(from: number, to: number): number[] {
  return Array.from({ length: to - from + 1 }, (_, index) => from + index);
}
