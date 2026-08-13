import { describe, expect, it } from 'vitest';

import type { AnalysisWorkspace, TimelineEvent } from '../../shared/desktop/dto';
import { buildRoundContext } from './roundContextModel';

const FALLEN = '76561197960690195';
const KSCERATO = '76561198058500492';
const KARRIGAN = '76561197989430253';
const TESES = '76561197996678278';
const NIKO = '76561198041683378';
const M0NESY = '76561198074762801';
const KYOUSUKE = '76561199032006224';

function combatEvent(
  id: string,
  tick: number,
  kind: 'damage' | 'kill',
  actor: string,
  target: string,
  weapon: string,
  damage: number,
): TimelineEvent {
  const ctPlayers = new Set([FALLEN, KSCERATO]);
  return {
    id,
    tick,
    seconds: tick / 64,
    kind,
    actor,
    target,
    weapon,
    headshot: false,
    penetrated: false,
    position: null,
    detail: {
      dmg_health: damage,
      attacker_team_num: ctPlayers.has(actor) ? 3 : 2,
      user_team_num: ctPlayers.has(target) ? 3 : 2,
    },
  };
}

// Production M1, de_mirage R20. The IDs/ticks/actors/targets are copied from the
// persisted Major analysis; only unrelated utility and purchase rows are omitted.
const realRound20Combat: TimelineEvent[] = [
  combatEvent('player_hurt-160757-2991', 160757, 'damage', KSCERATO, NIKO, 'ak47', 33),
  combatEvent('player_hurt-160764-2992', 160764, 'damage', KSCERATO, NIKO, 'ak47', 25),
  combatEvent('player_hurt-160770-2993', 160770, 'damage', KSCERATO, NIKO, 'ak47', 42),
  combatEvent('player_death-160770-2994', 160770, 'kill', KSCERATO, NIKO, 'ak47', 42),
  combatEvent('player_hurt-161101-2996', 161101, 'damage', FALLEN, M0NESY, 'm4a1', 37),
  combatEvent('player_hurt-161114-2997', 161114, 'damage', FALLEN, M0NESY, 'm4a1', 128),
  { ...combatEvent('player_death-161114-2998', 161114, 'kill', FALLEN, M0NESY, 'm4a1_silencer', 128), headshot: true },
  combatEvent('player_hurt-161152-2999', 161152, 'damage', FALLEN, KARRIGAN, 'm4a1', 28),
  combatEvent('player_hurt-161169-3000', 161169, 'damage', KARRIGAN, FALLEN, 'glock', 13),
  combatEvent('player_hurt-161178-3001', 161178, 'damage', FALLEN, KARRIGAN, 'm4a1', 37),
  combatEvent('player_hurt-161184-3002', 161184, 'damage', FALLEN, TESES, 'm4a1', 32),
  combatEvent('player_hurt-161189-3003', 161189, 'damage', KARRIGAN, FALLEN, 'glock', 55),
  combatEvent('player_hurt-161191-3004', 161191, 'damage', FALLEN, KARRIGAN, 'm4a1', 37),
  combatEvent('player_death-161191-3005', 161191, 'kill', FALLEN, KARRIGAN, 'm4a1_silencer', 37),
  combatEvent('player_hurt-161299-3006', 161299, 'damage', FALLEN, KYOUSUKE, 'hkp2000', 138),
  { ...combatEvent('player_death-161299-3007', 161299, 'kill', FALLEN, KYOUSUKE, 'usp_silencer', 138), headshot: true },
  combatEvent('player_hurt-161310-3008', 161310, 'damage', FALLEN, TESES, 'hkp2000', 135),
  { ...combatEvent('player_death-161310-3009', 161310, 'kill', FALLEN, TESES, 'usp_silencer', 135), headshot: true },
];

