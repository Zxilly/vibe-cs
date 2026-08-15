import { fireEvent } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { renderInteractive } from '../../test/render';
import { Seg } from './Seg';

const SPEED_OPTIONS = [
  { value: '0.5', label: '0.5×' },
  { value: '1', label: '1×' },
  { value: '2', label: '2×' },
] as const;

describe('Seg interaction', () => {
  it('exposes a named radio group with one checked radio', () => {
    const { getByRole, getAllByRole } = renderInteractive(
      <Seg name="speed" value="1" options={SPEED_OPTIONS} aria-label="播放速度" />,
    );

    expect(getByRole('radiogroup', { name: '播放速度' })).toBeDefined();

    const radios = getAllByRole('radio');
    expect(radios).toHaveLength(3);
    expect(radios.filter((radio) => (radio as HTMLInputElement).checked)).toHaveLength(1);
  });

  it('reports the picked value once, typed', () => {
    const onChange = vi.fn();
    const { getByRole } = renderInteractive(
      <Seg name="speed" value="1" options={SPEED_OPTIONS} onChange={onChange} aria-label="播放速度" />,
    );

    fireEvent.click(getByRole('radio', { name: '2×' }));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith('2');
  });

  it('does not re-announce the value that is already selected', () => {
    const onChange = vi.fn();
    const { getByRole } = renderInteractive(
      <Seg name="speed" value="1" options={SPEED_OPTIONS} onChange={onChange} aria-label="播放速度" />,
    );

    // A radio that is already checked fires no change event; the primitive
    // must not fake one from a click handler.
    fireEvent.click(getByRole('radio', { name: '1×' }));
    expect(onChange).not.toHaveBeenCalled();
  });

  it('is keyboard reachable: the checked radio is the group tab stop', () => {
    const { getByRole } = renderInteractive(
      <Seg name="speed" value="2" options={SPEED_OPTIONS} aria-label="播放速度" />,
    );

    const selected = getByRole('radio', { name: '2×' }) as HTMLInputElement;
    selected.focus();
    expect(document.activeElement).toBe(selected);
    expect(selected.checked).toBe(true);
  });

  it('leaves a disabled option unreachable while the group still works', () => {
    const onChange = vi.fn();
    const { getByRole } = renderInteractive(
      <Seg
        name="quality"
        value="fast"
        aria-label="画质策略"
        onChange={onChange}
        options={[
          { value: 'fast', label: '快速' },
          { value: 'balanced', label: '均衡' },
          { value: 'best', label: '最佳', disabled: true },
        ]}
      />,
    );

    const locked = getByRole('radio', { name: '最佳' }) as HTMLInputElement;

    // Asserted on the platform state rather than on the handler: a synthetic
    // `fireEvent.click` skips the disabled gate a real click obeys, so a
    // handler assertion here would be testing jsdom.
    expect(locked.disabled).toBe(true);
    expect(locked.checked).toBe(false);
    locked.focus();
    expect(document.activeElement).not.toBe(locked);

    // The rest of the group still works.
    fireEvent.click(getByRole('radio', { name: '均衡' }));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith('balanced');
  });
});
