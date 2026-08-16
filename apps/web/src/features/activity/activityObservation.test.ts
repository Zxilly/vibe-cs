import { afterEach, describe, expect, it, vi } from 'vitest';

import { DesktopError } from '../../shared/desktop/client';
import type { ActivityItem } from '../../shared/desktop/viewModels';
import { startActivityObservation, type ActivityObservation } from './activityObservation';

const jobId = '11111111-1111-4111-8111-111111111111';

const activity = (status: ActivityItem['status']): ActivityItem => ({
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
  failure: null,
  created_at: '2026-08-13T01:00:00Z',
  updated_at: '2026-08-13T01:01:00Z',
  available_actions: status === 'completed' ? ['open_outputs'] : ['cancel', 'open_outputs'],
});

describe('exact activity observation', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('preserves last-good truth and retries transient detail failures with bounded backoff', async () => {
    vi.useFakeTimers();
    const load = vi.fn()
      .mockResolvedValueOnce(activity('running'))
      .mockRejectedValueOnce(new Error('temporary read failure'))
      .mockResolvedValueOnce(activity('completed'));
    const snapshots: ActivityObservation[] = [];
    const stop = startActivityObservation({
      locator: { id: `export:${jobId}`, kind: 'export', jobId },
      load,
      onChange: (snapshot) => snapshots.push(snapshot),
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(load).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_500);
    expect(snapshots.at(-1)).toMatchObject({
      item: { status: 'running' }, stale: true, unavailable: false,
    });
    await vi.advanceTimersByTimeAsync(1_499);
    expect(load).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(load).toHaveBeenCalledTimes(3);
    expect(snapshots.at(-1)).toMatchObject({
      item: { status: 'completed' }, stale: false, error: null, unavailable: false,
    });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(load).toHaveBeenCalledTimes(3);
    stop();
  });

  it('surfaces exact 404 as unavailable without polling or falling back', async () => {
    vi.useFakeTimers();
    const load = vi.fn().mockRejectedValue(new DesktopError('missing exact job', 404, 'not_found'));
    const snapshots: ActivityObservation[] = [];
    const stop = startActivityObservation({
      locator: { id: `export:${jobId}`, kind: 'export', jobId },
      load,
      onChange: (snapshot) => snapshots.push(snapshot),
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(snapshots.at(-1)).toMatchObject({
      item: null, loading: false, stale: false, unavailable: true,
    });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(load).toHaveBeenCalledOnce();
    stop();
  });

  it('fails closed when an adapter returns a different self-consistent activity', async () => {
    vi.useFakeTimers();
    const otherId = '33333333-3333-4333-8333-333333333333';
    const load = vi.fn().mockResolvedValue({
      ...activity('completed'), id: `export:${otherId}`, job_id: otherId,
    });
    const snapshots: ActivityObservation[] = [];
    const stop = startActivityObservation({
      locator: { id: `export:${jobId}`, kind: 'export', jobId },
      load,
      onChange: (snapshot) => snapshots.push(snapshot),
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(snapshots.at(-1)).toMatchObject({ item: null, loading: false, stale: false });
    expect(snapshots.some((snapshot) => snapshot.item?.job_id === otherId)).toBe(false);
    stop();
  });

  it('aborts a superseded exact read and ignores its late result', async () => {
    let resolve!: (item: ActivityItem) => void;
    const observedSignal: { current: AbortSignal | null } = { current: null };
    const load = vi.fn((_kind, _id, signal: AbortSignal) => {
      observedSignal.current = signal;
      return new Promise<ActivityItem>((done) => { resolve = done; });
    });
    const snapshots: ActivityObservation[] = [];
    const stop = startActivityObservation({
      locator: { id: `export:${jobId}`, kind: 'export', jobId },
      load,
      onChange: (snapshot) => snapshots.push(snapshot),
    });

    stop();
    expect(observedSignal.current?.aborted).toBe(true);
    resolve(activity('completed'));
    await Promise.resolve();
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]).toMatchObject({ item: null, loading: true });
  });
});
