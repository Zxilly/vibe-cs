import { describe, expect, it } from 'vitest';

import type { TimelineClip, TimelineTrack } from '../../shared/desktop/dto';
import { adjacentCaptionClip, serializeCaptionSrt, timelineCaptionClips } from './captionEditing';

function clip(id: string, start: number, duration: number, content: string, enabled = true): TimelineClip {
  return {
    id,
    name: content,
    capture_intent: null,
    material: { kind: 'planned' },
    placement: { start, duration, source_in: 0, source_out: duration, speed: 1, reverse: false, frame_hold_source_time: null, volume: 1, pan: 0, enabled },
    transform: { x: 0, y: 360, scale_x: 1, scale_y: 1, rotation: 0, opacity: 1 },
    effects: [],
    transitions: { video_in: null, video_out: null, audio_in: null, audio_out: null },
    text: { content, font_family: 'Arial', font_asset_id: null, font_size: 48, color: '#FFFFFF', background: '#000000', align: 'center' },
    metadata: {},
    group_id: null,
    link_group_id: null,
    keyframes: [],
    speed_segments: [],
  };
}

function track(kind: TimelineTrack['kind'], clips: TimelineClip[]): TimelineTrack {
  return { id: kind, name: kind, kind, order: 1, muted: false, solo: false, volume: 1, pan: 0, keyframes: [], locked: false, hidden: false, clips };
}

describe('caption editing', () => {
  it('collects enabled visible caption clips in sequence order only', () => {
    const later = clip('later', 4, 2, 'Later');
    const first = clip('first', 1, 1.5, 'First');
    expect(timelineCaptionClips([
      track('text', [clip('title', 0, 1, 'Title')]),
      track('caption', [later, clip('disabled', 2, 1, 'No', false), first]),
      { ...track('caption', [clip('hidden', 3, 1, 'Hidden')]), id: 'hidden-track', hidden: true },
    ])).toEqual([first, later]);
  });

  it('navigates caption starts without selecting the active caption again', () => {
    const clips = [clip('a', 1, 2, 'A'), clip('b', 4, 2, 'B'), clip('c', 7, 2, 'C')];
    expect(adjacentCaptionClip(clips, 4, 1)?.id).toBe('c');
    expect(adjacentCaptionClip(clips, 4, -1)?.id).toBe('a');
    expect(adjacentCaptionClip(clips, 0, -1)).toBeNull();
  });

  it('exports ordered UTF-8 SRT cues with millisecond timecodes and multiline text', () => {
    expect(serializeCaptionSrt([track('caption', [
      clip('b', 61.234, 2.111, 'Second\nline'),
      clip('a', 0, 1.5, ' First '),
    ])])).toBe(
      '1\r\n00:00:00,000 --> 00:00:01,500\r\nFirst\r\n\r\n'
      + '2\r\n00:01:01,234 --> 00:01:03,345\r\nSecond\nline\r\n',
    );
  });
});
