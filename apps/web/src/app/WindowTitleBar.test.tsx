import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import {
  createWindowTitleBarController,
  WindowTitleBar,
  type DesktopWindowAdapter,
} from './WindowTitleBar';

function windowAdapter(overrides: Partial<DesktopWindowAdapter> = {}): DesktopWindowAdapter {
  return {
    minimize: vi.fn(async () => undefined),
    toggleMaximize: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
    startDragging: vi.fn(async () => undefined),
    ...overrides,
  };
}

describe('desktop window title bar', () => {
  it('renders keyboard-operable controls outside the drag region', () => {
    const markup = renderToStaticMarkup(
      <WindowTitleBar adapter={null}><span>比赛</span></WindowTitleBar>,
    );

    expect(markup).toContain('class="titlebar"');
    expect(markup).toContain('aria-label="最小化窗口"');
    expect(markup).toContain('aria-label="最大化或还原窗口"');
    expect(markup).toContain('aria-label="关闭窗口"');
    expect(markup).not.toMatch(/window-controls[^>]*onpointerdown/);
  });

  it('uses safe no-op behavior when rendered outside Tauri', async () => {
    const controller = createWindowTitleBarController(null, () => undefined);

    await expect(controller.minimize()).resolves.toBeUndefined();
    await expect(controller.toggleMaximize()).resolves.toBeUndefined();
    await expect(controller.close()).resolves.toBeUndefined();
    await expect(controller.startDragging()).resolves.toBeUndefined();
  });

  it('forwards minimize, maximize, close, and drag to the desktop window', async () => {
    const adapter = windowAdapter();
    const controller = createWindowTitleBarController(adapter, () => undefined);

    await controller.minimize();
    await controller.toggleMaximize();
    await controller.close();
    await controller.startDragging();

    expect(adapter.minimize).toHaveBeenCalledOnce();
    expect(adapter.toggleMaximize).toHaveBeenCalledOnce();
    expect(adapter.close).toHaveBeenCalledOnce();
    expect(adapter.startDragging).toHaveBeenCalledOnce();
  });

  it('double-click toggles maximize without starting a drag', async () => {
    const adapter = windowAdapter();
    const controller = createWindowTitleBarController(adapter, () => undefined);

    await controller.handlePointerDown({ button: 0, doubleClick: true });

    expect(adapter.toggleMaximize).toHaveBeenCalledOnce();
    expect(adapter.startDragging).not.toHaveBeenCalled();
  });

  it('ignores secondary-button pointer gestures', async () => {
    const adapter = windowAdapter();
    const controller = createWindowTitleBarController(adapter, () => undefined);

    await controller.handlePointerDown({ button: 2, doubleClick: false });

    expect(adapter.startDragging).not.toHaveBeenCalled();
    expect(adapter.toggleMaximize).not.toHaveBeenCalled();
  });
});
