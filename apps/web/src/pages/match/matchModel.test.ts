/*
 * `unit` project — wire → the presentation models the context bar takes.
 *
 * The interesting cases are all about *absence*: a demo that has never been
 * analysed still has to produce a bar that says something true, and none of the
 * missing fields may be filled with a zero.
 */

import { describe, expect, it } from 'vitest';

import type { AnalysisWorkspace, DemoSummary } from '../../shared/desktop/dto';
import {
  focusedPlayers,
  formatMatchDay,
  mapCode,
  mapDisplayName,
  matchIdentity,
  matchTeams,
  roundLabel,
  roundSummaries,
} from './matchModel';
import { ANALYSIS, DEMO, DEMO_ID } from './test/fixtures';

describe('the map plate', () => {
  it('knows the maps that have a community abbreviation', () => {
    expect(mapCode('de_mirage')).toBe('MRG');
    expect(mapCode('DE_INFERNO')).toBe('INF');
  });

  it('draws no plate for a map it does not know, rather than guessing one', () => {
    // 「DE_」 would be the truncation, and a confidently wrong three letters is
    // worse than none: the plate is part of the match's identity.
    expect(mapCode('de_workshop_thing')).toBeUndefined();
    expect(mapCode(null)).toBeUndefined();
  });

  it('prints the map without its file-name prefix', () => {
    expect(mapDisplayName('de_mirage')).toBe('Mirage');
    expect(mapDisplayName('cs_office')).toBe('Office');
    expect(mapDisplayName('  ')).toBeNull();
    expect(mapDisplayName(undefined)).toBeNull();
  });
});

describe('the date', () => {
  it('is the artboard’s ISO day, with no clock', () => {
    expect(formatMatchDay('2026-08-14T20:11:00.000Z')).toMatch(/^\d{4}-\d{2}-\d{2}$/u);
  });

  it('is null rather than 「Invalid Date」 when the record has none', () => {
    expect(formatMatchDay(null)).toBeNull();
    expect(formatMatchDay('not a date')).toBeNull();
  });
});

describe('identity', () => {
  it('is built from the library record before any analysis exists', () => {
    const identity = matchIdentity(DEMO_ID, { demo: DEMO });
    expect(identity.mapName).toBe('Mirage');
    expect(identity.mapCode).toBe('MRG');
    expect(identity.roundCount).toBe(24);
    // No analysis, no tick rate — the bar falls back to 64 and prints it.
    expect(identity.tickRate).toBeUndefined();
  });

  it('prefers the analysis where it has an answer', () => {
    const identity = matchIdentity(DEMO_ID, { demo: DEMO, analysis: ANALYSIS });
    expect(identity.tickRate).toBe(64);
    // Three parsed rounds beat the library's 24 — the strip is drawn from the
    // list, and the two disagree on an interrupted parse.
    expect(identity.roundCount).toBe(3);
  });

  it('falls back to the demo id when nothing names the match', () => {
    expect(matchIdentity('x-1', {}).mapName).toBe('x-1');
  });
});

describe('the scoreboard', () => {
  it('takes both names and both scores from the analysis', () => {
    const { teamA, teamB } = matchTeams({ demo: DEMO, analysis: ANALYSIS });
    expect(teamA).toEqual({ id: 'a', name: 'Aurora', side: 'ct', score: 13 });
    expect(teamB).toEqual({ id: 'b', name: 'Meridian', side: 't', score: 11 });
  });

  it('falls back to the library record when the demo is unanalysed', () => {
    const { teamA, teamB } = matchTeams({ demo: DEMO });
    expect(teamA.name).toBe('Aurora');
    expect(teamB.score).toBe(11);
    expect(teamA.side).toBeUndefined();
  });

  it('leaves the score null — never 0 — when nobody has one', () => {
    const bare: DemoSummary = { ...DEMO, score_team_a: null, score_team_b: null };
    const { teamA, teamB } = matchTeams({ demo: bare });
    expect(teamA.score).toBeNull();
    expect(teamB.score).toBeNull();
  });

  it('drops a side it cannot read instead of guessing CT', () => {
    const odd: AnalysisWorkspace = {
      ...ANALYSIS,
      teams: [
        { name: 'Aurora', side: '', score: 13, players: [] },
        { name: 'Meridian', side: 'spectator', score: 11, players: [] },
      ],
    };
    const { teamA, teamB } = matchTeams({ analysis: odd });
    expect(teamA.side).toBeUndefined();
    expect(teamB.side).toBeUndefined();
  });
});

describe('rounds', () => {
  it('maps the wire winner and canonicalises the end reason', () => {
    const [first, second] = roundSummaries(ANALYSIS);
    expect(first).toMatchObject({ number: 1, winner: 'a', reason: 'elimination' });
    expect(second).toMatchObject({ number: 2, winner: 'b', reason: 'bomb-exploded' });
  });

  it('carries the tick range each cell needs to be clickable', () => {
    expect(roundSummaries(ANALYSIS)[0]).toMatchObject({ startTick: 16_000, endTick: 21_400 });
  });

  it('marks no round as 「关键回合」 — the wire has no such field', () => {
    for (const round of roundSummaries(ANALYSIS)) {
      expect(round.key).toBeUndefined();
    }
  });

  it('is empty, not undefined, before the analysis lands', () => {
    expect(roundSummaries(undefined)).toEqual([]);
  });

  it('labels the selected round the way the bar prints it', () => {
    expect(roundLabel(21)).toBe('R21');
    expect(roundLabel(null)).toBeNull();
  });
});

describe('focus', () => {
  it('is empty when the address carries no player', () => {
    expect(focusedPlayers(ANALYSIS, null)).toEqual([]);
  });

  it('names the player once the analysis knows the id', () => {
    expect(focusedPlayers(ANALYSIS, 'kael')).toEqual([
      { id: 'kael', name: 'Kael', primary: true },
    ]);
  });

  it('shows the raw id rather than an empty chip while the name is unknown', () => {
    expect(focusedPlayers(undefined, 'kael')[0]?.name).toBe('kael');
    expect(focusedPlayers(ANALYSIS, 'nobody')[0]?.name).toBe('nobody');
  });
});
