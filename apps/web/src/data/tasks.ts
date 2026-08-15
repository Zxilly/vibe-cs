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
 * picking one number here would impose it on all three. Phase 3a chooses.
 * The QueryClient defaults are not touched.
 */

import { skipToken, useQuery, type QueryClient } from '@tanstack/react-query';

import type { ActivityKind, ActivityQuery } from '../shared/desktop/dto';
import { useDesktopClient } from './desktopClient';
import { qk } from './keys';
import { resolveQueryTuning, type DataQueryTuning } from './queryTuning';

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
export function useTaskFeed(query: ActivityQuery, tuning: DataQueryTuning = {}) {
  const client = useDesktopClient();
  return useQuery({
    queryKey: qk.tasks.feed(query),
    queryFn: ({ signal }) => client.listActivities(query, signal),
    ...resolveQueryTuning(tuning),
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
  tuning: DataQueryTuning = {},
) {
  const client = useDesktopClient();
  const ready = kind !== null && jobId !== null;
  return useQuery({
    queryKey: qk.tasks.detail(kind ?? 'recording', jobId ?? ''),
    queryFn:
      kind === null || jobId === null
        ? skipToken
        : ({ signal }) => client.getActivity(kind, jobId, signal),
    ...resolveQueryTuning(tuning, { enabled: ready }),
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
export function useAnalysisRun(runId: string | null, tuning: DataQueryTuning = {}) {
  const client = useDesktopClient();
  return useQuery({
    queryKey: qk.tasks.analysisRun(runId ?? ''),
    queryFn: runId === null ? skipToken : ({ signal }) => client.getAnalysisRun(runId, signal),
    ...resolveQueryTuning(tuning, { enabled: runId !== null }),
  });
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
