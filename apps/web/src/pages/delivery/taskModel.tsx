/*
 * pages/delivery — the service's activity record, as the display model
 * `domain/task` draws.
 *
 * `domain/task/types.ts` states the division: 「This is a display model, not a
 * transport model … the page layer maps rather than translates」. This file is
 * that map, and it is the only place in the page that knows both shapes.
 *
 * Four decisions are worth reading before changing anything here.
 *
 * ── 1. `montage` is inferred from `subtype`, not invented ──────────────────
 *
 * Spec §10.3 deviation 7: `TaskKind` has five members and `dto.ts`'s
 * `ActivityKind` has four — there is no `montage`. It is not missing, though: an
 * export activity carries `subtype`, and the service writes exactly two values
 * into it (`crates/runtime/src/export.rs`: 「if !matches!(kind, "montage" |
 * "editor")」 rejects anything else). So 合辑导出 is `kind: 'export'` plus
 * `subtype: 'montage'`, and this file reads that pair rather than asking the
 * backend for a fifth kind. An unrecognised subtype stays 导出.
 *
 * ── 2. A progress bar only where the service sent a denominator ────────────
 *
 * 「有真实分母时才用进度条，否则只给阶段名」 (「补齐 · 规范与状态」). `TaskProgress`
 * has no shape for "a bar with no total", so the rule is enforced by the type;
 * what this file must not do is manufacture the missing half. Two sources are
 * accepted and nothing else:
 *
 *   completed_units + total_units + unit   the counted forms (bytes, stages)
 *   progress_percent                       a percentage the service computed
 *
 * `progress_percent` is nullable on the wire and null never becomes zero. A
 * `total_units` of 0 is dropped too: a bar over an empty total is a division
 * the reader would have to ignore.
 *
 * ── 3. Failure reason is `unknown`, and that is the honest answer ──────────
 *
 * `TaskFailureReason` is a closed set of five; `ActivityItem.error` is free
 * text with no code beside it. Recovering the set from the sentence would mean
 * matching substrings the service has never promised to keep — 「磁盘空间不足」
 * today, a reworded message tomorrow, and a task silently reclassified as
 * 未知原因 with nobody noticing. So every failure maps to `unknown` and the
 * service's own sentence is carried through as `detail`, where the artboard
 * puts it. Naming the five needs an error *code* on `ActivityItem`; that is
 * reported as a gap rather than papered over here.
 *
 * ── 4. Recovery actions come from the caller ───────────────────────────────
 *
 * `TaskFailure.recovery` is required by `domain/task`'s types, and it holds a
 * callback — which is a page concern (it fires a mutation, it navigates). This
 * module stays free of hooks and mutations: the caller passes the action in.
 * That also keeps the whole file pure, so it is asserted in the `unit` project.
 */

import { Trans } from '@lingui/react/macro';
import type { ReactNode } from 'react';

import { ANALYSIS_STAGE_IDS } from '../../domain/task';
import type {
  TaskArtifact,
  TaskKind,
  TaskLink,
  TaskProgress,
  TaskRecoveryAction,
  TaskStagePosition,
  TaskStatus,
  TaskSummary,
} from '../../domain/task';
import type { ActivityStatus } from '../../shared/desktop/dto';
import type { ActivityItem } from '../../shared/desktop/viewModels';

/* ── status ──────────────────────────────────────────────────────────────── */

/**
 * `ActivityStatus` → `TaskStatus`.
 *
 * `dto.ts` widens `JobStatus` with four words the download and analysis
 * pipelines use for their own middles (`downloading` / `decompressing` /
 * `importing` / `analyzing`). All four are 运行中: they say *what* is running,
 * which is the stage line's job, not *whether* it is. `preparing` folds into
 * `queued` for the reason `domain/task/types.ts` already gives — the artboard
 * has one 排队中 marker and no 准备中 word.
 *
 * There is no `awaiting-confirmation` on the wire. It is a state the front end
 * owns (§4.5.3 ①), reached by `taskMachine` before a recording is confirmed and
 * never reported by the service, so nothing maps onto it.
 */
