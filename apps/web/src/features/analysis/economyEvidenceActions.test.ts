import { describe, expect, it } from 'vitest';

import type { AnalysisWorkspace } from '../../shared/desktop/dto';
import type { EconomyAtomicEvidence } from './economyEvidenceWorkspace';
import { economyEvidenceActionContract } from './economyEvidenceActions';

const workspace: AnalysisWorkspace = {
  demo_id: 'major-final-map-1',
  map_name: 'de_mirage',
  tick_rate: 64,
  duration_seconds: 2_958,
  teams: [],
  players: [
    { id: 'fallen-id', name: 'FalleN', team: 'A', kills: 1, deaths: 1, assists: 0, headshot_rate: 0.5, kill_death_ratio: 1, adr: 80 },
  ],
  rounds: [{
    number: 13,
    winner: 'A',
    reason: 'elimination',
    start_tick: 13_000,
    end_tick: 14_000,
    team_a_score: 7,
    team_b_score: 6,
    events: [{
      id: 'item_purchase-13100-1',
      tick: 13_100,
      seconds: 204.6875,
      kind: 'purchase',
      actor: 'fallen-id',
      target: null,
      weapon: 'weapon_m4a1_silencer',
      headshot: false,
      penetrated: false,
      position: null,
      detail: { team: 3, price: 2_900 },
    }],
  }],
  highlights: [],
};

const evidence: EconomyAtomicEvidence = {
  evidence_id: 'demo:major-final-map-1/event:item_purchase-13100-1',
  demo_id: 'major-final-map-1',
  source_kind: 'event',
  source_id: 'item_purchase-13100-1',
  round: 13,
  tick: 13_100,
  end_tick: null,
  event_kind: 'purchase',
  seconds: 204.6875,
  actor_id: 'fallen-id',
  actor_name: 'FalleN',
  side: 'CT',
  item: 'm4a1_silencer',
  cost: 2_900,
};

describe('economy evidence action contract', () => {
  it('carries a canonical locatable purchase into Round, Replay, Watch, and Add', () => {
    const result = economyEvidenceActionContract(workspace, evidence, {
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
        round: 13,
        tick: 13_100,
        playerId: 'fallen-id',
        evidenceId: evidence.evidence_id,
      },
    });
    expect(result.replay.navigation).toMatchObject({
      tab: 'replay',
      evidenceId: evidence.evidence_id,
    });
    expect(result.watch).toEqual({ available: true, reason: null, start_tick: 13_100 });
    expect(result.add).toMatchObject({
      available: true,
      reason: null,
      compilation: {
        id: evidence.evidence_id,
        title: 'Purchase · M4A1_SILENCER · FalleN · Round 13',
        playerId: 'fallen-id',
        startTick: 13_100,
        endTick: 13_101,
        category: 'custom',
      },
    });
  });

  it('blocks every action when purchase evidence no longer matches its source event', () => {
    const result = economyEvidenceActionContract(workspace, {
      ...evidence,
      actor_id: 'forged-player-id',
      actor_name: 'Forged player',
    }, {
      serviceAvailable: true,
      runtimeIdle: true,
      watchPending: false,
      alreadyAdded: false,
    });

    for (const action of [result.round, result.replay, result.watch, result.add]) {
      expect(action).toMatchObject({
        available: false,
        reason: 'This purchase evidence is not locatable in the current analysis.',
      });
    }
    expect(result.add.compilation).toBeNull();
  });
});
