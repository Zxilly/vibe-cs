/**
 * data layer — the Demo library, reads and writes (spec §2 `data/demos.ts`).
 *
 * Phase 2 shipped the reads and wrote down, next to each one, what a later
 * write would have to invalidate. Phase 3b adds those writes — import, scan,
 * rescan, rename, tag, delete, start an analysis, launch playback — and every
 * one of them invalidates exactly the keys the read above it names.
 *
 * Every read is a thin `useQuery` over one `commands` method. No selectors, no
 * derived shapes: presentation belongs to `domain/**` and `pages/**`, and a
 * `select` here would be a second place to look when a column shows the wrong
 * number.
 *
 * ## One rule for the writes
 *
 * `qk.demos.all` is the default invalidation, not `qk.demos.detail(id)`. The
 * library list renders the display name, the remark, the source and the status
 * of every row, so almost every write to one demo changes what a *list* shows.
 * `invalidateDemo` is exported for the rare write that provably cannot, and
 * each mutation below says which of the two it picked and why.
 */

import {
  skipToken,
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from '@tanstack/react-query';

import type {
  DemoMetadataBatchUpdate,
  DemoMetadataUpdate,
  DemoQuery,
  DemoUpdate,
  ReviewTagCreate,
} from '../shared/desktop/dto';
import { useDesktopClient } from './desktopClient';
import { qk } from './keys';
import { resolveQueryTuning, type DataQueryTuning } from './queryTuning';

/**
 * One page of the library table / card grid.
 *
 * Invalidated by: `importDemoPaths`, `importDemos`, `scanDemos`,
 * `rescanDemoWatch`, `updateDemo`, `updateDemoMetadata*`, `deleteDemo`, and by
 * an analysis run completing (it moves a row from 「未分析」 to 「已分析」).
 * All of those change row *content*, not just membership, so they invalidate
 * `qk.demos.all` rather than a single detail key.
 */
export function useDemoList(query: DemoQuery, tuning: DataQueryTuning = {}) {
  const client = useDesktopClient();
  return useQuery({
    queryKey: qk.demos.list(query),
    queryFn: ({ signal }) => client.listDemos(query, signal),
    ...resolveQueryTuning(tuning),
  });
}

/**
 * One demo, for the library Inspector and for `/match/:demoId`'s context bar.
 *
 * `demoId: null` is the "nothing selected" state — `skipToken` keeps the entry
 * out of the cache entirely rather than parking a disabled query under a
 * placeholder key.
 */
export function useDemo(demoId: string | null, tuning: DataQueryTuning = {}) {
  const client = useDesktopClient();
  return useQuery({
    queryKey: qk.demos.detail(demoId ?? ''),
    queryFn: demoId === null ? skipToken : ({ signal }) => client.getDemo(demoId, signal),
    ...resolveQueryTuning(tuning, { enabled: demoId !== null }),
  });
}

/**
 * Review metadata (tags, remarks, rating) for one demo. Sits below the demo's
 * detail key, so `invalidateDemo` refreshes it too.
 *
 * Invalidated by: `updateDemoMetadata`, `updateDemoMetadataBatch`, and tag
 * renames — a tag's label is embedded in what this returns.
 */
export function useDemoMetadata(demoId: string | null, tuning: DataQueryTuning = {}) {
  const client = useDesktopClient();
  return useQuery({
    queryKey: qk.demos.metadata(demoId ?? ''),
    queryFn: demoId === null ? skipToken : ({ signal }) => client.getDemoMetadata(demoId, signal),
    ...resolveQueryTuning(tuning, { enabled: demoId !== null }),
  });
}

/**
 * The watched-folder status shown in settings and on the library's empty state.
 *
 * Invalidated by: `rescanDemoWatch`, and by a config write that changes
 * `demo_watch_paths` (see `config.ts` — that mutation invalidates
 * `qk.demos.all` for exactly this reason).
 */
export function useDemoWatchStatus(tuning: DataQueryTuning = {}) {
  const client = useDesktopClient();
  return useQuery({
    queryKey: qk.demos.watch(),
    queryFn: ({ signal }) => client.getDemoWatchStatus(signal),
    ...resolveQueryTuning(tuning),
  });
}

/**
 * The review-tag catalogue: the filter chips above the library and the options
 * in the tag dialog.
 *
 * Invalidated by: `createReviewTag`, `updateReviewTag`, `deleteReviewTag` —
 * each of which must *also* invalidate `qk.demos.all`, because the rows carry
 * the tag labels.
 */
export function useReviewTags(tuning: DataQueryTuning = {}) {
  const client = useDesktopClient();
  return useQuery({
    queryKey: qk.demos.reviewTags(),
    queryFn: ({ signal }) => client.listReviewTags(signal),
    ...resolveQueryTuning(tuning),
  });
}

/* ── the write surface of the bridge ─────────────────────────────────────── */

/* ── writes: getting demos into the library ──────────────────────────────── */

/**
 * 「导入 Demo」 with files the user dropped or picked in the browser file
 * dialog. `commands.importDemos` uploads each one through the desktop bridge
 * and folds the per-file `ScanResult`s into one.
 *
 * Invalidates `qk.demos.all`: an import adds rows (every `demos.list` query,
 * whatever its filter) and moves the watch counters that `qk.demos.watch()`
 * reports. Both hang under the namespace, so one call reaches both.
 */
export function useImportDemoFiles() {
  const client = useDesktopClient();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (files: readonly File[]) => client.importDemos([...files]),
    onSuccess: () => invalidateDemos(queryClient),
  });
}

