import { isCanonicalSteamId } from '../../shared/desktop/playerContract';
import type { PlayerDirectorySort } from './playerPresentation';

const PLAYER_DIRECTORY_PARAMETERS = new Set([
  'q',
  'page',
  'sort',
  'direction',
  'compare',
  'player',
  'matches_page',
  'maps_page',
  'heatmap_map',
  'heatmap_kind',
  'inspector',
]);
const PLAYER_SORT_KEYS = new Set<PlayerDirectorySort['key']>([
  'player',
  'team',
  'matches',
  'kd',
  'kills',
  'deaths',
  'assists',
  'headshots',
  'adr',
  'damage',
  'last_match',
]);
const PLAYER_SORT_DIRECTIONS = new Set<PlayerDirectorySort['direction']>(['asc', 'desc']);
const maximumPage = 10_000;
const maximumSearchCharacters = 128;

export type PlayerDirectoryQuery = {
  search: string;
  page: number;
  sort: PlayerDirectorySort;
  comparedIds: string[];
  playerId: string | null;
  matchesPage: number;
  mapsPage: number;
  heatmapMap: string | null;
  heatmapKind: 'all' | 'kills' | 'deaths';
  inspectorOpen: boolean;
};

export const DEFAULT_PLAYER_DIRECTORY_QUERY: PlayerDirectoryQuery = {
  search: '',
  page: 1,
  sort: { key: 'last_match', direction: 'desc' },
  comparedIds: [],
  playerId: null,
  matchesPage: 1,
  mapsPage: 1,
  heatmapMap: null,
  heatmapKind: 'all',
  inspectorOpen: false,
};

function invalid(parameter: string): never {
  throw new Error(`Invalid Player Directory query parameter: ${parameter}`);
}

function positivePage(value: string | null, parameter: string): number {
  if (value === null) return 1;
  if (!/^\d+$/.test(value)) return invalid(parameter);
  const parsed = Number(value);
  assertPage(parsed, parameter);
  return parsed;
}

function assertPage(value: number, parameter: string): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximumPage) invalid(parameter);
}

function assertSelection(
  comparedIds: readonly string[],
  playerId: string | null,
  matchesPage: number,
  mapsPage: number,
  heatmapMap: string | null,
  heatmapKind: PlayerDirectoryQuery['heatmapKind'],
  inspectorOpen: boolean,
): void {
  assertPage(matchesPage, 'matches_page');
  assertPage(mapsPage, 'maps_page');
  if (
    comparedIds.length > 2
    || comparedIds.some((id) => !isCanonicalSteamId(id))
    || new Set(comparedIds).size !== comparedIds.length
  ) invalid('compare');
  if (playerId !== null && !isCanonicalSteamId(playerId)) invalid('player');
  if (
    (comparedIds.length === 0 && playerId !== null)
    || (comparedIds.length === 1 && playerId !== comparedIds[0])
    || (comparedIds.length === 2 && playerId !== null)
  ) invalid('player');
  if (playerId === null && matchesPage !== 1) invalid('matches_page');
  if (playerId === null && mapsPage !== 1) invalid('maps_page');
  if (
    heatmapMap !== null
    && (playerId === null
      || heatmapMap !== heatmapMap.trim()
      || Array.from(heatmapMap).length < 1
      || Array.from(heatmapMap).length > 128
      || /[\u0000-\u001f\u007f]/u.test(heatmapMap))
  ) invalid('heatmap_map');
  if (!(['all', 'kills', 'deaths'] as const).includes(heatmapKind)) invalid('heatmap_kind');
  if (heatmapMap === null && heatmapKind !== 'all') invalid('heatmap_kind');
  if (inspectorOpen && comparedIds.length === 0) invalid('inspector');
}

