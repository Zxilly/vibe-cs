import { describe, expect, it } from 'vitest';

import { resolveTimelineMaterial } from './timelineMaterial';

describe('resolveTimelineMaterial', () => {
  it('keeps Take streaming on the asset while waveform reads the Take', () => {
    expect(resolveTimelineMaterial({
      kind: 'take',
      take_id: 'take-1',
      asset_id: 'asset-1',
      capture_fingerprint: 'fingerprint',
      media_duration_seconds: 4,
    })).toEqual({
      streamAssetId: 'asset-1',
      waveform: { kind: 'take', id: 'take-1' },
      state: 'recorded',
    });
  });

  it('does not invent media for a planned clip', () => {
    expect(resolveTimelineMaterial({ kind: 'planned' })).toEqual({
      streamAssetId: null,
      waveform: null,
      state: 'planned',
    });
  });
});
