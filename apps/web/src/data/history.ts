/**
 * data layer — Steam match history (spec §2 directory map, §7 `/history`).
 *
 * The read side of 「比赛历史与 Steam 下载」 plus the three writes the page
 * performs: 同步最近比赛, 下载 one match, 取消 a download in flight.
 *
 * ── Why this file exists now ───────────────────────────────────────────────
 *
 * Phase 3d built `/history` against props because neither half of the seam it
 * needed was its to write: `keys.ts` had no `history` namespace and
 * `DesktopClient` listed no match-history method, so the page shipped with a
 * hard-coded empty list and a Notice saying so. Both halves are here now —
 * the namespace in `keys.ts`, the two reads on `DesktopClient` — and the page
 * reads the service like every other page in §7.
 *
 * ── What each write invalidates, and why ───────────────────────────────────
 *
 *   syncMatchHistory     `qk.history.all` — it rewrites the row set itself, and
 *                        nothing else: a sync discovers matches, it does not
 *                        fetch a demo, so no task and no demo changes.
 *   downloadMatchDemo    `qk.history.all` (the row moves to 下载中) **and**
 *                        `qk.tasks.all` — `ActivityKind` includes `download`,
 *                        so the job the call creates is a row in the task feed
 *                        the moment it exists. Not `qk.demos.all`: the library
 *                        gains a demo when the job *completes*, which is a
 *                        later event this mutation cannot observe.
 *   cancelMatchDownload  the same two, for the same reason in reverse — the row
 *                        leaves 下载中 and the feed entry becomes 已取消.
 *
 * The completion case is polled, not invalidated: `useActiveMatchDownloads`
 * takes a `pollMs` from the page, and when a job leaves the active list the
 * page invalidates the list and the demos namespace once. That is stated on the
 * hook rather than hidden in the page.
 */

import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';

import type { commands } from '../shared/desktop/client';
import type { MatchDownloadJob, MatchHistoryItem, Paginated } from '../shared/desktop/dto';
import { useDesktopClient, type DesktopClient } from './desktopClient';
import { invalidateDemos } from './demos';
import { qk, type MatchHistoryQuery } from './keys';
import { invalidateTasks } from './tasks';
import { resolveQueryTuning, type DataQueryTuning } from './queryTuning';

/* ── reads ───────────────────────────────────────────────────────────────── */

/**
 * One page of the Steam match list.
 *
 * The service pages this list, so the table never holds the whole account: the
 * page prints `total` under the table and the density rule of §10.3 (「该分页的
 * 要分页且页脚印出总数」) is satisfied by the server rather than by truncation.
 *
 * Invalidated by: every write below, and by a download finishing.
 */
export function useMatchHistory(query: MatchHistoryQuery, tuning: DataQueryTuning = {}) {
  const client = useDesktopClient();
  return useQuery({
    queryKey: qk.history.list(query),
    queryFn: ({ signal }): Promise<Paginated<MatchHistoryItem>> =>
      client.listMatchHistory(query.page, query.page_size, signal, query.search),
    ...resolveQueryTuning(tuning),
  });
}

/**
 * `pollMs` plus the knob this list needs, spelled the way `data/tasks.ts`
 * spells it: `pollWhileActiveMs` applies the interval **only while the answer
 * itself still holds a job**, evaluated against the query's own cached data so
 * an idle account really does stop asking.
 */
export interface MatchDownloadTuning extends DataQueryTuning {
  readonly pollWhileActiveMs?: number | undefined;
}

/**
 * The download jobs currently in flight.
 *
 * Separate from the list on purpose: a download moves (bytes, status) far
 * faster than the match rows do, and polling the table at the cadence a
 * progress reading needs would re-fetch fifty rows a second time for nothing.
 * The caller decides the cadence — §4.1 gives no hook a refetch interval of its
 * own.
 */
