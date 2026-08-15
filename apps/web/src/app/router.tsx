/*
 * App shell — the §7 route table.
 *
 * Fifteen destinations plus a catch-all, all of them children of `AppShell`, so
 * the title bar, the rail, the Agent column and the offline banner are mounted
 * once and survive every navigation. Hash mode is unchanged (§1.1): a desktop
 * webview and a statically hosted build both need deep links that never hit a
 * server.
 *
 * ── Why the pages are handed in ─────────────────────────────────────────
 *
 * §2 sketches this file as `app/routes.tsx` and puts the pages in `pages/**`,
 * but §2.1 rule 3 — the one the lint actually enforces — says 「pages/ 与 app/
 * 之间不得互相 import」. A route table that names its pages breaks it, in the
 * direction the rule cares least about but forbids all the same.
 *
 * So the table stops one step short: it owns the paths, the ids, the redirects,
 * the shell element and the error element, and takes the fifteen page elements
 * as an argument. `src/routes.tsx` — the composition root, which sits above
 * both layers next to `main.tsx` — supplies them. The `RoutePages` interface
 * makes that binding exhaustive, so adding a route here fails to compile until
 * it has a page, and neither layer learns about the other.
 *
 * ── What changed against the pre-redesign 17 routes ─────────────────────
 *
 * Renamed, with a redirect — the address changed, the destination did not:
 *
 *   /analysis?demo=…  → /match/:demoId      §7 promotes the id to a path segment
 *   /outputs          → /delivery?view=outputs
 *   /activity         → /delivery?view=tasks    the two merge into one route
 *   /evidence-search  → /evidence
 *   /match-history    → /history
 *   /queue            → /recording          the old label was already 录制计划
 *   /studio/editor    → /editor
 *
 * Retired, deliberately without one — §7 says 「下线」, and a redirect would
 * quietly promise the feature still exists somewhere:
 *
 *   /production, /studio, /lineups, /prototype/ace-overlay
 *
 * `/lineups` is the interesting one: its content is not gone, it moved *into*
 * the match workspace as `?view=teams`. There is still no redirect, because
 * 「本地五人阵容」 was a global page and `?view=teams` is scoped to one match —
 * sending a bookmark of the former to an arbitrary demo would be a guess.
 * Everything retired lands on `NotFound`, which says the address is gone rather
 * than that something broke.
 *
 * ── The three tables that describe the same thing ───────────────────────
 *
 * This file, `shell/navigation.tsx` (the rail) and `command/commandRegistry.ts`
 * (Ctrl K) each enumerate destinations, for three different reasons: the router
 * needs patterns and elements, the rail needs a Frame-ordered subset with icons,
 * the palette needs search terms. They are not merged, but they are *tied*:
 * `router.test.tsx` runs every rail link and every page command through
 * `matchRoutes` and fails if any of them can no longer be reached. A drift
 * shows up as a red test rather than as a dead link.
 */

import type { ReactNode } from 'react';
import { Navigate, useSearchParams, type RouteObject } from 'react-router-dom';

import { AppShell } from './AppShell';
import { NotFound, RouteErrorElement } from './boundary';

/**
 * One element per §7 destination. Named rather than keyed by path so a typo is
 * a compile error, and exhaustive so a new route cannot ship without a page.
 */
export interface RoutePages {
  readonly home: ReactNode;
  readonly library: ReactNode;
  readonly history: ReactNode;
  readonly players: ReactNode;
  readonly playerProfile: ReactNode;
  readonly evidence: ReactNode;
  readonly match: ReactNode;
  readonly agent: ReactNode;
  readonly recording: ReactNode;
  readonly montage: ReactNode;
  readonly editor: ReactNode;
  readonly delivery: ReactNode;
  readonly deliveryTask: ReactNode;
  readonly settings: ReactNode;
  readonly recovery: ReactNode;
}

/**
 * §7's table, as path patterns. Exported so the route test can walk it and so
 * later phases have one place to read the shape of an address from; the shell
 * itself matches on `location.pathname`, never on this list.
 */
