/*
 * Interaction tests, part 3 of 3 — the gestures phase 3f-2 added.
 *
 * Trimming by the edge handles, the frame grid seen through the DOM, pointer
 * capture, auto-scroll and the windowed clip set. Parts 1 and 2 cover the six
 * capabilities of §0.5; this file covers the four README gaps that had to be
 * closed before the timeline could carry real footage.
 *
 * The pointer mechanics are the same as part 2's and for the same reasons:
 * `MouseEvent`s with pointer-event names, and every measurement a delta rather
 * than a `getBoundingClientRect`. Where a test does need layout — auto-scroll
 * reads the viewport's rect — the rect is stubbed explicitly and the stub is
 * the point of the test.
 */

import { act, fireEvent } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderInteractive } from '../../test/render';
import { frameDuration } from './frameGrid';
import { createSampleTimeline } from './sampleTimeline';
import { TimelinePrototype } from './TimelinePrototype';
import { createTimeline, type Timeline } from './timelineModel';

const ORIGIN = { x: 400, y: 300 };
const FRAME = frameDuration(60);

function pointerEvent(type: string, clientX: number, clientY: number, pointerId = 7): MouseEvent {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX, clientY });
  Object.defineProperty(event, 'pointerId', { value: pointerId });
  return event;
}

/** Two clips on one lane, with source headroom at both ends of each. */
function twoUp(): Timeline {
  return createTimeline({
    tracks: [{ id: 'v1', kind: 'video', name: 'V1', role: '主画面' }],
    clips: [
      { id: 'left', trackId: 'v1', start: 0, duration: 10, sourceIn: 5, sourceDuration: 40, label: 'Left' },
      { id: 'right', trackId: 'v1', start: 20, duration: 10, sourceIn: 5, sourceDuration: 40, label: 'Right' },
    ],
    playhead: 0,
  });
}

function setup(initial: Timeline = twoUp()) {
  const view = renderInteractive(<TimelinePrototype initial={initial} />);
  const { container } = view;

  const clip = (id: string) => {
    const element = container.querySelector<HTMLButtonElement>(`[data-clip="${id}"]`);
    if (element === null) throw new Error(`no clip ${id}`);
    return element;
  };
  const handle = (id: string, edge: 'in' | 'out') => {
    const element = clip(id).querySelector<HTMLElement>(`.tl-clip-handle[data-edge="${edge}"]`);
    if (element === null) throw new Error(`no ${edge} handle on ${id}`);
    return element;
  };
  const num = (id: string, field: 'start' | 'duration' | 'sourceIn' | 'speed') => Number(clip(id).dataset[field]);
  const mountedIds = () =>
    [...container.querySelectorAll<HTMLElement>('.tl-clip')].map((element) => element.dataset.clip);
  const viewport = () => container.querySelector<HTMLElement>('.tl-viewport')!;

  const grabHandle = (id: string, edge: 'in' | 'out') => {
    fireEvent(handle(id, edge), pointerEvent('pointerdown', ORIGIN.x, ORIGIN.y));
  };
  const move = (dx: number) => fireEvent(window, pointerEvent('pointermove', ORIGIN.x + dx, ORIGIN.y));
  const release = (dx: number) => fireEvent(window, pointerEvent('pointerup', ORIGIN.x + dx, ORIGIN.y));
  const trim = (id: string, edge: 'in' | 'out', dx: number) => {
    grabHandle(id, edge);
    move(dx);
    release(dx);
  };

  return { ...view, clip, handle, num, mountedIds, viewport, grabHandle, move, release, trim };
}

