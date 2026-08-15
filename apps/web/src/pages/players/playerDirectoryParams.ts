/*
 * pages/players — the directory's state, in the address bar.
 *
 * 「06 玩家目录」 draws a searchable, sortable table with a capped selection
 * (「已选 2 名 · 比较上限 2 名」) and a comparison panel built from that
 * selection. All four — the search text, the sort, the page and *which two
 * players are being compared* — are shareable facts, so all four live in the
 * query string per §4.4. Sending someone 「比较 Kael 与 Sable」 is a link, not a
 * screenshot.
 *
 * Pure, so `playerDirectoryParams.test.ts` exhausts it in the `unit` project.
 */

import type { PlayerDirectoryQuery, PlayerDirectorySort } from '../../data/keys';
import { pickQueryValue } from '../routeQuery';

/* ── the contract §10.3 measured ─────────────────────────────────────────── */

/**
 * 20 rows per page. §10.3's density review states the directory's own
 * arithmetic in those terms — 「312 人、选择上限 2 时 20 个复选框禁用 18 个且不
 * 出现全选」 — so the page size is part of that contract and is asserted, not
 * chosen per render.
 */
export const PLAYER_PAGE_SIZE = 20;

/**
 * 「比较上限 2 名」, printed on the artboard's selection bar. `DataTable` takes
 * it as `selectionLimit`, which does two things at once: it disables the
 * unselected checkboxes at the cap (rather than hiding them, §8) and it
 * suppresses the select-all box entirely — 「a select-all contradicts a cap」,
 * in `DataTable`'s own words.
 */
export const PLAYER_COMPARE_LIMIT = 2;

/* ── sorting ─────────────────────────────────────────────────────────────── */

/**
 * The sorts `commands.listPlayers` accepts, re-listed as a runtime array
 * because `PlayerDirectorySort` is a type. `data/keys.ts` owns the type; this
 * is the value form the URL parser validates against, and
 * `playerDirectoryParams.test.ts` pins the two in step.
 */
export const PLAYER_SORTS = [
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
] as const satisfies readonly PlayerDirectorySort[];

export const PLAYER_SORT_DIRECTIONS = ['asc', 'desc'] as const;
export type PlayerSortDirection = (typeof PLAYER_SORT_DIRECTIONS)[number];

/**
 * The artboard's own ordering: 「Kael 1.42 / Sable 1.28 / Rhea 1.19 …」 is K/D
 * descending. `listPlayers` requires both a sort and a direction, so there is
 * no "unsorted" state to fall back to.
 */
export const DEFAULT_PLAYER_SORT: PlayerDirectorySort = 'kd';
export const DEFAULT_PLAYER_DIRECTION: PlayerSortDirection = 'desc';

/* ── the state ───────────────────────────────────────────────────────────── */

export interface PlayerDirectoryState {
  /** 「搜索选手或别名」 */
  readonly search: string;
  readonly sort: PlayerDirectorySort;
  readonly direction: PlayerSortDirection;
  readonly page: number;
  /** The checked rows, at most `PLAYER_COMPARE_LIMIT`, in the order chosen —
   *  the panel prints 「比较 Kael 与 Sable」 in that order. */
  readonly compare: readonly string[];
  /** The row the Inspector is describing. Different from `compare`: the
   *  artboard checks two boxes and paints exactly one row accent-100. */
  readonly activeId: string;
}

export const EMPTY_PLAYER_DIRECTORY: PlayerDirectoryState = {
  search: '',
  sort: DEFAULT_PLAYER_SORT,
  direction: DEFAULT_PLAYER_DIRECTION,
  page: 1,
  compare: [],
  activeId: '',
};

export interface ReadableParams {
  get(name: string): string | null;
}

export function readPlayerDirectory(params: ReadableParams): PlayerDirectoryState {
  return {
    search: (params.get('q') ?? '').trim(),
    sort: pickQueryValue(params.get('sort'), PLAYER_SORTS, DEFAULT_PLAYER_SORT),
    direction: pickQueryValue(
      params.get('dir'),
      PLAYER_SORT_DIRECTIONS,
      DEFAULT_PLAYER_DIRECTION,
    ),
    page: pageNumber(params.get('page')),
    compare: readCompare(params.get('compare')),
    activeId: (params.get('player') ?? '').trim(),
  };
}

