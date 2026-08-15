import { fireEvent } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { renderInteractive } from '../../test/render';
import { AgentReferenceRow } from './AgentReferenceRow';
import { REFERENCE_TASK } from './agentFixtures.testing';

describe('AgentReferenceRow 引用', () => {
  it('reports the whole reference, so the caller need not look it up again', () => {
    const onReference = vi.fn();
    const { getByRole } = renderInteractive(
      <AgentReferenceRow reference={REFERENCE_TASK} onReference={onReference} />,
    );

    fireEvent.click(getByRole('button', { name: '引用' }));
    expect(onReference).toHaveBeenCalledWith(REFERENCE_TASK);
  });

  it('stays visible and says why when it cannot be referenced — 不隐藏、不静默失败', () => {
    const onReference = vi.fn();
    const { getByRole } = renderInteractive(
      <AgentReferenceRow
        reference={REFERENCE_TASK}
        onReference={onReference}
        referenceDisabledReason="本地服务未连接 · 需要服务"
      />,
    );
    const button = getByRole('button', { name: '引用' }) as HTMLButtonElement;

    expect(button.disabled).toBe(true);
    expect(button.getAttribute('title')).toBe('本地服务未连接 · 需要服务');

    fireEvent.click(button);
    expect(onReference).not.toHaveBeenCalled();
  });

  it('offers nothing to press once the reference is held', () => {
    const { queryAllByRole } = renderInteractive(
      <AgentReferenceRow reference={REFERENCE_TASK} referenced onReference={vi.fn()} />,
    );

    expect(queryAllByRole('button')).toHaveLength(0);
  });
});
