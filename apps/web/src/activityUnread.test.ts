import { describe, expect, it } from 'vitest';

import type { ActivityItem } from './shared/desktop/viewModels';
import { activityStatusChanges, activityStatusSnapshot } from './activityUnread';

const item = (id: string, status: ActivityItem['status']): ActivityItem => ({
  id,
  status,
  kind: 'analysis',
  subtype: null,
  job_id: id,
  context_id: null,
  subject: id,
  stage: null,
  progress_percent: null,
  completed_units: null,
  total_units: null,
  unit: null,
  error: null,
  failure: null,
  created_at: '2026-08-20T00:00:00.000Z',
  updated_at: '2026-08-20T00:00:00.000Z',
  available_actions: [],
});

describe('activity unread versions', () => {
  it('uses the first feed as a baseline rather than old unread work', () => {
    expect(activityStatusChanges(null, [item('a', 'running')])).toBe(0);
  });

  it('counts new tasks and status transitions, but not unchanged polling', () => {
    const previous = activityStatusSnapshot([item('a', 'running'), item('b', 'failed')]);
    expect(activityStatusChanges(previous, [item('a', 'completed'), item('b', 'failed'), item('c', 'queued')])).toBe(2);
  });
});
