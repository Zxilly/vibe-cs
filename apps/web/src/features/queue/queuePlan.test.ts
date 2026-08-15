import { describe, expect, it, vi } from 'vitest';

import {
  buildRecordingQueueRequest,
  buildDemoPlaybackOptions,
  demoPlaybackFingerprint,
  demoPlaybackBlockReason,
  matchesRecordingQueueFingerprint,
  playbackReadinessRelevant,
  queueItemDurationSeconds,
  queueItemTickRate,
  recordingJobCancelTarget,
  recordingJobStage,
  recordingQueueFingerprint,
  requireManagedHlaeForRecording,
} from './queuePlan';

describe('recording job stage presentation', () => {
  it('keeps a recovered active job cancellable before status hydration succeeds', () => {
    expect(recordingJobCancelTarget('persisted-job', null)).toBe('persisted-job');
  });

  it('localizes a stable backend stage code without claiming elapsed-time percent', () => {
    expect(recordingJobStage('recording.stage.capturing')).toEqual({
      key: 'queue.recordingStage.capturing',
      ordinal: 3,
      total: 5,
    });
    expect(recordingJobStage('Recording 1 of 1')).toBeNull();
  });
});

describe('managed recording preparation', () => {
  it('accepts only a successfully prepared pinned runtime', async () => {
    const prepared = vi.fn().mockResolvedValue({ managed_release: { prepared: true } });
    const unavailable = vi.fn().mockResolvedValue({ managed_release: { prepared: false } });

    await expect(requireManagedHlaeForRecording(prepared, 'prepare failed')).resolves.toMatchObject({
      managed_release: { prepared: true },
    });
    await expect(requireManagedHlaeForRecording(unavailable, 'prepare failed')).rejects.toThrow('prepare failed');
  });
});

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
  it('keeps playback readiness out of a queue with no clips or active local preview', () => {
    expect(playbackReadinessRelevant(0, false)).toBe(false);
    expect(playbackReadinessRelevant(1, false)).toBe(true);
  });

  it('keeps local preview readiness visible while an otherwise empty queue owns playback', () => {
    expect(playbackReadinessRelevant(0, true)).toBe(true);
  });

  it('uses only an authoritative item tick rate and refuses to invent 64 tick timing', () => {
    const item = {
      ...realItem,
      startTick: 1_000,
      endTick: 1_128,
      preRollSeconds: 2,
      postRollSeconds: 3,
    };
    const fallbackItem: QueueItem = { ...item };
    delete fallbackItem.tickRate;

    expect(queueItemTickRate(item)).toBe(128);
    expect(queueItemDurationSeconds(item)).toBe(6);
    expect(queueItemTickRate(fallbackItem)).toBeNull();
    expect(queueItemDurationSeconds(fallbackItem)).toBeNull();
    expect(buildDemoPlaybackOptions(fallbackItem)).toBeNull();
    expect(demoPlaybackBlockReason(fallbackItem, false)).toContain('Tick Rate');
    expect(queueItemTickRate({ ...item, tickRate: Number.NaN })).toBeNull();
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
    expect(request.items.map((item) => item.camera_style)).toEqual(['pov', 'pov']);
    for (const item of request.items) {
      expect(item).not.toHaveProperty('playback_speed');
      expect(item).not.toHaveProperty('show_keyboard');
      expect(item).not.toHaveProperty('show_kill_fx');
      expect(item).not.toHaveProperty('fade');
    }
    expect(request.items[0]).not.toHaveProperty('perspective');
  });

  it('builds deterministic 1.0× preview arguments from the stable player identity and real tick rate', () => {
    expect(buildDemoPlaybackOptions({
      ...realItem,
      startTick: 10_000,
      preRollSeconds: 2.5,
      tickRate: 128,
      playerName: 'Ambiguous Name',
      playerId: '76561198000000000',
    })).toEqual({
      start_tick: 9_680,
      player: '76561198000000000',
      timescale: 1,
    });
  });

  it('blocks local preview while recording and for unsupported victim perspective', () => {
    expect(demoPlaybackBlockReason(realItem, false)).toBeNull();
    expect(demoPlaybackBlockReason(realItem, true)).toContain('录制任务');
    expect(demoPlaybackBlockReason(realItem, false, true)).toContain('显式停止');
    expect(demoPlaybackBlockReason({ ...realItem, perspective: 'victim' }, false)).toContain('受害者视角');
    expect(demoPlaybackBlockReason({ ...realItem, cameraStyle: 'flyby' }, false)).toContain('正式生成');
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
      [{ ...realItem, perspective: 'victim' }, second],
      [{ ...realItem, cameraStyle: 'crane' }, second],
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
