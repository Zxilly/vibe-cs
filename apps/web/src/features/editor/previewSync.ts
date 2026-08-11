export type PreviewMediaTarget = Pick<
  HTMLMediaElement,
  'currentTime' | 'duration' | 'pause' | 'play' | 'playbackRate' | 'volume'
>;

export function synchronizeMediaPreview(
  element: PreviewMediaTarget,
  desiredTime: number,
  volume: number,
  playbackRate: number,
  playing: boolean,
): void {
  element.volume = Math.max(0, Math.min(1, volume));
  element.playbackRate = Math.max(0.05, Math.min(16, playbackRate));
  if (Number.isFinite(element.duration) && element.duration >= 0) {
    const boundedTime = Math.max(0, Math.min(element.duration, desiredTime));
    if (Math.abs(element.currentTime - boundedTime) > 0.15) element.currentTime = boundedTime;
  }
  if (playing) {
    void element.play().catch(() => undefined);
  } else {
    element.pause();
  }
}
