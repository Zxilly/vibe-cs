import { beforeEach, describe, expect, it } from 'vitest';

import {
  interpolateTimelineProperty,
  useTimelineStore,
  type TimelineClip,
  type TimelineTrack,
} from './timelineStore';
import { MAX_EDITOR_TIMELINE_SECONDS } from './projectState';

const clip: TimelineClip = {
  id: 'clip-a',
  assetId: 'asset-a',
  name: '测试片段',
  start: 0,
  duration: 10,
  sourceIn: 0,
  sourceOut: 10,
  speed: 1,
  volume: 1,
  color: '#f59e0b',
};

const tracks: TimelineTrack[] = [
  { id: 'video', name: '主画面', kind: 'video', muted: false, locked: false, clips: [clip] },
  { id: 'video-2', name: '第二画面', kind: 'video', muted: false, locked: false, clips: [] },
  { id: 'audio', name: '音乐', kind: 'audio', muted: false, locked: false, clips: [] },
];

describe('timeline store', () => {
  beforeEach(() => {
    useTimelineStore.getState().reset(tracks);
    useTimelineStore.getState().selectClip(clip.id);
  });

  it('moves only across compatible tracks and recomputes duration', () => {
    const rejected = useTimelineStore.getState().moveClip(clip.id, 'audio', 5);
    expect(rejected.ok).toBe(false);

    const moved = useTimelineStore.getState().moveClip(clip.id, 'video-2', 5);

    expect(moved.ok).toBe(true);
    expect(useTimelineStore.getState().tracks[0]?.clips).toHaveLength(0);
    expect(useTimelineStore.getState().tracks[1]?.clips[0]).toMatchObject({ id: clip.id, start: 5 });
    expect(useTimelineStore.getState().duration).toBe(15);
  });

  it('splits at the playhead while preserving total source duration', () => {
    useTimelineStore.getState().splitClip(clip.id, 4);
    const clips = useTimelineStore.getState().tracks[0]?.clips ?? [];

    expect(clips).toHaveLength(2);
    expect(clips[0]).toMatchObject({ duration: 4, sourceOut: 4 });
    expect(clips[1]).toMatchObject({ start: 4, duration: 6, sourceIn: 4 });
  });

  it('supports undo and redo for destructive edits', () => {
    useTimelineStore.getState().removeClip(clip.id);
    expect(useTimelineStore.getState().tracks[0]?.clips).toHaveLength(0);

    useTimelineStore.getState().undo();
    expect(useTimelineStore.getState().tracks[0]?.clips[0]?.id).toBe(clip.id);

    useTimelineStore.getState().redo();
    expect(useTimelineStore.getState().tracks[0]?.clips).toHaveLength(0);
  });

  it('prevents edits on a locked track and makes the lock undoable', () => {
    useTimelineStore.getState().toggleTrackLock('video');
    useTimelineStore.getState().removeClip(clip.id);
    useTimelineStore.getState().updateClip(clip.id, { name: '不应生效' });

    expect(useTimelineStore.getState().tracks[0]?.locked).toBe(true);
    expect(useTimelineStore.getState().tracks[0]?.clips[0]?.name).toBe('测试片段');

    useTimelineStore.getState().undo();
    expect(useTimelineStore.getState().tracks[0]?.locked).toBe(false);
  });

  it('ripple inserts and deletes while closing the affected track gap', () => {
    const second = { ...clip, id: 'clip-b', start: 10, sourceIn: 10, sourceOut: 15, duration: 5 };
    useTimelineStore.getState().reset([{ ...tracks[0]!, clips: [clip, second] }]);
    const inserted = { ...clip, id: 'inserted', start: 10, duration: 2, sourceOut: 2 };

    expect(useTimelineStore.getState().addClip('video', { ...inserted, start: 5 }, true).ok).toBe(false);

    expect(useTimelineStore.getState().addClip('video', inserted, true).ok).toBe(true);
    expect(useTimelineStore.getState().tracks[0]?.clips.find((item) => item.id === 'clip-b')?.start).toBe(12);

    expect(useTimelineStore.getState().removeClip('inserted', true).ok).toBe(true);
    expect(useTimelineStore.getState().tracks[0]?.clips.find((item) => item.id === 'clip-b')?.start).toBe(10);
  });

  it('moves and deletes linked clips together and respects every locked member track', () => {
    const linkedVideo = { ...clip, linkGroupId: 'link-1' };
    const linkedAudio = { ...clip, id: 'clip-audio', linkGroupId: 'link-1' };
    useTimelineStore.getState().reset([
      { ...tracks[0]!, clips: [linkedVideo] },
      { ...tracks[2]!, clips: [linkedAudio] },
    ]);

    expect(useTimelineStore.getState().moveClip(clip.id, 'video', 3).ok).toBe(true);
    expect(useTimelineStore.getState().tracks.flatMap((track) => track.clips).map((item) => item.start)).toEqual([3, 3]);

    useTimelineStore.getState().toggleTrackLock('audio');
    expect(useTimelineStore.getState().removeClip(clip.id).ok).toBe(false);
    expect(useTimelineStore.getState().tracks.flatMap((track) => track.clips)).toHaveLength(2);
  });

  it('slips linked sources without changing timeline placement and rejects source overflow', () => {
    const linkedVideo = { ...clip, linkGroupId: 'link-1' };
    const linkedAudio = { ...clip, id: 'clip-audio', assetId: 'asset-b', linkGroupId: 'link-1' };
    useTimelineStore.getState().reset([
      { ...tracks[0]!, clips: [linkedVideo] },
      { ...tracks[2]!, clips: [linkedAudio] },
    ]);

    expect(useTimelineStore.getState().slipClip(clip.id, 2, { 'asset-a': 20, 'asset-b': 20 }).ok).toBe(true);
    expect(useTimelineStore.getState().tracks.flatMap((track) => track.clips)).toEqual(expect.arrayContaining([
      expect.objectContaining({ start: 0, sourceIn: 2, sourceOut: 12 }),
    ]));
    expect(useTimelineStore.getState().slipClip(clip.id, 10, { 'asset-a': 20, 'asset-b': 20 }).ok).toBe(false);
  });

  it('stores bounded speed segments and linearly interpolates keyframes', () => {
    expect(useTimelineStore.getState().setSpeedSegments(clip.id, [
      { start: 0, end: 5, speed: 0.5 },
      { start: 5, end: 10, speed: 1.5 },
    ], 20).ok).toBe(true);
    expect(useTimelineStore.getState().upsertKeyframe(clip.id, 'opacity', 0, 0).ok).toBe(true);
    expect(useTimelineStore.getState().upsertKeyframe(clip.id, 'opacity', 10, 1).ok).toBe(true);

    const automated = useTimelineStore.getState().tracks[0]?.clips[0];
    expect(automated?.sourceOut).toBe(10);
    expect(automated && interpolateTimelineProperty(automated, 'opacity', 5)).toBeCloseTo(0.5);
  });

  it('normalizes hostile clip timing before it reaches layout calculations', () => {
    useTimelineStore.getState().reset([{
      ...tracks[0]!,
      clips: [{
        ...clip,
        start: 1e100,
        duration: 1e100,
        sourceIn: Number.NaN,
        sourceOut: Number.POSITIVE_INFINITY,
        speed: Number.POSITIVE_INFINITY,
      }],
    }]);

    const state = useTimelineStore.getState();
    expect(state.duration).toBe(MAX_EDITOR_TIMELINE_SECONDS);
    expect(state.tracks[0]?.clips[0]).toMatchObject({
      start: 0,
      duration: MAX_EDITOR_TIMELINE_SECONDS,
      sourceIn: 0,
      speed: 1,
    });
  });

  it('preserves an authoritative tail and changes it only through an explicit duration edit', () => {
    const marker = [{ id: 'tail', time: 50, label: '尾部标记', color: '#60A5FA' }];
    useTimelineStore.getState().reset(tracks, 60, marker);
    expect(useTimelineStore.getState().duration).toBe(60);
    expect(useTimelineStore.getState().markers).toEqual(marker);

    expect(useTimelineStore.getState().setProjectDuration(40).ok).toBe(true);
    expect(useTimelineStore.getState().duration).toBe(40);
    expect(useTimelineStore.getState().markers).toEqual([]);

    useTimelineStore.getState().undo();
    expect(useTimelineStore.getState().duration).toBe(60);
    expect(useTimelineStore.getState().markers).toEqual(marker);

    useTimelineStore.getState().redo();
    expect(useTimelineStore.getState().duration).toBe(40);
    expect(useTimelineStore.getState().markers).toEqual([]);

    expect(useTimelineStore.getState().setProjectDuration(5).ok).toBe(false);
    expect(useTimelineStore.getState().duration).toBe(40);
  });
});
