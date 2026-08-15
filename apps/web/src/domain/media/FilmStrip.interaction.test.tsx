/*
 * Interaction tests — scrubbing from the film strip.
 *
 * The strip is a control only when it is given somewhere to seek to; without
 * `onSeek` it is a static preview and there is nothing to focus. Both shapes
 * are asserted, because a strip that quietly became a button row would put
 * three dozen tab stops in front of the timeline.
 */

import { act, fireEvent } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { renderInteractive } from '../../test/render';
import { FilmStrip } from './FilmStrip';
import type { FilmFrame } from './types';

const frames: FilmFrame[] = [
  { time: 0, src: 'asset://f0.jpg' },
  { time: 10, src: 'asset://f1.jpg' },
  { time: 20, src: 'asset://f2.jpg' },
  { time: 30, src: 'asset://f3.jpg' },
];

function setup(currentTime?: number) {
  const onSeek = vi.fn<(seconds: number) => void>();
  const view = renderInteractive(
    currentTime === undefined ? (
      <FilmStrip frames={frames} onSeek={onSeek} />
    ) : (
      <FilmStrip frames={frames} currentTime={currentTime} onSeek={onSeek} />
    ),
  );

  const cell = (time: number) => {
    const element = view.container.querySelector<HTMLButtonElement>(`[data-time="${time}"]`);
    if (element === null) throw new Error(`no cell at ${time}`);
    return element;
  };

  return { ...view, onSeek, cell };
}

describe('FilmStrip scrubbing', () => {
  it('reports the time of the cell that was clicked', () => {
    const { cell, onSeek } = setup();
    fireEvent.click(cell(20));
    expect(onSeek).toHaveBeenCalledWith(20);
  });

  it('walks the strip with the arrow keys', () => {
    const { cell } = setup();
    act(() => {
      cell(0).focus();
    });
    fireEvent.keyDown(cell(0), { key: 'ArrowRight' });
    expect(document.activeElement).toBe(cell(10));

    fireEvent.keyDown(cell(10), { key: 'ArrowLeft' });
    expect(document.activeElement).toBe(cell(0));
  });

  it('stops at both ends rather than wrapping', () => {
    const { cell } = setup();
    act(() => {
      cell(0).focus();
    });
    fireEvent.keyDown(cell(0), { key: 'ArrowLeft' });
    expect(document.activeElement).toBe(cell(0));

    act(() => {
      cell(30).focus();
    });
    fireEvent.keyDown(cell(30), { key: 'ArrowRight' });
    expect(document.activeElement).toBe(cell(30));
  });

  it('does not seek merely because focus moved', () => {
    const { cell, onSeek } = setup();
    act(() => {
      cell(0).focus();
    });
    fireEvent.keyDown(cell(0), { key: 'ArrowRight' });
    expect(onSeek).not.toHaveBeenCalled();
  });

  it('marks the current cell for assistive technology too', () => {
    const { cell } = setup(25);
    expect(cell(20).getAttribute('aria-current')).toBe('true');
    expect(cell(10).getAttribute('aria-current')).toBeNull();
  });

  it('is not focusable at all without somewhere to seek to', () => {
    const view = renderInteractive(<FilmStrip frames={frames} />);
    expect(view.queryAllByRole('button')).toHaveLength(0);
  });
});
