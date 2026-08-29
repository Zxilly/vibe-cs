import type { MediaAsset } from '../../shared/desktop/dto';

export const PROJECT_MEDIA_DRAG_TYPE = 'application/x-vibe-cs-media-asset';

export interface ProjectMediaDragPayload {
  readonly assetId: string;
  readonly kind: 'video' | 'audio';
  readonly durationSeconds: number;
}

export interface ProjectMediaDataTransfer {
  readonly types: readonly string[];
  effectAllowed: string;
  dropEffect: string;
  getData: (format: string) => string;
  setData: (format: string, data: string) => void;
}

let activeDrag: ProjectMediaDragPayload | null = null;

export function projectMediaAssetKind(asset: MediaAsset): 'video' | 'audio' {
  return asset.kind.toLocaleLowerCase().includes('audio') ? 'audio' : 'video';
}

export function writeProjectMediaDrag(
  transfer: ProjectMediaDataTransfer,
  asset: MediaAsset,
): ProjectMediaDragPayload | null {
  const durationSeconds = asset.duration_seconds;
  if (asset.metadata_status.status !== 'ready'
    || durationSeconds === null
    || !Number.isFinite(durationSeconds)
    || durationSeconds <= 0) return null;
  const payload: ProjectMediaDragPayload = {
    assetId: asset.id,
    kind: projectMediaAssetKind(asset),
    durationSeconds,
  };
  transfer.effectAllowed = 'copy';
  transfer.setData(PROJECT_MEDIA_DRAG_TYPE, JSON.stringify(payload));
  activeDrag = payload;
  return payload;
}

export function hasProjectMediaDrag(transfer: ProjectMediaDataTransfer): boolean {
  return activeDrag !== null || transfer.types.includes(PROJECT_MEDIA_DRAG_TYPE);
}

export function readProjectMediaDrag(
  transfer: ProjectMediaDataTransfer,
): ProjectMediaDragPayload | null {
  const encoded = transfer.getData(PROJECT_MEDIA_DRAG_TYPE);
  if (encoded === '') return activeDrag;
  try {
    const value: unknown = JSON.parse(encoded);
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    if (typeof record.assetId !== 'string' || record.assetId.length === 0 || record.assetId.length > 128) return null;
    if (record.kind !== 'video' && record.kind !== 'audio') return null;
    if (typeof record.durationSeconds !== 'number'
      || !Number.isFinite(record.durationSeconds)
      || record.durationSeconds <= 0
      || record.durationSeconds > 21_600) return null;
    return {
      assetId: record.assetId,
      kind: record.kind,
      durationSeconds: record.durationSeconds,
    };
  } catch {
    return null;
  }
}

export function clearProjectMediaDrag(): void {
  activeDrag = null;
}
