import type { ActivityKind } from '../../shared/desktop/dto';

export type ActivityLocator = {
  id: string;
  kind: ActivityKind;
  jobId: string;
};

const locatorPattern = /^(recording|export|download|analysis):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

export function parseActivityLocator(value: string | null): ActivityLocator | null {
  if (value === null) return null;
  const match = locatorPattern.exec(value);
  if (!match) return null;
  return {
    id: value,
    kind: match[1] as ActivityKind,
    jobId: match[2]!,
  };
}

export function activityHref(activityId: string): string {
  return `/activity?${new URLSearchParams({ activity: activityId }).toString()}`;
}

export function withActivitySelection(
  current: URLSearchParams,
  activityId: string,
): URLSearchParams {
  const next = new URLSearchParams(current);
  next.set('activity', activityId);
  return next;
}
