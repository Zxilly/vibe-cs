import { Trans } from '@lingui/react/macro';
import { act, fireEvent, within } from '@testing-library/react';
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
    fireEvent.click(trigger);

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

  it('moves focus into the menu, runs the chosen action and closes', () => {
    media = stubMatchMedia(true);
    const onExport = vi.fn();
    const { getByRole, queryByRole } = renderInteractive(
      <Toolbar actions={actions(onExport)} primary={PRIMARY} />,
    );

    fireEvent.click(getByRole('button', { name: '更多操作' }));
    const items = within(getByRole('menu')).getAllByRole('menuitem');
    expect(document.activeElement).toBe(items[0]);

    fireEvent.click(items[1] as HTMLElement);

    expect(onExport).toHaveBeenCalledTimes(1);
    expect(queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(getByRole('button', { name: '更多操作' }));
  });

  it('walks the menu with the arrow keys and wraps', () => {
    media = stubMatchMedia(true);
    const { getByRole } = renderInteractive(<Toolbar actions={actions()} primary={PRIMARY} />);

    fireEvent.click(getByRole('button', { name: '更多操作' }));
    const menu = getByRole('menu');
    const items = within(menu).getAllByRole('menuitem');

    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(items[1]);

    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(items[0]);

    fireEvent.keyDown(menu, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(items[1]);
  });

  it('closes on Esc and returns focus to the trigger', () => {
    media = stubMatchMedia(true);
    const { getByRole, queryByRole } = renderInteractive(
      <Toolbar actions={actions()} primary={PRIMARY} />,
    );

    const trigger = getByRole('button', { name: '更多操作' });
    fireEvent.click(trigger);
    fireEvent.keyDown(getByRole('menu'), { key: 'Escape' });

    expect(queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });
});
