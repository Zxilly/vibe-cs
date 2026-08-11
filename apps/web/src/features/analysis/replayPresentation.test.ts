import { describe, expect, it } from 'vitest';

import { replayCacheLabel, replayEffectPresentation } from './replayPresentation';

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
      version: 1,
      key: 'abc',
      bytes: 42,
      generated_at: '2026-08-10T00:00:00Z',
      reason: null,
    } as const;
    expect(replayCacheLabel({ ...base, state: 'hit', repaired: false })).toBe('缓存命中');
    expect(replayCacheLabel({ ...base, state: 'generated', repaired: true })).toBe('损坏自愈 · 已重建');
    expect(replayCacheLabel({ ...base, state: 'bypassed', repaired: false })).toBe('未缓存');
  });
});
