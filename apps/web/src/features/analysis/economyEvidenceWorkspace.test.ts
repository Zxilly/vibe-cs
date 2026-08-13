import { describe, expect, it } from 'vitest';

import type { AnalysisWorkspace, TimelineEvent } from '../../shared/desktop/dto';
import { buildEconomyEvidenceWorkspace } from './economyEvidenceWorkspace';

const purchase = (overrides: Partial<TimelineEvent>): TimelineEvent => ({
  id: 'item_purchase-100-1',
  tick: 100,
  seconds: 1.5625,
  kind: 'purchase',
  actor: 'fallen-id',
  target: null,
  weapon: 'weapon_ak47',
  headshot: false,
  penetrated: false,
  position: null,
  detail: { team: 2, price: 2_700 },
  ...overrides,
});

const workspace: AnalysisWorkspace = {
  demo_id: 'major-final-map-1',
  map_name: 'de_mirage',
  tick_rate: 64,
  duration_seconds: 2_958,
  teams: [],
  players: [
    { id: 'fallen-id', name: 'FalleN', team: 'A', kills: 1, deaths: 1, assists: 0, headshot_rate: 0.5, kill_death_ratio: 1, adr: 80 },
    { id: 'karrigan-id', name: 'karrigan', team: 'B', kills: 1, deaths: 1, assists: 0, headshot_rate: 0.5, kill_death_ratio: 1, adr: 80 },
  ],
  rounds: [
    {
      number: 1,
      winner: 'A',
      reason: 'elimination',
      start_tick: 1,
      end_tick: 1_000,
      team_a_score: 1,
      team_b_score: 0,
      events: [
        purchase({ id: 'item_purchase-100-1' }),
        purchase({
          id: 'item_purchase-110-2',
          tick: 110,
          actor: 'karrigan-id',
          weapon: 'weapon_deagle',
          detail: { team: 'T', price: 700 },
        }),
      ],
    },
    {
      number: 13,
      winner: 'B',
      reason: 'elimination',
      start_tick: 13_000,
      end_tick: 14_000,
      team_a_score: 6,
      team_b_score: 7,
      events: [
        purchase({
          id: 'item_purchase-13100-1',
          tick: 13_100,
          seconds: 204.6875,
          weapon: 'weapon_m4a1_silencer',
          detail: { user_team_num: 3, item_cost: 2_900 },
        }),
      ],
    },
  ],
  highlights: [],
  insights: {
    round_economy: [
      {
        round: 1,
        teams: [
          { team: 'T', purchase_count: 2, items: [{ name: 'ak47', count: 1 }, { name: 'deagle', count: 1 }], spend: 3_400 },
          { team: 'CT', purchase_count: 0, items: [], spend: null },
        ],
        unattributed_purchase_count: 0,
      },
      {
        round: 13,
        teams: [
          { team: 'T', purchase_count: 0, items: [], spend: null },
          { team: 'CT', purchase_count: 1, items: [{ name: 'm4a1_silencer', count: 1 }], spend: 2_900 },
        ],
        unattributed_purchase_count: 0,
      },
    ],
    player_utility: [],
    matchups: [],
    availability: {
      purchase_events: { available: true, reason: null },
      purchase_spend: { available: true, reason: null },
      utility_events: { available: false, reason: 'not requested' },
      utility_damage: { available: false, reason: 'not requested' },
      flash_effects: { available: false, reason: 'not requested' },
      matchups: { available: false, reason: 'not requested' },
    },
  },
};