export const ROUTE_PATHS = [
  '/',
  '/library',
  '/history',
  '/players',
  '/players/:playerId',
  '/evidence',
  '/match/:demoId',
  '/agent',
  '/recording/:taskId?',
  '/montage/:projectId?',
  '/editor/:projectId?',
  '/delivery',
  '/delivery/task/:taskId',
  '/settings',
  '/recovery',
] as const;

/**
 * The renamed addresses and where they go. `/analysis` is absent because its
 * target depends on a query parameter — see `LegacyAnalysisRedirect`.
 */
export const LEGACY_REDIRECTS: Readonly<Record<string, string>> = {
  '/outputs': '/delivery?view=outputs',
  '/activity': '/delivery?view=tasks',
  '/evidence-search': '/evidence',
  '/match-history': '/history',
  '/queue': '/recording',
  '/studio/editor': '/editor',
};

/** §7: 「下线」 — no redirect, on purpose. */
export const RETIRED_PATHS = [
  '/production',
  '/studio',
  '/lineups',
  '/prototype/ace-overlay',
] as const;

/**
 * `/analysis?demo=abc` → `/match/abc`. The remaining query is dropped rather
 * than forwarded: the old page addressed its 18 tabs with `?tab=`, the new one
 * addresses 9 views with `?view=`, and §7's merge table is not a rename — two
 * of the old tabs land in `rounds`, one in `highlights`, one in `review`.
 * Carrying a `tab` the workspace does not understand would be worse than
 * opening on 概览, which is the view §7 makes the default anyway.
 *
 * Without a demo id there is nothing to open, so the bookmark goes to the
 * library, which is where a match is chosen.
 */
export function LegacyAnalysisRedirect() {
  const [params] = useSearchParams();
  const demoId = params.get('demo') ?? '';
  const to = demoId === '' ? '/library' : `/match/${encodeURIComponent(demoId)}`;
  return <Navigate to={to} replace />;
}

/* `replace` on every redirect: the old address should not sit in the back
   stack, or Back from the new page bounces straight through it again. */
const legacyRoutes: RouteObject[] = [
  { id: 'legacy-analysis', path: 'analysis', element: <LegacyAnalysisRedirect /> },
  ...Object.entries(LEGACY_REDIRECTS).map(([from, to]) => ({
    id: `legacy${from.replaceAll('/', '-')}`,
    path: from.slice(1),
    element: <Navigate to={to} replace />,
  })),
];

/** The whole tree, with `pages` bound into it. */
export function createAppRoutes(pages: RoutePages): RouteObject[] {
  return [
    {
      id: 'app-shell',
      path: '/',
      element: <AppShell />,
      errorElement: <RouteErrorElement />,
      children: [
        { id: 'home', index: true, element: pages.home },
        { id: 'library', path: 'library', element: pages.library },
        { id: 'history', path: 'history', element: pages.history },
        { id: 'players', path: 'players', element: pages.players },
        { id: 'player-profile', path: 'players/:playerId', element: pages.playerProfile },
        { id: 'evidence', path: 'evidence', element: pages.evidence },
        { id: 'match', path: 'match/:demoId', element: pages.match },
        { id: 'agent', path: 'agent', element: pages.agent },
        { id: 'recording', path: 'recording/:taskId?', element: pages.recording },
        { id: 'montage', path: 'montage/:projectId?', element: pages.montage },
        { id: 'editor', path: 'editor/:projectId?', element: pages.editor },
        /* Declared next to each other on purpose, but the order is not what
           keeps them apart: react-router ranks a static segment above a dynamic
           one, so `/delivery/task/x` can never be swallowed by `/delivery`. */
        { id: 'delivery', path: 'delivery', element: pages.delivery },
        { id: 'delivery-task', path: 'delivery/task/:taskId', element: pages.deliveryTask },
        { id: 'settings', path: 'settings', element: pages.settings },
        { id: 'recovery', path: 'recovery', element: pages.recovery },
        ...legacyRoutes,
        { id: 'not-found', path: '*', element: <NotFound /> },
      ],
    },
  ];
}

export const routerMode = 'hash' as const;
