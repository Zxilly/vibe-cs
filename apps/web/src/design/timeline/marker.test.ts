import { describe, expect, it } from 'vitest';
import { clusterTimelinePins } from './marker';
import { createTimeScale } from './timeScale';

describe('dense timeline review pins', () => {
  it('keeps every change available while preventing overlapping pin targets', () => {
    const changes = [0, 0, 1, 2.5, 4, 6, 7, 8].map((time, id) => ({ time, id }));
    const pins = clusterTimelinePins(changes, (change) => change.time, createTimeScale(1));
    expect(pins.flatMap((pin) => pin.items)).toEqual(changes);
    expect(pins[0]?.items).toHaveLength(4);
    expect(pins.every((pin, index) => index === 0 || pin.left - pins[index - 1]!.left >= 32)).toBe(true);
  });

  it('separates short neighboring edits when zooming into their time range', () => {
    const changes = [0, 1, 2];
    expect(clusterTimelinePins(changes, (time) => time, createTimeScale(0.25))).toHaveLength(1);
    expect(clusterTimelinePins(changes, (time) => time, createTimeScale(4))).toHaveLength(3);
  });
});
