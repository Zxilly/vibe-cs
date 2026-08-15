/*
 * App shell — the self-drawn title bar (spec §3.4 `--h-titlebar`, 44px).
 *
 * Frame.dc.html draws it as three stretches across one 44px bar:
 *
 *   ┌ 216px ────────┬ flex:1 ─────────────────────────────┬ 3 × 44px ┐
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

import { t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { Maximize, Minus, Search, X } from 'lucide-react';
import {
  useEffect,
  useMemo,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';

import { cx } from '../../design/layout';
import { isDesktopShell } from '../../shared/desktop/dialog';
import { ServiceStatusMarker, type ServiceStatus } from '../boundary';
import { useShellStore } from './shellStore';

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
  /** 「资料库 › Aurora vs Meridian › 概览」. Owned by the route. */
  crumb?: ReactNode;
  serviceStatus?: ShellServiceStatus;
  /** Opens the command palette. The Ctrl K key binding belongs to the palette. */
  onOpenCommandPalette?: (() => void) | undefined;
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

/* Frame gives each control a 44px square; the token is the bar height because
   the reference sizes them off it (`--h-titlebar` = 44 = the drawn width).
   The hover wash is `--color-neutral-200` rather than the ink mix the design
   layer uses: §2.1 rule 5 forbids a bare colour inside an arbitrary value in
   `app/**`, and the ramp step reverses on its own in dark. */
const CONTROL_CLASS =
  'grid w-[var(--h-titlebar)] flex-none place-items-center text-neutral-700 ' +
  'hover:bg-neutral-200 hover:text-text';

/** A press that started on a control is that control's, not the drag region's. */
const NO_DRAG_SELECTOR = 'button, a, input, textarea, select, [data-window-no-drag]';

function startsOnDragRegion(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(NO_DRAG_SELECTOR) === null;
}

export function WindowTitleBar({
  crumb,
  serviceStatus = 'checking',
  onOpenCommandPalette,
  navCollapsed,
  adapter,
  className,
}: WindowTitleBarProps) {
  const storedNavCollapsed = useShellStore((state) => state.navCollapsed);
  const collapsed = navCollapsed ?? storedNavCollapsed;

  const [desktopWindow, setDesktopWindow] = useState<DesktopWindowAdapter | null>(adapter ?? null);
  const [actionFailed, setActionFailed] = useState(false);

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

  const onPointerDown = (event: ReactPointerEvent<HTMLElement>) => {
    if (!startsOnDragRegion(event.target)) return;
    void controller.handlePointerDown({ button: event.button, doubleClick: false });
  };

  const onDoubleClick = (event: ReactPointerEvent<HTMLElement>) => {
    if (!startsOnDragRegion(event.target)) return;
    event.preventDefault();
    void controller.toggleMaximize();
  };

  return (
    <header
      data-shell-titlebar={collapsed ? 'nav-collapsed' : 'nav-expanded'}
      onPointerDown={onPointerDown}
      onDoubleClick={onDoubleClick}
      className={cx(
        'flex h-[var(--h-titlebar)] flex-none items-stretch border-b border-divider bg-surface-chrome',
        className,
      )}
    >
      <div
        data-titlebar-brand
        className={cx(
          'flex flex-none items-center gap-2 border-r border-divider',
          collapsed ? 'w-[var(--w-nav-collapsed)] justify-center' : 'w-[var(--w-nav)] px-4',
        )}
      >
        <span
          aria-hidden="true"
          className="grid size-6.5 flex-none place-items-center border border-accent font-heading text-xs text-accent"
        >
          V
        </span>
        {collapsed ? null : (
          <>
            {/* 16px in Frame; §3.2 folds 16 into `--text-md`. */}
            <span className="font-heading text-md leading-tight tracking-caps">VIBE CS</span>
            {/* 9px in Frame; §3.2 folds 9/10 into `--text-2xs`. */}
            <span className="text-2xs tracking-caps text-neutral-600">STUDIO</span>
          </>
        )}
      </div>

      <div className="flex min-w-0 flex-1 items-center gap-3.5 px-4">
        <span data-titlebar-crumb className="min-w-0 truncate text-sm text-neutral-700">
          {crumb}
        </span>
        <span className="flex-1" />

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
          {/* A key name, not copy: it is the same three characters in every locale. */}
          <kbd
            aria-hidden="true"
            className="flex-none border border-divider px-1.5 font-mono text-2xs tracking-wide"
          >
            CTRL K
          </kbd>
        </button>

        <span className="flex-1" />

        <span data-titlebar-service={serviceStatus} className="flex flex-none items-center">
          <ServiceStatusMarker status={serviceStatus} className={SERVICE_TEXT_CLASS[serviceStatus]} />
        </span>
      </div>

      <div data-window-no-drag className="flex flex-none items-stretch border-l border-divider">
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
          className={CONTROL_CLASS}
        >
          <Minus size={14} strokeWidth={1.5} aria-hidden="true" />
        </button>
        <button
          type="button"
          data-window-control="maximize"
          aria-label={t`最大化或还原窗口`}
          title={t`最大化或还原窗口`}
          onClick={() => void controller.toggleMaximize()}
          className={CONTROL_CLASS}
        >
          <Maximize size={12} strokeWidth={1.5} aria-hidden="true" />
        </button>
        <button
          type="button"
          data-window-control="close"
          aria-label={t`关闭窗口`}
          title={t`关闭窗口`}
          onClick={() => void controller.close()}
          className={cx(CONTROL_CLASS, 'hover:bg-fail hover:text-bg')}
        >
          <X size={14} strokeWidth={1.5} aria-hidden="true" />
        </button>
      </div>
    </header>
  );
}
