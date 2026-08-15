/*
 * Domain layer, 2 of 3 — match/, how the round strip packs.
 *
 * ── The problem, stated before any JSX ───────────────────────────────────
 *
 * 「03 比赛工作区」 draws the strip as 24 equal cells with `flex:1` and a 4px
 * gap, at 1920px wide. That works exactly once. An MR12 match is 24 rounds, a
 * single overtime is 30, a long one runs past 50, and the window that has to
 * hold all of them is 1100px (spec §8). At 1100 the content column is:
 *
 *     1100  window
 *     − 56  the collapsed icon rail (--w-nav-collapsed)
 *     − 48  the page gutters the reference draws at 24px each side
 *     = 996
 *
 * and the right-hand Inspector is a drawer at that width (§8 rule 2), so 996 is
 * the honest worst case rather than a pessimistic one. Divided 30 ways with a
 * 4px gap a cell is 29px; divided 58 ways it is 13px, which is narrower than the
 * two digits it has to print. So the strip has to be able to wrap, and the
 * decision of when has to be arithmetic, not a guess in a stylesheet.
 *
 * This module is that arithmetic: no React, no DOM, exhausted in the node
 * project. `RoundTimeline` renders whatever it returns as a CSS grid of
 * `minmax(0, 1fr)` columns, so above 996px the cells simply grow — the plan
 * decides the *row count*, the grid decides the *width*.
 */

/** The reference's `gap:4px` between cells. */
export const ROUND_CELL_GAP_PX = 4;

/**
 * Below this a cell stops being a target. 18px is roughly half a finger-free
 * desktop click target, and it is the point at which the winner rule and the
 * reason glyph stop being separable at a glance; wrapping to a second row is
 * strictly better than a strip nobody can hit.
 */
export const ROUND_CELL_MIN_PX = 18;

/**
 * Below this the round number is dropped and the cell speaks only through its
 * accessible name and its title. Two digits of `--text-2xs` (11px) mono are
 * about 13px, plus a pixel of air on each side.
 */
export const ROUND_CELL_LABEL_MIN_PX = 20;

/**
 * The width the strip plans against when the caller does not measure one: the
 * 996px derived above. Planning against the narrow case means the strip never
 * overflows at the fold, and the `1fr` columns take care of everything wider.
 */
export const ROUND_STRIP_NARROW_WIDTH_PX = 996;

export interface RoundStripPlanInput {
  readonly roundCount: number;
  /** Content width available to the strip. Defaults to the §8 worst case. */
  readonly availableWidthPx?: number | undefined;
  readonly gapPx?: number | undefined;
  readonly minCellPx?: number | undefined;
  readonly labelMinPx?: number | undefined;
}

export interface RoundStripPlan {
  /** How many rows the strip wraps onto. 0 only when there are no rounds. */
  readonly rows: number;
  /** Grid columns. The last row is short when the count does not divide. */
  readonly perRow: number;
  /** What one cell measures at `availableWidthPx`; a float, not a CSS value. */
  readonly cellWidthPx: number;
  /** Whether the round number fits inside the cell. */
  readonly showLabels: boolean;
}

/**
 * Plans the strip.
 *
 * Rows are balanced rather than filled: 58 rounds over 2 rows becomes 29 + 29,
 * not 45 + 13. A short trailing row reads as missing data, and the strip is a
 * picture of the whole match.
 */
export function planRoundStrip({
  roundCount,
  availableWidthPx = ROUND_STRIP_NARROW_WIDTH_PX,
  gapPx = ROUND_CELL_GAP_PX,
  minCellPx = ROUND_CELL_MIN_PX,
  labelMinPx = ROUND_CELL_LABEL_MIN_PX,
}: RoundStripPlanInput): RoundStripPlan {
  const count = Number.isFinite(roundCount) ? Math.max(0, Math.trunc(roundCount)) : 0;
  if (count === 0) return { rows: 0, perRow: 0, cellWidthPx: 0, showLabels: false };

  const width = Number.isFinite(availableWidthPx) ? Math.max(0, availableWidthPx) : 0;
  const gap = Number.isFinite(gapPx) ? Math.max(0, gapPx) : 0;
  const minCell = Number.isFinite(minCellPx) ? Math.max(1, minCellPx) : 1;

  // A row of n cells occupies `n * cell + (n - 1) * gap`; solving for the
  // largest n whose cell is still at least `minCell` gives the ceiling below.
  // At least one cell per row even in a zero-width container, so the strip is
  // never an empty grid with rounds hidden inside it.
  const maxPerRow = Math.max(1, Math.floor((width + gap) / (minCell + gap)));
  const rows = Math.max(1, Math.ceil(count / maxPerRow));
  const perRow = Math.ceil(count / rows);
  const cellWidthPx = (width - gap * (perRow - 1)) / perRow;

  return {
    rows,
    perRow,
    cellWidthPx,
    showLabels: cellWidthPx >= (Number.isFinite(labelMinPx) ? labelMinPx : ROUND_CELL_LABEL_MIN_PX),
  };
}
