import { describe, expect, it } from 'vitest';

import type {
  AnalysisWorkspace,
  PlayerAnalysis,
  TimelineEvent,
} from '../../shared/desktop/dto';
import {
  buildTeamRoundWorkspace,
  initialTeamRoundSelection,
  reduceTeamRoundSelection,
  resolveTeamRoundEvidenceId,
} from './teamRoundWorkspace';

const teamAIds = ['a1', 'a2', 'a3', 'a4', 'a5'] as const;
const teamBIds = ['b1', 'b2', 'b3', 'b4', 'b5'] as const;

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
    ...teamAIds.map((id) => [id, aSide] as const),
    ...teamBIds.map((id) => [id, bSide] as const),
  ]);
}

function workspace(): AnalysisWorkspace {
  return {
    demo_id: 'major-m1',
    map_name: 'de_mirage',
    tick_rate: 64,
    duration_seconds: 1_200,
    teams: [
      { name: 'Team A', side: 'A', score: 1, players: [...teamAIds] },
      { name: 'Team B', side: 'B', score: 1, players: [...teamBIds] },
    ],
    players: [
      ...teamAIds.map((id) => player(id, 'A')),
      ...teamBIds.map((id) => player(id, 'B')),
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
          event('round-start-r1', 1_000, 'round_start', { detail: { _round_roster: roster('T') } }),
          event('kill-r1', 1_400, 'kill', { actor: 'a1', target: 'b1', weapon: 'ak47' }),
          event('round-end-r1', 2_000, 'round_end'),
        ],
      },
      {
        number: 2,
        winner: 'B',
        reason: 'defused',
        start_tick: 3_000,
        end_tick: 4_000,
        team_a_score: 1,
        team_b_score: 1,
        events: [
          event('round-start-r2', 3_000, 'round_start', { detail: { _round_roster: roster('CT') } }),
          event('kill-r2', 3_400, 'kill', { actor: 'b1', target: 'a1', weapon: 'm4a1' }),
          event('round-end-r2', 4_000, 'round_end'),
        ],
      },
    ],
    highlights: [],
  };
}

describe('team round workspace', () => {
  it('lets a local evidence-row selection take ownership from the initial URL focus', () => {
    const initial = initialTeamRoundSelection();
    expect(resolveTeamRoundEvidenceId(initial, 'url-evidence', [
      'url-evidence',
      'clicked-evidence',
    ])).toBe('url-evidence');

    const afterClick = reduceTeamRoundSelection(initial, {
      type: 'select_evidence',
      cell_key: 'A:T',
      evidence_id: 'clicked-evidence',
    });

    expect(resolveTeamRoundEvidenceId(afterClick, 'url-evidence', [
      'url-evidence',
      'clicked-evidence',
    ])).toBe('clicked-evidence');
  });

  it('keeps local ownership when a cell switch clears its row selection', () => {
    const afterRowClick = reduceTeamRoundSelection(initialTeamRoundSelection(), {
      type: 'select_evidence',
      cell_key: 'A:T',
      evidence_id: 'url-evidence',
    });
    const afterCellSwitch = reduceTeamRoundSelection(afterRowClick, {
      type: 'select_cell',
      cell_key: 'B:CT',
    });

    expect(afterCellSwitch).toEqual({
      cell_key: 'B:CT',
      evidence_id: null,
      local_owner: true,
    });
    expect(resolveTeamRoundEvidenceId(afterCellSwitch, 'url-evidence', [
      'new-cell-first',
    ])).toBe('new-cell-first');

    const afterReturning = reduceTeamRoundSelection(afterCellSwitch, {
      type: 'select_cell',
      cell_key: 'A:T',
    });
    expect(resolveTeamRoundEvidenceId(afterReturning, 'url-evidence', [
      'first-evidence',
      'url-evidence',
    ])).toBe('first-evidence');
  });

  it('proves stable teams across a side swap and exposes a 2 by 2 round-control matrix', () => {
    const result = buildTeamRoundWorkspace(workspace(), { team: null, side: null });

    expect(result.availability).toMatchObject({ state: 'available', reason: null });
    expect(result.teams.map((team) => ({ id: team.id, player_ids: team.player_ids }))).toEqual([
      { id: 'A', player_ids: [...teamAIds] },
      { id: 'B', player_ids: [...teamBIds] },
    ]);
    expect(result.cells.map((cell) => ({
      team: cell.team,
      side: cell.side,
      rounds_played: cell.rounds_played,
      round_wins: cell.round_wins,
      rounds: cell.rounds,
    }))).toEqual([
      { team: 'A', side: 'T', rounds_played: 1, round_wins: 1, rounds: [1] },
      { team: 'A', side: 'CT', rounds_played: 1, round_wins: 0, rounds: [2] },
      { team: 'B', side: 'T', rounds_played: 1, round_wins: 1, rounds: [2] },
      { team: 'B', side: 'CT', rounds_played: 1, round_wins: 0, rounds: [1] },
    ]);
  });

  it('filters one team-side cell to canonical round-end and kill evidence', () => {
    const result = buildTeamRoundWorkspace(workspace(), { team: 'A', side: 'T' });

    expect(result.selected_cell).toMatchObject({
      team: 'A',
      side: 'T',
      rounds_played: 1,
      round_wins: 1,
    });
    expect(result.evidence.map((item) => ({
      id: item.evidence_id,
      kind: item.event_kind,
      round: item.round,
      tick: item.tick,
      actor_team: item.actor_team,
      target_team: item.target_team,
      winner_team: item.winner_team,
    }))).toEqual([
      {
        id: 'demo:major-m1/event:kill-r1',
        kind: 'kill',
        round: 1,
        tick: 1_400,
        actor_team: 'A',
        target_team: 'B',
        winner_team: null,
      },
      {
        id: 'demo:major-m1/event:round-end-r1',
        kind: 'round_end',
        round: 1,
        tick: 2_000,
        actor_team: null,
        target_team: null,
        winner_team: 'A',
      },
    ]);
  });

  it('fails closed with the exact round when a roster cannot prove both five-player teams', () => {
    const incomplete = workspace();
    const start = incomplete.rounds[1]?.events[0];
    if (start) start.detail = { _round_roster: { ...roster('CT'), b5: undefined } };

    const result = buildTeamRoundWorkspace(incomplete, { team: 'A', side: 'CT' });

    expect(result.availability).toMatchObject({
      state: 'unavailable',
      failure_code: 'incomplete_round_roster',
      failure_round: 2,
    });
    expect(result.availability.reason).toContain('Round 2');
    expect(result.cells).toEqual([]);
    expect(result.evidence).toEqual([]);
  });

  it('rejects normalized T/CT fallback summaries that do not prove stable match teams', () => {
    const sideOnly = workspace();
    sideOnly.teams[0]!.name = 'T';
    sideOnly.teams[1]!.name = 'CT';

    const result = buildTeamRoundWorkspace(sideOnly, { team: null, side: null });

    expect(result.availability).toMatchObject({
      state: 'unavailable',
      failure_code: 'stable_team_identity',
    });
    expect(result.cells).toEqual([]);
  });
});
