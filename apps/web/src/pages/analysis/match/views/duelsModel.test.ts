/*
 * `unit` project — the 对位 arithmetic.
 *
 * Every assertion here is about a rule the view depends on and cannot restate:
 * that a zero cell is a measurement, that an unattributed kill is skipped
 * rather than half-counted, and that a teammate never appears as an opponent.
 */

import { describe, expect, it } from 'vitest';

import {
  cellWashPercent,
  duelMatrix,
  hasKillEvents,
  matchupsAgainst,
  MAX_CELL_WASH_PERCENT,
  openingDuels,
  openingTallies,
  pairKills,
  roster,
  rosterIndex,
} from './duelsModel';
import { ANALYSIS, BARE_ANALYSIS, ROUNDS } from './test/rosterFixtures';

describe('the roster', () => {
  it('is one side, most kills first', () => {
    expect(roster(ANALYSIS, 'A').map((entry) => entry.name)).toEqual(['Kael', 'Rhea']);
    expect(roster(ANALYSIS, 'B').map((entry) => entry.name)).toEqual(['Sable', 'Corvin']);
  });

  it('is empty rather than thrown for a workspace that has not loaded', () => {
    expect(roster(undefined, 'A')).toEqual([]);
    expect(rosterIndex(undefined).size).toBe(0);
  });

  it('indexes every player of both sides', () => {
    const index = rosterIndex(ANALYSIS);
    expect([...index.keys()].sort()).toEqual(['corvin', 'kael', 'rhea', 'sable']);
    expect(index.get('sable')?.team).toBe('B');
  });
});

describe('the matrix', () => {
  const matrix = duelMatrix(ANALYSIS, 'A');

  it('is rectangular over the two rosters, not over the observed pairs', () => {
    expect(matrix.rows.map((row) => row.player.name)).toEqual(['Kael', 'Rhea']);
    expect(matrix.columns.map((column) => column.name)).toEqual(['Sable', 'Corvin']);
    for (const row of matrix.rows) expect(row.cells).toHaveLength(2);
  });

  it('reads a cell as the row player’s kills on the column player', () => {
    const kael = matrix.rows[0];
    expect(kael?.cells[0]?.kills).toBe(2);
    expect(kael?.cells[0]?.deaths).toBe(1);
    expect(kael?.cells[0]?.headshotKills).toBe(2);
    expect(kael?.cells[1]?.kills).toBe(1);
  });

  it('totals the row across the listed opponents', () => {
    expect(matrix.rows.map((row) => row.kills)).toEqual([3, 2]);
  });

  it('reports the densest cell so the wash has a scale', () => {
    expect(matrix.maxKills).toBe(2);
  });

  it('keeps rows for a side with no matchup records at all', () => {
    const bare = duelMatrix(BARE_ANALYSIS, 'A');
    expect(bare.rows).toHaveLength(2);
    // A rectangular grid of measured zeros, not a missing table.
    expect(bare.rows.every((row) => row.cells.every((cell) => cell.kills === 0))).toBe(true);
    expect(bare.maxKills).toBe(0);
  });

  it('flips both axes when the row side is B', () => {
    const flipped = duelMatrix(ANALYSIS, 'B');
    expect(flipped.rows.map((row) => row.player.name)).toEqual(['Sable', 'Corvin']);
    expect(flipped.columns.map((column) => column.name)).toEqual(['Kael', 'Rhea']);
    expect(flipped.rows[0]?.cells[0]?.kills).toBe(1);
  });
});

describe('the cell wash', () => {
  it('tops out at the artboard’s densest cell', () => {
    expect(cellWashPercent(7, 7)).toBe(MAX_CELL_WASH_PERCENT);
  });

  it('is flat where there is nothing to compare', () => {
    expect(cellWashPercent(0, 7)).toBe(0);
    expect(cellWashPercent(3, 0)).toBe(0);
  });

  it('scales the middle linearly', () => {
    expect(cellWashPercent(2, 7)).toBe(10);
    expect(cellWashPercent(5, 7)).toBe(24);
  });
});

describe('the opening duel of a round', () => {
  const duels = openingDuels(ROUNDS);

  it('is the earliest kill with both ends named, not the earliest event', () => {
    // R1's first event is an unattributed kill 50 ticks earlier.
    expect(duels[0]).toMatchObject({ round: 1, killerId: 'kael', victimId: 'sable', tick: 10_100 });
  });

  it('carries the weapon and the qualifiers verbatim', () => {
    expect(duels[0]?.weapon).toBe('ak47');
    expect(duels[0]?.headshot).toBe(true);
    expect(duels[1]?.penetrated).toBe(false);
  });

  it('is one per round, in round order', () => {
    expect(duels.map((duel) => duel.round)).toEqual([1, 2, 3]);
    expect(duels[1]?.killerId).toBe('sable');
  });

  it('is empty when nothing in the analysis is an attributed kill', () => {
    expect(openingDuels(BARE_ANALYSIS.rounds)).toEqual([]);
  });
});

describe('the opening tallies', () => {
  const tallies = openingTallies(openingDuels(ROUNDS));

  it('counts both halves of the exchange', () => {
    expect(tallies.get('kael')).toEqual({ kills: 2, deaths: 1 });
    expect(tallies.get('sable')).toEqual({ kills: 1, deaths: 1 });
    expect(tallies.get('corvin')).toEqual({ kills: 0, deaths: 1 });
  });

  it('has no entry for a player who was in no opening duel', () => {
    expect(tallies.get('rhea')).toBeUndefined();
  });
});

describe('whether there is an event stream at all', () => {
  it('separates 「没有事件流」 from 「零次击杀」', () => {
    expect(hasKillEvents(ROUNDS)).toBe(true);
    expect(hasKillEvents(BARE_ANALYSIS.rounds)).toBe(false);
  });
});

describe('one pair’s exchanges', () => {
  it('is directed and tick-ordered', () => {
    const kills = pairKills(ROUNDS, 'kael', 'sable');
    expect(kills.map((entry) => entry.tick)).toEqual([10_100, 30_150]);
    expect(kills[0]?.round).toBe(1);
    expect(pairKills(ROUNDS, 'sable', 'kael')).toHaveLength(1);
  });

  it('is empty rather than thrown for a pair that never met', () => {
    expect(pairKills(ROUNDS, 'rhea', 'kael')).toEqual([]);
  });
});

describe('one player’s matchups', () => {
  const index = rosterIndex(ANALYSIS);

  it('drops teammates — friendly fire makes a same-team pair', () => {
    const matchups = matchupsAgainst(ANALYSIS.insights, 'kael', index);
    expect(matchups.map((matchup) => matchup.opponent_id)).toEqual(['sable', 'corvin']);
  });

  it('ranks by kills, then by damage', () => {
    const matchups = matchupsAgainst(ANALYSIS.insights, 'kael', index);
    expect(matchups[0]?.kills).toBe(2);
  });

  it('is empty when the insight block has no matchups', () => {
    expect(matchupsAgainst(BARE_ANALYSIS.insights, 'kael', index)).toEqual([]);
    expect(matchupsAgainst(undefined, 'kael', index)).toEqual([]);
  });
});
