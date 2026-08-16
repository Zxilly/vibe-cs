import { describe, expect, it } from 'vitest';

import type { TimelineEvent } from '../../shared/desktop/dto';
import type { AnalysisWorkspace } from '../../shared/desktop/viewModels';
import { buildOverviewEvidence } from './analysisOverview';

const event = (overrides: Partial<TimelineEvent>): TimelineEvent => ({
  id: 'event',
  tick: 64,
  seconds: 1,
  kind: 'kill',
  actor: 'fallen',
  target: 'niko',
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
    { id: 'fallen', name: 'FalleN', team: 'A', kills: 3, deaths: 1, assists: 1, headshot_rate: 2 / 3, kill_death_ratio: 3, adr: 90 },
    { id: 'niko', name: 'NiKo', team: 'B', kills: 1, deaths: 3, assists: 0, headshot_rate: 0, kill_death_ratio: 1 / 3, adr: 60 },
  ],
  rounds: [
    {
      number: 1,
      winner: 'A',
      reason: 'elimination',
      start_tick: 0,
      end_tick: 6_400,
      team_a_score: 1,
      team_b_score: 0,
      events: [
        event({ id: 'kill-ak-1', weapon: 'ak47', headshot: true }),
        event({ id: 'kill-awp', tick: 96, weapon: 'awp' }),
        event({ id: 'plant', tick: 120, kind: 'bomb_plant', target: null, weapon: null }),
      ],
    },
    {
      number: 2,
      winner: 'B',
      reason: 'defuse',
      start_tick: 6_401,
      end_tick: 12_800,
      team_a_score: 1,
      team_b_score: 1,
      events: [
        event({ id: 'kill-ak-2', tick: 6_500, weapon: 'ak47', headshot: true }),
        event({ id: 'death', tick: 6_600, actor: 'niko', target: 'fallen', weapon: 'm4a1' }),
        event({ id: 'defuse', tick: 6_700, kind: 'bomb_defuse', actor: 'niko', target: null, weapon: null }),
      ],
    },
  ],
  highlights: [],
  insights: {
    round_economy: [
      {
        round: 1,
        teams: [
          { team: 'A', purchase_count: 3, items: [{ name: 'ak47', count: 1 }], spend: 5_200 },
          { team: 'T', purchase_count: 3, items: [{ name: 'ak47', count: 1 }], spend: 5_200 },
        ],
        unattributed_purchase_count: 0,
      },
      {
        round: 2,
        teams: [
          { team: 'B', purchase_count: 2, items: [{ name: 'm4a1', count: 1 }], spend: 4_400 },
          { team: 'CT', purchase_count: 2, items: [{ name: 'm4a1', count: 1 }], spend: 4_400 },
        ],
        unattributed_purchase_count: 1,
      },
    ],
    player_utility: [{
      player_id: 'fallen',
      throws: 5,
      detonations: 4,
      items: [{ name: 'flashbang', count: 3 }, { name: 'smokegrenade', count: 2 }],
      damage: 41,
      damage_events: 2,
      flash_events: 0,
      players_flashed: 0,
      flash_duration_seconds: null,
    }],
    matchups: [{
      player_id: 'fallen',
      opponent_id: 'niko',
      kills: 3,
      deaths: 1,
      headshot_kills: 2,
      damage_dealt: 372,
      damage_taken: 143,
      damage_events: 7,
    }],
    availability: {
      purchase_events: { available: true, reason: null },
      purchase_spend: { available: true, reason: null },
      utility_events: { available: true, reason: null },
      utility_damage: { available: true, reason: null },
      flash_effects: { available: false, reason: 'not decoded' },
      matchups: { available: true, reason: null },
    },
  },
};

describe('maximized analysis overview evidence', () => {
  it('derives weapon, duel, utility, objective, and economy summaries from stored evidence', () => {
    expect(buildOverviewEvidence(workspace, 'fallen')).toEqual({
      weapons: [
        { name: 'ak47', kills: 2, headshots: 2 },
        { name: 'awp', kills: 1, headshots: 0 },
      ],
      duel: {
        opponent_id: 'niko',
        opponent_name: 'NiKo',
        kills: 3,
        deaths: 1,
        headshot_kills: 2,
        damage_dealt: 372,
        damage_taken: 143,
      },
      utility: {
        available: true,
        throws: 5,
        detonations: 4,
        damage: 41,
        items: [{ name: 'flashbang', count: 3 }, { name: 'smokegrenade', count: 2 }],
      },
      objectives: { plants: 1, defuses: 0, explosions: 0 },
      economy: { available: true, purchases: 5, spend: 9_600, unattributed: 1 },
    });
  });

  it('returns explicit empty evidence instead of estimating missing metrics', () => {
    const { insights: _insights, ...workspaceWithoutInsights } = workspace;
    expect(buildOverviewEvidence({ ...workspaceWithoutInsights, rounds: [] }, 'missing')).toEqual({
      weapons: [],
      duel: null,
      utility: { available: false, throws: 0, detonations: 0, damage: 0, items: [] },
      objectives: { plants: 0, defuses: 0, explosions: 0 },
      economy: { available: false, purchases: 0, spend: null, unattributed: 0 },
    });
  });

  it('does not treat an empty side as missing purchase-price evidence', () => {
    const explicitEconomy = {
      ...workspace.insights!,
      round_economy: [{
        round: 1,
        teams: [
          { team: 'T', purchase_count: 1, items: [{ name: 'ak47', count: 1 }], spend: 2_700 },
          { team: 'CT', purchase_count: 0, items: [], spend: null },
        ],
        unattributed_purchase_count: 0,
      }],
    };

    expect(buildOverviewEvidence({ ...workspace, insights: explicitEconomy }, 'fallen').economy)
      .toMatchObject({ purchases: 1, spend: 2_700 });
  });
});
