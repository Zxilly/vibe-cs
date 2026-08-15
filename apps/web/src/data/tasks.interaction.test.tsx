/**
 * `interaction` project — the unified task surface.
 *
 * No real IPC (see `demos.interaction.test.tsx`). Two things are peculiar to
 * tasks and pinned here:
 *
 *   1. polling is **off** unless the page asks for it — §4.1 sets no interval
 *      and this layer does not invent one;
 *   2. a job record hangs below the activity item it describes, so one
 *      `invalidateTask` refreshes both, while the feed's counters stay put.
 */

import { act, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type { ActivityFeed, ActivityItem, RecordingJob } from '../shared/desktop/dto';
import { dataErrorMessage } from './errors';
import {
  invalidateTask,
  invalidateTasks,
  useRecordingJob,
  useTask,
  useTaskFeed,
} from './tasks';
import { countingStub, renderDataHook } from './test/renderDataHook';

const ITEM: ActivityItem = {
  id: 'recording:job-1',
  kind: 'recording',
  subtype: null,
  job_id: 'job-1',
  context_id: 'demo-a',
  subject: 'Kael 的 1v3',
  status: 'running',
  stage: 'capturing',
  progress_percent: 40,
  completed_units: 2,
  total_units: 5,
  unit: 'stages',
  error: null,
  created_at: '2026-08-15T09:00:00Z',
  updated_at: '2026-08-15T09:04:00Z',
  available_actions: ['cancel'],
};

const FEED: ActivityFeed = {
  items: [ITEM],
  total: 1,
  page: 1,
  page_size: 20,
  summary: { total: 1, active: 1, failed: 0, completed: 0, cancelled: 0 },
};

const JOB: RecordingJob = {
  id: 'job-1',
  retry_of: null,
  status: 'running',
  items: [],
  current_index: 0,
  progress: 0.4,
  message: '正在采集',
  outputs: [],
  created_at: '2026-08-15T09:00:00Z',
  updated_at: '2026-08-15T09:04:00Z',
};

/** Long enough for several intervals, short enough not to slow the suite. */
const QUIET_MS = 80;

describe('useTaskFeed', () => {
  it('returns the items and the summary counters', async () => {
    const feed = countingStub(FEED);
    const { result } = renderDataHook(() => useTaskFeed({ state: 'active' }), {
      client: { listActivities: feed.call },
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });
    expect(result.current.data?.summary.active).toBe(1);
    expect(feed.lastArgs()[0]).toEqual({ state: 'active' });
  });

  it('does not poll unless the page asks', async () => {
    const feed = countingStub(FEED);
    const { result } = renderDataHook(() => useTaskFeed({}), {
      client: { listActivities: feed.call },
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });
    await new Promise((resolve) => {
      setTimeout(resolve, QUIET_MS);
    });

    // §4.1 has no refetch interval, and a task list that polled by default
    // would fire IPC on every page that happens to mount it.
    expect(feed.calls()).toBe(1);
  });

  it('polls when the page asks, and stops when the page goes away', async () => {
    const feed = countingStub(FEED);
    const { result, unmount } = renderDataHook(() => useTaskFeed({}, { pollMs: 20 }), {
      client: { listActivities: feed.call },
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });
    await waitFor(() => {
      expect(feed.calls()).toBeGreaterThanOrEqual(2);
    });

    unmount();
    const afterUnmount = feed.calls();
    await new Promise((resolve) => {
      setTimeout(resolve, QUIET_MS);
    });
    expect(feed.calls()).toBe(afterUnmount);
  });

  it('renders a failure rather than an empty task list', async () => {
    const feed = countingStub(FEED);
    feed.fail(new Error('活动记录不可用'));

    const { result } = renderDataHook(() => useTaskFeed({}), {
      client: { listActivities: feed.call },
    });

    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });
    expect(dataErrorMessage(result.current.error)).toBe('活动记录不可用');
    expect(feed.calls()).toBe(1);
  });
});

describe('useTask + useRecordingJob', () => {
  it('needs both halves of the locator before it calls the bridge', () => {
    const activity = countingStub(ITEM);
    const { result } = renderDataHook(() => useTask('recording', null), {
      client: { getActivity: activity.call },
    });

    expect(result.current.fetchStatus).toBe('idle');
    expect(activity.calls()).toBe(0);
  });

  it('passes kind and id in that order', async () => {
    const activity = countingStub(ITEM);
    const { result } = renderDataHook(() => useTask('recording', 'job-1'), {
      client: { getActivity: activity.call },
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });
    expect(activity.lastArgs().slice(0, 2)).toEqual(['recording', 'job-1']);
  });

  it('invalidateTask refreshes the activity row and its job, not the feed', async () => {
    const activity = countingStub(ITEM);
    const job = countingStub(JOB);
    const feed = countingStub(FEED);

    const { result, queryClient } = renderDataHook(
      () => ({
        task: useTask('recording', 'job-1'),
        job: useRecordingJob('job-1'),
        feed: useTaskFeed({}),
      }),
      {
        client: {
          getActivity: activity.call,
          getRecordingJob: job.call,
          listActivities: feed.call,
        },
      },
    );

    await waitFor(() => {
      expect(result.current.task.isSuccess).toBe(true);
      expect(result.current.job.isSuccess).toBe(true);
      expect(result.current.feed.isSuccess).toBe(true);
    });

    await act(async () => {
      await invalidateTask(queryClient, 'recording', 'job-1');
    });

    await waitFor(() => {
      expect(activity.calls()).toBe(2);
      expect(job.calls()).toBe(2);
    });
    expect(feed.calls()).toBe(1);
  });

  it('invalidateTasks sweeps the feed too — the counters move as well', async () => {
    const job = countingStub(JOB);
    const feed = countingStub(FEED);

    const { result, queryClient } = renderDataHook(
      () => ({ job: useRecordingJob('job-1'), feed: useTaskFeed({}) }),
      { client: { getRecordingJob: job.call, listActivities: feed.call } },
    );

    await waitFor(() => {
      expect(result.current.job.isSuccess).toBe(true);
      expect(result.current.feed.isSuccess).toBe(true);
    });

    await act(async () => {
      await invalidateTasks(queryClient);
    });

    await waitFor(() => {
      expect(job.calls()).toBe(2);
      expect(feed.calls()).toBe(2);
    });
  });
});
