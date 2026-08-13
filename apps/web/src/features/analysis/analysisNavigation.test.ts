import { describe, expect, it } from 'vitest';

import {
  frameIndexAtTick,
  readAnalysisNavigation,
  readAnalysisOpponent,
  updateAnalysisNavigation,
} from './analysisNavigation';

describe('analysis URL navigation', () => {
  it('defaults invalid or absent navigation to the overview and first round', () => {
    expect(readAnalysisNavigation(new URLSearchParams('tab=unknown&round=zero'))).toEqual({
      tab: 'overview',
      round: 1,
      playerId: null,
      tick: null,
      evidenceId: null,
    });
  });

  it('bounds round and player navigation to evidence available in the workspace', () => {
    const bounds = { roundNumbers: [1, 2, 20], playerIds: ['p1', 'p2'] };

    expect(readAnalysisNavigation(new URLSearchParams('tab=rounds&round=99&player=missing'), bounds)).toEqual({
      tab: 'rounds',
      round: 20,
      playerId: 'p1',
      tick: null,
      evidenceId: null,
    });
    expect(readAnalysisNavigation(new URLSearchParams('tab=replay&round=20&player=p2'), bounds)).toEqual({
      tab: 'replay',
      round: 20,
      playerId: 'p2',
      tick: null,
      evidenceId: null,
    });
  });

  it('accepts the weapon evidence workspace as a stable deep-linkable analysis tab', () => {
    expect(readAnalysisNavigation(new URLSearchParams('tab=weapons&round=20&player=p2'), {
      roundNumbers: [20],
      playerIds: ['p1', 'p2'],
    })).toMatchObject({ tab: 'weapons', round: 20, playerId: 'p2' });
  });

  it('accepts the duel evidence workspace as a stable deep-linkable analysis tab', () => {
    const params = new URLSearchParams('tab=duels&round=20&player=p2&opponent=p1');
    expect(readAnalysisNavigation(params, {
      roundNumbers: [20],
      playerIds: ['p1', 'p2'],
    })).toMatchObject({ tab: 'duels', round: 20, playerId: 'p2' });
    expect(readAnalysisOpponent(params, ['p1', 'p2'])).toBe('p1');
  });

  it('preserves a duel opponent across round filters and clears it when the selected player changes', () => {
    const current = new URLSearchParams(
      'demo=d1&tab=duels&round=20&player=p2&opponent=p1&evidence=demo%3Ad1%2Fevent%3Akill-1',
    );

    expect(updateAnalysisNavigation(current, { round: 21 }).toString()).toBe(
      'demo=d1&tab=duels&round=21&player=p2&opponent=p1',
    );
    expect(updateAnalysisNavigation(current, { playerId: 'p1' }).toString()).toBe(
      'demo=d1&tab=duels&round=20&player=p1',
    );
  });

  it('accepts the utility evidence workspace as a stable deep-linkable analysis tab', () => {
    expect(readAnalysisNavigation(new URLSearchParams('tab=utility&round=20&player=p2'), {
      roundNumbers: [20],
      playerIds: ['p1', 'p2'],
    })).toMatchObject({ tab: 'utility', round: 20, playerId: 'p2' });
  });

  it('accepts the economy evidence workspace as a stable deep-linkable analysis tab', () => {
    expect(readAnalysisNavigation(new URLSearchParams('tab=economy&round=20&player=p2'), {
      roundNumbers: [20],
      playerIds: ['p1', 'p2'],
    })).toMatchObject({ tab: 'economy', round: 20, playerId: 'p2' });
  });

  it('preserves Demo, batch, round, and player context when switching analysis tabs', () => {
    const current = new URLSearchParams('demo=d1&demos=d1%2Cd2&tab=rounds&round=20&player=p2');

    expect(updateAnalysisNavigation(current, { tab: 'replay' }).toString()).toBe(
      'demo=d1&demos=d1%2Cd2&tab=replay&round=20&player=p2',
    );
    expect(current.get('tab')).toBe('rounds');
  });

  it('opens replay on the first available frame for the selected round', () => {
    expect(frameIndexAtTick([50, 110, 180, 250], 100)).toBe(1);
    expect(frameIndexAtTick([50, 110, 180, 250], 300)).toBe(3);
    expect(frameIndexAtTick([], 100)).toBe(0);
  });

  it('accepts an exact replay tick only inside the selected round', () => {
    const bounds = {
      roundNumbers: [1, 2],
      playerIds: ['p1'],
      roundTickRanges: [
        { number: 1, startTick: 100, endTick: 200 },
        { number: 2, startTick: 201, endTick: 300 },
      ],
    };

    expect(readAnalysisNavigation(new URLSearchParams('tab=replay&round=2&tick=250'), bounds).tick).toBe(250);
    expect(readAnalysisNavigation(new URLSearchParams('tab=replay&round=2&tick=150'), bounds).tick).toBeNull();
  });

  it('drops a stale tick when changing rounds and preserves an explicit highlight tick', () => {
    const current = new URLSearchParams('demo=d1&tab=replay&round=1&player=p1&tick=150');

    expect(updateAnalysisNavigation(current, { round: 2 }).toString()).toBe(
      'demo=d1&tab=replay&round=2&player=p1',
    );
    expect(updateAnalysisNavigation(current, { round: 2, tick: 250 }).toString()).toBe(
      'demo=d1&tab=replay&round=2&player=p1&tick=250',
    );
  });

  it('removes round-scoped focus when a workspace switches to all rounds', () => {
    const current = new URLSearchParams(
      'demo=d1&tab=heatmap&round=20&player=p1&tick=160986&evidence=demo%3Ad1%2Fevent%3Akill-160986',
    );

    expect(updateAnalysisNavigation(current, { round: null }).toString()).toBe(
      'demo=d1&tab=heatmap&player=p1',
    );
  });

  it('preserves a stable evidence focus while moving between round and replay views', () => {
    const current = new URLSearchParams(
      'demo=d1&tab=rounds&round=20&player=p1&tick=160986&evidence=demo%3Ad1%2Fevent%3Akill-160986',
    );

    expect(readAnalysisNavigation(current, {
      roundNumbers: [20],
      playerIds: ['p1'],
      roundTickRanges: [{ number: 20, startTick: 156234, endTick: 161310 }],
    }).evidenceId).toBe('demo:d1/event:kill-160986');
    expect(updateAnalysisNavigation(current, { tab: 'replay' }).get('evidence')).toBe(
      'demo:d1/event:kill-160986',
    );
    expect(updateAnalysisNavigation(current, { evidenceId: null }).has('evidence')).toBe(false);
    expect(updateAnalysisNavigation(current, { round: 21 }).has('evidence')).toBe(false);
    expect(updateAnalysisNavigation(current, { playerId: 'p2' }).has('evidence')).toBe(false);
  });
});
