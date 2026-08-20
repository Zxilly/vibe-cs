/*
 * `unit` project — the rows and the type filter of 高光.
 *
 * The mapping table is the interesting part: the wire has ten kinds and
 * `HighlightKind` has nine, and the tests below pin both halves of that — the
 * five that line up, and the five that fold onto `other` rather than being
 * invented into the union.
 */

import { describe, expect, it } from 'vitest';

import { HIGHLIGHT_KINDS, type HighlightCandidate } from '../../../domain/match';
import type { Highlight } from '../../../shared/desktop/viewModels';
import {
  HIGHLIGHT_WIRE_KIND,
  currentHighlightId,
  filterHighlights,
  highlightKindCounts,
  matchHighlights,
  playerNameIndex,
  highlightPage,
  toHighlightCandidate,
  toggleSelected,
  visibleSelection,
} from './highlightModel';
import { ANALYSIS, HIGHLIGHTS, TICK_RATE } from './test/fixtures';

describe('HIGHLIGHT_WIRE_KIND', () => {
  it('is total over the wire union and lands inside the domain union', () => {
    const wireKinds: readonly Highlight['kind'][] = [
      'multi_kill',
      'clutch',
      'one_tap',
      'wallbang',
      'no_scope',
      'knife',
      'taser',
      'defuse',
      'fail',
      'timeline',
    ];
    for (const kind of wireKinds) {
      expect(`${kind}:${HIGHLIGHT_WIRE_KIND[kind]}`).toBe(`${kind}:${HIGHLIGHT_WIRE_KIND[kind]}`);
      expect(HIGHLIGHT_KINDS).toContain(HIGHLIGHT_WIRE_KIND[kind]);
    }
  });

  it('folds the five with no member of their own onto 其他', () => {
    // Reported as a contract gap rather than papered over: the row still prints
    // the analyser's own label, only the chip is coarser.
    expect(HIGHLIGHT_WIRE_KIND.knife).toBe('other');
    expect(HIGHLIGHT_WIRE_KIND.taser).toBe('other');
    expect(HIGHLIGHT_WIRE_KIND.defuse).toBe('other');
    expect(HIGHLIGHT_WIRE_KIND.fail).toBe('other');
    expect(HIGHLIGHT_WIRE_KIND.timeline).toBe('other');
  });

  it('reads 一枪 as 爆头', () => {
    expect(HIGHLIGHT_WIRE_KIND.one_tap).toBe('headshot');
  });
});

describe('toHighlightCandidate', () => {
  const names = playerNameIndex(ANALYSIS);

  it('renames the wire fields and resolves the player', () => {
    const [wire] = HIGHLIGHTS;
    const row = toHighlightCandidate(wire as Highlight, names, TICK_RATE);
    expect(row.id).toBe('h-21-clutch');
    expect(row.kind).toBe('clutch');
    expect(row.round).toBe(21);
    expect(row.subject).toBe('Kael');
    expect(row.startTick).toBe(148_920);
    expect(row.tickRate).toBe(TICK_RATE);
  });

  it('does not expose a raw id when the analysis does not know the player', () => {
    const row = toHighlightCandidate(
      { ...(HIGHLIGHTS[0] as Highlight), player_id: 'ghost' },
      names,
      TICK_RATE,
    );
    expect(row.subject).toBe('未知选手');
  });

  it('fills an empty analyzer label from the typed kind and omits an empty description', () => {
    const row = toHighlightCandidate(
      { ...(HIGHLIGHTS[0] as Highlight), label: '  ', description: '' },
      names,
      undefined,
    );
    expect(row.label).toBe('残局');
    expect(row.description).toBeUndefined();
    expect(row.tickRate).toBeUndefined();
  });

  it('turns analyzer boilerplate and victim ids into product language', () => {
    const row = toHighlightCandidate(
      {
        ...(HIGHLIGHTS[0] as Highlight),
        kind: 'one_tap',
        label: 'One-tap',
        description: 'One-tap against victim-id',
        victims: ['victim-id'],
      },
      new Map([['kael', 'Kael'], ['victim-id', 'Sable']]),
      TICK_RATE,
    );
    expect(row.label).toBe('一发击杀');
    expect(row.description).toBe('Kael 一发击杀 Sable');
  });
});

