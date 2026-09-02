/*
 * App shell — the self-drawn Windows tall title bar (`--h-titlebar`, 48px).
 *
 * The shell draws it as three stretches across one 48px bar:
 *
 *   ┌ 216px ────────┬ flex:1 ─────────────────────────────┬ 3 × 46px ┐
 *   │ V  VIBE CS    │ crumb   ⌕ 跳转、搜索…  CTRL K   ● 本地服务在线 │ ─ ▢ ✕ │
 *   └───────────────┴─────────────────────────────────────┴──────────┘
 *
 * The left block is exactly `--w-nav` wide and carries the same right-hand
 * hairline as the rail below it, so brand and rail share one vertical edge;
 * when the rail collapses the block follows it to `--w-nav-collapsed`.
 * Window controls sit on the right — this is a Windows-first desktop app and
 * Frame draws them there.
 *
 * Two folds against the reference, both required by §3:
 *   · the Ctrl K field is drawn 400px wide; §3.5 folds 400 into `--w-inspector`
 *     (380). It is `max-w-full` so a narrow window shrinks it rather than
 *     pushing the status out of the bar.
 *   · the same field is drawn 28px tall; §3.3 sets a 32px floor with no
 *     exceptions, so it is `--h-ctl-sm`.
 *
 * Window control behaviour is ported from the pre-redesign
 * `app/WindowTitleBar.tsx` unchanged — dragging, double-click-to-maximise and
 * the "ignore the press when it landed on a control" rule were already right.
 * The Tauri window is reached through an adapter so a test can pass its own:
 * when `adapter` is given the component never touches `@tauri-apps/api`.
 */

