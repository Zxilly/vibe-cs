import { describe, expect, it } from 'vitest';

import type { TimelineClip } from '../../shared/desktop/dto';
import { pasteTimelineClipAttributes } from './timelinePasteAttributes';

function clip(id: string, duration = 4): TimelineClip {
  return {
    id, name: id, capture_intent: null, material: { kind: 'planned' },
    placement: { start: 0, duration, source_in: 0, source_out: duration, speed: 1, volume: 1, pan: 0, enabled: true },
    transform: { x: 0, y: 0, scale_x: 1, scale_y: 1, rotation: 0, opacity: 1 }, effects: [],
    transitions: { video_in: null, video_out: null, audio_in: null, audio_out: null }, text: null,
    metadata: {}, group_id: null, link_group_id: null, keyframes: [], speed_segments: [],
  };
}

describe('Paste Attributes', () => {
  it('selectively copies authored attributes without replacing edit or material identity', () => {
    const source = {
      ...clip('source'),
      placement: { ...clip('source').placement, volume: 2, pan: -0.5 },
      transform: { ...clip('source').transform, x: 40 },
      effects: [{ id: 'fx', kind: 'blur', enabled: true, parameters: { radius: 3 } }],
      keyframes: [{ id: 'key', time: 1, property: 'opacity' as const, value: 0.5 }],
      transitions: { ...clip('source').transitions, video_in: { kind: 'fade' as const, duration_seconds: 0.5 } },
    };
    let id = 0;
    const result = pasteTimelineClipAttributes(source, clip('target'), {
      transform: true, effects: true, keyframes: true, transitions: false, audio: false,
    }, 60, () => `copy-${++id}`);
    expect(result).toMatchObject({ id: 'target', material: { kind: 'planned' }, placement: { start: 0, duration: 4, volume: 1 }, transform: { x: 40 } });
    expect(result.effects[0]).toMatchObject({ id: 'copy-1', kind: 'blur' });
    expect(result.keyframes[0]).toMatchObject({ id: 'copy-2', property: 'opacity' });
    expect(result.transitions.video_in).toBeNull();
  });

  it('clamps copied transitions and drops keyframes outside the target duration', () => {
    const source = {
      ...clip('source', 5),
      transitions: { ...clip('source').transitions, video_in: { kind: 'zoom' as const, duration_seconds: 3 } },
      keyframes: [{ id: 'late', time: 4, property: 'x' as const, value: 20 }],
    };
    const result = pasteTimelineClipAttributes(source, clip('target', 2), {
      transform: false, effects: false, keyframes: true, transitions: true, audio: false,
    }, 60, () => 'copy');
    expect(result.keyframes).toEqual([]);
    expect(result.transitions.video_in).toEqual({ kind: 'zoom', duration_seconds: 1.983_333_333_333_333_4 });
  });
});
