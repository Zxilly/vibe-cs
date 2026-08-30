import { describe, expect, it } from 'vitest';

import type { TimelineClip, TimelineTrack } from '../../shared/desktop/dto';
import { planDefaultTimelineTransitions } from './timelineTransitions';

function clip(id: string, start: number): TimelineClip {
  return {
    id, name: id, capture_intent: null, material: { kind: 'planned' },
    placement: { start, duration: 5, source_in: 0, source_out: 5, speed: 1, volume: 1, enabled: true },
    transform: { x: 0, y: 0, scale_x: 1, scale_y: 1, rotation: 0, opacity: 1 },
    effects: [], transitions: { video_in: null, video_out: null, audio_in: null, audio_out: null },
    text: null, metadata: {}, group_id: null, link_group_id: null, keyframes: [], speed_segments: [],
  };
}

function track(id: string, kind: TimelineTrack['kind']): TimelineTrack {
  return { id, name: id, kind, order: 0, muted: false, locked: false, hidden: false, clips: [clip(`${id}-a`, 0), clip(`${id}-b`, 5)] };
}

describe('default Timeline transitions', () => {
  it('applies a half-duration video fade to both sides of a targeted cut', () => {
    const video = track('story', 'video');
    const updates = planDefaultTimelineTransitions({
      tracks: [video], storyTrackId: video.id, targetTrackIds: new Set([video.id]), selectedClipIds: new Set(),
      timelineTime: 5, channel: 'video', mode: 'at_playhead', fps: 60,
    });
    expect(updates[0]?.clips[0]?.transitions.video_out).toEqual({ kind: 'fade', duration_seconds: 0.5 });
    expect(updates[0]?.clips[1]?.transitions.video_in).toEqual({ kind: 'fade', duration_seconds: 0.5 });
  });

  it('applies constant-power audio only to adjacent selected pairs', () => {
    const story = track('story', 'video');
    const updates = planDefaultTimelineTransitions({
      tracks: [story], storyTrackId: story.id, targetTrackIds: new Set(),
      selectedClipIds: new Set(story.clips.map((item) => item.id)), timelineTime: 0,
      channel: 'audio', mode: 'selection', fps: 60,
    });
    expect(updates[0]?.clips[0]?.transitions.audio_out?.kind).toBe('constant_power');
    expect(updates[0]?.clips[1]?.transitions.audio_in?.kind).toBe('constant_power');
    expect(updates[0]?.clips[0]?.transitions.video_out).toBeNull();
  });

  it('does not edit locked or incompatible tracks', () => {
    const text = { ...track('text', 'text'), locked: false };
    const locked = { ...track('video', 'video'), locked: true };
    expect(planDefaultTimelineTransitions({
      tracks: [text, locked], storyTrackId: 'story', targetTrackIds: new Set(['text', 'video']), selectedClipIds: new Set(),
      timelineTime: 5, channel: 'video', mode: 'at_playhead', fps: 60,
    })).toEqual([]);
  });
});
