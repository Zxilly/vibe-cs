import { describe, expect, it } from 'vitest';

import { demoLifecyclePresentation, hasVerifiedMatchScore } from './libraryPresentation';

describe('demo lifecycle presentation', () => {
  it.each([
    ['discovered', 'pending', 'start', true],
    ['indexing', 'parsing', 'progress', true],
    ['analyzing', 'parsing', 'progress', true],
    ['ready', 'ready', 'open', true],
    ['failed', 'error', 'retry', true],
    ['missing', 'error', null, false],
  ] as const)('presents %s truthfully', (lifecycle, status, action, enabled) => {
    expect(demoLifecyclePresentation(lifecycle)).toMatchObject({
      status,
      action,
      enabled,
      showMatchSummary: lifecycle === 'ready',
    });
  });
});

describe('library match summary', () => {
  it('hides a ready score until both teams and scores are verified', () => {
    expect(hasVerifiedMatchScore({
      lifecycle_status: 'ready',
      team_a_name: null,
      team_b_name: null,
      score_team_a: null,
      score_team_b: null,
    } as never)).toBe(false);
  });

  it('shows a verified organization score', () => {
    expect(hasVerifiedMatchScore({
      lifecycle_status: 'ready',
      team_a_name: 'FURIA',
      team_b_name: 'Falcons',
      score_team_a: 8,
      score_team_b: 13,
    } as never)).toBe(true);
  });
});
