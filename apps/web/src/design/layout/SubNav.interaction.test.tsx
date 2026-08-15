import { Trans } from '@lingui/react/macro';
import { act, fireEvent, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderInteractive } from '../../test/render';
import { stubMatchMedia, type MatchMediaStub } from './collapse.testing';
import { SubNav, type SubNavItem } from './SubNav';

let media: MatchMediaStub | null = null;

afterEach(() => {
  media?.restore();
  media = null;
});

const VIEWS: SubNavItem[] = [
  { id: 'overview', label: <Trans>概览</Trans> },
  { id: 'rounds', label: <Trans>回合</Trans> },
  { id: 'players', label: <Trans>玩家</Trans> },
  { id: 'duels', label: <Trans>对位</Trans> },
  { id: 'utility', label: <Trans>道具与经济</Trans> },
  { id: 'replay', label: <Trans>回放与热力图</Trans> },
  { id: 'highlights', label: <Trans>高光</Trans> },
  { id: 'review', label: <Trans>Review 与注释</Trans> },
  { id: 'teams', label: <Trans>阵容</Trans> },
];

describe('SubNav across the §8 breakpoint', () => {
  it('swaps the 190px rail for top tabs when the window folds', () => {
    media = stubMatchMedia(false);
    const stub = media;
    const { container } = renderInteractive(
      <SubNav items={VIEWS} activeId="overview" label="视图导航" />,
    );

    expect(container.querySelector('[data-subnav]')?.getAttribute('data-subnav')).toBe('rail');
    expect(container.querySelectorAll('[data-subnav-item]')).toHaveLength(9);

    act(() => {
      stub.setMatches(true);
    });

    expect(container.querySelector('[data-subnav]')?.getAttribute('data-subnav')).toBe('tabs');
    expect(container.querySelectorAll('[data-subnav-item]')).toHaveLength(5);
  });

  it('reaches a folded view through 更多 and reports it as the current one', () => {
    media = stubMatchMedia(true);
    const onSelect = vi.fn();
    const { getByRole } = renderInteractive(
      <SubNav items={VIEWS} activeId="overview" label="视图导航" onSelect={onSelect} />,
    );

    fireEvent.click(getByRole('button', { name: '更多视图' }));
    const items = within(getByRole('menu')).getAllByRole('menuitem');
    expect(items.map((item) => item.textContent)).toEqual([
      '回放与热力图',
      '高光',
      'Review 与注释',
      '阵容',
    ]);

    fireEvent.click(items[3] as HTMLElement);
    expect(onSelect).toHaveBeenCalledWith('teams');
  });

  it('never leaves the current view hidden inside 更多', () => {
    media = stubMatchMedia(true);
    const { container, getByRole } = renderInteractive(
      <SubNav items={VIEWS} activeId="teams" label="视图导航" />,
    );

    const current = container.querySelector('[data-subnav-item="teams"]');
    expect(current).not.toBeNull();
    expect(current?.getAttribute('aria-current')).toBe('page');

    fireEvent.click(getByRole('button', { name: '更多视图' }));
    const menu = getByRole('menu');
    expect(within(menu).queryByRole('menuitem', { name: '阵容' })).toBeNull();
  });

  it('closes 更多 on Esc and returns focus to its trigger', () => {
    media = stubMatchMedia(true);
    const { getByRole, queryByRole } = renderInteractive(
      <SubNav items={VIEWS} activeId="overview" label="视图导航" />,
    );

    const trigger = getByRole('button', { name: '更多视图' });
    fireEvent.click(trigger);
    fireEvent.keyDown(getByRole('menu'), { key: 'Escape' });

    expect(queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('selects a visible view by click', () => {
    media = stubMatchMedia(false);
    const onSelect = vi.fn();
    const { container } = renderInteractive(
      <SubNav items={VIEWS} activeId="overview" label="视图导航" onSelect={onSelect} />,
    );

    fireEvent.click(container.querySelector('[data-subnav-item="rounds"]') as HTMLElement);
    expect(onSelect).toHaveBeenCalledWith('rounds');
  });
});
