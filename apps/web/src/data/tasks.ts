/**
 * data layer — the unified task surface (spec §2 `data/tasks.ts`, §4.3).
 *
 * §4.3 makes one `taskMachine` out of recording / analysis / export / download,
 * and says its input comes from here: 「机器的输入来自 data/tasks.ts 的
 * query，输出只是呈现状态——推进由后端事件驱动，前端不模拟进度」. So this file
 * returns the server's own records unchanged; deriving a stage sequence or a
 * progress bar from them is `domain/task`'s job, not a `select` here.
 *
 * ## Polling
 *
 * A task moves without anyone touching the UI, which is the one case §4.1's
 * defaults do not cover — they set no refetch interval at all, and there is no
 * event channel from the backend yet (§4.7: the only streaming Tauri command is
 * `agent_chat`). So these hooks accept `pollMs` and **default to no polling**:
 * the cadence depends on what the page shows (the workbench's two-line task
 * row, delivery's task record column, a task detail page with a stage log) and
 * picking one number here would impose it on all three. Phase 3a chooses — the
 * three numbers live in `pages/delivery/taskPolling.ts`, and the predicate that
 * says whether polling is warranted at all (`feedHasActiveTask`) lives here,
 * because it is a fact about the feed rather than about a layout.
 * The QueryClient defaults are not touched.
 *
 * ## Writes
 *
 * Phase 3a adds the writes the delivery page performs: cancel a task, retry a
 * failed one. Two things are worth reading before adding another:
 *
 *   · **Every mutation states what it invalidates and why.** The keys come from
 *     `qk`, never from a literal array, so an invalidation cannot address a key
 *     the reads do not use.
 *   · **There is no `retry_export`.** `ActivityAction` (dto.ts) offers
 *     `retry_analysis` / `retry_download` / `retry_recording` and nothing for an
 *     export, because re-running one needs the `EditorExportOptions` the
 *     original request carried and the activity record does not keep them. A
 *     failed export therefore recovers by 「打开工程」, which is what
 *     「11 输出与任务记录」 draws next to it. Nothing here invents a command.
 */

import { useMutation, useQueryClient, skipToken, useQuery, type QueryClient } from '@tanstack/react-query';

import type {
  ActivityKind,
  ActivityQuery,
  ActivityStatus,
  AnalysisRunDetail,
  AnalysisRunStatus,
  RecordingPlanResponse,
} from '../shared/desktop/dto';
import type { ActivityFeed, ActivityItem } from '../shared/desktop/viewModels';
import { invalidateDemos } from './demos';
import { useDesktopClient } from './desktopClient';
import { qk } from './keys';
import { invalidateOutputs } from './outputs';
import { resolveQueryTuning, type DataQueryTuning } from './queryTuning';

/**
 * `pollMs` plus the one knob that is specific to a task surface.
 *
 * `pollMs` is an unconditional interval (`queryTuning.ts`); `pollWhileActiveMs`
 * is the same number applied **only while the answer says something is still
 * running**, and it is what the task pages use. The stopping condition is
 * evaluated against the query's own cached answer rather than against a value
 * the caller passes back in, so an idle feed really does stop asking — see
 * `pages/delivery/taskPolling.ts` for the three cadences and the reasoning.
 */
export interface TaskQueryTuning extends DataQueryTuning {
  readonly pollWhileActiveMs?: number | undefined;
}

/**
 * The activity feed: every task of every kind, filtered and paged, plus the
 * summary counters the 「任务记录」 header shows.
 *
 * Invalidated by: `planRecording` / `executeRecordingPlan` /
 * `cancelRecordingJob` / `startAnalysisRun` / `cancelAnalysisRun` /
 * `exportEditorProject` / `exportMontageProject` / `cancelExportJob` /
 * `downloadMatchDemo` / `cancelMatchDownload` → `invalidateTasks`. Anything
 * that starts, cancels or retries work belongs on that list.
 */
