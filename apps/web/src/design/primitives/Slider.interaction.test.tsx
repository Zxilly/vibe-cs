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
  it('exposes the native slider role and its bounds', () => {
    const { getByRole } = renderInteractive(<Slider value={5} min={1} max={12} aria-label="take 上限" />);
    const slider = getByRole('slider', { name: 'take 上限' }) as HTMLInputElement;

    expect(slider.min).toBe('1');
    expect(slider.max).toBe('12');
    expect(slider.value).toBe('5');
  });

  it('reports a number, not a string', () => {
    const onChange = vi.fn();
    const { getByRole } = renderInteractive(
      <Slider value={5} min={1} max={12} onChange={onChange} aria-label="take 上限" />,
    );

    fireEvent.change(getByRole('slider'), { target: { value: '8' } });
    expect(onChange).toHaveBeenCalledWith(8);
  });

  it('moves the drawn fill and thumb with the value', () => {
    const { getByRole, container } = renderInteractive(<Controlled />);
    const slider = getByRole('slider') as HTMLInputElement;

    const thumb = container.querySelector<HTMLElement>('.size-\\[14px\\]');
    expect(thumb).not.toBeNull();

    // 5 of 1..12 is 4/11 ≈ 36.36%.
    expect(Number.parseFloat(thumb?.style.left ?? '')).toBeCloseTo(36.36, 1);

    fireEvent.change(slider, { target: { value: '12' } });
    expect(Number.parseFloat(thumb?.style.left ?? '')).toBe(100);
    expect(thumb?.style.transform).toContain('-100%');
  });

  it('is keyboard reachable', () => {
    const { getByRole } = renderInteractive(<Controlled />);
    const slider = getByRole('slider') as HTMLInputElement;

    slider.focus();
    expect(document.activeElement).toBe(slider);
  });

  it('does not move while disabled', () => {
    const onChange = vi.fn();
    const { getByRole } = renderInteractive(
      <Slider value={5} min={1} max={12} disabled onChange={onChange} aria-label="take 上限" />,
    );
    const slider = getByRole('slider') as HTMLInputElement;

    expect(slider.disabled).toBe(true);
    slider.focus();
    expect(document.activeElement).not.toBe(slider);
  });
});
