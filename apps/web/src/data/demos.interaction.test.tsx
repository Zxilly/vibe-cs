/**
 * `interaction` project — the Demo library reads.
 *
 * **No real IPC.** vitest has no Tauri host, so the bridge arrives through
 * `DesktopClientProvider` as a hand-written stub that is typechecked against
 * `DesktopClient` — a stub whose signature drifts from the wire fails the build
 * rather than passing a green test over a fiction.
 *
 * This file carries the full contract for the layer (success, failure,
 * invalidation, the disabled read, the forwarded abort signal); the other
 * domain files assert their own shapes against it rather than repeating it.
 */

import { useQuery } from '@tanstack/react-query';
import { act, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { DesktopError } from '../shared/desktop/client';
import type { DemoSummary, Paginated, ScanResult } from '../shared/desktop/dto';
import {
  invalidateDemo,
  invalidateDemos,
  useDeleteDemos,
  useDemo,
  useDemoList,
  useImportDemoFiles,
  useLaunchDemoPlayback,
  useReviewTags,
  useStartDemoAnalysis,
  useUpdateDemo,
} from './demos';
import { useRuntimeState, useStorageStatus } from './config';
import { dataErrorMessage, toDataError } from './errors';
import { qk } from './keys';
import { countingStub, renderDataHook } from './test/renderDataHook';

const DEMO: DemoSummary = {
  id: 'demo-a',
  path: 'C:/demos/aurora.dem',
  filename: 'aurora.dem',
  display_name: 'Aurora vs Meridian',
  map_name: 'de_mirage',
  match_date: '2026-08-01T18:00:00Z',
  cataloged_at: '2026-08-01T19:00:00Z',
  duration_seconds: 2_400,
  total_rounds: 24,
  score_team_a: 13,
  score_team_b: 11,
  team_a_name: 'Aurora',
  team_b_name: 'Meridian',
  status: 'ready',
  lifecycle_status: 'ready',
  players: ['Kael'],
  source: 'local',
  remark: '',
  updated_at: '2026-08-01T19:00:00Z',
};

function page(items: DemoSummary[]): Paginated<DemoSummary> {
  return { items, total: items.length, page: 1, page_size: 20 };
}

describe('useDemoList', () => {
  it('resolves the page the bridge returned', async () => {
    const list = countingStub(page([DEMO]));
    const { result } = renderDataHook(() => useDemoList({}), { client: { listDemos: list.call } });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });
    expect(result.current.data?.items[0]?.display_name).toBe('Aurora vs Meridian');
    expect(list.calls()).toBe(1);
  });

  it('passes the filter through and forwards the abort signal', async () => {
    const list = countingStub(page([]));
    const { result } = renderDataHook(() => useDemoList({ search: 'aurora', page: 2 }), {
      client: { listDemos: list.call },
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });
    expect(list.lastArgs()[0]).toEqual({ search: 'aurora', page: 2 });
    // The second argument is TanStack's own AbortSignal: an unmounted list
    // must not keep an IPC round-trip alive.
    expect(list.lastArgs()[1]).toBeInstanceOf(AbortSignal);
  });

  it('surfaces a failure in a shape the UI can render, without retrying', async () => {
    const list = countingStub(page([]));
    list.fail(new DesktopError('本地服务未连接', 0, 'DESKTOP_COMMAND_FAILED'));

    const { result } = renderDataHook(() => useDemoList({}), { client: { listDemos: list.call } });

    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });
    // §4.1 `throwOnError: false` — the error stays on the query so the page can
    // render it as a Notice instead of losing the route to an ErrorBoundary.
    expect(dataErrorMessage(result.current.error)).toBe('本地服务未连接');
    expect(toDataError(result.current.error, '读取失败')).toEqual({
      message: '本地服务未连接',
      status: 0,
      code: 'DESKTOP_COMMAND_FAILED',
    });
    // §4.1 `retry: false` — a deterministic IPC failure is not retried.
    expect(list.calls()).toBe(1);
  });

  it('runs the queryFn again after invalidateDemos, and the new page reaches the caller', async () => {
    const list = countingStub(page([DEMO]));
    const { result, queryClient } = renderDataHook(() => useDemoList({}), {
      client: { listDemos: list.call },
    });

    // Reading `data` here is not decoration: TanStack only re-renders on the
    // result properties the caller has actually touched, so a test that never
    // reads `data` would not be notified when it changes.
    await waitFor(() => {
      expect(result.current.data?.items).toHaveLength(1);
    });
    expect(list.calls()).toBe(1);

    list.succeed(page([DEMO, { ...DEMO, id: 'demo-b', display_name: 'Nova vs Pulse' }]));
    await act(async () => {
      await invalidateDemos(queryClient);
    });

    expect(list.calls()).toBe(2);
    await waitFor(() => {
      expect(result.current.data?.items).toHaveLength(2);
    });
    expect(queryClient.getQueryData(qk.demos.list({}))).toEqual(result.current.data);
  });

  it('is not re-run by an invalidation aimed at one demo', async () => {
    const list = countingStub(page([DEMO]));
    const { result, queryClient } = renderDataHook(() => useDemoList({}), {
      client: { listDemos: list.call },
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    await act(async () => {
      await invalidateDemo(queryClient, 'demo-a');
    });

    // `['demos','detail','demo-a']` is not a prefix of `['demos','list',{}]`.
    expect(list.calls()).toBe(1);
  });
});

