import { describe, expect, it } from 'vitest';

import type { TimelineClip, TimelineTrack } from '../../shared/desktop/dto';
import { planTimelinePasteInsert, planTimelinePasteOverwrite, type TimelineClipboard } from './timelinePaste';

function clip(id: string, start: number, duration: number, linkGroupId: string | null = null): TimelineClip {
  return {
    id,
    name: id,
    capture_intent: null,
    material: { kind: 'asset', asset_id: id, media_duration_seconds: duration },
    placement: { start, duration, source_in: 0, source_out: duration, speed: 1, reverse: false, frame_hold_source_time: null, volume: 1, pan: 0, enabled: true },
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

function track(id: string, kind: TimelineTrack['kind'], order: number, clips: readonly TimelineClip[] = []): TimelineTrack {
  return { id, name: id, kind, order, muted: false, solo: false, volume: 1, pan: 0, keyframes: [], locked: false, hidden: false, clips: [...clips] };
}

function ids() {
  let next = 0;
  return () => `generated-${++next}`;
}

describe('Timeline Paste Insert', () => {
  it('maps linked AV groups to the lowest matching targets and inserts shared space', () => {
    const video1 = track('video-1', 'video', 0, [clip('existing-video', 0, 10, 'existing-av')]);
    const video2 = track('video-2', 'video', 1);
    const audio1 = track('audio-1', 'audio', 2, [clip('existing-audio', 0, 10, 'existing-av')]);
    const copiedVideo = clip('copied-video', 2, 3, 'copied-av');
    const copiedAudio = clip('copied-audio', 2, 3, 'copied-av');
    const clipboard: TimelineClipboard = {
      originTime: 2,
      duration: 3,
      groups: [
        { trackId: 'source-video', trackKind: 'video', clips: [copiedVideo] },
        { trackId: 'source-audio', trackKind: 'audio', clips: [copiedAudio] },
      ],
    };
    const plan = planTimelinePasteInsert({
      tracks: [video1, video2, audio1],
      targetTrackIds: new Set([video1.id, video2.id, audio1.id]),
      clipboard,
      timelineTime: 4,
      fps: 60,
      createId: ids(),
    });

    expect(plan?.updates.map((update) => update.trackId)).toEqual([video1.id, audio1.id]);
    const videoClips = plan?.updates[0]?.clips ?? [];
    const audioClips = plan?.updates[1]?.clips ?? [];
    expect(videoClips.map((item) => item.placement)).toEqual([
      expect.objectContaining({ start: 0, duration: 4 }),
      expect.objectContaining({ start: 4, duration: 3 }),
      expect.objectContaining({ start: 7, duration: 6 }),
    ]);
    expect(audioClips.map((item) => item.placement)).toEqual([
      expect.objectContaining({ start: 0, duration: 4 }),
      expect.objectContaining({ start: 4, duration: 3 }),
      expect.objectContaining({ start: 7, duration: 6 }),
    ]);
    expect(videoClips[1]?.link_group_id).toBeTruthy();
    expect(audioClips[1]?.link_group_id).toBe(videoClips[1]?.link_group_id);
    expect(videoClips[2]?.link_group_id).toBeTruthy();
    expect(audioClips[2]?.link_group_id).toBe(videoClips[2]?.link_group_id);
    expect(videoClips[2]?.link_group_id).not.toBe('existing-av');
  });

  it('preserves clipboard leading gaps and refuses missing matching targets', () => {
    const video = track('video', 'video', 0);
    const clipboard: TimelineClipboard = {
      originTime: 0,
      duration: 5,
      groups: [{ trackId: 'source', trackKind: 'video', clips: [clip('copy', 2, 2)] }],
    };
    const plan = planTimelinePasteInsert({
      tracks: [video],
      targetTrackIds: new Set([video.id]),
      clipboard,
      timelineTime: 10,
      fps: 60,
      createId: ids(),
    });
    expect(plan?.updates[0]?.clips[0]?.placement.start).toBe(12);

    expect(planTimelinePasteInsert({
      tracks: [video],
      targetTrackIds: new Set(),
      clipboard,
      timelineTime: 10,
      fps: 60,
      createId: ids(),
    })).toBeNull();
  });

  it('overwrites matching targets and rebuilds existing links on both sides', () => {
    const video = track('video', 'video', 0, [clip('existing-video', 0, 10, 'existing-av')]);
    const audio = track('audio', 'audio', 1, [clip('existing-audio', 0, 10, 'existing-av')]);
    const clipboard: TimelineClipboard = {
      originTime: 0,
      duration: 3,
      groups: [
        { trackId: 'source-video', trackKind: 'video', clips: [clip('copy-video', 0, 3, 'copy-av')] },
        { trackId: 'source-audio', trackKind: 'audio', clips: [clip('copy-audio', 0, 3, 'copy-av')] },
      ],
    };
    const plan = planTimelinePasteOverwrite({
      tracks: [video, audio],
      targetTrackIds: new Set([video.id, audio.id]),
      clipboard,
      timelineTime: 4,
      createId: ids(),
    });

    const videoClips = plan?.updates[0]?.clips ?? [];
    const audioClips = plan?.updates[1]?.clips ?? [];
    expect(videoClips.map((item) => item.placement)).toEqual([
      expect.objectContaining({ start: 0, duration: 4 }),
      expect.objectContaining({ start: 4, duration: 3 }),
      expect.objectContaining({ start: 7, duration: 3 }),
    ]);
    expect(audioClips.map((item) => item.placement)).toEqual([
      expect.objectContaining({ start: 0, duration: 4 }),
      expect.objectContaining({ start: 4, duration: 3 }),
      expect.objectContaining({ start: 7, duration: 3 }),
    ]);
    expect(videoClips[0]?.link_group_id).toBe('existing-av');
    expect(audioClips[0]?.link_group_id).toBe('existing-av');
    expect(videoClips[1]?.link_group_id).toBeTruthy();
    expect(audioClips[1]?.link_group_id).toBe(videoClips[1]?.link_group_id);
    expect(videoClips[2]?.link_group_id).toBeTruthy();
    expect(audioClips[2]?.link_group_id).toBe(videoClips[2]?.link_group_id);
    expect(videoClips[2]?.link_group_id).not.toBe('existing-av');
  });
});
