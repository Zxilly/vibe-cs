import type { TimelineClipMaterial } from '../../shared/desktop/dto';

export type TimelineWaveformLocator =
  | { readonly kind: 'asset'; readonly id: string }
  | { readonly kind: 'take'; readonly id: string }
  | null;

export interface TimelineMaterialView {
  readonly streamAssetId: string | null;
  readonly waveform: TimelineWaveformLocator;
  readonly state: 'planned' | 'recorded';
}

/** One material interpretation shared by preview, thumbnails, and waveforms. */
export function resolveTimelineMaterial(material: TimelineClipMaterial): TimelineMaterialView {
  if (material.kind === 'planned') {
    return { streamAssetId: null, waveform: null, state: 'planned' };
  }
  if (material.kind === 'take') {
    return {
      streamAssetId: material.asset_id,
      waveform: { kind: 'take', id: material.take_id },
      state: 'recorded',
    };
  }
  return {
    streamAssetId: material.asset_id,
    waveform: { kind: 'asset', id: material.asset_id },
    state: 'recorded',
  };
}
