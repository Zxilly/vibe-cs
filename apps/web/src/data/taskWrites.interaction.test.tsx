/*
 * `interaction` project — the writes phase 3a added to the task surface, and
 * the invalidation each one performs.
 *
 * No real IPC: every client is a stub handed through `DesktopClientProvider`
 * (see `data/test/renderDataHook.tsx`).
 *
 * What is actually being proved here is 「写完之后对应的 query 真的重新跑了」 —
 * the mutation's `onSuccess` names keys from `qk`, and a key named wrongly
 * would leave the read below it unrefetched. So each test mounts the read *and*
 * the write together and counts the reads.
 */

import { act, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type {
  ActivityFeed,
  ActivityItem,
  AnalysisRun,
  AnalysisRunDetail,
  DemoSummary,
  OutputPage,
  Paginated,
  RecordingJob,
} from '../shared/desktop/dto';
import { useDemoList } from './demos';
import { useOutputList } from './outputs';
import {
  activityIsActive,
  feedHasActiveTask,
  useCancelTask,
  useRetryRecordingPlan,
  useRetryTask,
  useTaskFeed,
} from './tasks';
import type { DesktopClientStub } from './desktopClient';
import { countingStub, renderDataHook } from './test/renderDataHook';

const RUNNING: ActivityItem = {
  id: 'recording:job-1',
  kind: 'recording',
  subtype: null,
  job_id: 'job-1',
  context_id: 'demo-1',
  subject: 'Kael_Mirage_1v3',
  status: 'running',
  stage: 'recording.stage.capturing',
  progress_percent: null,
  completed_units: 3,
  total_units: 5,
  unit: 'stages',
  error: null,
  created_at: '2026-08-15T09:05:00.000Z',
  updated_at: '2026-08-15T09:09:00.000Z',
  available_actions: ['cancel'],
};

function feedOf(items: readonly ActivityItem[], active: number): ActivityFeed {
  return {
    items: [...items],
    total: items.length,
    page: 1,
    page_size: 20,
    summary: { total: items.length, active, failed: 0, completed: 0, cancelled: 0 },
  };
}

const OUTPUT_PAGE: OutputPage = { items: [], total: 0, page: 1, page_size: 12, scan_limited: false };
const DEMO_PAGE: Paginated<DemoSummary> = { items: [], total: 0, page: 1, page_size: 20 };

/* The records the cancel and retry commands answer with. Nothing reads them —
   the assertions are about *which* command ran and what it invalidated — but
   the stub is typechecked against the real wire signature, which is the point
   of the seam (`data/test/renderDataHook.tsx`). */
const RECORDING_JOB: RecordingJob = {
  id: 'job-1',
  retry_of: null,
  status: 'cancelled',
  items: [],
  current_index: 0,
  progress: 0.6,
  message: '',
  outputs: [],
  created_at: '2026-08-15T09:05:00.000Z',
  updated_at: '2026-08-15T09:09:00.000Z',
};

const ANALYSIS_RUN: AnalysisRun = {
  id: 'run-1',
  demo_id: 'demo-1',
  input_sha256: null,
  input_size: null,
  status: 'cancelled',
  stage: 'cancelled',
  error: null,
  created_at: '2026-08-15T09:00:00.000Z',
  updated_at: '2026-08-15T09:02:00.000Z',
};

const ANALYSIS_DETAIL: AnalysisRunDetail = {
  run: ANALYSIS_RUN,
  events: [],
  result_available: false,
};

describe('feedHasActiveTask', () => {
  it('is false before anything has loaded — the first fetch is already in flight', () => {
    expect(feedHasActiveTask(undefined)).toBe(false);
  });

  it('reads the summary as well as the page, because a filter can hide the runner', () => {
    expect(feedHasActiveTask(feedOf([], 1))).toBe(true);
    expect(feedHasActiveTask(feedOf([RUNNING], 0))).toBe(true);
    expect(feedHasActiveTask(feedOf([{ ...RUNNING, status: 'completed' }], 0))).toBe(false);
  });

  it('counts every non-terminal status as still moving', () => {
    expect(activityIsActive({ ...RUNNING, status: 'downloading' })).toBe(true);
    expect(activityIsActive({ ...RUNNING, status: 'cancelling' })).toBe(true);
    expect(activityIsActive({ ...RUNNING, status: 'cancelled' })).toBe(false);
  });
});

describe('useCancelTask', () => {
  it('cancels the recording and re-runs the feed that showed it', async () => {
    const feed = countingStub(feedOf([RUNNING], 1));
    const cancel = countingStub(RECORDING_JOB);
    const client: DesktopClientStub = { listActivities: feed.call, cancelRecordingJob: cancel.call };

    const { result } = renderDataHook(
      () => ({ feed: useTaskFeed({ page: 1 }), cancel: useCancelTask() }),
      { client },
    );

    await waitFor(() => {
      expect(result.current.feed.isSuccess).toBe(true);
    });
    const before = feed.calls();

    await act(async () => {
      await result.current.cancel.mutateAsync({ kind: 'recording', jobId: 'job-1' });
    });

    expect(cancel.calls()).toBe(1);
    await waitFor(() => {
      expect(feed.calls()).toBeGreaterThan(before);
    });
  });

  it('also re-runs the output list, because a stopped recording keeps its finished clips', async () => {
    const feed = countingStub(feedOf([RUNNING], 1));
    const outputs = countingStub(OUTPUT_PAGE);
    const cancel = countingStub(RECORDING_JOB);
    const client: DesktopClientStub = {
      listActivities: feed.call,
      listOutputs: outputs.call,
      cancelRecordingJob: cancel.call,
    };

    const { result } = renderDataHook(
      () => ({
        feed: useTaskFeed({ page: 1 }),
        outputs: useOutputList({ page: 1 }),
        cancel: useCancelTask(),
      }),
      { client },
    );

    await waitFor(() => {
      expect(result.current.outputs.isSuccess).toBe(true);
    });
    const before = outputs.calls();

    await act(async () => {
      await result.current.cancel.mutateAsync({ kind: 'recording', jobId: 'job-1' });
    });

    await waitFor(() => {
      expect(outputs.calls()).toBeGreaterThan(before);
    });
  });

  it('re-runs the demo list after an analysis cancel, since the library shows its state', async () => {
    const feed = countingStub(feedOf([], 0));
    const demos = countingStub(DEMO_PAGE);
    const cancel = countingStub(ANALYSIS_DETAIL);
    const client: DesktopClientStub = {
      listActivities: feed.call,
      listDemos: demos.call,
      cancelAnalysisRun: cancel.call,
    };

    const { result } = renderDataHook(
      () => ({
        feed: useTaskFeed({ page: 1 }),
        demos: useDemoList({ page: 1 }),
        cancel: useCancelTask(),
      }),
      { client },
    );

    await waitFor(() => {
      expect(result.current.demos.isSuccess).toBe(true);
    });
    const before = demos.calls();

    await act(async () => {
      await result.current.cancel.mutateAsync({ kind: 'analysis', jobId: 'run-1' });
    });

    expect(cancel.calls()).toBe(1);
    await waitFor(() => {
      expect(demos.calls()).toBeGreaterThan(before);
    });
  });

  it('reports a missing command instead of failing silently', async () => {
    const feed = countingStub(feedOf([RUNNING], 1));
    const { result } = renderDataHook(
      () => ({ feed: useTaskFeed({ page: 1 }), cancel: useCancelTask() }),
      { client: { listActivities: feed.call } },
    );

    await act(async () => {
      await expect(
        result.current.cancel.mutateAsync({ kind: 'export', jobId: 'job-9' }),
      ).rejects.toThrow(/cancelExportJob/u);
    });
  });
});

describe('useRetryTask', () => {
  it('re-runs an analysis against its demo, not against the finished run', async () => {
    const feed = countingStub(feedOf([], 0));
    const start = countingStub(ANALYSIS_RUN);
    const client: DesktopClientStub = { listActivities: feed.call, startAnalysisRun: start.call };

    const { result } = renderDataHook(
      () => ({ feed: useTaskFeed({ page: 1 }), retry: useRetryTask() }),
      { client },
    );

    await waitFor(() => {
      expect(result.current.feed.isSuccess).toBe(true);
    });
    const before = feed.calls();

    await act(async () => {
      await result.current.retry.mutateAsync({
        kind: 'analysis',
        jobId: 'run-1',
        contextId: 'demo-1',
      });
    });

    expect(start.lastArgs()[0]).toBe('demo-1');
    await waitFor(() => {
      expect(feed.calls()).toBeGreaterThan(before);
    });
  });

  it('refuses a record with no source object rather than guessing one', async () => {
    const { result } = renderDataHook(() => useRetryTask(), { client: {} });

    await act(async () => {
      await expect(result.current.mutateAsync({ kind: 'analysis', jobId: 'run-1' })).rejects.toThrow();
    });
  });

  it('will not retry an export, because no command re-runs one', async () => {
    const { result } = renderDataHook(() => useRetryTask(), { client: {} });

    await act(async () => {
      await expect(
        result.current.mutateAsync({ kind: 'export', jobId: 'job-1', contextId: 'project-1' }),
      ).rejects.toThrow();
    });
  });
});

describe('useRetryRecordingPlan', () => {
  it('asks for a plan and invalidates nothing — no task has changed yet', async () => {
    const feed = countingStub(feedOf([], 0));
    const plan = countingStub({
      plan_id: 'plan-7',
      expires_at: '2026-08-15T10:00:00.000Z',
      active_items: 2,
      disabled_items: 0,
      estimated_seconds: 42,
      warnings: [],
      items: [],
      director: { shots: [] },
    });
    const client = {
      listActivities: feed.call,
      planRecordingRetry: plan.call,
    } as unknown as DesktopClientStub;

    const { result } = renderDataHook(
      () => ({ feed: useTaskFeed({ page: 1 }), retry: useRetryRecordingPlan() }),
      { client },
    );

    await waitFor(() => {
      expect(result.current.feed.isSuccess).toBe(true);
    });
    const before = feed.calls();

    await act(async () => {
      const response = await result.current.retry.mutateAsync({ kind: 'recording', jobId: 'job-1' });
      expect(response.plan_id).toBe('plan-7');
    });

    // A refetch here would be a request that cannot return anything different.
    expect(feed.calls()).toBe(before);
  });
});

describe('pollWhileActiveMs', () => {
  /** Several intervals, short enough not to slow the suite. */
  const POLL_MS = 25;
  const QUIET_MS = 140;

  it('keeps asking while something is running', async () => {
    const feed = countingStub(feedOf([RUNNING], 1));
    const { result } = renderDataHook(
      () => useTaskFeed({ page: 1 }, { pollWhileActiveMs: POLL_MS }),
      { client: { listActivities: feed.call } },
    );

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, QUIET_MS));
    });

    expect(feed.calls()).toBeGreaterThan(1);
  });

  it('stops completely once nothing is in flight', async () => {
    const feed = countingStub(feedOf([{ ...RUNNING, status: 'completed' }], 0));
    const { result } = renderDataHook(
      () => useTaskFeed({ page: 1 }, { pollWhileActiveMs: POLL_MS }),
      { client: { listActivities: feed.call } },
    );

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });
    const after = feed.calls();

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, QUIET_MS));
    });

    expect(feed.calls()).toBe(after);
  });
});
