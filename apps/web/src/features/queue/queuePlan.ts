import { currentLocale, msg, translate } from '../../shared/i18n';
import type { DemoPlaybackOptions, RecordingJob, RecordingQueueRequest } from '../../shared/desktop/dto';

import type { QueueItem } from './queueStore';

export type RecordingJobStage = {
  key:
    | 'queue.recordingStage.launching'
    | 'queue.recordingStage.seeking'
    | 'queue.recordingStage.capturing'
    | 'queue.recordingStage.stabilizing'
    | 'queue.recordingStage.encoding';
  ordinal: 1 | 2 | 3 | 4 | 5;
  total: 5;
};

const recordingJobStages: Readonly<Record<string, RecordingJobStage>> = {
  'recording.stage.launching': { key: 'queue.recordingStage.launching', ordinal: 1, total: 5 },
  'recording.stage.seeking': { key: 'queue.recordingStage.seeking', ordinal: 2, total: 5 },
  'recording.stage.capturing': { key: 'queue.recordingStage.capturing', ordinal: 3, total: 5 },
  'recording.stage.stabilizing': { key: 'queue.recordingStage.stabilizing', ordinal: 4, total: 5 },
  'recording.stage.encoding': { key: 'queue.recordingStage.encoding', ordinal: 5, total: 5 },
};

/** Prepares the pinned app-managed movie runtime for one recording task. This
 * deliberately lives in the task flow instead of global workspace readiness. */
export async function requireManagedHlaeForRecording<
  T extends { managed_release: { prepared: boolean } },
>(
  prepare: () => Promise<T>,
  failureMessage: string,
): Promise<T> {
  const status = await prepare();
  if (!status.managed_release.prepared) throw new Error(failureMessage);
  return status;
}

/** Maps the runtime's stable stage protocol to presentation data. Unknown and
 * terminal messages remain visible verbatim so errors never get hidden. */
export function recordingJobStage(message: string): RecordingJobStage | null {
  return recordingJobStages[message] ?? null;
}

/** Keeps the durable runtime identity actionable while the richer job status
 * is still hydrating (or temporarily unavailable). */
export function recordingJobCancelTarget(
  activeJobId: string | null,
  job: Pick<RecordingJob, 'id'> | null,
): string | null {
  return activeJobId ?? job?.id ?? null;
}

export function queueItemTickRate(item: QueueItem): number | null {
  return item.tickRate !== undefined && Number.isFinite(item.tickRate) && item.tickRate >= 1 && item.tickRate <= 256
    ? item.tickRate
    : null;
}

export function queueItemDurationSeconds(item: QueueItem): number | null {
  const tickRate = queueItemTickRate(item);
  if (tickRate === null) return null;
  const tickSpan = Math.max(0, item.endTick - item.startTick);
  const preRoll = Number.isFinite(item.preRollSeconds) && item.preRollSeconds > 0 ? item.preRollSeconds : 0;
  const postRoll = Number.isFinite(item.postRollSeconds) && item.postRollSeconds > 0 ? item.postRollSeconds : 0;
  return tickSpan / tickRate + preRoll + postRoll;
}

export function buildDemoPlaybackOptions(item: QueueItem): DemoPlaybackOptions | null {
  const tickRate = queueItemTickRate(item);
  if (tickRate === null) return null;
  const startTick = Number.isFinite(item.startTick) ? item.startTick : 0;
  const preRoll = Number.isFinite(item.preRollSeconds) && item.preRollSeconds > 0
    ? item.preRollSeconds
    : 0;
  return {
    start_tick: Math.max(0, Math.round(startTick - preRoll * tickRate)),
    player: item.playerId,
    timescale: 1,
  };
}

export function demoPlaybackFingerprint(item: QueueItem): string {
  return `demo-playback:${JSON.stringify({
    id: item.id,
    demoId: item.demoId,
    origin: item.origin,
    perspective: item.perspective,
    options: buildDemoPlaybackOptions(item),
  })}`;
}

export function demoPlaybackBlockReason(
  item: QueueItem | null,
  recordingActive: boolean,
  playbackActive = false,
): string | null {
  if (!item) return msg("m1135");
  if (item.origin !== 'demo') return msg("m1002");
  if (recordingActive) return msg("m0577");
  if (playbackActive) return msg("m0571");
  if (queueItemTickRate(item) === null) {
    return translate(currentLocale(), 'queue.tickRateUnavailable');
  }
  if (item.perspective === 'victim') {
    return msg("m0333");
  }
  return null;
}

/** Playback readiness belongs to the local preview workflow, not global
 * recording readiness. An idle empty queue therefore has nothing to report. */
export function playbackReadinessRelevant(
  queueItemCount: number,
  playbackActive: boolean,
): boolean {
  return queueItemCount > 0 || playbackActive;
}

export function buildRecordingQueueRequest(items: readonly QueueItem[]): RecordingQueueRequest {
  return {
    items: items
      .filter((item) => item.enabled && item.origin === 'demo')
      .map((item) => ({
        id: item.id,
        demo_id: item.demoId,
        highlight_id: item.highlightId ?? null,
        player_id: item.playerId,
        title: item.title,
        start_tick: item.startTick,
        end_tick: item.endTick,
        pre_roll_seconds: item.preRollSeconds,
        post_roll_seconds: item.postRollSeconds,
        victim_pov: item.perspective === 'victim',
      })),
  };
}

/**
 * Fingerprints every plan-relevant queue input, including disabled and preview
 * entries. This intentionally invalidates a plan for any queue edit, even when
 * that edit would currently be filtered out of the wire request.
 */
export function recordingQueueFingerprint(items: readonly QueueItem[]): string {
  const snapshot = items.map((item) => ({
    id: item.id,
    demoId: item.demoId,
    highlightId: item.highlightId ?? null,
    hasVictimPov: item.hasVictimPov ?? false,
    demoName: item.demoName,
    playerId: item.playerId,
    playerName: item.playerName,
    title: item.title,
    category: item.category,
    startTick: item.startTick,
    endTick: item.endTick,
    tickRate: item.tickRate ?? null,
    preRollSeconds: item.preRollSeconds,
    postRollSeconds: item.postRollSeconds,
    perspective: item.perspective,
    enabled: item.enabled,
    origin: item.origin,
  }));

  return `recording-queue:${JSON.stringify(snapshot)}`;
}

export function matchesRecordingQueueFingerprint(
  plannedFingerprint: string | null | undefined,
  items: readonly QueueItem[],
): boolean {
  return plannedFingerprint !== null
    && plannedFingerprint !== undefined
    && plannedFingerprint === recordingQueueFingerprint(items);
}
