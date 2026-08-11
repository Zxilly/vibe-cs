import { describe, expect, it } from 'vitest';

import {
  buildRecordingQueueRequest,
  buildDemoPlaybackOptions,
  demoPlaybackFingerprint,
  demoPlaybackBlockReason,
  matchesRecordingQueueFingerprint,
  queueItemDurationSeconds,
  queueItemTickRate,
  recordingQueueFingerprint,
} from './queuePlan';
import type { QueueItem } from './queueStore';
import { queueTestItems } from './queueTestFixtures';

const realItem: QueueItem = {
  ...queueTestItems[0]!,
  id: 'd783d432-74c3-4025-b13b-cdce293c13ae',
  demoId: '1c35e027-20cf-42c7-833e-edfdd6672524',
  title: '真实片段',
  highlightId: 'parsed-highlight-1',
  hasVictimPov: true,
  tickRate: 128,
  origin: 'demo',
};

describe('queue plan model', () => {
  it('uses the item tick rate for duration and falls back to 64', () => {
    const item = {
      ...realItem,
      startTick: 1_000,
      endTick: 1_128,
      preRollSeconds: 2,
      postRollSeconds: 3,
      playbackSpeed: 1,
    };
    const fallbackItem: QueueItem = { ...item };
    delete fallbackItem.tickRate;

    expect(queueItemTickRate(item)).toBe(128);
    expect(queueItemDurationSeconds(item)).toBe(6);
    expect(queueItemTickRate(fallbackItem)).toBe(64);
    expect(queueItemDurationSeconds(fallbackItem)).toBe(7);
    expect(queueItemTickRate({ ...item, tickRate: Number.NaN })).toBe(64);
  });

  it('sends only enabled demo items and maps evidence-backed victim perspectives', () => {
    const request = buildRecordingQueueRequest([
      realItem,
      { ...realItem, id: 'disabled', enabled: false },
      { ...realItem, id: 'preview', origin: 'preview' },
      { ...realItem, id: 'second', highlightId: 'parsed-highlight-2', perspective: 'victim' },
    ]);

    expect(request.items.map((item) => item.highlight_id)).toEqual(['parsed-highlight-1', 'parsed-highlight-2']);
    expect(request.items.map((item) => item.victim_pov)).toEqual([false, true]);
    expect(request.items[0]).not.toHaveProperty('perspective');
  });

  it('builds preview arguments from the stable player identity and real tick rate', () => {
    expect(buildDemoPlaybackOptions({
      ...realItem,
      startTick: 10_000,
      preRollSeconds: 2.5,
      tickRate: 128,
      playbackSpeed: 0.5,
      playerName: 'Ambiguous Name',
      playerId: '76561198000000000',
    })).toEqual({
      start_tick: 9_680,
      player: '76561198000000000',
      timescale: 0.5,
    });
  });

  it('blocks local preview while recording and for unsupported victim perspective', () => {
    expect(demoPlaybackBlockReason(realItem, false)).toBeNull();
    expect(demoPlaybackBlockReason(realItem, true)).toContain('录制任务');
    expect(demoPlaybackBlockReason(realItem, false, true)).toContain('显式停止');
    expect(demoPlaybackBlockReason({ ...realItem, perspective: 'victim' }, false)).toContain('受害者视角');
    expect(demoPlaybackBlockReason({ ...realItem, origin: 'preview' }, false)).toContain('示例');
  });

  it('invalidates playback evidence for every request or disclosure parameter change', () => {
    const fingerprint = demoPlaybackFingerprint(realItem);
    const mutations: QueueItem[] = [
      { ...realItem, demoId: 'another-demo' },
      { ...realItem, playerId: '76561198000000001' },
      { ...realItem, startTick: realItem.startTick + 1 },
      { ...realItem, tickRate: 64 },
      { ...realItem, preRollSeconds: realItem.preRollSeconds + 0.5 },
      { ...realItem, playbackSpeed: 0.5 },
      { ...realItem, perspective: 'victim' },
      { ...realItem, origin: 'preview' },
    ];

    expect(demoPlaybackFingerprint({ ...realItem })).toBe(fingerprint);
    for (const mutation of mutations) {
      expect(demoPlaybackFingerprint(mutation)).not.toBe(fingerprint);
    }
  });

  it('is stable for an equivalent queue and changes for every queue mutation class', () => {
    const second = { ...realItem, id: 'second', title: '第二段' };
    const baseline = [realItem, second];
    const fingerprint = recordingQueueFingerprint(baseline);
    const mutations: QueueItem[][] = [
      [...baseline, { ...realItem, id: 'added' }],
      [realItem],
      [second, realItem],
      [{ ...realItem, enabled: false }, second],
      [{ ...realItem, title: '改名' }, second],
      [{ ...realItem, preRollSeconds: realItem.preRollSeconds + 0.5 }, second],
      [{ ...realItem, postRollSeconds: realItem.postRollSeconds + 0.5 }, second],
      [{ ...realItem, playbackSpeed: 0.5 }, second],
      [{ ...realItem, showKeyboard: !realItem.showKeyboard }, second],
      [{ ...realItem, showKillFx: !realItem.showKillFx }, second],
      [{ ...realItem, perspective: 'victim' }, second],
      [{ ...realItem, tickRate: 64 }, second],
    ];

    expect(recordingQueueFingerprint(baseline.map((item) => ({ ...item })))).toBe(fingerprint);
    for (const mutation of mutations) {
      expect(recordingQueueFingerprint(mutation)).not.toBe(fingerprint);
      expect(matchesRecordingQueueFingerprint(fingerprint, mutation)).toBe(false);
    }
    expect(matchesRecordingQueueFingerprint(fingerprint, baseline)).toBe(true);
    expect(matchesRecordingQueueFingerprint(null, baseline)).toBe(false);
  });
});
