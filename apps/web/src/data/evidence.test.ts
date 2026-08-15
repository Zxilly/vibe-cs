/*
 * `unit` project — what the evidence index says about itself.
 *
 * These two functions decide whether an empty result set is the query's fault,
 * so they are the difference between 「换个条件」 and 「先去分析一场」. Both are
 * pure functions of the response's `availability` block; the hooks around them
 * are covered by `evidence.interaction.test.tsx`.
 */

import { describe, expect, it } from 'vitest';

import { evidenceIndexState, unsupportedEvidenceFilters, type EvidenceAvailability } from './evidence';

function availability(overrides: Partial<EvidenceAvailability> = {}): EvidenceAvailability {
  return {
    indexed_items: 1_284_632,
    indexed_demos: 248,
    total_analyses: 248,
    scan_complete: true,
    match_date: { available: true, indexed_items: 1_284_632, reason: null },
    source: { available: true, indexed_items: 1_284_632, reason: null },
    ...overrides,
  };
}

describe('how far the index has got', () => {
  it('is complete when everything is in', () => {
    expect(evidenceIndexState(availability())).toBe('complete');
  });

  it('is partial while the scan is still running', () => {
    // A genuine hit may simply not be in yet, so 「放宽条件」 would be bad advice.
    expect(evidenceIndexState(availability({ scan_complete: false }))).toBe('partial');
  });

  it('is empty when nothing is indexed, whatever the scan flag says', () => {
    expect(evidenceIndexState(availability({ indexed_items: 0 }))).toBe('empty');
    expect(
      evidenceIndexState(availability({ indexed_items: 0, scan_complete: false })),
    ).toBe('empty');
  });
});

describe('the filters this index cannot serve', () => {
  it('is empty when both capabilities are available', () => {
    expect(unsupportedEvidenceFilters(availability())).toEqual([]);
  });

  it('reports the service s own reason, so the chip can say why', () => {
    const gaps = unsupportedEvidenceFilters(
      availability({
        match_date: { available: false, indexed_items: 0, reason: '这批索引没有比赛日期' },
      }),
    );
    expect(gaps).toEqual([
      { field: 'match_date', reason: '这批索引没有比赛日期', indexedItems: 0 },
    ]);
  });

  it('reports both when both are unavailable', () => {
    const gaps = unsupportedEvidenceFilters(
      availability({
        match_date: { available: false, indexed_items: 0, reason: null },
        source: { available: false, indexed_items: 3, reason: null },
      }),
    );
    expect(gaps.map((gap) => gap.field)).toEqual(['match_date', 'source']);
    expect(gaps[1]?.indexedItems).toBe(3);
  });
});
