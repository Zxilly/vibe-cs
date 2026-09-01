import type { EditingDocument, MediaAsset, ProjectEditOperation, TimelineClip, TimelineTrack } from '../../shared/desktop/dto';
import { isStillImageMediaAsset, mediaAssetEditDuration, projectMediaAssetKind } from './mediaDrag';
import { insertRippleClipAtTime, overwriteClipsAtTime, timelineClipFromMediaAsset } from './timelineEditing';
import { planDefaultTimelineTransitions } from './timelineTransitions';

export type AutomateSequencePlacement = 'sequential' | 'markers';
export type AutomateSequenceMethod = 'insert' | 'overwrite';

export interface AutomateSequencePlan {
  readonly operations: readonly ProjectEditOperation[];
  readonly insertedClipIds: readonly string[];
}

export function planAutomateToSequence({
  document,
  assets,
  placement,
  method,
  startTime,
  applyDefaultTransitions,
  createId,
}: {
  readonly document: EditingDocument;
  readonly assets: readonly MediaAsset[];
  readonly placement: AutomateSequencePlacement;
  readonly method: AutomateSequenceMethod;
  readonly startTime: number;
  readonly applyDefaultTransitions: boolean;
  readonly createId: () => string;
}): AutomateSequencePlan | null {
  const story = document.tracks.find((track) => track.id === document.story_track_id);
  if (story === undefined || story.locked || assets.length === 0) return null;
  const ready = assets.filter((asset) => projectMediaAssetKind(asset) === 'video'
    && asset.metadata_status.status === 'ready'
    && mediaAssetEditDuration(asset) !== null);
  if (ready.length !== assets.length) return null;
  const overlap = applyDefaultTransitions && placement === 'sequential' ? 0.5 : 0;
  const sourceClip = (asset: MediaAsset): TimelineClip | null => {
    const duration = mediaAssetEditDuration(asset);
    if (duration === null) return null;
    const handle = isStillImageMediaAsset(asset) || duration <= overlap + 1 / document.fps ? 0 : overlap / 2;
    return timelineClipFromMediaAsset(
      asset,
      createId(),
      handle === 0 ? undefined : { sourceIn: handle, sourceOut: duration - handle },
    );
  };
  const clips = ready.map(sourceClip);
  if (clips.some((clip) => clip === null)) return null;
  const inserted = clips.filter((clip): clip is TimelineClip => clip !== null);
  let storyClips = [...story.clips];
  if (placement === 'sequential') {
    let cursor = Math.max(0, startTime);
    for (const clip of inserted) {
      storyClips = method === 'insert'
        ? insertRippleClipAtTime(storyClips, clip, cursor, createId())
        : overwriteClipsAtTime(storyClips, clip, cursor, createId());
      cursor += clip.placement.duration;
    }
  } else {
    const markerTimes = [...document.markers]
      .sort((left, right) => left.time - right.time)
      .slice(0, inserted.length)
      .map((marker) => marker.time);
    if (markerTimes.length < inserted.length) return null;
    const placements = inserted.map((clip, index) => ({ clip, time: markerTimes[index]! }));
    const ordered = method === 'insert' ? [...placements].reverse() : placements;
    for (const item of ordered) {
      storyClips = method === 'insert'
        ? insertRippleClipAtTime(storyClips, item.clip, item.time, createId())
        : overwriteClipsAtTime(storyClips, item.clip, item.time, createId());
    }
  }
  if (applyDefaultTransitions && placement === 'sequential') {
    const updatedStory: TimelineTrack = { ...story, clips: storyClips };
    const transition = planDefaultTimelineTransitions({
      tracks: document.tracks.map((track) => track.id === story.id ? updatedStory : track),
      storyTrackId: story.id,
      targetTrackIds: new Set([story.id]),
      selectedClipIds: new Set(inserted.map((clip) => clip.id)),
      timelineTime: startTime,
      channel: 'video',
      mode: 'selection',
      fps: document.fps,
      defaultDurationSeconds: overlap,
    }).find((update) => update.trackId === story.id);
    if (transition !== undefined) storyClips = [...transition.clips];
  }
  return {
    operations: [{ op: 'replace_track_clips', track_id: story.id, clips: storyClips }],
    insertedClipIds: inserted.map((clip) => clip.id),
  };
}
