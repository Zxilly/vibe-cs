import { describe, expect, it } from 'vitest';

import {
  ariaSortFor,
  clampPage,
  columnConfigOptions,
  headerSelectionState,
  isSelectionBlocked,
  nextSortState,
  pageCount,
  pageRange,
  pageSlice,
  toggleAllSelection,
  toggleColumn,
  toggleSelection,
  visibleColumns,
} from './tableModel';

describe('nextSortState', () => {
  it('cycles unsorted → ascending → descending → unsorted', () => {
    const first = nextSortState(null, 'date');
    expect(first).toEqual({ columnId: 'date', direction: 'asc' });

    const second = nextSortState(first, 'date');
    expect(second).toEqual({ columnId: 'date', direction: 'desc' });

    // The default ordering has to be reachable again — 「05 证据检索」states one
    // ("排序：时间倒序") that a two-step cycle would strand.
    expect(nextSortState(second, 'date')).toBeNull();
  });

  it('restarts at ascending when a different column is clicked', () => {
    expect(nextSortState({ columnId: 'date', direction: 'desc' }, 'map')).toEqual({
      columnId: 'map',
      direction: 'asc',
    });
  });
});

describe('ariaSortFor', () => {
  it('reports the direction only for the sorted column', () => {
    const sort = { columnId: 'date', direction: 'desc' } as const;
    expect(ariaSortFor(sort, 'date')).toBe('descending');
    expect(ariaSortFor(sort, 'map')).toBe('none');
    expect(ariaSortFor(null, 'date')).toBe('none');
  });
});

describe('column configuration', () => {
  const columns = [
    { id: 'match', headerLabel: '比赛', hideable: false },
    { id: 'map', headerLabel: '地图' },
    { id: 'rounds', headerLabel: '回合数' },
    { id: 'size', configLabel: '文件大小' },
  ];

  it('keeps a non-hideable column visible even when it is in the hidden set', () => {
    const shown = visibleColumns(columns, new Set(['match', 'map']));
    expect(shown.map((column) => column.id)).toEqual(['match', 'rounds', 'size']);
  });

  it('offers only the hideable columns to the 列配置 dialog', () => {
    expect(columnConfigOptions(columns, new Set(['map']))).toEqual([
      { id: 'map', label: '地图', visible: false },
      { id: 'rounds', label: '回合数', visible: true },
      { id: 'size', label: '文件大小', visible: true },
    ]);
  });

  it('falls back to the column id when no label is given', () => {
    expect(columnConfigOptions([{ id: 'checksum' }])).toEqual([{ id: 'checksum', label: 'checksum', visible: true }]);
  });

  it('toggles a column without mutating the input', () => {
    const hidden = new Set(['map']);
    expect([...toggleColumn(hidden, 'rounds')]).toEqual(['map', 'rounds']);
    expect([...toggleColumn(hidden, 'map')]).toEqual([]);
    expect([...hidden]).toEqual(['map']);
  });
});

describe('selection', () => {
  it('adds and removes a row', () => {
    const empty = new Set<string>();
    const one = toggleSelection(empty, 'a');
    expect([...one]).toEqual(['a']);
    expect([...toggleSelection(one, 'a')]).toEqual([]);
    expect([...empty]).toEqual([]);
  });

  it('refuses to grow past the cap, and says so by identity', () => {
    const full = new Set(['a', 'b']);
    // "比较上限 2 名" — 「06 玩家目录」.
    expect(toggleSelection(full, 'c', { limit: 2 })).toBe(full);
  });

  it('always allows removal at the cap, so a limit cannot trap the user', () => {
    const full = new Set(['a', 'b']);
    expect([...toggleSelection(full, 'a', { limit: 2 })]).toEqual(['b']);
  });

  it('blocks only unselected rows once the cap is reached', () => {
    const full = new Set(['a', 'b']);
    expect(isSelectionBlocked(full, 'c', { limit: 2 })).toBe(true);
    expect(isSelectionBlocked(full, 'a', { limit: 2 })).toBe(false);
    expect(isSelectionBlocked(full, 'c')).toBe(false);
  });

  it('reads the header checkbox as none / some / all', () => {
    const rows = ['a', 'b', 'c'];
    expect(headerSelectionState(rows, new Set())).toBe('none');
    expect(headerSelectionState(rows, new Set(['b']))).toBe('some');
    expect(headerSelectionState(rows, new Set(rows))).toBe('all');
    expect(headerSelectionState([], new Set(['b']))).toBe('none');
  });

  it('selects and clears the page without touching rows on other pages', () => {
    const page = ['a', 'b'];
    const selected = new Set(['z']);

    const all = toggleAllSelection(page, selected);
    expect([...all].sort()).toEqual(['a', 'b', 'z']);

    expect([...toggleAllSelection(page, all)]).toEqual(['z']);
  });
});

describe('paging', () => {
  it('counts at least one page, even with no rows', () => {
    expect(pageCount(0, 20)).toBe(1);
    expect(pageCount(41, 20)).toBe(3);
  });

  it('clamps a page number into range', () => {
    expect(clampPage(0, 41, 20)).toBe(1);
    expect(clampPage(9, 41, 20)).toBe(3);
    expect(clampPage(Number.NaN, 41, 20)).toBe(1);
  });

  it('slices the requested page', () => {
    const rows = Array.from({ length: 5 }, (_, index) => index);
    expect(pageSlice(rows, 2, 2)).toEqual([2, 3]);
    expect(pageSlice(rows, 3, 2)).toEqual([4]);
    // Out of range collapses onto the last page rather than rendering nothing.
    expect(pageSlice(rows, 99, 2)).toEqual([4]);
  });

  it('reports the row span of the page', () => {
    expect(pageRange(41, 3, 20)).toEqual({ from: 41, to: 41 });
    expect(pageRange(41, 1, 20)).toEqual({ from: 1, to: 20 });
    expect(pageRange(0, 1, 20)).toEqual({ from: 0, to: 0 });
  });
});
