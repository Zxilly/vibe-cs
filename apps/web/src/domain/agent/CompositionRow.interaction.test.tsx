import { fireEvent } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { renderInteractive } from '../../test/render';
import { CompositionRow } from './CompositionRow';
import { reasonOf } from '../../test/reason';

describe('CompositionRow 换来源', () => {
  it('is a button, not a link — it opens a picker rather than navigating', () => {
    const onChangeSource = vi.fn();
    const { getByRole } = renderInteractive(
      <CompositionRow index={1} label="建立地点 · 3.0s" onChangeSource={onChangeSource} />,
    );
    const button = getByRole('button', { name: '换来源' });

    expect(button.tagName).toBe('BUTTON');
    fireEvent.click(button);
    expect(onChangeSource).toHaveBeenCalledTimes(1);
  });

  it('stays visible and says why when there is no other source to take', () => {
    const onChangeSource = vi.fn();
    const { getByRole } = renderInteractive(
      <CompositionRow
        index={1}
        label="建立地点 · 3.0s"
        onChangeSource={onChangeSource}
        changeSourceDisabledReason="只有一条 take，没有别的来源可换"
      />,
    );
    const button = getByRole('button', { name: '换来源' }) as HTMLButtonElement;

    expect(button.disabled).toBe(true);
    expect(reasonOf(button)).toContain('只有一条 take，没有别的来源可换');
    fireEvent.click(button);
    expect(onChangeSource).not.toHaveBeenCalled();
  });
});
