import { describe, expect, it } from 'vitest';

import type { AnalysisWorkspace, PlayerAnalysis, TimelineEvent } from '../../shared/desktop/dto';
import { teamRoundEvidenceActionContract } from './teamRoundEvidenceActions';
import { buildTeamRoundWorkspace } from './teamRoundWorkspace';

const a = ['a1', 'a2', 'a3', 'a4', 'a5'];
const b = ['b1', 'b2', 'b3', 'b4', 'b5'];

const player = (id: string, team: PlayerAnalysis['team']): PlayerAnalysis => ({
  id,
  name: id.toLocaleUpperCase(),
  team,
  kills: 0,
  deaths: 0,
  assists: 0,
  headshot_rate: 0,
  kill_death_ratio: 0,
  adr: 0,
});

const event = (
  id: string,
  tick: number,
  kind: TimelineEvent['kind'],
  overrides: Partial<TimelineEvent> = {},
): TimelineEvent => ({
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
});

function workspace(): AnalysisWorkspace {
  const roster = Object.fromEntries([
    ...a.map((id) => [id, 'T']),
    ...b.map((id) => [id, 'CT']),
  ]);
  return {
    demo_id: 'major-m1',
    map_name: 'de_mirage',
    tick_rate: 64,
    duration_seconds: 60,
    teams: [
      { name: 'Team A', side: 'A', score: 1, players: a },
      { name: 'Team B', side: 'B', score: 0, players: b },
    ],
    players: [...a.map((id) => player(id, 'A')), ...b.map((id) => player(id, 'B'))],
    rounds: [{
      number: 1,
      winner: 'A',
      reason: 'elimination',
      start_tick: 1_000,
      end_tick: 2_000,
      team_a_score: 1,
      team_b_score: 0,
      events: [
        event('start-r1', 1_000, 'round_start', { detail: { _round_roster: roster } }),
        event('kill-r1', 1_400, 'kill', {
          actor: 'a1',
          target: 'b1',
          weapon: 'ak47',
          headshot: true,
        }),
        event('end-r1', 2_000, 'round_end'),
      ],
    }],
    highlights: [],
  };
}

describe('team round evidence actions', () => {
  it('binds a canonical kill to exact Round, Replay, Watch, and production intents', () => {
    const analysis = workspace();
    const evidence = buildTeamRoundWorkspace(analysis, { team: 'A', side: 'T' }).evidence[0]!;
    const result = teamRoundEvidenceActionContract(analysis, evidence, {
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
        round: 1,
        tick: 1_400,
        playerId: 'a1',
        evidenceId: 'demo:major-m1/event:kill-r1',
      },
    });
    expect(result.replay.navigation).toMatchObject({ tab: 'replay', round: 1, tick: 1_400 });
    expect(result.watch).toEqual({ available: true, reason: null, start_tick: 1_400 });
    expect(result.add.available).toBe(true);
    expect(result.add.compilation).toMatchObject({
      id: 'demo:major-m1/event:kill-r1',
      playerId: 'a1',
      startTick: 1_400,
      category: 'entry',
    });
  });

  it('disables every action when display fields do not match the canonical event', () => {
    const analysis = workspace();
    const canonical = buildTeamRoundWorkspace(analysis, { team: 'A', side: 'T' }).evidence[0]!;
    const forged = { ...canonical, weapon: 'awp' };
    const result = teamRoundEvidenceActionContract(analysis, forged, {
      serviceAvailable: true,
      runtimeIdle: true,
      watchPending: false,
      alreadyAdded: false,
    });

    expect(result.round.available).toBe(false);
    expect(result.replay.available).toBe(false);
    expect(result.watch.available).toBe(false);
    expect(result.add).toMatchObject({ available: false, compilation: null });
  });
});
