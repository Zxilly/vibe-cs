/*
 * `markup` project — the seam between the shell's route table and the pages.
 *
 * `app/router.test.tsx` proves the addresses are right with stand-in pages;
 * this proves the real pages are actually bound to them, which is the half that
 * the layering split (§2.1 rule 3) moved out of that file. Without it a route
 * could resolve to nothing and both suites would still be green.
 */

import { isValidElement } from 'react';
import { matchRoutes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';

import { ROUTE_PATHS } from './app/router';
import { appRoutes, APP_PAGES } from './routes';

const pageRouteIds = [
  'home',
  'library',
  'history',
  'players',
  'player-profile',
  'evidence',
  'match',
  'agent',
  'recording',
  'montage',
  'editor',
  'delivery',
  'delivery-task',
  'settings',
  'recovery',
  'guide',
] as const;

describe('the page bindings', () => {
  it('binds one element per §7 destination', () => {
    const entries = Object.values(APP_PAGES);
    expect(entries).toHaveLength(ROUTE_PATHS.length);
    expect(entries.every((element) => isValidElement(element))).toBe(true);
  });

  it('binds a distinct component to each route — no accidental copy-paste', () => {
    const types = Object.values(APP_PAGES).map((element) =>
      isValidElement(element) ? element.type : null,
    );
    expect(new Set(types).size).toBe(types.length);
  });

  it.each(pageRouteIds)('gives the %s route an element to render', (id) => {
    const route = appRoutes[0]?.children?.find((child) => child.id === id);
    expect(route, id).toBeDefined();
    expect(route?.element, id).toBeDefined();
    expect(route?.element, id).not.toBeNull();
  });

  it('resolves a concrete address all the way down to a page element', () => {
    const matched = matchRoutes(appRoutes, '/match/aurora-vs-meridian')?.at(-1);
    expect(matched?.route.id).toBe('match');
    expect(matched?.route.element).toBe(APP_PAGES.match);
    expect(matched?.params['demoId']).toBe('aurora-vs-meridian');
  });
});
