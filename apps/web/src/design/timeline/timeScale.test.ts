import { describe, expect, it } from 'vitest';

import {
  BASE_PIXELS_PER_SECOND,
  chooseTickStep,
  clampZoom,
  createTimeScale,
  formatFrameTimecode,
  formatTimecode,
  MAX_ZOOM,
  MIN_ZOOM,
  nextZoom,
  pxToTime,
  rulerTicks,
  timeAtViewportPx,
  timeToPx,
  ZOOM_STEPS,
  zoomAtAnchor,
} from './timeScale';

describe('time scale', () => {
  it('puts one second at twelve pixels at 100%', () => {
    // The artboard's 「缩放 1 秒 = 12 px」.
    expect(BASE_PIXELS_PER_SECOND).toBe(12);
    expect(createTimeScale(1).pixelsPerSecond).toBe(12);
  });

  it('reproduces the drawn clip widths', () => {
    const scale = createTimeScale(1);
    expect(timeToPx(scale, 42)).toBe(504);
    expect(timeToPx(scale, 28)).toBe(336);
    expect(timeToPx(scale, 86.667)).toBeCloseTo(1040, 1);
  });

  it('round-trips pixels and seconds at every zoom stop', () => {
    for (const zoom of ZOOM_STEPS) {
      const scale = createTimeScale(zoom);
      for (const seconds of [0, 0.25, 1, 42.167, 3600]) {
        expect(pxToTime(scale, timeToPx(scale, seconds))).toBeCloseTo(seconds, 9);
      }
    }
  });

  it('clamps zoom to its bounds and survives nonsense', () => {
    expect(clampZoom(0)).toBe(MIN_ZOOM);
    expect(clampZoom(1000)).toBe(MAX_ZOOM);
    expect(clampZoom(Number.POSITIVE_INFINITY)).toBe(MAX_ZOOM);
    expect(clampZoom(Number.NEGATIVE_INFINITY)).toBe(MIN_ZOOM);
    // NaN has no side to fall to; 100% is the only answer that is not a lie.
    expect(clampZoom(Number.NaN)).toBe(1);
  });

  it('steps one stop at a time, and stops at the ends', () => {
    expect(nextZoom(1, 1)).toBe(2);
    expect(nextZoom(1, -1)).toBe(0.5);
    // An off-ladder zoom moves to the neighbouring stop, not past it.
    expect(nextZoom(1.5, 1)).toBe(2);
    expect(nextZoom(1.5, -1)).toBe(1);
    expect(nextZoom(MAX_ZOOM, 1)).toBe(MAX_ZOOM);
    expect(nextZoom(MIN_ZOOM, -1)).toBe(MIN_ZOOM);
  });
});

describe('zoom anchoring', () => {
  it('keeps the time under the cursor under the cursor', () => {
    const from = createTimeScale(1);
    const to = createTimeScale(2);
    // 31.167s sits at content px 374; with 200px scrolled away it is 174px
    // into the viewport.
    const scrollPx = zoomAtAnchor({ from, to, scrollPx: 200, anchorPx: 174 });
    expect(timeAtViewportPx(to, scrollPx, 174)).toBeCloseTo(timeAtViewportPx(from, 200, 174), 9);
  });

  it('never scrolls to a negative offset', () => {
    const from = createTimeScale(4);
    const to = createTimeScale(0.25);
    expect(zoomAtAnchor({ from, to, scrollPx: 0, anchorPx: 600 })).toBe(0);
  });

  it('is its own inverse', () => {
    const a = createTimeScale(1);
    const b = createTimeScale(8);
    const out = zoomAtAnchor({ from: a, to: b, scrollPx: 480, anchorPx: 300 });
    expect(zoomAtAnchor({ from: b, to: a, scrollPx: out, anchorPx: 300 })).toBeCloseTo(480, 6);
  });
});

