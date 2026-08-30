import type { TimelineClip, TimelineTrack } from '../../shared/desktop/dto';
import { splitRippleClip } from './timelineEditing';

export interface TimelineAddEditUpdate {
  readonly trackId: string;
  readonly clips: readonly TimelineClip[];
}

export interface TimelineAddEditPlan {
  readonly updates: readonly TimelineAddEditUpdate[];
  readonly rightClipIds: readonly string[];
}

export function planTimelineAddEdit({
  tracks,
  targetTrackIds,
  timelineTime,
  fps,
  allTracks,
  followLinkedClips,
  createId,
}: {
  readonly tracks: readonly TimelineTrack[];
  readonly targetTrackIds: ReadonlySet<string>;
  readonly timelineTime: number;
  readonly fps: number;
  readonly allTracks: boolean;
  readonly followLinkedClips: boolean;
  readonly createId: () => string;
}): TimelineAddEditPlan | null {
  const frame = 1 / Math.max(1, fps);
  const editableTracks = tracks.filter((track) => !track.locked);
  const candidates = new Map<string, { readonly track: TimelineTrack; readonly clip: TimelineClip }>();
  const addActiveClips = (track: TimelineTrack) => {
    for (const clip of track.clips) {
      if (timelineTime <= clip.placement.start + frame * 0.5
        || timelineTime >= clip.placement.start + clip.placement.duration - frame * 0.5) continue;
      candidates.set(clip.id, { track, clip });
    }
  };
  for (const track of editableTracks) {
    if (allTracks || targetTrackIds.has(track.id)) addActiveClips(track);
  }
  if (followLinkedClips) {
    const linkedGroups = new Set([...candidates.values()].flatMap(({ clip }) => (
      clip.link_group_id === null ? [] : [clip.link_group_id]
    )));
    if (linkedGroups.size > 0) {
      for (const track of editableTracks) {
        for (const clip of track.clips) {
          if (clip.link_group_id === null || !linkedGroups.has(clip.link_group_id)) continue;
          if (timelineTime <= clip.placement.start + frame * 0.5
            || timelineTime >= clip.placement.start + clip.placement.duration - frame * 0.5) continue;
          candidates.set(clip.id, { track, clip });
        }
      }
    }
  }
  if (candidates.size === 0) return null;

  const candidatesByTrack = new Map<string, { readonly clip: TimelineClip; readonly rightId: string }[]>();
  for (const { track, clip } of candidates.values()) {
    const current = candidatesByTrack.get(track.id) ?? [];
    current.push({ clip, rightId: createId() });
    candidatesByTrack.set(track.id, current);
  }
  const linkCounts = new Map<string, number>();
  for (const { clip } of candidates.values()) {
    if (clip.link_group_id !== null) {
      linkCounts.set(clip.link_group_id, (linkCounts.get(clip.link_group_id) ?? 0) + 1);
    }
  }
  const rightLinkIds = new Map<string, string>();
  for (const [linkId, count] of linkCounts) {
    if (count >= 2) rightLinkIds.set(linkId, createId());
  }

  const rightClipIds: string[] = [];
  const updates = editableTracks.flatMap((track): TimelineAddEditUpdate[] => {
    const trackCandidates = candidatesByTrack.get(track.id);
    if (trackCandidates === undefined) return [];
    let clips = [...track.clips];
    for (const { clip, rightId } of trackCandidates) {
      clips = splitRippleClip(clips, clip.id, timelineTime, rightId).map((candidate) => (
        candidate.id !== rightId
          ? candidate
          : {
              ...candidate,
              group_id: null,
              link_group_id: clip.link_group_id === null ? null : rightLinkIds.get(clip.link_group_id) ?? null,
            }
      ));
      rightClipIds.push(rightId);
    }
    return [{ trackId: track.id, clips }];
  });
  return { updates, rightClipIds };
}
