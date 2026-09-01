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
      nestedProjectId: null,
      waveform: { kind: 'take', id: 'take-1' },
      state: 'recorded',
    });
  });

  it('does not invent media for a planned clip', () => {
    expect(resolveTimelineMaterial({ kind: 'planned' })).toEqual({
      streamAssetId: null,
      nestedProjectId: null,
      waveform: null,
      state: 'planned',
    });
  });

  it('keeps nested sequence identity separate from media assets', () => {
    expect(resolveTimelineMaterial({
      kind: 'sequence',
      project_id: 'nested-1',
      project_revision: 3,
      media_duration_seconds: 8,
    })).toEqual({
      streamAssetId: null,
      nestedProjectId: 'nested-1',
      waveform: null,
      state: 'recorded',
    });
  });

  it('does not present a Take whose file cannot cover source-out as ready', () => {
    expect(resolveTimelineMaterial(
      {
        kind: 'take',
        take_id: 'take-short',
        asset_id: 'asset-short',
        capture_fingerprint: 'a'.repeat(64),
        media_duration_seconds: 9.97,
      },
      { start: 0, duration: 10, source_in: 0, source_out: 10, speed: 1, reverse: false, frame_hold_source_time: null, volume: 1, pan: 0, enabled: true },
    ).state).toBe('stale');
  });
});
