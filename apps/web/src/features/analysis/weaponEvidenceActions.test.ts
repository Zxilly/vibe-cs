import { describe, expect, it } from 'vitest';

import type { AnalysisWorkspace } from '../../shared/desktop/viewModels';
import type { WeaponAtomicEvidence } from './weaponEvidenceWorkspace';
import { weaponEvidenceActionContract } from './weaponEvidenceActions';

const workspace: AnalysisWorkspace = {
  demo_id: 'major-final-map-1',
  map_name: 'de_mirage',
  tick_rate: 64,
  duration_seconds: 2_958,
  teams: [],
  players: [
    { id: 'fallen-id', name: 'FalleN', team: 'A', kills: 1, deaths: 0, assists: 0, headshot_rate: 1, kill_death_ratio: 1, adr: 100 },
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
      id: 'kill-ak',
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

const evidence: WeaponAtomicEvidence = {
  evidence_id: 'demo:major-final-map-1/event:kill-ak',
  demo_id: 'major-final-map-1',
  source_kind: 'event',
  source_id: 'kill-ak',
  round: 20,
  tick: 161_114,
  end_tick: null,
  event_kind: 'kill',
  seconds: 2_517.4,
  actor_id: 'fallen-id',
  actor_name: 'FalleN',
  target_id: 'niko-id',
  target_name: 'NiKo',
  weapon: 'ak47',
  damage: null,
  headshot: true,
  penetrated: false,
};

describe('weapon evidence actions', () => {
  it('exposes exact Round, Replay, Watch, and production intents with an explicit Watch reason', () => {
    const contract = weaponEvidenceActionContract(workspace, evidence, {
      serviceAvailable: false,
      runtimeIdle: true,
      watchPending: false,
      alreadyAdded: false,
    });

    expect(contract.round).toEqual({
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
    expect(contract.replay.navigation).toMatchObject({ tab: 'replay', round: 20, tick: 161_114 });
    expect(contract.watch).toEqual({
      available: false,
      reason: 'Watch requires an analyzed local demo.',
      start_tick: 161_114,
    });
    expect(contract.add.available).toBe(true);
    expect(contract.add.reason).toBeNull();
    expect(contract.add.compilation).toMatchObject({
      id: evidence.evidence_id,
      playerId: 'fallen-id',
      startTick: 161_114,
      endTick: 161_115,
    });
  });

  it('does not enable actions when their round or actor evidence cannot be verified', () => {
    const contract = weaponEvidenceActionContract(workspace, {
      ...evidence,
      actor_id: 'unresolved-player',
      actor_name: 'Unknown',
      round: 99,
    }, {
      serviceAvailable: true,
      runtimeIdle: true,
      watchPending: false,
      alreadyAdded: false,
    });

    expect(contract.round).toMatchObject({
      available: false,
      reason: 'Round 99 is not present in this analysis.',
    });
    expect(contract.replay).toMatchObject({
      available: false,
      reason: 'Round 99 is not present in this analysis.',
    });
    expect(contract.watch).toMatchObject({
      available: false,
      reason: 'Round 99 is not present in this analysis.',
    });
    expect(contract.add).toEqual({
      available: false,
      reason: 'A verified actor is required before this evidence can be added to production.',
      compilation: null,
    });
  });
});