import { CopyRegular } from '@fluentui/react-icons/svg/copy';
import { DismissRegular } from '@fluentui/react-icons/svg/dismiss';
import { SquareRegular } from '@fluentui/react-icons/svg/square';
import { SubtractRegular } from '@fluentui/react-icons/svg/subtract';
import { t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { Bell, Search } from 'lucide-react';
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';

import { cn } from '../../design/layout';
import { Kbd } from '../../design/primitives';
import { isDesktopShell } from '../../shared/desktop/dialog';
import { ServiceStatusMarker, type ServiceStatus } from '../boundary';
import { useShellStore } from './shellStore';
import type { WorkspaceMode } from './navigation';
import { WorkspaceModeMenu } from './WorkspaceModeMenu';

/**
 * The local service state the top bar reports. This is an alias, not a second
 * union: `ServiceGate` (§4.1) owns the states, and the dot itself is
 * `ServiceStatusMarker` — the title bar renders the only instance of it in the
 * whole shell, so there is exactly one implementation of «● 本地服务在线».
 */
export type ShellServiceStatus = ServiceStatus;

export interface DesktopWindowAdapter {
  minimize(): Promise<void>;
  toggleMaximize(): Promise<void>;
  close(): Promise<void>;
  startDragging(): Promise<void>;
  isMaximized(): Promise<boolean>;
  onResized(handler: () => void): Promise<() => void>;
}

interface PointerDownDetails {
  button: number;
  doubleClick: boolean;
}

export interface WindowTitleBarController {
  minimize(): Promise<void>;
  toggleMaximize(): Promise<void>;
  close(): Promise<void>;
  startDragging(): Promise<void>;
  handlePointerDown(details: PointerDownDetails): Promise<void>;
}

/**
 * Wraps an adapter so that a missing window (the browser dev server) is a
 * no-op and a rejected call is reported rather than thrown into the void.
 */
export function createWindowTitleBarController(
  adapter: DesktopWindowAdapter | null,
  reportError: (cause: unknown) => void,
): WindowTitleBarController {
  const run = async (operation: (window: DesktopWindowAdapter) => Promise<void>) => {
    if (!adapter) return;
    try {
      await operation(adapter);
    } catch (cause) {
      reportError(cause);
    }
  };

  const toggleMaximize = () => run((window) => window.toggleMaximize());

  return {
    minimize: () => run((window) => window.minimize()),
    toggleMaximize,
    close: () => run((window) => window.close()),
    startDragging: () => run((window) => window.startDragging()),
    handlePointerDown: async ({ button, doubleClick }) => {
      if (button !== 0) return;
      if (doubleClick) {
        await toggleMaximize();
        return;
      }
      await run((window) => window.startDragging());
    },
  };
}

async function resolveDesktopWindow(): Promise<DesktopWindowAdapter | null> {
  if (!isDesktopShell()) return null;
  const { getCurrentWindow } = await import('@tauri-apps/api/window');
  return getCurrentWindow();
}

export interface WindowTitleBarProps {
  /** Project workbench focus mode: keep drag/window controls, hide global chrome. */
  compact?: boolean | undefined;
  /** Current work lens shown in the former brand block. */
  mode?: WorkspaceMode | undefined;
  /** Switches the shell navigation and lands on that lens's remembered entry. */
  onModeChange?: ((mode: WorkspaceMode) => void) | undefined;
  /** 「资料库 › Aurora vs Meridian › 概览」. Owned by the route. */
  crumb?: ReactNode;
  serviceStatus?: ShellServiceStatus;
  /** Opens the command palette. The Ctrl K key binding belongs to the palette. */
  onOpenCommandPalette?: (() => void) | undefined;
  /** Opens the shell-level background activity drawer. */
  onOpenActivity?: (() => void) | undefined;
  activityUnreadCount?: number | undefined;
  /** Overrides the persisted rail state; the brand block tracks the rail width. */
  navCollapsed?: boolean | undefined;
  /**
   * The desktop window. `undefined` resolves the real one lazily, `null` means
   * "no window" (browser), an object is used as given — which is how tests
   * keep Tauri out of the tree.
   */
  adapter?: DesktopWindowAdapter | null | undefined;
  className?: string | undefined;
}

/* 「本地服务离线」 artboard: the offline line is the only one that takes a
   colour — the darkened brick red `theme.css` records as `--color-fail-text`,
   and `ServiceStatusMarker` already applies it. The two neutral steps below are
   the title bar's own inks; the marker is rendered by nothing else, but leaving
   the tone here keeps the marker itself free of a caller's typography. */
const SERVICE_TEXT_CLASS: Record<ShellServiceStatus, string> = {
  checking: 'text-neutral-600',
  online: 'text-neutral-700',
  offline: 'text-fail-text',
};

/* Windows caption controls use a system-width backplate rather than the
   product spacing scale. 46px is the logical caption width; the title bar
   height remains responsive to the standard/tall Windows title-bar mode. */
const CONTROL_CLASS =
  'pointer-events-auto grid h-full w-[46px] flex-none place-items-center text-neutral-700 ' +
  'hover:bg-neutral-200 hover:text-text active:bg-neutral-300';

/** A press that started on a control is that control's, not the drag region's. */
const NO_DRAG_SELECTOR = 'button, a, input, textarea, select, [data-window-no-drag]';

function startsOnDragRegion(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(NO_DRAG_SELECTOR) === null;
}

export function WindowTitleBar({
  compact = false,
  mode,
  onModeChange,
  crumb,
  serviceStatus = 'checking',
  onOpenCommandPalette,
  onOpenActivity,
  activityUnreadCount = 0,
  navCollapsed,
  adapter,
  className,
}: WindowTitleBarProps) {
  const storedMode = useShellStore((state) => state.mode);
  const storedNavCollapsed = useShellStore((state) => state.navCollapsed);
  const currentMode = mode ?? storedMode;
  const collapsed = navCollapsed ?? storedNavCollapsed;

  const [desktopWindow, setDesktopWindow] = useState<DesktopWindowAdapter | null>(adapter ?? null);
  const [actionFailed, setActionFailed] = useState(false);
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    if (adapter !== undefined) {
      setDesktopWindow(adapter);
      return undefined;
    }
    let active = true;
    void resolveDesktopWindow()
      .then((window) => {
        if (active) setDesktopWindow(window);
      })
      .catch(() => {
        if (active) setActionFailed(true);
      });
    return () => {
      active = false;
    };
  }, [adapter]);

  const controller = useMemo(
    () => createWindowTitleBarController(desktopWindow, () => setActionFailed(true)),
    [desktopWindow],
  );
  const controlClass = cn(CONTROL_CLASS, compact && 'text-neutral-500');
  const syncMaximizedState = useCallback(async () => {
    if (desktopWindow === null) return;
    try {
      setMaximized(await desktopWindow.isMaximized());
    } catch {
      setActionFailed(true);
    }
  }, [desktopWindow]);

  useEffect(() => {
    if (desktopWindow === null) {
      setMaximized(false);
      return undefined;
    }
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void syncMaximizedState();
    void desktopWindow.onResized(() => void syncMaximizedState())
      .then((stop) => {
        if (disposed) stop();
        else unlisten = stop;
      })
      .catch(() => setActionFailed(true));
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [desktopWindow, syncMaximizedState]);

  const toggleWindowMaximize = async () => {
    await controller.toggleMaximize();
    await syncMaximizedState();
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLElement>) => {
    if (!startsOnDragRegion(event.target)) return;
    void controller.handlePointerDown({ button: event.button, doubleClick: false });
  };

  const onDoubleClick = (event: ReactPointerEvent<HTMLElement>) => {
    if (!startsOnDragRegion(event.target)) return;
    event.preventDefault();
    void toggleWindowMaximize();
  };

  return (
    <header
      data-titlebar-compact={String(compact)}
      data-shell-titlebar={collapsed ? 'nav-collapsed' : 'nav-expanded'}
      onPointerDown={onPointerDown}
      onDoubleClick={onDoubleClick}
      className={cn(
        'flex flex-none items-stretch border-b border-divider bg-surface-chrome',
        compact
          ? 'pointer-events-none absolute inset-x-0 top-0 z-50 h-[48px] border-b-0 bg-transparent'
          : 'h-[var(--h-titlebar)]',
        className,
      )}
    >
      {compact ? null : (
        <div
          data-titlebar-mode={currentMode}
          className={cn(
            'flex flex-none items-stretch border-r border-divider',
            collapsed ? 'w-[var(--w-nav-collapsed)]' : 'w-[var(--w-nav)]',
          )}
        >
          <WorkspaceModeMenu
            mode={currentMode}
            collapsed={collapsed}
            onModeChange={onModeChange}
          />
        </div>
      )}

      <div className={cn('flex min-w-0 flex-1 items-center gap-3.5', compact ? 'px-0' : 'px-4')}>
        {/* A `div`, not a `span`: the crumb is a `<nav>` with a list in it. */}
        <div className="flex min-w-0 items-center">{crumb}</div>
        <span className="flex-1" />

        {compact ? null : (
          <>
            <button
              type="button"
              data-window-no-drag
              data-titlebar-command
              onClick={onOpenCommandPalette}
              className={
                'flex h-[var(--h-ctl-sm)] w-[var(--w-inspector)] max-w-full flex-none items-center gap-2 ' +
                'border border-divider bg-bg px-2.5 text-sm text-neutral-600 ' +
                'hover:border-neutral-500 hover:text-text'
              }
            >
              <Search size={14} strokeWidth={1.5} aria-hidden="true" className="flex-none" />
              <span className="min-w-0 flex-1 truncate text-left">
                <Trans>跳转、搜索比赛或证据</Trans>
              </span>
              <Kbd className="tracking-wide">CTRL K</Kbd>
            </button>

            <span className="flex-1" />

            {onOpenActivity === undefined ? null : (
              <button
                type="button"
                data-window-no-drag
                data-titlebar-activity
                aria-label={
                  activityUnreadCount > 0
                    ? t`后台任务，${activityUnreadCount} 条未读`
                    : t`后台任务`
                }
                onClick={onOpenActivity}
                className="relative grid size-[var(--h-ctl-sm)] flex-none place-items-center border border-divider text-neutral-700 hover:border-neutral-500 hover:text-text"
              >
                <Bell size={15} strokeWidth={1.5} aria-hidden="true" />
                {activityUnreadCount > 0 ? (
                  <span
                    aria-hidden="true"
                    data-activity-unread={activityUnreadCount}
                    className="absolute -right-1 -top-1 min-w-4 border border-accent bg-accent px-0.5 font-mono text-2xs leading-tight text-bg"
                  >
                    {activityUnreadCount > 99 ? '99+' : activityUnreadCount}
                  </span>
                ) : null}
              </button>
            )}

            <span data-titlebar-service={serviceStatus} className="flex flex-none items-center">
              <ServiceStatusMarker status={serviceStatus} className={SERVICE_TEXT_CLASS[serviceStatus]} />
            </span>
          </>
        )}
      </div>

      <div data-window-no-drag className="flex flex-none items-stretch">
        {actionFailed ? (
          <span
            role="status"
            data-window-action-failed
            className="self-center whitespace-nowrap px-2.5 text-xs text-fail-text"
          >
            <Trans>窗口操作失败</Trans>
          </span>
        ) : null}
        <button
          type="button"
          data-window-control="minimize"
          aria-label={t`最小化窗口`}
          title={t`最小化窗口`}
          onClick={() => void controller.minimize()}
          className={controlClass}
        >
          <SubtractRegular className="size-4" aria-hidden="true" />
        </button>
        <button
          type="button"
          data-window-control="maximize"
          data-window-state={maximized ? 'restore' : 'maximize'}
          aria-label={maximized ? t`还原窗口` : t`最大化窗口`}
          title={maximized ? t`还原窗口` : t`最大化窗口`}
          onClick={() => void toggleWindowMaximize()}
          className={controlClass}
        >
          {maximized
            ? <CopyRegular className="size-3.5" aria-hidden="true" />
            : <SquareRegular className="size-3.5" aria-hidden="true" />}
        </button>
        <button
          type="button"
          data-window-control="close"
          aria-label={t`关闭窗口`}
          title={t`关闭窗口`}
          onClick={() => void controller.close()}
          className={cn(controlClass, 'hover:bg-fail hover:text-bg')}
        >
          <DismissRegular className="size-4" aria-hidden="true" />
        </button>
      </div>
    </header>
  );
}
