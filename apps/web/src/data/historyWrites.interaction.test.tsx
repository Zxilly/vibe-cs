/*
 * `interaction` project — the match-history reads and the three writes over
 * them, each proved by the query that has to re-run afterwards.
 *
 * The invalidation is the whole contract of these hooks: 「下载」 that does not
 * move the row to 下载中 and does not put a record in 任务记录 looks like a
 * button that did nothing. No real IPC; see `data/test/renderDataHook.tsx`.
 */

import { act, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type { MatchDownloadJob, MatchHistoryItem, Paginated } from '../shared/desktop/dto';
import type { ActivityFeed } from '../shared/desktop/viewModels';
import type { DemoSummary } from '../shared/desktop/viewModels';
import { useDemoList } from './demos';
import {
  useActiveMatchDownloads,
  useCancelMatchDownload,
  useDownloadMatchDemo,
  useMatchHistory,
  useSyncMatchHistory,
  type MatchHistoryClientStub,
} from './history';
import { useTaskFeed } from './tasks';
import { countingStub, renderDataHook } from './test/renderDataHook';

const MATCH: MatchHistoryItem = {
  id: 'mh-1',
  steam_id: 'STEAM_KAEL',
  match_id: 'CSGO-abcde-fghij',
  outcome_id: 'outcome-1',
  token: 1,
  map_name: 'de_mirage',
  played_at: '2026-08-14T20:11:00.000Z',
  score: '13 : 11',
  result: 'win',
  demo_status: 'available',
  demo_id: null,
  last_error: null,
  synced_at: '2026-08-15T08:40:00.000Z',
  updated_at: '2026-08-15T08:40:00.000Z',
};

const PAGE: Paginated<MatchHistoryItem> = { items: [MATCH], total: 1, page: 1, page_size: 50 };

const JOB: MatchDownloadJob = {
  id: 'dl-1',
  match_record_id: 'mh-1',
  status: 'downloading',
  downloaded_bytes: 0,
  total_bytes: null,
  progress: 0,
  demo_id: null,
  error: null,
  error_code: null,
  created_at: '2026-08-15T08:41:00.000Z',
  updated_at: '2026-08-15T08:41:00.000Z',
};

const TASKS: ActivityFeed = {
  items: [],
  total: 0,
  page: 1,
  page_size: 20,
  summary: { total: 0, active: 0, failed: 0, completed: 0, cancelled: 0 },
};

const DEMOS: Paginated<DemoSummary> = { items: [], total: 0, page: 1, page_size: 20 };

const QUERY = { page: 1, page_size: 50 } as const;

describe('useMatchHistory', () => {
  it('passes the page, the size and the abort signal through positionally', async () => {
    const list = countingStub(PAGE);
    const client: MatchHistoryClientStub = { listMatchHistory: list.call };

    const { result } = renderDataHook(() => useMatchHistory({ page: 2, page_size: 50 }), { client });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });
    const [page, pageSize, signal, search] = list.lastArgs();
    expect([page, pageSize, search]).toEqual([2, 50, undefined]);
    expect(signal).toBeInstanceOf(AbortSignal);
  });

  it('sends the search term when the page has one', async () => {
    const list = countingStub(PAGE);
    const client: MatchHistoryClientStub = { listMatchHistory: list.call };

    const { result } = renderDataHook(
      () => useMatchHistory({ page: 1, page_size: 50, search: 'mirage' }),
      { client },
    );

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });
    expect(list.lastArgs()[3]).toBe('mirage');
  });
});

