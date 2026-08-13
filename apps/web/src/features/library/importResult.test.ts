import { describe, expect, it } from 'vitest';

import { requireSuccessfulImport } from './importResult';

describe('requireSuccessfulImport', () => {
  const translate = () => 'No Demo was imported.';

  it('accepts a result that persisted a new or updated record', () => {
    expect(requireSuccessfulImport({ discovered: 1, imported: 1, updated: 0, skipped: 0, errors: [] }, translate).imported).toBe(1);
    expect(requireSuccessfulImport({ discovered: 1, imported: 0, updated: 1, skipped: 0, errors: [] }, translate).updated).toBe(1);
  });

  it('rejects an empty success response and preserves bounded backend details', () => {
    expect(() => requireSuccessfulImport({
      discovered: 3,
      imported: 0,
      updated: 0,
      skipped: 3,
      errors: ['one.dem: rejected', 'two.dem: rejected', 'three.dem: rejected', 'four.dem: rejected'],
    }, translate)).toThrow('No Demo was imported.\none.dem: rejected\ntwo.dem: rejected\nthree.dem: rejected');
  });
});
