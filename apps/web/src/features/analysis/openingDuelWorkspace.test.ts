import { describe, expect, it } from 'vitest';

import type { AnalysisWorkspace, TimelineEvent } from '../../shared/desktop/dto';
import { buildOpeningDuelWorkspace } from './openingDuelWorkspace';

const event = (overrides: Partial<TimelineEvent>): TimelineEvent => ({
  id: 'kill-1',
  tick: 1_100,
  seconds: 17.2,
  kind: 'kill',
  actor: 'fallen-id',
  target: 'niko-id',
  weapon: 'ak47',
  headshot: false,
  penetrated: false,
  position: null,
  detail: {},
  ...overrides,
});

const workspace: AnalysisWorkspace = {
  demo_id: 'major-final-map-1',
  map_name: 'de_mirage',
  tick_rate: 64,
  duration_seconds: 2_958,
  teams: [],
  players: [
    { id: 'fallen-id', name: 'FalleN', team: 'A', kills: 2, deaths: 1, assists: 0, headshot_rate: 0.5, kill_death_ratio: 2, adr: 80 },
    { id: 'niko-id', name: 'NiKo', team: 'B', kills: 1, deaths: 1, assists: 0, headshot_rate: 0, kill_death_ratio: 1, adr: 75 },
    { id: 'monesy-id', name: 'm0NESY', team: 'B', kills: 0, deaths: 1, assists: 1, headshot_rate: 0, kill_death_ratio: 0, adr: 40 },
  ],
  rounds: [
    {
      number: 1,
      winner: 'A',
      reason: 'elimination',
      start_tick: 1_000,
      end_tick: 2_000,
      team_a_score: 1,
      team_b_score: 0,
      events: [
        event({ id: 'later-kill', tick: 1_500, actor: 'niko-id', target: 'fallen-id' }),
        event({ id: 'opening-r1', tick: 1_100, headshot: true }),
        event({ id: 'same-tick-second', tick: 1_100, actor: 'fallen-id', target: 'monesy-id' }),
      ],
    },
    {
      number: 2,
      winner: 'B',
      reason: 'elimination',
      start_tick: 3_000,
      end_tick: 4_000,
      team_a_score: 1,
      team_b_score: 1,
      events: [
        event({ id: 'opening-r2', tick: 3_150, actor: 'niko-id', target: 'fallen-id', weapon: 'awp' }),
      ],
    },
  ],
  highlights: [],
};

