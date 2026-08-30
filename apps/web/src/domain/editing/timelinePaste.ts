import type { TimelineClip, TimelineTrack } from '../../shared/desktop/dto';
import { overwriteClipsAtTime, placeFreeClipAtTime } from './timelineEditing';
import { planTimelineAddEdit } from './timelineAddEdit';

export interface TimelineClipboardGroup {
  readonly trackId: string;
  readonly trackKind: TimelineTrack['kind'];
  readonly clips: readonly TimelineClip[];
}

export interface TimelineClipboard {
  readonly originTime: number;
  readonly duration: number;
  readonly groups: readonly TimelineClipboardGroup[];
}

export interface TimelinePasteInsertPlan {
  readonly updates: readonly { readonly trackId: string; readonly clips: readonly TimelineClip[] }[];
  readonly pastedClipIds: readonly string[];
}

export type TimelinePasteOverwritePlan = TimelinePasteInsertPlan;

function identityCounts(values: readonly (string | null)[]): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  for (const value of values) {
    if (value !== null) counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return counts;
}

function remapIdentity(
  source: string | null,
  counts: ReadonlyMap<string, number>,
  remapped: Map<string, string>,
  createId: () => string,
): string | null {
  if (source === null || (counts.get(source) ?? 0) < 2) return null;
  const existing = remapped.get(source);
  if (existing !== undefined) return existing;
  const created = createId();
  remapped.set(source, created);
  return created;
}

export function resolveTimelinePasteTargets(
  tracks: readonly TimelineTrack[],
  targetTrackIds: ReadonlySet<string>,
  clipboard: TimelineClipboard,
): readonly TimelineTrack[] | null {
  const orderedTargets = tracks
    .filter((track) => targetTrackIds.has(track.id) && !track.locked)
    .sort((left, right) => left.order - right.order);
  const targetByKind = new Map<TimelineTrack['kind'], TimelineTrack[]>();
  for (const track of orderedTargets) {
    const sameKind = targetByKind.get(track.kind) ?? [];
    sameKind.push(track);
    targetByKind.set(track.kind, sameKind);
  }
  const kindOffsets = new Map<TimelineTrack['kind'], number>();
  const destinations = clipboard.groups.map((group) => {
    const offset = kindOffsets.get(group.trackKind) ?? 0;
    kindOffsets.set(group.trackKind, offset + 1);
    return targetByKind.get(group.trackKind)?.[offset] ?? null;
  });
  return destinations.some((track) => track === null) ? null : destinations as TimelineTrack[];
}

function createPastedByTrack(
  clipboard: TimelineClipboard,
  destinations: readonly TimelineTrack[],
  timelineTime: number,
  createId: () => string,
): { readonly pastedByTrack: ReadonlyMap<string, readonly TimelineClip[]>; readonly pastedClipIds: readonly string[] } {
  const copiedClips = clipboard.groups.flatMap((group) => group.clips);
  const groupCounts = identityCounts(copiedClips.map((clip) => clip.group_id));
  const linkCounts = identityCounts(copiedClips.map((clip) => clip.link_group_id));
  const groupIds = new Map<string, string>();
  const linkIds = new Map<string, string>();
  const pastedClipIds: string[] = [];
  const pastedByTrack = new Map<string, TimelineClip[]>();
  clipboard.groups.forEach((group, groupIndex) => {
    const destination = destinations[groupIndex]!;
    pastedByTrack.set(destination.id, group.clips.map((clip) => {
      const id = createId();
      pastedClipIds.push(id);
      return {
        ...clip,
        id,
        placement: {
          ...clip.placement,
          start: timelineTime + clip.placement.start - clipboard.originTime,
        },
        group_id: remapIdentity(clip.group_id, groupCounts, groupIds, createId),
        link_group_id: remapIdentity(clip.link_group_id, linkCounts, linkIds, createId),
      };
    }));
  });
  return { pastedByTrack, pastedClipIds };
}