/**
 * The same import addressed by path — what the watch-directory drawer's
 * 「导入这个目录」 uses. Same invalidation, same reason.
 */
export function useImportDemoPaths() {
  const client = useDesktopClient();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (paths: readonly string[]) => client.importDemoPaths([...paths]),
    onSuccess: () => invalidateDemos(queryClient),
  });
}

/**
 * A one-off scan of a directory tree that is *not* being watched.
 * `commands.scanDemos` hard-codes `recursive: true`.
 */
export function useScanDemoPaths() {
  const client = useDesktopClient();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (paths: readonly string[]) => client.scanDemos([...paths]),
    onSuccess: () => invalidateDemos(queryClient),
  });
}

/**
 * 「重新扫描」 in the watch-directory drawer. The response *is* the new
 * `DemoWatchStatus`, but it is not written into the cache directly: the same
 * rescan also changes the rows, and a page that saw a fresh status beside a
 * stale table would be worse than one that waits for both.
 */
export function useRescanDemoWatch() {
  const client = useDesktopClient();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: () => client.rescanDemoWatch(),
    onSuccess: () => invalidateDemos(queryClient),
  });
}

/* ── writes: editing one demo ────────────────────────────────────────────── */

/**
 * Rename, or edit the remark. Invalidates `qk.demos.all` rather than the one
 * detail key because `display_name` and `remark` are both columns of the list
 * — the case the header note calls out.
 */
export function useUpdateDemo() {
  const client = useDesktopClient();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ demoId, update }: { demoId: string; update: DemoUpdate }) =>
      client.updateDemo(demoId, update),
    onSuccess: () => invalidateDemos(queryClient),
  });
}

/**
 * Review metadata for one demo: the tag set, the comment and the match source.
 *
 * Invalidates `qk.demos.all`, not `qk.demos.metadata(id)`. The narrower key
 * would be correct only if no list column showed a tag — and the artboard's
 * table has a 标签 column, so as soon as the wire carries tags on `DemoSummary`
 * this write changes rows too. Choosing the namespace now means that day
 * changes nothing here.
 */
export function useUpdateDemoMetadata() {
  const client = useDesktopClient();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ demoId, update }: { demoId: string; update: DemoMetadataUpdate }) =>
      client.updateDemoMetadata(demoId, update),
    onSuccess: () => invalidateDemos(queryClient),
  });
}

/** 「添加标签」 on a selection — one request for the whole batch. */
export function useUpdateDemoMetadataBatch() {
  const client = useDesktopClient();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (update: DemoMetadataBatchUpdate) => client.updateDemoMetadataBatch(update),
    onSuccess: () => invalidateDemos(queryClient),
  });
}

