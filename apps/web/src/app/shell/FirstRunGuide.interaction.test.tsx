import { fireEvent } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { renderInteractive } from '../../test/render';
import { FirstRunGuide } from './FirstRunGuide';

describe('FirstRunGuide', () => {
  it('explains the shared data model and starts from editing mode', () => {
    const { getByText } = renderInteractive(
      <FirstRunGuide open initialMode="edit" onChoose={() => undefined} onDismiss={() => undefined} />,
    );

    expect(getByText(/同一份 Demo/u)).toBeTruthy();
    expect(document.querySelector('[data-first-run-mode="edit"]')?.getAttribute('aria-pressed')).toBe('true');
    expect(document.querySelector('[data-first-run-mode="analysis"]')?.getAttribute('aria-pressed')).toBe('false');
  });

  it('selects analysis before confirming the initial destination', () => {
    const onChoose = vi.fn();
    const { getByRole } = renderInteractive(
      <FirstRunGuide open initialMode="edit" onChoose={onChoose} onDismiss={() => undefined} />,
    );

    fireEvent.click(getByRole('button', { name: /分析模式/u }));
    fireEvent.click(getByRole('button', { name: '进入分析模式' }));
    expect(onChoose).toHaveBeenCalledWith('analysis');
  });

  it('can be dismissed and will not force a mode choice', () => {
    const onDismiss = vi.fn();
    const { getByRole } = renderInteractive(
      <FirstRunGuide open initialMode="edit" onChoose={() => undefined} onDismiss={onDismiss} />,
    );

    fireEvent.click(getByRole('button', { name: '先用当前模式' }));
    expect(onDismiss).toHaveBeenCalledOnce();
  });
});
