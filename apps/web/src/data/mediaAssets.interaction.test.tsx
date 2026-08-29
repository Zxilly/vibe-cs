/*
 * `interaction` project — media assets, and the one rule this module exists
 * for: **a write must not drag a minute of DSP behind it.**
 *
 * A waveform decodes the file; an audio analysis runs beat, onset and energy
 * detection over it. Both answer the bytes behind an asset id, so importing a
 * second asset or generating a proxy cannot change them — and the assertions
 * below are the ones that fail if someone later "tidies" the keys so that
 * everything hangs under the asset detail.
 */

import { act, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type { MediaAsset } from '../shared/desktop/dto';
import { qk } from './keys';
import {
  DEFAULT_WAVEFORM_BUCKETS,
  mediaAssetProxyStreamPath,
  mediaAssetStreamPath,
  recordedClipStreamPath,
  useAssetWaveform,
  useAudioAnalysis,
  useDeleteMediaAsset,
  useGenerateMediaProxy,
  useImportMediaAsset,
  useMediaAssets,
  useRelinkMediaAsset,
} from './mediaAssets';
import { countingStub, renderDataHook } from './test/renderDataHook';

function asset(overrides: Partial<MediaAsset> = {}): MediaAsset {
  return {
    id: 'asset-1',
    project_id: null,
    path: 'D:\\music\\low-orbit.mp3',
    name: 'low-orbit.mp3',
    kind: 'audio',
    duration_seconds: 184,
    width: null,
    height: null,
    file_size: 4_200_000,
    has_audio: true,
    proxy_path: null,
    proxy_status: { status: 'not_requested' },
    waveform: null,
    metadata_status: { status: 'ready' },
    created_at: '2026-08-15T09:00:00.000Z',
    ...overrides,
  };
}

const ANALYSIS = {
  duration_seconds: 184,
  analysis_sample_rate: 11_025,
  bpm: 128,
  tempo_confidence: 0.92,
  beats: [],
  onsets: [],
  energy: [],
  sections: [],
  spectral_map: { floor_db: -80, bands: [], points: [] },
  rhythm_diagnostics: {
    onset_rate_per_second: 0,
    strong_onset_rate_per_second: 0,
    dynamic_range_db: 0,
    silence_ratio: 0,
    silence_regions: [],
    recommended_cut_points: [],
  },
  limitations: [],
};

/* ── the rule ────────────────────────────────────────────────────────────── */

describe('an asset write never re-runs a computation over another asset', () => {
  it('leaves the waveform and the analysis alone when a second asset is imported', async () => {
    const list = countingStub({ items: [asset()] });
    const waveform = countingStub({ waveform: [0.1, 0.9], cached: false });
    const analysis = countingStub(ANALYSIS);
    const importAsset = countingStub(asset({ id: 'asset-2' }));

    const { result } = renderDataHook(
      () => ({
        assets: useMediaAssets(null),
        waveform: useAssetWaveform('asset-1'),
        analysis: useAudioAnalysis('asset-1'),
        import: useImportMediaAsset(),
      }),
      {
        client: {
          listMediaAssets: list.call,
          getAssetWaveform: waveform.call,
          analyzeAudioAsset: analysis.call,
          importMediaAsset: importAsset.call,
        },
      },
    );

    await waitFor(() => expect(result.current.assets.isSuccess).toBe(true));
    await waitFor(() => expect(result.current.waveform.isSuccess).toBe(true));
    await waitFor(() => expect(result.current.analysis.isSuccess).toBe(true));
    expect(waveform.calls()).toBe(1);
    expect(analysis.calls()).toBe(1);

    await act(async () => {
      await result.current.import.mutateAsync({ path: 'D:\\music\\other.mp3' });
    });

    /* The list refreshed… */
    await waitFor(() => expect(list.calls()).toBe(2));
    /* …and the two expensive reads did not. */
    expect(waveform.calls()).toBe(1);
    expect(analysis.calls()).toBe(1);
  });

  it('leaves them alone when a proxy is generated for the same asset', async () => {
    const list = countingStub({ items: [asset()] });
    const waveform = countingStub({ waveform: [0.1], cached: true });
    const proxy = countingStub(asset({ proxy_status: { status: 'ready', generated_at: 'x' } }));

    const { result } = renderDataHook(
      () => ({
        assets: useMediaAssets(null),
        waveform: useAssetWaveform('asset-1'),
        proxy: useGenerateMediaProxy(),
      }),
      {
        client: {
          listMediaAssets: list.call,
          getAssetWaveform: waveform.call,
          generateMediaProxy: proxy.call,
        },
      },
    );

    await waitFor(() => expect(result.current.waveform.isSuccess).toBe(true));

    await act(async () => {
      await result.current.proxy.mutateAsync('asset-1');
    });

    await waitFor(() => expect(list.calls()).toBe(2));
    expect(waveform.calls()).toBe(1);
  });
});

/* ── deleting ────────────────────────────────────────────────────────────── */

describe('useDeleteMediaAsset', () => {
  it('drops the cached computations instead of refetching them for a file that is gone', async () => {
    const list = countingStub({ items: [asset()] });
    const waveform = countingStub({ waveform: [0.4], cached: true });
    const remove = countingStub<void>(undefined);

    const { result, queryClient } = renderDataHook(
      () => ({
        assets: useMediaAssets(null),
        waveform: useAssetWaveform('asset-1'),
        remove: useDeleteMediaAsset(),
      }),
      {
        client: {
          listMediaAssets: list.call,
          getAssetWaveform: waveform.call,
          deleteMediaAsset: remove.call,
        },
      },
    );

    await waitFor(() => expect(result.current.waveform.isSuccess).toBe(true));
    expect(
      queryClient.getQueryData(qk.media.waveform('asset-1', DEFAULT_WAVEFORM_BUCKETS)),
    ).toBeDefined();

    await act(async () => {
      await result.current.remove.mutateAsync('asset-1');
    });

    /* Removed, not invalidated: an invalidated waveform for a deleted asset is
       refetched on the next mount and 404s. The live subscription in this tree
       re-creates its own entry, so the assertion is about the *call*, which
       must not have gone up because of the delete. */
    expect(waveform.calls()).toBe(1);
    await waitFor(() => expect(list.calls()).toBe(2));
  });
});

describe('useRelinkMediaAsset', () => {
  it('forgets computations over the old bytes before refreshing the stable asset identity', async () => {
    const list = countingStub({ items: [asset()] });
    const waveform = countingStub({ waveform: [0.4], cached: true });
    const relink = countingStub(asset({ path: 'E:\\moved\\low-orbit.mp3' }));
    const { result } = renderDataHook(
      () => ({
        assets: useMediaAssets(null),
        waveform: useAssetWaveform('asset-1'),
        relink: useRelinkMediaAsset(),
      }),
      {
        client: {
          listMediaAssets: list.call,
          getAssetWaveform: waveform.call,
          relinkMediaAsset: relink.call,
        },
      },
    );

    await waitFor(() => expect(result.current.waveform.isSuccess).toBe(true));
    await act(async () => {
      await result.current.relink.mutateAsync({ id: 'asset-1', path: 'E:\\moved\\low-orbit.mp3' });
    });

    expect(relink.lastArgs()).toEqual(['asset-1', 'E:\\moved\\low-orbit.mp3']);
    await waitFor(() => expect(list.calls()).toBe(2));
    await waitFor(() => expect(waveform.calls()).toBe(2));
  });
});

/* ── reads ───────────────────────────────────────────────────────────────── */

describe('reads', () => {
  it('treats 「整个素材库」 and a project’s library as two different lists', async () => {
    const list = countingStub({ items: [] });
    const { result } = renderDataHook(
      () => ({ all: useMediaAssets(null), scoped: useMediaAssets('project-a') }),
      { client: { listMediaAssets: list.call } },
    );

    await waitFor(() => expect(result.current.all.isSuccess).toBe(true));
    await waitFor(() => expect(result.current.scoped.isSuccess).toBe(true));
    expect(list.calls()).toBe(2);
  });

  it('reads nothing without an asset id', () => {
    const waveform = countingStub({ waveform: [], cached: false });
    const analysis = countingStub(ANALYSIS);
    renderDataHook(
      () => ({ waveform: useAssetWaveform(null), analysis: useAudioAnalysis(null) }),
      {
        client: {
          getAssetWaveform: waveform.call,
          analyzeAudioAsset: analysis.call,
        },
      },
    );

    expect(waveform.calls()).toBe(0);
    expect(analysis.calls()).toBe(0);
  });

  it('caches a different bucket count as a different picture', async () => {
    const waveform = countingStub({ waveform: [], cached: false });
    const { result } = renderDataHook(
      () => ({ small: useAssetWaveform('asset-1', 120), large: useAssetWaveform('asset-1', 480) }),
      { client: { getAssetWaveform: waveform.call } },
    );

    await waitFor(() => expect(result.current.small.isSuccess).toBe(true));
    await waitFor(() => expect(result.current.large.isSuccess).toBe(true));
    expect(waveform.calls()).toBe(2);
  });
});

/* ── media paths ─────────────────────────────────────────────────────────── */

describe('stream paths', () => {
  it('spells the three paths the desktop bridge whitelists', () => {
    expect(mediaAssetStreamPath('a-1')).toBe('/api/media/assets/a-1/stream');
    expect(mediaAssetProxyStreamPath('a-1')).toBe('/api/media/assets/a-1/proxy/stream');
    expect(recordedClipStreamPath('c-1')).toBe('/api/recorded-clips/c-1/stream');
  });

  it('escapes an id rather than pasting it into the path', () => {
    expect(mediaAssetStreamPath('a/1')).toBe('/api/media/assets/a%2F1/stream');
  });
});
