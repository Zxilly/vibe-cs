/*
 * Interaction tests, part 2 of 2 — the pointer.
 *
 * 拖拽 and 吸附 of spec §0.5, driven the way the browser drives them: a
 * pointerdown on the clip, pointermoves on the window, a pointerup to commit.
 *
 * Two notes on the mechanics, both about jsdom rather than about the timeline:
 *
 *   · the events are built as `MouseEvent`s with a pointer event *name*.
 *     jsdom does not implement `PointerEvent`, and Testing Library's
 *     `fireEvent.pointerMove` would then fall back to a plain `Event`, which
 *     carries no `clientX` — the very thing under test.
 *   · every measurement is a *delta* between two pointer positions, never a
 *     `getBoundingClientRect`, so these tests exercise the same arithmetic the
 *     browser will run rather than a layout jsdom does not perform. That is a
 *     property of the implementation, not a concession to the test: a drag that
 *     needed layout would break the moment the lane scrolled.
 */

import { act, fireEvent } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { renderInteractive } from '../../test/render';
import { createSampleTimeline } from './sampleTimeline';
import { TimelinePrototype } from './TimelinePrototype';
import { createTimeline, type Timeline } from './timelineModel';

const ORIGIN = { x: 400, y: 300 };

function pointerEvent(type: string, clientX: number, clientY: number): MouseEvent {
  return new MouseEvent(type, { bubbles: true, cancelable: true, clientX, clientY });
}

/**
 * A time in frames — see the note in `TimelinePrototype.interaction.test.tsx`.
 * The fixture is the artboard's pixels ÷ 12 and the editor holds the document
 * on the 60fps grid, so 42.167s reaches the DOM as `2530 / 60`.
 */
const frames = (count: number) => count / 60;

function setup(initial: Timeline = createSampleTimeline()) {
  const view = renderInteractive(<TimelinePrototype initial={initial} />);
  const { container, getByRole } = view;

  const clip = (id: string) => {
    const element = container.querySelector<HTMLButtonElement>(`[data-clip="${id}"]`);
    if (element === null) throw new Error(`no clip ${id}`);
    return element;
  };
  const start = (id: string) => Number(clip(id).dataset.start);
  const offset = (id: string) => clip(id).style.getPropertyValue('--tl-dx');
  const laneOf = (id: string) => clip(id).closest('.tl-lane')?.getAttribute('data-track');
  const headOf = (trackId: string) =>
    container.querySelector<HTMLElement>(`.tl-head[data-track="${trackId}"]`)?.dataset.current;

  const grab = (id: string) => {
    fireEvent(clip(id), pointerEvent('pointerdown', ORIGIN.x, ORIGIN.y));
  };
  const move = (dx: number, dy = 0) => {
    fireEvent(window, pointerEvent('pointermove', ORIGIN.x + dx, ORIGIN.y + dy));
  };
  const release = (dx: number, dy = 0) => {
    fireEvent(window, pointerEvent('pointerup', ORIGIN.x + dx, ORIGIN.y + dy));
  };
  const drag = (id: string, dx: number, dy = 0) => {
    grab(id);
    move(dx, dy);
    release(dx, dy);
  };

  return { ...view, clip, start, offset, laneOf, headOf, grab, move, release, drag, getByRole };
}

/** One clip on a two-video-lane sequence: room to move without colliding. */
function sparseTimeline(): Timeline {
  return createTimeline({
    tracks: [
      { id: 'v2', kind: 'video', name: 'V2', role: '叠加' },
      { id: 'v1', kind: 'video', name: 'V1', role: '主画面' },
      { id: 'a1', kind: 'audio', name: 'A1', role: '原声' },
    ],
    clips: [{ id: 'x', trackId: 'v1', start: 10, duration: 4, sourceIn: 2, sourceDuration: 20, label: 'X' }],
    playhead: 0,
  });
}

