import { describe, expect, it } from 'vitest';
import { matchRoutes } from 'react-router-dom';

import { appRoutes, routePaths, routerMode } from './router';

describe('application routes', () => {
  it('uses hash navigation so desktop and static-hosted deep links remain local', () => {
    expect(routerMode).toBe('hash');
  });

  it.each(routePaths)('matches the declared route %s', (path) => {
    const matches = matchRoutes(appRoutes, path);
    expect(matches).not.toBeNull();
    expect(matches?.at(-1)?.route.id).not.toBe('not-found');
  });

  it('sends an unknown path to the not-found route', () => {
    const matches = matchRoutes(appRoutes, '/does-not-exist');
    expect(matches?.at(-1)?.route.id).toBe('not-found');
  });
});
