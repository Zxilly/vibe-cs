import { describe, expect, it } from 'vitest';

import { previewDrag, previewSlip } from './dragPreview';
import { TRACK_HEIGHT_PX, adjacentTrackOfKind, trackAfterVerticalDrag, trackAtOffset, trackBands } from './geometry';
import { createSampleTimeline } from './sampleTimeline';
import { createTimeScale } from './timeScale';

const AT_100 = createTimeScale(1);

describe('vertical geometry', () => {
  const timeline = createSampleTimeline();

  it('stacks the lanes in the artboard’s order and heights', () => {
    expect(trackBands(timeline)).toEqual([
      { trackId: 'v2', kind: 'video', top: 0, height: 62 },
      { trackId: 'v1', kind: 'video', top: 62, height: 62 },
      { trackId: 'a1', kind: 'audio', top: 124, height: 52 },
      { trackId: 'a2', kind: 'audio', top: 176, height: 52 },
      { trackId: 't1', kind: 'subtitle', top: 228, height: 44 },
    ]);
  });

  it('hit-tests an offset, clamping to the outermost lane', () => {
    expect(trackAtOffset(timeline, 0)?.trackId).toBe('v2');
    expect(trackAtOffset(timeline, 61.9)?.trackId).toBe('v2');
    expect(trackAtOffset(timeline, 62)?.trackId).toBe('v1');
    expect(trackAtOffset(timeline, -400)?.trackId).toBe('v2');
    expect(trackAtOffset(timeline, 9000)?.trackId).toBe('t1');
  });

  it('changes lane at the half-way point, not at the edge', () => {
    // V1's centre is 31px from its top; a 30px lift is still V1.
    expect(trackAfterVerticalDrag(timeline, 'v1', 0)?.trackId).toBe('v1');
    expect(trackAfterVerticalDrag(timeline, 'v1', -30)?.trackId).toBe('v1');
    expect(trackAfterVerticalDrag(timeline, 'v1', -32)?.trackId).toBe('v2');
    expect(trackAfterVerticalDrag(timeline, 'v1', 32)?.trackId).toBe('a1');
    expect(trackAfterVerticalDrag(timeline, 'nope', 0)).toBeUndefined();
  });

  it('finds the neighbouring lane of the same kind for the keyboard', () => {
    expect(adjacentTrackOfKind(timeline, 'v1', -1)).toBe('v2');
    expect(adjacentTrackOfKind(timeline, 'v1', 1)).toBeUndefined(); // A1 is audio
    expect(adjacentTrackOfKind(timeline, 'a1', 1)).toBe('a2');
    expect(adjacentTrackOfKind(timeline, 't1', -1)).toBeUndefined();
    expect(adjacentTrackOfKind(timeline, 'nope', 1)).toBeUndefined();
  });

  it('agrees with the heights the stylesheet is given', () => {
    expect(TRACK_HEIGHT_PX).toEqual({ video: 62, audio: 52, subtitle: 44 });
  });
});

