import { describe, expect, it } from 'vitest';

import type { TimelineEvent } from '../../shared/desktop/dto';
import type { AnalysisWorkspace } from '../../shared/desktop/viewModels';
import { buildWeaponEvidenceWorkspace } from './weaponEvidenceWorkspace';

const timelineEvent = (overrides: Partial<TimelineEvent>): TimelineEvent => ({
  id: 'event-1',
  tick: 1_000,
  seconds: 15.625,
  kind: 'kill',
  actor: 'fallen-id',
  target: 'niko-id',
  weapon: 'weapon_ak47',
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
    { id: 'fallen-id', name: 'FalleN', team: 'A', kills: 2, deaths: 1, assists: 0, headshot_rate: 0.5, kill_death_ratio: 2, adr: 78 },
    { id: 'niko-id', name: 'NiKo', team: 'B', kills: 1, deaths: 2, assists: 0, headshot_rate: 1, kill_death_ratio: 0.5, adr: 90 },
  ],
  rounds: [{
    number: 20,
    winner: 'A',
    reason: 'elimination',
    start_tick: 160_000,
    end_tick: 162_000,
    team_a_score: 12,
    team_b_score: 8,
    events: [
      timelineEvent({ id: 'hurt-ak', kind: 'damage', tick: 161_100, detail: { dmg_health: 37 } }),
      timelineEvent({ id: 'kill-ak', tick: 161_114, headshot: true }),
      timelineEvent({ id: 'kill-awp', tick: 161_300, weapon: 'awp', target: 'teses-id' }),
    ],
  }],
  highlights: [],
};

describe('weapon evidence workspace', () => {
  it('derives truthful weapon summaries and atomic evidence without inventing hit counts', () => {
    const result = buildWeaponEvidenceWorkspace(workspace, { playerId: null, round: null });

    expect(result.weapons.map((weapon) => ({
      name: weapon.name,
      kills: weapon.kills,
      headshot_kills: weapon.headshot_kills,
      damage: weapon.damage,
      damage_events: weapon.damage_events,
      damage_availability: weapon.damage_availability,
      evidence_ids: weapon.evidence.map((item) => item.evidence_id),
    }))).toEqual([
      {
        name: 'ak47',
        kills: 1,
        headshot_kills: 1,
        damage: 37,
        damage_events: 1,
        damage_availability: { state: 'available', reason: null },
        evidence_ids: [
          'demo:major-final-map-1/event:hurt-ak',
          'demo:major-final-map-1/event:kill-ak',
        ],
      },
      {
        name: 'awp',
        kills: 1,
        headshot_kills: 0,
        damage: null,
        damage_events: 0,
        damage_availability: {
          state: 'unavailable',
          reason: 'No weapon-attributed damage events match this weapon.',
        },
        evidence_ids: ['demo:major-final-map-1/event:kill-awp'],
      },
    ]);
    expect(result.availability.hits).toEqual({
      state: 'unavailable',
      reason: 'Damage events do not prove individual bullet or pellet hits.',
    });
    expect(result).not.toHaveProperty('hits');
  });

  it('filters by stable player identity and round when events use a unique player name alias', () => {
    const result = buildWeaponEvidenceWorkspace({
      ...workspace,
      rounds: [
        {
          ...workspace.rounds[0]!,
          number: 19,
          events: [timelineEvent({ id: 'r19-ak', actor: 'FalleN', weapon: 'ak47' })],
        },
        {
          ...workspace.rounds[0]!,
          number: 20,
          events: [
            timelineEvent({ id: 'r20-ak', actor: 'FalleN', weapon: 'ak47' }),
            timelineEvent({ id: 'r20-awp-other', actor: 'niko-id', weapon: 'awp' }),
          ],
        },
      ],
    }, { playerId: 'fallen-id', round: 20 });

    expect(result.weapons.map((weapon) => weapon.name)).toEqual(['ak47']);
    expect(result.weapons[0]?.evidence.map((item) => ({
      evidence_id: item.evidence_id,
      actor_id: item.actor_id,
      actor_name: item.actor_name,
      round: item.round,
    }))).toEqual([{
      evidence_id: 'demo:major-final-map-1/event:r20-ak',
      actor_id: 'fallen-id',
      actor_name: 'FalleN',
      round: 20,
    }]);
  });

  it('marks damage totals partial when a matching player_hurt event has no numeric amount', () => {
    const result = buildWeaponEvidenceWorkspace({
      ...workspace,
      rounds: [{
        ...workspace.rounds[0]!,
        events: [
          timelineEvent({ id: 'hurt-known', kind: 'damage', detail: { dmg_health: 24 } }),
          timelineEvent({ id: 'hurt-unknown', kind: 'damage', tick: 1_001, detail: {} }),
        ],
      }],
    }, { playerId: 'fallen-id', round: null });

    expect(result.weapons[0]).toMatchObject({ damage: 24, damage_events: 2 });
    expect(result.availability.damage).toEqual({
      state: 'partial',
      reason: '1 matching damage event has no numeric damage amount; totals include verified amounts only.',
    });
  });
});