export function writePlayerDirectory(state: PlayerDirectoryState): URLSearchParams {
  const params = new URLSearchParams();
  if (state.search !== '') params.set('q', state.search);
  if (state.sort !== DEFAULT_PLAYER_SORT) params.set('sort', state.sort);
  if (state.direction !== DEFAULT_PLAYER_DIRECTION) params.set('dir', state.direction);
  if (state.page > 1) params.set('page', String(state.page));
  if (state.compare.length > 0) params.set('compare', state.compare.join(','));
  if (state.activeId !== '') params.set('player', state.activeId);
  return params;
}

/**
 * The `listPlayers` argument. `search` is omitted when empty rather than sent
 * as `''` — the cache key is the query object, and `{ search: '' }` would be a
 * second entry for the unfiltered list.
 */
export function toPlayerQuery(state: PlayerDirectoryState): PlayerDirectoryQuery {
  return {
    sort: state.sort,
    direction: state.direction,
    page: state.page,
    page_size: PLAYER_PAGE_SIZE,
    ...(state.search === '' ? {} : { search: state.search }),
  };
}

/* ── the selection ───────────────────────────────────────────────────────── */

/**
 * Toggling one row's checkbox, capped.
 *
 * `design/data/tableModel`'s `toggleSelection` already implements the cap over
 * a `Set`, and this is the ordered form of the same rule: a comparison has a
 * left and a right, so 「比较 Kael 与 Sable」 needs the order the user picked and
 * a `Set`'s iteration order is insertion order only by accident of the
 * standard. Removing always works — a cap must never trap the user.
 */
export function toggleCompare(
  compare: readonly string[],
  steamId: string,
  limit: number = PLAYER_COMPARE_LIMIT,
): readonly string[] {
  if (compare.includes(steamId)) return compare.filter((id) => id !== steamId);
  if (compare.length >= limit) return compare;
  return [...compare, steamId];
}

/**
 * The ordered selection after `DataTable` handed back an unordered one.
 *
 * `DataTable` speaks `Set<string>`: it applies the cap and the toggle itself
 * (`tableModel.toggleSelection`), which is the behaviour this page wants, but a
 * `Set` cannot say which of the two players is the left-hand one. So the ids
 * already in `previous` keep their positions and anything new is appended —
 * which makes 「比较 Kael 与 Sable」 read in the order the boxes were ticked, and
 * makes re-ticking a box that was already there a no-op rather than a reshuffle.
 */
export function reconcileCompare(
  previous: readonly string[],
  next: ReadonlySet<string>,
): readonly string[] {
  const kept = previous.filter((id) => next.has(id));
  const added = [...next].filter((id) => !previous.includes(id));
  return [...kept, ...added].slice(0, PLAYER_COMPARE_LIMIT);
}

/** Whether an *unselected* row's checkbox has to be disabled — the same
 *  question `tableModel.isSelectionBlocked` answers for the `Set` form. */
export function isCompareBlocked(
  compare: readonly string[],
  steamId: string,
  limit: number = PLAYER_COMPARE_LIMIT,
): boolean {
  return !compare.includes(steamId) && compare.length >= limit;
}

/* ── parsing ─────────────────────────────────────────────────────────────── */

/**
 * `compare=a,b`. Blanks and duplicates are dropped and the list is truncated to
 * the cap, because the value comes off a URL a human may have edited and an
 * over-long list would let the address bar bypass the limit the UI enforces.
 */
function readCompare(value: string | null): readonly string[] {
  if (value === null) return [];
  const seen: string[] = [];
  for (const raw of value.split(',')) {
    const id = raw.trim();
    if (id === '' || seen.includes(id)) continue;
    seen.push(id);
    if (seen.length === PLAYER_COMPARE_LIMIT) break;
  }
  return seen;
}

function pageNumber(value: string | null): number {
  if (value === null) return 1;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) return 1;
  return parsed;
}
