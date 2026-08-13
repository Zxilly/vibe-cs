import type { ActivityAction, ActivityItem, ActivityKind } from '../../shared/desktop/dto';

export type ActivityStateFilter = '' | 'active' | 'failed' | 'completed';
export type ActivityFilters = {
  query: string;
  kind: ActivityKind | '';
  state: ActivityStateFilter;
};

const terminalStatuses = new Set<ActivityItem['status']>([
  'completed', 'failed', 'cancelled',
]);

export function isActivityActive(item: ActivityItem): boolean {
  return !terminalStatuses.has(item.status);
}

export function activityProgressLabel(item: ActivityItem): string | null {
  if (item.progress_percent === null) return null;
  return `${Math.max(0, Math.min(100, Math.round(item.progress_percent)))}%`;
}

export function activityUnitLabel(item: ActivityItem): string | null {
  if (item.completed_units === null) return null;
  if (item.unit === 'stages' && item.total_units !== null) {
    return `${item.completed_units} / ${item.total_units}`;
  }
  if (item.unit !== 'bytes') return null;
  const formatter = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 });
  const complete = `${formatter.format(item.completed_units)} B`;
  return item.total_units === null ? complete : `${complete} / ${formatter.format(item.total_units)} B`;
}

export function activityActionHref(item: ActivityItem, action: ActivityAction): string | null {
  if (action === 'open_analysis' && item.context_id) {
    const parameters = new URLSearchParams({ demo: item.context_id });
    if (item.kind === 'analysis' && item.job_id) parameters.set('run', item.job_id);
    return `/analysis?${parameters.toString()}`;
  }
  if (action === 'open_library') return '/library';
  if (action === 'open_match_history') return '/match-history';
  if (action === 'open_outputs') return '/outputs';
  return null;
}

export function filterActivities(items: ActivityItem[], filters: ActivityFilters): ActivityItem[] {
  const query = filters.query.trim().toLocaleLowerCase();
  return items.filter((item) => {
    if (filters.kind && item.kind !== filters.kind) return false;
    if (filters.state === 'active' && !isActivityActive(item)) return false;
    if (filters.state === 'failed' && item.status !== 'failed') return false;
    if (filters.state === 'completed' && item.status !== 'completed') return false;
    if (!query) return true;
    return [
      item.id,
      item.job_id,
      item.context_id,
      item.subject,
      item.subtype,
      item.status,
      item.stage,
      item.error,
    ].some((value) => value?.toLocaleLowerCase().includes(query));
  });
}