/**
 * 「删除记录」, one or many.
 *
 * Sequential rather than `Promise.all`: the service deletes managed files into
 * a rollback staging area, and firing twelve concurrent deletes at it buys
 * nothing a user can perceive while making a partial failure much harder to
 * report. The rejection carries the first failure, and the ids already deleted
 * are gone — which is why the invalidation runs from `onSettled`.
 *
 * Invalidates:
 *   `qk.demos.all`        the rows are gone, every filter's list is stale
 *   `qk.config.storage()` a managed delete moves bytes into 「暂存区」, which is
 *                         what settings·文件 and 恢复中心 count
 */
export function useDeleteDemos() {
  const client = useDesktopClient();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (demoIds: readonly string[]) => {
      for (const demoId of demoIds) {
        await client.deleteDemo(demoId);
      }
      return demoIds.length;
    },
    onSettled: async () => {
      await Promise.all([
        invalidateDemos(queryClient),
        queryClient.invalidateQueries({ queryKey: qk.config.storage() }),
      ]);
    },
  });
}

/* ── writes: the review-tag catalogue ────────────────────────────────────── */

/**
 * Create / rename / delete a review tag.
 *
 * All three invalidate `qk.demos.all`, not just `qk.demos.reviewTags()`: a tag
 * label is embedded in the metadata every demo carries, so renaming one changes
 * what rows and the Inspector display. `keys.ts` parks `reviewTags` under the
 * `demos` namespace for exactly this reason — one invalidation reaches both.
 */
export function useCreateReviewTag() {
  const client = useDesktopClient();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: ReviewTagCreate) => client.createReviewTag(input),
    onSuccess: () => invalidateDemos(queryClient),
  });
}

export function useRenameReviewTag() {
  const client = useDesktopClient();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ tagId, input }: { tagId: string; input: ReviewTagCreate }) =>
      client.updateReviewTag(tagId, input),
    onSuccess: () => invalidateDemos(queryClient),
  });
}

export function useDeleteReviewTag() {
  const client = useDesktopClient();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (tagId: string) => client.deleteReviewTag(tagId),
    onSuccess: () => invalidateDemos(queryClient),
  });
}

/* ── writes: what the library starts elsewhere ───────────────────────────── */

/**
 * 「分析选中的 3 场」 and the row's 「分析」.
 *
 * It lives in `demos.ts` because the library is where the action is taken and
 * the selection it acts on is a set of demos. It invalidates two namespaces,
 * and `data/tasks.ts`'s own note predicted both:
 *
 *   `qk.tasks.all`   a new run appears in the activity feed, and
 *                    `qk.tasks.activeAnalysisRun(demoId)` is the query the row
 *                    and the workspace gate read
 *   `qk.demos.all`   the row's status column flips to 「分析中」 off the same
 *                    event (`DemoRecord.status: 'analyzing'`)
 *
 * If phase 3a grows a twin in `data/tasks.ts`, the two must be merged rather
 * than left to drift — two mutations invalidating different key sets for one
 * server event is the failure the key factory exists to prevent.
 */
export function useStartDemoAnalysis() {
  const client = useDesktopClient();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (demoIds: readonly string[]) => {
      for (const demoId of demoIds) {
        await client.startAnalysisRun(demoId);
      }
      return demoIds.length;
    },
    onSettled: async () => {
      await Promise.all([
        invalidateDemos(queryClient),
        queryClient.invalidateQueries({ queryKey: qk.tasks.all }),
      ]);
    },
  });
}

/**
 * 「游戏内回放」 — launches CS2 on this demo.
 *
 * Invalidates `qk.config.runtime()` and nothing else: `RuntimeState` carries
 * the active playback session, and it is the only read whose answer this
 * changes. The demo rows do not move.
 */
export function useLaunchDemoPlayback() {
  const client = useDesktopClient();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (demoId: string) => client.playDemo(demoId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: qk.config.runtime() }),
  });
}

/* ── invalidation ────────────────────────────────────────────────────────── */

/** Everything demo-shaped: lists, details, metadata, tags, watch status. */
export function invalidateDemos(client: QueryClient): Promise<void> {
  return client.invalidateQueries({ queryKey: qk.demos.all });
}

/**
 * One demo and its sub-resources, leaving the lists alone. Correct only when
 * the write cannot change what a list row displays — in practice that is rare,
 * so prefer `invalidateDemos` unless you have checked the columns.
 */
export function invalidateDemo(client: QueryClient, demoId: string): Promise<void> {
  return client.invalidateQueries({ queryKey: qk.demos.detail(demoId) });
}