describe('修剪 — dragging an edge handle', () => {
  it('moves the in point and the start together, and leaves the out point', () => {
    // 24px right at 12 px/s is 2s.
    const { trim, num } = setup();
    trim('left', 'in', 24);
    expect(num('left', 'start')).toBe(2);
    expect(num('left', 'duration')).toBe(8);
    expect(num('left', 'sourceIn')).toBe(7);
  });

  it('moves only the duration on the out edge', () => {
    const { trim, num } = setup();
    trim('left', 'out', 24);
    expect(num('left', 'start')).toBe(0);
    expect(num('left', 'duration')).toBe(12);
    expect(num('left', 'sourceIn')).toBe(5);
  });

  it('does not also start a move', () => {
    // The handle sits inside the clip's own button. Without the
    // `stopPropagation` the gesture would be a trim and a drag at once, and
    // the clip would travel while its edge was being pulled.
    const { grabHandle, move, release, clip, num } = setup();
    grabHandle('left', 'out', );
    move(24);
    expect(clip('left').style.getPropertyValue('--tl-dx')).toBe('0');
    release(24);
    expect(num('left', 'start')).toBe(0);
  });

  it('previews the edge while the pointer is down, without committing', () => {
    const { grabHandle, move, clip, num } = setup();
    grabHandle('left', 'out');
    move(60); // 5s
    expect(num('left', 'duration')).toBe(15);
    expect(clip('left').dataset.trimming).toBe('out');
    // The document has not moved: a cancelled trim needs no rollback, which is
    // the same arrangement a move drag has.
    fireEvent(window, new MouseEvent('pointercancel', { bubbles: true }));
    expect(num('left', 'duration')).toBe(10);
    expect(clip('left').dataset.trimming).toBe('false');
  });

  it('stops at the neighbour and says so on release', () => {
    // `right` starts at 20; `left` may grow 10s and no further.
    const { trim, num, queryByRole } = setup();
    trim('left', 'out', 12 * 40); // 40s of pointer travel
    expect(num('left', 'duration')).toBe(20);
    expect(num('right', 'start')).toBe(20);
    expect(queryByRole('alert')).toBeNull(); // it was clamped, not refused
  });

  it('stops at the end of the source', () => {
    // `right` starts at 20 with 10s of empty lane in front of it and 5s of
    // source head. It is the source that runs out first, at start = 15 —
    // `left` is only a limit from 10 back, and t = 0 is further still.
    const { trim, num } = setup();
    trim('right', 'in', -12 * 30);
    expect(num('right', 'sourceIn')).toBe(0);
    expect(num('right', 'start')).toBe(15);
  });

  it('refuses audibly when there is nothing left to give', () => {
    const { trim, num, queryByRole } = setup();
    trim('left', 'in', 12 * 40); // shrink it to one frame
    expect(num('left', 'duration')).toBeCloseTo(FRAME, 12);

    trim('left', 'in', 12); // and again
    expect(queryByRole('alert')?.textContent).toContain('再修剪就不足一帧了');
  });

  it('trims the linked partner by the same delta', () => {
    // Aurora ends at frame 4210 and Rhea starts at 4220, so the pair can only
    // grow by the 10 frames between them however far the pointer travels —
    // and both halves take exactly that, which is what keeps them in sync.
    const { trim, num } = setup(createSampleTimeline());
    trim('v1-aurora', 'out', 24);
    expect(num('v1-aurora', 'duration')).toBe(num('a1-aurora', 'duration'));
    expect(num('a1-aurora', 'duration')).toBeCloseTo(28 + 10 / 60, 9);
  });

  it('is reachable from the keyboard with Alt', () => {
    // 「全流程可键盘完成」 (§15.3). Alt+arrow trims the in point; adding Shift
    // trims the out point — one modifier pair for the one gesture that has two
    // targets.
    const { clip, num } = setup();
    act(() => clip('left').focus());

    fireEvent.keyDown(clip('left'), { key: 'ArrowRight', altKey: true });
    expect(num('left', 'start')).toBeCloseTo(0.1, 9);

    fireEvent.keyDown(clip('left'), { key: 'ArrowRight', altKey: true, shiftKey: true });
    expect(num('left', 'duration')).toBeCloseTo(10, 9);
  });

  it('undoes as one entry per gesture', () => {
    const { trim, num, getByRole } = setup();
    trim('left', 'out', 24);
    expect(num('left', 'duration')).toBe(12);
    fireEvent.click(getByRole('button', { name: '撤销' }));
    expect(num('left', 'duration')).toBe(10);
  });
});

describe('the frame grid, through the DOM', () => {
  it('lands a trim on a frame however far between two the pointer stopped', () => {
    // 7px at 12 px/s is 0.5833s — 35.0 frames exactly is 0.58333…, so this is
    // a pointer position deliberately off the grid.
    const { trim, num } = setup();
    trim('left', 'out', 7);
    const frames = num('left', 'duration') * 60;
    expect(Math.abs(frames - Math.round(frames))).toBeLessThan(1e-9);
  });

  it('quantises the document it was handed, before any edit', () => {
    // A project arriving from the service is not guaranteed to be on the grid.
    const offGrid = createTimeline({
      tracks: [{ id: 'v1', kind: 'video', name: 'V1', role: '主画面' }],
      clips: [{ id: 'a', trackId: 'v1', start: 1.001, duration: 3.999, sourceIn: 0, sourceDuration: 10, label: 'A' }],
    });
    const { num } = setup(offGrid);
    expect(num('a', 'start') * 60).toBeCloseTo(60, 9);
    expect(num('a', 'duration') * 60).toBeCloseTo(240, 9);
  });
});

