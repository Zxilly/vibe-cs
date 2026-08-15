/*
 * `unit` project — the directory's state and its capped, ordered selection.
 *
 * The cap is the part §10.3 wrote down (「比较上限 2 名」), and it has to hold on
 * both sides: the checkbox path (`design/data/tableModel`, tested there) and
 * the URL path, which is what this file covers. A `compare=` value a user
 * pasted must not be able to smuggle in a third player.
 */

import { describe, expect, it } from 'vitest';

import type { PlayerDirectorySort } from '../../data/keys';
import {
  DEFAULT_PLAYER_DIRECTION,
  DEFAULT_PLAYER_SORT,
  EMPTY_PLAYER_DIRECTORY,
  PLAYER_COMPARE_LIMIT,
  PLAYER_PAGE_SIZE,
  PLAYER_SORTS,
  isCompareBlocked,
  readPlayerDirectory,
  reconcileCompare,
  toPlayerQuery,
  toggleCompare,
  writePlayerDirectory,
  type PlayerDirectoryState,
} from './playerDirectoryParams';

function read(search: string): PlayerDirectoryState {
  return readPlayerDirectory(new URLSearchParams(search));
}

describe('the §10.3 numbers', () => {
  it('pages at 20 and caps the comparison at 2', () => {
    // 「312 人、选择上限 2 时 20 个复选框禁用 18 个且不出现全选」.
    expect(PLAYER_PAGE_SIZE).toBe(20);
    expect(PLAYER_COMPARE_LIMIT).toBe(2);
  });
});

describe('reading the URL', () => {
  it('opens on the artboard s own ordering: K/D descending', () => {
    expect(read('')).toEqual(EMPTY_PLAYER_DIRECTORY);
    expect(EMPTY_PLAYER_DIRECTORY.sort).toBe('kd');
    expect(EMPTY_PLAYER_DIRECTORY.direction).toBe('desc');
  });

  it('accepts every sort the service declares and rejects the rest', () => {
    for (const sort of PLAYER_SORTS) {
      expect(read(`sort=${sort}`).sort).toBe(sort);
    }
    expect(read('sort=vibes').sort).toBe(DEFAULT_PLAYER_SORT);
    expect(read('dir=sideways').direction).toBe(DEFAULT_PLAYER_DIRECTION);
  });

  it('is the same list `PlayerDirectorySort` declares', () => {
    // The type is the contract; this array is its runtime shadow. A widened
    // union with no entry here would silently stop being reachable from a URL.
    const sorts: readonly PlayerDirectorySort[] = PLAYER_SORTS;
    expect(new Set(sorts).size).toBe(PLAYER_SORTS.length);
  });

  it('never lets the address bar exceed the comparison cap', () => {
    expect(read('compare=a,b,c').compare).toEqual(['a', 'b']);
  });

  it('drops blanks and duplicates out of the comparison list', () => {
    expect(read('compare=a,,a,%20b%20').compare).toEqual(['a', 'b']);
  });

  it('round-trips', () => {
    const state = read('q=Kael&sort=adr&dir=asc&page=4&compare=a,b&player=a');
    expect(readPlayerDirectory(writePlayerDirectory(state))).toEqual(state);
  });

  it('writes nothing for the default state', () => {
    expect(writePlayerDirectory(EMPTY_PLAYER_DIRECTORY).toString()).toBe('');
  });
});

describe('the IPC query', () => {
  it('always sends a sort, a direction and the page window', () => {
    expect(toPlayerQuery(EMPTY_PLAYER_DIRECTORY)).toEqual({
      sort: 'kd',
      direction: 'desc',
      page: 1,
      page_size: PLAYER_PAGE_SIZE,
    });
  });

  it('omits an empty search rather than sending an empty string', () => {
    // `{ search: '' }` would be a second cache entry for the unfiltered list.
    expect(toPlayerQuery(EMPTY_PLAYER_DIRECTORY)).not.toHaveProperty('search');
    expect(toPlayerQuery({ ...EMPTY_PLAYER_DIRECTORY, search: 'Kael' })).toMatchObject({
      search: 'Kael',
    });
  });
});

describe('the selection', () => {
  it('adds in the order the boxes were ticked', () => {
    expect(toggleCompare(toggleCompare([], 'a'), 'b')).toEqual(['a', 'b']);
  });

  it('refuses a third and does not trap the user', () => {
    expect(toggleCompare(['a', 'b'], 'c')).toEqual(['a', 'b']);
    expect(toggleCompare(['a', 'b'], 'a')).toEqual(['b']);
  });

  it('blocks only the unselected rows, and only at the cap', () => {
    expect(isCompareBlocked(['a'], 'b')).toBe(false);
    expect(isCompareBlocked(['a', 'b'], 'c')).toBe(true);
    expect(isCompareBlocked(['a', 'b'], 'a')).toBe(false);
  });

  it('keeps the existing order when DataTable hands back a Set', () => {
    // A Set cannot say which of the two is the left-hand player, and
    // 「比较 Kael 与 Sable」 must not swap sides when the other box is re-ticked.
    expect(reconcileCompare(['a', 'b'], new Set(['b', 'a']))).toEqual(['a', 'b']);
    expect(reconcileCompare(['a'], new Set(['a', 'b']))).toEqual(['a', 'b']);
    expect(reconcileCompare(['a', 'b'], new Set(['b']))).toEqual(['b']);
  });

  it('truncates a Set that somehow exceeded the cap', () => {
    expect(reconcileCompare([], new Set(['a', 'b', 'c']))).toHaveLength(PLAYER_COMPARE_LIMIT);
  });
});
