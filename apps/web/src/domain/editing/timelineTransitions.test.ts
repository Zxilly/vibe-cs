import { describe, expect, it } from 'vitest';

import type { TimelineClip, TimelineTrack } from '../../shared/desktop/dto';
import {
  applyTimelineCutTransition,
  maximumTimelineTransitionDuration,
  planDefaultTimelineTransitions,
  setTimelineTransitionDuration,
  timelineCutTransition,
} from './timelineTransitions';

function clip(id: string, start: number): TimelineClip {
  return {
    id, name: id, capture_intent: null, material: { kind: 'planned' },
    placement: { start, duration: 5, source_in: 0, source_out: 5, speed: 1, reverse: false, frame_hold_source_time: null, volume: 1, pan: 0, enabled: true },
    transform: { x: 0, y: 0, scale_x: 1, scale_y: 1, rotation: 0, opacity: 1 },
    effects: [], transitions: { video_in: null, video_out: null, audio_in: null, audio_out: null },
    text: null, metadata: {}, group_id: null, link_group_id: null, keyframes: [], speed_segments: [],
  };
}

function track(id: string, kind: TimelineTrack['kind']): TimelineTrack {
  return { id, name: id, kind, order: 0, muted: false, solo: false, volume: 1, pan: 0, keyframes: [], locked: false, hidden: false, clips: [clip(`${id}-a`, 0), clip(`${id}-b`, 5)] };
}

describe('default Timeline transitions', () => {
  it('resizes an existing transition on the frame grid without replacing its kind', () => {
    const original = {
      ...clip('a', 0),
      transitions: {
        ...clip('a', 0).transitions,
        video_in: { kind: 'zoom' as const, duration_seconds: 0.5 },
        video_out: { kind: 'fade' as const, duration_seconds: 1 },
      },
    };

    const replacement = setTimelineTransitionDuration(original, 'video', 'in', 4.4, 60);
    expect(replacement.transitions.video_in).toEqual({ kind: 'zoom', duration_seconds: 3.983_333_333_333_333_4 });
    expect(maximumTimelineTransitionDuration(original, 'video', 'in', 60)).toBeCloseTo(3.983_333_333);
  });

  it('removes a transition when its direct handle is dragged below the minimum', () => {
    const original = setTimelineTransitionDuration(clip('a', 0), 'audio', 'in', 0.5, 60);
    expect(setTimelineTransitionDuration(original, 'audio', 'in', 0.01, 60).transitions.audio_in).toBeNull();
  });

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

  it('derives and switches one canonical cut between Premiere alignments', () => {
    const source = track('story', 'video');
    const centered = planDefaultTimelineTransitions({
      tracks: [source], storyTrackId: source.id, targetTrackIds: new Set([source.id]), selectedClipIds: new Set(),
      timelineTime: 5, channel: 'video', mode: 'at_playhead', fps: 60,
    })[0]!.clips;
    const centeredTrack = { ...source, clips: [...centered] };
    const cut = timelineCutTransition(centeredTrack, 'story-a', 'video', 'out', 60);
    expect(cut).toMatchObject({ alignment: 'center_at_cut', durationSeconds: 1, leftDurationSeconds: 0.5, rightDurationSeconds: 0.5 });

    const startAligned = applyTimelineCutTransition(centeredTrack, 'story-a', 'video', 'out', { ...cut!, alignment: 'start_at_cut' }, 60);
    expect(startAligned[0]?.transitions.video_out).toBeNull();
    expect(startAligned[1]?.transitions.video_in).toEqual({ kind: 'fade', duration_seconds: 1 });

    const endAligned = applyTimelineCutTransition({ ...source, clips: startAligned }, 'story-b', 'video', 'in', { ...cut!, alignment: 'end_at_cut' }, 60);
    expect(endAligned[0]?.transitions.video_out).toEqual({ kind: 'fade', duration_seconds: 1 });
    expect(endAligned[1]?.transitions.video_in).toBeNull();
  });

  it('copies custom transition timing and rejects a video transition on audio', () => {
    const source = track('story', 'video');
    const left = setTimelineTransitionDuration(source.clips[0]!, 'video', 'out', 0.25, 60);
    const right = setTimelineTransitionDuration(source.clips[1]!, 'video', 'in', 0.75, 60);
    const customTrack = { ...source, clips: [left, right] };
    const copied = timelineCutTransition(customTrack, left.id, 'video', 'out', 60);
    expect(copied).toMatchObject({ alignment: 'custom_start', leftDurationSeconds: 0.25, rightDurationSeconds: 0.75 });
    expect(applyTimelineCutTransition(customTrack, left.id, 'audio', 'out', copied, 60)).toEqual(customTrack.clips);
  });
});
