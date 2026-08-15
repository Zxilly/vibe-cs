/*
 * `unit` project — the 玩家 arithmetic.
 *
 * The load-bearing assertions are the ones about absence: a missing statistic
 * is `null` and prints as a dash, and a missing *event stream* is `null` too —
 * a different `null` from 「他没有击杀」, which is 0.
 */

import { describe, expect, it } from 'vitest';

import { HIGHLIGHT_KINDS, TICK_GROUP_SEPARATOR } from '../../../domain/match';
import type { Highlight } from '../../../shared/desktop/dto';
import {
  formatCount,
  formatFixed,
  formatPercent,
  highlightKindOf,
  NO_VALUE,
  playerHighlights,
  scoreboardRows,
  SCOREBOARD_SORT_IDS,
  sortScoreboardRows,
  teamNames,
  weaponBreakdown,
} from './playersModel';
import { ANALYSIS, BARE_ANALYSIS, ROUNDS } from './test/rosterFixtures';

describe('formatting', () => {
  it('prints the dash for a number that does not exist', () => {
    expect(formatFixed(null, 2)).toBe(NO_VALUE);
    expect(formatFixed(Number.NaN, 2)).toBe(NO_VALUE);
    expect(formatPercent(null)).toBe(NO_VALUE);
    expect(formatCount(undefined)).toBe(NO_VALUE);
  });

  it('prints zero as zero — a measured zero is not a missing value', () => {
    expect(formatFixed(0, 0)).toBe('0');
    expect(formatPercent(0)).toBe('0%');
    expect(formatCount(0)).toBe('0');
  });

  it('rounds a rate to whole percents and groups a count', () => {
    expect(formatPercent(0.618)).toBe('62%');
    expect(formatCount(1_246)).toBe(`1${TICK_GROUP_SEPARATOR}246`);
    expect(formatCount(999)).toBe('999');
  });
});

describe('the team names', () => {
  it('comes off the analysis, positionally', () => {
    expect(teamNames(ANALYSIS)).toEqual({ A: 'Aurora', B: 'Meridian' });
  });

  it('is empty rather than 「队伍 A」 when nothing named them', () => {
    expect(teamNames(undefined)).toEqual({ A: '', B: '' });
  });
});

describe('the scoreboard rows', () => {
  const rows = scoreboardRows(ANALYSIS);

  it('is team A then team B, most kills first inside each', () => {
    expect(rows.map((row) => row.name)).toEqual(['Kael', 'Rhea', 'Sable', 'Corvin']);
  });

  it('carries the team’s own name rather than the side letter', () => {
    expect(rows[0]?.teamName).toBe('Aurora');
    expect(rows[2]?.teamName).toBe('Meridian');
  });

  it('copies the per-match record without recomputing it', () => {
    expect(rows[0]).toMatchObject({
      kills: 27,
      deaths: 14,
      assists: 5,
      killDeathRatio: 1.93,
      adr: 98.4,
      headshotRate: 0.62,
    });
  });

  it('derives 首杀 / 首死 from the event stream', () => {
    expect(rows[0]).toMatchObject({ openingKills: 2, openingDeaths: 1 });
    // Rhea was in no opening duel: a measured zero, not a missing value.
    expect(rows[1]).toMatchObject({ openingKills: 0, openingDeaths: 0 });
  });

  it('reports 首杀 as null — never 0 — when there is no event stream', () => {
    const bare = scoreboardRows(BARE_ANALYSIS);
    expect(bare.every((row) => row.openingKills === null && row.openingDeaths === null)).toBe(true);
  });

  it('counts this match’s highlights per player', () => {
    expect(rows[0]?.highlights).toBe(2);
    expect(rows[1]?.highlights).toBe(0);
    expect(rows[2]?.highlights).toBe(1);
  });

  it('is empty rather than thrown before the analysis lands', () => {
    expect(scoreboardRows(undefined)).toEqual([]);
  });
});

describe('sorting the scoreboard', () => {
  const rows = scoreboardRows(ANALYSIS);

  it('leaves the team grouping alone when nothing is sorted', () => {
    expect(sortScoreboardRows(rows, null)).toBe(rows);
  });

  it('ranks across both sides once a header is used', () => {
    const byAdr = sortScoreboardRows(rows, { columnId: 'adr', direction: 'desc' });
    expect(byAdr.map((row) => row.name)).toEqual(['Kael', 'Sable', 'Rhea', 'Corvin']);
  });

  it('sorts a name as a name, not as a number', () => {
    const byName = sortScoreboardRows(rows, { columnId: 'name', direction: 'asc' });
    expect(byName.map((row) => row.name)).toEqual(['Corvin', 'Kael', 'Rhea', 'Sable']);
  });

  it('ignores a column id it does not know', () => {
    expect(sortScoreboardRows(rows, { columnId: 'nope', direction: 'asc' })).toBe(rows);
  });

  it('sorts every declared column without throwing', () => {
    for (const columnId of SCOREBOARD_SORT_IDS) {
      expect(sortScoreboardRows(rows, { columnId, direction: 'desc' })).toHaveLength(rows.length);
    }
  });
});

describe('the weapon breakdown', () => {
  it('counts kills per weapon, most first', () => {
    const breakdown = weaponBreakdown(ROUNDS, 'kael', 4);
    expect(breakdown?.entries).toEqual([{ weapon: 'ak47', kills: 3 }]);
    expect(breakdown?.total).toBe(3);
    expect(breakdown?.other).toBe(0);
  });

  it('folds the tail past the limit into 其他', () => {
    const breakdown = weaponBreakdown(ROUNDS, 'rhea', 1);
    expect(breakdown?.entries).toHaveLength(1);
    expect(breakdown?.other).toBe(1);
    expect(breakdown?.total).toBe(2);
  });

  it('is null — not empty — when the analysis has no event stream', () => {
    expect(weaponBreakdown(BARE_ANALYSIS.rounds, 'kael', 4)).toBeNull();
  });

  it('is an empty breakdown for a player with no kills in a match that has events', () => {
    const breakdown = weaponBreakdown(ROUNDS, 'corvin', 4);
    expect(breakdown).not.toBeNull();
    expect(breakdown?.total).toBe(0);
  });
});

describe('the highlight kind table', () => {
  const WIRE_KINDS: readonly Highlight['kind'][] = [
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

  it('maps every wire kind onto a member of the domain vocabulary', () => {
    for (const kind of WIRE_KINDS) {
      expect(`${kind}:${String(HIGHLIGHT_KINDS.includes(highlightKindOf(kind)))}`).toBe(
        `${kind}:true`,
      );
    }
  });

  it('folds a one-tap onto 爆头 and the untyped ones onto 其他', () => {
    expect(highlightKindOf('one_tap')).toBe('headshot');
    expect(highlightKindOf('knife')).toBe('other');
    expect(highlightKindOf('timeline')).toBe('other');
  });
});

describe('one player’s highlights', () => {
  it('is filtered to the player and ordered by round', () => {
    const highlights = playerHighlights(ANALYSIS, 'kael');
    expect(highlights.map((entry) => entry.round)).toEqual([1, 3]);
  });

  it('is empty rather than thrown when the analysis has none', () => {
    expect(playerHighlights(BARE_ANALYSIS, 'kael')).toEqual([]);
    expect(playerHighlights(undefined, 'kael')).toEqual([]);
  });
});
