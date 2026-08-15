/*
 * `unit` project — the derivations 概览 / 回合 / 队伍 share.
 *
 * The assertions worth having here are the ones about *not lying*: an event that
 * names nobody must not be folded into one side, a count that cannot be derived
 * must not appear, and a sort must be total so two renders of one document
 * agree.
 */

import { describe, expect, it } from 'vitest';

import type { AnalysisWorkspace, Highlight, PlayerAnalysis } from '../../../shared/desktop/dto';
import {
  highlightKindCounts,
  highlightKindOf,
  matchOverviewFacts,
  openingKills,
  playerDirectory,
  positionedEvidence,
  rankedHighlights,
  rosters,
  roundsWon,
  signedDelta,
  teamNames,
  teamOfActor,
  toHighlightCandidate,
  winsByReason,
} from './matchAggregates';
import { ANALYSIS, BARE_ANALYSIS, PLAYERS } from './test/matchFixture';

describe('identity resolution', () => {
  const directory = playerDirectory(PLAYERS);

  it('answers to the id and to the name, because the wire uses both', () => {
    expect(teamOfActor('kael', directory)).toBe('a');
    expect(teamOfActor('Kael', directory)).toBe('a');
    expect(teamOfActor('sable', directory)).toBe('b');
  });

  it('returns null for a stranger rather than guessing a side', () => {
    expect(teamOfActor('a-player-who-left', directory)).toBeNull();
    expect(teamOfActor(null, directory)).toBeNull();
    expect(teamOfActor('', directory)).toBeNull();
  });

  it('does not let a name key shadow a player whose id is already indexed', () => {
    const twins: PlayerAnalysis[] = [
      { ...(PLAYERS[0] as PlayerAnalysis), id: 'kael', name: 'Kael' },
      { ...(PLAYERS[5] as PlayerAnalysis), id: 'Kael', name: 'Shadow' },
    ];
    // 'Kael' is the second player's *id*; it must keep winning over the first
    // player's name, because an id is the stronger claim.
    expect(playerDirectory(twins).get('Kael')?.name).toBe('Shadow');
  });
});

describe('rosters', () => {
  it('splits by team and sorts by impact, with a stable tail', () => {
    const split = rosters(PLAYERS);
    expect(split.a).toHaveLength(5);
    expect(split.b).toHaveLength(5);
    expect(split.a.map((player) => player.name)[0]).toBe('Kael');
    const kills = split.a.map((player) => player.kills);
    expect([...kills].sort((left, right) => right - left)).toEqual(kills);
  });
});

describe('round tallies', () => {
  it('counts the round list rather than trusting TeamSummary.score', () => {
    expect(roundsWon(ANALYSIS.rounds)).toEqual({ a: 13, b: 11 });
  });

  it('breaks wins down over the whole closed reason vocabulary', () => {
    const wins = winsByReason(ANALYSIS.rounds);
    const totalA = Object.values(wins.a).reduce((sum, value) => sum + value, 0);
    const totalB = Object.values(wins.b).reduce((sum, value) => sum + value, 0);
    expect(totalA).toBe(13);
    expect(totalB).toBe(11);
    // A reason nobody won a round with is present and zero, so the table keeps
    // its shape between two matches.
    expect(wins.a).toHaveProperty('unknown');
  });
});

describe('opening kills', () => {
  const directory = playerDirectory(PLAYERS);

  it('takes the earliest kill of each round, not the first in the array', () => {
    const base = ANALYSIS.rounds[0] as AnalysisWorkspace['rounds'][number];
    const template = base.events[0] as AnalysisWorkspace['rounds'][number]['events'][number];
    const round = {
      ...base,
      events: [
        { ...template, id: 'late', tick: base.start_tick + 5_000, actor: 'kael', kind: 'kill' as const },
        { ...template, id: 'early', tick: base.start_tick + 100, actor: 'sable', kind: 'kill' as const },
      ],
    };
    // The wire promises no order and 「first kill」 is a claim about time.
    expect(openingKills([round], directory)).toMatchObject({ a: 0, b: 1 });
  });

  it('reports what it could not attribute instead of folding it into a side', () => {
    const opening = openingKills(ANALYSIS.rounds, directory);
    // Round 5's first kill targets a stranger but its *actor* is known, so the
    // opening tally is complete; the fixture's unattributed case is a target.
    expect(opening.a + opening.b + opening.unattributed).toBe(opening.rounds);
    expect(opening.rounds).toBe(24);
  });

  it('counts no rounds at all when the parse produced no kill events', () => {
    const opening = openingKills(BARE_ANALYSIS.rounds, directory);
    expect(opening).toEqual({ a: 0, b: 0, rounds: 0, unattributed: 0 });
  });
});

