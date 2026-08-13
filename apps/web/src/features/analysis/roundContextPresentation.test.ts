import { describe, expect, it } from 'vitest';

import {
  evidenceRangeGroupId,
  roundNumberFromNavigationKey,
  roundSectionIsVisible,
  roundTickPercent,
  selectedGroupScrollTop,
  selectedRoundGroupId,
  tickDurationLabel,
} from './roundContextPresentation';

describe('round context canvas presentation', () => {
  it('focuses the actor evidence group when a highlight deep link includes pre-roll outside the atomic encounter', () => {
    const groups = [
      { id: 'utility-before', startTick: 158_033, endTick: 158_033, actorIds: ['yuurih'] },
      { id: 'fallen-4k', startTick: 161_101, endTick: 161_310, actorIds: ['FalleN', 'NiKo'] },
    ];

    expect(evidenceRangeGroupId(groups, 160_986, 161_502, 'FalleN')).toBe('fallen-4k');
  });

  it('keeps an explicit encounter selection and otherwise falls back to focused then first evidence', () => {
    const groupIds = ['encounter-1', 'objective-1', 'economy-1'];

    expect(selectedRoundGroupId(groupIds, 'objective-1', 'encounter-1')).toBe('objective-1');
    expect(selectedRoundGroupId(groupIds, 'missing', 'encounter-1')).toBe('encounter-1');
    expect(selectedRoundGroupId(groupIds, null, 'missing')).toBe('encounter-1');
    expect(selectedRoundGroupId([], null, null)).toBeNull();
  });

  it('scrolls an oversized selected encounter to its summary instead of leaving it below the viewport', () => {
    expect(selectedGroupScrollTop(0, 101, 167, 677)).toBe(159);
    expect(selectedGroupScrollTop(159, 101, 167, 677)).toBe(159);
    expect(selectedGroupScrollTop(120, 180, 140, 80)).toBe(120);
  });

  it('positions exact evidence ticks inside the selected round without overflowing the ruler', () => {
    expect(roundTickPercent(160_986, 156_234, 161_310)).toBeCloseTo(93.617, 2);
    expect(roundTickPercent(150_000, 156_234, 161_310)).toBe(0);
    expect(roundTickPercent(170_000, 156_234, 161_310)).toBe(100);
    expect(roundTickPercent(10, 10, 10)).toBe(0);
  });

  it('formats compact evidence-window durations from the authoritative tick rate', () => {
    expect(tickDurationLabel(161_101, 161_310, 64)).toBe('3.3s');
    expect(tickDurationLabel(0, 768, 64)).toBe('12s');
    expect(tickDurationLabel(0, 768, 0)).toBe('—');
  });

  it('moves the round tab focus without escaping the filtered round strip', () => {
    const rounds = [9, 10, 11, 12, 14, 18, 19, 20];

    expect(roundNumberFromNavigationKey(rounds, 20, 'ArrowLeft')).toBe(19);
    expect(roundNumberFromNavigationKey(rounds, 20, 'ArrowRight')).toBe(20);
    expect(roundNumberFromNavigationKey(rounds, 11, 'Home')).toBe(9);
    expect(roundNumberFromNavigationKey(rounds, 11, 'End')).toBe(20);
    expect(roundNumberFromNavigationKey(rounds, 11, 'Enter')).toBeNull();
  });

  it('does not render an empty section as if the selected evidence filter had results', () => {
    expect(roundSectionIsVisible('objective', 0, 'objectives')).toBe(false);
    expect(roundSectionIsVisible('objective', 2, 'objectives')).toBe(true);
    expect(roundSectionIsVisible('economy', 2, 'objectives')).toBe(false);
    expect(roundSectionIsVisible('utility', 1, 'all')).toBe(true);
  });
});
