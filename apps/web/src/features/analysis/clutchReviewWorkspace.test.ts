import { describe, expect, it } from 'vitest';

import type { TimelineEvent } from '../../shared/desktop/dto';
import type { AnalysisWorkspace, Highlight, PlayerAnalysis } from '../../shared/desktop/viewModels';
import { buildClutchReviewWorkspace } from './clutchReviewWorkspace';

const m0nesy = '76561198074762801';
const molodoy = '76561198200982290';
const yuurih = '76561198164970560';
const niko = '76561198006920295';

function player(id: string, name: string, team: PlayerAnalysis['team']): PlayerAnalysis {
  return {
    id,
    name,
    team,
    kills: 0,
    deaths: 0,
    assists: 0,
    headshot_rate: 0,
    kill_death_ratio: 0,
    adr: 0,
  };
}

function kill(id: string, tick: number, actor: string, target: string): TimelineEvent {
  return {
    id,
    tick,
    seconds: tick / 64,
    kind: 'kill',
    actor,
    target,
    weapon: 'ak47',
    headshot: false,
    penetrated: false,
    position: null,
    detail: {},
  };
}

function clutch(overrides: Partial<Highlight> = {}): Highlight {
  return {
    id: '16:76561198074762801:144102-clutch',
    label: '1v2 clutch',
    category: 'clutch',
    kind: 'clutch',
    description: 'Won a 1v2 situation with 2 elimination(s)',
    tags: ['1v2', 'clutch'],
    victims: [molodoy, yuurih],
    player_id: m0nesy,
    round: 16,
    start_tick: 143_974,
    end_tick: 144_911,
    confidence: 0.83,
    ...overrides,
  };
}

function majorM2Workspace(highlights: Highlight[] = [clutch()]): AnalysisWorkspace {
  return {
    demo_id: 'iem-cologne-major-2026-final-m2',
    map_name: 'de_anubis',
    tick_rate: 64,
    duration_seconds: 3_000,
    teams: [],
    players: [
      player(m0nesy, 'm0NESY', 'A'),
      player(niko, 'NiKo', 'A'),
      player(molodoy, 'molodoy', 'B'),
      player(yuurih, 'yuurih', 'B'),
    ],
    rounds: [{
      number: 16,
      winner: 'A',
      reason: 'elimination',
      start_tick: 136_040,
      end_tick: 144_815,
      team_a_score: 9,
      team_b_score: 7,
      events: [
        kill('player_death-144238-2655', 144_238, m0nesy, molodoy),
        kill('player_death-144815-2665', 144_815, m0nesy, yuurih),
      ],
    }],
    highlights,
  };
}

