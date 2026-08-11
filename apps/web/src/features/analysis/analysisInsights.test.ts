import { describe, expect, it } from 'vitest';

import type { AnalysisInsightsRecord, Highlight, PlayerAnalysis } from '../../shared/desktop/dto';
import {
  emptyAnalysisInsights,
  matchupsForPlayer,
  orderHighlightsForCompilation,
  teamPurchaseForSide,
} from './analysisInsights';

const players: PlayerAnalysis[] = [
  { id: 'a', name: 'Alice', team: 'A', kills: 2, deaths: 1, assists: 0, headshot_rate: 0.5, rating: 1.2, adr: 90 },
  { id: 'ally', name: 'Ally', team: 'A', kills: 1, deaths: 1, assists: 0, headshot_rate: 0, rating: 1, adr: 50 },
  { id: 'b', name: 'Bob', team: 'B', kills: 1, deaths: 2, assists: 0, headshot_rate: 0, rating: 0.8, adr: 40 },
];

function insights(): AnalysisInsightsRecord {
  const result = emptyAnalysisInsights();
  result.round_economy = [{
    round: 1,
    teams: [
      { team: 'T', purchase_count: 2, items: [{ name: 'ak47', count: 1 }], spend: null },
      { team: 'CT', purchase_count: 1, items: [{ name: 'm4a1', count: 1 }], spend: 2900 },
    ],
    unattributed_purchase_count: 0,
  }];
  result.matchups = [
    { player_id: 'a', opponent_id: 'ally', kills: 1, deaths: 0, headshot_kills: 0, damage_dealt: 100, damage_taken: 0, damage_events: 1 },
    { player_id: 'a', opponent_id: 'b', kills: 2, deaths: 1, headshot_kills: 1, damage_dealt: 180, damage_taken: 80, damage_events: 3 },
  ];
  return result;
}

describe('analysis insight selectors', () => {
  it('maps decoded T/CT economy evidence to displayed A/B sides without estimating spend', () => {
    const round = insights().round_economy[0]!;
    expect(teamPurchaseForSide(round, 'A')).toMatchObject({ purchase_count: 2, spend: null });
    expect(teamPurchaseForSide(round, 'B')).toMatchObject({ purchase_count: 1, spend: 2900 });
  });

  it('keeps only opponent matchups for the selected player', () => {
    expect(matchupsForPlayer(insights(), 'a', players)).toEqual([
      expect.objectContaining({ opponent_id: 'b', kills: 2, deaths: 1 }),
    ]);
  });

  it('deduplicates and orders compilation moments by round and tick', () => {
    const base = {
      label: 'moment', category: 'entry', kind: 'one_tap', description: '', tags: [], victims: [],
      player_id: 'a', end_tick: 20, confidence: 1,
    } satisfies Omit<Highlight, 'id' | 'round' | 'start_tick'>;
    const late: Highlight = { ...base, id: 'late', round: 2, start_tick: 10 };
    const early: Highlight = { ...base, id: 'early', round: 1, start_tick: 30 };

    expect(orderHighlightsForCompilation([late, early, late]).map((item) => item.id)).toEqual(['early', 'late']);
  });
});
