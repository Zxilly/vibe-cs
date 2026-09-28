/** Shared window chrome, mode navigation, route boundaries and task drawer.
 * Project workspaces use the full viewport below the window title bar. */

import { Trans } from '@lingui/react/macro';
import { useEffect, useRef, useState } from 'react';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';

import { ActivityDrawer } from '../domain/task/ActivityDrawer';
import { Toaster } from '../design/feedback';
import { useShellCollapsed } from '../design/layout';
import {
  RouteBoundary,
} from './boundary';
import { buildCommandList, CommandPalette, useCommandPalette, useObjectCommands } from './command';
import { routeCrumb } from './routeCrumb';
import {
  MODE_LANDING_PATH,
  RouteBreadcrumb,
  SideNav,
  type DesktopWindowAdapter,
  type ShellNavItemId,
  useShellStore,
  WindowTitleBar,
  workspaceModeForPath,
} from './shell';
import './routeViewport.css';

export interface AppShellProps {
  /**
   * Pins the §8 fold. Omitted, the shell follows the 1100px media query —
   * which `renderToStaticMarkup` cannot observe, so the `markup` project needs
   * this to render the folded frame at all.
   */
  collapsed?: boolean | undefined;
  /**
   * The desktop window. `undefined` resolves the real one lazily, `null` means
   * "no window" (browser dev server). Tests pass their own.
   */
  adapter?: DesktopWindowAdapter | null | undefined;
  /**
   * The rail badges — 「Agent 创作」 and 「任务记录」 in Frame. Empty this round:
   * both counts are server data (phases 3e and 3a).
   */
  badges?: Readonly<Partial<Record<ShellNavItemId, number>>> | undefined;
}

export function AppShell({ collapsed, adapter, badges }: AppShellProps) {
  const location = useLocation();
  const navigate = useNavigate();
  const palette = useCommandPalette();
  const viewportFolded = useShellCollapsed();
  const storedNavCollapsed = useShellStore((state) => state.navCollapsed);
  const storedMode = useShellStore((state) => state.mode);
  const setMode = useShellStore((state) => state.setMode);
  const [activityOpen, setActivityOpen] = useState(false);
  const [activityUnread, setActivityUnread] = useState(0);
  const [paletteQuery, setPaletteQuery] = useState('');
  const mainRef = useRef<HTMLElement>(null);
  const objectCommands = useObjectCommands(paletteQuery, palette.open);

  const folded = collapsed ?? viewportFolded;
  /* §8 rule 1: below the breakpoint the rail is an icon rail whatever the
     preference says. The title bar's brand block is the same width as the rail,
     so it is told the resolved state rather than re-deriving it. */
  const navCollapsed = storedNavCollapsed || folded;
  const routeMode = workspaceModeForPath(location.pathname, location.search);
  const mode = routeMode ?? storedMode;

  const crumb = routeCrumb(location.pathname, location.search);
  const focusedProject = /^\/projects\/[^/]+$/u.test(location.pathname);

  useEffect(() => {
    if (routeMode === null) return;
    setMode(routeMode);
  }, [routeMode, setMode]);

  /* A link inside the task drawer (查看成品, 打开作品) is a way out of it:
     the drawer closes when the page underneath changes. */
  useEffect(() => {
    setActivityOpen(false);
  }, [location.pathname, location.search]);

  const goTo = (to: string) => {
    void navigate(to);
  };

  const switchMode = (nextMode: typeof mode) => {
    if (nextMode === mode) return;
    setMode(nextMode);
    void navigate(MODE_LANDING_PATH[nextMode]);
  };

  return (
    <div
      data-app-shell
      data-shell-folded={String(folded)}
      className="flex h-full min-h-0 flex-col overflow-hidden bg-bg text-text"
    >
      <a
        href="#main-content"
        onClick={(event) => {
          event.preventDefault();
          mainRef.current?.focus();
        }}
        className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-2 focus:z-50 focus:rounded-md focus:bg-bg focus:px-4 focus:py-2 focus:text-accent-700 focus:shadow-[var(--shadow-md)]"
      >
        <Trans>跳到主要内容</Trans>
      </a>
      <WindowTitleBar
        mode={mode}
        onModeChange={switchMode}
        crumb={<RouteBreadcrumb segments={crumb} />}
        navCollapsed={focusedProject ? false : navCollapsed}
        adapter={adapter}
        onOpenCommandPalette={palette.openPalette}
        onOpenActivity={() => setActivityOpen(true)}
        activityUnreadCount={activityUnread}
      />

      <div data-shell-row className="flex min-h-0 flex-1">
        {focusedProject ? null : <SideNav mode={mode} collapsed={navCollapsed} badges={badges} />}

        <main
          ref={mainRef}
          id="main-content"
          tabIndex={-1}
          data-shell-main
          className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
        >
          {/* `location.key` changes on every navigation, so leaving a broken
              route is itself the recovery — without it the caught error would
              survive onto the next page. */}
          <RouteBoundary resetKey={location.key} onGoHome={() => goTo('/')}>
            <div
              key={location.pathname}
              data-route-viewport
              data-route-path={location.pathname}
              className="flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
            >
              <Outlet />
            </div>
          </RouteBoundary>
        </main>

      </div>

      <CommandPalette
        open={palette.open}
        onClose={palette.closePalette}
        navigate={goTo}
        commands={buildCommandList(objectCommands)}
        onQueryChange={setPaletteQuery}
      />

      <ActivityDrawer
        open={activityOpen}
        onClose={() => setActivityOpen(false)}
        onUnreadChange={setActivityUnread}
      />

      {/* Mounted once, at the shell. What belongs in it and what belongs in an
          `Alert` is settled in `design/feedback/Toast`. */}
      <Toaster />
    </div>
  );
}
