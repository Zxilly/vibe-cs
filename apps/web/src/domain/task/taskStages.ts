/*
 * Domain layer, layer 2 of 3 — the stage sequence of a task, as pure data.
 *
 * The host owns lifecycle state. This module only maps each task kind to its
 * displayed stage sequence.
 *
 * The six recording stages are **imported**, not retyped: `RECORDING_STAGE_IDS`
 * is `design/feedback/StageBar`'s own list, the one `recordingStages()` labels
 * 启动 · 跳转 · 采集 · 稳定 · 编码 · 发布. Copying the six words here would let the
 * bar and the machine disagree about how many there are.
 *
 * Ids only. Labels are a rendering concern and live with the components — which
 * is also why this module has no React and no i18n and can be exhausted in the
 * `unit` project.
 */

import { RECORDING_STAGE_IDS, type StageState } from '../../design/feedback';

import type { TaskKind, TaskStatus } from './types';

/**
 * The five stages of an analysis run, §4.3's 「分析 5 阶段」.
 *
 * Taken verbatim from `shared/desktop/dto`'s `AnalysisRunStage`, minus its four
 * terminal values (`completed` / `failed` / `interrupted` / `cancelled`, which
 * are task *status*, not stages). That leaves exactly five, which is the count
 * §4.3 states and the count the home artboard prints as 「阶段 3/5」. Taking the
 * backend's own ids rather than inventing user-facing ones means the page layer
 * can match `ActivityItem.stage` against this list without a translation table;
 * the Chinese the artboard shows for one of them (「位置采样」) is a label, and
 * labels are supplied by the caller.
 */
export const ANALYSIS_STAGE_IDS = [
  'validating_input',
  'parser_queued',
  'parser_running',
  'verifying_input_after_parse',
  'projecting',
] as const;

/**
 * Stage sequence per task kind.
 *
 * `montage` / `export` / `download` are deliberately empty. The reference draws
 * a stage bar for recording and a 「阶段 3/5」 readout for analysis, and for the
 * other three it draws neither — the failed export on 「11 输出与任务记录」 shows
 * a failure notice and two links, no bar. An empty sequence is what makes
 * `TaskCard` fall through to its stage-name branch instead of inventing six
 * segments, which is the artboard's rule (「有真实分母时才用进度条，否则只给阶段
 * 名」) applied one level up. When the backend grows a real sequence for them,
 * this table is the one place to add it.
 */
export const TASK_STAGE_IDS: Readonly<Record<TaskKind, readonly string[]>> = {
  analysis: ANALYSIS_STAGE_IDS,
  recording: RECORDING_STAGE_IDS,
  montage: [],
  export: [],
  download: [],
};

export function taskStageIds(kind: TaskKind): readonly string[] {
  return TASK_STAGE_IDS[kind];
}

/**
 * Which stage of the sequence an id is, or `-1` when the sequence does not
 * contain it. Unknown ids happen — the backend can report a stage this build
 * has never heard of — and they must not be guessed at.
 */
export function taskStageIndex(stages: readonly string[], stage: string): number {
  return stages.indexOf(stage);
}

/**
 * Turn "which stage are we on" plus "how is the task doing" into one
 * `StageState` per stage, the shape `design/feedback/StageBar` takes.
 *
 *   before the pointer   done      it happened
 *   at the pointer       active    …unless the task stopped there, below
 *   after the pointer    pending   it has not happened
 *
 * The three terminal statuses each override the pointer's own cell:
 *
 *   succeeded  every stage is `done`, whatever the pointer says. A task cannot
 *              have finished while a stage of it did not.
 *   failed     the pointer's cell is `failed`. Only that one — the stages
 *              before it did complete, and saying otherwise would hide which
 *              stage to look at.
 *   cancelled  the pointer's cell returns to `pending`. `StageState` has no
 *              cancelled, and painting an interrupted stage as `failed` would
 *              merge two things the artboard keeps apart: 「失败 · 磁盘空间不足」
 *              carries a recovery action, 「已取消 · 可重新发起」 does not.
 *
 * A pointer of `-1` (nothing entered yet) leaves every stage `pending`, which
 * is also what `recordingStages([])` produces.
 */
export function taskStageStates(
  stages: readonly string[],
  stageIndex: number,
  status: TaskStatus,
): StageState[] {
  return stages.map((_stage, index) => {
    if (status === 'succeeded') return 'done';
    if (index < stageIndex) return 'done';
    if (index > stageIndex) return 'pending';
    if (status === 'failed') return 'failed';
    if (status === 'cancelled') return 'pending';
    if (status === 'queued') return 'pending';
    return 'active';
  });
}
