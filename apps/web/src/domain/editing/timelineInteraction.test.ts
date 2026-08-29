import { describe, expect, it } from 'vitest';

import type { TimelineClip } from '../../shared/desktop/dto';
import {
  adjustLinearGainByTrackDelta,
  dbToLinearGain,
  gainToTrackPercent,
  linearGainToDb,
  clipFadeDuration,
  constrainClipGroupTrimDelta,
  maximumClipFadeDuration,
  moveTimelineClip,
  resolveTimelineSnap,
  snapTimeToFrame,
  setClipFadeDuration,
  trimTimelineClip,
  timelineEdgeScrollStep,
} from './timelineInteraction';

const CLIP: TimelineClip = {
  id: 'clip',
  name: 'Clip',
  capture_intent: null,
  material: { kind: 'asset', asset_id: 'asset', media_duration_seconds: 12 },
  placement: { start: 10, duration: 8, source_in: 2, source_out: 10, speed: 1, volume: 1, enabled: true },
  transform: { x: 0, y: 0, scale_x: 1, scale_y: 1, rotation: 0, opacity: 1 },
  effects: [],
  transition_in: null,
  transition_out: null,
  text: null,
  metadata: {},
  group_id: null,
  link_group_id: null,
  keyframes: [],
  speed_segments: [],
};

describe('timeline direct manipulation', () => {
  it('snaps playhead and clip positions to the Editing Document frame grid', () => {
    expect(snapTimeToFrame(1.019, 60)).toBeCloseTo(1.016_666_667);
    expect(moveTimelineClip(CLIP, 14.019, 60).placement.start).toBeCloseTo(14.016_666_667);
  });

  it('trims the start while preserving the source/timeline relationship', () => {
    const trimmed = trimTimelineClip(CLIP, 'start', 12, 60, 12);
    expect(trimmed.placement).toMatchObject({ start: 12, duration: 6, source_in: 4, source_out: 10 });
  });

  it('does not extend a start trim before the available source', () => {
    const trimmed = trimTimelineClip(CLIP, 'start', 0, 60, 12);
    expect(trimmed.placement).toMatchObject({ start: 8, duration: 10, source_in: 0, source_out: 10 });
  });

  it('trims the end without extending past recorded media', () => {
    const trimmed = trimTimelineClip(CLIP, 'end', 30, 60, 12);
    expect(trimmed.placement.duration).toBe(10);
    expect(trimmed.placement.source_out).toBe(12);
  });

  it('snaps the closest moving edge within a screen-derived threshold', () => {
    expect(resolveTimelineSnap(9.84, [0, 5], [0, 10, 20], 0.2)).toEqual({
      anchorTime: 10,
      snapTime: 10,
    });
    expect(resolveTimelineSnap(14.84, [0, 5], [0, 10, 20], 0.2)).toEqual({
      anchorTime: 15,
      snapTime: 20,
    });
  });

  it('does not snap outside the threshold', () => {
    expect(resolveTimelineSnap(9.7, [0], [10], 0.2)).toEqual({
      anchorTime: 9.7,
      snapTime: null,
    });
  });

  it('maps canonical linear volume to the Premiere-style dB rubber band', () => {
    expect(linearGainToDb(1)).toBe(0);
    expect(linearGainToDb(0)).toBe(-60);
    expect(dbToLinearGain(0)).toBe(1);
    expect(dbToLinearGain(-60)).toBe(0);
    expect(gainToTrackPercent(1)).toBeCloseTo(16.715, 2);
  });

  it('adjusts gain from vertical track movement and clamps to the renderer range', () => {
    expect(linearGainToDb(adjustLinearGainByTrackDelta(1, -5.35, 64))).toBeCloseTo(6.02, 1);
    expect(adjustLinearGainByTrackDelta(4, -64, 64)).toBe(4);
    expect(adjustLinearGainByTrackDelta(0, 64, 64)).toBe(0);
  });

  it('reads renderer-backed fade duration and enables a frame-snapped fade', () => {
    expect(clipFadeDuration(CLIP, 'in')).toBe(0);
    const faded = setClipFadeDuration(CLIP, 'in', 0.363, 60);
    expect(faded.transition_in).toBe('fade');
    expect(faded.metadata).toMatchObject({ transition_duration: 0.366_666_666_666_666_64 });
    expect(clipFadeDuration(faded, 'in')).toBeCloseTo(0.366_666_667);
  });

  it('constrains dual fades to less than the clip duration and disables below threshold', () => {
    const withOut = { ...CLIP, transition_out: 'fade' };
    expect(maximumClipFadeDuration(withOut, 'in', 60)).toBeCloseTo(8 / 2 - 1 / 60);
    const faded = setClipFadeDuration(withOut, 'in', 5, 60);
    expect(clipFadeDuration(faded, 'in')).toBeCloseTo(3.983_333_333);
    expect(setClipFadeDuration(faded, 'in', 0.01, 60).transition_in).toBeNull();
  });

  it('derives bounded drag auto-scroll from pointer edge penetration', () => {
    expect(timelineEdgeScrollStep(500, 200, 1_000)).toBe(0);
    expect(timelineEdgeScrollStep(224, 200, 1_000)).toBe(-12);
    expect(timelineEdgeScrollStep(976, 200, 1_000)).toBe(12);
    expect(timelineEdgeScrollStep(1_100, 200, 1_000)).toBe(24);
  });

  it('constrains one trim delta by every selected source boundary', () => {
    const second = {
      ...CLIP,
      id: 'second',
      placement: { ...CLIP.placement, start: 20, duration: 4, source_in: 1, source_out: 5 },
    };
    expect(constrainClipGroupTrimDelta([CLIP, second], 'start', -5, 60)).toBe(-1);
    expect(constrainClipGroupTrimDelta([CLIP, second], 'end', 10, 60)).toBe(2);
  });
});
