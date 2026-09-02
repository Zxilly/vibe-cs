/*
 * Domain layer, layer 2 of 3 — the task display model.
 *
 * Every task the product runs is drawn the same way twice: as a row on
 * 「01 工作台首页」 and as an entry in the 任务记录 rail of 「11 输出与任务记录」.
 * Both draw the same five facts — 类型 · 目标对象 · 当前阶段 · 开始时间 · 耗时 —
 * and then either a result link or a failure with a recovery action. That is
 * what this file types.
 *
 * This is a **display model, not a transport model**. Field names line up with
 * `shared/desktop/dto`'s `ActivityItem` wherever the two mean the same thing, so
 * the page layer maps rather than translates; the alignment is noted per field.
 * Where they differ, the reason is written down — the DTO carries things a card
 * must not show (`progress_percent` next to no denominator) and misses things a
 * card must show (a required recovery action on every failure).
 *
 * Spec §4.3: 「推进由后端事件驱动，前端不模拟进度」. Nothing in here is derived
 * from a clock. A card renders exactly what it was handed.
 */

import type { ReactNode } from 'react';

import type { JobStatus } from '../../shared/desktop/dto';

/**
 * The four task types the brief names plus 下载, which the 任务记录 rail header
 * lists verbatim (「任务记录 · 分析 · 下载 · 录制 · 导出」) and draws as its
 * fourth entry (「下载 · Steam 比赛历史」).
 *
 * `analysis` / `recording` / `export` / `download` are `ActivityKind` from
 * `dto.ts` unchanged. `montage` is the fifth: 「09 快速合辑」 is its own pipeline
 * with its own page, and the artboard labels its output 「合辑导出 · 快速合辑」 —
 * a montage that fails has a different recovery (回到合辑) from a plain export.
 */
/**
 * The seven job states, and the narrowing that recovers them from the wire.
 *
 * `RecordingExecutionResponse.status` and `JobAccepted.status` are
 * `&'static str` in `crates/application` — written by `match` arms over
 * `JobStatus` but typed as plain strings, so the generated bindings say
 * `string` and nothing in the contract closes the set. Every caller that needs
 * the closed enum goes through `asJobStatus`, which answers `null` for a value
 * this application has never seen rather than letting it flow on as a state
 * the compiler believes is impossible.
 */
export const JOB_STATUSES: readonly JobStatus[] = [
  'queued',
  'preparing',
  'running',
  'cancelling',
  'completed',
  'failed',
  'cancelled',
];

export function asJobStatus(value: string): JobStatus | null {
  return JOB_STATUSES.includes(value as JobStatus) ? (value as JobStatus) : null;
}

export type TaskKind = 'analysis' | 'recording' | 'montage' | 'export' | 'download';

/**
 * Display states derived from the host's `JobStatus` (`queued preparing running cancelling
 * completed failed cancelled`):
 *   · `preparing` folds into `queued` — the artboard has one 「排队中」 marker
 *     and no separate 「准备中」 word anywhere.
 *   · `completed` is spelled `succeeded` so it cannot be confused with the
 *     `done` of a *stage*, which is a different scale.
 */
export type TaskStatus =
  | 'queued'
  | 'running'
  | 'cancelling'
  | 'succeeded'
  | 'failed'
  | 'cancelled';

/**
 * Why a task failed, as a closed set. `dto.ts` gives failures as a free-text
 * `error` string, which cannot be styled, counted or translated; the reason is
 * lifted out so the copy is a `Record` lookup (see `taskVocabulary.tsx`) and the
 * free text survives as `TaskFailure.detail` for the cases nobody foresaw.
 *
 * The five named reasons are the ones the reference actually writes:
 *   disk-space        「导出未完成：磁盘空间不足，已保留工程与素材」
 *   game-unavailable  「CS2 与受管录制环境已就绪」, negated — the shell's
 *                     environment block only appears when it blocks a task
 *   source-missing    「文件不在原位 · 记录仍在，文件已被移动或删除」
 *   timeout           「观察者视角短暂丢失」 escalated past its retry budget
 */
export type TaskFailureReason =
  | 'disk-space'
  | 'game-unavailable'
  | 'source-missing'
  | 'timeout'
  | 'unknown';

/**
 * What a progress numerator counts. `percent` / `bytes` / `stages` are
 * `ActivityItem.unit` plus the percentage form the home artboard draws
 * (「62%」); `clips` is the recording rail's 「2/6」, which counts 片段.
 */
export type TaskProgressUnit = 'percent' | 'stages' | 'clips' | 'bytes';

/**
 * A **real** denominator. 「有真实分母时才用进度条，否则只给阶段名」
 * (「补齐 · 规范与状态」) is enforced by construction: there is no shape here
 * that expresses "a bar with no total", so a caller that lacks one cannot
 * describe it. `TaskSummary.progress` is optional; its absence is the
 * stage-name branch.
 *
 * Maps from `ActivityItem.completed_units` / `total_units` / `unit`.
 * `ActivityItem.progress_percent` maps here as `{ completed, total: 100,
 * unit: 'percent' }` — but only when the backend actually sent it; it is
 * nullable there, and null must not become a zero.
 */