export const ACTIVITY_STATUS_TO_TASK_STATUS: Readonly<Record<ActivityStatus, TaskStatus>> = {
  queued: 'queued',
  preparing: 'queued',
  running: 'running',
  downloading: 'running',
  decompressing: 'running',
  importing: 'running',
  analyzing: 'running',
  cancelling: 'cancelling',
  completed: 'succeeded',
  failed: 'failed',
  cancelled: 'cancelled',
};

export function taskStatusOfActivity(status: ActivityStatus): TaskStatus {
  return ACTIVITY_STATUS_TO_TASK_STATUS[status];
}

/* ── kind ────────────────────────────────────────────────────────────────── */

/** See decision 1. */
export function taskKindOfActivity(item: ActivityItem): TaskKind {
  if (item.kind === 'export' && item.subtype === 'montage') return 'montage';
  return item.kind;
}

/* ── progress ────────────────────────────────────────────────────────────── */

/** See decision 2. */
export function taskProgressOfActivity(item: ActivityItem): TaskProgress | undefined {
  const { completed_units: completed, total_units: total, unit } = item;
  if (completed !== null && total !== null && total > 0 && unit !== null) {
    return { completed, total, unit };
  }
  if (item.progress_percent !== null) {
    return { completed: item.progress_percent, total: 100, unit: 'percent' };
  }
  return undefined;
}

/* ── stages ──────────────────────────────────────────────────────────────── */

/**
 * The service's recording stage messages, mapped onto the six ids
 * `design/feedback/StageBar` draws.
 *
 * `crates/application/src/routes/activity.rs`'s `recording_stage_ordinal`
 * enumerates exactly these five and gives them the ordinals 1–5; the sixth
 * drawn stage (发布) has no message of its own, because a job that published is
 * a job that completed. That asymmetry is why this table maps ids rather than
 * ordinals: `taskStageStates` paints every stage `done` on success anyway, so
 * 发布 lights up at the right moment without the service ever naming it.
 */
export const RECORDING_STAGE_BY_MESSAGE: Readonly<Record<string, string>> = {
  'recording.stage.launching': 'launch',
  'recording.stage.seeking': 'seek',
  'recording.stage.capturing': 'capture',
  'recording.stage.stabilizing': 'settle',
  'recording.stage.encoding': 'encode',
};

/**
 * The five analysis stages in the user's language.
 *
 * Spec §10.3 gap 4: `ANALYSIS_STAGE_IDS` are the service's own ids and 「剩下的
 * 裸 id 由页面层传 label」. These are that copy. They are a proposal — the ids
 * describe the pipeline's internals (`verifying_input_after_parse`) and the
 * artboard only ever prints one stage name (「阶段 3/5 位置采样」) — so they are
 * written where a product decision can replace them, in one table, rather than
 * spread over the page.
 */
export function analysisStageLabels(): Readonly<Record<string, ReactNode>> {
  return {
    validating_input: <Trans>校验输入</Trans>,
    parser_queued: <Trans>排队等待解析</Trans>,
    parser_running: <Trans>解析比赛数据</Trans>,
    verifying_input_after_parse: <Trans>复核解析结果</Trans>,
    projecting: <Trans>位置采样</Trans>,
  };
}

/**
 * Which stage the task is in, as `domain/task` wants it: an id from the drawn
 * sequence, a label, and the 「阶段 3/5」 position when the sequence is drawn.
 *
 * `undefined` for a stage this build does not recognise. The alternative —
 * showing the raw id — would put `verifying_input_after_parse` in a status line
 * that is otherwise entirely Chinese, and the artboard's rule for the log panel
 * (「用户语言；实现细节收在「技术细节」里」) is the same rule one level up.
 */
export function taskStagePositionOf(item: ActivityItem): TaskStagePosition | undefined {
  if (item.stage === null) return undefined;

  if (item.kind === 'recording') {
    const id = RECORDING_STAGE_BY_MESSAGE[item.stage];
    if (id === undefined) return undefined;
    return { id, label: recordingStageLabel(id) };
  }

  if (item.kind === 'analysis') {
    const index = ANALYSIS_STAGE_IDS.indexOf(item.stage as (typeof ANALYSIS_STAGE_IDS)[number]);
    if (index < 0) return undefined;
    const label = analysisStageLabels()[item.stage];
    return {
      id: item.stage,
      label: label ?? item.stage,
      index: index + 1,
      count: ANALYSIS_STAGE_IDS.length,
    };
  }

  return undefined;
}

