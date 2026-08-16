import { describe, expect, it } from 'vitest';

import type { TimelineEvent } from '../../shared/desktop/dto';
import type { AnalysisWorkspace } from '../../shared/desktop/viewModels';
import { buildPlayerMatchEvidence } from './playerMatchEvidence';

const event = (overrides: Partial<TimelineEvent>): TimelineEvent => ({
  id: 'player_death-100-1',
  tick: 100,
  seconds: 1.5625,
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

const workspace = (roundEvents: TimelineEvent[]): AnalysisWorkspace => ({
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
    number: 5,
    winner: 'A',
    reason: 'elimination',
    start_tick: 20_000,
    end_tick: 30_000,
    team_a_score: 2,
    team_b_score: 3,
    events: roundEvents,
  }],
  highlights: [],
});

describe('player match evidence', () => {
  it('returns stable, tick-sorted kill and death evidence for the selected player', () => {
    const result = buildPlayerMatchEvidence(workspace([
      event({ id: 'kill-late', tick: 29_900, seconds: 467.1875, actor: 'FalleN', target: 'niko-id', weapon: 'awp' }),
      event({ id: 'death', tick: 29_700, seconds: 464.0625, actor: 'niko-id', target: 'fallen-id', weapon: 'm4a1', headshot: true }),
      event({ id: 'kill-early', tick: 29_723, seconds: 464.421875, actor: 'fallen-id', target: 'NiKo', headshot: true, penetrated: true, position: [10, 20, 30] }),
    ]), 'fallen-id');

    expect(result?.kills.map((kill) => ({
      evidence_id: kill.evidence_id,
      round: kill.round,
      tick: kill.tick,
      actor_id: kill.actor_id,
      actor_name: kill.actor_name,
      target_id: kill.target_id,
      target_name: kill.target_name,
      weapon: kill.weapon,
      headshot: kill.headshot,
      penetrated: kill.penetrated,
      position: kill.position,
    }))).toEqual([
      {
        evidence_id: 'demo:major-final-map-1/event:kill-early',
        round: 5,
        tick: 29_723,
        actor_id: 'fallen-id',
        actor_name: 'FalleN',
        target_id: 'niko-id',
        target_name: 'NiKo',
        weapon: 'ak47',
        headshot: true,
        penetrated: true,
        position: [10, 20, 30],
      },
      {
        evidence_id: 'demo:major-final-map-1/event:kill-late',
        round: 5,
        tick: 29_900,
        actor_id: 'fallen-id',
        actor_name: 'FalleN',
        target_id: 'niko-id',
        target_name: 'NiKo',
        weapon: 'awp',
        headshot: false,
        penetrated: false,
        position: null,
      },
    ]);
    expect(result?.deaths.map((death) => [death.evidence_id, death.tick]))
      .toEqual([['demo:major-final-map-1/event:death', 29_700]]);
    expect(result?.player).toEqual({
      id: 'fallen-id',
      name: 'FalleN',
      team: 'A',
      kills: 2,
      deaths: 1,
      assists: 0,
      headshot_rate: 0.5,
      adr: 78,
    });
    expect(result?.player).not.toHaveProperty('rating');
  });

  it('aggregates only evidenced weapon kills, headshots, damage, and damage-event counts', () => {
    const result = buildPlayerMatchEvidence(workspace([
      event({ id: 'ak-kill', tick: 200, weapon: 'weapon_AK47', headshot: true }),
      event({ id: 'awp-kill', tick: 300, weapon: 'awp' }),
      event({ id: 'ak-hurt-1', tick: 120, kind: 'damage', weapon: 'ak47', detail: { dmg_health: 27 } }),
      event({ id: 'ak-hurt-2', tick: 130, kind: 'damage', weapon: 'AK47', detail: { damage: 73 } }),
      event({ id: 'awp-hurt', tick: 250, kind: 'damage', weapon: 'weapon_awp', detail: { dmg_health: 111 } }),
    ]), 'fallen-id');

    expect(result?.weapons).toEqual([
      {
        id: 'demo:major-final-map-1/player:fallen-id/weapon:ak47',
        name: 'ak47',
        kills: 1,
        headshots: 1,
        damage: 100,
        damage_events: 2,
        evidence_ids: [
          'demo:major-final-map-1/event:ak-hurt-1',
          'demo:major-final-map-1/event:ak-hurt-2',
          'demo:major-final-map-1/event:ak-kill',
        ],
      },
      {
        id: 'demo:major-final-map-1/player:fallen-id/weapon:awp',
        name: 'awp',
        kills: 1,
        headshots: 0,
        damage: 111,
        damage_events: 1,
        evidence_ids: [
          'demo:major-final-map-1/event:awp-hurt',
          'demo:major-final-map-1/event:awp-kill',
        ],
      },
    ]);
    expect(result?.weapons[0]).not.toHaveProperty('shots');
    expect(result?.weapons[0]).not.toHaveProperty('accuracy');
  });

  it('keeps directional opponent duels and tick-sorted atomic engagements while filtering teammates', () => {
    const base = workspace([
      event({ id: 'kill-opponent', tick: 300, actor: 'fallen-id', target: 'niko-id' }),
      event({ id: 'death-opponent', tick: 200, actor: 'niko-id', target: 'fallen-id', weapon: 'm4a1' }),
      event({ id: 'damage-dealt', tick: 100, kind: 'damage', actor: 'fallen-id', target: 'niko-id', detail: { dmg_health: 34 } }),
      event({ id: 'damage-taken', tick: 150, kind: 'damage', actor: 'niko-id', target: 'fallen-id', weapon: 'm4a1', detail: { dmg_health: 50 } }),
      event({ id: 'team-kill', tick: 175, actor: 'fallen-id', target: 'ally-id' }),
    ]);
    const result = buildPlayerMatchEvidence({
      ...base,
      players: [
        ...base.players,
        { id: 'ally-id', name: 'yuurih', team: 'A', kills: 0, deaths: 1, assists: 0, headshot_rate: 0, kill_death_ratio: 0, adr: 0 },
      ],
      insights: {
        round_economy: [],
        player_utility: [],
        matchups: [
          { player_id: 'fallen-id', opponent_id: 'niko-id', kills: 1, deaths: 1, headshot_kills: 0, damage_dealt: 34, damage_taken: 50, damage_events: 1 },
          { player_id: 'fallen-id', opponent_id: 'ally-id', kills: 1, deaths: 0, headshot_kills: 0, damage_dealt: 0, damage_taken: 0, damage_events: 0 },
        ],
        availability: {
          purchase_events: { available: false, reason: 'not requested' },
          purchase_spend: { available: false, reason: 'not requested' },
          utility_events: { available: false, reason: 'not requested' },
          utility_damage: { available: false, reason: 'not requested' },
          flash_effects: { available: false, reason: 'not decoded' },
          matchups: { available: true, reason: null },
        },
      },
    }, 'fallen-id');

    expect(result?.duels).toHaveLength(1);
    expect(result?.duels[0]).toMatchObject({
      id: 'demo:major-final-map-1/player:fallen-id/duel:niko-id',
      opponent_id: 'niko-id',
      opponent_name: 'NiKo',
      opponent_team: 'B',
      kills: 1,
      deaths: 1,
      headshot_kills: 0,
      damage_dealt: 34,
      damage_taken: 50,
      damage_events: 1,
      summary_source: 'insights',
    });
    expect(result?.duels[0]?.engagements.map((item) => [item.perspective, item.tick]))
      .toEqual([
        ['damage_dealt', 100],
        ['damage_taken', 150],
        ['death', 200],
        ['kill', 300],
      ]);
  });

  it('preserves capability-backed utility aggregates, atomic events, and unavailable reasons', () => {
    const base = workspace([
      event({ id: 'flashbang_detonate-450-4', tick: 450, kind: 'grenade', target: null, weapon: null }),
      event({ id: 'grenade_thrown-400-2', tick: 400, kind: 'grenade', target: null, weapon: 'weapon_flashbang' }),
      event({ id: 'utility-hurt', tick: 430, kind: 'damage', target: 'niko-id', weapon: 'hegrenade', detail: { dmg_health: 41 } }),
      event({ id: 'other-throw', tick: 390, kind: 'grenade', actor: 'niko-id', target: null, weapon: 'smokegrenade' }),
    ]);
    const result = buildPlayerMatchEvidence({
      ...base,
      insights: {
        round_economy: [],
        matchups: [],
        player_utility: [{
          player_id: 'fallen-id',
          throws: 5,
          detonations: 4,
          items: [{ name: 'smokegrenade', count: 2 }, { name: 'flashbang', count: 3 }],
          damage: 41,
          damage_events: 1,
          flash_events: 0,
          players_flashed: 0,
          flash_duration_seconds: null,
        }],
        availability: {
          purchase_events: { available: false, reason: 'not requested' },
          purchase_spend: { available: false, reason: 'not requested' },
          utility_events: { available: true, reason: null },
          utility_damage: { available: true, reason: null },
          flash_effects: { available: false, reason: 'no player_blind events were decoded' },
          matchups: { available: false, reason: 'not requested' },
        },
      },
    }, 'fallen-id');

    expect(result?.utility.summary).toEqual({
      id: 'demo:major-final-map-1/player:fallen-id/utility',
      throws: 5,
      detonations: 4,
      items: [{ name: 'flashbang', count: 3 }, { name: 'smokegrenade', count: 2 }],
      damage: 41,
      damage_events: 1,
      flash_events: 0,
      players_flashed: 0,
      flash_duration_seconds: null,
    });
    expect(result?.utility.events.map((item) => [item.phase, item.utility_name, item.tick, item.damage]))
      .toEqual([
        ['throw', 'flashbang', 400, null],
        ['damage', 'hegrenade', 430, 41],
        ['detonation', 'flashbang', 450, null],
      ]);
    expect(result?.availability.utility_events).toEqual({
      state: 'available',
      reason: null,
    });
    expect(result?.availability.flash_effects).toEqual({
      state: 'unavailable',
      reason: 'no player_blind events were decoded',
    });
    expect(Object.values(result!.availability).every(
      (availability) => ['available', 'partial', 'unavailable'].includes(availability.state)
        && (availability.reason === null || typeof availability.reason === 'string'),
    )).toBe(true);
  });

  it('keeps direct objective actions and marks an actorless explosion only as related to the player plant', () => {
    const base = workspace([]);
    const roundFixture = base.rounds[0]!;
    const result = buildPlayerMatchEvidence({
      ...base,
      rounds: [
        {
          ...roundFixture,
          number: 9,
          start_tick: 59_000,
          end_tick: 62_000,
          events: [
            event({ id: 'plant-selected', tick: 60_114, kind: 'bomb_plant', actor: 'fallen-id', target: null, weapon: null }),
            event({ id: 'explode-actorless', tick: 61_000, kind: 'bomb_explode', actor: null, target: null, weapon: null }),
          ],
        },
        {
          ...roundFixture,
          number: 10,
          start_tick: 62_001,
          end_tick: 70_000,
          events: [event({ id: 'defuse-selected', tick: 67_000, kind: 'bomb_defuse', actor: 'FalleN', target: null, weapon: null })],
        },
        {
          ...roundFixture,
          number: 11,
          start_tick: 70_001,
          end_tick: 81_000,
          events: [
            event({ id: 'plant-other', tick: 77_000, kind: 'bomb_plant', actor: 'niko-id', target: null, weapon: null }),
            event({ id: 'explode-other', tick: 80_000, kind: 'bomb_explode', actor: null, target: null, weapon: null }),
          ],
        },
      ],
    }, 'fallen-id');

    expect(result?.objectives.map((item) => ({
      evidence_id: item.evidence_id,
      objective: item.objective,
      attribution: item.attribution,
      round: item.round,
      tick: item.tick,
    }))).toEqual([
      {
        evidence_id: 'demo:major-final-map-1/event:plant-selected',
        objective: 'plant',
        attribution: 'actor',
        round: 9,
        tick: 60_114,
      },
      {
        evidence_id: 'demo:major-final-map-1/event:explode-actorless',
        objective: 'explode',
        attribution: 'related_to_player_plant',
        round: 9,
        tick: 61_000,
      },
      {
        evidence_id: 'demo:major-final-map-1/event:defuse-selected',
        objective: 'defuse',
        attribution: 'actor',
        round: 10,
        tick: 67_000,
      },
    ]);
    expect(result?.availability.objectives.state).toBe('available');
  });

  it('separates parsed highlights from timeline and failure review candidates', () => {
    const base = workspace([]);
    const result = buildPlayerMatchEvidence({
      ...base,
      highlights: [
        {
          id: 'timeline-late', label: 'Kill reel', category: 'utility', kind: 'timeline',
          description: 'Chronological collection', tags: ['timeline'], victims: ['niko-id'],
          player_id: 'fallen-id', round: 20, start_tick: 161_000, end_tick: 161_200, confidence: 0.5,
        },
        {
          id: 'one-tap', label: 'One-tap', category: 'entry', kind: 'one_tap',
          description: 'Decoded one-tap', tags: ['headshot'], victims: ['niko-id'],
          player_id: 'FalleN', round: 5, start_tick: 29_600, end_tick: 29_800, confidence: 0.88,
        },
        {
          id: 'failure', label: 'Death reel', category: 'entry', kind: 'fail',
          description: 'Review candidate', tags: ['failure'], victims: [],
          player_id: 'fallen-id', round: 1, start_tick: 3_200, end_tick: 3_500, confidence: 0.5,
        },
        {
          id: 'other-player', label: 'Other', category: 'entry', kind: 'one_tap',
          description: 'Not selected', tags: [], victims: ['fallen-id'],
          player_id: 'niko-id', round: 2, start_tick: 9_000, end_tick: 9_200, confidence: 0.88,
        },
      ],
    }, 'fallen-id');

    expect(result?.highlights.map((item) => ({
      evidence_id: item.evidence_id,
      kind: item.kind,
      quality: item.quality,
      tick: item.tick,
      end_tick: item.end_tick,
    }))).toEqual([
      {
        evidence_id: 'demo:major-final-map-1/highlight:failure',
        kind: 'fail',
        quality: 'review_candidate',
        tick: 3_200,
        end_tick: 3_500,
      },
      {
        evidence_id: 'demo:major-final-map-1/highlight:one-tap',
        kind: 'one_tap',
        quality: 'parsed_highlight',
        tick: 29_600,
        end_tick: 29_800,
      },
      {
        evidence_id: 'demo:major-final-map-1/highlight:timeline-late',
        kind: 'timeline',
        quality: 'review_candidate',
        tick: 161_000,
        end_tick: 161_200,
      },
    ]);
    expect(result?.availability.highlights.state).toBe('available');
  });

  it('reports incomplete evidence explicitly and returns null for an unknown player', () => {
    const result = buildPlayerMatchEvidence(workspace([
      event({ id: 'only-decoded-kill', tick: 29_723 }),
    ]), 'fallen-id');

    expect(result?.availability.kills).toMatchObject({
      state: 'partial',
      reason: 'Decoded 1 of 2 scoreboard kills.',
    });
    expect(result?.availability.deaths).toMatchObject({
      state: 'unavailable',
      reason: 'Decoded 0 of 1 scoreboard deaths.',
    });
    expect(result?.availability.weapons.state).toBe('partial');
    expect(result?.availability.duels.state).toBe('partial');
    expect(result?.availability.utility_events.state).toBe('unavailable');
    expect(result).not.toHaveProperty('shots');
    expect(result).not.toHaveProperty('accuracy');
    expect(result).not.toHaveProperty('kast');
    expect(result).not.toHaveProperty('rating_2');
    expect(buildPlayerMatchEvidence(workspace([]), 'missing-player')).toBeNull();
  });
});