function workspace(events: TimelineEvent[] = realRound20Combat): AnalysisWorkspace {
  return {
    demo_id: 'bc6043de-b77e-4f79-afcb-3193a40a3bf2',
    map_name: 'de_mirage',
    tick_rate: 64,
    duration_seconds: 2_958.0625,
    teams: [],
    players: [
      { id: FALLEN, name: 'FalleN', team: 'A', kills: 9, deaths: 14, assists: 6, headshot_rate: 6 / 9, kill_death_ratio: 9 / 14, adr: 78 },
      { id: KSCERATO, name: 'KSCERATO', team: 'A', kills: 13, deaths: 14, assists: 3, headshot_rate: 0, kill_death_ratio: 13 / 14, adr: 0 },
      { id: KARRIGAN, name: 'karrigan', team: 'B', kills: 9, deaths: 14, assists: 6, headshot_rate: 0, kill_death_ratio: 9 / 14, adr: 0 },
      { id: TESES, name: 'TeSeS', team: 'B', kills: 11, deaths: 13, assists: 1, headshot_rate: 0, kill_death_ratio: 11 / 13, adr: 0 },
      { id: NIKO, name: 'NiKo', team: 'B', kills: 15, deaths: 10, assists: 5, headshot_rate: 0, kill_death_ratio: 1.5, adr: 0 },
      { id: M0NESY, name: 'm0NESY', team: 'B', kills: 19, deaths: 12, assists: 5, headshot_rate: 0, kill_death_ratio: 19 / 12, adr: 0 },
      { id: KYOUSUKE, name: 'kyousuke', team: 'B', kills: 18, deaths: 12, assists: 3, headshot_rate: 0, kill_death_ratio: 1.5, adr: 0 },
    ],
    rounds: [{
      number: 20,
      winner: 'A',
      reason: '#SFUI_Notice_CTs_Win',
      start_tick: 156234,
      end_tick: 161310,
      team_a_score: 8,
      team_b_score: 12,
      events,
    }],
    highlights: [],
  };
}