describe('previewDrag', () => {
  const timeline = createSampleTimeline();

  it('turns a pointer delta into a landing place', () => {
    // 120px right at 12 px/s is 10s; 名牌 · Kael goes from 8 to 18.
    const preview = previewDrag({ timeline, clipId: 'v2-kael', deltaXPx: 120, deltaYPx: 0, scale: AT_100 });
    expect(preview.start).toBeCloseTo(18, 6);
    expect(preview.trackId).toBe('v2');
    expect(preview.offsetPx).toBeCloseTo(120, 6);
    expect(preview.refusal).toBeNull();
  });

  it('snaps the edge and reports what it stuck to', () => {
    // 名牌 · Kael dragged so its left edge is 0.25s short of the 20s marker.
    const preview = previewDrag({ timeline, clipId: 'v2-kael', deltaXPx: 141, deltaYPx: 0, scale: AT_100 });
    expect(preview.start).toBeCloseTo(20, 6);
    expect(preview.snap).toMatchObject({ kind: 'marker', id: 'm-entry' });
    // The offset the renderer writes is the snapped one, not the raw one.
    expect(preview.offsetPx).toBeCloseTo(144, 6);
  });

  it('does not snap when snapping is off', () => {
    const preview = previewDrag({
      timeline,
      clipId: 'v2-kael',
      deltaXPx: 141,
      deltaYPx: 0,
      scale: AT_100,
      snapEnabled: false,
    });
    expect(preview.start).toBeCloseTo(19.75, 6);
    expect(preview.snap).toBeNull();
  });

  it('needs a closer pointer once the view is zoomed in', () => {
    const zoomed = createTimeScale(4);
    // The same 0.25s gap is 12px at 4× — outside the 8px threshold.
    const preview = previewDrag({ timeline, clipId: 'v2-kael', deltaXPx: 141 * 4, deltaYPx: 0, scale: zoomed });
    expect(preview.snap).toBeNull();
    expect(preview.start).toBeCloseTo(19.75, 6);
  });

  it('follows the pointer onto another lane', () => {
    const preview = previewDrag({ timeline, clipId: 'v1-aurora', deltaXPx: 700, deltaYPx: -32, scale: AT_100 });
    expect(preview.trackId).toBe('v2');
    expect(preview.refusal).toBeNull();
  });

  it('keeps following the pointer onto a lane it may not land on, and says so', () => {
    const preview = previewDrag({ timeline, clipId: 'v1-aurora', deltaXPx: 700, deltaYPx: 60, scale: AT_100 });
    expect(preview.trackId).toBe('a1');
    expect(preview.refusal).toBe('track-kind-mismatch');
    // Still under the pointer: the user has to see where it is being taken.
    expect(preview.offsetPx).toBeGreaterThan(0);
  });

  it('reports an overlap without stopping the clip under the pointer', () => {
    // Dragged left onto Kael, which V1 already has.
    const preview = previewDrag({ timeline, clipId: 'v1-aurora', deltaXPx: -240, deltaYPx: 0, scale: AT_100 });
    expect(preview.refusal).toBe('overlap');
    expect(preview.start).toBeCloseTo(22.167, 3);
  });

  it('does nothing at all for a drag that has not moved', () => {
    // Selecting a clip must not move it. The fixture's V1 clips are 0.167s
    // apart — inside the snap radius — so without a dead zone a pointerdown
    // alone would shift this one onto its neighbour.
    const preview = previewDrag({ timeline, clipId: 'v1-aurora', deltaXPx: 0, deltaYPx: 0, scale: AT_100 });
    expect(preview).toEqual({ start: 42.167, trackId: 'v1', offsetPx: 0, snap: null, refusal: null });
  });

  it('does snap as soon as the pointer moves one pixel', () => {
    const preview = previewDrag({ timeline, clipId: 'v1-aurora', deltaXPx: 1, deltaYPx: 0, scale: AT_100 });
    expect(preview.snap).not.toBeNull();
  });

  it('clamps at t = 0 and stops the preview there', () => {
    const preview = previewDrag({ timeline, clipId: 'v2-kael', deltaXPx: -1000, deltaYPx: 0, scale: AT_100 });
    expect(preview.start).toBe(0);
    expect(preview.offsetPx).toBeCloseTo(-96, 6);
  });

  it('reports an unknown clip instead of throwing', () => {
    expect(previewDrag({ timeline, clipId: 'nope', deltaXPx: 10, deltaYPx: 0, scale: AT_100 }).refusal).toBe(
      'unknown-clip',
    );
  });

  it('never lets the offset disagree with the landing place', () => {
    for (let dx = -600; dx <= 600; dx += 37) {
      for (const dy of [-70, 0, 70]) {
        const preview = previewDrag({ timeline, clipId: 'v2-kael', deltaXPx: dx, deltaYPx: dy, scale: AT_100 });
        expect(preview.offsetPx).toBeCloseTo((preview.start - 8) * 12, 6);
        expect(preview.start).toBeGreaterThanOrEqual(0);
      }
    }
  });
});

describe('previewSlip', () => {
  it('is a pixel delta read as seconds at the current zoom', () => {
    expect(previewSlip(AT_100, 24)).toBe(2);
    expect(previewSlip(createTimeScale(2), 24)).toBe(1);
  });
});
