/*
 * App shell — the frame every route renders inside (spec §10, phase 1).
 *
 * ── The composition ──────────────────────────────────────────────────────
 *
 *   ┌──────────────────────────────────────────────────────────┐
 *   │ WindowTitleBar                       44px  `--h-titlebar` │  flex-none
 *   ├──────────────────────────────────────────────────────────┤
 *   │ ServiceOfflineNotice        only while status === offline │  flex-none
 *   ├──────────┬──────────────────────────────────┬────────────┤
 *   │ SideNav  │ <main> RouteBoundary → Outlet    │ AgentRail  │  flex-1
 *   │ 216 / 56 │ flex-1, min-w-0                  │ 46 / 380   │  min-h-0
 *   └──────────┴──────────────────────────────────┴────────────┘
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
 * ── Decision 3: the Agent rail at ≤1100px ────────────────────────────────
 *
 * `AgentRail.tsx` states this is the container's call. The 1100 × 700 board
 * draws no right column at all, and that is followed literally: below the fold
 * the rail is not rendered. It is not a lost entry point — `SideNav`'s own
 * sparkle item (`agent`, → `/agent`) is in the icon rail with the same badge
 * dot, which is exactly what the artboard draws — so keeping a 46px column
 * whose only remaining gesture is "go to /agent" would put the same control on
 * screen twice and spend the 46px the fold exists to reclaim. The fold's
 * companion rules do the same thing elsewhere: the Inspector becomes a 44px
 * summary, the view nav becomes tabs. Nothing here is hidden without a route.
 */

import { Outlet, useLocation, useNavigate } from 'react-router-dom';

import { useShellCollapsed } from '../design/layout';
import {
  RouteBoundary,
  ServiceGate,
  ServiceOfflineNotice,
  useService,
  type ServiceGateProps,
} from './boundary';
import { CommandPalette, useCommandPalette } from './command';
import { routeCrumb } from './routeCrumb';
import {
  AgentRail,
  RouteBreadcrumb,
  SideNav,
  type DesktopWindowAdapter,
  type ShellNavItemId,
  useShellStore,
  WindowTitleBar,
} from './shell';

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
  /** The health probe `ServiceGate` polls. Defaults to the desktop IPC command. */
  probe?: ServiceGateProps['probe'] | undefined;
  /** Background health polling. Tests turn it off so no timer outlives them. */
  poll?: boolean | undefined;
  /**
   * The rail badges — 「Agent 创作」 and 「任务记录」 in Frame. Empty this round:
   * both counts are server data (phases 3e and 3a).
   */
  badges?: Readonly<Partial<Record<ShellNavItemId, number>>> | undefined;
}

export function AppShell({ collapsed, adapter, probe, poll, badges }: AppShellProps) {
  /* `exactOptionalPropertyTypes`: `ServiceGate` declares `probe?: (…) => …`
     without `| undefined`, so the prop has to be absent rather than undefined. */
  return (
    <ServiceGate
      {...(probe === undefined ? {} : { probe })}
      {...(poll === undefined ? {} : { poll })}
    >
      <ShellFrame collapsed={collapsed} adapter={adapter} badges={badges} />
    </ServiceGate>
  );
}

interface ShellFrameProps {
  collapsed?: boolean | undefined;
  adapter?: DesktopWindowAdapter | null | undefined;
  badges?: Readonly<Partial<Record<ShellNavItemId, number>>> | undefined;
}

/**
 * The frame proper. Split from `AppShell` because the title bar's status dot
 * reads `useService()`, which only resolves *inside* the gate.
 */
function ShellFrame({ collapsed, adapter, badges }: ShellFrameProps) {
  const location = useLocation();
  const navigate = useNavigate();
  const service = useService();
  const palette = useCommandPalette();
  const viewportFolded = useShellCollapsed();
  const storedNavCollapsed = useShellStore((state) => state.navCollapsed);

  const folded = collapsed ?? viewportFolded;
  /* §8 rule 1: below the breakpoint the rail is an icon rail whatever the
     preference says. The title bar's brand block is the same width as the rail,
     so it is told the resolved state rather than re-deriving it. */
  const navCollapsed = storedNavCollapsed || folded;

  const crumb = routeCrumb(location.pathname, location.search);

  const goTo = (to: string) => {
    void navigate(to);
  };

  return (
    <div
      data-app-shell
      data-shell-folded={String(folded)}
      className="flex h-full min-h-0 flex-col overflow-hidden bg-bg text-text"
    >
      <WindowTitleBar
        crumb={<RouteBreadcrumb segments={crumb} />}
        serviceStatus={service.status}
        navCollapsed={navCollapsed}
        adapter={adapter}
        onOpenCommandPalette={palette.openPalette}
      />

      {/* 「重连成功后横幅收起」 falls out of the state: the notice renders null
          while the service answers, so it is mounted unconditionally. */}
      <ServiceOfflineNotice />

      <div data-shell-row className="flex min-h-0 flex-1">
        <SideNav collapsed={navCollapsed} badges={badges} />

        <main
          id="main-content"
          data-shell-main
          className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
        >
          {/* `location.key` changes on every navigation, so leaving a broken
              route is itself the recovery — without it the caught error would
              survive onto the next page. */}
          <RouteBoundary resetKey={location.key} onGoHome={() => goTo('/')}>
            <Outlet />
          </RouteBoundary>
        </main>

        {/* Decision 3: no right column below the fold. `SideNav` keeps the
            Agent entry and its badge. */}
        {folded ? null : <AgentRail />}
      </div>

      <CommandPalette open={palette.open} onClose={palette.closePalette} navigate={goTo} />
    </div>
  );
}
