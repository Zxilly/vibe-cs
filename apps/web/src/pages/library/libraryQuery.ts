/*
 * pages/library — the address of 「02 Demo 资料库」.
 *
 * §7 gives the route one query parameter by name (`?view=table|card`), but the
 * artboard's filter strip adds six more controls — search, map, status, source,
 * tag, and the pager — and every one of them has to survive a reload, a back
 * button and a link pasted into a session. §4.4 already settled the principle
 * for the match workspace ("URL 是唯一真值"); this is the same decision applied
 * to the library.
 *
 * The module is pure and node-testable: reading the address, turning it into
 * the `DemoQuery` the bridge takes, and writing a change back are three
 * functions with no React in them.
 *
 * One rule about the `DemoQuery` it builds: **absent, never `undefined`.** The
 * workspace compiles with `exactOptionalPropertyTypes`, and `keys.ts` hashes
 * the query object whole — `{ search: undefined }` and `{}` are two different
 * cache entries for one filter, which is a duplicated IPC call and a table that
 * flickers between two identical pages.
 */

import type { SortState } from '../../design/data';
import type { DemoLifecycleStatus, DemoMatchSource, DemoQuery, DemoSort } from '../../shared/desktop/dto';

/* ── the two views ───────────────────────────────────────────────────────── */

export const LIBRARY_VIEWS = ['table', 'card'] as const;
export type LibraryView = (typeof LIBRARY_VIEWS)[number];

/**
 * §10.3 did the arithmetic: 「248 行资料库分页后表里 20 行且页脚印『共 248 条』」.
 * 248 rows at `--h-row` (42px) is 10 416px of table — silently taller than any
 * window, which the same section calls a bug rather than a layout.
 */
export const LIBRARY_PAGE_SIZE = 20;

/** 「已选 3 场 · 上限 12 场」, printed on the artboard's selection bar. */
export const DEMO_SELECTION_LIMIT = 12;

/** The wire's default ordering, and the one no column header selects. */
export const DEFAULT_DEMO_SORT: DemoSort = 'updated_desc';

/* ── the address ─────────────────────────────────────────────────────────── */

/**
 * Every filter the strip can set. Empty string is 「全部」 for the four
 * dropdowns, because that is what an absent query parameter reads back as and
 * a second spelling for "no filter" is a second branch at every call site.
 */
export interface LibraryAddress {
  readonly view: LibraryView;
  /** 1-based, matching `Pagination` and the wire. */
  readonly page: number;
  readonly search: string;
  readonly map: string;
  readonly status: DemoLifecycleStatus | '';
  readonly source: DemoMatchSource | '';
  readonly tagId: string;
  readonly sort: DemoSort;
}

const DEMO_LIFECYCLE_STATUSES: readonly DemoLifecycleStatus[] = [
  'discovered',
  'indexing',
  'ready',
  'analyzing',
  'failed',
  'missing',
];

const DEMO_MATCH_SOURCES: readonly DemoMatchSource[] = [
  'challengermode', 'ebot', 'esl', 'esplay', 'esportal', 'esportligaen',
  'faceit', 'fastcup', 'five_eplay', 'matchzy', 'perfect_world', 'pracc',
  'renown', 'valve',
];

const DEMO_SORTS: readonly DemoSort[] = [
  'updated_desc', 'updated_asc',
  'file_asc', 'file_desc',
  'status_asc', 'status_desc',
  'map_asc', 'map_desc',
  'score_asc', 'score_desc',
  'duration_asc', 'duration_desc',
  'rounds_asc', 'rounds_desc',
];

/**
 * The address as the page reads it. An unrecognised value falls back rather
 * than rendering nothing — `pages/routeQuery.ts` states the reason: a stale or
 * hand-typed deep link is a navigation, not an error.
 */
export function readLibraryAddress(params: URLSearchParams): LibraryAddress {
  return {
    view: oneOf(params.get('view'), LIBRARY_VIEWS, 'table'),
    page: readPage(params.get('page')),
    search: params.get('q') ?? '',
    map: params.get('map') ?? '',
    status: oneOf(params.get('status'), DEMO_LIFECYCLE_STATUSES, ''),
    source: oneOf(params.get('source'), DEMO_MATCH_SOURCES, ''),
    tagId: params.get('tag') ?? '',
    sort: oneOf(params.get('sort'), DEMO_SORTS, DEFAULT_DEMO_SORT),
  };
}

