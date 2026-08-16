import { describe, expect, it } from 'vitest';

import type { AnalysisWorkspace, Highlight, PlayerAnalysis } from '../../shared/desktop/viewModels';
import { clutchReviewActionContract } from './clutchReviewActions';
import { buildClutchReviewWorkspace } from './clutchReviewWorkspace';

const player = (id: string, name: string, team: PlayerAnalysis['team']): PlayerAnalysis => ({
  id,
  name,
  team,
  kills: 0,
  deaths: 0,
  assists: 0,
  headshot_rate: 0,
  kill_death_ratio: 0,
  adr: 0,
});

function workspace(): AnalysisWorkspace {
  const highlight: Highlight = {
    id: '16:76561198074762801:144102-clutch',
    label: '1v2 clutch',
    category: 'clutch',
    kind: 'clutch',
    description: 'Won a 1v2 situation with 2 elimination(s)',
    tags: ['1v2', 'clutch'],
    victims: ['molodoy', 'yuurih'],
    player_id: 'm0nesy',
    round: 16,
    start_tick: 143_974,
    end_tick: 144_911,
    confidence: 0.83,
  };
  return {
    demo_id: 'major-m2',
    map_name: 'de_anubis',
    tick_rate: 64,
    duration_seconds: 3_000,
    teams: [],
    players: [
      player('m0nesy', 'm0NESY', 'A'),
      player('molodoy', 'molodoy', 'B'),
      player('yuurih', 'yuurih', 'B'),
    ],
    rounds: [{
      number: 16,
      winner: 'A',
      reason: 'elimination',
      start_tick: 136_040,
      end_tick: 144_815,
      team_a_score: 9,
      team_b_score: 7,
      events: [],
    }],
    highlights: [highlight],
  };
}

describe('clutch review actions', () => {
  it('binds canonical clutch evidence to exact Round, Replay, Watch, and Add actions', () => {
    const analysis = workspace();
    const evidence = buildClutchReviewWorkspace(analysis, {
      outcome: null,
      opponent_count: null,
      player_id: null,
    }).evidence[0]!;
    const result = clutchReviewActionContract(analysis, evidence, {
      serviceAvailable: true,
      runtimeIdle: true,
      watchPending: false,
      alreadyAdded: false,
    });

    expect(result.round).toEqual({
      available: true,
      reason: null,
      navigation: {
        tab: 'rounds',
        round: 16,
        tick: 143_974,
        playerId: 'm0nesy',
        evidenceId: 'demo:major-m2/highlight:16:76561198074762801:144102-clutch',
      },
    });
    expect(result.replay.navigation).toMatchObject({ tab: 'replay', round: 16, tick: 143_974 });
    expect(result.watch).toEqual({ available: true, reason: null, start_tick: 143_974 });
    expect(result.add).toEqual({ available: true, reason: null });
  });
});
