import { fireEvent, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderInteractive } from '../../test/render';
import { resetShellStore } from './shellStore';
import { WindowTitleBar, type DesktopWindowAdapter } from './WindowTitleBar';

/** A stand-in for the Tauri window: the component never imports @tauri-apps. */
function stubAdapter(overrides: Partial<DesktopWindowAdapter> = {}) {
  return {
    minimize: vi.fn(async () => {}),
    toggleMaximize: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    startDragging: vi.fn(async () => {}),
    ...overrides,
  } satisfies DesktopWindowAdapter;
}

beforeEach(() => {
  resetShellStore();
});

describe('window controls', () => {
  it('drives the window through the adapter it was given', () => {
    const adapter = stubAdapter();
    const { getByRole } = renderInteractive(<WindowTitleBar adapter={adapter} />);

    fireEvent.click(getByRole('button', { name: '最小化窗口' }));
    expect(adapter.minimize).toHaveBeenCalledTimes(1);

    fireEvent.click(getByRole('button', { name: '最大化或还原窗口' }));
    expect(adapter.toggleMaximize).toHaveBeenCalledTimes(1);

    fireEvent.click(getByRole('button', { name: '关闭窗口' }));
    expect(adapter.close).toHaveBeenCalledTimes(1);
  });

  it('does nothing at all when there is no desktop window', () => {
    const { getByRole } = renderInteractive(<WindowTitleBar adapter={null} />);
    // No adapter, no throw: the browser dev server renders the same bar.
    expect(() => fireEvent.click(getByRole('button', { name: '关闭窗口' }))).not.toThrow();
  });

  it('surfaces a failed window call instead of swallowing it', async () => {
    const adapter = stubAdapter({
      minimize: vi.fn(async () => {
        throw new Error('window gone');
      }),
    });
    const { getByRole, container } = renderInteractive(<WindowTitleBar adapter={adapter} />);

    fireEvent.click(getByRole('button', { name: '最小化窗口' }));
    // Addressed by its own hook rather than by role: the service marker is the
    // bar's other live region, and both being `role="status"` is deliberate.
    await waitFor(() => {
      expect(container.querySelector('[data-window-action-failed]')?.textContent).toBe(
        '窗口操作失败',
      );
    });
  });
});

describe('the drag region', () => {
  it('starts a window drag when the press lands on the bar itself', () => {
    const adapter = stubAdapter();
    const { container } = renderInteractive(<WindowTitleBar adapter={adapter} />);
    const bar = container.querySelector('[data-shell-titlebar]') as HTMLElement;

    fireEvent.pointerDown(bar, { button: 0 });
    expect(adapter.startDragging).toHaveBeenCalledTimes(1);
  });

  it('leaves the press alone when it lands on a control', () => {
    const adapter = stubAdapter();
    const { getByRole } = renderInteractive(<WindowTitleBar adapter={adapter} />);

    fireEvent.pointerDown(getByRole('button', { name: '关闭窗口' }), { button: 0 });
    expect(adapter.startDragging).not.toHaveBeenCalled();
  });

  it('ignores a non-primary button', () => {
    const adapter = stubAdapter();
    const { container } = renderInteractive(<WindowTitleBar adapter={adapter} />);
    const bar = container.querySelector('[data-shell-titlebar]') as HTMLElement;

    fireEvent.pointerDown(bar, { button: 2 });
    expect(adapter.startDragging).not.toHaveBeenCalled();
    expect(adapter.toggleMaximize).not.toHaveBeenCalled();
  });

  it('maximises on a double click on the bar', () => {
    const adapter = stubAdapter();
    const { container } = renderInteractive(<WindowTitleBar adapter={adapter} />);
    const bar = container.querySelector('[data-shell-titlebar]') as HTMLElement;

    fireEvent.doubleClick(bar);
    expect(adapter.toggleMaximize).toHaveBeenCalledTimes(1);
    // The second click of the gesture must not also drag the window away.
    expect(adapter.startDragging).not.toHaveBeenCalled();
  });

  it('leaves a double click on a control to that control', () => {
    const adapter = stubAdapter();
    const { getByRole } = renderInteractive(<WindowTitleBar adapter={adapter} />);

    fireEvent.doubleClick(getByRole('button', { name: '最小化窗口' }));
    expect(adapter.toggleMaximize).not.toHaveBeenCalled();
  });
});

describe('the command palette entry', () => {
  it('is a button that hands the palette its open signal', () => {
    const onOpen = vi.fn();
    const { container } = renderInteractive(
      <WindowTitleBar adapter={null} onOpenCommandPalette={onOpen} />,
    );
    const trigger = container.querySelector('[data-titlebar-command]') as HTMLButtonElement;

    expect(trigger.tagName).toBe('BUTTON');
    fireEvent.click(trigger);
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('is reachable by keyboard before the window controls', () => {
    const { container } = renderInteractive(<WindowTitleBar adapter={null} />);
    const order = [...container.querySelectorAll('button')].map((button) =>
      button.closest('[data-titlebar-mode]') !== null
        ? 'mode'
        : button.hasAttribute('data-titlebar-command')
          ? 'command'
          : button.getAttribute('data-window-control'),
    );

    expect(order).toEqual(['mode', 'command', 'minimize', 'maximize', 'close']);
  });
});

describe('the work-mode switch', () => {
  it('offers both lenses and reports the selected one', () => {
    const onModeChange = vi.fn();
    const { getByRole } = renderInteractive(
      <WindowTitleBar adapter={null} mode="edit" onModeChange={onModeChange} />,
    );

    fireEvent.pointerDown(getByRole('button', { name: /切换工作模式/u }), {
      button: 0,
      ctrlKey: false,
    });
    const analysis = getByRole('menuitem', { name: '分析模式' });
    fireEvent.click(analysis);

    expect(onModeChange).toHaveBeenCalledWith('analysis');
  });
});
