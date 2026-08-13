import { describe, expect, it } from 'vitest';

import {
  analysisTabLayout,
  coreAnalysisTabs,
  secondaryAnalysisTabs,
} from './analysisWorkspaceLayout';

describe('analysis workspace information architecture', () => {
  it('keeps the five frequent evidence workflows in the primary navigation', () => {
    expect(coreAnalysisTabs).toEqual([
      'overview',
      'rounds',
      'players',
      'replay',
      'highlights',
    ]);
  });

  it('retains specialist tools in one bounded secondary group', () => {
    expect(secondaryAnalysisTabs).toEqual([
      'weapons',
      'utility',
      'economy',
      'duels',
      'openings',
      'insights',
      'review',
      'heatmap',
      'cosmetics',
    ]);
  });

  it('only spends horizontal space on the player rail where player context drives the view', () => {
    expect(analysisTabLayout('overview')).toEqual({ group: 'core', showsPlayerRail: true });
    expect(analysisTabLayout('players')).toEqual({ group: 'core', showsPlayerRail: true });
    expect(analysisTabLayout('weapons')).toEqual({ group: 'secondary', showsPlayerRail: false });
    expect(analysisTabLayout('utility')).toEqual({ group: 'secondary', showsPlayerRail: false });
    expect(analysisTabLayout('economy')).toEqual({ group: 'secondary', showsPlayerRail: false });
    expect(analysisTabLayout('duels')).toEqual({ group: 'secondary', showsPlayerRail: false });
    expect(analysisTabLayout('openings')).toEqual({ group: 'secondary', showsPlayerRail: false });
    expect(analysisTabLayout('insights')).toEqual({ group: 'secondary', showsPlayerRail: true });
    expect(analysisTabLayout('review')).toEqual({ group: 'secondary', showsPlayerRail: true });

    expect(analysisTabLayout('rounds').showsPlayerRail).toBe(false);
    expect(analysisTabLayout('replay').showsPlayerRail).toBe(false);
    expect(analysisTabLayout('highlights').showsPlayerRail).toBe(false);
    expect(analysisTabLayout('heatmap').showsPlayerRail).toBe(false);
    expect(analysisTabLayout('cosmetics').showsPlayerRail).toBe(false);
  });
});
