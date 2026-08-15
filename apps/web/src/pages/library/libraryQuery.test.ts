/*
 * `unit` project — the library's address.
 *
 * These are the rules that make a filter shareable and a cache stable, so they
 * are asserted without a DOM: what a bad parameter falls back to, what a change
 * does to the page number, and — the one that costs real IPC if it is wrong —
 * that an inactive filter produces an *absent* key rather than an `undefined`
 * one.
 */

import { describe, expect, it } from 'vitest';

import {
  changeLibraryAddress,
  clearLibraryFilters,
  DEFAULT_DEMO_SORT,
  demoSortOf,
  hasActiveFilter,
  libraryDemoQuery,
  LIBRARY_PAGE_SIZE,
  readLibraryAddress,
  sortStateOf,
  writeLibraryAddress,
  type LibraryAddress,
} from './libraryQuery';

function at(search: string): LibraryAddress {
  return readLibraryAddress(new URLSearchParams(search));
}

describe('readLibraryAddress', () => {
  it('opens the table on a bare /library', () => {
    expect(at('')).toEqual({
      view: 'table',
      page: 1,
      search: '',
      map: '',
      status: '',
      source: '',
      tagId: '',
      sort: DEFAULT_DEMO_SORT,
    });
  });

  it('reads every filter the strip can set', () => {
    expect(at('view=card&q=aurora&map=Mirage&status=ready&source=valve&tag=t1&sort=map_asc&page=3')).toEqual({
      view: 'card',
      page: 3,
      search: 'aurora',
      map: 'Mirage',
      status: 'ready',
      source: 'valve',
      tagId: 't1',
      sort: 'map_asc',
    });
  });

  it('falls back rather than rendering nothing for a stale deep link', () => {
    // `pages/routeQuery.ts` states the rule: an unknown value is a navigation,
    // not an error.
    expect(at('view=grid').view).toBe('table');
    expect(at('status=analysed').status).toBe('');
    expect(at('source=steam').source).toBe('');
    expect(at('sort=magic').sort).toBe(DEFAULT_DEMO_SORT);
    expect(at('page=0').page).toBe(1);
    expect(at('page=-4').page).toBe(1);
    expect(at('page=nine').page).toBe(1);
  });
});

describe('writeLibraryAddress', () => {
  it('drops defaults, so /library stays /library', () => {
    expect(writeLibraryAddress(at('')).toString()).toBe('');
  });

  it('round-trips everything that is not a default', () => {
    const address = at('view=card&q=aurora&map=Mirage&status=ready&source=valve&tag=t1&sort=map_asc&page=3');
    expect(readLibraryAddress(writeLibraryAddress(address))).toEqual(address);
  });
});

describe('changeLibraryAddress', () => {
  it('sends a filter change back to page 1', () => {
    const address = at('page=7');
    expect(changeLibraryAddress(address, { search: 'kael' }).page).toBe(1);
    expect(changeLibraryAddress(address, { view: 'card' }).page).toBe(1);
  });

  it('leaves the page alone when the page itself is what changed', () => {
    expect(changeLibraryAddress(at('q=kael'), { page: 4 })).toEqual({ ...at('q=kael'), page: 4 });
  });
});

describe('libraryDemoQuery', () => {
  it('omits an inactive filter instead of sending undefined', () => {
    const query = libraryDemoQuery(at(''));

    // The distinction is not cosmetic: `keys.ts` hashes the query object whole,
    // so `{ search: undefined }` and `{}` are two cache entries for one filter.
    expect(Object.hasOwn(query, 'search')).toBe(false);
    expect(Object.hasOwn(query, 'map_name')).toBe(false);
    expect(Object.hasOwn(query, 'status')).toBe(false);
    expect(Object.hasOwn(query, 'match_source')).toBe(false);
    expect(Object.hasOwn(query, 'tag_id')).toBe(false);
    expect(query).toEqual({ sort: DEFAULT_DEMO_SORT, page: 1, page_size: LIBRARY_PAGE_SIZE });
  });

  it('carries every active filter under the wire’s own field names', () => {
    expect(libraryDemoQuery(at('q=aurora&map=Mirage&status=ready&source=valve&tag=t1&page=2'))).toEqual({
      search: 'aurora',
      map_name: 'Mirage',
      status: 'ready',
      match_source: 'valve',
      tag_id: 't1',
      sort: DEFAULT_DEMO_SORT,
      page: 2,
      page_size: LIBRARY_PAGE_SIZE,
    });
  });

  it('pages by 20, the size §10.3 settled', () => {
    expect(LIBRARY_PAGE_SIZE).toBe(20);
  });
});

describe('hasActiveFilter / clearLibraryFilters', () => {
  it('does not count the view or the page as a filter', () => {
    expect(hasActiveFilter(at('view=card&page=4'))).toBe(false);
    expect(hasActiveFilter(at('q=a'))).toBe(true);
    expect(hasActiveFilter(at('tag=t1'))).toBe(true);
  });

  it('keeps where you are looking and drops what you were looking for', () => {
    const cleared = clearLibraryFilters(at('view=card&q=a&map=Mirage&sort=map_asc&page=6'));
    expect(cleared.view).toBe('card');
    expect(cleared.sort).toBe('map_asc');
    expect(cleared.page).toBe(1);
    expect(hasActiveFilter(cleared)).toBe(false);
  });
});

describe('sorting', () => {
  it('round-trips every sortable column in both directions', () => {
    for (const columnId of ['match', 'map', 'duration', 'rounds', 'status']) {
      for (const direction of ['asc', 'desc'] as const) {
        const state = { columnId, direction };
        expect(sortStateOf(demoSortOf(state))).toEqual(state);
      }
    }
  });

  it('has no state for the default order, so no header shows an arrow', () => {
    expect(sortStateOf(DEFAULT_DEMO_SORT)).toBeNull();
    expect(demoSortOf(null)).toBe(DEFAULT_DEMO_SORT);
  });

  it('does not claim to sort a column the wire cannot order', () => {
    // 日期 renders `match_date`; the wire's only date order is `updated_*`.
    expect(demoSortOf({ columnId: 'date', direction: 'asc' })).toBe(DEFAULT_DEMO_SORT);
  });
});
