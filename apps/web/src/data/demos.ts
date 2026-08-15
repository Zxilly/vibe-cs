/**
 * data layer — Demo library reads (spec §2 `data/demos.ts`).
 *
 * Reads only this round. The writes (import, scan, rename, tag, delete) belong
 * to phase 3b, which is where the dialogs that perform them are built; what
 * they have to invalidate is written down next to each read below so 3b does
 * not have to rediscover it.
 *
 * Every hook is a thin `useQuery` over one `commands` method. No selectors, no
 * derived shapes: presentation belongs to `domain/**`, and a `select` here
 * would be a second place to look when a column shows the wrong number.
 */

import { skipToken, useQuery, type QueryClient } from '@tanstack/react-query';

import type { DemoQuery } from '../shared/desktop/dto';
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
