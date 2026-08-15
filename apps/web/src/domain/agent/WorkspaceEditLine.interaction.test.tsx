import { fireEvent } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { renderInteractive } from '../../test/render';
import { WorkspaceEditLine } from './WorkspaceEditLine';
import { EDIT_NOTICE } from './agentFixtures.testing';

const UTC = { timeZone: 'UTC' } as const;

describe('WorkspaceEditLine disclosure', () => {
  it('reveals the original and folds it away again', () => {
    const { container, getByRole } = renderInteractive(<WorkspaceEditLine notice={EDIT_NOTICE} {...UTC} />);

    expect(container.querySelector('[data-workspace-edit-original]')).toBeNull();

    fireEvent.click(getByRole('button', { name: /查看发给 Agent 的内容/u }));
    const panel = container.querySelector('[data-workspace-edit-original]');
    expect(panel).not.toBeNull();
    expect(panel?.textContent).toContain('"type": "workspace_edit"');

    fireEvent.click(getByRole('button', { name: /收起/u }));
    expect(container.querySelector('[data-workspace-edit-original]')).toBeNull();
  });

  it('wires the toggle to the panel it controls', () => {
    const { container, getByRole } = renderInteractive(<WorkspaceEditLine notice={EDIT_NOTICE} {...UTC} />);
    const toggle = getByRole('button', { name: /查看发给 Agent 的内容/u });

    expect(toggle.getAttribute('aria-expanded')).toBe('false');

    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(container.querySelector('[data-workspace-edit-original]')?.id).toBe(
      toggle.getAttribute('aria-controls'),
    );
  });

  it('is a button, so the original is reachable without a pointer', () => {
    const { getByRole } = renderInteractive(<WorkspaceEditLine notice={EDIT_NOTICE} {...UTC} />);
    const toggle = getByRole('button', { name: /查看发给 Agent 的内容/u });

    toggle.focus();
    expect(document.activeElement).toBe(toggle);
    expect(toggle.tagName).toBe('BUTTON');
  });

  it('opens on first paint when the caller asks for it', () => {
    const { container } = renderInteractive(<WorkspaceEditLine notice={EDIT_NOTICE} defaultExpanded {...UTC} />);

    expect(container.querySelector('[data-workspace-edit-original]')).not.toBeNull();
  });
});
