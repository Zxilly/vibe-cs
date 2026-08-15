/*
 * pages/delivery — what `/delivery/task/:taskId` has to work out before
 * `domain/task/TaskDetail` can draw.
 *
 * ── The address ───────────────────────────────────────────────────────────
 *
 * `ActivityItem.id` is the service's own locator, `kind:jobId`
 * (`crates/application/src/routes/activity.rs` builds it, and
 * `commands.getActivity` refuses an answer whose id does not match the pair it
 * was asked for). §7's route takes one path segment, so that locator *is* the
 * segment — percent-encoded, since the colon is the separator. Splitting it
 * back apart is the whole of `parseTaskLocator`, and an address that does not
 * name a real kind returns `null` rather than a guess: the page then renders
 * 「找不到这条任务」 instead of asking the service about `recording:undefined`.
 *
 * ── The stage log ─────────────────────────────────────────────────────────
 *
 * Only an analysis has one. `AnalysisRunDetail.events` is a real per-stage log
 * with nine closed-set codes, which is exactly what 「阶段日志」 asks for
 * (「用户语言；实现细节收在「技术细节」里」 — a closed set can be translated, a
 * free-text line cannot). A recording job carries a single `message` naming the
 * stage it is on and no history; an export and a download carry neither. So
 * this file translates the analysis events and the other three kinds render an
 * empty log, which `TaskDetail` already draws as 「还没有阶段日志」.
 *
 * That asymmetry is a backend gap, not a rendering choice, and it is reported as
 * one. Nothing here manufactures a log line from a status change.
 */

import { Trans } from '@lingui/react/macro';
import type { ReactNode } from 'react';

import {
  ANALYSIS_STAGE_IDS,
  recordingTaskStages,
  taskStageStates,
  type TaskLogEntry,
  type TaskStageEntry,
  type TaskStatus,
} from '../../domain/task';
import { RECORDING_STAGE_IDS } from '../../design/feedback';
import type {
  ActivityItem,
  ActivityKind,
  AnalysisRunEvent,
  AnalysisRunEventCode,
} from '../../shared/desktop/dto';
import { analysisStageLabels, RECORDING_STAGE_BY_MESSAGE } from './taskModel';

/* ── the address ─────────────────────────────────────────────────────────── */

const ACTIVITY_KINDS: readonly ActivityKind[] = ['recording', 'export', 'download', 'analysis'];

export interface TaskLocator {
  readonly kind: ActivityKind;
  readonly jobId: string;
}

export function parseTaskLocator(taskId: string): TaskLocator | null {
  const separator = taskId.indexOf(':');
  if (separator <= 0) return null;

  const kind = taskId.slice(0, separator);
  const jobId = taskId.slice(separator + 1);
  if (jobId === '' || !ACTIVITY_KINDS.includes(kind as ActivityKind)) return null;

  return { kind: kind as ActivityKind, jobId };
}

/* ── stages ──────────────────────────────────────────────────────────────── */

/**
 * The six recording stages with the run's own state applied.
 *
 * The pointer comes from the service's stage message; an unrecognised one
 * leaves the pointer at −1, which `taskStageStates` renders as "nothing entered
 * yet" rather than as a wrong stage lighting up.
 */
export function recordingStageEntries(item: ActivityItem, status: TaskStatus): TaskStageEntry[] {
  const id = item.stage === null ? undefined : RECORDING_STAGE_BY_MESSAGE[item.stage];
  const pointer = id === undefined ? -1 : (RECORDING_STAGE_IDS as readonly string[]).indexOf(id);
  const states = taskStageStates(RECORDING_STAGE_IDS, pointer, status);
  return recordingTaskStages(states.map((state) => ({ state })));
}

/**
 * The five analysis stages, with the stamp of the event that entered each one.
 *
 * The stamps come from the log rather than from the run record, because the run
 * only keeps `created_at` / `updated_at` — the per-stage times exist exactly
 * once, in the events.
 */
export function analysisStageEntries(
  currentStage: string,
  status: TaskStatus,
  events: readonly AnalysisRunEvent[],
): TaskStageEntry[] {
  const pointer = ANALYSIS_STAGE_IDS.indexOf(currentStage as (typeof ANALYSIS_STAGE_IDS)[number]);
  const states = taskStageStates(ANALYSIS_STAGE_IDS, pointer, status);
  const labels = analysisStageLabels();

  const enteredAt = new Map<string, string>();
  for (const event of events) {
    if (!enteredAt.has(event.stage)) enteredAt.set(event.stage, event.created_at);
  }

  return ANALYSIS_STAGE_IDS.map((id, index) => {
    const at = enteredAt.get(id);
    return {
      id,
      label: labels[id] ?? id,
      state: states[index] ?? 'pending',
      ...(at === undefined ? {} : { at }),
    };
  });
}

/* ── the log ─────────────────────────────────────────────────────────────── */

/**
 * The nine analysis event codes in the user's language.
 *
 * A closed set, so this is a `Record` and a new code fails to compile rather
 * than rendering its own identifier at the reader. `AnalysisRunEvent.detail` is
 * the service's free text and is appended when it sent any.
 */
function analysisEventLabels(): Readonly<Record<AnalysisRunEventCode, ReactNode>> {
  return {
    input_validation_started: <Trans>开始校验输入文件</Trans>,
    input_verified: <Trans>输入文件校验通过</Trans>,
    parser_started: <Trans>开始解析比赛数据</Trans>,
    input_revalidation_started: <Trans>解析后复核输入</Trans>,
    projection_started: <Trans>开始位置采样</Trans>,
    completed: <Trans>分析完成</Trans>,
    failed: <Trans>分析失败</Trans>,
    interrupted: <Trans>分析被中断</Trans>,
    cancelled: <Trans>分析已取消</Trans>,
  };
}

/**
 * The codes the artboard washes in accent (「片段 3 重试 1 次后成功」 — the line
 * that explains something the reader would otherwise have to infer). Here that
 * is the three that end the run in a way the user has to act on.
 */
const EMPHASISED_CODES: ReadonlySet<AnalysisRunEventCode> = new Set<AnalysisRunEventCode>([
  'failed',
  'interrupted',
  'cancelled',
]);

export function analysisLogEntries(events: readonly AnalysisRunEvent[]): TaskLogEntry[] {
  const labels = analysisEventLabels();

  return events.map((event) => ({
    // `sequence` is the service's own ordering key and unique within a run —
    // two events can share a timestamp, so the stamp is not an identity.
    id: `${event.run_id}-${String(event.sequence)}`,
    at: event.created_at,
    message:
      event.detail === null || event.detail === '' ? (
        labels[event.message_code]
      ) : (
        <>
          {labels[event.message_code]}
          {' · '}
          {event.detail}
        </>
      ),
    ...(EMPHASISED_CODES.has(event.message_code) ? { emphasis: true } : {}),
  }));
}
