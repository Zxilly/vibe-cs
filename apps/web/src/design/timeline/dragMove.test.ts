import { describe, expect, it } from 'vitest';

import { moveClip, moveClipBy, planMove } from './dragMove';
import { createLinearTimeline, createSampleTimeline } from './sampleTimeline';
import {
  clipEnd,
  clipSourceOut,
  createTimeline,
  getClip,
  type Timeline,
} from './timelineModel';

function twoLane(): Timeline {
  return createTimeline({
    tracks: [
      { id: 'v2', kind: 'video', name: 'V2', role: '叠加' },
      { id: 'v1', kind: 'video', name: 'V1', role: '主画面' },
      { id: 'a1', kind: 'audio', name: 'A1', role: '原声' },
    ],
    clips: [
      { id: 'v', trackId: 'v1', start: 10, duration: 4, sourceIn: 0, sourceDuration: 20, label: 'v', linkId: 'g' },
      { id: 'a', trackId: 'a1', start: 10, duration: 4, sourceIn: 0, sourceDuration: 20, label: 'a', linkId: 'g' },
      { id: 'blocker', trackId: 'v1', start: 20, duration: 4, sourceIn: 0, sourceDuration: 20, label: 'blocker' },
    ],
  });
}

describe('moving within a track', () => {
  it('translates a clip and leaves everything else where it was', () => {
    const before = createLinearTimeline();
    const { timeline, applied, deltaSeconds } = moveClip(before, 'c', 20);
    expect(applied).toBe(true);
    expect(deltaSeconds).toBe(12);
    expect(getClip(timeline, 'c')!.start).toBe(20);
    expect(getClip(timeline, 'a')!.start).toBe(0);
    expect(getClip(timeline, 'b')!.start).toBe(4);
  });

  it('changes nothing about the clip but its position', () => {
    const moved = getClip(moveClip(createLinearTimeline(), 'b', 20).timeline, 'b')!;
    const original = getClip(createLinearTimeline(), 'b')!;
    expect(moved).toEqual({ ...original, start: 20 });
    // In particular the source window: a move is not a slip.
    expect(moved.sourceIn).toBe(original.sourceIn);
    expect(clipSourceOut(moved)).toBe(clipSourceOut(original));
  });

  it('reports a move to where it already is as no change', () => {
    const before = createLinearTimeline();
    const result = moveClip(before, 'b', 4);
    expect(result.applied).toBe(false);
    expect(result.reason).toBe('no-change');
    expect(result.timeline).toBe(before);
  });

  it('addresses a nudge by delta', () => {
    const { timeline } = moveClipBy(createLinearTimeline(), 'c', 0.5);
    expect(getClip(timeline, 'c')!.start).toBe(8.5);
    // …and a nudge into its neighbour is refused like any other collision.
    expect(moveClipBy(createLinearTimeline(), 'c', -0.5).reason).toBe('overlap');
  });
});

describe('the left bound', () => {
  /** One clip alone at 4s, so a clamp at zero cannot also be a collision. */
  function lone(): Timeline {
    return createTimeline({
      tracks: [{ id: 'v1', kind: 'video', name: 'V1', role: '主画面' }],
      clips: [{ id: 'b', trackId: 'v1', start: 4, duration: 4, sourceIn: 2, sourceDuration: 10, label: 'b' }],
    });
  }

  it('clamps at zero rather than refusing, by default', () => {
    const { timeline, applied, deltaSeconds } = moveClip(lone(), 'b', -10);
    expect(applied).toBe(true);
    expect(deltaSeconds).toBe(-4);
    expect(getClip(timeline, 'b')!.start).toBe(0);
  });

  it('refuses instead when the caller wants to say so', () => {
    const result = moveClip(lone(), 'b', -10, { clampToOrigin: false });
    expect(result.applied).toBe(false);
    expect(result.reason).toBe('out-of-bounds');
  });

  it('a clamp that lands on a neighbour is still a collision', () => {
    // `b` clamped to 0 lands exactly on `a`, and the overlap rule wins.
    expect(moveClip(createLinearTimeline(), 'b', -10).reason).toBe('overlap');
  });

  it('clamps a link group by its earliest member, keeping the pair in sync', () => {
    const timeline = createTimeline({
      tracks: [
        { id: 'v1', kind: 'video', name: 'V1', role: '主画面' },
        { id: 'a1', kind: 'audio', name: 'A1', role: '原声' },
      ],
      clips: [
        { id: 'v', trackId: 'v1', start: 6, duration: 4, sourceIn: 0, sourceDuration: 20, label: 'v', linkId: 'g' },
        { id: 'a', trackId: 'a1', start: 2, duration: 4, sourceIn: 0, sourceDuration: 20, label: 'a', linkId: 'g' },
      ],
    });
    const { timeline: next, deltaSeconds } = moveClip(timeline, 'v', 0);
    expect(deltaSeconds).toBe(-2); // limited by `a`, not by `v`
    expect(getClip(next, 'v')!.start).toBe(4);
    expect(getClip(next, 'a')!.start).toBe(0);
  });

  it('has no right bound — the sequence grows', () => {
    const { timeline } = moveClip(createLinearTimeline(), 'a', 1000);
    expect(getClip(timeline, 'a')!.start).toBe(1000);
  });
});

