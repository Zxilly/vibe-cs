import { describe, expect, it } from 'vitest';

import {
  replayCacheLabel,
  replayEffectPresentation,
  replayFidelityPresentation,
  replayPlaybackControlPresentation,
  replayPlayerVitalPresentation,
} from './replayPresentation';

describe('replay presentation', () => {
  it.each([
    ['smoke', 'smoke', '烟雾', false],
    ['inferno_event', 'inferno', '燃烧', true],
    ['decoy', 'decoy', '诱饵', false],
    ['he', 'he', '高爆', false],
    ['flash', 'flash', '闪光', false],
    ['unknown', 'event', '道具事件', true],
  ] as const)('maps %s without inventing an effect type', (kind, className, label, eventOnly) => {
    expect(replayEffectPresentation(kind)).toEqual({ className, label, eventOnly });
  });

  it('distinguishes cache hits, generation, repair, and bypass', () => {
    const base = {
      key: 'abc',
      bytes: 42,
      generated_at: '2026-08-10T00:00:00Z',
      reason: null,
    } as const;
    expect(replayCacheLabel({ ...base, state: 'hit', repaired: false })).toBe('缓存命中');
    expect(replayCacheLabel({ ...base, state: 'generated', repaired: true })).toBe('损坏自愈 · 已重建');
    expect(replayCacheLabel({ ...base, state: 'bypassed', repaired: false })).toBe('未缓存');
  });

  it('labels sparse replay truthfully without presenting it as a continuous trajectory', () => {
    expect(replayFidelityPresentation({
      mode: 'event_sparse',
      tick_rate: 64,
      frame_count: 2_479,
      positioned_event_count: 3_129,
      start_tick: 60,
      end_tick: 173_950,
    })).toEqual({
      label: '事件稀疏',
      description: '精确事件 tick；自动播放会跳到下一证据点并压缩空白间隔，位置不代表连续移动轨迹。',
      tone: 'warning',
    });
  });

  it('presents sparse cadence as evidence stepping rather than fake realtime multipliers', () => {
    expect(replayPlaybackControlPresentation('event_sparse', 0.5)).toEqual({
      buttonLabel: '证据步进 · 慢',
      description: '调整证据点步进节奏；这不是实时倍速。',
    });
    expect(replayPlaybackControlPresentation('event_sparse', 1).buttonLabel).toBe('证据步进 · 标准');
    expect(replayPlaybackControlPresentation('event_sparse', 2).buttonLabel).toBe('证据步进 · 快');
  });

  it('states that hybrid evidence keeps the recorded tick clock without interpolation', () => {
    expect(replayFidelityPresentation({
      mode: 'hybrid',
      tick_rate: 64,
      frame_count: 40,
      positioned_event_count: 12,
      start_tick: 1_000,
      end_tick: 2_000,
    }).description).toBe('实体采样与事件位置共同组成；按真实 tick 间隔播放，采样间隔内不插值。');
    expect(replayPlaybackControlPresentation('hybrid', 2)).toEqual({
      buttonLabel: '2.0×',
      description: '按真实 tick 间隔缩放播放。',
    });
  });

  it('does not present an unknown sparse health sentinel as verified alive state', () => {
    const player = {
      id: 'molodoy',
      name: 'molodoy',
      team: 'A',
      position: [0, 0, 0] as [number, number, number],
      yaw: 0,
      health: 0,
      armor: 0,
      alive: true,
      weapon: '',
      input: null,
    };
    expect(replayPlayerVitalPresentation(player)).toEqual({
      healthLabel: 'HP —',
      statusLabel: '状态未取证',
      verified: false,
    });
    expect(replayPlayerVitalPresentation({ ...player, health: 72 })).toEqual({
      healthLabel: 'HP 72',
      statusLabel: '存活',
      verified: true,
    });
    expect(replayPlayerVitalPresentation({ ...player, alive: false })).toEqual({
      healthLabel: 'HP 0',
      statusLabel: '阵亡',
      verified: true,
    });
  });
});
