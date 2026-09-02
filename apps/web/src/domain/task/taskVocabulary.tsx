/*
 * Domain layer, layer 2 of 3 — the words and tones a task is drawn with.
 *
 * Every union in `types.ts` gets one `Record` here and no `if` chain anywhere
 * else in the directory. Adding a task kind, a status or a failure reason then
 * fails to compile in exactly the places that need a decision, which is the
 * point of closing the sets in the first place.
 *
 * The label records are built inside functions rather than declared as module
 * constants: a `<Trans>` element captures nothing at construction time, but a
 * module-level element would be created before `I18nProvider` has activated a
 * locale in some import orders. `design/feedback/StageBar` builds its own label
 * record the same way, for the same reason.
 */

import { Trans } from '@lingui/react/macro';
import type { ReactNode } from 'react';

import type { StatusDotStatus } from '../../design/feedback';
import type { BadgeVariant } from '../../design/primitives';

import type { TaskFailureReason, TaskKind, TaskProgressUnit, TaskStatus } from './types';

/** 分析 · 录制 · 合辑 · 导出 · 下载 — the rail header of 「11 输出与任务记录」. */
export function taskKindLabels(): Readonly<Record<TaskKind, ReactNode>> {
  return {
    analysis: <Trans>分析</Trans>,
    recording: <Trans>录制</Trans>,
    montage: <Trans>剪辑</Trans>,
    export: <Trans>导出</Trans>,
    download: <Trans>下载</Trans>,
  };
}

/**
 * The status word that opens a task's second line: 「已完成 · 09:12 · …」,
 * 「运行中 · 阶段 3/5 …」, 「失败 · 磁盘空间不足 · …」, 「已取消 · 08-14 22:03 · …」.
 * The first four are the artboard's verbatim; 等待确认 is the shell's word for
 * the state §4.5.3 ① introduces, and 取消中 is `dto.ts`'s `cancelling`.
 */
export function taskStatusLabels(): Readonly<Record<TaskStatus, ReactNode>> {
  return {
    'awaiting-confirmation': <Trans>等待确认</Trans>,
    queued: <Trans>排队中</Trans>,
    running: <Trans>运行中</Trans>,
    cancelling: <Trans>取消中</Trans>,
    succeeded: <Trans>已完成</Trans>,
    failed: <Trans>失败</Trans>,
    cancelled: <Trans>已取消</Trans>,
  };
}

/**
 * The failure in one phrase. The backend's own sentence, when it sent one,
 * goes to `TaskFailure.detail` underneath — this line has to be the same length
 * and the same register every time so a column of task records stays readable.
 */
export function taskFailureLabels(): Readonly<Record<TaskFailureReason, ReactNode>> {
  return {
    'disk-space': <Trans>磁盘空间不足</Trans>,
    'game-unavailable': <Trans>录制环境未就绪</Trans>,
    'source-missing': <Trans>源文件不在原位</Trans>,
    timeout: <Trans>等待超时</Trans>,
    unknown: <Trans>未知原因</Trans>,
  };
}

/** The noun a progress numerator counts, for the bar's accessible value text. */
export function taskProgressUnitLabels(): Readonly<Record<TaskProgressUnit, ReactNode>> {
  return {
    percent: <Trans context="task-progress">百分比</Trans>,
    stages: <Trans context="task-progress">阶段</Trans>,
    clips: <Trans context="task-progress">片段</Trans>,
    bytes: <Trans context="task-progress">字节</Trans>,
  };
}

/**
 * Which square marker precedes the task. Straight off `StatusDot`'s own tally:
 * filled for what is happening or has happened, hollow for what has not.
 *
 * `cancelling` keeps the running marker: the task is still running until the
 * backend says otherwise, and moving the marker on request would be the
 * front-end simulating an outcome (§4.3).
 */
export const TASK_STATUS_DOT: Readonly<Record<TaskStatus, StatusDotStatus>> = {
  'awaiting-confirmation': 'warn',
  queued: 'idle',
  running: 'running',
  cancelling: 'running',
  succeeded: 'ok',
  failed: 'fail',
  cancelled: 'idle',
};

/**
 * The tag beside a task's title on 「任务详情与阶段日志」, where 「已完成」 is drawn
 * as `tag tag-accent`.
 *
 * There is no ok/warn/fail tag tone in this system on purpose (see `Tag.tsx`):
 * the reference draws every failure as a Notice or a StatusDot. So a failed
 * task's tag is neutral and the failure itself is carried by the Notice below
 * it — which is also the component that holds the required recovery action.
 */
export const TASK_STATUS_TAG_TONE: Readonly<Record<TaskStatus, BadgeVariant>> = {
  'awaiting-confirmation': 'outline',
  queued: 'neutral',
  running: 'accent',
  cancelling: 'neutral',
  succeeded: 'accent',
  failed: 'neutral',
  cancelled: 'neutral',
};
