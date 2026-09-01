import type { TimelineClip, TimelineTrack } from '../../shared/desktop/dto';
import { snapTimeToFrame } from './timelineInteraction';

export interface TimelineTrackClipUpdate {
  readonly trackId: string;
  readonly clips: readonly TimelineClip[];
}

interface StoryTimeAnchor {
  readonly time: number;
  readonly offset: number;
}

function snapSignedTimeToFrame(seconds: number, fps: number): number {
  return Math.round(seconds * Math.max(1, fps)) / Math.max(1, fps);
}

function sameOrder(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

function storyOffsetAt(anchors: readonly StoryTimeAnchor[], time: number, tolerance: number): number {
  for (let index = anchors.length - 1; index >= 0; index -= 1) {
    const anchor = anchors[index]!;
    if (time >= anchor.time - tolerance) return anchor.offset;
  }
  return 0;
}

/**
 * Describe a monotonic Story ripple as offsets at stable Story identities.
 * Reorders intentionally return no anchors: moving Story shots is content
 * reordering, not an insert/extract that should drag unrelated free tracks.
 */
export function storyRippleTimeAnchors(
  before: readonly TimelineClip[],
  after: readonly TimelineClip[],
  fps: number,
): readonly StoryTimeAnchor[] {
  const beforeIds = new Set(before.map((clip) => clip.id));
  const afterIds = new Set(after.map((clip) => clip.id));
  const commonBefore = before.filter((clip) => afterIds.has(clip.id));
  const commonAfter = after.filter((clip) => beforeIds.has(clip.id));
  if (!sameOrder(commonBefore.map((clip) => clip.id), commonAfter.map((clip) => clip.id))) return [];

  const afterById = new Map(after.map((clip) => [clip.id, clip]));
  const frame = 1 / Math.max(1, fps);
  const anchors = commonBefore.map((clip): StoryTimeAnchor => ({
    time: clip.placement.start,
    offset: afterById.get(clip.id)!.placement.start - clip.placement.start,
  }));
  const beforeEnd = before.reduce(
    (maximum, clip) => Math.max(maximum, clip.placement.start + clip.placement.duration),
    0,
  );
  const afterEnd = after.reduce(
    (maximum, clip) => Math.max(maximum, clip.placement.start + clip.placement.duration),
    0,
  );
  anchors.push({ time: beforeEnd, offset: afterEnd - beforeEnd });
  anchors.sort((left, right) => left.time - right.time);

  const compact: StoryTimeAnchor[] = [];
  for (const anchor of anchors) {
    const normalized = {
      time: snapTimeToFrame(anchor.time, fps),
      offset: snapSignedTimeToFrame(anchor.offset, fps),
    };
    const previous = compact.at(-1);
    if (previous !== undefined && Math.abs(previous.time - normalized.time) < frame / 2) {
      compact[compact.length - 1] = normalized;
      continue;
    }
    if (previous !== undefined && Math.abs(previous.offset - normalized.offset) < frame / 2) continue;
    compact.push(normalized);
  }
  return compact.filter((anchor) => Math.abs(anchor.offset) >= frame / 2);
}

/**
 * Apply one Story insert/extract/ripple map to every eligible free track.
 * Items that cross an edit boundary stay fixed, matching Premiere's default
 * trim preference; items beginning on or after that boundary inherit the
 * latest Story offset.
 */
export function planSyncLockedStoryRipple({
  tracks,
  storyTrackId,
  nextStoryClips,
  syncLockedTrackIds,
  directlyEditedTrackIds,
  fps,
}: {
  readonly tracks: readonly TimelineTrack[];
  readonly storyTrackId: string;
  readonly nextStoryClips: readonly TimelineClip[];
  readonly syncLockedTrackIds: ReadonlySet<string>;
  readonly directlyEditedTrackIds: ReadonlySet<string>;
  readonly fps: number;
}): readonly TimelineTrackClipUpdate[] {
  const story = tracks.find((track) => track.id === storyTrackId);
  if (story === undefined) return [];
  const anchors = storyRippleTimeAnchors(story.clips, nextStoryClips, fps);
  if (anchors.length === 0) return [];
  const frame = 1 / Math.max(1, fps);

  return tracks.flatMap((track): TimelineTrackClipUpdate[] => {
    if (track.id === storyTrackId
      || track.locked
      || directlyEditedTrackIds.has(track.id)
      || !syncLockedTrackIds.has(track.id)) return [];
    let changed = false;
    const clips = track.clips.map((clip) => {
      const clipStart = clip.placement.start;
      const offset = storyOffsetAt(anchors, clipStart, frame / 2);
      if (Math.abs(offset) < frame / 2) return clip;
      changed = true;
      return {
        ...clip,
        placement: {
          ...clip.placement,
          start: snapTimeToFrame(Math.max(0, clipStart + offset), fps),
        },
      };
    });
    return changed ? [{ trackId: track.id, clips }] : [];
  });
}

export function expandSyncLockedStoryRippleUpdates({
  tracks,
  storyTrackId,
  updates,
  syncLockedTrackIds,
  fps,
}: {
  readonly tracks: readonly TimelineTrack[];
  readonly storyTrackId: string;
  readonly updates: readonly TimelineTrackClipUpdate[];
  readonly syncLockedTrackIds: ReadonlySet<string>;
  readonly fps: number;
}): readonly TimelineTrackClipUpdate[] {
  const storyUpdate = updates.find((update) => update.trackId === storyTrackId);
  if (storyUpdate === undefined) return updates;
  const directTrackIds = new Set(updates.map((update) => update.trackId));
  const synced = planSyncLockedStoryRipple({
    tracks,
    storyTrackId,
    nextStoryClips: storyUpdate.clips,
    syncLockedTrackIds,
    directlyEditedTrackIds: directTrackIds,
    fps,
  });
  if (synced.length === 0) return updates;
  const byTrackId = new Map(synced.map((update) => [update.trackId, update]));
  for (const update of updates) byTrackId.set(update.trackId, update);
  return tracks.flatMap((track) => {
    const update = byTrackId.get(track.id);
    return update === undefined ? [] : [update];
  });
}
