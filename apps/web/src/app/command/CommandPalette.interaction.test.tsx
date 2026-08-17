/*
 * Interaction project (jsdom): every keyboard contract the palette advertises.
 *
 * The palette prints its own contract on screen — 「ESC 关闭」 in the header and
 * 「↑↓ 选择 · ↵ 打开 · TAB 切换分组」 in the footer — so each of those lines has a
 * case below, plus the Ctrl K binding that summons it and the focus restoration
 * the 浮层与状态规范 artboard requires of every overlay.
 *
 * The harness is a trigger button next to the palette, the shape `AppShell`
 * will have: focus restoration cannot be observed without somewhere for focus
 * to go back to.
 */

import { act, fireEvent, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { renderInteractive } from '../../test/render';
import { CommandPalette } from './CommandPalette';
import type { CommandDefinition } from './commandRegistry';
import { useCommandPalette } from './useCommandPalette';

function Harness({
  navigate = () => {},
  commands,
}: {
  navigate?: (to: string) => void;
  commands?: readonly CommandDefinition[] | undefined;
}) {
  const { open, openPalette, closePalette } = useCommandPalette();
  return (
    <>
      <button type="button" onClick={openPalette}>
        打开命令面板
      </button>
      <CommandPalette open={open} onClose={closePalette} navigate={navigate} commands={commands} />
    </>
  );
}

const TWO_GROUPS: readonly CommandDefinition[] = [
  {
    id: 'match.aurora',
    group: 'match',
    title: { id: 'aurora', message: 'Aurora vs Meridian · Mirage' },
    hint: { id: 'open-workspace', message: '打开工作区' },
    keywords: ['mirage'],
    run: () => {},
  },
  {
    id: 'page.home',
    group: 'page',
    title: { id: 'home', message: '工作台' },
    keywords: ['mirage'],
    run: () => {},
  },
];

const searchBox = (getByRole: ReturnType<typeof renderInteractive>['getByRole']) =>
  getByRole('combobox');

describe('CommandPalette keyboard entry', () => {
  it('opens on Ctrl K and closes on a second Ctrl K', () => {
    const { queryByRole } = renderInteractive(<Harness />);
    expect(queryByRole('dialog')).toBeNull();

    fireEvent.keyDown(document, { key: 'k', ctrlKey: true });
    expect(queryByRole('dialog')).not.toBeNull();

    fireEvent.keyDown(document, { key: 'k', ctrlKey: true });
    expect(queryByRole('dialog')).toBeNull();
  });

  it('opens on ⌘K as well', () => {
    const { queryByRole } = renderInteractive(<Harness />);
    fireEvent.keyDown(document, { key: 'K', metaKey: true });
    expect(queryByRole('dialog')).not.toBeNull();
  });

  it('ignores the near misses', () => {
    const { queryByRole } = renderInteractive(<Harness />);
    fireEvent.keyDown(document, { key: 'k' });
    fireEvent.keyDown(document, { key: 'k', ctrlKey: true, shiftKey: true });
    fireEvent.keyDown(document, { key: 'k', ctrlKey: true, altKey: true });
    fireEvent.keyDown(document, { key: 'j', ctrlKey: true });
    expect(queryByRole('dialog')).toBeNull();
  });

  it('puts focus in the search box when it opens', () => {
    const { getByRole } = renderInteractive(<Harness />);
    fireEvent.keyDown(document, { key: 'k', ctrlKey: true });
    expect(document.activeElement).toBe(searchBox(getByRole));
  });

  it('closes on Escape', () => {
    const { queryByRole } = renderInteractive(<Harness />);
    fireEvent.keyDown(document, { key: 'k', ctrlKey: true });
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(queryByRole('dialog')).toBeNull();
  });

  it('returns focus to whatever opened it', async () => {
    const { getByRole } = renderInteractive(<Harness />);
    const trigger = getByRole('button', { name: '打开命令面板' });
    trigger.focus();
    fireEvent.click(trigger);
    expect(document.activeElement).not.toBe(trigger);

    fireEvent.keyDown(document, { key: 'Escape' });
    /* Radix restores focus after the unmount settles, so that a component
       tearing down alongside the palette cannot steal it back. */
    await waitFor(() => {
      expect(document.activeElement).toBe(trigger);
    });
  });

  it('starts from a clean query every time it opens', () => {
    const { getByRole } = renderInteractive(<Harness />);
    fireEvent.keyDown(document, { key: 'k', ctrlKey: true });
    fireEvent.change(searchBox(getByRole), { target: { value: '设置' } });
    expect((searchBox(getByRole) as HTMLInputElement).value).toBe('设置');

    fireEvent.keyDown(document, { key: 'Escape' });
    fireEvent.keyDown(document, { key: 'k', ctrlKey: true });
    expect((searchBox(getByRole) as HTMLInputElement).value).toBe('');
  });
});

describe('CommandPalette selection', () => {
  function open(commands?: readonly CommandDefinition[]) {
    const result = renderInteractive(<Harness commands={commands} />);
    fireEvent.keyDown(document, { key: 'k', ctrlKey: true });
    return result;
  }

  const selectedId = (getAllByRole: ReturnType<typeof renderInteractive>['getAllByRole']) =>
    getAllByRole('option').find((option) => option.getAttribute('aria-selected') === 'true')?.dataset[
      'commandId'
    ];

  it('selects the first row and moves it with ↓ and ↑', () => {
    const { getAllByRole, getByRole } = open();
    expect(selectedId(getAllByRole)).toBe('page.home');

    fireEvent.keyDown(searchBox(getByRole), { key: 'ArrowDown' });
    expect(selectedId(getAllByRole)).toBe('page.library');

    fireEvent.keyDown(searchBox(getByRole), { key: 'ArrowUp' });
    expect(selectedId(getAllByRole)).toBe('page.home');
  });

  it('wraps at both ends of the list', () => {
    const { getAllByRole, getByRole } = open();
    fireEvent.keyDown(searchBox(getByRole), { key: 'ArrowUp' });
    // Four rows per group, so ↑ from the first lands on the fourth.
    expect(selectedId(getAllByRole)).toBe('page.players');

    fireEvent.keyDown(searchBox(getByRole), { key: 'ArrowDown' });
    expect(selectedId(getAllByRole)).toBe('page.home');
  });

  it('keeps the announced active row in step with the selection', () => {
    const { getAllByRole, getByRole } = open();
    fireEvent.keyDown(searchBox(getByRole), { key: 'ArrowDown' });

    const active = searchBox(getByRole).getAttribute('aria-activedescendant');
    const selected = getAllByRole('option').find(
      (option) => option.getAttribute('aria-selected') === 'true',
    );
    expect(active).toBe(selected?.id);
  });

  it('moves to the next group on TAB and wraps back', () => {
    const { getAllByRole, getByRole } = open(TWO_GROUPS);
    expect(selectedId(getAllByRole)).toBe('match.aurora');

    fireEvent.keyDown(searchBox(getByRole), { key: 'Tab' });
    expect(selectedId(getAllByRole)).toBe('page.home');

    fireEvent.keyDown(searchBox(getByRole), { key: 'Tab' });
    expect(selectedId(getAllByRole)).toBe('match.aurora');
    // TAB never leaves the palette: the input stays focused throughout.
    expect(document.activeElement).toBe(searchBox(getByRole));
  });

  it('resets the selection to the first row when the query changes', () => {
    const { getAllByRole, getByRole } = open();
    fireEvent.keyDown(searchBox(getByRole), { key: 'ArrowDown' });
    expect(selectedId(getAllByRole)).toBe('page.library');

    fireEvent.change(searchBox(getByRole), { target: { value: '交付' } });
    expect(selectedId(getAllByRole)).toBe('page.delivery-outputs');
  });
});

describe('CommandPalette execution', () => {
  it('runs the selected command on Enter and closes', () => {
    const navigate = vi.fn();
    const { getByRole, queryByRole } = renderInteractive(<Harness navigate={navigate} />);
    fireEvent.keyDown(document, { key: 'k', ctrlKey: true });

    fireEvent.keyDown(searchBox(getByRole), { key: 'ArrowDown' });
    fireEvent.keyDown(searchBox(getByRole), { key: 'Enter' });

    expect(navigate).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledWith('/library');
    expect(queryByRole('dialog')).toBeNull();
  });

  it('runs the row that was clicked, not the selected one', () => {
    const navigate = vi.fn();
    const { getAllByRole, queryByRole } = renderInteractive(<Harness navigate={navigate} />);
    fireEvent.keyDown(document, { key: 'k', ctrlKey: true });

    const rows = getAllByRole('option');
    const players = rows.find((row) => row.dataset['commandId'] === 'page.players');
    expect(players).toBeDefined();
    if (players) fireEvent.click(players);

    expect(navigate).toHaveBeenCalledWith('/players');
    expect(queryByRole('dialog')).toBeNull();
  });

  it('filters as the user types and reaches a page the rail does not list', () => {
    const navigate = vi.fn();
    const { getByRole, getAllByRole } = renderInteractive(<Harness navigate={navigate} />);
    fireEvent.keyDown(document, { key: 'k', ctrlKey: true });

    fireEvent.change(searchBox(getByRole), { target: { value: '恢复' } });
    expect(getAllByRole('option')).toHaveLength(1);

    fireEvent.keyDown(searchBox(getByRole), { key: 'Enter' });
    expect(navigate).toHaveBeenCalledWith('/recovery');
  });

  it('does nothing on Enter when nothing matches', () => {
    const navigate = vi.fn();
    const { getByRole, queryAllByRole, queryByRole, getByText } = renderInteractive(
      <Harness navigate={navigate} />,
    );
    fireEvent.keyDown(document, { key: 'k', ctrlKey: true });
    fireEvent.change(searchBox(getByRole), { target: { value: 'ziliaoku' } });

    expect(queryAllByRole('option')).toHaveLength(0);
    expect(queryByRole('listbox')).toBeNull();
    expect(getByText('没有匹配的结果')).toBeTruthy();

    fireEvent.keyDown(searchBox(getByRole), { key: 'Enter' });
    expect(navigate).not.toHaveBeenCalled();
    // The palette stays open so the query can be corrected in place.
    expect(queryByRole('dialog')).not.toBeNull();
  });

  it('dismisses on a press on the scrim but not inside the panel', async () => {
    const { getByRole, queryByRole } = renderInteractive(<Harness />);
    fireEvent.keyDown(document, { key: 'k', ctrlKey: true });

    /* Radix arms the outside-press listener on a zero-delay timeout, so that
       the very press which opened the overlay cannot also dismiss it. */
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    fireEvent.pointerDown(getByRole('dialog'));
    expect(queryByRole('dialog')).not.toBeNull();

    // `document`, not the render container: the scrim is portalled to the body.
    const scrim = document.querySelector('[data-overlay="command-palette-backdrop"]');
    expect(scrim).not.toBeNull();
    if (scrim) {
      fireEvent.pointerDown(scrim);
      fireEvent.click(scrim);
    }
    expect(queryByRole('dialog')).toBeNull();
  });
});
