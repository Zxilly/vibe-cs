/*
 * Interaction tests — the transport's keyboard contract and its buttons.
 *
 * Everything is addressed the way a user would address it: a control by its
 * accessible name, the group by its role. A failure here means an action
 * became unreachable, not that a class name moved.
 */

import { fireEvent, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { renderInteractive } from '../../test/render';
import { Transport, type TransportProps } from './Transport';

const FPS = 60;
const DURATION = 42;
/** Seconds one frame lasts at the project rate. */
const FRAME = 1 / FPS;

function setup(overrides: Partial<TransportProps> = {}) {
  const onTogglePlay = vi.fn();
  const onSeek = vi.fn();
  const onRateChange = vi.fn();

  const view = renderInteractive(
    <Transport
      currentTime={10}
      durationSeconds={DURATION}
      playing={false}
      fps={FPS}
      onTogglePlay={onTogglePlay}
      onSeek={onSeek}
      onRateChange={onRateChange}
      {...overrides}
    />,
  );

  // Scoped to this render's container: a test that mounts two transports
  // would otherwise get "found multiple elements" from the document-wide
  // queries Testing Library hands back.
  const scope = within(view.container);

  return {
    ...view,
    onTogglePlay,
    onSeek,
    onRateChange,
    scope,
    group: () => scope.getByRole('group', { name: '播放控制' }),
    button: (name: string) => scope.getByRole('button', { name }),
    radio: (name: string) => scope.getByRole('radio', { name }),
  };
}

describe('Transport keyboard', () => {
  it('toggles playback on Space', () => {
    const { group, onTogglePlay } = setup();
    fireEvent.keyDown(group(), { key: ' ' });
    expect(onTogglePlay).toHaveBeenCalledTimes(1);
  });

  it('does not double-fire when Space lands on a button', () => {
    // A focused <button> already turns Space into a click. Handling it on the
    // group as well would toggle twice and land back where it started.
    const { button, onTogglePlay } = setup();
    const play = button('播放');

    fireEvent.keyDown(play, { key: ' ' });
    expect(onTogglePlay).not.toHaveBeenCalled();

    fireEvent.click(play);
    expect(onTogglePlay).toHaveBeenCalledTimes(1);
  });

  it('steps one frame with the arrow keys', () => {
    const { group, onSeek } = setup();
    fireEvent.keyDown(group(), { key: 'ArrowRight' });
    expect(onSeek).toHaveBeenLastCalledWith(expect.closeTo(10 + FRAME, 9));

    fireEvent.keyDown(group(), { key: 'ArrowLeft' });
    expect(onSeek).toHaveBeenLastCalledWith(expect.closeTo(10 - FRAME, 9));
  });

  it('steps ten frames with Shift held', () => {
    const { group, onSeek } = setup();
    fireEvent.keyDown(group(), { key: 'ArrowRight', shiftKey: true });
    expect(onSeek).toHaveBeenLastCalledWith(expect.closeTo(10 + 10 * FRAME, 9));
  });

  it('jumps to the ends with Home and End', () => {
    const { group, onSeek } = setup();
    fireEvent.keyDown(group(), { key: 'Home' });
    expect(onSeek).toHaveBeenLastCalledWith(0);

    fireEvent.keyDown(group(), { key: 'End' });
    expect(onSeek).toHaveBeenLastCalledWith(DURATION);
  });

  it('never seeks outside the media', () => {
    const { group, onSeek } = setup({ currentTime: 0 });
    fireEvent.keyDown(group(), { key: 'ArrowLeft' });
    expect(onSeek).toHaveBeenLastCalledWith(0);

    const end = setup({ currentTime: DURATION });
    fireEvent.keyDown(end.group(), { key: 'ArrowRight' });
    expect(end.onSeek).toHaveBeenLastCalledWith(DURATION);
  });

  it('leaves the arrow keys to the rate group when focus is inside it', () => {
    const view = setup({ rate: 1 });
    const radio = view.radio('2×');
    fireEvent.keyDown(radio, { key: 'ArrowRight' });
    expect(view.onSeek).not.toHaveBeenCalled();
  });

  it('ignores every shortcut while it is disabled', () => {
    const { group, onSeek, onTogglePlay } = setup({ disabled: true });
    for (const key of [' ', 'ArrowLeft', 'ArrowRight', 'Home', 'End']) {
      fireEvent.keyDown(group(), { key });
    }
    expect(onSeek).not.toHaveBeenCalled();
    expect(onTogglePlay).not.toHaveBeenCalled();
  });

  it('lets an unhandled key through untouched', () => {
    const { group, onSeek, onTogglePlay } = setup();
    fireEvent.keyDown(group(), { key: 'k' });
    expect(onSeek).not.toHaveBeenCalled();
    expect(onTogglePlay).not.toHaveBeenCalled();
  });
});

describe('Transport buttons', () => {
  it('steps a frame at a time', () => {
    const { button, onSeek } = setup();
    fireEvent.click(button('下一帧'));
    expect(onSeek).toHaveBeenLastCalledWith(expect.closeTo(10 + FRAME, 9));

    fireEvent.click(button('上一帧'));
    expect(onSeek).toHaveBeenLastCalledWith(expect.closeTo(10 - FRAME, 9));
  });

  it('jumps to the in and out points when they are set', () => {
    const { button, onSeek } = setup({ inPoint: 4, outPoint: 30 });
    fireEvent.click(button('跳到入点'));
    expect(onSeek).toHaveBeenLastCalledWith(4);

    fireEvent.click(button('跳到出点'));
    expect(onSeek).toHaveBeenLastCalledWith(30);
  });

  it('falls back to the ends of the media when they are not', () => {
    const { button, onSeek } = setup();
    fireEvent.click(button('跳到入点'));
    expect(onSeek).toHaveBeenLastCalledWith(0);

    fireEvent.click(button('跳到出点'));
    expect(onSeek).toHaveBeenLastCalledWith(DURATION);
  });

  it('reports a rate change without applying one itself', () => {
    const view = setup({ rate: 1 });
    fireEvent.click(view.radio('2×'));
    expect(view.onRateChange).toHaveBeenCalledWith(2);
    // Still controlled: the checked option is the one the prop names.
    expect(view.radio('1×').getAttribute('aria-checked')).toBe('true');
  });

  it('is disabled with a stated reason when there is nothing to play', () => {
    const view = setup({ durationSeconds: 0 });
    expect((view.button('播放') as HTMLButtonElement).disabled).toBe(true);
    // One description per control — 「不隐藏、不静默失败」.
    expect(view.scope.getAllByText(/还没有可播放的素材/u).length).toBe(5);

    fireEvent.click(view.button('播放'));
    expect(view.onTogglePlay).not.toHaveBeenCalled();
  });

  it('does not advance time by itself', () => {
    // The component is controlled: with no props changing, nothing moves.
    const view = setup({ playing: true });
    const readout = view.container.querySelector('[data-current-time]');
    expect(readout?.getAttribute('data-current-time')).toBe('10');
    expect(view.onSeek).not.toHaveBeenCalled();
  });
});
