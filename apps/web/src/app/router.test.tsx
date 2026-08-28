/*
 * `markup` project — the §7 route table.
 *
 * Three jobs:
 *   1. every §7 destination resolves, parameters and all
 *   2. every renamed address still lands somewhere, and every retired one
 *      honestly does not
 *   3. the rail and the command palette can still reach what they advertise —
 *      the tie that keeps three tables from drifting apart (see router.tsx)
 */

import { matchRoutes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';

import { PAGE_COMMANDS } from './command';
import {
  createAppRoutes,
  LEGACY_REDIRECTS,
  RETIRED_PATHS,
  ROUTE_PATHS,
  routerMode,
  type RoutePages,
} from './router';
import { SHELL_NAV_ITEMS } from './shell';

/*
 * The table is asserted with stand-in pages: what this file is about is the
 * shape of the addresses, and `app/**` cannot import `pages/**` anyway (§2.1
 * rule 3 — see router.tsx). `src/routes.test.tsx` covers the real bindings.
 */
const STUB_PAGES: RoutePages = {
  home: <span data-stub="home" />,
  library: <span data-stub="library" />,
  players: <span data-stub="players" />,
  playerProfile: <span data-stub="player-profile" />,
  evidence: <span data-stub="evidence" />,
  match: <span data-stub="match" />,
  projects: <span data-stub="projects" />,
  projectWorkspace: <span data-stub="project-workspace" />,
  delivery: <span data-stub="delivery" />,
  deliveryTask: <span data-stub="delivery-task" />,
  settings: <span data-stub="settings" />,
  recovery: <span data-stub="recovery" />,
  guide: <span data-stub="guide" />,
};

const appRoutes = createAppRoutes(STUB_PAGES);

/** `/players/:playerId` → `/players/sample`; `/recording/:taskId?` → `/recording/sample`. */
function withSampleParams(pattern: string): string {
  return pattern.replaceAll(/:[A-Za-z]+\??/gu, 'sample');
}

/** `/delivery?view=tasks` → `/delivery`; `matchRoutes` takes a path, not a URL. */
function pathOnly(to: string): string {
  return to.split('?')[0] ?? to;
}

function routeIdFor(path: string): string | undefined {
  return matchRoutes(appRoutes, path)?.at(-1)?.route.id;
}

describe('application routes', () => {
  it('uses hash navigation so desktop and static-hosted deep links stay local', () => {
    expect(routerMode).toBe('hash');
  });

  it('declares the current destinations and one catch-all inside the shell', () => {
    expect(ROUTE_PATHS).toHaveLength(14);

    const shell = appRoutes.find((route) => route.id === 'app-shell');
    expect(shell?.children?.some((child) => child.id === 'not-found')).toBe(true);
    // Nothing renders outside the shell — the pre-redesign tree had the ace
    // overlay prototype as a sibling, and §7 retires it.
    expect(appRoutes).toHaveLength(1);
  });

  it.each(ROUTE_PATHS)('matches the declared route %s', (pattern) => {
    const path = withSampleParams(pattern);
    const matches = matchRoutes(appRoutes, path);

    expect(matches, path).not.toBeNull();
    expect(matches?.at(-1)?.route.id, path).not.toBe('not-found');
  });

  it('keeps the task detail out of the delivery route despite the shared prefix', () => {
    expect(routeIdFor('/delivery')).toBe('delivery');
    expect(routeIdFor('/delivery/task/t-42')).toBe('delivery-task');
  });

  it('gives every §7 route its own id, so a match can be identified', () => {
    const ids = (appRoutes[0]?.children ?? []).map((child) => child.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('sends an unknown path to the not-found route', () => {
    expect(routeIdFor('/does-not-exist')).toBe('not-found');
  });
});

describe('routes that changed name', () => {
  it.each(Object.keys(LEGACY_REDIRECTS))('still resolves the retired address %s', (from) => {
    expect(routeIdFor(from), from).not.toBe('not-found');
  });

  it.each(Object.entries(LEGACY_REDIRECTS))('points %s at a live route (%s)', (_from, to) => {
    expect(routeIdFor(pathOnly(to)), to).not.toBe('not-found');
  });

  it('redirects the demo-scoped analysis page, which needs its query read', () => {
    expect(routeIdFor('/analysis')).toBe('legacy-analysis');
  });
});

describe('routes §7 retires without a redirect', () => {
  it.each(RETIRED_PATHS)('lets %s fall through to 找不到这个页面', (path) => {
    expect(routeIdFor(path), path).toBe('not-found');
  });

  it('does not quietly redirect them anywhere', () => {
    for (const path of RETIRED_PATHS) {
      expect(Object.keys(LEGACY_REDIRECTS)).not.toContain(path);
    }
  });
});

describe('the other two tables still reach what they advertise', () => {
  it.each(SHELL_NAV_ITEMS.map((item) => item.to))('resolves the rail link %s', (to) => {
    expect(routeIdFor(pathOnly(to)), to).not.toBe('not-found');
  });

  it.each(PAGE_COMMANDS.map((command) => command.id))('resolves the command %s', (id) => {
    const command = PAGE_COMMANDS.find((entry) => entry.id === id);
    let target = '';
    command?.run({
      navigate: (to) => {
        target = to;
      },
    });

    expect(target, id).not.toBe('');
    expect(routeIdFor(pathOnly(target)), `${id} → ${target}`).not.toBe('not-found');
  });
});