export interface TaskProgress {
  readonly completed: number;
  readonly total: number;
  readonly unit: TaskProgressUnit;
}

/** The stage a task is in right now, in the user's language. */
export interface TaskStagePosition {
  /** Stage id, e.g. `capture`. Matches `taskStages.ts`'s sequence for the kind. */
  readonly id: string;
  /** 「位置采样」. `ActivityItem.stage` after the page has named it. */
  readonly label: ReactNode;
  /** 1-based, for 「阶段 3/5」. Omitted when the kind has no drawn sequence. */
  readonly index?: number | undefined;
  readonly count?: number | undefined;
}

/** 主要恢复动作. Required on every failure — see `TaskFailure`. */
export interface TaskRecoveryAction {
  /** 「重试导出」「重新定位」「释放空间」 */
  readonly label: ReactNode;
  readonly onAction: () => void;
  /** Set while the service that would carry it out is unavailable. */
  readonly disabled?: boolean | undefined;
}

export interface TaskFailure {
  readonly reason: TaskFailureReason;
  /**
   * 影响范围, in the user's language:
   * 「影响范围：仅这一次导出，工程与素材已保留。释放 4.2 GB 后可重试。」
   * The artboard prints one on every failure it draws.
   */
  readonly impact?: ReactNode | undefined;
  /** `ActivityItem.error` — the backend's own sentence, when it adds anything. */
  readonly detail?: ReactNode | undefined;
  /**
   * Required. 「每条都带一个主要恢复动作」 (「补齐 · 规范与状态」, the Notice
   * rule) — a failed task with no way forward does not type-check.
   */
  readonly recovery: TaskRecoveryAction;
}

/** A produced file or record: 「查看结果 Kael_Mirage_1v3.mp4」 */
export interface TaskArtifact {
  readonly id: string;
  readonly label: ReactNode;
  readonly href: string;
  /** 「文件不在原位」 — the record survives, the file does not. */
  readonly missing?: boolean | undefined;
}

/** 「来源方案 #P-118」「来源 Demo Aurora vs Meridian」 */
export interface TaskLink {
  readonly id: string;
  readonly label: ReactNode;
  readonly href: string;
}

interface TaskSummaryBase {
  /** 「#A-2481」 — shown in the mono face exactly as written. `ActivityItem.id`. */
  readonly id: string;
  readonly kind: TaskKind;
  /** 目标对象: 「Kael_Mirage_1v3」「Kestrel vs Halcyon」. `ActivityItem.subject`. */
  readonly subject: string;
  /** ISO 8601. `ActivityItem.created_at`. Rendered by `taskClock.ts`. */
  readonly startedAt: string;
  /**
   * Elapsed for a task still going, total for one that stopped — which of the
   * two it is comes from `status`, not from a second field. See
   * `TASK_DURATION_KIND` in `duration.ts`: 「已用 1 分 52 秒」 and 「用时 6 分 41
   * 秒」 are different statements, and the artboard writes both.
   */
  readonly durationMs?: number | undefined;
  readonly stage?: TaskStagePosition | undefined;
  /** Present only when a real denominator exists. See `TaskProgress`. */
  readonly progress?: TaskProgress | undefined;
  /** One trailing fact for the status line: 「4 个片段」「可重新发起」. */
  readonly note?: ReactNode | undefined;
  readonly artifacts?: readonly TaskArtifact[] | undefined;
}

/**
 * Discriminated on `status` so the type system carries the artboard's rule:
 * a failed task **has** a failure, and a failure **has** a recovery action.
 */
export type TaskSummary =
  | (TaskSummaryBase & {
    readonly status: Exclude<TaskStatus, 'failed'>;
    readonly failure?: undefined;
  })
  | (TaskSummaryBase & {
    readonly status: 'failed';
    readonly failure: TaskFailure;
  });

/** A failed task, for callers that have already narrowed. */
export type FailedTask = Extract<TaskSummary, { status: 'failed' }>;

/** One line of 阶段日志, in the user's language. */
export interface TaskLogEntry {
  readonly id: string;
  /** ISO 8601; rendered as 「09:09」. */
  readonly at: string;
  /** 「片段 3 重试 1 次后成功 · 观察者视角短暂丢失」 */
  readonly message: ReactNode;
  /**
   * The artboard washes one line in `--color-accent-100`: the one that explains
   * a retry. `emphasis` is that wash, not a severity.
   */
  readonly emphasis?: boolean | undefined;
}

/** A label/value row of the detail rail: 「用时 6 分 41 秒」「重试 1」. */
export interface TaskFact {
  readonly id: string;
  readonly label: ReactNode;
  readonly value: ReactNode;
}