describe('positioned evidence', () => {
  it('counts the events a 2D replay could actually draw', () => {
    const spatial = positionedEvidence(ANALYSIS.rounds);
    expect(spatial.positioned).toBeGreaterThan(0);
    expect(spatial.positioned).toBeLessThan(spatial.total);
  });

  it('is zero over zero on a parse with no events, so the view can omit it', () => {
    expect(positionedEvidence(BARE_ANALYSIS.rounds)).toEqual({ positioned: 0, total: 0 });
  });
});

describe('highlights', () => {
  const directory = playerDirectory(PLAYERS);

  it('maps every wire kind onto a filter member, with no silent gap', () => {
    const kinds: Highlight['kind'][] = [
      'multi_kill', 'clutch', 'one_tap', 'wallbang', 'no_scope',
      'knife', 'taser', 'defuse', 'fail', 'timeline',
    ];
    for (const kind of kinds) expect(typeof highlightKindOf(kind)).toBe('string');
    // `fail` is not 「残局」: it marks any failed candidate, not a lost clutch.
    expect(highlightKindOf('fail')).toBe('other');
    expect(highlightKindOf('clutch')).toBe('clutch');
  });

  it('drops an empty label rather than rendering an empty Tag', () => {
    const blank = ANALYSIS.highlights.find((entry) => entry.label === '');
    expect(blank).toBeDefined();
    expect(toHighlightCandidate(blank as Highlight, directory).label).toBeUndefined();
  });

  it('names the subject with the player name when the match knows the id', () => {
    const first = toHighlightCandidate(ANALYSIS.highlights[0] as Highlight, directory);
    expect(first.subject).toBe('Kael');
  });

  it('keeps the raw id as the subject when it names nobody', () => {
    const orphan = { ...(ANALYSIS.highlights[0] as Highlight), player_id: 'ghost' };
    expect(toHighlightCandidate(orphan, directory).subject).toBe('ghost');
  });

  it('ranks by confidence and breaks every tie, so the order is total', () => {
    const flat = ANALYSIS.highlights.map((entry) => ({ ...entry, confidence: 0.5 }));
    const once = rankedHighlights(flat, 5).map((entry) => entry.id);
    const twice = rankedHighlights([...flat].reverse(), 5).map((entry) => entry.id);
    expect(once).toEqual(twice);
  });

  it('counts candidates per filter type', () => {
    const counts = highlightKindCounts(ANALYSIS.highlights);
    expect(counts.get('clutch')).toBe(3);
    expect([...counts.values()].reduce((sum, value) => sum + value, 0)).toBe(18);
  });
});

describe('team names', () => {
  it('hands back what the analysis said, empty included, and labels nothing', () => {
    expect(teamNames(ANALYSIS)).toEqual({ a: 'Aurora', b: 'Meridian' });
    expect(teamNames({ ...ANALYSIS, teams: [] })).toEqual({ a: '', b: '' });
  });
});

describe('signedDelta', () => {
  it('shows which way a difference points', () => {
    expect(signedDelta(4)).toBe('+4');
    expect(signedDelta(-2)).toBe('-2');
    expect(signedDelta(0)).toBe('0');
  });
});

describe('the one call 概览 makes', () => {
  it('folds the whole document once', () => {
    const facts = matchOverviewFacts(ANALYSIS);
    expect(facts.rounds).toBe(24);
    expect(facts.won).toEqual({ a: 13, b: 11 });
    expect(facts.highlights).toBe(18);
    expect(facts.clutchCandidates).toBe(3);
  });

  it('reports zeros the view can omit rather than inventing numbers', () => {
    const facts = matchOverviewFacts(BARE_ANALYSIS);
    expect(facts.highlights).toBe(0);
    expect(facts.spatial.total).toBe(0);
    expect(facts.opening.rounds).toBe(0);
  });
});
