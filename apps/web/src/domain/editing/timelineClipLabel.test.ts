import { describe, expect, it } from 'vitest';

import type { TimelineClip } from '../../shared/desktop/dto';
import { timelineClipStripLabel } from './timelineClipLabel';

function clip(name: string, metadata: TimelineClip['metadata'] = {}): TimelineClip {
  return { name, metadata } as TimelineClip;
}

describe('timelineClipStripLabel', () => {
  it('shows the whole name when it fits the strip', () => {
    expect(timelineClipStripLabel(clip('Mirage R1 · s1mple'), 3, 200)).toBe('Mirage R1 · s1mple');
  });

  it('collapses a narrow clip to its source round rather than a shared prefix', () => {
    expect(timelineClipStripLabel(clip('Mirage R12 · s1mple'), 3, 60)).toBe('R12');
    expect(timelineClipStripLabel(clip('Mirage · s1mple', { round: 7 }), 3, 60)).toBe('R7');
  });

  it('falls back to the clip ordinal when no round is known', () => {
    expect(timelineClipStripLabel(clip('开场集锦片段'), 4, 40)).toBe('4');
    // A word that merely starts with R is not a round.
    expect(timelineClipStripLabel(clip('Rush B · Mirage'), 2, 40)).toBe('2');
  });

  it('counts CJK characters at a full em', () => {
    // Six CJK characters are 72px of text plus 8px of padding.
    expect(timelineClipStripLabel(clip('开场集锦片段'), 1, 80)).toBe('开场集锦片段');
    expect(timelineClipStripLabel(clip('开场集锦片段'), 1, 79)).toBe('1');
  });
});
