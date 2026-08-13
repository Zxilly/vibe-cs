import { describe, expect, it } from 'vitest';

import {
  commitCurrentMatchHistoryPage,
  DEFAULT_MATCH_HISTORY_QUERY,
  matchHistoryQueryFromParams,
  matchHistoryQueryToParams,
  patchMatchHistoryQuery,
} from './matchHistoryQuery';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe('Match History URL state', () => {
  it('restores and serializes the canonical server query', () => {
    const query = matchHistoryQueryFromParams(new URLSearchParams(
      'q=major+final&page=3&page_size=50',
    ));

    expect(query).toEqual({
      search: 'major final',
      page: 3,
      pageSize: 50,
    });
    expect(matchHistoryQueryToParams(query).toString()).toBe(
      'q=major+final&page=3&page_size=50',
    );
  });

  it('fails closed for unknown, duplicate, aliased, or out-of-range parameters', () => {
    const invalidQueries = [
      'search=major',
      'unknown=value',
      'q=first&q=second',
      'page=0',
      'page=100001',
      'page=1.5',
      'page_size=25',
      'page_size=201',
      'page_size=20&page_size=50',
      `q=${'x'.repeat(129)}`,
    ];

    for (const value of invalidQueries) {
      expect(
        () => matchHistoryQueryFromParams(new URLSearchParams(value)),
        value,
      ).toThrow('Invalid Match History query parameter');
    }
  });

  it('resets paging when the server result set changes', () => {
    const thirdPage = { ...DEFAULT_MATCH_HISTORY_QUERY, page: 3 };

    expect(patchMatchHistoryQuery(thirdPage, { search: 'nuke' }).page).toBe(1);
    expect(patchMatchHistoryQuery(thirdPage, { pageSize: 100 }).page).toBe(1);
    expect(patchMatchHistoryQuery(thirdPage, { page: 2 }).page).toBe(2);
    expect(patchMatchHistoryQuery(thirdPage, { search: '' }).page).toBe(3);
  });

  it('keeps a late response for an old URL from overwriting the current page', async () => {
    const oldQuery = { ...DEFAULT_MATCH_HISTORY_QUERY, search: 'old', page: 2 };
    const newQuery = { ...DEFAULT_MATCH_HISTORY_QUERY, search: 'new', page: 1 };
    let currentQuery = oldQuery;
    const oldResponse = deferred<string>();
    const newResponse = deferred<string>();
    const committed: string[] = [];

    const oldRequest = commitCurrentMatchHistoryPage(
      oldQuery,
      () => oldResponse.promise,
      () => currentQuery,
      (response) => committed.push(response),
    );
    currentQuery = newQuery;
    const newRequest = commitCurrentMatchHistoryPage(
      newQuery,
      () => newResponse.promise,
      () => currentQuery,
      (response) => committed.push(response),
    );

    newResponse.resolve('new page');
    await expect(newRequest).resolves.toBe(true);
    oldResponse.resolve('old page');
    await expect(oldRequest).resolves.toBe(false);
    expect(committed).toEqual(['new page']);
  });
});