export function useTaskFeed(query: ActivityQuery, tuning: TaskQueryTuning = {}) {
  const client = useDesktopClient();
  const { pollWhileActiveMs, ...rest } = tuning;

  return useQuery({
    queryKey: qk.tasks.feed(query),
    queryFn: ({ signal }) => client.listActivities(query, signal),
    ...resolveQueryTuning(rest),
    ...(pollWhileActiveMs === undefined
      ? {}
      : {
        // The interval reads the query's *own* last answer, so "stop when
        // nothing is running" cannot drift out of step with what is on
        // screen — which it would if the caller computed the number from
        // `feed.data` and handed it back on the next render.
        refetchInterval: (self: { state: { data: ActivityFeed | undefined } }) =>
          feedHasActiveTask(self.state.data) ? pollWhileActiveMs : false,
      }),
  });
}

/**
 * One activity item — the row the task detail page (`/delivery/task/:taskId`)
 * is built from. Addressed by the `kind` + job id locator the feed uses, which
 * is why both are in the key.
 */
export function useTask(
  kind: ActivityKind | null,
  jobId: string | null,
  tuning: TaskQueryTuning = {},
) {
  const client = useDesktopClient();
  const ready = kind !== null && jobId !== null;
  const { pollWhileActiveMs, ...rest } = tuning;

  return useQuery({
    queryKey: qk.tasks.detail(kind ?? 'recording', jobId ?? ''),
    queryFn:
      kind === null || jobId === null
        ? skipToken
        : ({ signal }) => client.getActivity(kind, jobId, signal),
    ...resolveQueryTuning(rest, { enabled: ready }),
    ...(pollWhileActiveMs === undefined
      ? {}
      : {
        refetchInterval: (self: { state: { data: ActivityItem | undefined } }) =>
          self.state.data !== undefined && activityIsActive(self.state.data)
            ? pollWhileActiveMs
            : false,
      }),
  });
}

/**
 * The recording job record: outputs, per-shot state and the failure reason the
 * retry notice needs. Keyed below `tasks.detail('recording', id)`, so
 * `invalidateTask` refreshes the activity row and the job together.
 */
export function useRecordingJob(jobId: string | null, tuning: DataQueryTuning = {}) {
  const client = useDesktopClient();
  return useQuery({
    queryKey: qk.tasks.recordingJob(jobId ?? ''),
    queryFn: jobId === null ? skipToken : ({ signal }) => client.getRecordingJob(jobId, signal),
    ...resolveQueryTuning(tuning, { enabled: jobId !== null }),
  });
}

/** The export job record, same arrangement as `useRecordingJob`. */
export function useExportJob(jobId: string | null, tuning: DataQueryTuning = {}) {
  const client = useDesktopClient();
  return useQuery({
    queryKey: qk.tasks.exportJob(jobId ?? ''),
    queryFn: jobId === null ? skipToken : ({ signal }) => client.getExportJob(jobId, signal),
    ...resolveQueryTuning(tuning, { enabled: jobId !== null }),
  });
}

/**
 * One analysis run with its event log — the five-stage timeline of §4.3.
 *
 * Invalidated by: `cancelAnalysisRun`, which changes both the run and the feed,
 * so it invalidates `qk.tasks.all`.
 */
export function useAnalysisRun(runId: string | null, tuning: TaskQueryTuning = {}) {
  const client = useDesktopClient();
  const { pollWhileActiveMs, ...rest } = tuning;

  return useQuery({
    queryKey: qk.tasks.analysisRun(runId ?? ''),
    queryFn: runId === null ? skipToken : ({ signal }) => client.getAnalysisRun(runId, signal),
    ...resolveQueryTuning(rest, { enabled: runId !== null }),
    ...(pollWhileActiveMs === undefined
      ? {}
      : {
        refetchInterval: (self: { state: { data: AnalysisRunDetail | undefined } }) =>
          self.state.data !== undefined && analysisRunIsActive(self.state.data.run.status)
            ? pollWhileActiveMs
            : false,
      }),
  });
}