describe('clutch review workspace', () => {
  it('locks the real Major M2 R16 m0NESY 1v2 win to canonical highlight evidence', () => {
    const result = buildClutchReviewWorkspace(majorM2Workspace(), {
      outcome: null,
      opponent_count: null,
      player_id: null,
    });

    expect(result.availability).toEqual({ state: 'available', reason: null });
    expect(result.summary).toEqual({ opportunities: 1, wins: 1, attempts: 0, rejected: 0 });
    expect(result.evidence).toEqual([expect.objectContaining({
      evidence_id: 'demo:iem-cologne-major-2026-final-m2/highlight:16:76561198074762801:144102-clutch',
      source_kind: 'highlight',
      source_id: '16:76561198074762801:144102-clutch',
      outcome: 'won',
      opponent_count: 2,
      player_id: m0nesy,
      player_name: 'm0NESY',
      round: 16,
      tick: 143_974,
      end_tick: 144_911,
      eliminations: 2,
      survived: true,
      victim_names: ['molodoy', 'yuurih'],
    })]);
  });

  it('includes only explicitly tagged clutch attempts and never promotes an ordinary failure', () => {
    const explicitAttempt = clutch({
      id: '15:76561198074762801:133913-attempt',
      kind: 'fail',
      category: 'entry',
      label: '1v4 attempt',
      description: 'Reached a 1v4 situation but did not win the round',
      tags: ['1v4', 'clutch_attempt', 'failure'],
      victims: [],
      round: 16,
      start_tick: 140_000,
      end_tick: 144_815,
    });
    const ordinaryDeathReel = clutch({
      id: 'timeline:death-reel',
      kind: 'fail',
      category: 'entry',
      label: 'Full-match death reel · 1/9',
      tags: ['timeline', 'death_reel'],
      victims: [],
    });

    const result = buildClutchReviewWorkspace(
      majorM2Workspace([clutch(), explicitAttempt, ordinaryDeathReel]),
      { outcome: null, opponent_count: null, player_id: null },
    );

    expect(result.summary).toEqual({ opportunities: 2, wins: 1, attempts: 1, rejected: 0 });
    expect(result.evidence.map((item) => ({ id: item.source_id, outcome: item.outcome }))).toEqual([
      { id: '16:76561198074762801:144102-clutch', outcome: 'won' },
      { id: '15:76561198074762801:133913-attempt', outcome: 'attempt' },
    ]);
  });

  it('fails closed when candidate highlights cannot prove an exact outcome and 1vN scenario', () => {
    const missingScenario = clutch({ tags: ['clutch'] });
    const unknownPlayerAttempt = clutch({
      id: 'forged-attempt',
      kind: 'fail',
      category: 'entry',
      player_id: 'unknown-player',
      tags: ['1v3', 'clutch_attempt', 'failure'],
      victims: [],
    });
    const ordinaryDeathReel = clutch({
      id: 'ordinary-fail',
      kind: 'fail',
      category: 'entry',
      tags: ['timeline', 'death_reel'],
      victims: [],
    });

    const result = buildClutchReviewWorkspace(
      majorM2Workspace([missingScenario, unknownPlayerAttempt, ordinaryDeathReel]),
      { outcome: null, opponent_count: null, player_id: null },
    );

    expect(result.availability.state).toBe('unavailable');
    expect(result.availability.reason).toContain('2');
    expect(result.summary).toEqual({ opportunities: 0, wins: 0, attempts: 0, rejected: 2 });
    expect(result.evidence).toEqual([]);
  });

  it('rejects candidates with an out-of-round start or a same-team victim while allowing the generator tail', () => {
    const outOfRoundStart = clutch({
      id: 'out-of-round-start',
      start_tick: 136_039,
      end_tick: 136_100,
    });
    const sameTeamVictim = clutch({
      id: 'same-team-victim',
      victims: [niko],
    });

    const result = buildClutchReviewWorkspace(
      majorM2Workspace([clutch(), outOfRoundStart, sameTeamVictim]),
      { outcome: null, opponent_count: null, player_id: null },
    );

    expect(result.availability.state).toBe('partial');
    expect(result.summary).toEqual({ opportunities: 1, wins: 1, attempts: 0, rejected: 2 });
    expect(result.evidence.map((item) => item.source_id)).toEqual([
      '16:76561198074762801:144102-clutch',
    ]);
    expect(result.evidence[0]?.end_tick).toBe(144_911);
  });

  it('reports an available empty workspace when there are no clutch markers at all', () => {
    const ordinaryDeathReel = clutch({
      id: 'ordinary-fail',
      kind: 'fail',
      category: 'entry',
      tags: ['timeline', 'death_reel'],
      victims: [],
    });

    const result = buildClutchReviewWorkspace(
      majorM2Workspace([ordinaryDeathReel]),
      { outcome: null, opponent_count: null, player_id: null },
    );

    expect(result.availability).toEqual({ state: 'available', reason: null });
    expect(result.summary).toEqual({ opportunities: 0, wins: 0, attempts: 0, rejected: 0 });
    expect(result.evidence).toEqual([]);
  });

  it('applies outcome, opponent, and player filters without changing the match summary', () => {
    const attempt = clutch({
      id: 'm0nesy-1v4-attempt',
      kind: 'fail',
      category: 'entry',
      tags: ['1v4', 'clutch_attempt', 'failure'],
      victims: [],
    });
    const otherPlayerAttempt = clutch({
      id: 'molodoy-1v2-attempt',
      kind: 'fail',
      category: 'entry',
      player_id: molodoy,
      tags: ['1v2', 'clutch_attempt', 'failure'],
      victims: [],
    });

    const result = buildClutchReviewWorkspace(
      majorM2Workspace([clutch(), attempt, otherPlayerAttempt]),
      { outcome: 'attempt', opponent_count: 4, player_id: m0nesy },
    );

    expect(result.summary).toEqual({ opportunities: 3, wins: 1, attempts: 2, rejected: 0 });
    expect(result.evidence.map((item) => item.source_id)).toEqual(['m0nesy-1v4-attempt']);
  });
});
