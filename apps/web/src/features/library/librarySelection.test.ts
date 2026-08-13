import { describe, expect, it } from 'vitest';

import { isDemoAnalyzable, retainLibraryPageSelection } from './librarySelection';

describe('library analysis selection', () => {
  it.each([
    ['discovered', true],
    ['failed', true],
    ['indexing', false],
    ['analyzing', false],
    ['ready', false],
    ['missing', false],
  ] as const)('allows %s in an analysis batch: %s', (status, expected) => {
    expect(isDemoAnalyzable(status)).toBe(expected);
  });
});

describe('library page-scoped selection', () => {
  it('drops inspector and batch selection IDs that are not on the returned server page', () => {
    const retained = retainLibraryPageSelection(
      new Set(['page-1', 'page-2']),
      ['page-2', 'page-3'],
    );

    expect([...retained]).toEqual(['page-2']);
    expect(retainLibraryPageSelection(new Set(['page-1']), ['page-2'])).toEqual(new Set());
  });
});
