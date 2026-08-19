import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderMarkup } from '../../test/render';
import { resetShellStore } from './shellStore';
import {
  createWindowTitleBarController,
  WindowTitleBar,
  type DesktopWindowAdapter,
} from './WindowTitleBar';

beforeEach(() => {
  resetShellStore();
});

function stubAdapter(overrides: Partial<DesktopWindowAdapter> = {}): DesktopWindowAdapter {
  return {
    minimize: vi.fn(async () => undefined),
    toggleMaximize: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
    startDragging: vi.fn(async () => undefined),
    ...overrides,
  };
}

describe('WindowTitleBar', () => {
  it('is one 44px bar, brand block exactly as wide as the rail below it', () => {
    const html = renderMarkup(<WindowTitleBar adapter={null} />);

    expect(html).toContain('h-[var(--h-titlebar)]');
    expect(html).toContain('data-shell-titlebar="nav-expanded"');
    expect(html).toContain('w-[var(--w-nav)]');
    expect(html).toContain('bg-surface-chrome');
  });

  it('follows the rail to 56px when the rail is collapsed', () => {
    const html = renderMarkup(<WindowTitleBar adapter={null} navCollapsed />);

    expect(html).toContain('data-shell-titlebar="nav-collapsed"');
    expect(html).toContain('w-[var(--w-nav-collapsed)]');
    // The wordmark is dropped; only the 22px V mark stays.
    expect(html).not.toContain('VIBE CS');
  });

  it('carries the crumb and the Ctrl K entry of the frame', () => {
    const html = renderMarkup(
      <WindowTitleBar adapter={null} crumb="资料库 › Aurora vs Meridian › 概览" />,
    );

    expect(html).toContain('资料库 › Aurora vs Meridian › 概览');
    expect(html).toContain('跳转、搜索比赛或证据');
    expect(html).toContain('CTRL K');
    // §3.5 folds the artboard's 400px field into --w-inspector; §3.3 lifts its
    // 28px height to the 32px floor.
    expect(html).toContain('w-[var(--w-inspector)]');
    expect(html).toContain('h-[var(--h-ctl-sm)]');
  });

  it('reports the local service with a marker and a sentence, not colour alone', () => {
    const online = renderMarkup(<WindowTitleBar adapter={null} serviceStatus="online" />);
    expect(online).toContain('data-titlebar-service="online"');
    expect(online).toContain('本地服务在线');
    expect(online).toContain('data-status="ok"');
    expect(online).toContain('data-shape="filled"');

    const offline = renderMarkup(<WindowTitleBar adapter={null} serviceStatus="offline" />);
    expect(offline).toContain('data-titlebar-service="offline"');
    expect(offline).toContain('本地服务未连接');
    // 「本地服务离线」artboard: the dot goes hollow brick red, the line takes
    // the darkened ink of --color-fail-text.
    expect(offline).toContain('data-status="fail"');
    expect(offline).toContain('data-shape="hollow"');
    expect(offline).toContain('text-fail-text');

    const checking = renderMarkup(<WindowTitleBar adapter={null} serviceStatus="checking" />);
    expect(checking).toContain('data-titlebar-service="checking"');
    expect(checking).toContain('正在连接本地服务');
  });

  it('puts the three window controls on the right, each with a name', () => {
    const html = renderMarkup(<WindowTitleBar adapter={null} />);

    for (const control of ['minimize', 'maximize', 'close']) {
      expect(html).toContain(`data-window-control="${control}"`);
    }
    expect(html).toContain('aria-label="最小化窗口"');
    expect(html).toContain('aria-label="最大化或还原窗口"');
    expect(html).toContain('aria-label="关闭窗口"');
    // The control cluster is excluded from the drag region.
    expect(html).toContain('data-window-no-drag');
  });

  it('names the activity bell and renders its unread count', () => {
    const html = renderMarkup(
      <WindowTitleBar adapter={null} onOpenActivity={() => undefined} activityUnreadCount={3} />,
    );

    expect(html).toContain('data-titlebar-activity');
    expect(html).toContain('aria-label="后台任务，3 条未读"');
    expect(html).toContain('data-activity-unread="3"');
  });
});

/*
 * The controller is the part of the bar that has no markup, so it is asserted
 * here rather than in the jsdom pair: these cases are the pre-redesign
 * `app/WindowTitleBar.test.tsx` unit block, carried over when the component
 * moved into `app/shell/`.
 */
describe('WindowTitleBar controller', () => {
  it('is a no-op on every operation when there is no desktop window', async () => {
    const controller = createWindowTitleBarController(null, () => undefined);

    await expect(controller.minimize()).resolves.toBeUndefined();
    await expect(controller.toggleMaximize()).resolves.toBeUndefined();
    await expect(controller.close()).resolves.toBeUndefined();
    await expect(controller.startDragging()).resolves.toBeUndefined();
    await expect(
      controller.handlePointerDown({ button: 0, doubleClick: false }),
    ).resolves.toBeUndefined();
  });

  it('forwards minimize, maximize, close, and drag to the desktop window', async () => {
    const adapter = stubAdapter();
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

  it('reports a rejected window call instead of swallowing it', async () => {
    const reportError = vi.fn();
    const cause = new Error('window gone');
    const controller = createWindowTitleBarController(
      stubAdapter({
        close: vi.fn(async () => {
          throw cause;
        }),
      }),
      reportError,
    );

    await expect(controller.close()).resolves.toBeUndefined();
    expect(reportError).toHaveBeenCalledWith(cause);
  });

  it('double-click toggles maximize without starting a drag', async () => {
    const adapter = stubAdapter();
    const controller = createWindowTitleBarController(adapter, () => undefined);

    await controller.handlePointerDown({ button: 0, doubleClick: true });

    expect(adapter.toggleMaximize).toHaveBeenCalledOnce();
    expect(adapter.startDragging).not.toHaveBeenCalled();
  });

  it('ignores secondary-button pointer gestures', async () => {
    const adapter = stubAdapter();
    const controller = createWindowTitleBarController(adapter, () => undefined);

    await controller.handlePointerDown({ button: 2, doubleClick: false });
    await controller.handlePointerDown({ button: 2, doubleClick: true });

    expect(adapter.startDragging).not.toHaveBeenCalled();
    expect(adapter.toggleMaximize).not.toHaveBeenCalled();
  });
});
