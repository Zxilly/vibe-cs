/*
 * `markup` project — the §7 route table.
 *
 * Two jobs:
 *   1. every §7 destination resolves, parameters and all
 *   2. the rail and the command palette can still reach what they advertise
 */

import { matchRoutes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';

import { PAGE_COMMANDS } from './command';
import { appRoutes, ROUTE_PATHS, routerMode } from '../routes';
import { SHELL_NAV_ITEMS } from './shell';

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
    expect(ROUTE_PATHS).toHaveLength(13);

    const shell = appRoutes.find((route) => route.id === 'app-shell');
    expect(shell?.children?.some((child) => child.id === 'not-found')).toBe(true);
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
