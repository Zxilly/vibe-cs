import { describe, expect, it } from 'vitest';

import type { EditorTransitionKind, MediaAsset, TimelineClip } from '../../shared/desktop/dto';
import { advanceTimelineTransport, evaluatePreviewTransition, programPreviewStreamPath, transportReachedBoundary } from './TimelineProgramMonitor';

function clip(transition: EditorTransitionKind): TimelineClip {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    name: 'Transition',
    capture_intent: null,
    material: { kind: 'planned' },
    placement: { start: 0, duration: 5, source_in: 0, source_out: 5, speed: 1, reverse: false, frame_hold_source_time: null, volume: 1, pan: 0, enabled: true },
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

describe('Trim Mode transport range', () => {
  it('clamps forward and reverse transport to the loop boundaries', () => {
    expect(advanceTimelineTransport(6.4, 1, 1, 6.5, 3.5)).toBe(6.5);
    expect(transportReachedBoundary(6.5, 1, 6.5, 3.5)).toBe(true);
    expect(advanceTimelineTransport(3.6, 1, -1, 6.5, 3.5)).toBe(3.5);
    expect(transportReachedBoundary(3.5, -1, 6.5, 3.5)).toBe(true);
  });
});

describe('Program proxy source selection', () => {
  const asset: MediaAsset = {
    id: 'asset',
    project_id: 'project',
    path: 'D:\\media\\source.mp4',
    name: 'Source',
    kind: 'video',
    duration_seconds: 5,
    width: 1920,
    height: 1080,
    file_size: 1,
    has_audio: true,
    proxy_path: 'D:\\proxy\\source.mp4',
    proxy_status: { status: 'ready', generated_at: '2026-09-02T00:00:00Z' },
    waveform: null,
    metadata_status: { status: 'ready' },
    markers: [],
    created_at: '2026-09-02T00:00:00Z',
  };

  it('uses a ready proxy only when the Project setting enables it', () => {
    const assets = new Map([[asset.id, asset]]);
    expect(programPreviewStreamPath(asset.id, assets, true)).toContain('/proxy/stream');
    expect(programPreviewStreamPath(asset.id, assets, false)).toBe('/api/media/assets/asset/stream');
    expect(programPreviewStreamPath(asset.id, new Map(), true)).toBe('/api/media/assets/asset/stream');
  });
});