/**
 * The six recording stage names. They are `design/feedback/recordingStages()`'s
 * own labels, read off the design layer instead of retyped — the same reason
 * `domain/task/taskStages.ts` imports the ids rather than copying them.
 */
function recordingStageLabel(id: string): ReactNode {
  const stage = recordingStageLabelTable()[id];
  return stage ?? id;
}

function recordingStageLabelTable(): Readonly<Record<string, ReactNode>> {
  return {
    launch: <Trans>启动</Trans>,
    seek: <Trans context="recording-stage">跳转</Trans>,
    capture: <Trans>采集</Trans>,
    settle: <Trans>稳定</Trans>,
    encode: <Trans>编码</Trans>,
    publish: <Trans>发布</Trans>,
  };
}

/* ── the whole record ────────────────────────────────────────────────────── */

export interface TaskSummaryOptions {
  /**
   * Required for a failed task and ignored otherwise — `TaskSummary` will not
   * compile without a recovery action on a failure, which is 「每条都带一个主要
   * 恢复动作」 held by the type system rather than by review.
   */
  readonly recovery?: TaskRecoveryAction | undefined;
  /** 影响范围, when the page can state it. */
  readonly impact?: ReactNode | undefined;
  readonly artifacts?: readonly TaskArtifact[] | undefined;
  readonly links?: readonly TaskLink[] | undefined;
  /** A trailing fact for the status line: 「可重新发起」「4 个片段」. */
  readonly note?: ReactNode | undefined;
  /** `now` when the task has not finished; used only to compute 已用 / 用时. */
  readonly now?: Date | undefined;
}

/**
 * `ActivityItem` → `TaskSummary`.
 *
 * A failed record with no `recovery` supplied falls back to a recovery that
 * does nothing but say so. That branch exists because the type demands an
 * action and a page that forgot one must still render; it is deliberately
 * useless rather than plausible, so the omission shows up.
 */
export function toTaskSummary(item: ActivityItem, options: TaskSummaryOptions = {}): TaskSummary {
  const status = taskStatusOfActivity(item.status);
  const stage = taskStagePositionOf(item);
  const progress = taskProgressOfActivity(item);

  const base = {
    id: item.id,
    kind: taskKindOfActivity(item),
    subject: item.subject ?? item.id,
    startedAt: item.created_at,
    ...(stage === undefined ? {} : { stage }),
    ...(progress === undefined ? {} : { progress }),
    ...(options.note === undefined ? {} : { note: options.note }),
    ...(options.artifacts === undefined ? {} : { artifacts: options.artifacts }),
    ...durationOf(item, status, options.now),
  } as const;

  if (status !== 'failed') return { ...base, status };

  return {
    ...base,
    status,
    failure: {
      reason: 'unknown',
      ...(item.error === null ? {} : { detail: item.error }),
      ...(options.impact === undefined ? {} : { impact: options.impact }),
      recovery: options.recovery ?? MISSING_RECOVERY,
    },
  };
}

const MISSING_RECOVERY: TaskRecoveryAction = {
  label: <Trans>暂无可用的恢复动作</Trans>,
  onAction: () => {},
  disabled: true,
};

/**
 * 已用 / 用时, from the two stamps the record carries.
 *
 * A finished task's span is `updated_at − created_at`, which is what the
 * service last wrote. A running one is measured against `now` instead, because
 * `updated_at` only moves when the service reports something — using it would
 * freeze 已用 between stages and make a slow stage look like a stalled clock.
 * Without a `now` the elapsed time is simply omitted; inventing one from the
 * module's own `Date.now()` would make this function impure and untestable.
 */
function durationOf(
  item: ActivityItem,
  status: TaskStatus,
  now: Date | undefined,
): { durationMs?: number } {
  const started = Date.parse(item.created_at);
  if (!Number.isFinite(started)) return {};

  const terminal = status === 'succeeded' || status === 'failed' || status === 'cancelled';
  const end = terminal ? Date.parse(item.updated_at) : now?.getTime();
  if (end === undefined || !Number.isFinite(end)) return {};

  const span = end - started;
  return span < 0 ? {} : { durationMs: span };
}