describe('moving across tracks', () => {
  it('moves the clip to another lane of the same kind', () => {
    const { timeline, applied } = moveClip(twoLane(), 'v', 40, { toTrackId: 'v2' });
    expect(applied).toBe(true);
    expect(getClip(timeline, 'v')!.trackId).toBe('v2');
    expect(getClip(timeline, 'v')!.start).toBe(40);
  });

  it('refuses a video clip on an audio lane, and says why', () => {
    const before = twoLane();
    const result = moveClip(before, 'v', 40, { toTrackId: 'a1' });
    expect(result.applied).toBe(false);
    expect(result.reason).toBe('track-kind-mismatch');
    expect(result.timeline).toBe(before);
  });

  it('keeps a linked partner on its own lane while it shifts in time', () => {
    // The A/V pair dragged onto V2: the audio must not follow onto a video lane.
    const { timeline } = moveClip(twoLane(), 'v', 40, { toTrackId: 'v2' });
    expect(getClip(timeline, 'a')!.trackId).toBe('a1');
    expect(getClip(timeline, 'a')!.start).toBe(40);
  });

  it('refuses an unknown destination', () => {
    expect(moveClip(twoLane(), 'v', 40, { toTrackId: 'nope' }).reason).toBe('unknown-track');
    expect(moveClip(twoLane(), 'nope', 40).reason).toBe('unknown-clip');
  });

  it('refuses to move onto or off a locked lane', () => {
    const timeline = createTimeline({
      tracks: [
        { id: 'v1', kind: 'video', name: 'V1', role: '主画面' },
        { id: 'v2', kind: 'video', name: 'V2', role: '叠加', locked: true },
      ],
      clips: [
        { id: 'a', trackId: 'v1', start: 0, duration: 4, sourceIn: 0, sourceDuration: 20, label: 'a' },
        { id: 'b', trackId: 'v2', start: 0, duration: 4, sourceIn: 0, sourceDuration: 20, label: 'b' },
      ],
    });
    expect(moveClip(timeline, 'a', 10, { toTrackId: 'v2' }).reason).toBe('track-locked');
    expect(moveClip(timeline, 'b', 10).reason).toBe('track-locked');
  });
});

describe('overlap: reject (the default)', () => {
  it('refuses a landing that would collide and changes nothing', () => {
    const before = twoLane();
    const result = moveClip(before, 'v', 18);
    expect(result.applied).toBe(false);
    expect(result.reason).toBe('overlap');
    expect(result.timeline).toBe(before);
  });

  it('allows a landing that only touches — butt joints are legal', () => {
    const { timeline, applied } = moveClip(twoLane(), 'v', 16);
    expect(applied).toBe(true);
    expect(clipEnd(getClip(timeline, 'v')!)).toBe(20);
  });

  it('also refuses when the collision is on a linked partner’s lane', () => {
    const timeline = createTimeline({
      tracks: [
        { id: 'v1', kind: 'video', name: 'V1', role: '主画面' },
        { id: 'a1', kind: 'audio', name: 'A1', role: '原声' },
      ],
      clips: [
        { id: 'v', trackId: 'v1', start: 0, duration: 4, sourceIn: 0, sourceDuration: 20, label: 'v', linkId: 'g' },
        { id: 'a', trackId: 'a1', start: 0, duration: 4, sourceIn: 0, sourceDuration: 20, label: 'a', linkId: 'g' },
        { id: 'other', trackId: 'a1', start: 10, duration: 4, sourceIn: 0, sourceDuration: 20, label: 'other' },
      ],
    });
    // V1 is empty at 12, but A1 is not — and the pair moves together.
    expect(moveClip(timeline, 'v', 12).reason).toBe('overlap');
  });

  it('never collides with itself', () => {
    const { applied } = moveClip(twoLane(), 'v', 11);
    expect(applied).toBe(true);
  });
});

