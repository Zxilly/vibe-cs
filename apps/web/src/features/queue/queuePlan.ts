import { msg } from '../../shared/i18n';
import type { DemoPlaybackOptions, RecordingQueueRequest } from '../../shared/desktop/dto';

import type { QueueItem } from './queueStore';

const FALLBACK_TICK_RATE = 64;

export function queueItemTickRate(item: QueueItem): number {
  return item.tickRate !== undefined && Number.isFinite(item.tickRate) && item.tickRate >= 1 && item.tickRate <= 256
    ? item.tickRate
    : FALLBACK_TICK_RATE;
}

export function queueItemDurationSeconds(item: QueueItem): number {
  const tickSpan = Math.max(0, item.endTick - item.startTick);
  const playbackSpeed = Number.isFinite(item.playbackSpeed) && item.playbackSpeed > 0 ? item.playbackSpeed : 1;
  const preRoll = Number.isFinite(item.preRollSeconds) && item.preRollSeconds > 0 ? item.preRollSeconds : 0;
  const postRoll = Number.isFinite(item.postRollSeconds) && item.postRollSeconds > 0 ? item.postRollSeconds : 0;
  return tickSpan / queueItemTickRate(item) / playbackSpeed + preRoll + postRoll;
}

export function buildDemoPlaybackOptions(item: QueueItem): DemoPlaybackOptions {
  const tickRate = queueItemTickRate(item);
  const startTick = Number.isFinite(item.startTick) ? item.startTick : 0;
  const preRoll = Number.isFinite(item.preRollSeconds) && item.preRollSeconds > 0
    ? item.preRollSeconds
    : 0;
  const timescale = Number.isFinite(item.playbackSpeed)
    && item.playbackSpeed >= 0.1
    && item.playbackSpeed <= 8
    ? item.playbackSpeed
    : 1;
  return {
    start_tick: Math.max(0, Math.round(startTick - preRoll * tickRate)),
    player: item.playerId,
    timescale,
  };
}

export function demoPlaybackFingerprint(item: QueueItem): string {
  return `demo-playback-v1:${JSON.stringify({
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
  if (item.perspective === 'victim') {
    return msg("m0333");
  }
  return null;
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
        playback_speed: item.playbackSpeed,
        pre_roll_seconds: item.preRollSeconds,
        post_roll_seconds: item.postRollSeconds,
        victim_pov: item.perspective === 'victim',
        show_keyboard: item.showKeyboard,
        show_kill_fx: item.showKillFx,
        fade: true,
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
    playbackSpeed: item.playbackSpeed,
    perspective: item.perspective,
    showKeyboard: item.showKeyboard,
    showKillFx: item.showKillFx,
    enabled: item.enabled,
    origin: item.origin,
  }));

  return `recording-queue-v1:${JSON.stringify(snapshot)}`;
}

export function matchesRecordingQueueFingerprint(
  plannedFingerprint: string | null | undefined,
  items: readonly QueueItem[],
): boolean {
  return plannedFingerprint !== null
    && plannedFingerprint !== undefined
    && plannedFingerprint === recordingQueueFingerprint(items);
}
