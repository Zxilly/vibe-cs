import { Trans } from '@lingui/react/macro';
import { act, fireEvent, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderInteractive } from '../../test/render';
import { stubMatchMedia, type MatchMediaStub } from './collapse.testing';
import { Toolbar, type ToolbarAction } from './Toolbar';

let media: MatchMediaStub | null = null;

afterEach(() => {
  media?.restore();
  media = null;
});

function actions(onExport = () => {}): ToolbarAction[] {
  return [
    {
      id: 'watch',
      control: (
        <button type="button">
          <Trans>监听目录</Trans>
        </button>
      ),
      label: <Trans>监听目录</Trans>,
    },
    {
      id: 'export',
      control: (
        <button type="button">
          <Trans>导出元数据</Trans>
        </button>
      ),
      label: <Trans>导出元数据</Trans>,
      onSelect: onExport,
    },
  ];
}

const PRIMARY = (
  <button type="button">
    <Trans>用 Agent 制作视频</Trans>
  </button>
);

/* Radix opens a dropdown on the press, not on the click — so a press that
   opens the menu cannot also select whatever ends up under the pointer. */
function openMenu(trigger: HTMLElement): void {
  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
}

/* Menu keys are handled on the focused item, not on the menu box: Radix's
   roving focus lives on the items. Firing at the box would test nothing. */
function press(key: string): void {
  fireEvent.keyDown(document.activeElement ?? document.body, { key });
}

describe('Toolbar at the §8 collapse breakpoint', () => {
  /*
   * The rule this whole file exists for, quoted from the 1100 × 700 artboard:
   * 「主动作（加入视频、用 Agent 制作视频、确认并生成视频）在任何宽度下都保持
   *   可见，不进溢出菜单。」
   */
  it('never puts the main action into the overflow menu', () => {
    media = stubMatchMedia(true);
    const { getByRole, container } = renderInteractive(
      <Toolbar actions={actions()} primary={PRIMARY} />,
    );

    const trigger = getByRole('button', { name: '更多操作' });
    openMenu(trigger);

    const menu = getByRole('menu');
    const items = within(menu).getAllByRole('menuitem');
    expect(items.map((item) => item.textContent)).toEqual(['监听目录', '导出元数据']);
    expect(menu.textContent).not.toContain('用 Agent 制作视频');

    const primary = container.querySelector('[data-toolbar-primary]');
    expect(primary?.textContent).toBe('用 Agent 制作视频');
    expect(menu.contains(primary)).toBe(false);
  });

  it('folds the secondary actions only once the viewport crosses the breakpoint', () => {
    media = stubMatchMedia(false);
    const stub = media;
    const { container, queryByRole } = renderInteractive(
      <Toolbar actions={actions()} primary={PRIMARY} />,
    );

    expect(container.querySelectorAll('[data-toolbar-action]')).toHaveLength(2);
    expect(queryByRole('button', { name: '更多操作' })).toBeNull();

    act(() => {
      stub.setMatches(true);
    });

    expect(container.querySelectorAll('[data-toolbar-action]')).toHaveLength(0);
    expect(queryByRole('button', { name: '更多操作' })).not.toBeNull();
    expect(container.querySelector('[data-toolbar-primary]')?.textContent).toBe(
      '用 Agent 制作视频',
    );
  });

  it('moves focus into the menu, runs the chosen action and closes', async () => {
    media = stubMatchMedia(true);
    const onExport = vi.fn();
    const { getByRole, queryByRole } = renderInteractive(
      <Toolbar actions={actions(onExport)} primary={PRIMARY} />,
    );

    const trigger = getByRole('button', { name: '更多操作' });
    openMenu(trigger);
    const menu = getByRole('menu');
    const items = within(menu).getAllByRole('menuitem');
    /* Opened by pointer, focus lands on the menu itself and no item is
       highlighted — a mouse user has not chosen anything yet. Opening from the
       keyboard is the case that pre-selects, below. */
    expect(menu.contains(document.activeElement)).toBe(true);

    fireEvent.click(items[1] as HTMLElement);

    expect(onExport).toHaveBeenCalledTimes(1);
    expect(queryByRole('menu')).toBeNull();
    await waitFor(() => {
      expect(document.activeElement).toBe(getByRole('button', { name: '更多操作' }));
    });
  });

  it('walks the menu with the arrow keys and wraps', async () => {
    media = stubMatchMedia(true);
    const { getByRole } = renderInteractive(<Toolbar actions={actions()} primary={PRIMARY} />);

    /* Opened from the keyboard, so the first item is highlighted straight
       away — the whole reason ArrowDown opens a menu at all. */
    fireEvent.keyDown(getByRole('button', { name: '更多操作' }), { key: 'ArrowDown' });
    const menu = getByRole('menu');
    const items = within(menu).getAllByRole('menuitem');
    await waitFor(() => {
      expect(document.activeElement).toBe(items[0]);
    });

    /* Radix moves roving focus on a timeout, so that a key held down cannot
       outrun its own re-render. Every step here therefore settles first. */
    press('ArrowDown');
    await waitFor(() => {
      expect(document.activeElement).toBe(items[1]);
    });

    press('ArrowDown');
    await waitFor(() => {
      expect(document.activeElement).toBe(items[0]);
    });

    press('ArrowUp');
    await waitFor(() => {
      expect(document.activeElement).toBe(items[1]);
    });
  });

  /* Not in the hand-rolled menu, and the one menu affordance users reach for
     without being told it is there. */
  it('jumps to an item by typing its name', async () => {
    media = stubMatchMedia(true);
    const { getByRole } = renderInteractive(<Toolbar actions={actions()} primary={PRIMARY} />);

    const trigger = getByRole('button', { name: '更多操作' });
    openMenu(trigger);
    getByRole('menu');

    press('导');
    await waitFor(() => {
      expect((document.activeElement as HTMLElement | null)?.textContent).toBe('导出元数据');
    });
  });

  it('closes on Esc and returns focus to the trigger', async () => {
    media = stubMatchMedia(true);
    const { getByRole, queryByRole } = renderInteractive(
      <Toolbar actions={actions()} primary={PRIMARY} />,
    );

    const trigger = getByRole('button', { name: '更多操作' });
    openMenu(trigger);
    getByRole('menu');
    press('Escape');

    expect(queryByRole('menu')).toBeNull();
    await waitFor(() => {
      expect(document.activeElement).toBe(trigger);
    });
  });
});
