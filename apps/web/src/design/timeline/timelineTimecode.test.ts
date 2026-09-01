import { describe, expect, it } from 'vitest';

import { formatTimelinePosition, parseTimelinePosition } from './timelineTimecode';

describe('Timeline position timecode', () => {
  it('formats and parses frame-aligned Premiere timecode', () => {
    expect(formatTimelinePosition(3_661.5, 60, 'timecode')).toBe('01:01:01:30');
    expect(parseTimelinePosition('01:01:01:30', 60, 'timecode')).toBe(3_661.5);
  });

  it('switches to absolute frame count without changing the position', () => {
    expect(formatTimelinePosition(2.5, 60, 'frames')).toBe('150');
    expect(parseTimelinePosition('150', 60, 'frames')).toBe(2.5);
  });

  it('rejects malformed or out-of-range fields', () => {
    expect(parseTimelinePosition('00:60:00:00', 60, 'timecode')).toBeNull();
    expect(parseTimelinePosition('00:00:00:60', 60, 'timecode')).toBeNull();
    expect(parseTimelinePosition('-1', 60, 'frames')).toBeNull();
  });
});