export function playerDirectoryQueryFromParams(params: URLSearchParams): PlayerDirectoryQuery {
  for (const key of params.keys()) {
    if (!PLAYER_DIRECTORY_PARAMETERS.has(key) || params.getAll(key).length !== 1) invalid(key);
  }
  const search = params.get('q') ?? '';
  if (Array.from(search).length > maximumSearchCharacters) invalid('q');
  const rawSort = params.get('sort');
  const rawDirection = params.get('direction');
  if (rawSort !== null && !PLAYER_SORT_KEYS.has(rawSort as PlayerDirectorySort['key'])) invalid('sort');
  if (
    rawDirection !== null
    && !PLAYER_SORT_DIRECTIONS.has(rawDirection as PlayerDirectorySort['direction'])
  ) invalid('direction');
  const rawPlayer = params.get('player');
  const rawCompare = params.get('compare');
  if (rawCompare !== null && rawPlayer === null) invalid('compare');
  const comparedIds = rawPlayer === null
    ? []
    : rawCompare === null ? [rawPlayer] : [rawPlayer, rawCompare];
  const playerId = rawCompare === null ? rawPlayer : null;
  const matchesPage = positivePage(params.get('matches_page'), 'matches_page');
  const mapsPage = positivePage(params.get('maps_page'), 'maps_page');
  const heatmapMap = params.get('heatmap_map');
  const rawHeatmapKind = params.get('heatmap_kind');
  const heatmapKind = (rawHeatmapKind ?? 'all') as PlayerDirectoryQuery['heatmapKind'];
  const rawInspector = params.get('inspector');
  if (rawInspector !== null && rawInspector !== '1') invalid('inspector');
  const inspectorOpen = rawInspector === '1';
  assertSelection(
    comparedIds,
    playerId,
    matchesPage,
    mapsPage,
    heatmapMap,
    heatmapKind,
    inspectorOpen,
  );
  return {
    search,
    page: positivePage(params.get('page'), 'page'),
    sort: {
      key: (rawSort ?? DEFAULT_PLAYER_DIRECTORY_QUERY.sort.key) as PlayerDirectorySort['key'],
      direction: (rawDirection
        ?? DEFAULT_PLAYER_DIRECTORY_QUERY.sort.direction) as PlayerDirectorySort['direction'],
    },
    comparedIds,
    playerId,
    matchesPage,
    mapsPage,
    heatmapMap,
    heatmapKind,
    inspectorOpen,
  };
}

export function playerDirectoryQueryToParams(query: PlayerDirectoryQuery): URLSearchParams {
  assertSelection(
    query.comparedIds,
    query.playerId,
    query.matchesPage,
    query.mapsPage,
    query.heatmapMap,
    query.heatmapKind,
    query.inspectorOpen,
  );
  if (Array.from(query.search).length > maximumSearchCharacters) invalid('q');
  if (!PLAYER_SORT_KEYS.has(query.sort.key)) invalid('sort');
  if (!PLAYER_SORT_DIRECTIONS.has(query.sort.direction)) invalid('direction');
  assertPage(query.page, 'page');
  const params = new URLSearchParams();
  if (query.search) params.set('q', query.search);
  if (query.page !== 1) params.set('page', String(query.page));
  if (query.sort.key !== DEFAULT_PLAYER_DIRECTORY_QUERY.sort.key) params.set('sort', query.sort.key);
  if (query.sort.direction !== DEFAULT_PLAYER_DIRECTORY_QUERY.sort.direction) {
    params.set('direction', query.sort.direction);
  }
  if (query.comparedIds[0]) params.set('player', query.comparedIds[0]);
  if (query.comparedIds[1]) params.set('compare', query.comparedIds[1]);
  if (query.matchesPage !== 1) params.set('matches_page', String(query.matchesPage));
  if (query.mapsPage !== 1) params.set('maps_page', String(query.mapsPage));
  if (query.heatmapMap !== null) params.set('heatmap_map', query.heatmapMap);
  if (query.heatmapKind !== 'all') params.set('heatmap_kind', query.heatmapKind);
  if (query.inspectorOpen) params.set('inspector', '1');
  return params;
}

export function patchPlayerDirectoryQuery(
  current: PlayerDirectoryQuery,
  patch: Partial<PlayerDirectoryQuery>,
): PlayerDirectoryQuery {
  const changesDirectoryResult = (
    ('search' in patch && patch.search !== current.search)
    || ('sort' in patch && (
      patch.sort?.key !== current.sort.key
      || patch.sort.direction !== current.sort.direction
    ))
  );
  const nextSelection = patch.comparedIds ? [...patch.comparedIds] : [...current.comparedIds];
  const nextPlayerId = patch.playerId === undefined ? current.playerId : patch.playerId;
  const playerChanged = nextPlayerId !== current.playerId;
  const next = {
    ...current,
    ...patch,
    sort: patch.sort ?? current.sort,
    comparedIds: nextSelection,
    page: changesDirectoryResult ? 1 : (patch.page ?? current.page),
    matchesPage: patch.playerId === null ? 1 : (patch.matchesPage ?? current.matchesPage),
    mapsPage: patch.playerId === null ? 1 : (patch.mapsPage ?? current.mapsPage),
    heatmapMap: nextPlayerId === null || playerChanged
      ? null
      : (patch.heatmapMap === undefined ? current.heatmapMap : patch.heatmapMap),
    heatmapKind: nextPlayerId === null || playerChanged || patch.heatmapMap === null
      ? 'all' as const
      : (patch.heatmapKind ?? current.heatmapKind),
    inspectorOpen: nextSelection.length === 0
      ? false
      : (patch.inspectorOpen ?? current.inspectorOpen),
  };
  assertSelection(
    next.comparedIds,
    next.playerId,
    next.matchesPage,
    next.mapsPage,
    next.heatmapMap,
    next.heatmapKind,
    next.inspectorOpen,
  );
  return next;
}