describe('round context model', () => {
  it('turns the real Major R20 FalleN 4K into one expandable encounter without losing atomic evidence', () => {
    const context = buildRoundContext(workspace(), 20);
    const encounters = context?.sections.find((section) => section.kind === 'encounters');
    const fallenFourKill = encounters?.groups.find(
      (group) => group.encounter?.dominant_actor_id === FALLEN,
    );

    expect(context?.sections.map((section) => section.kind)).toEqual([
      'encounters', 'objective', 'utility', 'economy', 'other',
    ]);
    expect(encounters?.groups).toHaveLength(2);
    expect(fallenFourKill).toMatchObject({
      start_tick: 161101,
      end_tick: 161310,
      encounter: {
        dominant_actor_id: FALLEN,
        kill_count: 4,
      },
    });
    expect(fallenFourKill?.atomic_event_ids).toEqual(
      realRound20Combat.slice(4).map((event) => event.id),
    );
    expect(fallenFourKill?.events).toHaveLength(14);
  });

  it('keeps every category deterministic and collapses purchases by explicit T/CT side', () => {
    const event = (
      id: string,
      tick: number,
      kind: TimelineEvent['kind'],
      actor: string | null,
      detail: Record<string, unknown> = {},
    ): TimelineEvent => ({
      id,
      tick,
      seconds: tick / 64,
      kind,
      actor,
      target: null,
      weapon: null,
      headshot: false,
      penetrated: false,
      position: null,
      detail,
    });
    const events = [
      event('round_start-100-1', 100, 'round_start', null),
      event('item_purchase-110-2', 110, 'purchase', FALLEN, { team: 3, item_name: 'Smoke Grenade' }),
      event('item_purchase-112-3', 112, 'purchase', KARRIGAN, { team: 2, item_name: 'AK-47' }),
      event('item_purchase-115-4', 115, 'purchase', KSCERATO, { team: 3, item_name: 'Flashbang' }),
      event('grenade_thrown-190-5', 190, 'grenade', FALLEN, { team: 3 }),
      event('bomb_planted-200-6', 200, 'bomb_plant', KARRIGAN, { team: 2 }),
      event('round_end-300-7', 300, 'round_end', null),
    ];

    const ordered = buildRoundContext(workspace(events), 20)!;
    const reordered = buildRoundContext(workspace([...events].reverse()), 20)!;
    const economy = ordered.sections.find((section) => section.kind === 'economy')!;

    expect(economy.groups).toHaveLength(2);
    expect(economy.groups.map((group) => ({
      side: group.side,
      start: group.start_tick,
      end: group.end_tick,
      events: group.atomic_event_ids,
    }))).toEqual([
      { side: 'CT', start: 110, end: 115, events: ['item_purchase-110-2', 'item_purchase-115-4'] },
      { side: 'T', start: 112, end: 112, events: ['item_purchase-112-3'] },
    ]);
    expect(reordered.sections.map((section) => ({
      id: section.id,
      start: section.start_tick,
      end: section.end_tick,
      events: section.atomic_event_ids,
      groups: section.groups.map((group) => group.id),
    }))).toEqual(ordered.sections.map((section) => ({
      id: section.id,
      start: section.start_tick,
      end: section.end_tick,
      events: section.atomic_event_ids,
      groups: section.groups.map((group) => group.id),
    })));
  });

  it('builds round-wide purchase and spend evidence only from explicit T/CT data', () => {
    const purchase = (
      id: string,
      tick: number,
      actor: string,
      team: number,
      item: string,
    ): TimelineEvent => ({
      id,
      tick,
      seconds: tick / 64,
      kind: 'purchase',
      actor,
      target: null,
      weapon: null,
      headshot: false,
      penetrated: false,
      position: null,
      detail: { team, item_name: item },
    });
    const subject = workspace([
      purchase('ct-smoke', 110, FALLEN, 3, 'Smoke Grenade'),
      purchase('t-ak', 112, KARRIGAN, 2, 'AK-47'),
      purchase('ct-flash', 115, KSCERATO, 3, 'Flashbang'),
    ]);
    subject.insights = {
      round_economy: [{
        round: 20,
        teams: [
          { team: 'A', purchase_count: 999, items: [{ name: 'fabricated', count: 999 }], spend: 999_999 },
          { team: 'B', purchase_count: 999, items: [{ name: 'fabricated', count: 999 }], spend: 999_999 },
          { team: 'CT', purchase_count: 2, items: [], spend: 5_750 },
          { team: 'T', purchase_count: 1, items: [], spend: 4_700 },
        ],
        unattributed_purchase_count: 0,
      }],
      player_utility: [],
      matchups: [],
      availability: {
        purchase_events: { available: true, reason: null },
        purchase_spend: { available: true, reason: null },
        utility_events: { available: false, reason: 'not decoded' },
        utility_damage: { available: false, reason: 'not decoded' },
        flash_effects: { available: false, reason: 'not decoded' },
        matchups: { available: false, reason: 'not decoded' },
      },
    };

    const sides = buildRoundContext(subject, 20)!.inspector.sides;

    expect(sides.map((side) => side.side)).toEqual(['T', 'CT']);
    expect(sides[0]?.purchases).toEqual({
      state: 'available',
      value: { count: 1, items: [{ name: 'AK-47', count: 1 }], atomic_event_ids: ['t-ak'] },
    });
    expect(sides[1]?.purchases).toEqual({
      state: 'available',
      value: {
        count: 2,
        items: [{ name: 'Flashbang', count: 1 }, { name: 'Smoke Grenade', count: 1 }],
        atomic_event_ids: ['ct-smoke', 'ct-flash'],
      },
    });
    expect(sides.map((side) => side.spend)).toEqual([
      { state: 'available', value: 4_700 },
      { state: 'available', value: 5_750 },
    ]);
  });

  it('reports only life-state and equipment facts that atomic events can prove at the focused tick', () => {
    const context = buildRoundContext(workspace(), 20, {
      event_id: 'player_death-161191-3005',
    })!;
    const fallen = context.inspector.participants.find((participant) => participant.player_id === FALLEN);
    const karrigan = context.inspector.participants.find((participant) => participant.player_id === KARRIGAN);
    const teses = context.inspector.participants.find((participant) => participant.player_id === TESES);
    const terroristLifeState = context.inspector.sides.find((side) => side.side === 'T')?.alive;

    expect(context.inspector.at_tick).toBe(161191);
    expect(fallen).toMatchObject({
      name: 'FalleN',
      side: { state: 'available', value: 'CT' },
      alive: { state: 'unavailable', reason: 'life-state-snapshot-unavailable' },
      equipment: { state: 'unavailable', reason: 'equipment-snapshot-unavailable' },
    });
    expect(karrigan).toMatchObject({
      name: 'karrigan',
      side: { state: 'available', value: 'T' },
      alive: { state: 'available', value: false },
    });
    // TeSeS dies later in the round. Absence of a death before the focus tick is
    // not treated as proof that the player is alive.
    expect(teses?.alive).toEqual({
      state: 'unavailable',
      reason: 'life-state-snapshot-unavailable',
    });
    expect(terroristLifeState).toEqual({
      state: 'partial',
      value: {
        known_dead_player_ids: [NIKO, M0NESY, KARRIGAN],
        observed_player_ids: [KARRIGAN, TESES, NIKO, M0NESY, KYOUSUKE],
      },
      reason: 'life-state-snapshot-unavailable',
    });
  });

  it('returns stable focus evidence so the inspector never has to reverse-engineer sections', () => {
    const context = buildRoundContext(workspace(), 20, {
      event_id: 'player_death-161191-3005',
      player_id: FALLEN,
    })!;
    const encounter = context.sections
      .find((section) => section.kind === 'encounters')!
      .groups.find((group) => group.encounter?.dominant_actor_id === FALLEN)!;

    expect(context.focus).toEqual({
      requested_event_id: 'player_death-161191-3005',
      requested_player_id: FALLEN,
      requested_tick: null,
      resolved_tick: 161191,
      matched_group_ids: [encounter.id],
      atomic_event_ids: encounter.atomic_event_ids,
      participant_ids: [FALLEN, KARRIGAN, TESES, M0NESY, KYOUSUKE].sort(),
    });
  });
});
