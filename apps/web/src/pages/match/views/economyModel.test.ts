/*
 * `unit` project — 队伍's 经济 block.
 *
 * Two properties are the whole reason this module exists, and both are about
 * refusing to print a plausible wrong number: a total spend goes `null` the
 * moment one of its rounds has no price, and the rows are keyed by *side*
 * because that is what the analyser attributed them to.
 */

import { describe, expect, it } from 'vitest';

import type { AnalysisWorkspace } from '../../../shared/desktop/viewModels';
import { economyAvailability, economyTotals, sideEconomyRows } from './economyModel';
import { ANALYSIS, BARE_ANALYSIS, INSIGHTS } from './test/matchFixture';

describe('rows', () => {
  const rows = sideEconomyRows(ANALYSIS);

  it('has one row per round of the analysis, in round order', () => {
    expect(rows).toHaveLength(24);
    expect(rows.map((row) => row.round)).toEqual(Array.from({ length: 24 }, (_, i) => i + 1));
  });

  it('carries the winner, which is the one per-team fact a round record has', () => {
    expect(rows[0]?.winner).toBe('a');
    expect(rows[1]?.winner).toBe('b');
  });

  it('keeps a round the economy pass produced nothing for, with zeros it can defend', () => {
    const partial: AnalysisWorkspace = {
      ...ANALYSIS,
      insights: { ...INSIGHTS, round_economy: INSIGHTS.round_economy.slice(0, 3) },
    };
    const sparse = sideEconomyRows(partial);
    // Round 8 exists and reads zero rather than the table skipping to round 3.
    expect(sparse).toHaveLength(24);
    expect(sparse[7]).toMatchObject({ round: 8, ct: { purchases: 0, spend: null } });
  });

  it('reads zeros throughout when the document carries no insights at all', () => {
    const rowsWithout = sideEconomyRows(BARE_ANALYSIS);
    expect(rowsWithout).toHaveLength(24);
    expect(rowsWithout.every((row) => row.ct.purchases === 0 && row.t.purchases === 0)).toBe(true);
  });
});

describe('totals', () => {
  it('is null, not low, when a contributing round carried no price', () => {
    // The fixture's last round has `spend: null` on both sides.
    const totals = economyTotals(sideEconomyRows(ANALYSIS));
    expect(totals.ct.spend).toBeNull();
    expect(totals.t.spend).toBeNull();
    expect(totals.ct.purchases).toBeGreaterThan(0);
  });

  it('sums when every contributing round has a price', () => {
    const rows = sideEconomyRows(ANALYSIS).filter((row) => row.round !== 24);
    const totals = economyTotals(rows);
    expect(totals.ct.spend).toBe(
      rows.reduce((sum, row) => sum + (row.ct.spend ?? 0), 0),
    );
  });

  it('is not spoiled by a round that simply had no purchases to price', () => {
    const rows = [
      { round: 1, winner: 'a', reason: 'elimination', ct: { purchases: 3, spend: 900 }, t: { purchases: 0, spend: null }, unattributed: 0 },
      { round: 2, winner: 'b', reason: 'elimination', ct: { purchases: 2, spend: 600 }, t: { purchases: 0, spend: null }, unattributed: 0 },
    ] as const;
    const totals = economyTotals(rows);
    expect(totals.ct.spend).toBe(1_500);
    // Nothing was bought on T, so its total is a real zero-purchase answer.
    expect(totals.t.purchases).toBe(0);
  });

  it('surfaces the purchases the analyser could not attribute to a side', () => {
    const totals = economyTotals(sideEconomyRows(ANALYSIS));
    expect(totals.unattributed).toBe(2);
    expect(totals.anyPurchases).toBe(true);
  });

  it('says there is nothing to show when nothing was bought', () => {
    expect(economyTotals(sideEconomyRows(BARE_ANALYSIS)).anyPurchases).toBe(false);
  });
});

describe('availability', () => {
  it('separates 「没有 insights」 from 「跑了但没有购买事件」', () => {
    expect(economyAvailability(undefined)).toEqual({
      available: false,
      reason: null,
      present: false,
    });
    expect(economyAvailability(INSIGHTS)).toEqual({ available: true, reason: null, present: true });
  });

  it('keeps the service’s own sentence rather than rewriting it', () => {
    const blocked = {
      ...INSIGHTS,
      availability: {
        ...INSIGHTS.availability,
        purchase_events: { available: false, reason: '这批 Demo 没有购买事件' },
      },
    };
    expect(economyAvailability(blocked)).toEqual({
      available: false,
      reason: '这批 Demo 没有购买事件',
      present: true,
    });
  });
});
