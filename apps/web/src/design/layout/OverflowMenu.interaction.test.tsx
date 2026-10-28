import { fireEvent, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { renderInteractive } from '../../test/render';
import { OverflowMenu, type OverflowMenuItem } from './OverflowMenu';

/* The Timeline's 「剪辑」 menu: 28 rows, taller than a 900px window. */
const LONG: OverflowMenuItem[] = Array.from({ length: 28 }, (_, index) => ({
  id: `item-${index}`,
  label: `操作 ${index + 1}`,
}));

/* Radix opens a dropdown on the press, not on the click. */
function openMenu(trigger: HTMLElement): void {
  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
}

describe('OverflowMenu with a list taller than the window', () => {
  it('keeps the workspace accessible while a menu is open', () => {
    const { getByRole } = renderInteractive(
      <main aria-label="工作区">
        <OverflowMenu items={LONG} label="剪辑操作" />
        <button type="button">页面动作</button>
      </main>,
    );

    openMenu(getByRole('button', { name: '剪辑操作' }));

    expect(getByRole('menu', { name: '剪辑操作' })).toBeTruthy();
    expect(getByRole('main', { name: '工作区' })).toBeTruthy();
    expect(getByRole('button', { name: '页面动作' })).toBeTruthy();
    expect(document.body.style.pointerEvents).not.toBe('none');
  });

  it('caps the list at the space Radix measures and scrolls it inside', () => {
    const { getByRole } = renderInteractive(<OverflowMenu items={LONG} label="剪辑操作" />);

    openMenu(getByRole('button', { name: '剪辑操作' }));

    const menu = getByRole('menu');
    expect(menu.className).toContain('max-h-[var(--radix-dropdown-menu-content-available-height)]');
    expect(menu.className).toContain('overflow-y-auto');
  });

  it('keeps every row at its compact height instead of squeezing them into the cap', () => {
    const { getByRole } = renderInteractive(<OverflowMenu items={LONG} label="剪辑操作" />);

    openMenu(getByRole('button', { name: '剪辑操作' }));

    const items = within(getByRole('menu')).getAllByRole('menuitem');
    expect(items).toHaveLength(28);
    for (const item of items) {
      expect(item.className).toContain('h-[var(--h-row-compact)]');
      expect(item.className).toContain('flex-none');
    }
  });
});