describe('dragging within a lane', () => {
  it('translates the clip by the pointer distance, in seconds', () => {
    // 名牌 · Kael starts at 8; 120px at 12 px/s is 10s.
    const { drag, start } = setup();
    drag('v2-kael', 120);
    expect(start('v2-kael')).toBe(18);
  });

  it('writes one pixel offset while the pointer is down and commits on release', () => {
    const { grab, move, release, offset, start } = setup(sparseTimeline());
    grab('x');
    expect(offset('x')).toBe('0');

    move(60);
    expect(offset('x')).toBe('60');
    expect(start('x')).toBe(10); // the document has not changed yet

    release(60);
    expect(start('x')).toBe(15);
    expect(offset('x')).toBe('0');
  });

  it('reads the same pixel distance as fewer seconds once zoomed in', () => {
    const { getByRole, drag, start } = setup(sparseTimeline());
    fireEvent.click(getByRole('button', { name: '放大' })); // 24 px/s
    drag('x', 120);
    expect(start('x')).toBe(15);
  });

  it('clamps at the head of the sequence instead of going negative', () => {
    const { drag, start } = setup(sparseTimeline());
    drag('x', -1000);
    expect(start('x')).toBe(0);
  });

  it('does nothing at all when the pointer never moved', () => {
    const { grab, release, start, clip } = setup();
    grab('v1-aurora');
    release(0);
    expect(start('v1-aurora')).toBe(frames(2530));
    // …but it did select the clip, which is what a click on a clip means.
    expect(clip('v1-aurora').getAttribute('aria-pressed')).toBe('true');
  });

  it('abandons the gesture on pointercancel', () => {
    const { grab, move, start, offset } = setup(sparseTimeline());
    grab('x');
    move(240);
    expect(offset('x')).toBe('240');

    fireEvent(window, new Event('pointercancel', { bubbles: true }));
    expect(start('x')).toBe(10);
    expect(offset('x')).toBe('0');
  });
});

describe('吸附', () => {
  it('sticks the leading edge to a marker and says it has', () => {
    // 名牌 · Kael to 19.75 — a quarter second short of the 20s marker, well
    // inside the 8px radius at 12 px/s (0.667s).
    const { grab, move, offset, queryByTestId, release, start } = setup();
    grab('v2-kael');
    move(141);
    expect(offset('v2-kael')).toBe('144'); // snapped to 20s, not 19.75
    expect(queryByTestId('snap-readout')).not.toBeNull();

    release(141);
    expect(start('v2-kael')).toBe(20);
  });

  it('lets go when the toggle is off', () => {
    const { getByRole, drag, start } = setup();
    const snap = getByRole('switch', { name: '吸附' });
    expect(snap.getAttribute('aria-checked')).toBe('true');

    fireEvent.click(snap);
    expect(snap.getAttribute('aria-checked')).toBe('false');

    drag('v2-kael', 141);
    expect(start('v2-kael')).toBe(19.75);
  });

  it('needs a closer pointer at a higher zoom — the radius is in pixels', () => {
    const { getByRole, drag, start } = setup();
    fireEvent.click(getByRole('button', { name: '放大' })); // 24 px/s
    fireEvent.click(getByRole('button', { name: '放大' })); // 48 px/s
    // The same 0.25s gap is now 12px away, outside the 8px radius.
    drag('v2-kael', 141 * 4);
    expect(start('v2-kael')).toBe(19.75);
  });

  it('sticks the trailing edge to a neighbour’s leading edge', () => {
    // V1 Kael runs 0–42; Aurora starts at 42.167. Dragging the name plate so
    // its *right* edge lands near 42 snaps it to the seam.
    const { grab, move, release, start } = setup();
    // 名牌 · Kael is 8–23; to put its right edge at 41.9 it must start at 26.9,
    // which is 18.9s (226.8px) to the right.
    grab('v2-kael');
    move(226.8);
    release(226.8);
    expect(start('v2-kael')).toBeCloseTo(27, 6);
  });
});

describe('dragging across lanes', () => {
  it('follows the pointer up a lane and commits there', () => {
    const { grab, move, release, laneOf, headOf, start } = setup(sparseTimeline());
    expect(laneOf('x')).toBe('v1');

    grab('x');
    move(0, -40);
    // The document has not changed yet, but the head column already shows
    // where the clip is going.
    expect(laneOf('x')).toBe('v1');
    expect(headOf('v2')).toBe('true');

    release(0, -40);
    expect(laneOf('x')).toBe('v2');
    expect(start('x')).toBe(10);
  });

  it('paints a refusal while the pointer is over a lane it may not land on', () => {
    const { grab, move, release, clip, laneOf, queryByRole } = setup(sparseTimeline());
    grab('x');
    move(0, 100); // down onto A1

    expect(clip('x').dataset.blocked).toBe('true');
    expect(clip('x').style.getPropertyValue('--tl-dx')).toBe('0');

    release(0, 100);
    expect(laneOf('x')).toBe('v1');
    expect(queryByRole('alert')?.textContent).toContain('请将视频放到视频轨');
  });

  it('refuses a landing that would overlap, and says which rule stopped it', () => {
    const { drag, start, queryByRole } = setup();
    // Aurora dragged left onto Kael, which V1 already occupies.
    drag('v1-aurora', -240);
    expect(start('v1-aurora')).toBe(frames(2530));
    expect(queryByRole('alert')?.textContent).toContain('这里已经有片段了');
  });
});