export function planTimelinePasteInsert({
  tracks,
  targetTrackIds,
  clipboard,
  timelineTime,
  fps,
  createId,
}: {
  readonly tracks: readonly TimelineTrack[];
  readonly targetTrackIds: ReadonlySet<string>;
  readonly clipboard: TimelineClipboard;
  readonly timelineTime: number;
  readonly fps: number;
  readonly createId: () => string;
}): TimelinePasteInsertPlan | null {
  if (clipboard.groups.length === 0 || clipboard.duration <= 0) return null;
  const destinations = resolveTimelinePasteTargets(tracks, targetTrackIds, clipboard);
  if (destinations === null) return null;
  const { pastedByTrack, pastedClipIds } = createPastedByTrack(clipboard, destinations, timelineTime, createId);

  const destinationIds = new Set(destinations.map((track) => track!.id));
  const cutPlan = planTimelineAddEdit({
    tracks,
    targetTrackIds: destinationIds,
    timelineTime,
    fps,
    allTracks: false,
    followLinkedClips: true,
    createId,
  });
  const workingByTrack = new Map(tracks.map((track) => [track.id, [...track.clips]]));
  for (const update of cutPlan?.updates ?? []) workingByTrack.set(update.trackId, [...update.clips]);
  const affectedIds = new Set([...destinationIds, ...(cutPlan?.updates.map((update) => update.trackId) ?? [])]);
  const updates = tracks.flatMap((track): TimelinePasteInsertPlan['updates'][number][] => {
    if (!affectedIds.has(track.id)) return [];
    let clips = (workingByTrack.get(track.id) ?? []).map((clip) => (
      clip.placement.start < timelineTime - 1e-9
        ? clip
        : { ...clip, placement: { ...clip.placement, start: clip.placement.start + clipboard.duration } }
    ));
    for (const pasted of pastedByTrack.get(track.id) ?? []) {
      clips = placeFreeClipAtTime(clips, pasted, pasted.placement.start);
    }
    return [{ trackId: track.id, clips }];
  });
  return { updates, pastedClipIds };
}

function normalizeExistingLinkGroups(
  tracks: readonly TimelineTrack[],
  updatedByTrack: ReadonlyMap<string, readonly TimelineClip[]>,
  pastedClipIds: ReadonlySet<string>,
  createId: () => string,
): ReadonlyMap<string, readonly TimelineClip[]> {
  const originalLinkIds = new Set(tracks.flatMap((track) => track.clips.flatMap((clip) => (
    clip.link_group_id === null ? [] : [clip.link_group_id]
  ))));
  const finalByTrack = new Map(tracks.map((track) => [track.id, updatedByTrack.get(track.id) ?? track.clips]));
  const assignments = new Map<string, string | null>();
  for (const linkId of originalLinkIds) {
    const buckets = new Map<string, { readonly clip: TimelineClip; readonly trackId: string }[]>();
    for (const [trackId, clips] of finalByTrack) {
      for (const clip of clips) {
        if (clip.link_group_id !== linkId || pastedClipIds.has(clip.id)) continue;
        const key = `${clip.placement.start.toFixed(6)}:${clip.placement.duration.toFixed(6)}`;
        const bucket = buckets.get(key) ?? [];
        bucket.push({ clip, trackId });
        buckets.set(key, bucket);
      }
    }
    let retainedOriginal = false;
    for (const [, bucket] of [...buckets].sort(([left], [right]) => left.localeCompare(right))) {
      const nextLinkId = bucket.length < 2 ? null : retainedOriginal ? createId() : linkId;
      if (nextLinkId !== null) retainedOriginal = true;
      for (const { clip } of bucket) assignments.set(clip.id, nextLinkId);
    }
  }
  if (assignments.size === 0) return updatedByTrack;
  const normalized = new Map<string, readonly TimelineClip[]>();
  for (const track of tracks) {
    const current = finalByTrack.get(track.id) ?? track.clips;
    let changed = updatedByTrack.has(track.id);
    const clips = current.map((clip) => {
      if (!assignments.has(clip.id)) return clip;
      const linkGroupId = assignments.get(clip.id) ?? null;
      if (clip.link_group_id === linkGroupId) return clip;
      changed = true;
      return { ...clip, link_group_id: linkGroupId };
    });
    if (changed) normalized.set(track.id, clips);
  }
  return normalized;
}

export function planTimelinePasteOverwrite({
  tracks,
  targetTrackIds,
  clipboard,
  timelineTime,
  createId,
}: {
  readonly tracks: readonly TimelineTrack[];
  readonly targetTrackIds: ReadonlySet<string>;
  readonly clipboard: TimelineClipboard;
  readonly timelineTime: number;
  readonly createId: () => string;
}): TimelinePasteOverwritePlan | null {
  if (clipboard.groups.length === 0 || clipboard.duration <= 0) return null;
  const destinations = resolveTimelinePasteTargets(tracks, targetTrackIds, clipboard);
  if (destinations === null) return null;
  const { pastedByTrack, pastedClipIds } = createPastedByTrack(clipboard, destinations, timelineTime, createId);
  const updatedByTrack = new Map<string, readonly TimelineClip[]>();
  for (const destination of destinations) {
    let clips = [...destination.clips];
    for (const pasted of [...(pastedByTrack.get(destination.id) ?? [])].sort((left, right) => (
      left.placement.start - right.placement.start
    ))) {
      clips = overwriteClipsAtTime(clips, pasted, pasted.placement.start, createId());
    }
    updatedByTrack.set(destination.id, clips);
  }
  const normalized = normalizeExistingLinkGroups(tracks, updatedByTrack, new Set(pastedClipIds), createId);
  return {
    updates: tracks.flatMap((track) => {
      const clips = normalized.get(track.id);
      return clips === undefined ? [] : [{ trackId: track.id, clips }];
    }),
    pastedClipIds,
  };
}
