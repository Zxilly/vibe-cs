import type { TimelineClip } from '../../shared/desktop/dto';

export function timelineThroughEditCuts(clips: readonly TimelineClip[], fps: number): number[] {
  const ordered = [...clips].sort((left, right) => left.placement.start - right.placement.start);
  const tolerance = 0.5 / Math.max(1, fps);
  const cuts: number[] = [];
  for (let index = 0; index < ordered.length - 1; index += 1) {
    const left = ordered[index]!;
    const right = ordered[index + 1]!;
    const cut = left.placement.start + left.placement.duration;
    if (Math.abs(cut - right.placement.start) <= tolerance
      && timelineMaterialKey(left) !== null
      && timelineMaterialKey(left) === timelineMaterialKey(right)
      && left.speed_segments.length === 0
      && right.speed_segments.length === 0
      && Math.abs(left.placement.speed - right.placement.speed) <= 1e-6
      && Math.abs(left.placement.source_out - right.placement.source_in) <= tolerance) cuts.push(cut);
  }
  return cuts;
}

export function repeatedFrameClipIds(clips: readonly TimelineClip[]): ReadonlySet<string> {
  const repeated = new Set<string>();
  for (let leftIndex = 0; leftIndex < clips.length; leftIndex += 1) {
    const left = clips[leftIndex]!;
    const material = timelineMaterialKey(left);
    if (material === null) continue;
    for (let rightIndex = leftIndex + 1; rightIndex < clips.length; rightIndex += 1) {
      const right = clips[rightIndex]!;
      if (timelineMaterialKey(right) !== material) continue;
      const overlap = Math.min(left.placement.source_out, right.placement.source_out)
        - Math.max(left.placement.source_in, right.placement.source_in);
      if (overlap > 1e-6) {
        repeated.add(left.id);
        repeated.add(right.id);
      }
    }
  }
  return repeated;
}

function timelineMaterialKey(clip: TimelineClip): string | null {
  switch (clip.material.kind) {
    case 'asset': return `asset:${clip.material.asset_id}`;
    case 'take': return `take:${clip.material.asset_id}`;
    case 'planned': return null;
  }
}
