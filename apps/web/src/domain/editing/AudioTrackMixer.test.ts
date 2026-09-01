import { describe, expect, it } from 'vitest';

import type { TimelineTrack } from '../../shared/desktop/dto';
import { applyMixerAutomation } from './AudioTrackMixer';

const track: TimelineTrack = {
  id: 'track', name: 'A1', kind: 'audio', order: 0, muted: false, solo: false,
  volume: 1, pan: 0, locked: false, hidden: false, clips: [],
  keyframes: [{ id: 'future', time: 8, property: 'volume', value: 0.5, interpolation: 'linear', in_tangent: 0, out_tangent: 0 }],
};

describe('Track Mixer automation modes', () => {
  it('keeps Read immutable and Off on the static track value', () => {
    expect(applyMixerAutomation(track, 'read', 'volume', 4, 10, 2, 60, () => 'x')).toBe(track);
    expect(applyMixerAutomation(track, 'off', 'volume', 4, 10, 2, 60, () => 'x').volume).toBe(2);
  });

  it('uses Touch for one point, Write for the remaining pass and Latch for the future', () => {
    const touch = applyMixerAutomation(track, 'touch', 'volume', 4, 10, 2, 60, () => 'touch');
    expect(touch.keyframes.map((keyframe) => [keyframe.id, keyframe.time, keyframe.value])).toEqual([
      ['touch', 4, 2],
      ['future', 8, 0.5],
    ]);
    const write = applyMixerAutomation(track, 'write', 'volume', 4, 10, 2, 60, (() => { let id = 0; return () => `write-${++id}`; })());
    expect(write.keyframes.map((keyframe) => [keyframe.time, keyframe.value])).toEqual([[4, 2], [10, 2]]);
    const latch = applyMixerAutomation(track, 'latch', 'volume', 4, 10, 2, 60, (() => { let id = 0; return () => `latch-${++id}`; })());
    expect(latch.keyframes.map((keyframe) => [keyframe.time, keyframe.value])).toEqual([[4, 2], [10, 2]]);
  });
});
