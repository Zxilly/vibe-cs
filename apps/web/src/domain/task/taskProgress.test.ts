import { describe, expect, it } from 'vitest';

import { formatTaskProgress } from './taskProgress';

describe('formatTaskProgress', () => {
  it('reads a percentage as 「62%」 and a count as 「2/6」', () => {
    expect(formatTaskProgress({ completed: 62, total: 100, unit: 'percent' })).toBe('62%');
    expect(formatTaskProgress({ completed: 2, total: 6, unit: 'clips' })).toBe('2/6');
    expect(formatTaskProgress({ completed: 3, total: 5, unit: 'stages' })).toBe('3/5');
  });

  it('reads bytes in decimal units — the delivery page\'s 「186 MB」, not a nine-digit count', () => {
    expect(formatTaskProgress({ completed: 63_963_136, total: 187_301_888, unit: 'bytes' })).toBe('64 MB / 187 MB');
    expect(formatTaskProgress({ completed: 0, total: 4_200_000_000, unit: 'bytes' })).toBe('0 B / 4.2 GB');
  });
});
