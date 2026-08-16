import { describe, expect, it } from 'vitest';

import type { AnalysisWorkspace } from '../../shared/desktop/viewModels';
import type { PlayerEvidenceRef } from './playerMatchEvidence';
import { playerEvidenceActionIntent } from './playerEvidenceActions';

function workspace(): AnalysisWorkspace {
  return {
    demo_id: 'major-final-map-1',
    map_name: 'de_mirage',
    tick_rate: 64,
    duration_seconds: 2_958,
    teams: [],
    players: [
      { id: 'fallen-id', name: 'FalleN', team: 'A', kills: 4, deaths: 1, assists: 0, headshot_rate: 0.25, kill_death_ratio: 4, adr: 120 },
      { id: 'niko-id', name: 'NiKo', team: 'B', kills: 1, deaths: 4, assists: 0, headshot_rate: 0.5, kill_death_ratio: 0.25, adr: 70 },
    ],
    rounds: [{
      number: 20,
      winner: 'A',
      reason: 'elimination',
      start_tick: 156_234,
      end_tick: 161_310,
      team_a_score: 8,
      team_b_score: 12,
      events: [{
        id: 'kill-160986',
        tick: 160_986,
        seconds: 2_515.40625,
        kind: 'kill',
        actor: 'fallen-id',
        target: 'niko-id',
        weapon: 'awp',
        headshot: false,
        penetrated: false,
        position: null,
        detail: {},
      }],
    }],
    highlights: [{
      id: 'fallen-r20-4k',
      label: 'FalleN 4K',
      category: 'multi-kill',
      kind: 'multi_kill',
      description: 'Four verified kills in round 20',
      tags: ['4k'],
      victims: ['NiKo'],
      player_id: 'fallen-id',
      round: 20,
      start_tick: 160_986,
      end_tick: 161_310,
      confidence: 1,
    }],
  };
}

function evidence(overrides: Partial<PlayerEvidenceRef> = {}): PlayerEvidenceRef {
  return {
    evidence_id: 'demo:major-final-map-1/event:kill-160986',
    demo_id: 'major-final-map-1',
    source_kind: 'event',
    source_id: 'kill-160986',
    round: 20,
    tick: 160_986,
    end_tick: null,
    ...overrides,
  };
}

describe('player evidence actions', () => {
  it('turns one atomic kill into exact watch, replay, and production intents', () => {
    const intent = playerEvidenceActionIntent(workspace(), 'fallen-id', evidence());

    expect(intent.watch).toEqual({ start_tick: 160_986 });
    expect(intent.replay).toEqual({
      tab: 'replay',
      round: 20,
      tick: 160_986,
      playerId: 'fallen-id',
      evidenceId: 'demo:major-final-map-1/event:kill-160986',
    });
    expect(intent.compilation).toEqual({
      id: 'demo:major-final-map-1/event:kill-160986',
      title: 'Kill · FalleN → NiKo · AWP',
      playerId: 'fallen-id',
      startTick: 160_986,
      endTick: 160_987,
      category: 'entry',
    });
  });

  it('preserves the authoritative highlight identity and interval', () => {
    const intent = playerEvidenceActionIntent(workspace(), 'fallen-id', evidence({
      evidence_id: 'demo:major-final-map-1/highlight:fallen-r20-4k',
      source_kind: 'highlight',
      source_id: 'fallen-r20-4k',
      end_tick: 161_310,
    }));

    expect(intent.compilation).toEqual({
      id: 'demo:major-final-map-1/highlight:fallen-r20-4k',
      title: 'FalleN 4K',
      playerId: 'fallen-id',
      startTick: 160_986,
      endTick: 161_310,
      category: 'multi-kill',
      highlightId: 'fallen-r20-4k',
      hasVictimPov: true,
    });
  });

  it('fails soft for a valid projection without inventing an event', () => {
    const intent = playerEvidenceActionIntent(workspace(), 'fallen-id', evidence({
      evidence_id: 'demo:major-final-map-1/projection:utility-20',
      source_kind: 'projection',
      source_id: 'utility-20',
      tick: 159_000,
      end_tick: 159_128,
    }));

    expect(intent.compilation).toMatchObject({
      id: 'demo:major-final-map-1/projection:utility-20',
      title: 'FalleN · Round 20 evidence',
      category: 'custom',
      startTick: 159_000,
      endTick: 159_128,
    });
  });
});
