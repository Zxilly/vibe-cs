import { describe, expect, it } from 'vitest';

import type { AnalysisWorkspace } from '../../shared/desktop/dto';
import type { OpeningDuelEvidence } from './openingDuelWorkspace';
import { openingDuelEvidenceActionContract } from './openingDuelEvidenceActions';

const workspace: AnalysisWorkspace = {
  demo_id: 'major-final-map-1',
  map_name: 'de_mirage',
  tick_rate: 64,
  duration_seconds: 2_958,
  teams: [],
  players: [
    { id: 'fallen-id', name: 'FalleN', team: 'A', kills: 1, deaths: 0, assists: 0, headshot_rate: 1, kill_death_ratio: 1, adr: 80 },
    { id: 'niko-id', name: 'NiKo', team: 'B', kills: 0, deaths: 1, assists: 0, headshot_rate: 0, kill_death_ratio: 0, adr: 60 },
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
      id: 'opening-kill',
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
    }, {
      id: 'later-kill',
      tick: 161_300,
      seconds: 2_520.3,
      kind: 'kill',
      actor: 'niko-id',
      target: 'fallen-id',
      weapon: 'awp',
      headshot: false,
      penetrated: false,
      position: null,
      detail: {},
    }],
  }],
  highlights: [],
};

const evidence: OpeningDuelEvidence = {
  evidence_id: 'demo:major-final-map-1/event:opening-kill',
  demo_id: 'major-final-map-1',
  source_kind: 'event',
  source_id: 'opening-kill',
  round: 20,
  tick: 161_114,
  end_tick: null,
  event_kind: 'kill',
  seconds: 2_517.4,
  actor_id: 'fallen-id',
  actor_name: 'FalleN',
  actor_team: 'A',
  target_id: 'niko-id',
  target_name: 'NiKo',
  target_team: 'B',
  weapon: 'ak47',
  headshot: true,
  penetrated: false,
  position: null,
};

describe('opening duel evidence action contract', () => {
  it('carries canonical evidence through Round, Replay, Watch, and Add', () => {
    const result = openingDuelEvidenceActionContract(workspace, 'niko-id', evidence, {
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
        playerId: 'niko-id',
        evidenceId: evidence.evidence_id,
      },
    });
    expect(result.replay.navigation).toMatchObject({
      tab: 'replay',
      evidenceId: evidence.evidence_id,
    });
    expect(result.watch).toEqual({ available: true, reason: null, start_tick: 161_114 });
    expect(result.add).toMatchObject({
      available: true,
      reason: null,
      compilation: {
        id: evidence.evidence_id,
        playerId: 'niko-id',
        startTick: 161_114,
        endTick: 161_115,
      },
    });
  });

  it('fails closed with concrete reasons when canonical source or runtime is unavailable', () => {
    const stale = openingDuelEvidenceActionContract(workspace, null, {
      ...evidence,
      source_id: 'missing-event',
    }, {
      serviceAvailable: true,
      runtimeIdle: true,
      watchPending: false,
      alreadyAdded: false,
    });
    expect(stale.round).toMatchObject({
      available: false,
      reason: 'The canonical opening kill event is not present at this round and tick.',
    });
    expect(stale.replay.available).toBe(false);
    expect(stale.watch.available).toBe(false);
    expect(stale.add.available).toBe(false);

    const blocked = openingDuelEvidenceActionContract(workspace, null, evidence, {
      serviceAvailable: true,
      runtimeIdle: false,
      watchPending: false,
      alreadyAdded: true,
    });
    expect(blocked.watch.reason).toBe(
      'Watch is unavailable while another playback or capture session is active.',
    );
    expect(blocked.add.reason).toBe('This evidence is already in the production plan.');
    expect(blocked.add.compilation?.playerId).toBe('fallen-id');
  });

  it('rejects a later kill and participant mutations even when their source event exists', () => {
    const laterKill = openingDuelEvidenceActionContract(workspace, null, {
      ...evidence,
      evidence_id: 'demo:major-final-map-1/event:later-kill',
      source_id: 'later-kill',
      tick: 161_300,
      seconds: 2_520.3,
      actor_id: 'niko-id',
      actor_name: 'NiKo',
      actor_team: 'B',
      target_id: 'fallen-id',
      target_name: 'FalleN',
      target_team: 'A',
      weapon: 'awp',
      headshot: false,
    }, {
      serviceAvailable: true,
      runtimeIdle: true,
      watchPending: false,
      alreadyAdded: false,
    });
    expect(laterKill.watch).toMatchObject({
      available: false,
      reason: 'The canonical opening kill event is not present at this round and tick.',
    });
    expect(laterKill.add.compilation).toBeNull();

    const mutatedParticipant = openingDuelEvidenceActionContract(workspace, null, {
      ...evidence,
      actor_id: 'niko-id',
      actor_name: 'NiKo',
      actor_team: 'B',
      target_id: 'fallen-id',
      target_name: 'FalleN',
      target_team: 'A',
    }, {
      serviceAvailable: true,
      runtimeIdle: true,
      watchPending: false,
      alreadyAdded: false,
    });
    expect(mutatedParticipant.round.available).toBe(false);
    expect(mutatedParticipant.add.compilation).toBeNull();
  });
});
