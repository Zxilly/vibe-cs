import { describe, expect, it } from 'vitest';

import type { TimelineTrackDto } from '../../shared/api/dto';
import {
  MAX_EDITOR_TIMELINE_SECONDS,
  boundedTimelineValue,
  createOperationGate,
  decideProjectTransition,
  formatTimelineTime,
  projectEditFingerprint,
  presetCompatibilityReason,
  snapTimelineTime,
  timelineRuler,
  trimMarkersToDuration,
} from './projectState';

const tracks: TimelineTrackDto[] = [
  {
    id: 'video',
    name: '主画面',
    kind: 'video',
    order: 0,
    muted: false,
    locked: false,
    hidden: false,
    clips: [],
  },
];

describe('Editor project state', () => {
  it('counts both project-name and timeline changes as unsaved edits', () => {
    const saved = projectEditFingerprint('我的剪辑', tracks);

    expect(projectEditFingerprint('我的剪辑', structuredClone(tracks))).toBe(saved);
    expect(projectEditFingerprint('新名称', tracks)).not.toBe(saved);
    expect(projectEditFingerprint('我的剪辑', [{ ...tracks[0]!, locked: true }])).not.toBe(saved);
    expect(projectEditFingerprint('我的剪辑', tracks, [{ id: 'm1', time: 1, label: '击杀', color: '#F59E0B' }])).not.toBe(saved);
    expect(projectEditFingerprint('我的剪辑', tracks, [], { safeArea: true })).not.toBe(saved);
    expect(projectEditFingerprint('我的剪辑', tracks, [], {}, 60)).not.toBe(saved);
  });

  it('keeps the active edit when selecting it again and confirms destructive transitions', () => {
    expect(decideProjectTransition('project-a', 'project-a', 'dirty', 'saved')).toBe('stay');
    expect(decideProjectTransition('project-a', 'project-b', 'saved', 'saved')).toBe('proceed');
    expect(decideProjectTransition('project-a', 'project-b', 'dirty', 'saved')).toBe('confirm');
    expect(decideProjectTransition('project-a', null, 'dirty', 'saved')).toBe('confirm');
  });

  it('allows only one save-or-export operation until the owner finishes it', () => {
    const gate = createOperationGate<'save' | 'export'>();

    expect(gate.tryStart('export')).toBe(true);
    expect(gate.tryStart('export')).toBe(false);
    expect(gate.tryStart('save')).toBe(false);
    expect(gate.finish('save')).toBe(false);
    expect(gate.current()).toBe('export');
    expect(gate.finish('export')).toBe(true);
    expect(gate.tryStart('save')).toBe(true);
  });

  it('snaps to marker and clip edges inside the pixel-derived threshold', () => {
    const populated: TimelineTrackDto[] = [{
      ...tracks[0]!,
      clips: [{
        id: 'clip-a', asset_id: null, name: 'A', start: 3, duration: 2,
        source_in: 0, source_out: 2, speed: 1, volume: 1,
        transform: { x: 0, y: 0, scale_x: 1, scale_y: 1, rotation: 0, opacity: 1 },
        effects: [], transition_in: null, transition_out: null, text: null, metadata: {},
        group_id: null, link_group_id: null, keyframes: [], speed_segments: [],
      }],
    }];
    const markers = [{ id: 'marker-a', time: 8, label: '转场', color: '#60A5FA' }];

    expect(snapTimelineTime(7.94, populated, markers, 12, 0.1)).toEqual({ time: 8, snapped: true });
    expect(snapTimelineTime(5.08, populated, markers, 12, 0.1)).toEqual({ time: 5, snapped: true });
    expect(snapTimelineTime(5.2, populated, markers, 12, 0.1)).toEqual({ time: 5.2, snapped: false });
    expect(snapTimelineTime(3.04, populated, markers, 12, 0.1, 'clip-a')).toEqual({ time: 3.04, snapped: false });
  });

  it('bounds hostile numeric input and keeps ruler allocation finite', () => {
    expect(boundedTimelineValue(Number.NaN, 12, 0.1, 20)).toBe(12);
    expect(boundedTimelineValue(Number.POSITIVE_INFINITY, 12, 0.1, 20)).toBe(12);
    expect(boundedTimelineValue(1e100, 12, 0.1, 20)).toBe(20);

    const ruler = timelineRuler(1e100, 100);
    expect(ruler.tickCount).toBeLessThanOrEqual(100);
    expect(ruler.stepSeconds).toBeGreaterThan(5);
    expect(timelineRuler(Number.NaN).tickCount).toBe(15);
  });

  it('drops markers outside a shortened finite timeline', () => {
    const markers = [
      { id: 'inside', time: 4, label: '保留', color: '#60A5FA' },
      { id: 'edge', time: 5, label: '边界', color: '#60A5FA' },
      { id: 'outside', time: 5.01, label: '移除', color: '#60A5FA' },
      { id: 'invalid', time: Number.NaN, label: '非法', color: '#60A5FA' },
    ];

    expect(trimMarkersToDuration(markers, 5)).toEqual({
      markers: markers.slice(0, 2),
      removed: 2,
    });
    expect(trimMarkersToDuration(markers, 1e100).markers).toHaveLength(3);
  });

  it('formats time with the actual project frame rate', () => {
    expect(formatTimelineTime(1.5, 30)).toBe('00:01:15');
    expect(formatTimelineTime(1.5, 60)).toBe('00:01:30');
    expect(formatTimelineTime(Number.POSITIVE_INFINITY, 60)).toBe('00:00:00');
    expect(formatTimelineTime(MAX_EDITOR_TIMELINE_SECONDS, 240)).toBe('1440:00:000');
  });

  it('rejects presets whose properties cannot render on the selected target', () => {
    const document = {
      schema_version: 1 as const,
      transform: { x: 0, y: 0, scale_x: 1, scale_y: 1, rotation: 0, opacity: 1 },
      volume: 1,
      color_adjust: { brightness: 0, contrast: 1, saturation: 1 },
      grayscale: false,
      blur_radius: null,
      transition_in: null,
      transition_out: null,
    };
    expect(presetCompatibilityReason('text', true, 1, document)).toBeNull();
    expect(presetCompatibilityReason('text', true, 1, {
      ...document,
      transform: { ...document.transform, rotation: 12 },
    })).toContain('文字片段');
    expect(presetCompatibilityReason('audio', false, 1, {
      ...document,
      transform: { ...document.transform, x: 10 },
    })).toContain('音频片段');
  });
});