describe('linked A/V', () => {
  it('moves the pair by the same offset while the pointer is down', () => {
    const { grab, move, offset } = setup();
    grab('v1-aurora');
    move(1200); // +100s, past everything in the fixture

    expect(offset('v1-aurora')).toBe('1200');
    expect(offset('a1-aurora')).toBe('1200');
    // An unrelated clip does not move.
    expect(offset('a2-music')).toBe('0');
  });

  it('commits both, keeping them in sync', () => {
    const { drag, start } = setup();
    drag('v1-aurora', 1200);
    expect(start('v1-aurora')).toBeCloseTo(frames(8530), 9);
    expect(start('a1-aurora')).toBe(start('v1-aurora'));
  });

  it('keeps the audio on its own lane when the video changes lane', () => {
    const { grab, move, release, laneOf } = setup();
    grab('v1-aurora');
    move(1200, -40); // up to V2, and clear of everything
    release(1200, -40);

    expect(laneOf('v1-aurora')).toBe('v2');
    expect(laneOf('a1-aurora')).toBe('a1');
  });
});

describe('the razor tool', () => {
  it('cuts the clip under the pointer at the playhead instead of dragging it', () => {
    const { getByRole, grab, container, clip } = setup();
    fireEvent.click(getByRole('radio', { name: '剃刀' }));

    grab('v1-kael'); // the playhead is at 31.167, inside it
    expect(container.querySelectorAll('.tl-clip')).toHaveLength(12);
    expect(clip('v1-kael~2').dataset.start).toBe(String(frames(1870)));
  });

  it('says so when the blade misses the clip it was aimed at', () => {
    const { getByRole, grab, queryByRole, container } = setup();
    fireEvent.click(getByRole('radio', { name: '剃刀' }));

    grab('v1-rhea'); // runs 70.333–86.666, the playhead is at 31.167
    expect(container.querySelectorAll('.tl-clip')).toHaveLength(10);
    expect(queryByRole('alert')?.textContent).toContain('这个位置没有可以操作的片段');
  });
});

describe('the slip tool', () => {
  it('slides the source window by the pointer distance and leaves the clip put', () => {
    const { getByRole, grab, move, release, clip, start } = setup();
    fireEvent.click(getByRole('radio', { name: '滑移' }));

    const before = Number(clip('v1-aurora').dataset.sourceIn);
    grab('v1-aurora');
    move(24); // 2s at 12 px/s
    // A slip never moves the clip, so nothing is offset while it is dragged.
    expect(clip('v1-aurora').style.getPropertyValue('--tl-dx')).toBe('0');

    release(24);
    expect(start('v1-aurora')).toBe(frames(2530));
    expect(Number(clip('v1-aurora').dataset.sourceIn)).toBeCloseTo(before + 2, 6);
    expect(Number(clip('a1-aurora').dataset.sourceIn)).toBeCloseTo(before + 2, 6);
  });

  it('clamps at the end of the source however far the pointer goes', () => {
    const { getByRole, drag, clip } = setup();
    fireEvent.click(getByRole('radio', { name: '滑移' }));
    drag('v1-aurora', 6000);
    expect(Number(clip('v1-aurora').dataset.sourceIn)).toBeCloseTo(8, 6);
  });
});

describe('the drag listeners', () => {
  it('are gone once the gesture ends', () => {
    const { drag, move, start } = setup(sparseTimeline());
    drag('x', 60);
    expect(start('x')).toBe(15);

    // A stray pointermove afterwards must not move anything.
    act(() => {
      move(600);
    });
    expect(start('x')).toBe(15);
  });
});
