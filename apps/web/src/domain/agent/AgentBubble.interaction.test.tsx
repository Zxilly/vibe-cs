import { fireEvent } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { renderInteractive } from '../../test/render';
import { AgentBubble, type AgentAssistantEntry } from './AgentBubble';
import { ASSISTANT_ENTRY } from './agentFixtures.testing';

const ASSISTANT = ASSISTANT_ENTRY as AgentAssistantEntry;

describe('AgentBubble inline actions', () => {
  it('calls back the action the sentence offered', () => {
    const onAction = vi.fn();
    const { getByRole } = renderInteractive(
      <AgentBubble entry={ASSISTANT} actions={[{ id: 'yes', label: '加上', onAction, primary: true }]} />,
    );

    fireEvent.click(getByRole('button', { name: '加上' }));
    expect(onAction).toHaveBeenCalledTimes(1);
  });

  it('stays visible and says why when the action cannot be taken', () => {
    const onAction = vi.fn();
    const { getByRole } = renderInteractive(
      <AgentBubble
        entry={ASSISTANT}
        actions={[
          {
            id: 'yes',
            label: '加上',
            onAction,
            disabled: true,
            disabledReason: '编辑会记入会话，请先选择或新建一条会话',
          },
        ]}
      />,
    );
    const button = getByRole('button', { name: '加上' }) as HTMLButtonElement;

    expect(button.disabled).toBe(true);
    expect(button.getAttribute('title')).toBe('编辑会记入会话，请先选择或新建一条会话');

    fireEvent.click(button);
    expect(onAction).not.toHaveBeenCalled();
  });

  it('draws no action row when the Agent offered none', () => {
    const { queryAllByRole } = renderInteractive(<AgentBubble entry={ASSISTANT} />);

    expect(queryAllByRole('button')).toHaveLength(0);
  });
});
