import type { AnalysisTab } from './analysisNavigation';

export const coreAnalysisTabs = [
  'overview',
  'rounds',
  'players',
  'replay',
  'highlights',
] as const satisfies readonly AnalysisTab[];

export const secondaryAnalysisTabs = [
  'weapons',
  'utility',
  'economy',
  'duels',
  'openings',
  'teams',
  'clutches',
  'insights',
  'review',
  'heatmap',
  'cosmetics',
] as const satisfies readonly AnalysisTab[];

const playerContextTabs = new Set<AnalysisTab>([
  'overview',
  'players',
  'insights',
  'review',
]);

export function analysisTabLayout(tab: AnalysisTab): {
  group: 'core' | 'secondary';
  showsPlayerRail: boolean;
} {
  return {
    group: (coreAnalysisTabs as readonly AnalysisTab[]).includes(tab) ? 'core' : 'secondary',
    showsPlayerRail: playerContextTabs.has(tab),
  };
}
