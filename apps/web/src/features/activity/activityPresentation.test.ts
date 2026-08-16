import { describe, expect, it } from 'vitest';

import type { ActivityItem } from '../../shared/desktop/viewModels';
import {
  activityActionHref,
  activityProgressLabel,
  activityStateFilterOptions,
  activityUnitLabel,
  filterActivities,
} from './activityPresentation';

const activity = (overrides: Partial<ActivityItem>): ActivityItem => ({
  id: 'recording:job-1',
  kind: 'recording',
  subtype: null,
  job_id: 'job-1',
  context_id: 'demo-1',
  subject: 'FalleN R20 4K',
  status: 'running',
  stage: null,
  progress_percent: 42,
  completed_units: null,
  total_units: null,
  unit: null,
  error: null,
  failure: null,
  created_at: '2026-08-13T01:00:00Z',
  updated_at: '2026-08-13T01:01:00Z',
  available_actions: ['cancel', 'open_outputs'],
  ...overrides,
});

describe('activity presentation', () => {
  it('offers cancelled as its own server-backed state filter', () => {
    expect(activityStateFilterOptions.map((option) => option.value))
      .toEqual(['active', 'failed', 'completed', 'cancelled']);
  });

  it('filters the persisted feed by kind, state bucket, and searchable identifiers', () => {
    const items = [
      activity({}),
      activity({
        id: 'analysis:run-2', kind: 'analysis', job_id: 'run-2', context_id: 'demo-2',
        subject: 'Major M1', status: 'failed', stage: 'interrupted', error: null,
      }),
      activity({
        id: 'download:job-3', kind: 'download', job_id: 'job-3',
        context_id: '7656119:42', subject: '7656119:42', status: 'completed',
      }),
      activity({
        id: 'analysis:run-4', kind: 'analysis', job_id: 'run-4', context_id: 'demo-4',
        subject: 'Major cancelled', status: 'cancelled', stage: 'cancelled', error: null,
        available_actions: ['retry_analysis', 'open_library'],
      }),
    ];

    expect(filterActivities(items, { query: 'demo-2', kind: 'analysis', state: 'failed' }))
      .toEqual([items[1]]);
    expect(filterActivities(items, { query: '', kind: '', state: 'active' }))
      .toEqual([items[0]]);
    expect(filterActivities(items, { query: '', kind: 'analysis', state: 'cancelled' }))
      .toEqual([items[3]]);
  });

  it('renders a percentage only when the aggregate supplies one', () => {
    expect(activityProgressLabel(activity({ progress_percent: 43 }))).toBe('43%');
    expect(activityProgressLabel(activity({ kind: 'analysis', status: 'analyzing', progress_percent: null })))
      .toBeNull();
  });

  it('renders recording milestones as stage ordinals rather than percentages', () => {
    const recording = activity({
      stage: 'recording.stage.capturing',
      progress_percent: null,
      completed_units: 3,
      total_units: 5,
      unit: 'stages',
    });

    expect(activityProgressLabel(recording)).toBeNull();
    expect(activityUnitLabel(recording)).toBe('3 / 5');
  });

  it('opens completed analysis at its persisted demo and keeps mutations command-driven', () => {
    const analyzed = activity({
      id: 'analysis:run/2', kind: 'analysis', job_id: 'run/2', context_id: 'demo/2',
      status: 'completed', available_actions: ['open_analysis', 'open_library'],
    });

    expect(activityActionHref(analyzed, 'open_analysis')).toBe('/analysis?demo=demo%2F2&run=run%2F2');
    expect(activityActionHref(analyzed, 'open_library')).toBe('/library');
    expect(activityActionHref(analyzed, 'retry_analysis')).toBeNull();
  });
});
