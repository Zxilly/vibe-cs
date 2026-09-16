/*
 * Domain layer, layer 2 of 3 — the number beside a task's progress bar.
 *
 * Shared by the card's readout and the detail rail's 进度 fact so the two
 * never disagree on a separator or a unit.
 */

import { formatBytes } from '../media/outputModel';
import type { TaskProgress, TaskProgressUnit } from './types';

/**
 * The readout beside a bar and the 进度 fact of a detail: 「62%」 for a
 * percentage, 「2/6」 for anything counted (both drawn on 「01 工作台首页」) —
 * except bytes, which nobody reads as a nine-digit count. A download says
 * 「64 MB / 187 MB」 in the same decimal units the delivery page prints for
 * the file it will become.
 */
const PROGRESS_READOUT: Readonly<Record<TaskProgressUnit, (progress: TaskProgress) => string>> = {
  percent: (progress) => `${String(progress.completed)}%`,
  stages: (progress) => `${String(progress.completed)}/${String(progress.total)}`,
  clips: (progress) => `${String(progress.completed)}/${String(progress.total)}`,
  bytes: (progress) => `${bytesReadout(progress.completed)} / ${bytesReadout(progress.total)}`,
};

export function formatTaskProgress(progress: TaskProgress): string {
  return PROGRESS_READOUT[progress.unit](progress);
}

/** `formatBytes` answers `null` only for a count that is not a count; the
 *  contract (`activityContract.ts`) already rejects those, so the raw number
 *  is the honest fallback rather than a made-up unit. */
function bytesReadout(bytes: number): string {
  return formatBytes(bytes) ?? String(bytes);
}
