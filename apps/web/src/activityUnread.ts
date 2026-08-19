import type { ActivityItem } from './shared/desktop/viewModels';

export type ActivityStatusSnapshot = ReadonlyMap<string, ActivityItem['status']>;

export function activityStatusSnapshot(
  items: readonly ActivityItem[],
): ActivityStatusSnapshot {
  return new Map(items.map((item) => [item.id, item.status]));
}

/** New records and status transitions are unread; progress-only polling is not. */
export function activityStatusChanges(
  previous: ActivityStatusSnapshot | null,
  items: readonly ActivityItem[],
): number {
  if (previous === null) return 0;
  return items.reduce(
    (count, item) => count + (previous.get(item.id) === item.status ? 0 : 1),
    0,
  );
}
