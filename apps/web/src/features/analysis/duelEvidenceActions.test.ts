import { describe, expect, it } from 'vitest';

import type { AnalysisWorkspace } from '../../shared/desktop/viewModels';
import type { PlayerDuelInteraction } from './playerMatchEvidence';
import { duelEvidenceActionContract } from './duelEvidenceActions';

const workspace: AnalysisWorkspace = {
  demo_id: 'major-final-map-1',
  map_name: 'de_mirage',
  tick_rate: 64,
  duration_seconds: 2_958,
  teams: [],
  players: [
    { id: 'fallen-id', name: 'FalleN', team: 'A', kills: 1, deaths: 1, assists: 0, headshot_rate: 1, kill_death_ratio: 1, adr: 80 },
    { id: 'niko-id', name: 'NiKo', team: 'B', kills: 1, deaths: 1, assists: 0, headshot_rate: 0, kill_death_ratio: 1, adr: 80 },
  ],
  rounds: [{
    number: 20,
    winner: 'A',
    reason: 'elimination',
    start_tick: 160_000,
    end_tick: 162_000,
    team_a_score: 12,
    team_b_score: 8,
    events: [{
      id: 'player-death-161114-2998',
      tick: 161_114,
      seconds: 2_517.4,
      kind: 'kill',
      actor: 'fallen-id',
      target: 'niko-id',
      weapon: 'ak47',
      headshot: true,
      penetrated: false,
      position: null,
      detail: {},
    }],
  }],
  highlights: [],
};

const evidence: PlayerDuelInteraction = {
  evidence_id: 'demo:major-final-map-1/event:player-death-161114-2998',
  demo_id: 'major-final-map-1',
  source_kind: 'event',
  source_id: 'player-death-161114-2998',
  round: 20,
  tick: 161_114,
  end_tick: null,
  event_kind: 'kill',
  perspective: 'kill',
  seconds: 2_517.4,
  actor_id: 'fallen-id',
  actor_name: 'FalleN',
  target_id: 'niko-id',
  target_name: 'NiKo',
  weapon: 'ak47',
  headshot: true,
  penetrated: false,
  damage: null,
};

describe('duel evidence action contract', () => {
  it('carries canonical evidence into Round, Replay, Watch, and Add actions', () => {
    const result = duelEvidenceActionContract(workspace, 'fallen-id', evidence, {
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
        round: 20,
        tick: 161_114,
        playerId: 'fallen-id',
        evidenceId: evidence.evidence_id,
      },
    });
    expect(result.replay.navigation).toMatchObject({
      tab: 'replay',
      evidenceId: evidence.evidence_id,
    });
    expect(result.watch).toEqual({ available: true, reason: null, start_tick: 161_114 });
    expect(result.add.available).toBe(true);
    expect(result.add.compilation).toMatchObject({
      id: evidence.evidence_id,
      playerId: 'fallen-id',
      startTick: 161_114,
      endTick: 161_115,
    });
  });

  it('gives concrete availability reasons for busy playback, repeated Add, and stale rounds', () => {
    const blocked = duelEvidenceActionContract(workspace, 'fallen-id', evidence, {
      serviceAvailable: true,
      runtimeIdle: false,
      watchPending: false,
      alreadyAdded: true,
    });

    expect(blocked.watch).toMatchObject({
      available: false,
      reason: 'Watch is unavailable while another playback or capture session is active.',
    });
    expect(blocked.add).toMatchObject({
      available: false,
      reason: 'This evidence is already in the production plan.',
    });

    const missingRound = duelEvidenceActionContract(workspace, 'fallen-id', {
      ...evidence,
      round: 99,
      tick: 999,
    }, {
      serviceAvailable: true,
      runtimeIdle: true,
      watchPending: false,
      alreadyAdded: false,
    });
    expect(missingRound.round).toMatchObject({
      available: false,
      reason: 'Round 99 is not present in this analysis.',
    });
    expect(missingRound.replay.available).toBe(false);
    expect(missingRound.watch.available).toBe(false);
  });
});
