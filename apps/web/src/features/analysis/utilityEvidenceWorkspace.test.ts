import { describe, expect, it } from 'vitest';

import type { AnalysisWorkspace, TimelineEvent } from '../../shared/desktop/dto';
import { buildUtilityEvidenceWorkspace } from './utilityEvidenceWorkspace';

const event = (overrides: Partial<TimelineEvent>): TimelineEvent => ({
  id: 'grenade_thrown-100-1',
  tick: 100,
  seconds: 1.5625,
  kind: 'grenade',
  actor: 'alice-id',
  target: null,
  weapon: 'weapon_smokegrenade',
  headshot: false,
  penetrated: false,
  position: [10, 20, 30],
  detail: {},
  ...overrides,
});

const workspace: AnalysisWorkspace = {
  demo_id: 'major-final-map-1',
  map_name: 'de_mirage',
  tick_rate: 64,
  duration_seconds: 2_900,
  teams: [],
  players: [
    { id: 'alice-id', name: 'Alice', team: 'A', kills: 1, deaths: 0, assists: 0, headshot_rate: 1, kill_death_ratio: 1, adr: 82 },
    { id: 'bob-id', name: 'Bob', team: 'B', kills: 0, deaths: 1, assists: 0, headshot_rate: 0, kill_death_ratio: 0, adr: 40 },
  ],
  rounds: [
    {
      number: 20,
      winner: 'A',
      reason: 'elimination',
      start_tick: 100,
      end_tick: 200,
      team_a_score: 12,
      team_b_score: 8,
      events: [
        event({ id: 'grenade_thrown-100-1' }),
        event({ id: 'smokegrenade_detonate-110-2', tick: 110, weapon: null }),
        event({ id: 'player_blind-120-3', tick: 120, target: 'bob-id', weapon: null, detail: { blind_duration: 2.25 } }),
        event({ id: 'player_blind-125-4', tick: 125, target: 'bob-id', weapon: null, detail: {} }),
        event({ id: 'player_hurt-130-5', tick: 130, kind: 'damage', target: 'bob-id', weapon: 'hegrenade', detail: { dmg_health: 41 } }),
        event({ id: 'player_hurt-135-6', tick: 135, kind: 'damage', target: 'bob-id', weapon: 'inferno', detail: {} }),
        event({ id: 'kill-noise', tick: 140, kind: 'kill', target: 'bob-id', weapon: 'ak47' }),
      ],
    },
    {
      number: 21,
      winner: 'B',
      reason: 'elimination',
      start_tick: 201,
      end_tick: 300,
      team_a_score: 12,
      team_b_score: 9,
      events: [
        event({ id: 'flashbang_detonate-220-1', tick: 220, actor: 'bob-id', weapon: null }),
      ],
    },
  ],
  highlights: [],
  insights: {
    round_economy: [],
    player_utility: [],
    matchups: [],
    availability: {
      purchase_events: { available: false, reason: 'not requested' },
      purchase_spend: { available: false, reason: 'not requested' },
      utility_events: { available: true, reason: null },
      utility_damage: { available: true, reason: null },
      flash_effects: { available: true, reason: null },
      matchups: { available: false, reason: 'not requested' },
    },
  },
};

