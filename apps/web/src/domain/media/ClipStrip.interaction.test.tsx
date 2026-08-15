/*
 * Interaction tests — reordering a clip strip.
 *
 * The keyboard path carries the assertions about *where a clip lands*: jsdom
 * performs no layout, so every tile spans [0, 0] and `dropIndex` (correctly)
 * refuses to move anything during a pointer drag there. The pointer tests
 * therefore assert what a pointer test can honestly assert in jsdom — that the
 * gesture is bound to the window, that it marks its tile, and that it ends
 * cleanly — while the landing arithmetic is exhausted in `clipOrder.test.ts`.
 *
 * The events are built as `MouseEvent`s with a pointer event *name*, for the
 * reason `design/timeline/timelineDrag.interaction.test.tsx` records: jsdom
 * has no `PointerEvent`, and Testing Library's `fireEvent.pointerDown` would
 * fall back to a plain `Event` carrying neither `clientX` nor `button`.
 */

import { act, fireEvent } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { renderInteractive } from '../../test/render';
import { ClipStrip, type ClipReorder } from './ClipStrip';
import type { MediaClip } from './types';

const clips: MediaClip[] = [
  { id: 'c1', title: 'Mirage 1v3 残局', durationSeconds: 42 },
  { id: 'c2', title: 'Ancient 穿墙双杀', durationSeconds: 18.4 },
  { id: 'c3', title: 'Nuke 匪口三杀', durationSeconds: 12.7 },
];

function pointerEvent(type: string, clientX: number, button = 0): MouseEvent {
  return new MouseEvent(type, { bubbles: true, cancelable: true, clientX, button });
}

function setup(selectedId: string | null = null) {
  const onReorder = vi.fn<(next: readonly MediaClip[], move: ClipReorder) => void>();
  const onSelect = vi.fn<(id: string) => void>();

  const view = renderInteractive(
    <ClipStrip clips={clips} selectedId={selectedId} onReorder={onReorder} onSelect={onSelect} />,
  );

  const tile = (id: string) => {
    const element = view.container.querySelector<HTMLButtonElement>(`[data-clip="${id}"]`);
    if (element === null) throw new Error(`no clip ${id}`);
    return element;
  };
  const focus = (id: string) => {
    const element = tile(id);
    act(() => {
      element.focus();
    });
    return element;
  };
  const grab = (id: string, clientX = 100, button = 0) =>
    fireEvent(tile(id), pointerEvent('pointerdown', clientX, button));
  const move = (clientX: number) => fireEvent(window, pointerEvent('pointermove', clientX));
  const release = (clientX: number) => fireEvent(window, pointerEvent('pointerup', clientX));

  return { ...view, onReorder, onSelect, tile, focus, grab, move, release };
}

