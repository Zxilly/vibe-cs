import { describe, expect, it } from 'vitest';

import {
  planRoundStrip,
  ROUND_CELL_GAP_PX,
  ROUND_CELL_LABEL_MIN_PX,
  ROUND_CELL_MIN_PX,
  ROUND_STRIP_NARROW_WIDTH_PX,
} from './roundTimelineLayout';

/** The §8 worst case the module derives: 1100 − 56 icon rail − 48 gutters. */
describe('ROUND_STRIP_NARROW_WIDTH_PX', () => {
  it('is the 1100px window minus the collapsed rail and the page gutters', () => {
    expect(ROUND_STRIP_NARROW_WIDTH_PX).toBe(1100 - 56 - 24 * 2);
  });
});

describe('planRoundStrip at the §8 fold', () => {
  it('keeps an MR12 match on one labelled row', () => {
    const plan = planRoundStrip({ roundCount: 24 });

    expect(plan.rows).toBe(1);
    expect(plan.perRow).toBe(24);
    expect(plan.cellWidthPx).toBeGreaterThanOrEqual(ROUND_CELL_MIN_PX);
    expect(plan.showLabels).toBe(true);
  });

  it('keeps 30 cells — one overtime — on one labelled row, which is the brief', () => {
    const plan = planRoundStrip({ roundCount: 30 });

    expect(plan.rows).toBe(1);
    expect(plan.cellWidthPx).toBeGreaterThan(ROUND_CELL_LABEL_MIN_PX);
    expect(plan.showLabels).toBe(true);
  });

  it('still fits a long overtime on one row', () => {
    const plan = planRoundStrip({ roundCount: 45 });

    expect(plan.rows).toBe(1);
    expect(plan.cellWidthPx).toBeGreaterThanOrEqual(ROUND_CELL_MIN_PX);
  });

  it('wraps rather than shrinking a cell below the minimum', () => {
    const plan = planRoundStrip({ roundCount: 58 });

    expect(plan.rows).toBe(2);
    expect(plan.cellWidthPx).toBeGreaterThanOrEqual(ROUND_CELL_MIN_PX);
    expect(plan.showLabels).toBe(true);
  });

  it('balances the rows instead of filling the first one', () => {
    const plan = planRoundStrip({ roundCount: 58 });

    // 58 over two rows is 29 + 29, not 45 + 13: a short trailing row reads as
    // missing data, and the strip is a picture of the whole match.
    expect(plan.perRow).toBe(29);
    expect(plan.perRow * plan.rows).toBeGreaterThanOrEqual(58);
    expect((plan.perRow - 1) * plan.rows).toBeLessThan(58);
  });
});

describe('planRoundStrip invariants', () => {
  const widths = [320, 640, 996, 1440, 1832];
  const counts = [1, 2, 12, 24, 30, 45, 58, 90, 128];

  it('never plans a cell narrower than the minimum, at any width or count', () => {
    for (const availableWidthPx of widths) {
      for (const roundCount of counts) {
        const plan = planRoundStrip({ roundCount, availableWidthPx });
        expect(plan.cellWidthPx).toBeGreaterThanOrEqual(ROUND_CELL_MIN_PX - 1e-9);
        expect(plan.rows * plan.perRow).toBeGreaterThanOrEqual(roundCount);
      }
    }
  });

  it('never plans a row wider than the container', () => {
    for (const availableWidthPx of widths) {
      for (const roundCount of counts) {
        const plan = planRoundStrip({ roundCount, availableWidthPx });
        const used = plan.perRow * plan.cellWidthPx + (plan.perRow - 1) * ROUND_CELL_GAP_PX;
        expect(used).toBeLessThanOrEqual(availableWidthPx + 1e-9);
      }
    }
  });

  it('needs no more rows as the container grows', () => {
    for (const roundCount of counts) {
      let previous = Number.POSITIVE_INFINITY;
      for (const availableWidthPx of widths) {
        const { rows } = planRoundStrip({ roundCount, availableWidthPx });
        expect(rows).toBeLessThanOrEqual(previous);
        previous = rows;
      }
    }
  });
});

describe('planRoundStrip edges', () => {
  it('plans nothing for no rounds', () => {
    expect(planRoundStrip({ roundCount: 0 })).toEqual({
      rows: 0,
      perRow: 0,
      cellWidthPx: 0,
      showLabels: false,
    });
    expect(planRoundStrip({ roundCount: -4 }).rows).toBe(0);
    expect(planRoundStrip({ roundCount: Number.NaN }).rows).toBe(0);
  });

  it('gives a single round the whole width', () => {
    const plan = planRoundStrip({ roundCount: 1, availableWidthPx: 996 });
    expect(plan).toEqual({ rows: 1, perRow: 1, cellWidthPx: 996, showLabels: true });
  });

  it('drops the label before it drops the cell', () => {
    // Narrow enough that a cell is a target but not a legible number.
    const plan = planRoundStrip({ roundCount: 24, availableWidthPx: 24 * 19 + 23 * 4 });
    expect(plan.rows).toBe(1);
    expect(plan.showLabels).toBe(false);
    expect(plan.cellWidthPx).toBeGreaterThanOrEqual(ROUND_CELL_MIN_PX);
  });

  it('degrades to one cell per row in a zero-width container rather than hiding rounds', () => {
    const plan = planRoundStrip({ roundCount: 24, availableWidthPx: 0 });
    expect(plan.perRow).toBe(1);
    expect(plan.rows).toBe(24);
    expect(plan.showLabels).toBe(false);
  });

  it('takes an overridden gap and minimum', () => {
    const plan = planRoundStrip({ roundCount: 24, availableWidthPx: 996, gapPx: 0, minCellPx: 40 });
    expect(plan.rows).toBe(1);
    expect(plan.cellWidthPx).toBe(41.5);
  });

  it('treats non-finite inputs as their safe extreme rather than as NaN', () => {
    const plan = planRoundStrip({ roundCount: 24, availableWidthPx: Number.NaN });
    expect(Number.isNaN(plan.cellWidthPx)).toBe(false);
    expect(plan.perRow).toBe(1);
  });
});
