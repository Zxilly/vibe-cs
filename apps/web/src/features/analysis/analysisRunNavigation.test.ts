import { describe, expect, it } from 'vitest';

import { persistPrimaryAnalysisRun, selectBatchAnalysisDemo } from './analysisRunNavigation';

describe('analysis run navigation', () => {
  it('persists the primary run identity without dropping evidence navigation', () => {
    const current = new URLSearchParams({
      demo: 'demo-1', tab: 'rounds', player: 'steam-1', evidence: 'event-1',
    });
    expect(persistPrimaryAnalysisRun(current, 'demo-1', 'demo-1', 'run-1').toString())
      .toBe('demo=demo-1&tab=rounds&player=steam-1&evidence=event-1&run=run-1');
  });

  it('does not replace the primary route with a secondary batch run', () => {
    const current = new URLSearchParams({ demo: 'demo-1', demos: 'demo-1,demo-2', run: 'run-1' });
    expect(persistPrimaryAnalysisRun(current, 'demo-1', 'demo-2', 'run-2').toString())
      .toBe(current.toString());
  });

  it('drops stale run provenance when switching the selected batch Demo', () => {
    const current = new URLSearchParams({
      demo: 'demo-1', demos: 'demo-1,demo-2', run: 'run-1', tab: 'rounds', round: '7',
      player: 'steam-1', opponent: 'steam-2', tick: '42000', evidence: 'demo:demo-1/event:kill-1',
    });
    expect(selectBatchAnalysisDemo(current, 'demo-2', 'demo-1,demo-2').toString())
      .toBe('demo=demo-2&demos=demo-1%2Cdemo-2&tab=rounds&round=1');
  });
});
