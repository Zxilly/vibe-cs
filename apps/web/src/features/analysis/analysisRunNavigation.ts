import { updateAnalysisNavigation } from './analysisNavigation';

export function persistPrimaryAnalysisRun(
  current: URLSearchParams,
  primaryDemoId: string,
  observedDemoId: string,
  runId: string,
): URLSearchParams {
  if (observedDemoId !== primaryDemoId || current.get('run') === runId) return current;
  const next = new URLSearchParams(current);
  next.set('run', runId);
  return next;
}

export function selectBatchAnalysisDemo(
  current: URLSearchParams,
  demoId: string,
  batchKey: string,
): URLSearchParams {
  const next = updateAnalysisNavigation(current, { round: 1, playerId: null });
  next.set('demo', demoId);
  next.set('demos', batchKey);
  next.delete('run');
  return next;
}
