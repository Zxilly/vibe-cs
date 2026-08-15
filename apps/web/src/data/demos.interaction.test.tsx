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

import { act, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { DesktopError } from '../shared/desktop/client';
import type { DemoSummary, Paginated } from '../shared/desktop/dto';
import { invalidateDemo, invalidateDemos, useDemo, useDemoList, useReviewTags } from './demos';
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
