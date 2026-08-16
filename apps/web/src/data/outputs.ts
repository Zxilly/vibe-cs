/**
 * data layer — delivery outputs (spec §2 `data/outputs.ts`).
 *
 * Feeds `/delivery?view=outputs` (§7). Phase 3a adds the two writes that page
 * performs — 移除记录 and 清理无效记录 — and one shell action that is not a
 * write at all (定位文件). Every write invalidates the whole namespace; see the
 * note on `useOutputList`.
 *
 * Rename and batch delete are deliberately still absent: 「11 输出与任务记录」
 * draws 批量重命名 / 批量删除 on a selection bar, and a selection bar with its
 * confirmation dialog is phase 3b's subject. `commands.renameOutput` and
 * `commands.batchDeleteOutputs` exist and are ready for it.
 */

import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';

import { revealLocalPath } from '../shared/desktop/dialog';
import type { DeleteOutputResult, OutputKind, OutputQuery } from '../shared/desktop/dto';
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

/* ── writes ──────────────────────────────────────────────────────────────── */


export interface DeleteOutputInput {
  readonly kind: OutputKind;
  readonly id: string;
  /**
   * Whether to remove the file as well as the record. Defaults to `false` —
   * 「移除记录不会删除文件」 is what the artboard prints under an external file,
   * and the destructive form is opt-in per call rather than per user.
   */
  readonly deleteFile?: boolean | undefined;
}

/**
 * 「移除记录」/「删除」 one output.
 *
 * Invalidates `qk.outputs.all` — the list and the recorded-clip list both, since
 * a recording output and a recorded clip are two views of one file (see
 * `useRecordedClips`). The task feed is **not** invalidated: deleting an output
 * does not change any task record, and the source-task link on the card points
 * at a record that still exists.
 *
 * The result is returned rather than swallowed: `DeleteOutputResult.file_action`
 * distinguishes 「外部文件已保留」 from 「受管文件已进入暂存」, which is the
 * sentence the delivery page prints afterwards. A caller that ignores it is
 * choosing not to say which of the two happened.
 */
export function useDeleteOutput() {
  const client = useDesktopClient();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ kind, id, deleteFile }: DeleteOutputInput): Promise<DeleteOutputResult> =>
      client.deleteOutput(kind, id, deleteFile ?? false),
    onSuccess: () => invalidateOutputs(queryClient),
  });
}

/**
 * 「清理无效记录」 — the topbar action of 「11 输出与任务记录」.
 *
 * Drops the records whose file is gone. Invalidates `qk.outputs.all`, which is
 * the whole point of the button; `CleanupMissingOutputsResult.scan_limited`
 * comes back so the page can say the sweep was partial instead of implying the
 * list is now clean.
 */
export function useCleanupMissingOutputs() {
  const client = useDesktopClient();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (kind?: OutputKind) => client.cleanupMissingOutputs(kind),
    onSuccess: () => invalidateOutputs(queryClient),
  });
}

/**
 * 恢复中心's 「清理暂存输出」.
 *
 * Deletes the files a failed recording or export left in the staging
 * directory. Separate from `useCleanupMissingOutputs` because they undo
 * different accidents: this one removes *files* that no record points at, that
 * one removes *records* that no file backs.
 *
 * `CleanupStagedResponse` carries `failed` as well as `deleted`, and the page
 * prints it: a cleanup that could not remove three locked files has not
 * cleaned up, and reporting only the successes would leave the user pressing
 * the button again.
 */
export function useCleanupStagedOutputs() {
  const client = useDesktopClient();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: () => client.cleanupStagedOutputs(),
    onSuccess: () => invalidateOutputs(queryClient),
  });
}

/**
 * 「定位文件」 — reveal the file in the desktop file manager.
 *
 * Not a server write, so it invalidates nothing and lives outside the
 * `DesktopClient` seam: `shared/desktop/dialog`'s `revealLocalPath` talks to the
 * Tauri opener plugin, not to the service. It is still exposed as a hook here
 * rather than imported by the page, because §2.1 rule 6 keeps `pages/**` out of
 * `shared/desktop/**` entirely and one exception would be one too many.
 *
 * Resolves `false` outside the desktop shell (a browser dev server, a test) —
 * the page reports that as 「只有桌面端能定位文件」 rather than pretending it
 * worked.
 */
export function useRevealOutput() {
  return useMutation({
    mutationFn: (path: string): Promise<boolean> => revealLocalPath(path),
  });
}

/* ── invalidation ────────────────────────────────────────────────────────── */

/** Output lists and recorded clips. */
export function invalidateOutputs(client: QueryClient): Promise<void> {
  return client.invalidateQueries({ queryKey: qk.outputs.all });
}
