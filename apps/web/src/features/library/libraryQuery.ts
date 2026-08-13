import type {
  DemoLifecycleStatus,
  DemoQuery,
  DemoSort,
} from '../../shared/desktop/dto';
import type { LibrarySort, LibrarySortKey } from './libraryTable';

export const LIBRARY_PAGE_SIZES = [20, 50, 100, 200] as const;
export const DEFAULT_LIBRARY_COLUMNS = [
  'map',
  'score',
  'played',
  'duration',
  'rounds',
  'updated',
] as const;
export type LibraryOptionalColumn = (typeof DEFAULT_LIBRARY_COLUMNS)[number];
const LIBRARY_MAX_PAGE = 100_000;

export type LibraryQueryState = {
  search: string;
  map: string;
  status: DemoLifecycleStatus | 'all';
  sort: DemoSort;
  page: number;
  pageSize: (typeof LIBRARY_PAGE_SIZES)[number];
  columns: LibraryOptionalColumn[];
};

export const DEFAULT_LIBRARY_QUERY: LibraryQueryState = {
  search: '',
  map: '',
  status: 'all',
  sort: 'updated_desc',
  page: 1,
  pageSize: 50,
  columns: [...DEFAULT_LIBRARY_COLUMNS],
};

const LIFECYCLE_STATUSES = new Set<DemoLifecycleStatus>([
  'discovered',
  'indexing',
  'ready',
  'analyzing',
  'failed',
  'missing',
]);

const DEMO_SORTS = new Set<DemoSort>([
  'updated_desc', 'updated_asc',
  'file_asc', 'file_desc',
  'status_asc', 'status_desc',
  'map_asc', 'map_desc',
  'score_asc', 'score_desc',
  'duration_asc', 'duration_desc',
  'rounds_asc', 'rounds_desc',
]);
const LIBRARY_QUERY_PARAMETERS = new Set(['q', 'map', 'status', 'sort', 'page', 'page_size', 'columns']);

function positiveInteger(value: string | null): number | null {
  if (!value || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function invalidLibraryQuery(parameter: string): never {
  throw new Error(`Invalid Library query parameter: ${parameter}`);
}

export function libraryQueryFromParams(params: URLSearchParams): LibraryQueryState {
  for (const key of params.keys()) {
    if (!LIBRARY_QUERY_PARAMETERS.has(key) || params.getAll(key).length !== 1) {
      invalidLibraryQuery(key);
    }
  }
  const status = params.get('status');
  const sort = params.get('sort');
  const rawPage = params.get('page');
  const rawPageSize = params.get('page_size');
  const rawColumns = params.get('columns');
  const requestedColumns = rawColumns === null || rawColumns === '' ? [] : rawColumns.split(',');
  const page = positiveInteger(rawPage);
  const pageSize = positiveInteger(rawPageSize);
  if (status !== null && !LIFECYCLE_STATUSES.has(status as DemoLifecycleStatus)) {
    invalidLibraryQuery('status');
  }
  if (sort !== null && !DEMO_SORTS.has(sort as DemoSort)) {
    invalidLibraryQuery('sort');
  }
  if (rawPage !== null && (page === null || page > LIBRARY_MAX_PAGE)) {
    invalidLibraryQuery('page');
  }
  if (rawPageSize !== null && !LIBRARY_PAGE_SIZES.includes(pageSize as LibraryQueryState['pageSize'])) {
    invalidLibraryQuery('page_size');
  }
  if (rawColumns !== null && (
    new Set(requestedColumns).size !== requestedColumns.length
    || requestedColumns.some((column) => !DEFAULT_LIBRARY_COLUMNS.includes(column as LibraryOptionalColumn))
  )) {
    invalidLibraryQuery('columns');
  }
  return {
    search: params.get('q') ?? DEFAULT_LIBRARY_QUERY.search,
    map: params.get('map') ?? DEFAULT_LIBRARY_QUERY.map,
    status: status === null ? DEFAULT_LIBRARY_QUERY.status : status as DemoLifecycleStatus,
    sort: sort === null ? DEFAULT_LIBRARY_QUERY.sort : sort as DemoSort,
    page: page ?? DEFAULT_LIBRARY_QUERY.page,
    pageSize: pageSize === null
      ? DEFAULT_LIBRARY_QUERY.pageSize
      : pageSize as LibraryQueryState['pageSize'],
    columns: rawColumns === null
      ? [...DEFAULT_LIBRARY_COLUMNS]
      : DEFAULT_LIBRARY_COLUMNS.filter((column) => requestedColumns.includes(column)),
  };
}

export function libraryQueryToParams(query: LibraryQueryState): URLSearchParams {
  const params = new URLSearchParams();
  if (query.search) params.set('q', query.search);
  if (query.map) params.set('map', query.map);
  if (query.status !== 'all') params.set('status', query.status);
  if (query.sort !== DEFAULT_LIBRARY_QUERY.sort) params.set('sort', query.sort);
  if (query.page !== DEFAULT_LIBRARY_QUERY.page) params.set('page', String(query.page));
  if (query.pageSize !== DEFAULT_LIBRARY_QUERY.pageSize) params.set('page_size', String(query.pageSize));
  if (query.columns.join(',') !== DEFAULT_LIBRARY_COLUMNS.join(',')) {
    params.set('columns', query.columns.join(','));
  }
  return params;
}

export function libraryQueryToDemoQuery(query: LibraryQueryState): DemoQuery {
  return {
    ...(query.search.trim() ? { search: query.search.trim() } : {}),
    ...(query.map.trim() ? { map_name: query.map.trim() } : {}),
    ...(query.status !== 'all' ? { status: query.status } : {}),
    sort: query.sort,
    page: query.page,
    page_size: query.pageSize,
  };
}

export function patchLibraryQuery(
  current: LibraryQueryState,
  patch: Partial<LibraryQueryState>,
): LibraryQueryState {
  const changesResultSet = (['search', 'map', 'status', 'sort', 'pageSize'] as const)
    .some((key) => key in patch && patch[key] !== current[key]);
  return {
    ...current,
    ...patch,
    page: changesResultSet ? 1 : (patch.page ?? current.page),
  };
}

export function setLibraryColumnVisibility(
  current: readonly LibraryOptionalColumn[],
  column: LibraryOptionalColumn,
  visible: boolean,
): LibraryOptionalColumn[] {
  const next = new Set(current);
  if (visible) next.add(column);
  else next.delete(column);
  return DEFAULT_LIBRARY_COLUMNS.filter((candidate) => next.has(candidate));
}

export function tableSortFromServerSort(sort: DemoSort): LibrarySort {
  const separator = sort.lastIndexOf('_');
  return {
    key: sort.slice(0, separator) as LibrarySortKey,
    direction: sort.slice(separator + 1) as LibrarySort['direction'],
  };
}

export function toggleLibraryTableSort(current: DemoSort, key: LibrarySortKey): DemoSort {
  const tableSort = tableSortFromServerSort(current);
  const direction = tableSort.key === key && tableSort.direction === 'asc' ? 'desc' : 'asc';
  return `${key}_${direction}` as DemoSort;
}

export function libraryPageCount(total: number, pageSize: number): number {
  return Math.max(1, Math.ceil(total / pageSize));
}
