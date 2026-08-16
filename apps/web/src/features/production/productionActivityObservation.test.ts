import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ActivityFeed, ActivityItem } from '../../shared/desktop/viewModels';
import {
  startProductionActivityObservationAfterInitial,
  startProductionActivityObservation,
  type ProductionActivityObservation,
} from './productionActivityObservation';

const jobId = '11111111-1111-4111-8111-111111111111';

function item(status: ActivityItem['status']): ActivityItem {
  return {
    id: `export:${jobId}`,
    kind: 'export',
    subtype: 'editor',
    job_id: jobId,
    context_id: '22222222-2222-4222-8222-222222222222',
    subject: 'C:/exports/exact.mp4',
    status,
    stage: null,
    progress_percent: status === 'completed' ? 100 : 42,
    completed_units: null,
    total_units: null,
    unit: null,
    error: null,
    created_at: '2026-08-13T01:00:00Z',
    updated_at: '2026-08-13T01:01:00Z',
    available_actions: status === 'completed' ? ['open_outputs'] : ['cancel', 'open_outputs'],
  };
}

function feed(status: ActivityItem['status']): ActivityFeed {
  return {
    items: [item(status)],
    total: 1,
    page: 1,
    page_size: 4,
    summary: {
      total: 1,
      active: status === 'running' ? 1 : 0,
      failed: 0,
      completed: status === 'completed' ? 1 : 0,
      cancelled: status === 'cancelled' ? 1 : 0,
    },
  };
}

describe('production activity observation', () => {
  afterEach(() => vi.useRealTimers());

  it('preserves the last-good preview and retries active-feed failures with bounded backoff', async () => {
    vi.useFakeTimers();
    const load = vi.fn()
      .mockRejectedValueOnce(new Error('temporary feed failure'))
      .mockResolvedValueOnce(feed('completed'));
    const snapshots: ProductionActivityObservation[] = [];
    const stop = startProductionActivityObservation({
      initial: feed('running'),
      load,
      onChange: (snapshot) => snapshots.push(snapshot),
    });

    await vi.advanceTimersByTimeAsync(1_500);
    expect(snapshots.at(-1)).toMatchObject({
      feed: { items: [{ status: 'running' }] }, stale: true,
    });
    await vi.advanceTimersByTimeAsync(1_500);
    expect(load).toHaveBeenCalledTimes(2);
    expect(snapshots.at(-1)).toMatchObject({
      feed: { items: [{ status: 'completed' }] }, stale: false, error: null,
    });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(load).toHaveBeenCalledTimes(2);
    stop();
  });

  it('aborts an in-flight preview read on unmount without clearing the last-good rows', async () => {
    vi.useFakeTimers();
    const signal: { current: AbortSignal | null } = { current: null };
    const load = vi.fn((_signal: AbortSignal) => {
      signal.current = _signal;
      return new Promise<ActivityFeed>(() => undefined);
    });
    const snapshots: ProductionActivityObservation[] = [];
    const stop = startProductionActivityObservation({
      initial: feed('running'),
      load,
      onChange: (snapshot) => snapshots.push(snapshot),
    });

    await vi.advanceTimersByTimeAsync(1_500);
    stop();

    expect(signal.current?.aborted).toBe(true);
    expect(snapshots[0]).toMatchObject({ feed: { items: [{ status: 'running' }] } });
  });

  it('does not start polling when an initial feed settles after cleanup', async () => {
    vi.useFakeTimers();
    let resolveInitial!: (value: ActivityFeed) => void;
    const initial = new Promise<ActivityFeed>((resolve) => { resolveInitial = resolve; });
    const load = vi.fn().mockResolvedValue(feed('completed'));
    const onChange = vi.fn();
    const stop = startProductionActivityObservationAfterInitial({
      initial,
      load,
      onChange,
    });

    stop();
    resolveInitial(feed('running'));
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(load).not.toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('waits for the overview commit before observing a newer activity revision', async () => {
    vi.useFakeTimers();
    let resolveOverview!: () => void;
    const overviewCommitted = new Promise<void>((resolve) => { resolveOverview = resolve; });
    const load = vi.fn().mockResolvedValue(feed('completed'));
    const snapshots: ProductionActivityObservation[] = [];
    const stop = startProductionActivityObservationAfterInitial({
      initial: overviewCommitted.then(() => feed('running')),
      load,
      onChange: (snapshot) => snapshots.push(snapshot),
    });

    await vi.advanceTimersByTimeAsync(30_000);
    expect(load).not.toHaveBeenCalled();
    resolveOverview();
    await Promise.resolve();
    await Promise.resolve();
    expect(snapshots.at(-1)).toMatchObject({ feed: { items: [{ status: 'running' }] } });
    await vi.advanceTimersByTimeAsync(1_500);
    expect(snapshots.at(-1)).toMatchObject({ feed: { items: [{ status: 'completed' }] } });
    stop();
  });
});