export function useActiveMatchDownloads(tuning: MatchDownloadTuning = {}) {
  const client = useDesktopClient();
  const { pollWhileActiveMs, ...rest } = tuning;

  return useQuery({
    queryKey: qk.history.activeDownloads(),
    queryFn: ({ signal }): Promise<MatchDownloadJob[]> =>
      client.listActiveMatchDownloadJobs(signal),
    ...resolveQueryTuning(rest),
    ...(pollWhileActiveMs === undefined
      ? {}
      : {
        refetchInterval: (self: { state: { data: MatchDownloadJob[] | undefined } }) =>
          (self.state.data?.length ?? 0) > 0 ? pollWhileActiveMs : false,
      }),
  });
}

/* ── writes ──────────────────────────────────────────────────────────────── */

/**
 * The write half of the IPC surface. Declared here rather than on
 * `DesktopClient` for the reason `data/outputs.ts` and `data/tasks.ts` give:
 * that type is shared with the other phase-3 files, and a write only this
 * module performs is this module's dependency to declare.
 */
export type MatchHistoryWriteClient = Pick<
  typeof commands,
  'syncMatchHistory' | 'downloadMatchDemo' | 'cancelMatchDownload'
>;

/** What a test hands to `DesktopClientProvider` when it exercises a write. */
export type MatchHistoryClientStub = Partial<DesktopClient & MatchHistoryWriteClient>;

type MatchHistoryClient = DesktopClient & Partial<MatchHistoryWriteClient>;

function requireCommand<Name extends keyof MatchHistoryWriteClient>(
  client: MatchHistoryClient,
  name: Name,
): MatchHistoryWriteClient[Name] {
  // See `data/tasks.ts`'s `requireCommand`: a stub that omits the method fails
  // loudly at the call rather than silently resolving `undefined`.
  const method = client[name] as MatchHistoryWriteClient[Name] | undefined;
  if (method === undefined) {
    throw new Error(`桌面客户端缺少 ${name}，无法执行这个比赛历史操作。`);
  }
  return method;
}

/**
 * 「同步最近比赛」 — pull the account's recent matches from Valve.
 *
 * Invalidates `qk.history.all` only. A sync writes match records; it starts no
 * job and imports no demo, so neither `qk.tasks.all` nor `qk.demos.all` has
 * changed and sweeping them would refetch two unrelated pages.
 */
export function useSyncMatchHistory() {
  const client = useDesktopClient() as MatchHistoryClient;
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: () => requireCommand(client, 'syncMatchHistory')(),
    onSuccess: () => invalidateMatchHistory(queryClient),
  });
}

/**
 * 「下载」 one match's demo.
 *
 * Invalidates `qk.history.all` (the row's `demo_status` becomes `downloading`
 * and the active-download list gains an entry) and `qk.tasks.all` (the job is
 * an activity, so 任务记录 shows it immediately). The library is deliberately
 * left alone — see this file's header.
 */
export function useDownloadMatchDemo() {
  const client = useDesktopClient() as MatchHistoryClient;
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (matchId: string): Promise<MatchDownloadJob> =>
      requireCommand(client, 'downloadMatchDemo')(matchId),
    onSuccess: async () => {
      await invalidateMatchHistory(queryClient);
      await invalidateTasks(queryClient);
    },
  });
}

/**
 * 「取消」 a download in flight. Same two invalidations as starting one, because
 * it is the same two facts moving back.
 */
export function useCancelMatchDownload() {
  const client = useDesktopClient() as MatchHistoryClient;
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (jobId: string): Promise<MatchDownloadJob> =>
      requireCommand(client, 'cancelMatchDownload')(jobId),
    onSuccess: async () => {
      await invalidateMatchHistory(queryClient);
      await invalidateTasks(queryClient);
    },
  });
}

/* ── invalidation ────────────────────────────────────────────────────────── */

/** The match list and the active-download list both. */
export function invalidateMatchHistory(client: QueryClient): Promise<void> {
  return client.invalidateQueries({ queryKey: qk.history.all });
}

/**
 * What a *completed* download changed: the row (now 已入库), the task feed entry
 * (now 已完成) and the library, which has a demo it did not have before. This is
 * the one place `qk.demos.all` is swept from this module, and it is a function
 * rather than a comment so the page cannot forget the third one.
 */
export async function invalidateAfterMatchDownload(client: QueryClient): Promise<void> {
  await invalidateMatchHistory(client);
  await invalidateTasks(client);
  await invalidateDemos(client);
}