describe('ClipStrip keyboard reordering', () => {
  it('moves the focused tile one slot with Ctrl and an arrow', () => {
    const { tile, onReorder } = setup();
    fireEvent.keyDown(tile('c1'), { key: 'ArrowRight', ctrlKey: true });

    expect(onReorder).toHaveBeenCalledTimes(1);
    const call = onReorder.mock.calls[0];
    expect(call?.[0].map((clip) => clip.id)).toEqual(['c2', 'c1', 'c3']);
    expect(call?.[1]).toEqual({ from: 0, to: 1 });
  });

  it('moves backward as well', () => {
    const { tile, onReorder } = setup();
    fireEvent.keyDown(tile('c3'), { key: 'ArrowLeft', ctrlKey: true });
    expect(onReorder.mock.calls[0]?.[0].map((clip) => clip.id)).toEqual(['c1', 'c3', 'c2']);
  });

  it('accepts ⌘ as well as Ctrl', () => {
    const { tile, onReorder } = setup();
    fireEvent.keyDown(tile('c1'), { key: 'ArrowRight', metaKey: true });
    expect(onReorder).toHaveBeenCalledTimes(1);
  });

  it('refuses to move past either end instead of wrapping', () => {
    const { tile, onReorder } = setup();
    fireEvent.keyDown(tile('c1'), { key: 'ArrowLeft', ctrlKey: true });
    fireEvent.keyDown(tile('c3'), { key: 'ArrowRight', ctrlKey: true });
    expect(onReorder).not.toHaveBeenCalled();
  });

  it('never mutates the strip it was given', () => {
    const { tile } = setup();
    fireEvent.keyDown(tile('c1'), { key: 'ArrowRight', ctrlKey: true });
    expect(clips.map((clip) => clip.id)).toEqual(['c1', 'c2', 'c3']);
  });

  it('walks the strip with a plain arrow, without reordering', () => {
    const { focus, tile, onReorder } = setup();
    focus('c1');
    fireEvent.keyDown(tile('c1'), { key: 'ArrowRight' });
    expect(document.activeElement).toBe(tile('c2'));

    fireEvent.keyDown(tile('c2'), { key: 'ArrowLeft' });
    expect(document.activeElement).toBe(tile('c1'));
    expect(onReorder).not.toHaveBeenCalled();
  });

  it('stops at the ends when walking', () => {
    const { focus, tile } = setup();
    focus('c1');
    fireEvent.keyDown(tile('c1'), { key: 'ArrowLeft' });
    expect(document.activeElement).toBe(tile('c1'));
  });

  it('leaves keys it does not own alone', () => {
    const { tile, onReorder } = setup();
    fireEvent.keyDown(tile('c1'), { key: 'ArrowUp', ctrlKey: true });
    fireEvent.keyDown(tile('c1'), { key: 'a' });
    expect(onReorder).not.toHaveBeenCalled();
  });
});

describe('ClipStrip selection', () => {
  it('reports a click without selecting itself', () => {
    const { tile, onSelect } = setup();
    fireEvent.click(tile('c2'));
    expect(onSelect).toHaveBeenCalledWith('c2');
    // Controlled: nothing is pressed until the prop says so.
    expect(tile('c2').getAttribute('aria-pressed')).toBe('false');
  });

  it('shows the selection the props name', () => {
    const { tile } = setup('c3');
    expect(tile('c3').getAttribute('aria-pressed')).toBe('true');
    expect(tile('c1').getAttribute('aria-pressed')).toBe('false');
  });
});

describe('ClipStrip pointer drag', () => {
  it('binds the gesture to the window and marks the tile it started on', () => {
    const { tile, grab, move, release } = setup();
    grab('c1');
    expect(tile('c1').getAttribute('data-dragging')).toBe('true');

    // Still dragging after the pointer has left the 210px tile: the listener
    // is on the window, not on the tile.
    move(900);
    expect(tile('c1').getAttribute('data-dragging')).toBe('true');

    release(900);
    expect(tile('c1').getAttribute('data-dragging')).toBe('false');
  });

  it('moves nothing when nothing can be measured', () => {
    // jsdom performs no layout, so every tile spans [0, 0] and `dropIndex`
    // returns the index the gesture started on. Guessing would be worse.
    const { grab, move, release, onReorder } = setup();
    grab('c1');
    move(900);
    release(900);
    expect(onReorder).not.toHaveBeenCalled();
  });

  it('abandons the gesture on pointercancel', () => {
    const { tile, grab, onReorder } = setup();
    grab('c1');
    fireEvent(window, new Event('pointercancel'));
    expect(tile('c1').getAttribute('data-dragging')).toBe('false');
    expect(onReorder).not.toHaveBeenCalled();
  });

  it('ignores a secondary button — that is a menu, not a drag', () => {
    const { tile, grab } = setup();
    grab('c1', 100, 2);
    expect(tile('c1').getAttribute('data-dragging')).toBe('false');
  });

  it('unbinds when the gesture ends', () => {
    const { grab, release } = setup();
    const remove = vi.spyOn(window, 'removeEventListener');
    grab('c1');
    release(100);
    expect(remove).toHaveBeenCalledWith('pointermove', expect.any(Function));
    remove.mockRestore();
  });
});
