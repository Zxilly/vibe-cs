import { describe, expect, it } from 'vitest';

import type {
  AnalysisWorkspace,
  PlayerAnalysis,
  TimelineEvent,
} from '../../shared/desktop/dto';
import { buildTeamEconomyWorkspace } from './teamEconomyWorkspace';

const teamA = ['a1', 'a2', 'a3', 'a4', 'a5'] as const;
const teamB = ['b1', 'b2', 'b3', 'b4', 'b5'] as const;

function player(id: string, team: PlayerAnalysis['team']): PlayerAnalysis {
  return {
    id,
    name: id.toLocaleUpperCase(),
    team,
    kills: 0,
    deaths: 0,
    assists: 0,
    headshot_rate: 0,
    kill_death_ratio: 0,
    adr: 0,
  };
}

function event(
  id: string,
  tick: number,
  kind: TimelineEvent['kind'],
  overrides: Partial<TimelineEvent> = {},
): TimelineEvent {
  return {
    id,
    tick,
    seconds: tick / 64,
    kind,
    actor: null,
    target: null,
    weapon: null,
    headshot: false,
    penetrated: false,
    position: null,
    detail: {},
    ...overrides,
  };
}

function roster(aSide: 'T' | 'CT'): Record<string, 'T' | 'CT'> {
  const bSide = aSide === 'T' ? 'CT' : 'T';
  return Object.fromEntries([
    ...teamA.map((id) => [id, aSide] as const),
    ...teamB.map((id) => [id, bSide] as const),
  ]);
}

function purchase(
  id: string,
  tick: number,
  actor: string,
  item: string,
  cost: number,
  side: 'T' | 'CT',
): TimelineEvent {
  return event(id, tick, 'purchase', {
    actor,
    weapon: item,
    detail: { cost, userteam: side === 'T' ? 2 : 3 },
  });
}

function workspace(): AnalysisWorkspace {
  return {
    demo_id: 'major-m1',
    map_name: 'de_mirage',
    tick_rate: 64,
    duration_seconds: 1_200,
    teams: [
      { name: 'Team A', side: 'A', score: 1, players: [...teamA] },
      { name: 'Team B', side: 'B', score: 1, players: [...teamB] },
    ],
    players: [
      ...teamA.map((id) => player(id, 'A')),
      ...teamB.map((id) => player(id, 'B')),
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
          event('start-r1', 1_000, 'round_start', { detail: { _round_roster: roster('T') } }),
          purchase('buy-a1-r1', 1_100, 'a1', 'vest', 650, 'T'),
          purchase('buy-a2-r1', 1_110, 'a2', 'flashbang', 200, 'T'),
          purchase('buy-b1-r1', 1_120, 'b1', 'vest', 650, 'CT'),
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
          event('start-r2', 3_000, 'round_start', { detail: { _round_roster: roster('CT') } }),
          purchase('buy-a1-r2', 3_100, 'a1', 'm4a1', 2_900, 'CT'),
          purchase('buy-b1-r2', 3_120, 'b1', 'ak47', 2_700, 'T'),
        ],
      },
    ],
    highlights: [],
  };
}

