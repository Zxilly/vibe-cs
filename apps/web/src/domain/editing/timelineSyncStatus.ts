import type { JsonValue, TimelineClip } from '../../shared/desktop/dto';
import { moveTimelineClip } from './timelineInteraction';

const SYNC_GROUP_KEY = 'sync_reference_group_id';
const SYNC_START_KEY = 'sync_reference_start';

function metadataRecord(clip: TimelineClip): Record<string, JsonValue> {
  return typeof clip.metadata === 'object' && clip.metadata !== null && !Array.isArray(clip.metadata)
    ? clip.metadata
    : {};
}

function syncReference(clip: TimelineClip): { readonly groupId: string; readonly start: number } | null {
  const metadata = metadataRecord(clip);
  const groupId = metadata[SYNC_GROUP_KEY];
  const start = metadata[SYNC_START_KEY];
  return typeof groupId === 'string' && typeof start === 'number' ? { groupId, start } : null;
}

export function unlinkTimelineClipWithSyncReference(clip: TimelineClip): TimelineClip {
  if (clip.link_group_id === null) return clip;
  return {
    ...clip,
    link_group_id: null,
    metadata: {
      ...metadataRecord(clip),
      [SYNC_GROUP_KEY]: clip.link_group_id,
      [SYNC_START_KEY]: clip.placement.start,
    },
  };
}

export function clearTimelineClipSyncReference(clip: TimelineClip): TimelineClip {
  const metadata = { ...metadataRecord(clip) };
  delete metadata[SYNC_GROUP_KEY];
  delete metadata[SYNC_START_KEY];
  return { ...clip, metadata };
}

export function timelineClipOutOfSyncFrames(
  clip: TimelineClip,
  clips: readonly TimelineClip[],
  fps: number,
): number {
  const reference = syncReference(clip);
  if (reference === null) return 0;
  const peer = clips.find((candidate) => candidate.id !== clip.id && syncReference(candidate)?.groupId === reference.groupId);
  const peerReference = peer === undefined ? null : syncReference(peer);
  if (peer === undefined || peerReference === null) return 0;
  const displacement = clip.placement.start - reference.start;
  const peerDisplacement = peer.placement.start - peerReference.start;
  return Math.round((displacement - peerDisplacement) * Math.max(1, fps));
}

export function restoreTimelineClipSync(
  clip: TimelineClip,
  clips: readonly TimelineClip[],
  fps: number,
): TimelineClip {
  const reference = syncReference(clip);
  if (reference === null) return clip;
  const peer = clips.find((candidate) => candidate.id !== clip.id && syncReference(candidate)?.groupId === reference.groupId);
  const peerReference = peer === undefined ? null : syncReference(peer);
  if (peer === undefined || peerReference === null) return clip;
  const peerDisplacement = peer.placement.start - peerReference.start;
  return moveTimelineClip(clip, reference.start + peerDisplacement, fps);
}