/**
 * Whether an analysis run can still change. `AnalysisRunStatus` has four ways to
 * stop (`interrupted` is the one the other task kinds have no equivalent of —
 * the service lost the worker), and everything else is in flight.
 */
export function analysisRunIsActive(status: AnalysisRunStatus): boolean {
  return status === 'queued' || status === 'running';
}

/**
 * 「这场比赛现在在分析吗」 — keyed by demo, because the caller has a demo id and
 * not a run id. This is what the library row's inline progress and the match
 * workspace's gate both read.
 *
 * Invalidated by: `startAnalysisRun` and `cancelAnalysisRun` →
 * `invalidateTasks`, and it must *also* invalidate `qk.demos.all`, since the
 * library row's status column is derived from the same event.
 */
export function useActiveAnalysisRun(demoId: string | null, tuning: DataQueryTuning = {}) {
  const client = useDesktopClient();
  return useQuery({
    queryKey: qk.tasks.activeAnalysisRun(demoId ?? ''),
    queryFn:
      demoId === null ? skipToken : ({ signal }) => client.getActiveAnalysisRun(demoId, signal),
    ...resolveQueryTuning(tuning, { enabled: demoId !== null }),
  });
}

/* ── is anything moving? ─────────────────────────────────────────────────── */

/**
 * The three states a task has stopped in. `dto.ts` spells the rest of
 * `ActivityStatus` as work in flight (`queued` / `preparing` / `running` /
 * `cancelling`, plus the download and analysis words `downloading` /
 * `decompressing` / `importing` / `analyzing`), so the terminal set is the one
 * worth writing down: it is short, closed, and the complement of it is what
 * "still moving" means.
 */
export const TERMINAL_ACTIVITY_STATUS: ReadonlySet<ActivityStatus> = new Set<ActivityStatus>([
  'completed',
  'failed',
  'cancelled',
]);

/** Whether this record can still change on its own. */
export function activityIsActive(item: ActivityItem): boolean {
  return !TERMINAL_ACTIVITY_STATUS.has(item.status);
}

/**
 * Whether a feed is worth polling.
 *
 * Both halves are consulted on purpose. `summary.active` counts every task the
 * service knows about, including ones the current filter hides — a page showing
 * only 失败 still has to notice when the running task beside it finishes,
 * because the counters in its header move. The per-item scan then covers the
 * opposite case: a summary that has not caught up with an item already in the
 * page.
 *
 * `undefined` (nothing has loaded yet) is **not** active: the first fetch is
 * already in flight and an interval would only stack a second one on top.
 */
export function feedHasActiveTask(feed: ActivityFeed | undefined): boolean {
  if (feed === undefined) return false;
  return feed.summary.active > 0 || feed.items.some(activityIsActive);
}

/* ── writes ──────────────────────────────────────────────────────────────── */

/** Which task a write addresses: the `kind:jobId` pair the feed is keyed by. */
export interface TaskLocator {
  readonly kind: ActivityKind;
  /** `ActivityItem.job_id`. Absent on a record whose job is gone. */
  readonly jobId: string;
  /**
   * `ActivityItem.context_id` — the demo behind an analysis, the match behind a
   * download. Retrying either needs it, because neither command takes a job id:
   * an analysis is re-run against its demo and a download against its match.
   */
  readonly contextId?: string | undefined;
}

/**
 * 「取消」/「停止」.
 *
 * Invalidates:
 *   · `qk.tasks.all` — the record itself, and the feed's five summary counters,
 *     which move even when only one task did.
 *   · `qk.outputs.all` for a recording or an export, because a cancelled run is
 *     not an empty one: 「停止这次录制？」 (「补齐 · 规范与状态」) states that
 *     「已完成的 2 个片段会保留在输出里」, so the output list changes at exactly
 *     this moment.
 *   · `qk.demos.all` for an analysis, because the library's 状态 column is
 *     derived from the run (see `useActiveAnalysisRun`).
 *
 * Nothing is invalidated optimistically and no status is written into the
 * cache: §4.3's 「推进由后端事件驱动，前端不模拟进度」 applies to a cancel as much
 * as to a stage — `cancelling` becomes `cancelled` when the service says so.
 */
