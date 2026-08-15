import { fireEvent } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderInteractive } from '../../test/render';
import { Toggle } from './Toggle';

function Controlled() {
  const [on, setOn] = useState(false);
  return <Toggle checked={on} onChange={setOn} aria-label="预填上下文" />;
}

describe('Toggle interaction', () => {
  it('flips on activation and reports the next state', () => {
    const onChange = vi.fn();
    const { getByRole } = renderInteractive(
      <Toggle checked={false} onChange={onChange} aria-label="预填上下文" />,
    );

    fireEvent.click(getByRole('switch', { name: '预填上下文' }));
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it('updates aria-checked when the owner re-renders it', () => {
    const { getByRole } = renderInteractive(<Controlled />);
    const toggle = getByRole('switch', { name: '预填上下文' });

    expect(toggle.getAttribute('aria-checked')).toBe('false');
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-checked')).toBe('true');
  });

  it('is keyboard reachable', () => {
    const { getByRole } = renderInteractive(<Controlled />);
    const toggle = getByRole('switch', { name: '预填上下文' });

    toggle.focus();
    expect(document.activeElement).toBe(toggle);

    // A native <button role="switch"> turns Space and Enter into a click, so
    // there is no keydown handler to get wrong.
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-checked')).toBe('true');
  });

  it('refuses to change while locked, and stays reachable so the reason can be read', () => {
    const onChange = vi.fn();
    const { getByRole } = renderInteractive(
      <Toggle checked locked onChange={onChange} aria-label="录制前需人工确认" />,
    );
    const toggle = getByRole('switch', { name: '录制前需人工确认' });

    fireEvent.click(toggle);
    expect(onChange).not.toHaveBeenCalled();
    expect(toggle.getAttribute('aria-checked')).toBe('true');

    toggle.focus();
    expect(document.activeElement).toBe(toggle);
  });

  it('refuses to change while disabled', () => {
    const onChange = vi.fn();
    const { getByRole } = renderInteractive(
      <Toggle checked={false} disabled onChange={onChange} aria-label="预填上下文" />,
    );

    fireEvent.click(getByRole('switch', { name: '预填上下文' }));
    expect(onChange).not.toHaveBeenCalled();
  });
});
