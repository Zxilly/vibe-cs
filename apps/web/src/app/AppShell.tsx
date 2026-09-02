/*
 * App shell — the frame every route renders inside (spec §10, phase 1).
 *
 * ── The composition ──────────────────────────────────────────────────────
 *
 *   ┌──────────────────────────────────────────────────────────┐
 *   │ WindowTitleBar                       48px  `--h-titlebar` │  flex-none
 *   ├──────────────────────────────────────────────────────────┤
 *   │ ServiceOfflineNotice        only while status === offline │  flex-none
 *   ├──────────┬──────────────────────────────────┬────────────┤
 *   │ SideNav  │ <main> RouteBoundary → Outlet                 │  flex-1
 *   │ 216 / 56 │ flex-1, min-w-0                               │  min-h-0
 *   └──────────┴───────────────────────────────────────────────┘
 *   CommandPalette — fixed, above everything, mounted last
 *
 * Every piece already exists: this file owns the arrangement, the three
 * decisions the artboards left to the container, and nothing else.
 *
 * ── Decision 1: who scrolls ──────────────────────────────────────────────
 *
 * Nobody above the page. `base.css` puts `overflow: hidden` on `body` because
 * the window *is* the viewport; the shell root is `h-full` and every band in it
 * is `flex-none` except the row, which is `flex-1 min-h-0`. `<main>` is
 * `overflow-hidden`, so the scroll boundary is `design/layout/Page`'s
 * `data-page-body` — one scroller per page, and the title bar, rail and Agent
 * column never move. `min-w-0` on `<main>` is what stops a wide table from
 * pushing the Agent rail off the right edge instead of scrolling inside itself.
 *
 * ── Decision 2: the stacking order ───────────────────────────────────────
 *
 * The design layer already spends z-index: sticky table head 10, OverflowMenu
 * and the collapsed rail's flyout 30, Drawer and the folded Inspector 40,
 * Dialog 50. The palette is mounted last in the shell and takes 50 as well, so
 * it sits above a page's Dialog by DOM order — which is right: Ctrl K is a
 * shell-level surface, and its scrim deliberately starts *below* the title bar
 * so the window controls stay usable while it is open. Nothing else in this
 * file positions anything, so the whole shell is one flow layer under those.
 *
 * The former right-edge Agent rail is intentionally absent. Agent remains
 * reachable from SideNav and Ctrl K until its capability moves into projects.
 */

import { useEffect, useState } from 'react';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';

import { ActivityDrawer } from '../ActivityDrawer';
import { Toaster } from '../design/feedback';
import { useShellCollapsed } from '../design/layout';
import {
  RouteBoundary,
} from './boundary';
import { CommandPalette, useCommandPalette } from './command';
import { routeCrumb } from './routeCrumb';
import {
  MODE_LANDING_PATH,
  FirstRunGuide,
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
  return <ShellFrame collapsed={collapsed} adapter={adapter} badges={badges} />;
}

interface ShellFrameProps {
  collapsed?: boolean | undefined;
  adapter?: DesktopWindowAdapter | null | undefined;
  badges?: Readonly<Partial<Record<ShellNavItemId, number>>> | undefined;
}

/**
 * The frame proper.
 */
function ShellFrame({ collapsed, adapter, badges }: ShellFrameProps) {
  const location = useLocation();
  const navigate = useNavigate();
  const palette = useCommandPalette();
  const viewportFolded = useShellCollapsed();
  const storedNavCollapsed = useShellStore((state) => state.navCollapsed);
  const storedMode = useShellStore((state) => state.mode);
  const setMode = useShellStore((state) => state.setMode);
  const onboardingComplete = useShellStore((state) => state.onboardingComplete);
  const completeOnboarding = useShellStore((state) => state.completeOnboarding);
  const [activityOpen, setActivityOpen] = useState(false);
  const [activityUnread, setActivityUnread] = useState(0);

  const folded = collapsed ?? viewportFolded;
  /* §8 rule 1: below the breakpoint the rail is an icon rail whatever the
     preference says. The title bar's brand block is the same width as the rail,
     so it is told the resolved state rather than re-deriving it. */
  const navCollapsed = storedNavCollapsed || folded;
  const routeMode = workspaceModeForPath(location.pathname);
  const mode = routeMode ?? storedMode;

  const crumb = routeCrumb(location.pathname, location.search);
  const focusedProject = /^\/projects\/[^/]+$/u.test(location.pathname);

  useEffect(() => {
    if (routeMode === null) return;
    setMode(routeMode);
  }, [routeMode, setMode]);

  useEffect(() => {
    if (location.pathname !== '/delivery') return;
    if (new URLSearchParams(location.search).get('view') !== 'tasks') return;
    setActivityOpen(true);
    void navigate('/delivery', { replace: true });
  }, [location.pathname, location.search, navigate]);

  const goTo = (to: string) => {
    void navigate(to);
  };

  const switchMode = (nextMode: typeof mode) => {
    if (nextMode === mode) return;
    setMode(nextMode);
    void navigate(MODE_LANDING_PATH[nextMode]);
  };

  const finishOnboarding = (nextMode: typeof mode) => {
    completeOnboarding();
    setMode(nextMode);
    void navigate(MODE_LANDING_PATH[nextMode]);
  };

  return (
    <div
      data-app-shell
      data-shell-folded={String(folded)}
      className="flex h-full min-h-0 flex-col overflow-hidden bg-bg text-text"
    >
      <WindowTitleBar
        compact={focusedProject}
        mode={mode}
        onModeChange={switchMode}
        crumb={focusedProject ? null : <RouteBreadcrumb segments={crumb} />}
        navCollapsed={navCollapsed}
        adapter={adapter}
        onOpenCommandPalette={palette.openPalette}
        onOpenActivity={() => setActivityOpen(true)}
        activityUnreadCount={activityUnread}
      />

      <div data-shell-row className="flex min-h-0 flex-1">
        {focusedProject ? null : <SideNav mode={mode} collapsed={navCollapsed} badges={badges} />}

        <main
          id="main-content"
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

      <CommandPalette open={palette.open} onClose={palette.closePalette} navigate={goTo} />

      <ActivityDrawer
        open={activityOpen}
        onClose={() => setActivityOpen(false)}
        onUnreadChange={setActivityUnread}
      />

      <FirstRunGuide
        open={!onboardingComplete}
        initialMode={mode}
        onChoose={finishOnboarding}
        onDismiss={completeOnboarding}
      />

      {/* Mounted once, at the shell. What belongs in it and what belongs in an
          `Alert` is settled in `design/feedback/Toast`. */}
      <Toaster />
    </div>
  );
}
