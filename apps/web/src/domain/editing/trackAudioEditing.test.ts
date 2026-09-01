import { describe, expect, it } from 'vitest';

import type { TimelineTrack } from '../../shared/desktop/dto';
import {
  evaluateTrackAudioProperty,
  moveTrackAudioKeyframe,
  removeTrackAudioKeyframe,
  setTrackAudioAtTime,
  upsertTrackAudioKeyframe,
} from './trackAudioEditing';

function track(): TimelineTrack {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    name: 'A1',
    kind: 'audio',
    order: 1,
    muted: false,
    solo: false,
    volume: 1,
    pan: 0,
    keyframes: [],
    locked: false,
    hidden: false,
    clips: [],
  };
}

describe('track audio automation', () => {
  it('edits the static property before automation exists', () => {
    expect(setTrackAudioAtTime(track(), 'volume', 2, 2, 60, 'volume').volume).toBe(2);
    expect(setTrackAudioAtTime(track(), 'pan', 2, -2, 60, 'pan').pan).toBe(-1);
  });

  it('interpolates frame-aligned volume and pan keyframes', () => {
    const automated = upsertTrackAudioKeyframe(
      upsertTrackAudioKeyframe(track(), 'volume', 0, 0, 60, 'start'),
      'volume',
      2,
      2,
      60,
      'end',
    );
    expect(evaluateTrackAudioProperty(automated, 'volume', 1)).toBe(1);
    expect(setTrackAudioAtTime(automated, 'volume', 1, 3, 60, 'middle').keyframes).toHaveLength(3);
  });

  it('moves, merges and removes automation points by stable identity', () => {
    const automated = upsertTrackAudioKeyframe(
      upsertTrackAudioKeyframe(track(), 'pan', 1, -1, 60, 'left'),
      'pan',
      2,
      1,
      60,
      'right',
    );
    const merged = moveTrackAudioKeyframe(automated, 'left', 2, 0, 60);
    expect(merged.keyframes).toEqual([{ id: 'right', time: 2, property: 'pan', value: 0 }]);
    expect(removeTrackAudioKeyframe(merged, 'pan', 2, 60).keyframes).toEqual([]);
  });
});
