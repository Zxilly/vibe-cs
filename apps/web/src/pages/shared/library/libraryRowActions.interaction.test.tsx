import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';

import { DataTable } from '../../../design/data';
import { renderInteractive } from '../../../test/render';
import { libraryColumns, type ActionAvailability } from './libraryColumns';
import { makeDemo } from './test/renderLibrary';

function renderRows(createButtonProps: ActionAvailability = { disabled: false }) {
  const rows = [makeDemo(0), makeDemo(1)];
  const onRowActivate = vi.fn();
  const onCreateProject = vi.fn();
  renderInteractive(
    <MemoryRouter>
      <DataTable
        caption="比赛"
        rows={rows}
        rowId={(demo) => demo.id}
        activeRowId={rows[0]!.id}
        onRowActivate={onRowActivate}
        columns={libraryColumns({
          onAnalyse: vi.fn(),
          onCreateProject,
          analyseButtonProps: { disabled: false },
          createButtonProps,
          workspaceHref: (demo) => `/match/${demo.id}?project=target-project`,
        })}
      />
    </MemoryRouter>,
  );
  return { rows, onRowActivate, onCreateProject };
}

describe('compact library row actions', () => {
  it('opens and activates the focused row menu from the keyboard without activating the row', async () => {
    const { rows, onRowActivate, onCreateProject } = renderRows();
    const trigger = screen.getByRole('button', { name: `更多操作：${rows[1]!.display_name}` });
    trigger.focus();
    fireEvent.keyDown(trigger, { key: 'Enter' });
    const menu = await screen.findByRole('menu');
    const action = within(menu).getByRole('menuitem', { name: '用 Agent 制作' });
    await waitFor(() => expect(document.activeElement).toBe(action));
    fireEvent.keyDown(action, { key: 'Enter' });

    expect(onCreateProject).toHaveBeenCalledExactlyOnceWith(rows[1]);
    expect(onRowActivate).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(trigger));
    expect(screen.getAllByRole('link', { name: '打开' })[1]?.getAttribute('href'))
      .toBe(`/match/${rows[1]!.id}?project=target-project`);
  });

  it('keeps the unavailable action and its reason visible without submitting it', async () => {
    const { rows, onRowActivate, onCreateProject } = renderRows({ disabled: true, disabledReason: '正在创建作品' });
    fireEvent.pointerDown(screen.getByRole('button', { name: `更多操作：${rows[1]!.display_name}` }), { button: 0, ctrlKey: false });
    const action = await screen.findByRole('menuitem', { name: '用 Agent 制作（正在创建作品）' });
    expect(action.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(action);
    expect(onCreateProject).not.toHaveBeenCalled();
    expect(onRowActivate).not.toHaveBeenCalled();
  });
});