export function useCancelTask() {
  const client = useDesktopClient();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ kind, jobId }: TaskLocator): Promise<void> => {
      switch (kind) {
        case 'recording':
          await client.cancelRecordingJob(jobId);
          return;
        case 'export':
          await client.cancelExportJob(jobId);
          return;
        case 'analysis':
          await client.cancelAnalysisRun(jobId);
          return;
        case 'download':
          await client.cancelMatchDownload(jobId);
          return;
      }
    },
    onSuccess: async (_result, { kind }) => {
      await invalidateTasks(queryClient);
      if (kind === 'recording' || kind === 'export') await invalidateOutputs(queryClient);
      if (kind === 'analysis') await invalidateDemos(queryClient);
    },
  });
}

/**
 * 「重试」 for the two kinds that can be re-run from the record alone.
 *
 * `retry_analysis` re-runs the analysis of `context_id` (the demo) and
 * `retry_download` re-requests `context_id` (the match); both are what
 * `ActivityItem.available_actions` offers, and both are addressed by context
 * rather than by job id because the service creates a *new* job.
 *
 * Recording is not here — see `useRetryRecordingPlan`. Export is not here at
 * all — see the module note.
 *
 * Invalidates `qk.tasks.all` (a new task exists) plus `qk.demos.all`: an
 * analysis moves the library's 状态 column, and a download ends by importing a
 * demo into the same library.
 */
export function useRetryTask() {
  const client = useDesktopClient();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ kind, contextId }: TaskLocator): Promise<void> => {
      if (contextId === undefined || contextId === '') {
        throw new Error('这条任务记录没有可重试的来源对象。');
      }
      if (kind === 'analysis') {
        await client.startAnalysisRun(contextId);
        return;
      }
      if (kind === 'download') {
        await client.downloadMatchDemo(contextId);
        return;
      }
      throw new Error('这一类任务不能从任务记录直接重试。');
    },
    onSuccess: async () => {
      await invalidateTasks(queryClient);
      await invalidateDemos(queryClient);
    },
  });
}

/**
 * 「重试录制」, first half.
 *
 * `planRecordingRetry` produces a *plan*, not a job: §4.5.3 ① and
 * `taskMachine`'s `awaiting-confirmation` both say 「录制只由一次显式确认启动」,
 * and `executeRecordingPlan(planId, acknowledged)` is that confirmation. So the
 * delivery page's 重试 takes the user to `/recording/<planId>`, where the plan
 * is reviewed and confirmed, instead of starting a recording behind their back.
 *
 * **Invalidates nothing on purpose.** No task has changed yet — the failed
 * record is still failed and no new one exists — so refreshing the feed here
 * would be a refetch that cannot return anything different.
 */
export function useRetryRecordingPlan() {
  const client = useDesktopClient();

  return useMutation({
    mutationFn: ({ jobId }: TaskLocator): Promise<RecordingPlanResponse> =>
      client.planRecordingRetry(jobId),
  });
}

/* ── invalidation ────────────────────────────────────────────────────────── */

/** Feed, every task detail and every job record. The default for any write
 *  that starts, cancels or retries work — the feed's summary counters move
 *  even when only one task did. */
export function invalidateTasks(client: QueryClient): Promise<void> {
  return client.invalidateQueries({ queryKey: qk.tasks.all });
}

/** One task and the job record below it, leaving the feed alone. Use when the
 *  page is showing a single task and the counters are off-screen. */
export function invalidateTask(
  client: QueryClient,
  kind: ActivityKind,
  jobId: string,
): Promise<void> {
  return client.invalidateQueries({ queryKey: qk.tasks.detail(kind, jobId) });
}
