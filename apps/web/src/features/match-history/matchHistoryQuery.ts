export const MATCH_HISTORY_PAGE_SIZES = [20, 50, 100, 200] as const;
export const MAXIMUM_MATCH_HISTORY_PAGE = 100_000;
export const MAXIMUM_MATCH_HISTORY_SEARCH_CHARACTERS = 128;

type MatchHistoryPageSize = (typeof MATCH_HISTORY_PAGE_SIZES)[number];

export type MatchHistoryQueryState = {
  search: string;
  page: number;
  pageSize: MatchHistoryPageSize;
};

export const DEFAULT_MATCH_HISTORY_QUERY: MatchHistoryQueryState = {
  search: '',
  page: 1,
  pageSize: 20,
};

const MATCH_HISTORY_QUERY_PARAMETERS = new Set(['q', 'page', 'page_size']);

function positiveInteger(value: string | null): number | null {
  if (!value || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function invalidMatchHistoryQuery(parameter: string): never {
  throw new Error(`Invalid Match History query parameter: ${parameter}`);
}

export function matchHistoryQueryFromParams(params: URLSearchParams): MatchHistoryQueryState {
  for (const key of params.keys()) {
    if (!MATCH_HISTORY_QUERY_PARAMETERS.has(key) || params.getAll(key).length !== 1) {
      invalidMatchHistoryQuery(key);
    }
  }
  const search = params.get('q') ?? DEFAULT_MATCH_HISTORY_QUERY.search;
  const rawPage = params.get('page');
  const rawPageSize = params.get('page_size');
  const page = positiveInteger(rawPage);
  const pageSize = positiveInteger(rawPageSize);
  if (Array.from(search).length > MAXIMUM_MATCH_HISTORY_SEARCH_CHARACTERS) {
    invalidMatchHistoryQuery('q');
  }
  if (rawPage !== null && (page === null || page > MAXIMUM_MATCH_HISTORY_PAGE)) {
    invalidMatchHistoryQuery('page');
  }
  if (rawPageSize !== null && !MATCH_HISTORY_PAGE_SIZES.includes(pageSize as MatchHistoryPageSize)) {
    invalidMatchHistoryQuery('page_size');
  }
  return {
    search,
    page: page ?? DEFAULT_MATCH_HISTORY_QUERY.page,
    pageSize: pageSize === null
      ? DEFAULT_MATCH_HISTORY_QUERY.pageSize
      : pageSize as MatchHistoryPageSize,
  };
}

export function matchHistoryQueryToParams(query: MatchHistoryQueryState): URLSearchParams {
  const params = new URLSearchParams();
  if (query.search) params.set('q', query.search);
  if (query.page !== DEFAULT_MATCH_HISTORY_QUERY.page) params.set('page', String(query.page));
  if (query.pageSize !== DEFAULT_MATCH_HISTORY_QUERY.pageSize) {
    params.set('page_size', String(query.pageSize));
  }
  return params;
}

export function patchMatchHistoryQuery(
  current: MatchHistoryQueryState,
  patch: Partial<MatchHistoryQueryState>,
): MatchHistoryQueryState {
  const changesResultSet = (['search', 'pageSize'] as const)
    .some((key) => key in patch && patch[key] !== current[key]);
  return {
    ...current,
    ...patch,
    page: changesResultSet ? 1 : (patch.page ?? current.page),
  };
}

export async function commitCurrentMatchHistoryPage<Response>(
  requestedQuery: MatchHistoryQueryState,
  load: () => Promise<Response>,
  currentQuery: () => MatchHistoryQueryState,
  commit: (response: Response) => void,
  signal?: AbortSignal,
): Promise<boolean> {
  const response = await load();
  const requestedKey = matchHistoryQueryToParams(requestedQuery).toString();
  const currentKey = matchHistoryQueryToParams(currentQuery()).toString();
  if (signal?.aborted || requestedKey !== currentKey) return false;
  commit(response);
  return true;
}
