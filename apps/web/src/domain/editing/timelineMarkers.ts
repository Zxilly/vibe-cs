import type { EditorMarker, TimelineClip } from '../../shared/desktop/dto';
import { storyRippleOffsetAt, storyRippleTimeAnchors } from './timelineSyncLock';

export interface TimelineMarkerRipplePlan {
  readonly markers: readonly EditorMarker[];
}

/**
 * Uses the same cumulative Story time shifts as Sync Lock.
 * Marker starts and ends are transformed independently so a duration marker
 * spanning the edit point grows or shrinks with the edited sequence time.
 */
export function planRippleSequenceMarkers(
  markers: readonly EditorMarker[],
  before: readonly TimelineClip[],
  after: readonly TimelineClip[],
  enabled: boolean,
  fps: number,
): TimelineMarkerRipplePlan | null {
  if (!enabled || markers.length === 0) return null;
  const frame = 1 / Math.max(1, fps);
  const anchors = storyRippleTimeAnchors(before, after, fps);
  if (anchors.length === 0) return null;
  const shift = (time: number) => Math.max(0, time + storyRippleOffsetAt(anchors, time, frame / 2));
  return {
    markers: markers.map((marker) => {
      const start = shift(marker.time);
      const end = shift(marker.time + marker.duration);
      return { ...marker, time: start, duration: Math.max(0, end - start) };
    }),
  };
}

