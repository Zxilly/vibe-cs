import { fireEvent } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderInteractive } from '../../test/render';
import { AgentRail } from './AgentRail';
import { resetShellStore, useShellStore } from './shellStore';

beforeEach(() => {
  resetShellStore();
});

const state = (container: HTMLElement) =>
  container.querySelector('[data-agent-rail]')?.getAttribute('data-agent-rail');

describe('expanding and collapsing', () => {
  it('opens from the strip and remembers that it is open', () => {
    const { container, getByRole } = renderInteractive(<AgentRail pendingCount={1} />);

    expect(state(container)).toBe('collapsed');
    fireEvent.click(getByRole('button', { name: /AI 工作台/u }));

    expect(state(container)).toBe('expanded');
    expect(useShellStore.getState().agentRailExpanded).toBe(true);
  });

  it('closes again from the header action', () => {
    const { container, getByRole } = renderInteractive(<AgentRail />);

    fireEvent.click(getByRole('button', { name: /AI 工作台/u }));
    fireEvent.click(getByRole('button', { name: '收起 AI 工作台' }));

    expect(state(container)).toBe('collapsed');
    expect(useShellStore.getState().agentRailExpanded).toBe(false);
  });

  it('lets a caller own the state instead of the store', () => {
    const onExpandedChange = vi.fn();
    const { getByRole } = renderInteractive(
      <AgentRail expanded={false} onExpandedChange={onExpandedChange} />,
    );

    fireEvent.click(getByRole('button', { name: /AI 工作台/u }));
    expect(onExpandedChange).toHaveBeenCalledWith(true);
    expect(useShellStore.getState().agentRailExpanded).toBe(false);
  });
});

describe('keyboard', () => {
  it('closes on Escape', () => {
    const { container, getByRole } = renderInteractive(<AgentRail />);

    fireEvent.click(getByRole('button', { name: /AI 工作台/u }));
    expect(state(container)).toBe('expanded');

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(state(container)).toBe('collapsed');
  });

  it('ignores Escape while collapsed, so it never steals the key', () => {
    const onExpandedChange = vi.fn();
    renderInteractive(<AgentRail expanded={false} onExpandedChange={onExpandedChange} />);

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onExpandedChange).not.toHaveBeenCalled();
  });

  it('moves focus into the panel on open and back to the strip on close', () => {
    const { container, getByRole } = renderInteractive(<AgentRail />);

    fireEvent.click(getByRole('button', { name: /AI 工作台/u }));
    expect(document.activeElement).toBe(container.querySelector('[data-agent-rail-toggle="collapse"]'));

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(document.activeElement).toBe(container.querySelector('[data-agent-rail-toggle="expand"]'));
  });

  it('does not steal focus on first render', () => {
    const outside = document.createElement('button');
    document.body.append(outside);
    outside.focus();

    renderInteractive(<AgentRail expanded />);
    expect(document.activeElement).toBe(outside);
    outside.remove();
  });

  it('does not trap Tab — it is a column of the page, not an overlay', () => {
    const { getByRole } = renderInteractive(<AgentRail expanded />);
    const closeButton = getByRole('button', { name: '收起 AI 工作台' });

    const forward = fireEvent.keyDown(closeButton, { key: 'Tab' });
    const backward = fireEvent.keyDown(closeButton, { key: 'Tab', shiftKey: true });

    // `fireEvent` returns false only when a handler called preventDefault.
    expect(forward).toBe(true);
    expect(backward).toBe(true);
  });
});

describe('unmounting', () => {
  it('takes its Escape listener with it', () => {
    const onExpandedChange = vi.fn();
    const { unmount } = renderInteractive(
      <AgentRail expanded onExpandedChange={onExpandedChange} />,
    );

    unmount();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onExpandedChange).not.toHaveBeenCalled();
  });
});
