import { describe, expect, it } from 'vitest';

import type { TimelineClip } from '../../shared/desktop/dto';
import { timelineClipCompactLabels, timelineClipStripLabel } from './timelineClipLabel';

function clip(name: string, metadata: TimelineClip['metadata'] = {}, start = 0, id = name): TimelineClip {
  return { id, name, metadata, placement: { start } } as TimelineClip;
}

describe('timelineClipCompactLabels', () => {
  it('collapses a clip to its source round rather than a shared prefix', () => {
    const labels = timelineClipCompactLabels([
      clip('Mirage R12 · s1mple', {}, 0),
      clip('Mirage · s1mple', { round: 7 }, 6),
    ]);
    expect(labels.get('Mirage R12 · s1mple')).toEqual({ text: 'R12', ordinal: 1 });
    expect(labels.get('Mirage · s1mple')).toEqual({ text: 'R7', ordinal: 2 });
  });

  it('falls back to the clip ordinal in timeline order when no round is known', () => {
    const labels = timelineClipCompactLabels([
      clip('Rush B · Mirage', {}, 12),
      clip('开场集锦片段', {}, 0),
    ]);
    expect(labels.get('开场集锦片段')).toEqual({ text: '1', ordinal: 1 });
    // A word that merely starts with R is not a round.
    expect(labels.get('Rush B · Mirage')).toEqual({ text: '2', ordinal: 2 });
  });

  it('letters clips cut from the same round in timeline order', () => {
    const labels = timelineClipCompactLabels([
      clip('Mirage R2 · s1mple', {}, 18, 'r2-late'),
      clip('Mirage R1 · s1mple', {}, 0, 'r1-early'),
      clip('Mirage R3 · s1mple', {}, 24, 'r3'),
      clip('Mirage R2 · s1mple', {}, 12, 'r2-early'),
      clip('Mirage R1 · s1mple', {}, 6, 'r1-late'),
    ]);
    expect(Object.fromEntries(labels)).toEqual({
      'r1-early': { text: 'R1a', ordinal: 1 },
      'r1-late': { text: 'R1b', ordinal: 2 },
      'r2-early': { text: 'R2a', ordinal: 3 },
      'r2-late': { text: 'R2b', ordinal: 4 },
      r3: { text: 'R3', ordinal: 5 },
    });
  });

  it('keeps lettering past the alphabet', () => {
    const clips = Array.from({ length: 28 }, (_, index) => clip('Mirage R1', {}, index, `take-${String(index)}`));
    const labels = timelineClipCompactLabels(clips);
    expect(labels.get('take-25')?.text).toBe('R1z');
    expect(labels.get('take-26')?.text).toBe('R1aa');
    expect(labels.get('take-27')?.text).toBe('R1ab');
  });
});

describe('timelineClipStripLabel', () => {
  it('shows the whole name when it fits the strip', () => {
    expect(timelineClipStripLabel(clip('Mirage R1 · s1mple'), { text: 'R1a', ordinal: 1 }, 200)).toBe('Mirage R1 · s1mple');
  });

  it('shows the compact label when the name does not fit', () => {
    expect(timelineClipStripLabel(clip('Mirage R1 · s1mple'), { text: 'R1a', ordinal: 1 }, 60)).toBe('R1a');
  });

  it('counts CJK characters at a full em', () => {
    // Six CJK characters are 72px of text plus 10px of padding and borders.
    expect(timelineClipStripLabel(clip('开场集锦片段'), { text: '1', ordinal: 1 }, 82)).toBe('开场集锦片段');
    expect(timelineClipStripLabel(clip('开场集锦片段'), { text: '1', ordinal: 1 }, 81)).toBe('1');
  });

  it('keeps neighboring clips identifiable when a fit view is narrower than a round token', () => {
    const clips = Array.from({ length: 30 }, (_, index) => clip('Mirage R1 · s1mple', {}, index * 6, `take-${index}`));
    const labels = timelineClipCompactLabels(clips);
    expect(clips.map((item) => timelineClipStripLabel(item, labels.get(item.id)!, 30)))
      .toEqual(clips.map((_, index) => String(index + 1)));
  });

  it('hides text only when the ordinal itself cannot fit', () => {
    expect(timelineClipStripLabel(clip('Mirage R1 · s1mple'), { text: 'R1a', ordinal: 12 }, 15)).toBeNull();
  });
});