describe('overlap: overwrite', () => {
  const OVERWRITE = { overlap: 'overwrite' as const };

  it('trims a clip it lands on from the left', () => {
    // `v` (4s) dropped at 18 covers 18–22; `blocker` runs 20–24.
    const { timeline, removedIds, createdIds } = moveClip(twoLane(), 'v', 18, OVERWRITE);
    const blocker = getClip(timeline, 'blocker')!;
    expect(removedIds).toEqual([]);
    expect(createdIds).toEqual([]);
    expect(blocker.start).toBe(22);
    expect(blocker.duration).toBe(2);
    // The head that was overwritten is skipped in the source too.
    expect(blocker.sourceIn).toBe(2);
  });

  it('trims a clip it lands on from the right, keeping the source window', () => {
    const { timeline } = moveClip(twoLane(), 'v', 22, OVERWRITE);
    const blocker = getClip(timeline, 'blocker')!;
    expect(blocker.start).toBe(20);
    expect(blocker.duration).toBe(2);
    expect(blocker.sourceIn).toBe(0);
  });

  it('removes a clip it covers completely', () => {
    const timeline = twoLane();
    const wide = moveClip(
      { ...timeline, clips: timeline.clips.map((clip) => (clip.id === 'v' ? { ...clip, duration: 10 } : clip)) },
      'v',
      18,
      OVERWRITE,
    );
    expect(wide.removedIds).toEqual(['blocker']);
    expect(getClip(wide.timeline, 'blocker')).toBeUndefined();
  });

  it('splits a clip it lands in the middle of', () => {
    const timeline = createTimeline({
      tracks: [{ id: 'v1', kind: 'video', name: 'V1', role: '主画面' }],
      clips: [
        { id: 'wide', trackId: 'v1', start: 0, duration: 20, sourceIn: 0, sourceDuration: 20, label: 'wide' },
        { id: 'small', trackId: 'v1', start: 40, duration: 4, sourceIn: 0, sourceDuration: 4, label: 'small' },
      ],
    });
    const { timeline: next, createdIds } = moveClip(timeline, 'small', 8, OVERWRITE);
    expect(createdIds).toEqual(['wide~2']);

    const head = getClip(next, 'wide')!;
    const tail = getClip(next, 'wide~2')!;
    expect([head.start, head.duration, head.sourceIn]).toEqual([0, 8, 0]);
    expect([tail.start, tail.duration, tail.sourceIn]).toEqual([12, 8, 12]);
    expect(getClip(next, 'small')!.start).toBe(8);
  });

  it('leaves no overlaps behind, whatever it lands on', () => {
    const base = twoLane();
    for (let start = 0; start <= 30; start += 0.5) {
      const { timeline } = moveClip(base, 'v', start, OVERWRITE);
      const lane = timeline.clips.filter((clip) => clip.trackId === 'v1');
      for (let index = 1; index < lane.length; index += 1) {
        expect(lane[index]!.start).toBeGreaterThanOrEqual(clipEnd(lane[index - 1]!) - 1e-9);
      }
    }
  });
});

describe('planMove', () => {
  it('answers where a drag would land without producing a document', () => {
    // 100s is past everything the fixture draws, so nothing here is about
    // collision — only about where the two members of the pair end up.
    const plan = planMove(createSampleTimeline(), 'v1-aurora', 100, { toTrackId: 'v2' });
    expect(plan.refusal).toBeUndefined();
    // The dragged clip changes lane; its audio partner keeps A1 and only shifts.
    expect(plan.placements.map((placement) => [placement.clipId, placement.trackId])).toEqual([
      ['v1-aurora', 'v2'],
      ['a1-aurora', 'a1'],
    ]);
    for (const placement of plan.placements) {
      expect(placement.start).toBeCloseTo(100, 9);
      expect(placement.duration).toBe(28);
    }
  });

  it('reports the refusal a live drag should paint', () => {
    expect(planMove(createSampleTimeline(), 'v1-aurora', 50, { toTrackId: 'a2' }).refusal).toBe(
      'track-kind-mismatch',
    );
    expect(planMove(twoLane(), 'v', 18).refusal).toBe('overlap');
    expect(planMove(twoLane(), 'v', 18).collisions.map((clip) => clip.id)).toEqual(['blocker']);
  });

  it('reports the clamped delta, so the preview stops where the commit will', () => {
    expect(planMove(createLinearTimeline(), 'b', -100).deltaSeconds).toBe(-4);
  });
});
