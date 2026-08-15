import { fireEvent } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { renderInteractive } from '../../test/render';
import { AgentSessionRow } from './AgentSessionRow';
import { OBJECT_REF_PLAN, SESSION_SUMMARY } from './agentFixtures.testing';

const UTC = { timeZone: 'UTC' } as const;
const NOW = new Date('2026-08-15T10:00:00.000Z');

describe('AgentSessionRow 打开这条会话', () => {
  it('reports the whole session summary', () => {
    const onOpen = vi.fn();
    const { container } = renderInteractive(
      <AgentSessionRow session={SESSION_SUMMARY} onOpen={onOpen} now={NOW} {...UTC} />,
    );

    const button = container.querySelector('[data-session-open]');
    expect(button).not.toBeNull();
    if (button !== null) fireEvent.click(button);

    expect(onOpen).toHaveBeenCalledWith(SESSION_SUMMARY);
  });

  it('is a real button, so the drawer is navigable from the keyboard', () => {
    const { container } = renderInteractive(
      <AgentSessionRow session={SESSION_SUMMARY} onOpen={vi.fn()} selected now={NOW} {...UTC} />,
    );
    const button = container.querySelector('[data-session-open]');

    expect(button?.tagName).toBe('BUTTON');
    expect(button?.getAttribute('aria-pressed')).toBe('true');
  });

  it('opens an object without also opening the session', () => {
    const onOpen = vi.fn();
    const onSelectRef = vi.fn();
    const { getByRole } = renderInteractive(
      <AgentSessionRow
        session={SESSION_SUMMARY}
        onOpen={onOpen}
        onSelectRef={onSelectRef}
        now={NOW}
        {...UTC}
      />,
    );

    fireEvent.click(getByRole('button', { name: /方案 #P-118/u }));
    expect(onSelectRef).toHaveBeenCalledWith(OBJECT_REF_PLAN);
    expect(onOpen).not.toHaveBeenCalled();
  });

  it('has nothing to press when the list only reads', () => {
    const { queryAllByRole } = renderInteractive(
      <AgentSessionRow session={SESSION_SUMMARY} now={NOW} {...UTC} />,
    );

    expect(queryAllByRole('button')).toHaveLength(0);
  });
});