function oneOf<T extends string, F extends string>(
  value: string | null,
  allowed: readonly T[],
  fallback: F,
): T | F {
  if (value === null) return fallback;
  return allowed.includes(value as T) ? (value as T) : fallback;
}

function readPage(value: string | null): number {
  if (value === null) return 1;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 1 ? parsed : 1;
}

/**
 * The address back as search parameters. Defaults are dropped, so 「/library」
 * stays 「/library」 — a URL that grows six redundant parameters the moment a
 * user touches anything is not a shareable address.
 */
export function writeLibraryAddress(address: LibraryAddress): URLSearchParams {
  const params = new URLSearchParams();
  if (address.view !== 'table') params.set('view', address.view);
  if (address.search !== '') params.set('q', address.search);
  if (address.map !== '') params.set('map', address.map);
  if (address.status !== '') params.set('status', address.status);
  if (address.source !== '') params.set('source', address.source);
  if (address.tagId !== '') params.set('tag', address.tagId);
  if (address.sort !== DEFAULT_DEMO_SORT) params.set('sort', address.sort);
  if (address.page > 1) params.set('page', String(address.page));
  return params;
}

/**
 * A change to the address. Any field but `page` resets to page 1: staying on
 * page 9 while narrowing a filter to eleven rows shows an empty table that
 * looks like 「没有命中」 and is not.
 */
export function changeLibraryAddress(
  address: LibraryAddress,
  change: Partial<LibraryAddress>,
): LibraryAddress {
  const onlyPage = Object.keys(change).every((key) => key === 'page');
  return { ...address, ...(onlyPage ? {} : { page: 1 }), ...change };
}

/* ── the wire query ──────────────────────────────────────────────────────── */

/** The `DemoQuery` this address asks the bridge for. */
export function libraryDemoQuery(address: LibraryAddress): DemoQuery {
  return {
    ...(address.search === '' ? {} : { search: address.search }),
    ...(address.map === '' ? {} : { map_name: address.map }),
    ...(address.status === '' ? {} : { status: address.status }),
    ...(address.source === '' ? {} : { match_source: address.source }),
    ...(address.tagId === '' ? {} : { tag_id: address.tagId }),
    sort: address.sort,
    page: address.page,
    page_size: LIBRARY_PAGE_SIZE,
  };
}

/** Whether anything but the view and the page is narrowing the list. */
export function hasActiveFilter(address: LibraryAddress): boolean {
  return (
    address.search !== ''
    || address.map !== ''
    || address.status !== ''
    || address.source !== ''
    || address.tagId !== ''
  );
}

/** 「清空条件」 — keeps where you are looking, drops what you were looking for. */
export function clearLibraryFilters(address: LibraryAddress): LibraryAddress {
  return { ...address, search: '', map: '', status: '', source: '', tagId: '', page: 1 };
}

/* ── sorting ─────────────────────────────────────────────────────────────── */

/**
 * The columns the wire can sort by, and the `DemoSort` each direction maps to.
 *
 * The artboard's 日期 column is deliberately absent: it renders `match_date`
 * (when the match was played) while the wire's only date ordering is
 * `updated_*` (when the record last changed). A header that sorted by a
 * different field than the one under it is worse than a header that does not
 * sort, so 日期 stays unsorted and `updated_desc` remains the default order.
 */
export const DEMO_SORT_BY_COLUMN: Readonly<Record<string, { asc: DemoSort; desc: DemoSort }>> = {
  match: { asc: 'file_asc', desc: 'file_desc' },
  map: { asc: 'map_asc', desc: 'map_desc' },
  duration: { asc: 'duration_asc', desc: 'duration_desc' },
  rounds: { asc: 'rounds_asc', desc: 'rounds_desc' },
  status: { asc: 'status_asc', desc: 'status_desc' },
};

/** What `DataTable` should draw in its header arrows for the current order. */
export function sortStateOf(sort: DemoSort): SortState | null {
  for (const [columnId, directions] of Object.entries(DEMO_SORT_BY_COLUMN)) {
    if (directions.asc === sort) return { columnId, direction: 'asc' };
    if (directions.desc === sort) return { columnId, direction: 'desc' };
  }
  return null;
}

/** The inverse: a header click, back to a `DemoSort`. */
export function demoSortOf(state: SortState | null): DemoSort {
  if (state === null) return DEFAULT_DEMO_SORT;
  const directions = DEMO_SORT_BY_COLUMN[state.columnId];
  if (directions === undefined) return DEFAULT_DEMO_SORT;
  return state.direction === 'asc' ? directions.asc : directions.desc;
}
