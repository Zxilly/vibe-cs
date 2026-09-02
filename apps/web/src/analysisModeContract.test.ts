import { describe, expect, it } from 'vitest';

import { PAGE_COMMANDS } from './app/command/commandRegistry';
import { ROUTE_PATHS } from './routes';
import { shellNavGroups } from './app/shell/navigation';
import { MATCH_VIEW_IDS } from './pages/match/viewContract';

describe('analysis mode capability contract', () => {
  it('keeps the three cross-match analysis destinations in the mode rail', () => {
    expect(
      shellNavGroups('analysis').flatMap((group) => group.items).map((item) => item.id),
    ).toEqual(['library', 'players', 'evidence']);
  });

  it('keeps every analysis destination and detail workspace routable', () => {
    for (const path of ['/library', '/players', '/players/:playerId', '/evidence', '/match/:demoId']) {
      expect(ROUTE_PATHS).toContain(path);
    }
  });

  it('keeps analysis destinations keyboard-reachable through Ctrl K', () => {
    const ids = PAGE_COMMANDS.map((command) => command.id);
    for (const id of ['page.library', 'page.history', 'page.players', 'page.evidence']) {
      expect(ids).toContain(id);
    }
  });

  it('keeps all nine single-match analysis views', () => {
    expect(MATCH_VIEW_IDS).toEqual([
      'overview',
      'rounds',
      'players',
      'duels',
      'utility',
      'replay',
      'highlights',
      'review',
      'teams',
    ]);
  });
});
