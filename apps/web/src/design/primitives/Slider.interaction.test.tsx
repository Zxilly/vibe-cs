import { fireEvent } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderInteractive } from '../../test/render';
import { Slider } from './Slider';

function Controlled() {
  const [value, setValue] = useState(5);
  return <Slider value={value} min={1} max={12} step={1} onChange={setValue} aria-label="take 上限" />;
}

describe('Slider interaction', () => {
  it('exposes the slider role and its bounds', () => {
    const { getByRole } = renderInteractive(<Slider value={5} min={1} max={12} aria-label="take 上限" />);
    const slider = getByRole('slider', { name: 'take 上限' });

    expect(slider.getAttribute('aria-valuemin')).toBe('1');
    expect(slider.getAttribute('aria-valuemax')).toBe('12');
    expect(slider.getAttribute('aria-valuenow')).toBe('5');
  });

  it('steps with the arrow keys and reports a number, not a string', () => {
    const onChange = vi.fn();
    const { getByRole } = renderInteractive(
      <Slider value={5} min={1} max={12} step={1} onChange={onChange} aria-label="take 上限" />,
    );

    fireEvent.keyDown(getByRole('slider'), { key: 'ArrowRight' });
    expect(onChange).toHaveBeenCalledWith(6);
  });

  it('honours Home and End', () => {
    const onChange = vi.fn();
    const { getByRole } = renderInteractive(
      <Slider value={5} min={1} max={12} step={1} onChange={onChange} aria-label="take 上限" />,
    );

    fireEvent.keyDown(getByRole('slider'), { key: 'Home' });
    expect(onChange).toHaveBeenLastCalledWith(1);

    fireEvent.keyDown(getByRole('slider'), { key: 'End' });
    expect(onChange).toHaveBeenLastCalledWith(12);
  });

  it('moves the thumb with the value', () => {
    const { getByRole } = renderInteractive(<Controlled />);
    const slider = getByRole('slider');

    expect(slider.getAttribute('aria-valuenow')).toBe('5');
    fireEvent.keyDown(slider, { key: 'End' });
    expect(slider.getAttribute('aria-valuenow')).toBe('12');
  });

  /* The whole reason this is Radix and not a native range: the settings rows
     write a config document on commit, and used to guess at the end of the
     gesture from `onPointerUp` plus `onBlur`.

     A key press is a whole gesture on its own, so it commits at once — the
     drag is the case where the two events separate, and jsdom has no layout
     to drag a thumb through. */
  it('commits a keyboard step immediately, and reports it as a change too', () => {
    const onChange = vi.fn();
    const onCommit = vi.fn();
    const { getByRole } = renderInteractive(
      <Slider value={5} min={1} max={12} step={1} onChange={onChange} onCommit={onCommit} aria-label="take 上限" />,
    );

    fireEvent.keyDown(getByRole('slider'), { key: 'ArrowRight' });
    expect(onChange).toHaveBeenCalledWith(6);
    expect(onCommit).toHaveBeenCalledWith(6);
  });

  it('does not commit a value the arrow key could not move', () => {
    const onCommit = vi.fn();
    const { getByRole } = renderInteractive(
      <Slider value={12} min={1} max={12} step={1} onCommit={onCommit} aria-label="take 上限" />,
    );

    fireEvent.keyDown(getByRole('slider'), { key: 'ArrowRight' });
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('is keyboard reachable', () => {
    const { getByRole } = renderInteractive(<Controlled />);
    const slider = getByRole('slider');

    slider.focus();
    expect(document.activeElement).toBe(slider);
  });

  it('does not move while disabled', () => {
    const onChange = vi.fn();
    const { getByRole } = renderInteractive(
      <Slider value={5} min={1} max={12} disabled onChange={onChange} aria-label="take 上限" />,
    );

    fireEvent.keyDown(getByRole('slider'), { key: 'ArrowRight' });
    expect(onChange).not.toHaveBeenCalled();
  });
});