describe('pointer capture', () => {
  afterEach(() => vi.restoreAllMocks());

  it('takes and releases the capture when the runtime has it', () => {
    // README gap 5: without capture, releasing outside the browser window
    // never delivers a `pointerup` and the gesture is stranded.
    const { handle } = setup();
    const element = handle('left', 'out');
    const set = vi.fn();
    const release = vi.fn();
    Object.assign(element, { setPointerCapture: set, releasePointerCapture: release });

    fireEvent(element, pointerEvent('pointerdown', ORIGIN.x, ORIGIN.y, 42));
    expect(set).toHaveBeenCalledWith(42);
    fireEvent(window, pointerEvent('pointerup', ORIGIN.x + 24, ORIGIN.y, 42));
    expect(release).toHaveBeenCalledWith(42);
  });

  it('drags perfectly well without it', () => {
    // jsdom implements neither method, so every other test in this file is
    // already the uncaptured path — this one states it.
    const { handle, trim, num } = setup();
    expect('setPointerCapture' in handle('left', 'out')).toBe(false);
    trim('left', 'out', 24);
    expect(num('left', 'duration')).toBe(12);
  });

  it('survives a runtime that throws from setPointerCapture', () => {
    // A pointer that ended between the event and the call throws
    // NotFoundError; the gesture is over and there is nothing to report.
    const { handle, num, move, release } = setup();
    const element = handle('left', 'out');
    Object.assign(element, {
      setPointerCapture: () => {
        throw new Error('NotFoundError');
      },
    });
    fireEvent(element, pointerEvent('pointerdown', ORIGIN.x, ORIGIN.y));
    move(24);
    release(24);
    expect(num('left', 'duration')).toBe(12);
  });
});

describe('auto-scroll', () => {
  afterEach(() => vi.restoreAllMocks());

  /**
   * jsdom performs no layout, so the viewport has no width and rAF never
   * advances a clock. Both are supplied explicitly: the rect is what the
   * velocity is computed from, and the frames are pumped by hand so the test
   * asserts on a known elapsed time rather than on wall time.
   */
  function withViewport(node: HTMLElement, rect: { left: number; width: number }) {
    vi.spyOn(node, 'getBoundingClientRect').mockReturnValue({
      left: rect.left,
      right: rect.left + rect.width,
      width: rect.width,
      height: 400,
      top: 0,
      bottom: 400,
      x: rect.left,
      y: 0,
      toJSON: () => ({}),
    } as DOMRect);
  }

  it('scrolls while the pointer is held in the edge band, without further movement', () => {
    // The whole reason the loop exists: a pointer held one pixel inside the
    // edge fires no events, so a scroll driven by `pointermove` would stop
    // dead exactly when the user means "keep going".
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    });
    vi.stubGlobal('cancelAnimationFrame', () => {});

    const long = createTimeline({
      tracks: [{ id: 'v1', kind: 'video', name: 'V1', role: '主画面' }],
      clips: [{ id: 'a', trackId: 'v1', start: 0, duration: 600, sourceIn: 0, sourceDuration: 600, label: 'A' }],
      playhead: 0,
    });
    const { viewport, clip, container } = setup(long);
    withViewport(viewport(), { left: 0, width: 1000 });

    fireEvent(clip('a'), pointerEvent('pointerdown', 990, ORIGIN.y));
    const canvas = () => container.querySelector<HTMLElement>('.tl-canvas')!;
    expect(canvas().style.getPropertyValue('--tl-scroll')).toBe('0');

    // The first callback establishes the clock and scrolls nothing; the second
    // is 200ms later. The pointer sits 10px inside a 48px band, so the ramp is
    // at (48 − 10) / 48 of the 720 px/s top speed — 570 px/s, and 114px in
    // 0.2s. Asserting the ramped value rather than the maximum is what proves
    // the speed comes from how deep the pointer is, not merely that it is
    // inside the band at all.
    act(() => {
      frames.at(-1)?.(0);
    });
    act(() => {
      frames.at(-1)?.(200);
    });
    expect(Number(canvas().style.getPropertyValue('--tl-scroll'))).toBeCloseTo(114, 6);
  });

  it('does not scroll from the middle of the viewport', () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    });
    vi.stubGlobal('cancelAnimationFrame', () => {});

    const { viewport, clip, container } = setup();
    withViewport(viewport(), { left: 0, width: 1000 });
    fireEvent(clip('left'), pointerEvent('pointerdown', 500, ORIGIN.y));
    act(() => {
      frames.at(-1)?.(0);
    });
    act(() => {
      frames.at(-1)?.(200);
    });
    expect(container.querySelector<HTMLElement>('.tl-canvas')!.style.getPropertyValue('--tl-scroll')).toBe('0');
  });
});

describe('virtualisation', () => {
  it('mounts every clip when the viewport has not been measured', () => {
    // jsdom reports `clientWidth` as 0, which is also the real first paint.
    const { mountedIds } = setup();
    expect(mountedIds()).toEqual(['left', 'right']);
  });

  it('is what the timeline renders from, not the whole document', () => {
    // The renderer reads `editor.mountedClips`. With no measured viewport that
    // is every clip, so this asserts the wiring rather than the culling —
    // `virtualize.test.ts` covers the arithmetic exhaustively.
    const { mountedIds } = setup(createSampleTimeline());
    expect(mountedIds()).toHaveLength(10);
  });
});
