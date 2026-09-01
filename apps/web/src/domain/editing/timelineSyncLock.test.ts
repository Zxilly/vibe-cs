import { describe, expect, it } from 'vitest';

import type { TimelineClip, TimelineTrack } from '../../shared/desktop/dto';
import {
  expandSyncLockedStoryRippleUpdates,
  planSyncLockedStoryRipple,
  storyRippleTimeAnchors,
} from './timelineSyncLock';

function clip(id: string, start: number, duration: number): TimelineClip {
  return {
    id,
    name: id,
    capture_intent: null,
    material: { kind: 'planned' },
    placement: { start, duration, source_in: 0, source_out: duration, speed: 1, reverse: false, frame_hold_source_time: null, volume: 1, pan: 0, enabled: true },
    transform: { x: 0, y: 0, scale_x: 1, scale_y: 1, rotation: 0, opacity: 1 },
    effects: [],
    transitions: { video_in: null, video_out: null, audio_in: null, audio_out: null },
    text: null,
    metadata: {},
    group_id: null,
    link_group_id: null,
    keyframes: [],
    speed_segments: [],
  };
}

function track(id: string, clips: readonly TimelineClip[], locked = false): TimelineTrack {
  return {
    id,
    name: id,
    kind: 'video',
    order: 0,
    muted: false,
    solo: false,
    volume: 1,
    pan: 0,
    keyframes: [],
    locked,
    hidden: false,
    clips: [...clips],
  };
}

describe('Timeline Sync Lock', () => {
  it('derives cumulative offsets from stable Story clip identities', () => {
    const before = [clip('a', 0, 5), clip('b', 5, 5), clip('c', 10, 5), clip('d', 15, 5)];
    const after = [clip('b', 0, 5), clip('d', 5, 5)];

    expect(storyRippleTimeAnchors(before, after, 60)).toEqual([
      { time: 5, offset: -5 },
      { time: 15, offset: -10 },
    ]);
  });

  it('shifts only eligible clips that begin after each Story ripple boundary', () => {
    const story = track('story', [clip('a', 0, 5), clip('b', 5, 5), clip('c', 10, 5)]);
    const synced = track('synced', [clip('crossing', 4, 3), clip('late', 11, 1)]);
    const disabled = track('disabled', [clip('still', 11, 1)]);
    const locked = track('locked', [clip('locked-clip', 11, 1)], true);

    expect(planSyncLockedStoryRipple({
      tracks: [story, synced, disabled, locked],
      storyTrackId: story.id,
      nextStoryClips: [clip('b', 0, 5), clip('c', 5, 5)],
      syncLockedTrackIds: new Set([synced.id, locked.id]),
      directlyEditedTrackIds: new Set([story.id]),
      fps: 60,
    })).toEqual([{
      trackId: synced.id,
      clips: [clip('crossing', 4, 3), clip('late', 6, 1)],
    }]);
  });

  it('does not reinterpret a Story reorder as a Timeline ripple', () => {
    const before = [clip('a', 0, 5), clip('b', 5, 5)];
    const after = [clip('b', 0, 5), clip('a', 5, 5)];
    expect(storyRippleTimeAnchors(before, after, 60)).toEqual([]);
  });

  it('merges Sync Lock shifts into one ordered multi-track update', () => {
    const story = track('story', [clip('a', 0, 5), clip('b', 5, 5)]);
    const synced = track('synced', [clip('late', 6, 1)]);
    expect(expandSyncLockedStoryRippleUpdates({
      tracks: [story, synced],
      storyTrackId: story.id,
      updates: [{ trackId: story.id, clips: [clip('b', 0, 5)] }],
      syncLockedTrackIds: new Set([synced.id]),
      fps: 60,
    })).toEqual([
      { trackId: story.id, clips: [clip('b', 0, 5)] },
      { trackId: synced.id, clips: [clip('late', 1, 1)] },
    ]);
  });
});
