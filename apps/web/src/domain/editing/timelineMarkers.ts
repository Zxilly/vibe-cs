import type { EditorMarker, TimelineClip } from '../../shared/desktop/dto';

export interface TimelineMarkerRipplePlan {
  readonly markers: readonly EditorMarker[];
  readonly pivot: number;
  readonly delta: number;
}

/**
 * Derives the one downstream time shift represented by a gapless Story edit.
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
  const beforeById = new Map(before.map((clip) => [clip.id, clip]));
  const shifted = after.flatMap((clip) => {
    const previous = beforeById.get(clip.id);
    if (previous === undefined) return [];
    const delta = clip.placement.start - previous.placement.start;
    return Math.abs(delta) <= 0.5 * frame ? [] : [{ previous, delta }];
  });
  let pivot: number;
  let delta: number;
  if (shifted.length > 0) {
    delta = shifted[0]!.delta;
    if (shifted.some((item) => Math.abs(item.delta - delta) > 0.5 * frame)) return null;
    pivot = Math.min(...shifted.map((item) => item.previous.placement.start));
  } else {
    const beforeEnd = storyEnd(before);
    const afterEnd = storyEnd(after);
    delta = afterEnd - beforeEnd;
    if (Math.abs(delta) <= 0.5 * frame) return null;
    pivot = beforeEnd;
  }
  const shift = (time: number) => time >= pivot - 0.5 * frame ? Math.max(0, time + delta) : time;
  return {
    markers: markers.map((marker) => {
      const start = shift(marker.time);
      const end = shift(marker.time + marker.duration);
      return { ...marker, time: start, duration: Math.max(0, end - start) };
    }),
    pivot,
    delta,
  };
}

function storyEnd(clips: readonly TimelineClip[]): number {
  return clips.reduce((end, clip) => Math.max(end, clip.placement.start + clip.placement.duration), 0);
}
