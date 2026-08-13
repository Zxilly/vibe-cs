import { describe, expect, it } from 'vitest';

import type {
  AnalysisWorkspace,
  PlayerAnalysis,
  TimelineEvent,
} from '../../shared/desktop/dto';
import { deriveStableMatchTeamContext } from './stableMatchTeamContext';

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
  detail: Record<string, unknown> = {},
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
    detail,
  };
}

function roster(aSide: 'T' | 'CT'): Record<string, 'T' | 'CT'> {
  const bSide = aSide === 'T' ? 'CT' : 'T';
  return Object.fromEntries([
    ...teamA.map((id) => [id, aSide] as const),
    ...teamB.map((id) => [id, bSide] as const),
  ]);
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
        events: [event('start-r1', 1_000, 'round_start', { _round_roster: roster('T') })],
      },
      {
        number: 2,
        winner: 'B',
        reason: 'elimination',
        start_tick: 3_000,
        end_tick: 4_000,
        team_a_score: 1,
        team_b_score: 1,
        events: [event('start-r2', 3_000, 'round_start', { _round_roster: roster('CT') })],
      },
    ],
    highlights: [],
  };
}

describe('stable match team context', () => {
  it('proves the same exact five-player teams across a side swap', () => {
    const result = deriveStableMatchTeamContext(workspace());

    expect(result.availability).toEqual({
      state: 'available',
      reason: null,
      failure_code: null,
      failure_round: null,
    });
    expect(result.teams.map((team) => ({ id: team.id, player_ids: team.player_ids }))).toEqual([
      { id: 'A', player_ids: [...teamA] },
      { id: 'B', player_ids: [...teamB] },
    ]);
    expect(result.rounds.map((round) => ({ number: round.number, sides: round.sides }))).toEqual([
      { number: 1, sides: { A: 'T', B: 'CT' } },
      { number: 2, sides: { A: 'CT', B: 'T' } },
    ]);
  });

  it('rejects duplicate members on either side of the exact roster comparison', () => {
    const duplicateSummaryMember = workspace();
    duplicateSummaryMember.teams[0]!.players = ['a1', 'a1', 'a2', 'a3', 'a4'];

    expect(deriveStableMatchTeamContext(duplicateSummaryMember).availability).toMatchObject({
      state: 'unavailable',
      failure_code: 'stable_team_identity',
    });

    const duplicateAnalysisMember = workspace();
    duplicateAnalysisMember.players[4] = player('a1', 'A');

    expect(deriveStableMatchTeamContext(duplicateAnalysisMember).availability).toMatchObject({
      state: 'unavailable',
      failure_code: 'stable_team_identity',
    });
  });
});
