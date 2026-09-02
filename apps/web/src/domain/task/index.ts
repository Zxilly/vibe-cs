/*
 * Domain layer, layer 2 of 3 — task cards and stages (spec §2 `domain/task/`).
 *
 * TaskCard        one task as a card — the 任务记录 entry and the 首页 row
 * StageTimeline   the stage bar plus per-stage times, durations and failure point
 * TaskDetail      the body of the task detail page
 *
 * Pages import from here, never from the files directly.
 */

export {
  StageTimeline,
  recordingTaskStages,
  type RecordingStageMeta,
  type StageTimelineProps,
  type TaskStageEntry,
} from './StageTimeline';
export { TaskCard, TaskCardSkeleton, type TaskCardProps } from './TaskCard';
export { TaskDetail, type TaskDetailProps, type TaskLogState } from './TaskDetail';
export { TaskDuration, type TaskDurationProps } from './TaskDuration';

export {
  TASK_DURATION_KIND,
  taskDuration,
  taskDurationFor,
  type TaskDurationKind,
  type TaskDurationPart,
  type TaskDurationPrecision,
  type TaskDurationUnit,
  type TaskDurationValue,
} from './duration';
export { formatTaskClock, formatTaskTime, type TaskClockOptions } from './taskClock';
export {
  ANALYSIS_STAGE_IDS,
  TASK_STAGE_IDS,
  taskStageIds,
  taskStageIndex,
  taskStageStates,
} from './taskStages';
export {
  TASK_STATUS_DOT,
  TASK_STATUS_TAG_TONE,
  taskFailureLabels,
  taskKindLabels,
  taskProgressUnitLabels,
  taskStatusLabels,
} from './taskVocabulary';
export { JOB_STATUSES, asJobStatus } from './types';
export type {
  FailedTask,
  TaskArtifact,
  TaskFact,
  TaskFailure,
  TaskFailureReason,
  TaskKind,
  TaskLink,
  TaskLogEntry,
  TaskProgress,
  TaskProgressUnit,
  TaskRecoveryAction,
  TaskStagePosition,
  TaskStatus,
  TaskSummary,
} from './types';
