import { describe, expect, it } from 'vitest';

import type { EditorTransitionKind, TimelineClip } from '../../shared/desktop/dto';
import { evaluatePreviewTransition } from './TimelineProgramMonitor';

function clip(transition: EditorTransitionKind): TimelineClip {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    name: 'Transition',
    capture_intent: null,
    material: { kind: 'planned' },
    placement: { start: 0, duration: 5, source_in: 0, source_out: 5, speed: 1, volume: 1, enabled: true },
    transform: { x: 0, y: 0, scale_x: 1, scale_y: 1, rotation: 0, opacity: 1 },
    effects: [],
    transitions: {
      video_in: { kind: transition, duration_seconds: 2 },
      video_out: null,
      audio_in: null,
      audio_out: null,
    },
    text: null,
    metadata: {},
    group_id: null,
    link_group_id: null,
    keyframes: [],
    speed_segments: [],
  };
}

describe('Program visual transition presentation', () => {
  it('matches the renderer transition vocabulary at quarter progress', () => {
    const fade = evaluatePreviewTransition(clip('fade'), 0.5, 1_920);
    expect(fade).toMatchObject({ kind: 'fade', progress: 0.25, opacityFactor: 0.25 });

    expect(evaluatePreviewTransition(clip('dip'), 0.5, 1_920).filter).toBe('brightness(0.25)');
    expect(evaluatePreviewTransition(clip('flash'), 0.5, 1_920).filter).toBe('brightness(2.5) saturate(0.25)');
    expect(evaluatePreviewTransition(clip('zoom'), 0.5, 1_920).scale).toBeCloseTo(1.135);
    expect(evaluatePreviewTransition(clip('wipe'), 0.5, 1_920).clipPath).toBe('inset(0 75% 0 0)');
    expect(evaluatePreviewTransition(clip('slide'), 0.5, 1_920).clipPath).toBe('inset(0 75% 0 0)');
    expect(evaluatePreviewTransition(clip('blur'), 0.5, 1_920).filter).toContain('blur(');
    expect(evaluatePreviewTransition(clip('glitch'), 0.5, 1_920).filter).toContain('drop-shadow(');
    expect(evaluatePreviewTransition(clip('spin'), 0.5, 1_920).rotation).toBeCloseTo(15.040_142);
  });

  it('uses remaining clip time for an outgoing transition', () => {
    const source = {
      ...clip('fade'),
      transitions: {
        video_in: null,
        video_out: { kind: 'zoom' as const, duration_seconds: 2 },
        audio_in: null,
        audio_out: null,
      },
    };
    expect(evaluatePreviewTransition(source, 4.5, 1_920)).toMatchObject({
      kind: 'zoom',
      progress: 0.25,
      scale: 1.135,
    });
  });
});