describe('ruler ticks', () => {
  it('labels every ten seconds at 100%, as drawn', () => {
    const ticks = rulerTicks(createTimeScale(1), { toSeconds: 60 });
    const labelled = ticks.filter((tick) => tick.major);
    expect(labelled.map((tick) => tick.label)).toEqual([
      '00:00',
      '00:10',
      '00:20',
      '00:30',
      '00:40',
      '00:50',
      '01:00',
    ]);
    // 120px apart, the artboard's ruler spans.
    expect(labelled[1]!.px - labelled[0]!.px).toBe(120);
  });

  it('draws subdivisions between the labels', () => {
    const ticks = rulerTicks(createTimeScale(1), { toSeconds: 20 });
    expect(ticks.filter((tick) => !tick.major).map((tick) => tick.time)).toEqual([5, 15]);
  });

  it('coarsens as the view zooms out and refines as it zooms in', () => {
    const wide = rulerTicks(createTimeScale(0.125), { toSeconds: 600 }).filter((tick) => tick.major);
    const close = rulerTicks(createTimeScale(8), { toSeconds: 10 }).filter((tick) => tick.major);
    expect(wide[1]!.time - wide[0]!.time).toBeGreaterThan(10);
    expect(close[1]!.time - close[0]!.time).toBeLessThan(10);
    // The invariant that matters: labels never crowd past the minimum gap.
    for (const ticks of [wide, close]) {
      expect(ticks[1]!.px - ticks[0]!.px).toBeGreaterThanOrEqual(90);
    }
  });

  it('places every tick where a clip at the same time would be', () => {
    const scale = createTimeScale(2);
    for (const tick of rulerTicks(scale, { toSeconds: 90 })) {
      expect(tick.px).toBeCloseTo(timeToPx(scale, tick.time), 9);
    }
  });

  it('does not drift over a long ruler', () => {
    const ticks = rulerTicks(createTimeScale(1), { toSeconds: 1200 });
    const last = ticks[ticks.length - 1];
    expect(last!.time).toBe(1200);
  });

  it('is empty for an empty range and bounded for an absurd one', () => {
    expect(rulerTicks(createTimeScale(1), { toSeconds: 0 })).toEqual([]);
    expect(rulerTicks(createTimeScale(16), { toSeconds: 1e9 }).length).toBeLessThanOrEqual(2000);
  });

  it('starts at the first tick at or after the range start', () => {
    const ticks = rulerTicks(createTimeScale(1), { fromSeconds: 12, toSeconds: 40 });
    expect(ticks[0]!.time).toBe(15);
  });

  it('chooses the smallest ladder step that clears the minimum gap', () => {
    expect(chooseTickStep(7.5)).toBe(10);
    expect(chooseTickStep(10)).toBe(10);
    expect(chooseTickStep(10.1)).toBe(15);
  });
});

describe('timecode', () => {
  it('prints mm:ss below an hour and h:mm:ss above it', () => {
    expect(formatTimecode(0)).toBe('00:00');
    expect(formatTimecode(31.167)).toBe('00:31');
    expect(formatTimecode(124)).toBe('02:04');
    expect(formatTimecode(3661)).toBe('1:01:01');
    expect(formatTimecode(-5)).toBe('-00:05');
  });

  it('prints the artboard frame timecodes', () => {
    // 「00:00:31:12」 on the monitor, 「00:00:04:08」 in the Inspector.
    expect(formatFrameTimecode(31.2)).toBe('00:00:31:12');
    expect(formatFrameTimecode(4.133)).toBe('00:00:04:07');
    expect(formatFrameTimecode(0)).toBe('00:00:00:00');
  });

  it('never prints a frame number equal to the frame rate', () => {
    expect(formatFrameTimecode(0.9999, 60)).toBe('00:00:00:59');
    for (let step = 0; step < 600; step += 1) {
      const printed = formatFrameTimecode(step / 60 + 1 / 240, 60);
      expect(Number(printed.slice(-2))).toBeLessThan(60);
    }
  });
});
