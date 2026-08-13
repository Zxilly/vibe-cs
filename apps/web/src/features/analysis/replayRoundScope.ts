export type ReplayRoundTickRange = {
  start_tick: number;
  end_tick: number;
};

export type ScopedReplayFrames<T> = {
  frames: T[];
  initialIndex: number;
};

export function scopeReplayFrames<T extends { tick: number }>(
  frames: readonly T[],
  round: ReplayRoundTickRange,
  preferredTick: number | null,
): ScopedReplayFrames<T> {
  const scopedFrames = frames.filter(
    (frame) => frame.tick >= round.start_tick && frame.tick <= round.end_tick,
  );
  const validPreferredTick = preferredTick !== null
    && preferredTick >= round.start_tick
    && preferredTick <= round.end_tick
    ? preferredTick
    : null;

  return {
    frames: scopedFrames,
    initialIndex: validPreferredTick === null ? 0 : firstFrameAtOrAfter(scopedFrames, validPreferredTick),
  };
}

export function nextScopedFrameIndex(currentIndex: number, frameCount: number): number {
  if (frameCount < 2 || currentIndex >= frameCount - 1) return 0;
  return Math.max(0, currentIndex + 1);
}

function firstFrameAtOrAfter(frames: readonly { tick: number }[], targetTick: number): number {
  if (frames.length === 0) return 0;
  let low = 0;
  let high = frames.length - 1;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if ((frames[middle]?.tick ?? 0) < targetTick) low = middle + 1;
    else high = middle;
  }
  return (frames[low]?.tick ?? 0) < targetTick ? frames.length - 1 : low;
}
