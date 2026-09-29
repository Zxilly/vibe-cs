import { deflateSync } from 'node:zlib';
import { crc32 } from './compressedBinary';
/**
 * `interaction` project — the match workspace reads and writes.
 *
 * No real IPC: the bridge is a typechecked stub through `DesktopClientProvider`
 * (`demos.interaction.test.tsx` carries the full rationale). What this file
 * adds is the shape peculiar to a match:
 *
 *   · one analysis document feeds eight of the nine views, so it must be one
 *     cache entry;
 *   · everything about a match hangs under one key, so `invalidateMatch` is one
 *     call — but the map's radar must survive it;
 *   · the replay is off unless a view asks for it, because it is megabytes;
 *   · a note invalidates a note, not the search index.
 */

import { act, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type {
  EvidenceAnnotation,
  HeatPointRecord,
  LlmReviewResult,
  RadarOverviewRecord,
  RoundReviewMetadata,
} from '../shared/desktop/dto';
import type { AnalysisWorkspace } from '../shared/desktop/viewModels';
import {
  analysisIsMissing,
  invalidateMatch,
  useCreateMatchAnnotation,
  useGenerateMatchReview,
  useMapRadarOverview,
  useMatchAnalysis,
  useMatchAnnotations,
  useMatchEvidence,
  useMatchHeatPoints,
  useMatchReplay,
  useCameraReplay,
  useRoundReview,
  useUpdateRoundReview,
} from './match';
import { countingStub, renderDataHook } from './test/renderDataHook';

const DEMO_ID = 'aurora-vs-meridian';

const ANALYSIS: AnalysisWorkspace = {
  demo_id: DEMO_ID,
  map_name: 'de_mirage',
  tick_rate: 64,
  duration_seconds: 2_412,
  teams: [
    { name: 'Aurora', side: 'CT', score: 13, players: [] },
    { name: 'Meridian', side: 'T', score: 11, players: [] },
  ],
  players: [],
  rounds: [],
  highlights: [],
};

const HEAT: HeatPointRecord[] = [
  {
    id: 'p-1',
    round: 21,
    tick: 149_380,
    x: -1_200,
    y: 480,
    weight: 1,
    floor: 0,
    kind: 'kill',
    player_id: 'kael',
    side: 'CT',
    event_kind: 'kill',
  },
];

const RADAR: RadarOverviewRecord = {
  map_name: 'de_mirage',
  transform: { pos_x: -3_230, pos_y: 1_713, scale: 5, rotate: false, zoom: null },
  image_url: null,
  image_mime: null,
  browser_displayable: false,
};

const ROUND_REVIEW: RoundReviewMetadata = {
  demo_id: DEMO_ID,
  source_sha256: 'sha',
  round: 21,
  comment: '第 2 杀的穿墙点可作为教学素材。',
  tags: [],
  updated_at: '2026-08-15T10:00:00.000Z',
};

const ANNOTATION: EvidenceAnnotation = {
  id: 'a-1',
  demo_id: DEMO_ID,
  demo_display_name: 'Aurora vs Meridian',
  map_name: 'de_mirage',
  evidence_id: 'e-9',
  round: 21,
  tick: 149_380,
  body: '穿墙点可做教学',
  tags: [],
  review_state: 'open',
  created_at: '2026-08-15T10:00:00.000Z',
  updated_at: '2026-08-15T10:00:00.000Z',
};

/**
 * The smallest valid `ARPL` stream: header, cache block, fidelity block, zero
 * frames. Built here rather than checked in as a fixture file so the assertion
 * is about the wiring — `getReplayBinary` → `decodeReplayBinary` — and not
 * about a blob nobody can read.
 */
function emptyReplayBinary(): ArrayBuffer {
  const encoder = new TextEncoder();
  const cache = encoder.encode(JSON.stringify({ state: 'bypassed', key: null, bytes: 0, generated_at: null, repaired: false, reason: null }));
  const fidelity = encoder.encode(JSON.stringify({ mode: 'entity_snapshots', tick_rate: 64, frame_count: 0, positioned_event_count: 0, start_tick: 0, end_tick: 0 }));
  const payload = new Uint8Array(4 + cache.length + 4 + fidelity.length + 2 + 2 + 4);
  const body = new DataView(payload.buffer);
  body.setUint32(0, cache.length, true); payload.set(cache, 4);
  const next = 4 + cache.length;
  body.setUint32(next, fidelity.length, true); payload.set(fidelity, next + 4);
  const compressed = deflateSync(payload);
  const bytes = new Uint8Array(16 + compressed.length); bytes.set(encoder.encode('ARPL')); bytes.set(compressed, 16);
  const header = new DataView(bytes.buffer); header.setUint16(4, 2, true); header.setUint16(6, 1, true); header.setUint32(8, payload.length, true); header.setUint32(12, crc32(payload), true);
  return bytes.buffer;
}

describe('useMatchAnalysis — the document eight views share', () => {
  it('reads one demo and forwards the abort signal', async () => {
    const analysis = countingStub(ANALYSIS);
    const { result } = renderDataHook(() => useMatchAnalysis(DEMO_ID), {
      client: { getAnalysis: analysis.call as never },
    });

    await waitFor(() => expect(result.current.data).toEqual(ANALYSIS));
    expect(analysis.lastArgs()[0]).toBe(DEMO_ID);
    expect(analysis.lastArgs()[1]).toBeInstanceOf(AbortSignal);
  });

  it('is one cache entry no matter how many views ask for it', async () => {
    const analysis = countingStub(ANALYSIS);
    const { result } = renderDataHook(
      () => [useMatchAnalysis(DEMO_ID), useMatchAnalysis(DEMO_ID), useMatchAnalysis(DEMO_ID)],
      { client: { getAnalysis: analysis.call as never } },
    );

    await waitFor(() => expect(result.current[0]?.data).toEqual(ANALYSIS));
    expect(analysis.calls()).toBe(1);
  });

  it('does not read at all without a demo', () => {
    const analysis = countingStub(ANALYSIS);
    renderDataHook(() => useMatchAnalysis(null), {
      client: { getAnalysis: analysis.call as never },
    });
    expect(analysis.calls()).toBe(0);
  });

  it('surfaces the failure rather than throwing it at a boundary', async () => {
    const analysis = countingStub(ANALYSIS);
    analysis.fail(new Error('解析结果不可用'));
    const { result } = renderDataHook(() => useMatchAnalysis(DEMO_ID), {
      client: { getAnalysis: analysis.call as never },
    });

    await waitFor(() => expect(result.current.isError).toBe(true));
  });

  it('tells 「还没分析」 from 「打不开」, because the recovery differs', () => {
    // A 404 is the unanalysed demo — the recovery is 开始分析, and rendering it
    // as an error would hide the one action that fixes it.
    expect(analysisIsMissing({ status: 404 })).toBe(true);
    expect(analysisIsMissing({ status: 500 })).toBe(false);
    expect(analysisIsMissing(new Error('offline'))).toBe(false);
  });
});

describe('invalidateMatch — one call reaches everything about one match', () => {
  it('refetches the analysis and the heat points, and leaves the radar alone', async () => {
    const analysis = countingStub(ANALYSIS);
    const heat = countingStub(HEAT);
    const radar = countingStub(RADAR);

    const { result, queryClient } = renderDataHook(
      () => ({
        analysis: useMatchAnalysis(DEMO_ID),
        heat: useMatchHeatPoints(DEMO_ID),
        radar: useMapRadarOverview('de_mirage'),
      }),
      {
        client: {
          getAnalysis: analysis.call as never,
          getHeatmap: heat.call as never,
          getRadarOverview: radar.call as never,
        },
      },
    );

    await waitFor(() => expect(result.current.radar.data).toEqual(RADAR));
    expect([analysis.calls(), heat.calls(), radar.calls()]).toEqual([1, 1, 1]);

    await act(async () => {
      await invalidateMatch(queryClient, DEMO_ID);
    });

    await waitFor(() => expect(analysis.calls()).toBe(2));
    expect(heat.calls()).toBe(2);
    // The calibration belongs to the map — a new analysis of this demo cannot
    // move it, and every other demo on Mirage shares the entry.
    expect(radar.calls()).toBe(1);
  });

  it('does not touch another match', async () => {
    const analysis = countingStub(ANALYSIS);
    const { result, queryClient } = renderDataHook(
      () => useMatchAnalysis('other-demo'),
      { client: { getAnalysis: analysis.call as never } },
    );

    await waitFor(() => expect(result.current.data).toEqual(ANALYSIS));
    await act(async () => {
      await invalidateMatch(queryClient, DEMO_ID);
    });
    expect(analysis.calls()).toBe(1);
  });
});

describe('the replay view’s reads', () => {
  it('keys the radar by map, so two maps are two entries', async () => {
    const radar = countingStub(RADAR);
    const { result } = renderDataHook(
      () => [useMapRadarOverview('de_mirage'), useMapRadarOverview('de_nuke')],
      { client: { getRadarOverview: radar.call as never } },
    );

    await waitFor(() => expect(result.current[0]?.data).toEqual(RADAR));
    await waitFor(() => expect(radar.calls()).toBe(2));
  });

  it('asks for no radar without a map name', () => {
    const radar = countingStub(RADAR);
    renderDataHook(() => useMapRadarOverview(''), {
      client: { getRadarOverview: radar.call as never },
    });
    expect(radar.calls()).toBe(0);
  });

  it('does not fetch the replay until a view asks for it', () => {
    const replay = countingStub(emptyReplayBinary());
    renderDataHook(() => useMatchReplay(DEMO_ID), {
      client: { getReplayBinary: replay.call as never },
    });
    // Seven of the nine views never want megabytes of frames.
    expect(replay.calls()).toBe(0);
  });

  it('decodes the binary once enabled', async () => {
    const replay = countingStub(emptyReplayBinary());
    const { result } = renderDataHook(() => useMatchReplay(DEMO_ID, { enabled: true }), {
      client: { getReplayBinary: replay.call as never },
    });

    await waitFor(() => expect(result.current.data?.fidelity.tick_rate).toBe(64));
    expect(result.current.data?.frames).toEqual([]);
    expect(replay.calls()).toBe(1);
  });

  it('loads camera actors from the preview producer and never from the latest demo replay', async () => {
    const round = countingStub(emptyReplayBinary());
    const latest = countingStub(emptyReplayBinary());
    const source = { demoId: DEMO_ID, producerRunId: 'exact-run' };
    let enabled = false;
    const { result, rerender } = renderDataHook(() => useCameraReplay(enabled ? source : null), {
      client: { getAnalysisRunReplayBinary: round.call as never, getReplayBinary: latest.call as never },
    });
    expect(round.calls()).toBe(0);
    enabled = true;
    rerender();
    await waitFor(() => expect(result.current.data?.fidelity.tick_rate).toBe(64));
    expect(round.calls()).toBe(1);
    expect(round.lastArgs()).toEqual(['exact-run', expect.any(AbortSignal)]);
    expect(latest.calls()).toBe(0);
  });
});

describe('round review — the note on a round', () => {
  it('reads one round and nothing when none is selected', async () => {
    const review = countingStub(ROUND_REVIEW);
    const { result, rerender } = renderDataHook(() => useRoundReview(DEMO_ID, 21), {
      client: { getRoundReviewMetadata: review.call as never },
    });

    await waitFor(() => expect(result.current.data).toEqual(ROUND_REVIEW));
    expect(review.lastArgs()[1]).toBe(21);
    rerender();
    expect(review.calls()).toBe(1);
  });

  it('is not read at all with no round selected', () => {
    const review = countingStub(ROUND_REVIEW);
    renderDataHook(() => useRoundReview(DEMO_ID, null), {
      client: { getRoundReviewMetadata: review.call as never },
    });
    expect(review.calls()).toBe(0);
  });

  it('refreshes only the round it wrote — not the whole analysis', async () => {
    const review = countingStub(ROUND_REVIEW);
    const other = countingStub({ ...ROUND_REVIEW, round: 7 });
    const analysis = countingStub(ANALYSIS);
    const write = countingStub(ROUND_REVIEW);

    const { result } = renderDataHook(
      () => ({
        analysis: useMatchAnalysis(DEMO_ID),
        round21: useRoundReview(DEMO_ID, 21),
        round7: useRoundReview(DEMO_ID, 7),
        update: useUpdateRoundReview(),
      }),
      {
        client: {
          getAnalysis: analysis.call as never,
          getRoundReviewMetadata: ((_demo: string, round: number) =>
            round === 21 ? review.call() : other.call()) as never,
          updateRoundReviewMetadata: write.call as never,
        },
      },
    );

    await waitFor(() => expect(result.current.round7.data?.round).toBe(7));
    expect([analysis.calls(), review.calls(), other.calls()]).toEqual([1, 1, 1]);

    await act(async () => {
      await result.current.update.mutateAsync({
        demoId: DEMO_ID,
        round: 21,
        update: { comment: '改了', tag_ids: [] },
      });
    });

    await waitFor(() => expect(review.calls()).toBe(2));
    expect(other.calls()).toBe(1);
    expect(analysis.calls()).toBe(1);
  });
});

describe('evidence, scoped to the match', () => {
  it('pins demo_id so a view cannot leak another match’s evidence in', async () => {
    const search = countingStub({
      items: [],
      total: 0,
      page: 1,
      page_size: 20,
      availability: {
        indexed_items: 0,
        indexed_demos: 0,
        total_analyses: 0,
        scan_complete: true,
        match_date: { available: true, indexed_items: 0, reason: null },
        source: { available: true, indexed_items: 0, reason: null },
      },
    });

    const { result } = renderDataHook(() => useMatchEvidence(DEMO_ID, { round: 21 }), {
      client: { searchEvidence: search.call as never },
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(search.lastArgs()[0]).toEqual({ round: 21, demo_id: DEMO_ID });
  });

  it('a note refreshes notes, not the search index', async () => {
    const search = countingStub({
      items: [],
      total: 0,
      page: 1,
      page_size: 20,
      availability: {
        indexed_items: 0,
        indexed_demos: 0,
        total_analyses: 0,
        scan_complete: true,
        match_date: { available: true, indexed_items: 0, reason: null },
        source: { available: true, indexed_items: 0, reason: null },
      },
    });
    const annotations = countingStub({ items: [ANNOTATION], total: 1, page: 1, page_size: 20 });
    const create = countingStub(ANNOTATION);

    const { result } = renderDataHook(
      () => ({
        search: useMatchEvidence(DEMO_ID),
        notes: useMatchAnnotations(DEMO_ID),
        create: useCreateMatchAnnotation(),
      }),
      {
        client: {
          searchEvidence: search.call as never,
          listEvidenceAnnotations: annotations.call as never,
          createEvidenceAnnotation: create.call as never,
        },
      },
    );

    await waitFor(() => expect(result.current.notes.data?.total).toBe(1));
    expect([search.calls(), annotations.calls()]).toEqual([1, 1]);

    await act(async () => {
      await result.current.create.mutateAsync({
        demo_id: DEMO_ID,
        evidence_id: 'e-9',
        round: 21,
        tick: 149_380,
        body: '穿墙点可做教学',
        tags: [],
      });
    });

    await waitFor(() => expect(annotations.calls()).toBe(2));
    // Re-running every open search after each note is a cost with no answer
    // behind it: an annotation does not change what the index contains.
    expect(search.calls()).toBe(1);
  });
});

describe('AI commentary', () => {
  it('runs only when asked, and invalidates nothing', async () => {
    const result_: LlmReviewResult = {
      demo_id: DEMO_ID,
      scope: 'match',
      player_id: null,
      highlight_ids: [],
      tone: 'analytical',
      commentary: 'Aurora 赢在中路的信息优势。',
      evidence_ids: ['e-1', 'e-2'],
      evidence_sha256: 'sha',
      provider: 'openai',
      model: 'gpt',
      generated_at: '2026-08-15T10:00:00.000Z',
      cached: false,
    };
    const review = countingStub(result_);
    const analysis = countingStub(ANALYSIS);

    const { result } = renderDataHook(
      () => ({ analysis: useMatchAnalysis(DEMO_ID), review: useGenerateMatchReview() }),
      { client: { getAnalysis: analysis.call as never, reviewDemo: review.call as never } },
    );

    await waitFor(() => expect(result.current.analysis.data).toEqual(ANALYSIS));
    expect(review.calls()).toBe(0);

    await act(async () => {
      const answer = await result.current.review.mutateAsync({
        demoId: DEMO_ID,
        request: { scope: 'match', player_id: null, highlight_ids: [], tone: 'analytical' },
      });
      // The citations ride on the result: 「引用了 4 条证据，全部属于发送给模型的
      // 集合」 is the artboard's own claim, and the view has to be able to make it.
      expect(answer.evidence_ids).toEqual(['e-1', 'e-2']);
    });

    expect(review.calls()).toBe(1);
    // Commentary changes no stored fact.
    expect(analysis.calls()).toBe(1);
  });
});
