import { describe, expect, it } from 'vitest';

import type { TimelineEvent } from '../../shared/desktop/dto';
import type { AnalysisWorkspace, PlayerAnalysis } from '../../shared/desktop/viewModels';
import { teamEconomyEvidenceActionContract } from './teamEconomyEvidenceActions';
import { buildTeamEconomyWorkspace } from './teamEconomyWorkspace';

const teamA = ['a1', 'a2', 'a3', 'a4', 'a5'];
const teamB = ['b1', 'b2', 'b3', 'b4', 'b5'];

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
    ...teamA.map((id) => [id, 'T']),
    ...teamB.map((id) => [id, 'CT']),
  ]);
  return {
    demo_id: 'major-m1',
    map_name: 'de_mirage',
    tick_rate: 64,
    duration_seconds: 60,
    teams: [
      { name: 'Team A', side: 'A', score: 1, players: teamA },
      { name: 'Team B', side: 'B', score: 0, players: teamB },
    ],
    players: [...teamA.map((id) => player(id, 'A')), ...teamB.map((id) => player(id, 'B'))],
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
        event('buy-a1-r1', 1_100, 'purchase', {
          actor: 'a1',
          weapon: 'weapon_ak47',
          detail: { cost: 2_700, userteam: 2 },
        }),
      ],
    }],
    highlights: [],
  };
}

describe('team economy evidence action contract', () => {
  it('allows canonical actions but rejects a forged decoded purchase cost', () => {
    const analysis = workspace();
    const evidence = buildTeamEconomyWorkspace(analysis, {
      team: 'A',
      side: 'T',
      round: 1,
      page: 1,
    }).page.items[0]!;
    const context = {
      serviceAvailable: true,
      runtimeIdle: true,
      watchPending: false,
      alreadyAdded: false,
    };

    const canonical = teamEconomyEvidenceActionContract(analysis, evidence, context);
    expect(canonical.round).toMatchObject({ available: true, reason: null });
    expect(canonical.replay.navigation).toMatchObject({
      tab: 'replay',
      round: 1,
      tick: 1_100,
      playerId: 'a1',
      evidenceId: 'demo:major-m1/event:buy-a1-r1',
    });
    expect(canonical.watch).toMatchObject({ available: true, start_tick: 1_100 });
    expect(canonical.add).toMatchObject({
      available: true,
      compilation: { id: 'demo:major-m1/event:buy-a1-r1', playerId: 'a1' },
    });

    const forged = teamEconomyEvidenceActionContract(analysis, {
      ...evidence,
      cost: 9_999,
    }, context);
    for (const action of [forged.round, forged.replay, forged.watch, forged.add]) {
      expect(action).toMatchObject({
        available: false,
        reason: 'The canonical team purchase is not present at this round and tick.',
      });
    }
    expect(forged.add.compilation).toBeNull();
  });
});
