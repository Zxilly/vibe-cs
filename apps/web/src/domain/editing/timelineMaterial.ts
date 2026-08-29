import type { TimelineClipMaterial, TimelinePlacement } from '../../shared/desktop/dto';

export type TimelineWaveformLocator =
  | { readonly kind: 'asset'; readonly id: string }
  | { readonly kind: 'take'; readonly id: string }
  | null;

export interface TimelineMaterialView {
  readonly streamAssetId: string | null;
  readonly waveform: TimelineWaveformLocator;
  readonly state: 'planned' | 'recorded' | 'stale';
}

/** One material interpretation shared by preview, thumbnails, and waveforms. */
export function resolveTimelineMaterial(
  material: TimelineClipMaterial,
  placement?: TimelinePlacement,
): TimelineMaterialView {
  if (material.kind === 'planned') {
    return { streamAssetId: null, waveform: null, state: 'planned' };
  }
  if (material.kind === 'take') {
    return {
      streamAssetId: material.asset_id,
      waveform: { kind: 'take', id: material.take_id },
      state: mediaCoversPlacement(material.media_duration_seconds, placement) ? 'recorded' : 'stale',
    };
  }
  return {
    streamAssetId: material.asset_id,
    waveform: { kind: 'asset', id: material.asset_id },
    state: mediaCoversPlacement(material.media_duration_seconds, placement) ? 'recorded' : 'stale',
  };
}

function mediaCoversPlacement(mediaDurationSeconds: number, placement?: TimelinePlacement): boolean {
  return placement === undefined || placement.source_out <= mediaDurationSeconds + 0.001;
}