describe('useDemo', () => {
  it('reads one demo and caches it under its own key', async () => {
    const detail = countingStub(DEMO);
    const { result, queryClient } = renderDataHook(() => useDemo('demo-a'), {
      client: { getDemo: detail.call },
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });
    expect(detail.lastArgs()[0]).toBe('demo-a');
    expect(queryClient.getQueryData(qk.demos.detail('demo-a'))).toEqual(DEMO);
  });

  it('does not call the bridge while nothing is selected', async () => {
    const detail = countingStub(DEMO);
    const { result, rerender } = renderDataHook(() => useDemo(null), {
      client: { getDemo: detail.call },
    });

    // 「未选中」 is a state, not a loading state: no request, and nothing
    // pending for a page to render a spinner over.
    expect(result.current.fetchStatus).toBe('idle');
    expect(detail.calls()).toBe(0);
    rerender();
    expect(detail.calls()).toBe(0);
  });

  it('honours an explicit enabled:false from the caller', async () => {
    const detail = countingStub(DEMO);
    const { result } = renderDataHook(() => useDemo('demo-a', { enabled: false }), {
      client: { getDemo: detail.call },
    });

    expect(result.current.fetchStatus).toBe('idle');
    expect(detail.calls()).toBe(0);
  });
});

describe('useReviewTags', () => {
  it('reads the tag catalogue and refreshes with the demo namespace', async () => {
    const tags = countingStub([
      {
        id: 't1',
        name: '值得复盘',
        color: 'var(--color-accent)',
        created_at: '2026-08-01T00:00:00Z',
        updated_at: '2026-08-01T00:00:00Z',
      },
    ]);
    const { result, queryClient } = renderDataHook(() => useReviewTags(), {
      client: { listReviewTags: tags.call },
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    // Tags live under `demos` because a tag rename changes what the library
    // rows display — one invalidation has to reach both.
    await act(async () => {
      await invalidateDemos(queryClient);
    });
    await waitFor(() => {
      expect(tags.calls()).toBe(2);
    });
  });
});

/* ── the phase 3b writes ─────────────────────────────────────────────────── */

const SCAN_RESULT: ScanResult = {
  discovered: 2,
  imported: 2,
  updated: 0,
  skipped: 0,
  errors: [],
};

describe('useImportDemoFiles', () => {
  it('re-runs the list after a successful import — the invalidation chain, proved', async () => {
    const list = countingStub(page([DEMO]));
    const importer = countingStub(SCAN_RESULT);

    const { result } = renderDataHook(
      () => ({ list: useDemoList({}), importer: useImportDemoFiles() }),
      { client: { listDemos: list.call, importDemos: importer.call } as never },
    );

    await waitFor(() => {
      expect(result.current.list.data?.items).toHaveLength(1);
    });
    expect(list.calls()).toBe(1);

    list.succeed(page([DEMO, { ...DEMO, id: 'demo-b', display_name: 'Nova vs Pulse' }]));
    await act(async () => {
      await result.current.importer.mutateAsync([new File([], 'nova.dem')]);
    });

    // Not "invalidateQueries was called" — the query actually ran again and the
    // new rows reached the caller. That is the only assertion that would have
    // caught an invalidation aimed at the wrong key.
    await waitFor(() => {
      expect(list.calls()).toBe(2);
      expect(result.current.list.data?.items).toHaveLength(2);
    });
  });

  it('leaves the cache alone when the import fails', async () => {
    const list = countingStub(page([DEMO]));
    const importer = countingStub(SCAN_RESULT);
    importer.fail(new DesktopError('磁盘空间不足', 507, 'STORAGE_FULL'));

    const { result } = renderDataHook(
      () => ({ list: useDemoList({}), importer: useImportDemoFiles() }),
      { client: { listDemos: list.call, importDemos: importer.call } as never },
    );

    await waitFor(() => {
      expect(result.current.list.isSuccess).toBe(true);
    });

    await act(async () => {
      await result.current.importer.mutateAsync([new File([], 'nova.dem')]).catch(() => undefined);
    });

    await waitFor(() => {
      expect(result.current.importer.isError).toBe(true);
    });
    expect(dataErrorMessage(result.current.importer.error)).toBe('磁盘空间不足');
    // A rejected write must not pretend the server state moved.
    expect(list.calls()).toBe(1);
  });
});

describe('useDeleteDemos', () => {
  it('deletes one id at a time and refreshes the rows and the storage figure', async () => {
    const list = countingStub(page([DEMO]));
    const remove = countingStub(undefined);

    const storage = countingStub({ ok: true } as never);

    // The storage probe is *mounted*, not seeded: `gcTime: 0` drops an entry
    // with no observers the moment it is written, so a seeded key would be gone
    // before the invalidation could reach it. A live observer is also the
    // stronger claim — it re-runs, rather than merely being marked stale.
    const { result } = renderDataHook(
      () => ({
        list: useDemoList({}),
        storage: useStorageStatus(),
        remove: useDeleteDemos(),
      }),
      {
        client: {
          listDemos: list.call,
          deleteDemo: remove.call,
          storageStatus: storage.call,
        } as never,
      },
    );

    await waitFor(() => {
      expect(result.current.list.isSuccess).toBe(true);
      expect(result.current.storage.isSuccess).toBe(true);
    });

    await act(async () => {
      await result.current.remove.mutateAsync(['demo-a', 'demo-b']);
    });

    // Sequential, not `Promise.all`: the service stages managed files, and a
    // partial failure has to be reportable.
    expect(remove.calls()).toBe(2);
    expect(remove.lastArgs()[0]).toBe('demo-b');
    await waitFor(() => {
      expect(list.calls()).toBe(2);
      // 「受管文件进入可回滚暂存」 — the bytes moved, so the占用 figure is stale.
      expect(storage.calls()).toBe(2);
    });
  });

  it('still refreshes after a partial failure, because some ids are already gone', async () => {
    const list = countingStub(page([DEMO]));
    const remove = countingStub(undefined);
    remove.fail(new DesktopError('文件被占用', 409, 'DEMO_LOCKED'));

    const { result } = renderDataHook(
      () => ({ list: useDemoList({}), remove: useDeleteDemos() }),
      { client: { listDemos: list.call, deleteDemo: remove.call } as never },
    );

    await waitFor(() => {
      expect(result.current.list.isSuccess).toBe(true);
    });

    await act(async () => {
      await result.current.remove.mutateAsync(['demo-a']).catch(() => undefined);
    });

    await waitFor(() => {
      expect(result.current.remove.isError).toBe(true);
    });
    expect(dataErrorMessage(result.current.remove.error)).toBe('文件被占用');
    // `onSettled`, not `onSuccess`: a delete that failed halfway still changed
    // the server, and leaving the stale rows on screen would be worse.
    await waitFor(() => {
      expect(list.calls()).toBe(2);
    });
  });
});

describe('useStartDemoAnalysis', () => {
  it('invalidates both namespaces, because one event moves rows and tasks', async () => {
    const list = countingStub(page([DEMO]));
    const start = countingStub({ id: 'run-1' });

    const feed = countingStub({ items: [], total: 0, page: 1, page_size: 20 });

    // The task feed is observed through a bare `useQuery` on `qk.tasks.feed`
    // rather than through `data/tasks.ts`'s hook: this file is asserting that
    // *this* mutation reaches the tasks namespace, and borrowing the other
    // file's hook would make the assertion depend on its options too.
    const { result } = renderDataHook(
      () => ({
        list: useDemoList({}),
        feed: useQuery({ queryKey: qk.tasks.feed({}), queryFn: () => feed.call() }),
        start: useStartDemoAnalysis(),
      }),
      { client: { listDemos: list.call, startAnalysisRun: start.call } as never },
    );

    await waitFor(() => {
      expect(result.current.list.isSuccess).toBe(true);
      expect(result.current.feed.isSuccess).toBe(true);
    });

    await act(async () => {
      await result.current.start.mutateAsync(['demo-a']);
    });

    expect(start.calls()).toBe(1);
    await waitFor(() => {
      // the row's 状态 column flips to 「分析中」 …
      expect(list.calls()).toBe(2);
      // … and the run appears in the activity feed
      expect(feed.calls()).toBe(2);
    });
  });
});

describe('useLaunchDemoPlayback', () => {
  it('refreshes the runtime state and nothing else', async () => {
    const list = countingStub(page([DEMO]));
    const play = countingStub({ launched: true });

    const runtime = countingStub({ version: '0.1.0' } as never);

    const { result } = renderDataHook(
      () => ({
        list: useDemoList({}),
        runtime: useRuntimeState(),
        play: useLaunchDemoPlayback(),
      }),
      {
        client: { listDemos: list.call, playDemo: play.call, runtimeState: runtime.call } as never,
      },
    );

    await waitFor(() => {
      expect(result.current.list.isSuccess).toBe(true);
      expect(result.current.runtime.isSuccess).toBe(true);
    });

    await act(async () => {
      await result.current.play.mutateAsync('demo-a');
    });

    await waitFor(() => {
      // `RuntimeState` carries the playback session — the only read this moves.
      expect(runtime.calls()).toBe(2);
    });
    // Launching a replay does not move a single row.
    expect(list.calls()).toBe(1);
  });
});

describe('useUpdateDemo', () => {
  it('refreshes the whole namespace, because the list shows the name and the remark', async () => {
    const list = countingStub(page([DEMO]));
    const update = countingStub(DEMO);

    const { result } = renderDataHook(
      () => ({ list: useDemoList({}), update: useUpdateDemo() }),
      { client: { listDemos: list.call, updateDemo: update.call } as never },
    );

    await waitFor(() => {
      expect(result.current.list.isSuccess).toBe(true);
    });

    await act(async () => {
      await result.current.update.mutateAsync({
        demoId: 'demo-a',
        update: { remark: 'Kael 第 21 回合的 1v3 值得做成片' },
      });
    });

    expect(update.lastArgs()[0]).toBe('demo-a');
    await waitFor(() => {
      expect(list.calls()).toBe(2);
    });
  });
});
