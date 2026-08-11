import { describe, expect, it } from 'vitest';

import {
  formatOutputBytes,
  outputReferenceFromKey,
  outputReferenceKey,
  outputStatusTone,
} from './outputPresentation';

describe('output presentation', () => {
  it('round-trips stable selection keys', () => {
    const reference = { kind: 'export' as const, id: 'c4985e78-f7ff-49bc-bbbc-af6c69cf145d' };
    expect(outputReferenceFromKey(outputReferenceKey(reference))).toEqual(reference);
    expect(outputReferenceFromKey('unknown:value')).toBeNull();
  });

  it('formats byte counts without pretending missing sizes are zero', () => {
    expect(formatOutputBytes(null)).toBe('—');
    expect(formatOutputBytes(512)).toBe('512 B');
    expect(formatOutputBytes(2 * 1024 * 1024)).toBe('2.00 MB');
  });

  it('distinguishes failed and cancelled terminal outcomes', () => {
    expect(outputStatusTone('failed')).toBe('danger');
    expect(outputStatusTone('cancelled')).toBe('neutral');
    expect(outputStatusTone('completed')).toBe('success');
  });
});