describe('team economy workspace', () => {
  it('attributes decoded purchase atoms and costs to stable Team A/B across a side swap', () => {
    const result = buildTeamEconomyWorkspace(workspace(), {
      team: null,
      side: null,
      round: null,
      page: 1,
    });

    expect(result.availability).toMatchObject({ state: 'available', reason: null });
    expect(result.cells.map((cell) => ({
      team: cell.team,
      side: cell.side,
      rounds_played: cell.rounds_played,
      purchase_count: cell.purchase_count,
      decoded_purchase_cost: cell.decoded_purchase_cost,
      cost_state: cell.cost_availability.state,
    }))).toEqual([
      { team: 'A', side: 'T', rounds_played: 1, purchase_count: 2, decoded_purchase_cost: 850, cost_state: 'available' },
      { team: 'A', side: 'CT', rounds_played: 1, purchase_count: 1, decoded_purchase_cost: 2_900, cost_state: 'available' },
      { team: 'B', side: 'T', rounds_played: 1, purchase_count: 1, decoded_purchase_cost: 2_700, cost_state: 'available' },
      { team: 'B', side: 'CT', rounds_played: 1, purchase_count: 1, decoded_purchase_cost: 650, cost_state: 'available' },
    ]);
    expect(result.page).toMatchObject({ total: 0, page: 1, page_size: 50, items: [] });
  });

  it('rejects every purchase atom whose canonical event id is ambiguous', () => {
    const ambiguous = workspace();
    ambiguous.rounds[0]?.events.push(
      purchase('buy-a1-r1', 1_130, 'a3', 'smokegrenade', 300, 'T'),
    );

    const result = buildTeamEconomyWorkspace(ambiguous, {
      team: 'A',
      side: 'T',
      round: null,
      page: 1,
    });

    expect(result.availability).toMatchObject({
      state: 'partial',
      rejected_purchase_count: 2,
    });
    expect(result.cells.find((cell) => cell.team === 'A' && cell.side === 'T'))
      .toMatchObject({ purchase_count: 1, decoded_purchase_cost: 200 });
    expect(result.page.items.map((item) => item.source_id)).toEqual(['buy-a2-r1']);
  });

  it('rejects an explicit event side that contradicts the exact round roster', () => {
    const contradictorySide = workspace();
    const purchaseWithContradictorySide = contradictorySide.rounds[0]?.events.find(
      (item) => item.id === 'buy-a1-r1',
    );
    if (purchaseWithContradictorySide) {
      purchaseWithContradictorySide.detail = { cost: 650, userteam: 3 };
    }

    const result = buildTeamEconomyWorkspace(contradictorySide, {
      team: 'A',
      side: 'T',
      round: 1,
      page: 1,
    });

    expect(result.availability).toMatchObject({
      state: 'partial',
      rejected_purchase_count: 1,
    });
    expect(result.cells.find((cell) => cell.team === 'A' && cell.side === 'T'))
      .toMatchObject({ purchase_count: 1, decoded_purchase_cost: 200 });
    expect(result.page.items.map((item) => item.source_id)).toEqual(['buy-a2-r1']);
  });

  it('rejects a purchase when its explicit side fields contradict each other', () => {
    const contradictoryFields = workspace();
    const purchaseWithContradictoryFields = contradictoryFields.rounds[0]?.events.find(
      (item) => item.id === 'buy-a1-r1',
    );
    if (purchaseWithContradictoryFields) {
      purchaseWithContradictoryFields.detail = {
        cost: 650,
        userteam: 2,
        user_team_num: 3,
      };
    }

    const result = buildTeamEconomyWorkspace(contradictoryFields, {
      team: 'A',
      side: 'T',
      round: 1,
      page: 1,
    });

    expect(result.availability).toMatchObject({
      state: 'partial',
      rejected_purchase_count: 1,
    });
    expect(result.page.items.map((item) => item.source_id)).toEqual(['buy-a2-r1']);
  });

  it('filters by cell and round before exposing a fixed fifty-atom page', () => {
    const manyPurchases = workspace();
    for (let index = 0; index < 53; index += 1) {
      manyPurchases.rounds[0]?.events.push(purchase(
        `buy-extra-${index}`,
        1_200 + index,
        teamA[index % teamA.length]!,
        'flashbang',
        100,
        'T',
      ));
    }

    const first = buildTeamEconomyWorkspace(manyPurchases, {
      team: 'A',
      side: 'T',
      round: 1,
      page: 1,
    });
    const second = buildTeamEconomyWorkspace(manyPurchases, {
      team: 'A',
      side: 'T',
      round: 1,
      page: 2,
    });

    expect(first.page).toMatchObject({ total: 55, page: 1, page_size: 50, total_pages: 2 });
    expect(first.page.items).toHaveLength(50);
    expect(second.page).toMatchObject({ total: 55, page: 2, page_size: 50, total_pages: 2 });
    expect(second.page.items).toHaveLength(5);
    expect(second.page.items.every((item) => item.stable_team === 'A'
      && item.side === 'T'
      && item.round === 1)).toBe(true);
  });

  it('keeps a canonical purchase count but withholds cost when one atom has no decoded cost', () => {
    const incompleteCost = workspace();
    const purchaseWithoutCost = incompleteCost.rounds[0]?.events.find(
      (item) => item.id === 'buy-a1-r1',
    );
    if (purchaseWithoutCost) purchaseWithoutCost.detail = { userteam: 2 };

    const result = buildTeamEconomyWorkspace(incompleteCost, {
      team: 'A',
      side: 'T',
      round: 1,
      page: 1,
    });
    const cell = result.cells.find((item) => item.team === 'A' && item.side === 'T');

    expect(cell).toMatchObject({
      purchase_count: 2,
      decoded_purchase_cost: null,
      cost_availability: { state: 'partial' },
    });
    expect(cell?.cost_availability.reason).toContain('no explicit non-negative cost');
    expect(result.page.items.find((item) => item.source_id === 'buy-a1-r1')?.cost).toBeNull();
  });
});
