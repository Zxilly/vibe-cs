import { describe, expect, it } from 'vitest';

import type { MediaAsset } from '../../shared/desktop/dto';
import {
  clearProjectMediaDrag,
  PROJECT_MEDIA_DRAG_TYPE,
  readProjectMediaDrag,
  writeProjectMediaDrag,
  type ProjectMediaDataTransfer,
} from './mediaDrag';

function transfer(): ProjectMediaDataTransfer {
  const values = new Map<string, string>();
  return {
    get types() { return [...values.keys()]; },
    effectAllowed: 'none',
    dropEffect: 'none',
    getData: (format) => values.get(format) ?? '',
    setData: (format, data) => values.set(format, data),
  };
}

function asset(
  kind: string,
  duration: number | null = 8,
  metadataStatus: MediaAsset['metadata_status'] = { status: 'ready' },
): MediaAsset {
  return {
    id: 'asset-1',
    project_id: 'project-1',
    path: 'D:\\media\\source.wav',
    name: 'Source',
    kind,
    duration_seconds: duration,
    width: null,
    height: null,
    file_size: 1,
    has_audio: true,
    proxy_path: null,
    proxy_status: { status: 'not_requested' },
    waveform: null,
    metadata_status: metadataStatus,
    markers: [],
    created_at: '2026-08-30T00:00:00Z',
  };
}

describe('Project Media drag payload', () => {
  it('carries only bounded placement hints and keeps asset identity authoritative', () => {
    const data = transfer();
    expect(writeProjectMediaDrag(data, asset('audio'))).toEqual({
      assetId: 'asset-1',
      kind: 'audio',
      durationSeconds: 8,
    });
    expect(data.effectAllowed).toBe('copy');
    expect(data.types).toEqual([PROJECT_MEDIA_DRAG_TYPE]);
    expect(readProjectMediaDrag(data)).toEqual({ assetId: 'asset-1', kind: 'audio', durationSeconds: 8 });
    clearProjectMediaDrag();
  });

  it('rejects missing duration and malformed external payloads', () => {
    expect(writeProjectMediaDrag(transfer(), asset('video', null))).toBeNull();
    expect(writeProjectMediaDrag(
      transfer(),
      asset('video', 8, { status: 'unavailable', message: 'missing' }),
    )).toBeNull();
    const data = transfer();
    data.setData(PROJECT_MEDIA_DRAG_TYPE, JSON.stringify({ assetId: '', kind: 'shell', durationSeconds: -1 }));
    clearProjectMediaDrag();
    expect(readProjectMediaDrag(data)).toBeNull();
  });

  it('gives still images a bounded editing duration without inventing source media time', () => {
    expect(writeProjectMediaDrag(transfer(), asset('image/png', 0.04))).toEqual({
      assetId: 'asset-1',
      kind: 'video',
      durationSeconds: 5,
    });
    clearProjectMediaDrag();
  });
});