describe('opening duel workspace', () => {
  it('selects one atomic first kill per round by tick then original event order', () => {
    const result = buildOpeningDuelWorkspace(workspace, {
      playerId: null,
      round: null,
      outcome: 'all',
    });

    expect(result.evidence.map((item) => [item.round, item.source_id, item.evidence_id])).toEqual([
      [1, 'opening-r1', 'demo:major-final-map-1/event:opening-r1'],
      [2, 'opening-r2', 'demo:major-final-map-1/event:opening-r2'],
    ]);
    expect(result.player_aggregates).toMatchObject([
      { player_id: 'fallen-id', opening_kills: 1, opening_deaths: 1 },
      { player_id: 'niko-id', opening_kills: 1, opening_deaths: 1 },
      { player_id: 'monesy-id', opening_kills: 0, opening_deaths: 0 },
    ]);
    expect(result.availability).toEqual({ state: 'available', reason: null });
  });

  it('builds a dense directional player matrix from verified first kills only', () => {
    const result = buildOpeningDuelWorkspace(workspace, {
      playerId: null,
      round: null,
      outcome: 'all',
    });

    expect(result.matrix.players.map((player) => player.player_id)).toEqual([
      'fallen-id',
      'niko-id',
      'monesy-id',
    ]);
    expect(result.matrix.cells).toHaveLength(6);
    expect(result.matrix.cells.find((cell) => (
      cell.actor_id === 'fallen-id' && cell.target_id === 'niko-id'
    ))).toEqual({
      actor_id: 'fallen-id',
      target_id: 'niko-id',
      opening_kills: 1,
      evidence_ids: ['demo:major-final-map-1/event:opening-r1'],
    });
    expect(result.matrix.cells.find((cell) => (
      cell.actor_id === 'niko-id' && cell.target_id === 'fallen-id'
    ))).toMatchObject({
      opening_kills: 1,
      evidence_ids: ['demo:major-final-map-1/event:opening-r2'],
    });
    expect(result.matrix.cells.find((cell) => (
      cell.actor_id === 'fallen-id' && cell.target_id === 'monesy-id'
    ))).toMatchObject({ opening_kills: 0, evidence_ids: [] });
    expect(result.matrix.cells.some((cell) => (
      cell.actor_id === 'fallen-id' && cell.target_id === 'fallen-id'
    ))).toBe(false);
    expect(result.matrix).not.toHaveProperty('success_rate');
    expect(result.matrix.cells[0]).not.toHaveProperty('opening_deaths');
  });

  it('filters atomic evidence to one canonical actor-to-target matrix cell', () => {
    const result = buildOpeningDuelWorkspace(workspace, {
      playerId: 'fallen-id',
      targetId: 'niko-id',
      round: null,
      outcome: 'all',
    });

    expect(result.evidence.map((item) => item.source_id)).toEqual(['opening-r1']);
    expect(result.evidence[0]).toMatchObject({
      actor_id: 'fallen-id',
      target_id: 'niko-id',
    });
  });

  it('fails closed when a matrix target does not form a canonical actor-to-target pair', () => {
    const missingActor = buildOpeningDuelWorkspace(workspace, {
      playerId: null,
      targetId: 'niko-id',
      round: null,
      outcome: 'all',
    });
    expect(missingActor.evidence).toEqual([]);
    expect(missingActor.availability).toEqual({
      state: 'unavailable',
      reason: 'Select a verified actor before filtering an opening matchup.',
    });

    const invalidTarget = buildOpeningDuelWorkspace(workspace, {
      playerId: 'fallen-id',
      targetId: 'missing-player',
      round: null,
      outcome: 'all',
    });
    expect(invalidTarget.evidence).toEqual([]);
    expect(invalidTarget.availability).toEqual({
      state: 'unavailable',
      reason: 'Select a verified target or clear the matchup filter.',
    });

    const selfTarget = buildOpeningDuelWorkspace(workspace, {
      playerId: 'fallen-id',
      targetId: 'fallen-id',
      round: null,
      outcome: 'all',
    });
    expect(selfTarget.evidence).toEqual([]);
    expect(selfTarget.availability).toEqual({
      state: 'unavailable',
      reason: 'Opening matchup actor and target must be different players.',
    });
  });

  it('marks an unidentifiable first kill unavailable and never promotes a later kill', () => {
    const incomplete: AnalysisWorkspace = {
      ...workspace,
      rounds: [
        {
          ...workspace.rounds[0]!,
          events: [
            event({ id: 'missing-actor', tick: 1_050, actor: null }),
            event({ id: 'later-valid', tick: 1_100 }),
          ],
        },
        { ...workspace.rounds[1]!, events: [] },
        {
          ...workspace.rounds[1]!,
          number: 3,
          start_tick: 5_000,
          end_tick: 6_000,
          events: [event({ id: 'outside-round', tick: 4_999 })],
        },
      ],
    };

    const result = buildOpeningDuelWorkspace(incomplete, {
      playerId: null,
      round: null,
      outcome: 'all',
    });

    expect(result.evidence).toEqual([]);
    expect(result.round_assessments.map((assessment) => [assessment.round, assessment.reason_code])).toEqual([
      [1, 'missing_actor'],
      [2, 'no_kill_event'],
      [3, 'outside_round_bounds'],
    ]);
    expect(result.unavailable_rounds).toEqual({
      count: 3,
      reasons: [
        { code: 'missing_actor', count: 1 },
        { code: 'no_kill_event', count: 1 },
        { code: 'outside_round_bounds', count: 1 },
      ],
    });
    expect(result.round_assessments.some((assessment) => assessment.source_id === 'later-valid')).toBe(false);
    expect(result.availability).toMatchObject({
      state: 'unavailable',
      reason: expect.stringContaining('3 of 3 rounds'),
    });
  });

  it('requires current canonical player ids and rejects display-name identity tokens', () => {
    const nameTokenWorkspace: AnalysisWorkspace = {
      ...workspace,
      rounds: [{
        ...workspace.rounds[0]!,
        events: [event({ id: 'name-token-opening', actor: 'FalleN', target: 'NiKo' })],
      }],
    };

    const result = buildOpeningDuelWorkspace(nameTokenWorkspace, {
      playerId: null,
      round: null,
      outcome: 'all',
    });

    expect(result.evidence).toEqual([]);
    expect(result.round_assessments[0]).toMatchObject({
      source_id: 'name-token-opening',
      reason_code: 'unknown_actor',
    });
  });

  it('filters atomic evidence by player, round, and opening outcome without deriving success rates', () => {
    const openingKills = buildOpeningDuelWorkspace(workspace, {
      playerId: 'fallen-id',
      round: 1,
      outcome: 'opening_kill',
    });
    expect(openingKills.evidence.map((item) => item.source_id)).toEqual(['opening-r1']);

    const openingDeaths = buildOpeningDuelWorkspace(workspace, {
      playerId: 'fallen-id',
      round: null,
      outcome: 'opening_death',
    });
    expect(openingDeaths.evidence.map((item) => item.source_id)).toEqual(['opening-r2']);
    expect(openingDeaths).not.toHaveProperty('success_rate');

    const invalidPlayer = buildOpeningDuelWorkspace(workspace, {
      playerId: 'missing-player',
      round: null,
      outcome: 'all',
    });
    expect(invalidPlayer.evidence).toEqual([]);
    expect(invalidPlayer.availability).toEqual({
      state: 'unavailable',
      reason: 'Select a verified player or clear the player filter.',
    });
  });
});
