/*
 * Design system, layer 1 of 3 — multi-track timeline prototype (spec §0.5).
 *
 * The artboard, transcribed. Spec §0.5: 「不接任何真实数据」 — this is the fixture
 * the prototype and its tests run on, and the only place clip labels appear.
 *
 * Every position is the drawn pixel divided by 12 (「缩放 1 秒 = 12 px」):
 *
 *   V1  left 0   width 504 → 0.000 – 42.000   Kael_Mirage_1v3.mp4
 *       left 506 width 336 → 42.167 – 70.167  Aurora_R13_ace.mp4   ← 已选中
 *       left 844 width 196 → 70.333 – 86.667  Rhea_double.mp4
 *   A1  the same three, which is what makes them A/V pairs
 *   A2  left 0   width 1040 → 0.000 – 86.667  low-orbit.mp3
 *   V2  left 96  width 180 → 8.000 – 23.000   名牌 · Kael
 *       left 840 width 150 → 70.000 – 82.500  名牌 · Rhea
 *   T1  left 96  width 120 → 8.000 – 18.000   1v3 CLUTCH
 *   markers   left 240 / 660 → 20.000 / 55.000
 *   playhead  left 374       → 31.167 ≈ the monitor's 00:00:31:12
 *
 * Two departures, both to make the prototype exercisable:
 *
 *   · `sourceDuration` exceeds `duration` on the middle pair, so 滑移 has
 *     somewhere to go. The artboard is internally inconsistent here — the
 *     library lists Aurora_R13_ace.mp4 at 28.0 s while the Inspector reads its
 *     in / out as 00:00:04:08 / 00:00:32:02, which needs at least 32.03 s of
 *     source. The Inspector's in point is kept and the source lengthened.
 *   · the V2 name plates stay `video` clips on a `video` lane. `overlay` is a
 *     real `TrackKind` now, and a name plate is the thing it describes — but
 *     the artboard draws the lane as 「V2」, and a V lane is a video lane. The
 *     kind is what the document would say; the fixture is what the artboard
 *     drew. It also keeps a cross-track drag between V1 and V2 legal, which
 *     several tests need and no pair of lanes in the artboard would otherwise
 *     provide.
 *   · the times are the drawn pixels ÷ 12 and are therefore *not* on the 60fps
 *     grid: 42.167 s is frame 2530.02. That is left alone deliberately. A
 *     project arriving from elsewhere is not on the grid either, and the
 *     editor's answer is the same in both cases — the first commit quantises
 *     the document (`frameGrid.ts`), so a test that edits this fixture sees
 *     42.166666… afterwards. Rewriting the fixture to pre-quantised values
 *     would hide the one behaviour the grid exists to provide.
 */

import { createTimeline, type Timeline } from './timelineModel';

/** The drawn sequence. A fresh object per call — callers mutate their own copy. */
export function createSampleTimeline(): Timeline {
  return createTimeline({
    tracks: [
      { id: 'v2', kind: 'video', name: 'V2', role: '叠加' },
      { id: 'v1', kind: 'video', name: 'V1', role: '主画面' },
      { id: 'a1', kind: 'audio', name: 'A1', role: '原声' },
      { id: 'a2', kind: 'audio', name: 'A2', role: '音乐' },
      { id: 't1', kind: 'text', name: 'T1', role: '字幕' },
    ],
    clips: [
      {
        id: 'v2-kael',
        trackId: 'v2',
        start: 8,
        duration: 15,
        sourceIn: 0,
        sourceDuration: 15,
        label: '名牌 · Kael',
      },
      {
        id: 'v2-rhea',
        trackId: 'v2',
        start: 70,
        duration: 12.5,
        sourceIn: 0,
        sourceDuration: 12.5,
        label: '名牌 · Rhea',
      },
      {
        id: 'v1-kael',
        trackId: 'v1',
        start: 0,
        duration: 42,
        sourceIn: 0,
        sourceDuration: 48,
        label: 'Kael_Mirage_1v3.mp4',
        linkId: 'av-kael',
      },
      {
        id: 'v1-aurora',
        trackId: 'v1',
        start: 42.167,
        duration: 28,
        sourceIn: 4.133,
        sourceDuration: 36,
        label: 'Aurora_R13_ace.mp4',
        linkId: 'av-aurora',
      },
      {
        id: 'v1-rhea',
        trackId: 'v1',
        start: 70.333,
        duration: 16.333,
        sourceIn: 0,
        sourceDuration: 16.4,
        label: 'Rhea_double.mp4',
        linkId: 'av-rhea',
      },
      {
        id: 'a1-kael',
        trackId: 'a1',
        start: 0,
        duration: 42,
        sourceIn: 0,
        sourceDuration: 48,
        label: 'Kael_Mirage_1v3 · 原声',
        linkId: 'av-kael',
      },
      {
        id: 'a1-aurora',
        trackId: 'a1',
        start: 42.167,
        duration: 28,
        sourceIn: 4.133,
        sourceDuration: 36,
        label: 'Aurora_R13_ace · 原声',
        linkId: 'av-aurora',
      },
      {
        id: 'a1-rhea',
        trackId: 'a1',
        start: 70.333,
        duration: 16.333,
        sourceIn: 0,
        sourceDuration: 16.4,
        label: 'Rhea_double · 原声',
        linkId: 'av-rhea',
      },
      {
        id: 'a2-music',
        trackId: 'a2',
        start: 0,
        duration: 86.667,
        sourceIn: 0,
        sourceDuration: 192,
        label: 'low-orbit.mp3',
      },
      {
        id: 't1-clutch',
        trackId: 't1',
        start: 8,
        duration: 10,
        sourceIn: 0,
        sourceDuration: 10,
        label: '1v3 CLUTCH',
      },
    ],
    markers: [
      { id: 'm-entry', time: 20, label: '入场' },
      { id: 'm-clutch', time: 55, label: '残局开始' },
    ],
    playhead: 31.167,
  });
}

/**
 * A three-clip single-lane sequence: the shape most unit tests want, where the
 * artboard fixture's link groups would only be noise.
 */
export function createLinearTimeline(): Timeline {
  return createTimeline({
    tracks: [{ id: 'v1', kind: 'video', name: 'V1', role: '主画面' }],
    clips: [
      { id: 'a', trackId: 'v1', start: 0, duration: 4, sourceIn: 0, sourceDuration: 10, label: 'A' },
      { id: 'b', trackId: 'v1', start: 4, duration: 4, sourceIn: 2, sourceDuration: 10, label: 'B' },
      { id: 'c', trackId: 'v1', start: 8, duration: 4, sourceIn: 0, sourceDuration: 10, label: 'C' },
    ],
    playhead: 0,
  });
}
