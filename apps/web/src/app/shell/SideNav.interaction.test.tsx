import { act, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { stubMatchMedia, type MatchMediaStub } from '../../design/layout/collapse.testing';
import { renderInteractive } from '../../test/render';
import { resetShellStore, useShellStore } from './shellStore';
import { SideNav, type SideNavProps } from './SideNav';

let media: MatchMediaStub | null = null;

beforeEach(() => {
  resetShellStore();
});

afterEach(() => {
  media?.restore();
  media = null;
});

function mount(props: SideNavProps = {}, at = '/') {
  return renderInteractive(
    <MemoryRouter initialEntries={[at]}>
      <SideNav {...props} />
    </MemoryRouter>,
  );
}

describe('collapsing and expanding the rail', () => {
  it('folds to the icon rail and back, and remembers which it is', () => {
    const { container, getByRole } = mount();
    const rail = () => container.querySelector('[data-shell-nav]')?.getAttribute('data-shell-nav');

    expect(rail()).toBe('expanded');

    fireEvent.click(getByRole('button', { name: '收起侧栏' }));
    expect(rail()).toBe('collapsed');
    expect(useShellStore.getState().navCollapsed).toBe(true);

    fireEvent.click(getByRole('button', { name: '展开侧栏' }));
    expect(rail()).toBe('expanded');
    expect(useShellStore.getState().navCollapsed).toBe(false);
  });

  it('lets a caller own the toggle instead of the store', () => {
    const onToggleCollapsed = vi.fn();
    const { getByRole } = mount({ onToggleCollapsed });

    fireEvent.click(getByRole('button', { name: '收起侧栏' }));
    expect(onToggleCollapsed).toHaveBeenCalledTimes(1);
    expect(useShellStore.getState().navCollapsed).toBe(false);
  });

  it('follows the §8 breakpoint even when the preference says otherwise', () => {
    media = stubMatchMedia(false);
    const stub = media;
    const { container } = mount();
    const rail = () => container.querySelector('[data-shell-nav]')?.getAttribute('data-shell-nav');

    expect(rail()).toBe('expanded');
    act(() => {
      stub.setMatches(true);
    });
    expect(rail()).toBe('collapsed');
    expect(useShellStore.getState().navCollapsed).toBe(false);
  });

  it('disables the toggle below the breakpoint and writes the reason down', () => {
    media = stubMatchMedia(true);
    const { getByRole } = mount();
    const toggle = getByRole('button', { name: '展开侧栏' }) as HTMLButtonElement;

    expect(toggle.disabled).toBe(true);
    const described = toggle.getAttribute('aria-describedby');
    expect(described).not.toBeNull();
    expect(document.getElementById(described as string)?.textContent).toContain('窗口宽度不足 1100px');
  });
});

describe('the collapsed rail flyout', () => {
  it('floats the group heading and the label out on hover', () => {
    const { container, queryByText } = mount({ collapsed: true });
    const evidence = container.querySelector('[data-nav-item="evidence"]') as HTMLElement;
    const item = evidence.closest('li') as HTMLElement;

    expect(container.querySelector('[data-nav-flyout]')).toBeNull();

    fireEvent.pointerEnter(item);
    const flyout = container.querySelector('[data-nav-flyout="evidence"]') as HTMLElement;
    expect(flyout).not.toBeNull();
    expect(flyout.textContent).toBe('资料库证据检索');

    fireEvent.pointerLeave(item);
    expect(container.querySelector('[data-nav-flyout]')).toBeNull();
    expect(queryByText('资料库')).toBeNull();
  });

  it('opens the same flyout on keyboard focus — the headings are not hover-only', () => {
    const { container } = mount({ collapsed: true });
    const agent = container.querySelector('[data-nav-item="projects"]') as HTMLElement;

    act(() => {
      agent.focus();
    });
    expect(container.querySelector('[data-nav-flyout="projects"]')?.textContent).toBe('制作作品');

    act(() => {
      agent.blur();
    });
    expect(container.querySelector('[data-nav-flyout]')).toBeNull();
  });

  it('closes the flyout on Escape without collapsing anything else', () => {
    const { container } = mount({ collapsed: true });
    const home = container.querySelector('[data-nav-item="home"]') as HTMLElement;

    fireEvent.pointerEnter(home.closest('li') as HTMLElement);
    expect(container.querySelector('[data-nav-flyout]')).not.toBeNull();

    fireEvent.keyDown(home, { key: 'Escape' });
    expect(container.querySelector('[data-nav-flyout]')).toBeNull();
    expect(container.querySelector('[data-shell-nav]')?.getAttribute('data-shell-nav')).toBe('collapsed');
  });

  it('keeps every entry named for assistive technology while collapsed', () => {
    const { getByRole } = mount({ collapsed: true });

    expect(getByRole('link', { name: '证据检索' })).not.toBeNull();
    expect(getByRole('link', { name: '设置与诊断' })).not.toBeNull();
  });
});

describe('current destination', () => {
  it('marks exactly one entry, in both states', () => {
    const expanded = mount({}, '/projects/new');
    expect(expanded.container.querySelectorAll('[aria-current="page"]')).toHaveLength(1);
    expect(
      expanded.container.querySelector('[aria-current="page"]')?.getAttribute('data-nav-item'),
    ).toBe('projects');
    expanded.unmount();

    const collapsed = mount({ collapsed: true }, '/delivery?view=tasks');
    expect(collapsed.container.querySelectorAll('[aria-current="page"]')).toHaveLength(1);
    expect(
      collapsed.container.querySelector('[aria-current="page"]')?.getAttribute('data-nav-item'),
    ).toBe('outputs');
  });
});

describe('tab order', () => {
  it('walks the rail top to bottom and ends on the collapse toggle', () => {
    const { container } = mount();
    const stops = [...container.querySelectorAll<HTMLElement>('a[href], button')].map(
      (element) => element.getAttribute('data-nav-item') ?? element.getAttribute('data-nav-toggle') ?? '?',
    );

    expect(stops).toEqual([
      'home',
      'library',
      'history',
      'players',
      'evidence',
      'projects',
      'recording',
      'editor',
      'outputs',
      'settings',
      'true',
    ]);
  });
});
