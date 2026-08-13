import { describe, expect, it } from 'vitest';

import type { TimelineEvent } from '../../shared/desktop/dto';
import { roundReasonLabel, timelineEventItemEvidence } from './analysisEvidence';

describe('analysis evidence presentation', () => {
  it('translates the round-end tokens emitted by real CS2 Demos', () => {
    expect(roundReasonLabel('#SFUI_Notice_CTs_Win', 'zh-CN')).toBe('反恐精英全歼对手');
    expect(roundReasonLabel('#SFUI_Notice_Target_Bombed', 'en-US')).toBe('Bomb exploded');
  });

  it('uses persisted purchase item_name only as timeline evidence when weapon is absent', () => {
    const purchase = {
      id: 'item_purchase-1',
      tick: 120,
      seconds: 1,
      kind: 'purchase',
      actor: 'p1',
      target: null,
      weapon: null,
      headshot: false,
      penetrated: false,
      position: null,
      detail: { item_name: 'weapon_ak47' },
    } satisfies TimelineEvent;

    expect(timelineEventItemEvidence(purchase)).toBe('weapon_ak47');
    expect(timelineEventItemEvidence({ ...purchase, kind: 'damage' })).toBeNull();
  });
});
