import type { EditorMarker, TimelineTrack } from '../../shared/desktop/dto';

export function timelineEditPoints({
  tracks,
  targetTrackIds,
  allTracks,
  duration,
}: {
  readonly tracks: readonly TimelineTrack[];
  readonly targetTrackIds: ReadonlySet<string>;
  readonly allTracks: boolean;
  readonly duration: number;
}): number[] {
  return [...new Set([
    0,
    duration,
    ...tracks
      .filter((track) => allTracks || targetTrackIds.has(track.id))
      .flatMap((track) => track.clips.flatMap((clip) => [
        clip.placement.start,
        clip.placement.start + clip.placement.duration,
      ])),
  ])].sort((left, right) => left - right);
}

export function adjacentTimelineTime(
  times: readonly number[],
  currentTime: number,
  direction: -1 | 1,
  fps: number,
): number | null {
  const threshold = 0.5 / Math.max(1, fps);
  const next = direction > 0
    ? times.find((time) => time > currentTime + threshold)
    : [...times].reverse().find((time) => time < currentTime - threshold);
  return next ?? null;
}

export function adjacentMarker(
  markers: readonly EditorMarker[],
  currentTime: number,
  direction: -1 | 1,
  fps: number,
): EditorMarker | null {
  const ordered = [...markers].sort((left, right) => left.time - right.time);
  const threshold = 0.5 / Math.max(1, fps);
  return direction > 0
    ? ordered.find((marker) => marker.time > currentTime + threshold) ?? null
    : [...ordered].reverse().find((marker) => marker.time < currentTime - threshold) ?? null;
}