describe('useSyncMatchHistory', () => {
  it('re-runs the match list, and nothing else', async () => {
    const list = countingStub(PAGE);
    const feed = countingStub(TASKS);
    const sync = countingStub({ synced: 4, created: 2, total: 42, cursor_advanced: true });
    const client: MatchHistoryClientStub = {
      listMatchHistory: list.call,
      listActivities: feed.call,
      syncMatchHistory: sync.call,
    };

    const { result } = renderDataHook(
      () => ({
        list: useMatchHistory(QUERY),
        feed: useTaskFeed({}),
        sync: useSyncMatchHistory(),
      }),
      { client },
    );

    await waitFor(() => {
      expect(result.current.list.isSuccess && result.current.feed.isSuccess).toBe(true);
    });
    const listBefore = list.calls();
    const feedBefore = feed.calls();

    await act(async () => {
      const outcome = await result.current.sync.mutateAsync();
      expect(outcome.created).toBe(2);
    });

    await waitFor(() => {
      expect(list.calls()).toBeGreaterThan(listBefore);
    });
    // A sync writes match records only: it starts no job, so the feed must not
    // be swept.
    expect(feed.calls()).toBe(feedBefore);
  });
});

describe('useDownloadMatchDemo', () => {
  it('re-runs the match list, the active downloads and the task feed', async () => {
    const list = countingStub(PAGE);
    const active = countingStub<MatchDownloadJob[]>([]);
    const feed = countingStub(TASKS);
    const demos = countingStub(DEMOS);
    const download = countingStub(JOB);
    const client: MatchHistoryClientStub = {
      listMatchHistory: list.call,
      listActiveMatchDownloadJobs: active.call,
      listActivities: feed.call,
      listDemos: demos.call,
      downloadMatchDemo: download.call,
    };

    const { result } = renderDataHook(
      () => ({
        list: useMatchHistory(QUERY),
        active: useActiveMatchDownloads(),
        feed: useTaskFeed({}),
        demos: useDemoList({}),
        download: useDownloadMatchDemo(),
      }),
      { client },
    );

    await waitFor(() => {
      expect(result.current.list.isSuccess && result.current.feed.isSuccess).toBe(true);
      expect(result.current.active.isSuccess && result.current.demos.isSuccess).toBe(true);
    });
    const before = {
      list: list.calls(),
      active: active.calls(),
      feed: feed.calls(),
      demos: demos.calls(),
    };

    await act(async () => {
      const job = await result.current.download.mutateAsync('CSGO-abcde-fghij');
      expect(job.status).toBe('downloading');
    });

    expect(download.lastArgs()).toEqual(['CSGO-abcde-fghij']);
    await waitFor(() => {
      expect(list.calls()).toBeGreaterThan(before.list);
      expect(active.calls()).toBeGreaterThan(before.active);
      expect(feed.calls()).toBeGreaterThan(before.feed);
    });
    // The library gains a demo when the job *completes*, not when it starts.
    expect(demos.calls()).toBe(before.demos);
  });

  it('says which command is missing rather than throwing undefined is not a function', async () => {
    const { result } = renderDataHook(() => useDownloadMatchDemo(), { client: {} });

    await act(async () => {
      await expect(result.current.mutateAsync('CSGO-1')).rejects.toThrow(/downloadMatchDemo/u);
    });
  });
});

describe('useCancelMatchDownload', () => {
  it('re-runs the same two lists the start did', async () => {
    const list = countingStub(PAGE);
    const feed = countingStub(TASKS);
    const cancel = countingStub({ ...JOB, status: 'cancelled' as const });
    const client: MatchHistoryClientStub = {
      listMatchHistory: list.call,
      listActivities: feed.call,
      cancelMatchDownload: cancel.call,
    };

    const { result } = renderDataHook(
      () => ({
        list: useMatchHistory(QUERY),
        feed: useTaskFeed({}),
        cancel: useCancelMatchDownload(),
      }),
      { client },
    );

    await waitFor(() => {
      expect(result.current.list.isSuccess && result.current.feed.isSuccess).toBe(true);
    });
    const listBefore = list.calls();
    const feedBefore = feed.calls();

    await act(async () => {
      await result.current.cancel.mutateAsync('dl-1');
    });

    expect(cancel.lastArgs()).toEqual(['dl-1']);
    await waitFor(() => {
      expect(list.calls()).toBeGreaterThan(listBefore);
      expect(feed.calls()).toBeGreaterThan(feedBefore);
    });
  });
});
