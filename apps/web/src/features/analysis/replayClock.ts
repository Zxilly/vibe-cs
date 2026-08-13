const FALLBACK_FRAME_DELAY_MS = 100;
const MINIMUM_FRAME_DELAY_MS = 16;
const SPARSE_MINIMUM_STEP_BASE_MS = 120;
const SPARSE_MAXIMUM_STEP_BASE_MS = 750;

export type ReplayTimingMode = 'entity_snapshots' | 'hybrid' | 'event_sparse';

export function replayFrameDelayMs(
  currentTick: number,
  nextTick: number,
  tickRate: number,
  speed: number,
  mode: ReplayTimingMode = 'entity_snapshots',
): number {
  const tickDistance = nextTick - currentTick;
  if (
    !Number.isFinite(tickDistance)
    || tickDistance <= 0
    || !Number.isFinite(tickRate)
    || tickRate <= 0
    || !Number.isFinite(speed)
    || speed <= 0
  ) {
    return FALLBACK_FRAME_DELAY_MS;
  }

  if (mode === 'event_sparse') {
    const evidenceStepDelay = Math.min(
      SPARSE_MAXIMUM_STEP_BASE_MS,
      Math.max(SPARSE_MINIMUM_STEP_BASE_MS, (tickDistance / tickRate) * 1_000),
    );
    return evidenceStepDelay / speed;
  }

  return Math.max(MINIMUM_FRAME_DELAY_MS, (tickDistance / tickRate / speed) * 1_000);
}