describe('matchHighlights', () => {
  it('orders by round descending, then chronologically inside a round', () => {
    const rows = matchHighlights(ANALYSIS);
    expect(rows.map((row) => row.id)).toEqual([
      'h-21-clutch',
      'h-21-wallbang',
      'h-18-multi',
      'h-7-noscope',
    ]);
  });

  it('is empty without an analysis', () => {
    expect(matchHighlights(undefined)).toEqual([]);
  });
});

describe('highlightKindCounts', () => {
  it('counts only the kinds that are present, in the vocabulary’s order', () => {
    const counts = highlightKindCounts(matchHighlights(ANALYSIS));
    expect(counts).toEqual([
      { kind: 'clutch', count: 1 },
      { kind: 'multi-kill', count: 1 },
      { kind: 'wallbang', count: 1 },
      { kind: 'no-scope', count: 1 },
    ]);
  });

  it('never emits a zero chip', () => {
    // 赛点 / 经济翻盘 / 首杀 have no wire kind at all; a 「赛点 0」 chip would be a
    // filter that can only produce an empty list.
    const kinds = highlightKindCounts(matchHighlights(ANALYSIS)).map((entry) => entry.kind);
    expect(kinds).not.toContain('match-point');
    expect(kinds).not.toContain('eco-comeback');
  });
});

describe('filterHighlights', () => {
  const rows = matchHighlights(ANALYSIS);

  it('passes everything through for 全部', () => {
    expect(filterHighlights(rows, null)).toHaveLength(rows.length);
  });

  it('narrows to one kind', () => {
    expect(filterHighlights(rows, 'clutch').map((row) => row.id)).toEqual(['h-21-clutch']);
  });
});

describe('highlightPage', () => {
  const rows = Array.from({ length: 121 }, (_, index) => ({
    id: `h-${index}`,
  }));

  it('keeps one bounded stable window in the DOM', () => {
    expect(highlightPage(rows, 1).map((row) => row.id)).toEqual(
      Array.from({ length: 50 }, (_, index) => `h-${index}`),
    );
    expect(highlightPage(rows, 3).map((row) => row.id)).toEqual(
      Array.from({ length: 21 }, (_, index) => `h-${index + 100}`),
    );
  });
});

describe('currentHighlightId', () => {
  const rows = matchHighlights(ANALYSIS);

  it('addresses a highlight by its round and its first tick', () => {
    expect(currentHighlightId(rows, 21, 148_920)).toBe('h-21-clutch');
    expect(currentHighlightId(rows, 21, 149_340)).toBe('h-21-wallbang');
  });

  it('is null when the address points at no highlight', () => {
    expect(currentHighlightId(rows, 21, 1)).toBeNull();
    expect(currentHighlightId(rows, null, 148_920)).toBeNull();
    expect(currentHighlightId(rows, 21, null)).toBeNull();
  });
});

describe('the batch selection', () => {
  it('adds and removes without mutating the set it was given', () => {
    const first: ReadonlySet<string> = new Set(['a']);
    const second = toggleSelected(first, 'b', true);
    expect([...second]).toEqual(['a', 'b']);
    expect([...first]).toEqual(['a']);
    expect([...toggleSelected(second, 'a', false)]).toEqual(['b']);
  });

  it('counts only the rows the filter is showing', () => {
    const rows = matchHighlights(ANALYSIS);
    const selected = new Set(['h-21-clutch', 'h-18-multi']);
    const visible: readonly HighlightCandidate[] = filterHighlights(rows, 'clutch');
    // 「已选 2 条」 above a list with one of them on screen would be a claim about
    // something invisible.
    expect(visibleSelection(selected, visible).map((row) => row.id)).toEqual(['h-21-clutch']);
  });
});
