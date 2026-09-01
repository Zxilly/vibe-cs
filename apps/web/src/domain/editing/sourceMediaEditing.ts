import type {
  EditingDocument,
  MediaAsset,
  ProjectEditOperation,
  TimelineClip,
  TimelineTrack,
} from '../../shared/desktop/dto';
import { isStillImageMediaAsset, mediaAssetEditDuration, projectMediaAssetKind } from './mediaDrag';
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

export type SourceMediaFitMode = 'fit_to_fill' | 'trim_head' | 'trim_tail' | 'ignore_sequence_in' | 'ignore_sequence_out';

export interface ResolvedSourceMediaFit {
  readonly sourceRange: { readonly sourceIn: number; readonly sourceOut: number };
  readonly editTimeSeconds: number;
  readonly timelineDurationSeconds: number;
  readonly speed: number;
}

export function resolveSourceMediaFit({ sourceRange, sequenceRange, mediaDuration, mode }: {
  readonly sourceRange: { readonly sourceIn: number; readonly sourceOut: number };
  readonly sequenceRange: { readonly start: number; readonly end: number };
  readonly mediaDuration: number;
  readonly mode: SourceMediaFitMode;
}): ResolvedSourceMediaFit | null {
  const sourceDuration = sourceRange.sourceOut - sourceRange.sourceIn;
  const sequenceDuration = sequenceRange.end - sequenceRange.start;
  if (sourceDuration <= 0 || sequenceDuration <= 0) return null;
  if (mode === 'fit_to_fill') {
    return { sourceRange, editTimeSeconds: sequenceRange.start, timelineDurationSeconds: sequenceDuration, speed: sourceDuration / sequenceDuration };
  }
  if (mode === 'trim_head') {
    const sourceIn = sourceRange.sourceOut - sequenceDuration;
    if (sourceIn < 0) return null;
    return { sourceRange: { sourceIn, sourceOut: sourceRange.sourceOut }, editTimeSeconds: sequenceRange.start, timelineDurationSeconds: sequenceDuration, speed: 1 };
  }
  if (mode === 'trim_tail') {
    const sourceOut = sourceRange.sourceIn + sequenceDuration;
    if (sourceOut > mediaDuration) return null;
    return { sourceRange: { sourceIn: sourceRange.sourceIn, sourceOut }, editTimeSeconds: sequenceRange.start, timelineDurationSeconds: sequenceDuration, speed: 1 };
  }
  if (mode === 'ignore_sequence_in') {
    return { sourceRange, editTimeSeconds: Math.max(0, sequenceRange.end - sourceDuration), timelineDurationSeconds: sourceDuration, speed: 1 };
  }
  return { sourceRange, editTimeSeconds: sequenceRange.start, timelineDurationSeconds: sourceDuration, speed: 1 };
}

export function replaceTimelineClipSource({ clip, track, asset, sourceRange }: {
  readonly clip: TimelineClip;
  readonly track: TimelineTrack;
  readonly asset: MediaAsset;
  readonly sourceRange: { readonly sourceIn: number; readonly sourceOut: number };
}): TimelineClip | null {
  if (track.locked || track.kind === 'text' || track.kind === 'caption') return null;
  const assetKind = projectMediaAssetKind(asset);
  if ((track.kind === 'video' || track.kind === 'overlay') && assetKind !== 'video') return null;
  if (track.kind === 'audio' && !asset.has_audio) return null;
  const mediaDuration = mediaAssetEditDuration(asset);
  if (mediaDuration === null || asset.metadata_status.status !== 'ready') return null;
  if (isStillImageMediaAsset(asset) && clip.speed_segments.length > 0) return null;
  const sourceIn = Math.min(mediaDuration, Math.max(0, sourceRange.sourceIn));
  const requiredSourceDuration = clip.speed_segments.length === 0
    ? clip.placement.duration * clip.placement.speed
    : clip.speed_segments.reduce((duration, segment) => (
      duration + (segment.end - segment.start) * segment.speed
    ), 0);
  const sourceOut = sourceIn + requiredSourceDuration;
  if (!isStillImageMediaAsset(asset)
    && (sourceOut > mediaDuration + 1e-6 || sourceOut > sourceRange.sourceOut + 1e-6)) return null;
  const replacementMediaDuration = isStillImageMediaAsset(asset)
    ? Math.max(mediaDuration, sourceOut)
    : mediaDuration;
  return {
    ...clip,
    name: asset.name,
    capture_intent: null,
    material: {
      kind: 'asset',
      asset_id: asset.id,
      media_duration_seconds: replacementMediaDuration,
    },
    placement: {
      ...clip.placement,
      source_in: sourceIn,
      source_out: sourceOut,
    },
    text: null,
    metadata: {
      ...(typeof clip.metadata === 'object' && clip.metadata !== null && !Array.isArray(clip.metadata)
        ? clip.metadata
        : {}),
      media_asset_id: asset.id,
      media_kind: asset.kind,
    },
  };
}

export function planSourceMediaEdit({
  document,
  asset,
  sourcePatch,
  tracks,
  mode,
  editTimeSeconds,
  sourceRange,
  timelineDurationSeconds,
  speed,
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
  readonly timelineDurationSeconds?: number | undefined;
  readonly speed?: number | undefined;
  readonly newAudioTrackName: string;
  readonly createId: () => string;
}): SourceMediaEditPlan | null {
  const sourceClip = timelineClipFromMediaAsset(asset, createId(), sourceRange);
  const baseClip = timelineDurationSeconds === undefined ? sourceClip : {
    ...sourceClip,
    placement: {
      ...sourceClip.placement,
      duration: timelineDurationSeconds,
      speed: speed ?? (sourceClip.placement.source_out - sourceClip.placement.source_in) / timelineDurationSeconds,
    },
  };
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
          solo: false,
          volume: 1,
          pan: 0,
          keyframes: [],
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
