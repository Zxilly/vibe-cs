import { describe, expect, it } from 'vitest';

import type { TimelineClip } from '../../shared/desktop/dto';
import {
  adjustLinearGainByTrackDelta,
  dbToLinearGain,
  gainToTrackPercent,
  linearGainToDb,
  clipFadeDuration,
  clipDemoTickAtTimelineTime,
  clipLocalTimeAtSourceTime,
  clipPlaybackSpeedAtLocalTime,
  clipSourceTimeAtLocalTime,
  disableClipTimeRemapping,
  enableClipTimeRemapping,
  canSlipTimelineClip,
  canRollTimelineEdit,
  canRateStretchTimelineClip,
  canSlideTimelineClip,
  constrainClipGroupSlipDelta,
  constrainClipGroupTrimDelta,
  moveTimelineClip,
  resolveTimelineSnap,
  removeClipSpeedBoundary,
  snapTimeToFrame,
  setClipSpeedSegmentSpeed,
  sliceClipSpeedSegments,
  slipTimelineClip,
  splitClipSpeedSegment,
  rollTimelineEdit,
  rollTimelineEdits,
  rateStretchTimelineClip,
  slideTimelineClip,
  trimTimelineClip,
  timelineEdgeScrollStep,
} from './timelineInteraction';

const CLIP: TimelineClip = {
  id: 'clip',
  name: 'Clip',
  capture_intent: null,
  material: { kind: 'asset', asset_id: 'asset', media_duration_seconds: 12 },
  placement: { start: 10, duration: 8, source_in: 2, source_out: 10, speed: 1, reverse: false, frame_hold_source_time: null, volume: 1, pan: 0, enabled: true },
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

  it('trims reverse clips against the source edge presented at each Timeline edge', () => {
    const reversed = { ...CLIP, placement: { ...CLIP.placement, reverse: true } };
    const trimmedStart = trimTimelineClip(reversed, 'start', 12, 60, 12);
    expect(trimmedStart.placement).toMatchObject({
      start: 12,
      duration: 6,
      source_in: 2,
      source_out: 8,
      reverse: true,
    });

    const extendedStart = trimTimelineClip(reversed, 'start', 0, 60, 12);
    expect(extendedStart.placement).toMatchObject({ start: 8, duration: 10, source_in: 2, source_out: 12 });

    const extendedEnd = trimTimelineClip(reversed, 'end', 30, 60, 12);
    expect(extendedEnd.placement).toMatchObject({ duration: 10, source_in: 0, source_out: 10 });
  });

  it('changes only Timeline geometry when trimming a held frame', () => {
    const held = {
      ...CLIP,
      placement: { ...CLIP.placement, frame_hold_source_time: 6 },
    };
    expect(trimTimelineClip(held, 'start', 12, 60, 12).placement).toMatchObject({
      start: 12,
      duration: 6,
      source_in: 2,
      source_out: 10,
      frame_hold_source_time: 6,
    });
    expect(trimTimelineClip(held, 'end', 22, 60, 12).placement).toMatchObject({
      start: 10,
      duration: 12,
      source_in: 2,
      source_out: 10,
      frame_hold_source_time: 6,
    });
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

  it('reads renderer-backed audio transition duration', () => {
    expect(clipFadeDuration(CLIP, 'in')).toBe(0);
    const faded = {
      ...CLIP,
      transitions: {
        ...CLIP.transitions,
        audio_in: { kind: 'constant_power' as const, duration_seconds: 0.35 },
      },
    };
    expect(clipFadeDuration(faded, 'in')).toBe(0.35);
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

  it('slips source In and Out without changing timeline position or duration', () => {
    const slipped = slipTimelineClip(CLIP, 1.5, 60);
    expect(slipped.placement).toEqual({
      ...CLIP.placement,
      source_in: 3.5,
      source_out: 11.5,
    });
  });

  it('constrains a shared slip delta by every selected media boundary', () => {
    const second = {
      ...CLIP,
      id: 'second',
      material: { kind: 'asset' as const, asset_id: 'second', media_duration_seconds: 20 },
      placement: { ...CLIP.placement, source_in: 0.5, source_out: 9 },
    };
    expect(constrainClipGroupSlipDelta([CLIP, second], -5, 60)).toBe(-0.5);
    expect(constrainClipGroupSlipDelta([CLIP, second], 5, 60)).toBe(2);
  });

  it('does not slip planned clips without a bounded media source', () => {
    const planned = { ...CLIP, material: { kind: 'planned' as const } };
    expect(canSlipTimelineClip(CLIP, 60)).toBe(true);
    expect(canSlipTimelineClip({ ...CLIP, placement: { ...CLIP.placement, source_in: 0, source_out: 12 } }, 60)).toBe(false);
    expect(canSlipTimelineClip(planned, 60)).toBe(false);
    expect(constrainClipGroupSlipDelta([planned], 1, 60)).toBe(0);
    expect(slipTimelineClip(planned, 1, 60)).toBe(planned);
    const held = { ...CLIP, placement: { ...CLIP.placement, frame_hold_source_time: 6 } };
    expect(canSlipTimelineClip(held, 60)).toBe(false);
    expect(slipTimelineClip(held, 1, 60)).toBe(held);
  });

  it('rolls one shared edit point without changing the combined duration or outer edges', () => {
    const right = {
      ...CLIP,
      id: 'right',
      material: { kind: 'asset' as const, asset_id: 'right', media_duration_seconds: 10 },
      placement: { ...CLIP.placement, start: 18, duration: 4, source_in: 1, source_out: 5 },
    };
    const rolled = rollTimelineEdit(CLIP, right, 19.5, 60)!;
    expect(rolled.delta).toBe(1.5);
    expect(rolled.left.placement).toEqual({ ...CLIP.placement, duration: 9.5, source_out: 11.5 });
    expect(rolled.right.placement).toEqual({ ...right.placement, start: 19.5, duration: 2.5, source_in: 2.5 });
    expect(rolled.left.placement.duration + rolled.right.placement.duration).toBe(12);
    expect(rolled.right.placement.start + rolled.right.placement.duration).toBe(22);
  });

  it('constrains a rolling edit by both clips source handles', () => {
    const right = {
      ...CLIP,
      id: 'right',
      material: { kind: 'asset' as const, asset_id: 'right', media_duration_seconds: 10 },
      placement: { ...CLIP.placement, start: 18, duration: 4, source_in: 1, source_out: 5 },
    };
    expect(rollTimelineEdit(CLIP, right, 30, 60)?.delta).toBe(2);
    expect(rollTimelineEdit(CLIP, right, 10, 60)?.delta).toBe(-1);
    expect(canRollTimelineEdit(CLIP, right, 60)).toBe(true);
  });

  it('rejects gaps and variable-speed clips as rolling edit points', () => {
    const gap = { ...CLIP, id: 'gap', placement: { ...CLIP.placement, start: 19 } };
    const remapped = { ...CLIP, speed_segments: [{ id: 'speed', start: 0, end: 8, speed: 1 }] };
    expect(rollTimelineEdit(CLIP, gap, 18, 60)).toBeNull();
    expect(rollTimelineEdit(remapped, { ...CLIP, id: 'right', placement: { ...CLIP.placement, start: 18 } }, 18, 60)).toBeNull();
    const reversed = { ...CLIP, placement: { ...CLIP.placement, reverse: true } };
    expect(rollTimelineEdit(reversed, { ...CLIP, id: 'right', placement: { ...CLIP.placement, start: 18 } }, 18, 60)).toBeNull();
  });

  it('rolls adjacent selected edit points with one constrained delta', () => {
    const clips = [
      { ...CLIP, id: 'a', placement: { ...CLIP.placement, start: 0, duration: 5, source_in: 5, source_out: 10 } },
      { ...CLIP, id: 'b', placement: { ...CLIP.placement, start: 5, duration: 5, source_in: 5, source_out: 10 } },
      { ...CLIP, id: 'c', placement: { ...CLIP.placement, start: 10, duration: 5, source_in: 5, source_out: 10 } },
    ];
    const rolled = rollTimelineEdits(clips, [
      { leftClipId: 'a', rightClipId: 'b' },
      { leftClipId: 'b', rightClipId: 'c' },
    ], 1, 60)!;
    expect(rolled.delta).toBe(1);
    expect(rolled.editTimes).toEqual([6, 11]);
    expect(rolled.clips.map((clip) => [clip.id, clip.placement.start, clip.placement.duration, clip.placement.source_in, clip.placement.source_out])).toEqual([
      ['a', 0, 6, 5, 11],
      ['b', 6, 5, 6, 11],
      ['c', 11, 4, 6, 10],
    ]);
  });

  it('preserves constant-speed source duration for real fractional Story cuts', () => {
    const clips = [
      { ...CLIP, id: 'a', material: { kind: 'asset' as const, asset_id: 'asset-a', media_duration_seconds: 200 }, placement: { ...CLIP.placement, start: 0, duration: 30.083_333_969_116_21, source_in: 100.75, source_out: 130.833_333_969_116_2, speed: 1 } },
      { ...CLIP, id: 'b', material: { kind: 'asset' as const, asset_id: 'asset-b', media_duration_seconds: 200 }, placement: { ...CLIP.placement, start: 30.083_333_969_116_21, duration: 4.307_664_871_215_82, source_in: 130.833_328_247_070_3, source_out: 135.140_993_118_286_13, speed: 1 } },
      { ...CLIP, id: 'c', material: { kind: 'asset' as const, asset_id: 'asset-c', media_duration_seconds: 200 }, placement: { ...CLIP.placement, start: 34.390_998_840_332_03, duration: 50, source_in: 20, source_out: 70, speed: 1 } },
    ];
    const rolled = rollTimelineEdits(clips, [
      { leftClipId: 'a', rightClipId: 'b' },
      { leftClipId: 'b', rightClipId: 'c' },
    ], -1 / 60, 60)!;
    for (const clip of rolled.clips) {
      expect(Math.abs(
        clip.placement.source_out - clip.placement.source_in
        - clip.placement.duration * clip.placement.speed,
      )).toBeLessThan(1e-9);
    }
  });

  it('rate-stretches duration and speed while retaining source In and Out', () => {
    const keyed = { ...CLIP, keyframes: [{ id: 'x', time: 4, property: 'x' as const, value: 100, interpolation: 'linear' as const, in_tangent: 0, out_tangent: 0  }] };
    const faster = rateStretchTimelineClip(keyed, 'end', 14, 60);
    expect(faster.placement).toEqual({ ...CLIP.placement, duration: 4, speed: 2 });
    expect(faster.keyframes[0]?.time).toBe(2);

    const slower = rateStretchTimelineClip(CLIP, 'end', 26, 60);
    expect(slower.placement).toEqual({ ...CLIP.placement, duration: 16, speed: 0.5 });
    expect(slower.placement.source_in).toBe(CLIP.placement.source_in);
    expect(slower.placement.source_out).toBe(CLIP.placement.source_out);
  });

  it('rate-stretches from the left while keeping the original Out point fixed', () => {
    const stretched = rateStretchTimelineClip(CLIP, 'start', 16, 60);
    expect(stretched.placement).toEqual({ ...CLIP.placement, start: 16, duration: 2, speed: 4 });
    expect(stretched.placement.start + stretched.placement.duration).toBe(18);
  });

  it('constrains rate stretch to Program and renderer speed limits', () => {
    expect(rateStretchTimelineClip(CLIP, 'end', 10.01, 60).placement).toEqual(expect.objectContaining({ duration: 0.5, speed: 16 }));
    expect(rateStretchTimelineClip(CLIP, 'end', 10_000, 60).placement).toEqual(expect.objectContaining({ duration: 128, speed: 0.0625 }));
    expect(canRateStretchTimelineClip({ ...CLIP, speed_segments: [{ id: 'speed', start: 0, end: 8, speed: 1 }] })).toBe(false);
    expect(canRateStretchTimelineClip({
      ...CLIP,
      placement: { ...CLIP.placement, frame_hold_source_time: 6 },
    })).toBe(false);
  });

  it('maps reverse and held clips through the canonical source clock', () => {
    const reversed = { ...CLIP, placement: { ...CLIP.placement, reverse: true } };
    expect(clipSourceTimeAtLocalTime(reversed, 0)).toBe(10);
    expect(clipSourceTimeAtLocalTime(reversed, 3)).toBe(7);
    expect(clipSourceTimeAtLocalTime(reversed, 8)).toBe(2);
    expect(clipLocalTimeAtSourceTime(reversed, 10)).toBe(0);
    expect(clipLocalTimeAtSourceTime(reversed, 7)).toBe(3);
    expect(clipLocalTimeAtSourceTime(reversed, 2)).toBe(8);
    expect(clipPlaybackSpeedAtLocalTime(reversed, 3)).toBe(-1);

    const held = { ...CLIP, placement: { ...CLIP.placement, frame_hold_source_time: 6 } };
    expect(clipSourceTimeAtLocalTime(held, 0)).toBe(6);
    expect(clipSourceTimeAtLocalTime(held, 8)).toBe(6);
    expect(clipLocalTimeAtSourceTime(held, 9)).toBe(0);
    expect(clipPlaybackSpeedAtLocalTime(held, 3)).toBe(0);
    expect(enableClipTimeRemapping(reversed, 'segment')).toBe(reversed);
    expect(enableClipTimeRemapping(held, 'segment')).toBe(held);
  });

  it('maps segmented Timeline time to the same source sections as export', () => {
    const remapped: TimelineClip = {
      ...CLIP,
      placement: { ...CLIP.placement, duration: 8, source_in: 2, source_out: 12 },
      speed_segments: [
        { id: 'slow', start: 0, end: 4, speed: 0.5 },
        { id: 'fast', start: 4, end: 8, speed: 2 },
      ],
    };

    expect(clipSourceTimeAtLocalTime(remapped, 2)).toBe(3);
    expect(clipSourceTimeAtLocalTime(remapped, 5)).toBe(6);
    expect(clipSourceTimeAtLocalTime(remapped, 8)).toBe(12);
    expect(clipLocalTimeAtSourceTime(remapped, 3)).toBe(2);
    expect(clipLocalTimeAtSourceTime(remapped, 6)).toBe(5);
    expect(clipLocalTimeAtSourceTime(remapped, 12)).toBe(8);
    expect(clipPlaybackSpeedAtLocalTime(remapped, 3)).toBe(0.5);
    expect(clipPlaybackSpeedAtLocalTime(remapped, 5)).toBe(2);
  });

  it('maps the shared Timeline playhead through source trim and capture pre-roll to Demo ticks', () => {
    const captured: TimelineClip = {
      ...CLIP,
      capture_intent: {
        demo_id: 'demo',
        highlight_id: null,
        player_id: 'player',
        start_tick: 1_000,
        end_tick: 1_512,
        pre_roll_seconds: 2,
        post_roll_seconds: 2,
        victim_pov: false,
        camera_style: 'pov',
        presentation: null,
      },
    };

    expect(clipDemoTickAtTimelineTime(captured, 10, 64)).toBe(1_000);
    expect(clipDemoTickAtTimelineTime(captured, 14, 64)).toBe(1_256);
    expect(clipDemoTickAtTimelineTime({ ...captured, capture_intent: null }, 14, 64)).toBeNull();
  });

  it('edits speed sections without changing their source In and Out', () => {
    const enabled = enableClipTimeRemapping(CLIP, 'whole');
    const split = splitClipSpeedSegment(enabled, 4, 'right', 60);
    const keyed = {
      ...split,
      keyframes: [{ id: 'x', time: 6, property: 'x' as const, value: 100, interpolation: 'linear' as const, in_tangent: 0, out_tangent: 0  }],
    };
    const faster = setClipSpeedSegmentSpeed(keyed, 'right', 2, 60);

    expect(faster.placement).toEqual({ ...CLIP.placement, duration: 6, speed: 4 / 3 });
    expect(faster.speed_segments).toEqual([
      { id: 'whole', start: 0, end: 4, speed: 1 },
      { id: 'right', start: 4, end: 6, speed: 2 },
    ]);
    expect(faster.keyframes[0]?.time).toBe(5);
    expect(clipSourceTimeAtLocalTime(faster, 6)).toBe(10);

    const merged = removeClipSpeedBoundary(faster, 'right');
    expect(merged.speed_segments).toEqual([{ id: 'whole', start: 0, end: 6, speed: 4 / 3 }]);
    expect(disableClipTimeRemapping(merged)).toMatchObject({
      placement: { duration: 6, source_in: 2, source_out: 10, speed: 4 / 3 },
      speed_segments: [],
    });
  });

  it('slices speed sections into clip-local coordinates', () => {
    const remapped = {
      ...CLIP,
      speed_segments: [
        { id: 'slow', start: 0, end: 4, speed: 0.5 },
        { id: 'fast', start: 4, end: 8, speed: 1.5 },
      ],
    };
    expect(sliceClipSpeedSegments(remapped, 2, 6)).toEqual([
      { id: 'slow', start: 0, end: 2, speed: 0.5 },
      { id: 'fast', start: 2, end: 4, speed: 1.5 },
    ]);
  });

  it('trims time-remapped clips only inward and slices their source mapping', () => {
    const remapped = {
      ...CLIP,
      speed_segments: [
        { id: 'slow', start: 0, end: 4, speed: 0.5 },
        { id: 'fast', start: 4, end: 8, speed: 1.5 },
      ],
    };
    const trimmedStart = trimTimelineClip(remapped, 'start', 12, 60, 12);
    expect(trimmedStart.placement).toEqual({ ...CLIP.placement, start: 12, duration: 6, source_in: 3, speed: 7 / 6 });
    expect(trimmedStart.speed_segments).toEqual([
      { id: 'slow', start: 0, end: 2, speed: 0.5 },
      { id: 'fast', start: 2, end: 6, speed: 1.5 },
    ]);

    const trimmedEnd = trimTimelineClip(remapped, 'end', 16, 60, 12);
    expect(trimmedEnd.placement).toEqual({ ...CLIP.placement, duration: 6, source_out: 7, speed: 5 / 6 });
    expect(trimmedEnd.speed_segments).toEqual([
      { id: 'slow', start: 0, end: 4, speed: 0.5 },
      { id: 'fast', start: 4, end: 6, speed: 1.5 },
    ]);
    expect(constrainClipGroupTrimDelta([remapped], 'start', -2, 60)).toBe(0);
    expect(constrainClipGroupTrimDelta([remapped], 'end', 2, 60)).toBe(0);
  });

  it('slides one clip while preserving its source and all three outer geometry', () => {
    const previous = { ...CLIP, id: 'previous', placement: { ...CLIP.placement, start: 0, duration: 8, source_in: 0, source_out: 8 } };
    const clip = { ...CLIP, id: 'middle', placement: { ...CLIP.placement, start: 8, duration: 4, source_in: 2, source_out: 6 } };
    const next = { ...CLIP, id: 'next', material: { kind: 'asset' as const, asset_id: 'next', media_duration_seconds: 20 }, placement: { ...CLIP.placement, start: 12, duration: 6, source_in: 2, source_out: 8 } };
    const slid = slideTimelineClip(previous, clip, next, 9.5, 60)!;
    expect(slid.delta).toBe(1.5);
    expect(slid.previous.placement).toEqual({ ...previous.placement, duration: 9.5, source_out: 9.5 });
    expect(slid.clip.placement).toEqual({ ...clip.placement, start: 9.5 });
    expect(slid.next.placement).toEqual({ ...next.placement, start: 13.5, duration: 4.5, source_in: 3.5 });
    expect(slid.clip.placement.source_in).toBe(2);
    expect(slid.clip.placement.source_out).toBe(6);
    expect(slid.next.placement.start + slid.next.placement.duration).toBe(18);
  });

  it('constrains Slide by previous tail and next head handles', () => {
    const previous = { ...CLIP, id: 'previous', placement: { ...CLIP.placement, start: 0, duration: 8, source_in: 0, source_out: 8 } };
    const clip = { ...CLIP, id: 'middle', placement: { ...CLIP.placement, start: 8, duration: 4, source_in: 2, source_out: 6 } };
    const next = { ...CLIP, id: 'next', placement: { ...CLIP.placement, start: 12, duration: 6, source_in: 1, source_out: 7 } };
    expect(slideTimelineClip(previous, clip, next, 20, 60)?.delta).toBe(4);
    expect(slideTimelineClip(previous, clip, next, 0, 60)?.delta).toBe(-1);
    expect(canSlideTimelineClip(previous, clip, next, 60)).toBe(true);
  });

  it('does not expose Slide across gaps or variable-speed adjacent clips', () => {
    const previous = { ...CLIP, id: 'previous', placement: { ...CLIP.placement, start: 0 } };
    const middle = { ...CLIP, id: 'middle', placement: { ...CLIP.placement, start: 18 } };
    const next = { ...CLIP, id: 'next', placement: { ...CLIP.placement, start: 26 } };
    expect(slideTimelineClip(previous, middle, next, 18, 60)).toBeNull();
    expect(slideTimelineClip(
      previous,
      { ...middle, placement: { ...middle.placement, start: 8 } },
      { ...next, placement: { ...next.placement, start: 16 }, speed_segments: [{ id: 'speed', start: 0, end: 8, speed: 1 }] },
      8,
      60,
    )).toBeNull();
    expect(slideTimelineClip(
      { ...previous, placement: { ...previous.placement, reverse: true } },
      { ...middle, placement: { ...middle.placement, start: 8 } },
      { ...next, placement: { ...next.placement, start: 16 } },
      8,
      60,
    )).toBeNull();
  });
});