describe('economy evidence workspace', () => {
  it('keeps explicit T/CT purchase sides across a player halftime swap and preserves round-side aggregates', () => {
    const result = buildEconomyEvidenceWorkspace(workspace, {
      playerId: 'fallen-id',
      round: null,
    });

    expect(result.evidence.map((item) => ({
      evidence_id: item.evidence_id,
      round: item.round,
      side: item.side,
      item: item.item,
      cost: item.cost,
    }))).toEqual([
      {
        evidence_id: 'demo:major-final-map-1/event:item_purchase-100-1',
        round: 1,
        side: 'T',
        item: 'ak47',
        cost: 2_700,
      },
      {
        evidence_id: 'demo:major-final-map-1/event:item_purchase-13100-1',
        round: 13,
        side: 'CT',
        item: 'm4a1_silencer',
        cost: 2_900,
      },
    ]);
    expect(result.rows.map((row) => ({
      round: row.round,
      t: {
        purchases: row.sides.T.purchase_count,
        matching: row.sides.T.matching_atomic_count,
      },
      ct: {
        purchases: row.sides.CT.purchase_count,
        matching: row.sides.CT.matching_atomic_count,
      },
    }))).toEqual([
      { round: 1, t: { purchases: 2, matching: 1 }, ct: { purchases: 0, matching: 0 } },
      { round: 13, t: { purchases: 0, matching: 0 }, ct: { purchases: 1, matching: 1 } },
    ]);
    expect(JSON.stringify(result)).not.toContain('team":"A');
    expect(JSON.stringify(result)).not.toContain('team":"B');
  });

  it('withholds non-schema economy metrics and never treats cash-like detail as a purchase price', () => {
    const incomplete: AnalysisWorkspace = {
      ...workspace,
      rounds: [{
        ...workspace.rounds[0]!,
        events: [purchase({
          id: 'item_purchase-no-explicit-price',
          detail: {
            team: 'T',
            item_name: 'weapon_ak47',
            price: '2700',
            money: 9_999,
            equipment_value: 8_450,
            economy_type: 'full-buy',
          },
        })],
      }],
      insights: {
        ...workspace.insights!,
        round_economy: [{
          round: 1,
          teams: [
            { team: 'T', purchase_count: 1, items: [{ name: 'ak47', count: 1 }], spend: null },
            { team: 'CT', purchase_count: 0, items: [], spend: null },
          ],
          unattributed_purchase_count: 0,
        }],
        availability: {
          ...workspace.insights!.availability,
          purchase_spend: {
            available: false,
            reason: 'Decoded purchase events do not provide a complete explicit price field.',
          },
        },
      },
    };

    const result = buildEconomyEvidenceWorkspace(incomplete, {
      playerId: null,
      round: 1,
    });

    expect(result.evidence[0]).toMatchObject({ item: 'ak47', cost: null });
    expect(result.rows[0]?.sides.T).toMatchObject({
      spend: null,
      spend_availability: {
        state: 'unavailable',
        reason: 'Decoded purchase events do not provide a complete explicit price field.',
      },
    });
    expect(result.availability).toMatchObject({
      equipment_value: {
        state: 'unavailable',
        reason: 'Equipment value snapshots are not present in this analysis schema.',
      },
      economy_type: {
        state: 'unavailable',
        reason: 'Economy classifications cannot be derived from purchase events alone.',
      },
      advantage: {
        state: 'unavailable',
        reason: 'Economy advantage cannot be derived without complete team value or money snapshots.',
      },
      money_snapshot: {
        state: 'unavailable',
        reason: 'Player money snapshots are not present in this analysis schema.',
      },
    });
  });

  it('keeps side-less purchases unattributed and marks mismatched round-side aggregates partial', () => {
    const partial: AnalysisWorkspace = {
      ...workspace,
      rounds: [{
        ...workspace.rounds[0]!,
        events: [
          purchase({ id: 'item_purchase-attributed' }),
          purchase({
            id: 'item_purchase-unattributed',
            tick: 120,
            detail: { price: 700 },
            weapon: 'weapon_deagle',
          }),
        ],
      }],
      insights: {
        ...workspace.insights!,
        round_economy: [{
          round: 1,
          teams: [
            { team: 'T', purchase_count: 2, items: [{ name: 'ak47', count: 1 }, { name: 'deagle', count: 1 }], spend: null },
            { team: 'CT', purchase_count: 0, items: [], spend: null },
          ],
          unattributed_purchase_count: 1,
        }],
      },
    };

    const result = buildEconomyEvidenceWorkspace(partial, {
      playerId: null,
      round: 1,
    });

    expect(result.evidence.map((item) => item.side)).toEqual(['T', null]);
    expect(result.rows[0]).toMatchObject({
      unattributed_purchase_count: 1,
      unattributed_atomic_count: 1,
      sides: {
        T: {
          purchase_count: 2,
          atomic_count: 1,
          purchase_availability: {
            state: 'partial',
            reason: expect.stringContaining('1 of 2'),
          },
        },
      },
    });
    expect(result.rows[0]?.sides.T.purchase_availability.reason).toContain('unattributed');
  });
});