describe('utility evidence workspace', () => {
  it('builds canonical atomic evidence from utility timeline events without inventing throws or hits', () => {
    const result = buildUtilityEvidenceWorkspace(workspace, {
      playerId: null,
      round: null,
      utilityType: null,
    });

    expect(result.evidence).toHaveLength(7);
    expect(result.evidence.map((item) => ({
      evidence_id: item.evidence_id,
      event_kind: item.event_kind,
      phase: item.phase,
      utility_type: item.utility_type,
      damage: item.damage,
      blind_duration_seconds: item.blind_duration_seconds,
    }))).toEqual([
      { evidence_id: 'demo:major-final-map-1/event:grenade_thrown-100-1', event_kind: 'grenade', phase: 'throw_event', utility_type: 'smoke', damage: null, blind_duration_seconds: null },
      { evidence_id: 'demo:major-final-map-1/event:smokegrenade_detonate-110-2', event_kind: 'grenade', phase: 'activation_event', utility_type: 'smoke', damage: null, blind_duration_seconds: null },
      { evidence_id: 'demo:major-final-map-1/event:player_blind-120-3', event_kind: 'flash', phase: 'blind_event', utility_type: 'flash', damage: null, blind_duration_seconds: 2.25 },
      { evidence_id: 'demo:major-final-map-1/event:player_blind-125-4', event_kind: 'flash', phase: 'blind_event', utility_type: 'flash', damage: null, blind_duration_seconds: null },
      { evidence_id: 'demo:major-final-map-1/event:player_hurt-130-5', event_kind: 'damage', phase: 'damage_event', utility_type: 'he', damage: 41, blind_duration_seconds: null },
      { evidence_id: 'demo:major-final-map-1/event:player_hurt-135-6', event_kind: 'damage', phase: 'damage_event', utility_type: 'fire', damage: null, blind_duration_seconds: null },
      { evidence_id: 'demo:major-final-map-1/event:flashbang_detonate-220-1', event_kind: 'grenade', phase: 'activation_event', utility_type: 'flash', damage: null, blind_duration_seconds: null },
    ]);
    expect(result.decoded_event_count).toBe(7);
    expect(result).not.toHaveProperty('throws');
    expect(result).not.toHaveProperty('hits');
  });

  it('withholds aggregate damage and blind duration when any matching atomic value is missing', () => {
    const result = buildUtilityEvidenceWorkspace(workspace, {
      playerId: 'alice-id',
      round: 20,
      utilityType: null,
    });

    expect(result.metrics.damage).toEqual({
      value: null,
      event_count: 2,
      availability: {
        state: 'partial',
        reason: '1 of 2 matching utility damage events has no numeric damage amount.',
      },
    });
    expect(result.metrics.blind_duration).toEqual({
      value: null,
      event_count: 2,
      availability: {
        state: 'partial',
        reason: '1 of 2 matching blind events has no numeric duration.',
      },
    });
  });

  it('applies player, round, and utility-type filters to the real event set', () => {
    const result = buildUtilityEvidenceWorkspace(workspace, {
      playerId: 'alice-id',
      round: 20,
      utilityType: 'he',
    });

    expect(result.evidence.map((item) => item.source_id)).toEqual(['player_hurt-130-5']);
    expect(result.decoded_event_count).toBe(1);
    expect(result.metrics.damage).toEqual({
      value: 41,
      event_count: 1,
      availability: { state: 'available', reason: null },
    });
    expect(result.metrics.blind_duration.value).toBeNull();
    expect(result.metrics.blind_duration.availability.state).toBe('unavailable');
  });

  it('does not present a globally available capability as matching filtered evidence', () => {
    const result = buildUtilityEvidenceWorkspace(workspace, {
      playerId: 'bob-id',
      round: 20,
      utilityType: 'smoke',
    });

    expect(result.evidence).toEqual([]);
    expect(result.availability.events).toEqual({
      state: 'unavailable',
      reason: 'No utility timeline events match these filters.',
    });
  });

  it('uses capability reasons and marks present evidence partial when metadata does not prove the aggregate', () => {
    const { insights: _insights, ...withoutCapabilities } = workspace;
    const result = buildUtilityEvidenceWorkspace(withoutCapabilities, {
      playerId: 'alice-id',
      round: 20,
      utilityType: 'he',
    });

    expect(result.availability.events).toEqual({
      state: 'partial',
      reason: 'Utility event capability metadata is not present in this analysis.',
    });
    expect(result.metrics.damage).toEqual({
      value: null,
      event_count: 1,
      availability: {
        state: 'partial',
        reason: 'Utility damage capability metadata is not present in this analysis.',
      },
    });
    expect(result.metrics.blind_duration.availability).toEqual({
      state: 'unavailable',
      reason: 'Flash-effect capability metadata is not present in this analysis.',
    });
  });
});
