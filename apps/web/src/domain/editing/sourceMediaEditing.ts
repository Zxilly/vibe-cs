import type {
  EditingDocument,
  MediaAsset,
  ProjectEditOperation,
  TimelineClip,
  TimelineTrack,
} from '../../shared/desktop/dto';
import { insertRippleClipAtTime, overwriteClipsAtTime, placeFreeClipAtTime, timelineClipFromMediaAsset } from './timelineEditing';

export interface SourceMediaPatch {
  readonly video: boolean;
  readonly audio: boolean;
}

export interface SourceMediaTrackPlan {
  readonly videoTrack: TimelineTrack | null;
  readonly audioTrack: TimelineTrack | null;
  readonly embeddedAudio: boolean;
}

export interface SourceMediaEditPlan {
  readonly operations: readonly ProjectEditOperation[];
  readonly insertedClipIds: readonly string[];
  readonly insertedAudioTrackIndex: number | null;
  readonly selectedAudioTrackId: string | null;
}

export function planSourceMediaEdit({
  document,
  asset,
  sourcePatch,
  tracks,
  mode,
  editTimeSeconds,
  sourceRange,
  newAudioTrackName,
  createId,
}: {
  readonly document: EditingDocument;
  readonly asset: MediaAsset;
  readonly sourcePatch: SourceMediaPatch;
  readonly tracks: SourceMediaTrackPlan;
  readonly mode: 'insert' | 'overwrite';
  readonly editTimeSeconds: number;
  readonly sourceRange?: { readonly sourceIn: number; readonly sourceOut: number } | undefined;
  readonly newAudioTrackName: string;
  readonly createId: () => string;
}): SourceMediaEditPlan | null {
  const baseClip = timelineClipFromMediaAsset(asset, createId(), sourceRange);
  if (baseClip.placement.duration < 1 / document.fps) return null;
  const separateAudio = sourcePatch.audio && !tracks.embeddedAudio;
  const linked = sourcePatch.video && separateAudio ? createId() : null;
  const operations: ProjectEditOperation[] = [];
  const insertedClipIds: string[] = [];
  const placeOnTrack = (track: TimelineTrack, clip: TimelineClip) => mode === 'insert'
    ? track.id === document.story_track_id
      ? insertRippleClipAtTime(track.clips, clip, editTimeSeconds, createId())
      : placeFreeClipAtTime(track.clips, clip, editTimeSeconds)
    : overwriteClipsAtTime(track.clips, clip, editTimeSeconds, createId());

  if (sourcePatch.video && tracks.videoTrack !== null) {
    const videoClip: TimelineClip = {
      ...baseClip,
      link_group_id: linked,
      placement: {
        ...baseClip.placement,
        volume: tracks.embeddedAudio ? 1 : 0,
      },
    };
    insertedClipIds.push(videoClip.id);
    operations.push({
      op: 'replace_track_clips',
      track_id: tracks.videoTrack.id,
      clips: placeOnTrack(tracks.videoTrack, videoClip),
    });
  }

  let insertedAudioTrackIndex: number | null = null;
  let selectedAudioTrackId: string | null = null;
  if (separateAudio) {
    const audioClip: TimelineClip = {
      ...baseClip,
      id: createId(),
      link_group_id: linked,
      placement: { ...baseClip.placement, volume: 1 },
    };
    insertedClipIds.push(audioClip.id);
    if (tracks.audioTrack === null) {
      selectedAudioTrackId = createId();
      insertedAudioTrackIndex = document.tracks.length;
      operations.push({
        op: 'insert_track',
        index: insertedAudioTrackIndex,
        track: {
          id: selectedAudioTrackId,
          name: newAudioTrackName,
          kind: 'audio',
          order: insertedAudioTrackIndex,
          muted: false,
          locked: false,
          hidden: false,
          clips: placeFreeClipAtTime([], audioClip, editTimeSeconds),
        },
      });
    } else {
      selectedAudioTrackId = tracks.audioTrack.id;
      operations.push({
        op: 'replace_track_clips',
        track_id: tracks.audioTrack.id,
        clips: placeOnTrack(tracks.audioTrack, audioClip),
      });
    }
  }

  if (operations.length === 0) return null;
  return {
    operations,
    insertedClipIds,
    insertedAudioTrackIndex,
    selectedAudioTrackId,
  };
}
