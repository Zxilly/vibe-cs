import { describe, expect, it } from 'vitest';

import type { TimelineEvent } from '../../shared/desktop/dto';
import type { AnalysisWorkspace } from '../../shared/desktop/viewModels';
import { buildDuelEvidenceWorkspace } from './duelEvidenceWorkspace';

const event = (overrides: Partial<TimelineEvent>): TimelineEvent => ({
  id: 'event-1',
  tick: 100,
  seconds: 1,
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
    { id: 'fallen-id', name: 'FalleN', team: 'A', kills: 5, deaths: 5, assists: 1, headshot_rate: 0.4, kill_death_ratio: 1, adr: 78 },
    { id: 'niko-id', name: 'NiKo', team: 'B', kills: 3, deaths: 4, assists: 2, headshot_rate: 0.5, kill_death_ratio: 0.75, adr: 90 },
    { id: 'monesy-id', name: 'm0NESY', team: 'B', kills: 2, deaths: 1, assists: 0, headshot_rate: 0.5, kill_death_ratio: 2, adr: 84 },
  ],
  rounds: [
    {
      number: 19,
      winner: 'A',
      reason: 'elimination',
      start_tick: 150_000,
      end_tick: 155_000,
      team_a_score: 11,
      team_b_score: 8,
      events: [
        event({ id: 'kill-r19', tick: 151_100 }),
      ],
    },
    {
      number: 20,
      winner: 'B',
      reason: 'elimination',
      start_tick: 160_000,
      end_tick: 165_000,
      team_a_score: 11,
      team_b_score: 9,
      events: [
        event({
          id: 'damage-r20',
          tick: 161_000,
          kind: 'damage',
          detail: { dmg_health: 64 },
        }),
        event({
          id: 'death-r20',
          tick: 161_114,
          actor: 'niko-id',
          target: 'fallen-id',
          weapon: 'awp',
        }),
        event({
          id: 'teammate-damage-r20',
          tick: 161_200,
          kind: 'damage',
          actor: 'niko-id',
          target: 'monesy-id',
          detail: { dmg_health: 25 },
        }),
      ],
    },
  ],
  highlights: [],
  insights: {
    round_economy: [],
    player_utility: [],
    matchups: [
      {
        player_id: 'fallen-id',
        opponent_id: 'niko-id',
        kills: 4,
        deaths: 3,
        headshot_kills: 2,
        damage_dealt: 311,
        damage_taken: 288,
        damage_events: 8,
      },
      {
        player_id: 'fallen-id',
        opponent_id: 'monesy-id',
        kills: 1,
        deaths: 2,
        headshot_kills: 0,
        damage_dealt: 120,
        damage_taken: 191,
        damage_events: 3,
      },
    ],
    availability: {
      purchase_events: { available: false, reason: 'Not decoded.' },
      purchase_spend: { available: false, reason: 'Not decoded.' },
      utility_events: { available: false, reason: 'Not decoded.' },
      utility_damage: { available: false, reason: 'Not decoded.' },
      flash_effects: { available: false, reason: 'Not decoded.' },
      matchups: { available: true, reason: null },
    },
  },
};

describe('duel evidence workspace', () => {
  it('keeps whole-match matchup aggregates separate from round-filtered atomic engagements', () => {
    const result = buildDuelEvidenceWorkspace(workspace, {
      playerId: 'fallen-id',
      opponentId: 'niko-id',
      round: 20,
    });

    expect(result.matchups).toMatchObject([{
      player_id: 'fallen-id',
      opponent_id: 'niko-id',
      kills: 4,
      deaths: 3,
      damage_dealt: 311,
      damage_taken: 288,
      summary_source: 'insights',
      aggregate_scope: 'match',
    }]);
    expect(result.evidence.map((item) => [item.round, item.perspective, item.evidence_id])).toEqual([
      [20, 'damage_dealt', 'demo:major-final-map-1/event:damage-r20'],
      [20, 'death', 'demo:major-final-map-1/event:death-r20'],
    ]);
  });

  it('changes the directional perspective with the player filter and summarizes only observed enemy events', () => {
    const result = buildDuelEvidenceWorkspace(workspace, {
      playerId: 'niko-id',
      opponentId: 'fallen-id',
      round: null,
    });

    expect(result.evidence.map((item) => item.perspective)).toEqual([
      'death',
      'damage_taken',
      'kill',
    ]);
    expect(result.evidence.some((item) => item.source_id === 'teammate-damage-r20')).toBe(false);
    expect(result.atomic_summary).toEqual({
      engagement_count: 3,
      kill_events: 1,
      death_events: 1,
      damage_dealt_events: 0,
      damage_taken_events: 1,
      verified_damage_dealt: null,
      verified_damage_taken: 64,
      damage_availability: { state: 'available', reason: null },
    });
  });

  it('exposes partial and unavailable reasons instead of inferring missing damage', () => {
    const missingDamageWorkspace: AnalysisWorkspace = {
      ...workspace,
      insights: {
        ...workspace.insights!,
        availability: {
          ...workspace.insights!.availability,
          matchups: { available: false, reason: 'Aggregate matchups were not decoded.' },
        },
        matchups: [],
      },
      rounds: [{
        ...workspace.rounds[0]!,
        events: [event({
          id: 'damage-without-amount',
          kind: 'damage',
          actor: 'fallen-id',
          target: 'niko-id',
          detail: {},
        })],
      }],
    };

    const result = buildDuelEvidenceWorkspace(missingDamageWorkspace, {
      playerId: 'fallen-id',
      opponentId: null,
      round: null,
    });

    expect(result.availability).toMatchObject({
      state: 'partial',
      reason: 'Aggregate matchups were not decoded.',
    });
    expect(result.matchups[0]).toMatchObject({
      summary_source: 'events',
      damage_dealt: null,
      damage_taken: 0,
    });
    expect(result.atomic_summary.damage_availability).toMatchObject({
      state: 'partial',
      reason: expect.stringContaining('no numeric amount'),
    });
    expect(result.atomic_summary.verified_damage_dealt).toBe(0);

    const unavailable = buildDuelEvidenceWorkspace(workspace, {
      playerId: null,
      opponentId: null,
      round: null,
    }).availability;
    expect(unavailable).toMatchObject({
      state: 'unavailable',
      reason: 'Select a verified player to inspect directional matchups.',
    });
  });
});
