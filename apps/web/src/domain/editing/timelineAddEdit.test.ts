import { describe, expect, it } from 'vitest';

import type { TimelineClip, TimelineTrack } from '../../shared/desktop/dto';
import { planTimelineAddEdit } from './timelineAddEdit';

function clip(id: string, linkGroupId: string | null = null): TimelineClip {
  return {
    id,
    name: id,
    capture_intent: null,
    material: { kind: 'asset', asset_id: 'asset', media_duration_seconds: 10 },
    placement: { start: 0, duration: 10, source_in: 0, source_out: 10, speed: 1, volume: 1, enabled: true },
    transform: { x: 0, y: 0, scale_x: 1, scale_y: 1, rotation: 0, opacity: 1 },
    effects: [],
    transitions: { video_in: null, video_out: null, audio_in: null, audio_out: null },
    text: null,
    metadata: {},
    group_id: null,
    link_group_id: linkGroupId,
    keyframes: [],
    speed_segments: [],
  };
}

function track(id: string, kind: TimelineTrack['kind'], clips: readonly TimelineClip[], locked = false): TimelineTrack {
  return { id, name: id, kind, order: 0, muted: false, locked, hidden: false, clips: [...clips] };
}

function ids() {
  let next = 0;
  return () => `generated-${++next}`;
}

describe('timeline Add Edit', () => {
  it('follows an AV link and creates independent left and right link groups', () => {
    const video = track('video', 'video', [clip('video-clip', 'av-link')]);
    const audio = track('audio', 'audio', [clip('audio-clip', 'av-link')]);
    const plan = planTimelineAddEdit({
      tracks: [video, audio],
      targetTrackIds: new Set([video.id]),
      timelineTime: 4,
      fps: 60,
      allTracks: false,
      followLinkedClips: true,
      createId: ids(),
    });

    expect(plan?.updates).toHaveLength(2);
    const [leftVideo, rightVideo] = plan?.updates[0]?.clips ?? [];
    const [leftAudio, rightAudio] = plan?.updates[1]?.clips ?? [];
    expect([leftVideo?.placement.duration, rightVideo?.placement.duration]).toEqual([4, 6]);
    expect([leftAudio?.placement.duration, rightAudio?.placement.duration]).toEqual([4, 6]);
    expect(leftVideo?.link_group_id).toBe('av-link');
    expect(leftAudio?.link_group_id).toBe('av-link');
    expect(rightVideo?.link_group_id).toBeTruthy();
    expect(rightAudio?.link_group_id).toBe(rightVideo?.link_group_id);
    expect(rightVideo?.link_group_id).not.toBe('av-link');
  });

  it('cuts every unlocked track in all-tracks mode and ignores locked tracks', () => {
    const video = track('video', 'video', [clip('video-clip')]);
    const audio = track('audio', 'audio', [clip('audio-clip')]);
    const locked = track('locked', 'audio', [clip('locked-clip')], true);
    const plan = planTimelineAddEdit({
      tracks: [video, audio, locked],
      targetTrackIds: new Set(),
      timelineTime: 5,
      fps: 60,
      allTracks: true,
      followLinkedClips: true,
      createId: ids(),
    });

    expect(plan?.updates.map((update) => update.trackId)).toEqual(['video', 'audio']);
    expect(plan?.updates.every((update) => update.clips.length === 2)).toBe(true);
  });

  it('cuts only the clicked channel when linked following is disabled', () => {
    const video = track('video', 'video', [clip('video-clip', 'av-link')]);
    const audio = track('audio', 'audio', [clip('audio-clip', 'av-link')]);
    const plan = planTimelineAddEdit({
      tracks: [video, audio],
      targetTrackIds: new Set([video.id]),
      timelineTime: 5,
      fps: 60,
      allTracks: false,
      followLinkedClips: false,
      createId: ids(),
    });

    expect(plan?.updates).toHaveLength(1);
    expect(plan?.updates[0]?.trackId).toBe(video.id);
    expect(plan?.updates[0]?.clips[1]?.link_group_id).toBeNull();
  });

  it('never cuts a locked linked partner and leaves the new unlocked side unlinked', () => {
    const video = track('video', 'video', [clip('video-clip', 'av-link')]);
    const audio = track('audio', 'audio', [clip('audio-clip', 'av-link')], true);
    const plan = planTimelineAddEdit({
      tracks: [video, audio],
      targetTrackIds: new Set([video.id, audio.id]),
      timelineTime: 5,
      fps: 60,
      allTracks: false,
      followLinkedClips: true,
      createId: ids(),
    });

    expect(plan?.updates).toHaveLength(1);
    expect(plan?.updates[0]?.trackId).toBe(video.id);
    expect(plan?.updates[0]?.clips[0]?.link_group_id).toBe('av-link');
    expect(plan?.updates[0]?.clips[1]?.link_group_id).toBeNull();
  });
});
