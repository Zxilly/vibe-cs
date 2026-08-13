import type { DemoRecord, DemoStatus, DemoSummary } from '../../shared/desktop/dto';

export type DemoLifecycleAction = 'start' | 'progress' | 'open' | 'retry' | 'locate';

export type DemoLifecyclePresentation = {
  status: DemoStatus;
  tone: 'neutral' | 'warning' | 'success' | 'danger';
  action: DemoLifecycleAction | null;
  enabled: boolean;
  labelKey: `library.lifecycle.${DemoRecord['status']}.label`;
  descriptionKey: `library.lifecycle.${DemoRecord['status']}.description`;
  actionKey: `library.lifecycle.${DemoLifecycleAction}` | null;
  showMatchSummary: boolean;
};

export function demoLifecyclePresentation(
  lifecycle: DemoRecord['status'],
): DemoLifecyclePresentation {
  const base = {
    labelKey: `library.lifecycle.${lifecycle}.label` as const,
    descriptionKey: `library.lifecycle.${lifecycle}.description` as const,
    showMatchSummary: lifecycle === 'ready',
  };
  switch (lifecycle) {
    case 'discovered':
      return { ...base, status: 'pending', tone: 'neutral', action: 'start', enabled: true, actionKey: 'library.lifecycle.start' };
    case 'indexing':
    case 'analyzing':
      return { ...base, status: 'parsing', tone: 'warning', action: 'progress', enabled: true, actionKey: 'library.lifecycle.progress' };
    case 'ready':
      return { ...base, status: 'ready', tone: 'success', action: 'open', enabled: true, actionKey: 'library.lifecycle.open' };
    case 'failed':
      return { ...base, status: 'error', tone: 'danger', action: 'retry', enabled: true, actionKey: 'library.lifecycle.retry' };
    case 'missing':
      return { ...base, status: 'error', tone: 'danger', action: null, enabled: false, actionKey: null };
  }
}

export function hasVerifiedMatchScore(demo: DemoSummary): boolean {
  return demo.lifecycle_status === 'ready'
    && Boolean(demo.team_a_name && demo.team_b_name)
    && demo.score_team_a !== null
    && demo.score_team_b !== null;
}
