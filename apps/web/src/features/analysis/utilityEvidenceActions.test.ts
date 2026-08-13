import { describe, expect, it } from 'vitest';

import type { AnalysisWorkspace } from '../../shared/desktop/dto';
import { utilityEvidenceActionContract } from './utilityEvidenceActions';
import type { UtilityAtomicEvidence } from './utilityEvidenceWorkspace';

const workspace: AnalysisWorkspace = {
  demo_id: 'major-final-map-1',
  map_name: 'de_mirage',
  tick_rate: 64,
  duration_seconds: 2_900,
  teams: [],
  players: [
    { id: 'alice-id', name: 'Alice', team: 'A', kills: 1, deaths: 0, assists: 0, headshot_rate: 1, kill_death_ratio: 1, adr: 82 },
  ],
  rounds: [{
    number: 20,
    winner: 'A',
    reason: 'elimination',
    start_tick: 100,
    end_tick: 200,
    team_a_score: 12,
    team_b_score: 8,
    events: [{
      id: 'grenade_thrown-120-1',
      tick: 120,
      seconds: 1.875,
      kind: 'grenade',
      actor: 'alice-id',
      target: null,
      weapon: 'weapon_smokegrenade',
      headshot: false,
      penetrated: false,
      position: null,
      detail: {},
    }],
  }],
  highlights: [],
};

const evidence: UtilityAtomicEvidence = {
  evidence_id: 'demo:major-final-map-1/event:grenade_thrown-120-1',
  demo_id: 'major-final-map-1',
  source_kind: 'event',
  source_id: 'grenade_thrown-120-1',
  round: 20,
  tick: 120,
  end_tick: null,
  event_kind: 'grenade',
  phase: 'throw_event',
  utility_type: 'smoke',
  seconds: 1.875,
  actor_id: 'alice-id',
  actor_name: 'Alice',
  target_id: null,
  target_name: null,
  weapon: 'smokegrenade',
  position: null,
  damage: null,
  blind_duration_seconds: null,
};

describe('utility evidence actions', () => {
  it('keeps Round and Replay anchored to the canonical evidence and creates a utility compilation', () => {
    const result = utilityEvidenceActionContract(workspace, evidence, {
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
        tick: 120,
        playerId: 'alice-id',
        evidenceId: evidence.evidence_id,
      },
    });
    expect(result.replay.navigation).toEqual({
      tab: 'replay',
      round: 20,
      tick: 120,
      playerId: 'alice-id',
      evidenceId: evidence.evidence_id,
    });
    expect(result.watch).toEqual({ available: true, reason: null, start_tick: 120 });
    expect(result.add.compilation).toMatchObject({
      id: evidence.evidence_id,
      playerId: 'alice-id',
      startTick: 120,
      endTick: 121,
      category: 'utility',
    });
  });

  it('explains unavailable Watch and Add states without inventing an actor', () => {
    const result = utilityEvidenceActionContract(
      workspace,
      { ...evidence, actor_id: null, actor_name: null },
      {
        serviceAvailable: false,
        runtimeIdle: false,
        watchPending: false,
        alreadyAdded: false,
      },
    );

    expect(result.watch).toEqual({
      available: false,
      reason: 'Watch requires an analyzed local demo.',
      start_tick: 120,
    });
    expect(result.add).toEqual({
      available: false,
      reason: 'A verified utility actor is required before this evidence can be added to production.',
      compilation: null,
    });
  });
});
