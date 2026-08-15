/**
 * data layer — delivery outputs (spec §2 `data/outputs.ts`).
 *
 * Feeds `/delivery?view=outputs` (§7). Reads only; the writes (rename, delete,
 * batch delete, cleanup) are phase 3a, and every one of them invalidates the
 * whole namespace — see the note on `useOutputList`.
 */

import { useQuery, type QueryClient } from '@tanstack/react-query';

import type { OutputQuery } from '../shared/desktop/dto';
import { useDesktopClient } from './desktopClient';
import { qk } from './keys';
import { resolveQueryTuning, type DataQueryTuning } from './queryTuning';

/**
 * One page of outputs, plus the `scan_limited` flag the page needs to say
 * 「文件缺失」 honestly rather than pretending the list is complete.
 *
 * Invalidated by: `renameOutput`, `deleteOutput`, `batchDeleteOutputs`,
 * `cleanupMissingOutputs`, `cleanupStagedOutputs` → `invalidateOutputs`, and by
 * any export or recording job reaching a terminal state — a finished job is
 * what *creates* an output, so `invalidateTasks` at a terminal transition has
 * to be paired with `invalidateOutputs`. That pairing is the one cross-domain
 * invalidation in this layer; it is stated here and on `tasks.ts` both.
 */
export function useOutputList(query: OutputQuery, tuning: DataQueryTuning = {}) {
  const client = useDesktopClient();
  return useQuery({
    queryKey: qk.outputs.list(query),
    queryFn: ({ signal }) => client.listOutputs(query, signal),
    ...resolveQueryTuning(tuning),
  });
}

/**
 * Recorded clips — the raw takes the montage and editor pages pick from. They
 * are outputs of the recording pipeline rather than a separate domain, so they
 * share the namespace and the invalidation of one finished recording reaches
 * both this and the output list.
 */
export function useRecordedClips(tuning: DataQueryTuning = {}) {
  const client = useDesktopClient();
  return useQuery({
    queryKey: qk.outputs.recordedClips(),
    queryFn: ({ signal }) => client.listRecordedClips(signal),
    ...resolveQueryTuning(tuning),
  });
}

/* ── invalidation ────────────────────────────────────────────────────────── */

/** Output lists and recorded clips. */
export function invalidateOutputs(client: QueryClient): Promise<void> {
  return client.invalidateQueries({ queryKey: qk.outputs.all });
}
