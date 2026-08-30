import type { TimelineTrack } from '../../shared/desktop/dto';

export function timelineTrackSelection({
  tracks,
  trackId,
  timelineTime,
  direction,
  allTracks,
}: {
  readonly tracks: readonly TimelineTrack[];
  readonly trackId: string;
  readonly timelineTime: number;
  readonly direction: 'forward' | 'backward';
  readonly allTracks: boolean;
}): string[] {
  return [...tracks]
    .sort((left, right) => left.order - right.order)
    .filter((track) => allTracks || track.id === trackId)
    .flatMap((track) => [...track.clips]
      .sort((left, right) => left.placement.start - right.placement.start)
      .filter((clip) => direction === 'forward'
        ? clip.placement.start + clip.placement.duration > timelineTime + 1e-9
        : clip.placement.start < timelineTime - 1e-9)
      .map((clip) => clip.id));
}
