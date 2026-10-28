/* The URL owns search, sorting and comparison selection. The server pages
 * directory rows; selected profiles are fetched independently across pages. */

import { t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';

import { usePlayer, usePlayerDirectory } from '../../../data/players';
import { toDataError } from '../../../data/errors';
import {
  DataTable,
  Empty,
  Pagination,
  TableSkeleton,
  type DataTableColumn,
  type SortState,
} from '../../../design/data';
import { Alert } from '../../../design/feedback';
import { Page, SelectionBar, Toolbar, useCollapsed } from '../../../design/layout';
import { Button, Input } from '../../../design/primitives';
import type { PlayerDirectorySort } from '../../../data/keys';
import type { PlayerDirectoryItem } from '../../../shared/desktop/dto';
import { RouteLink } from '../../shared/navigation/RouteLink';
import { PlayerComparePanel } from './PlayerComparePanel';
import {
  DEFAULT_PLAYER_DIRECTION,
  DEFAULT_PLAYER_SORT,
  PLAYER_COMPARE_LIMIT,
  PLAYER_PAGE_SIZE,
  readPlayerDirectory,
  reconcileCompare,
  toPlayerQuery,
  writePlayerDirectory,
  type PlayerDirectoryState,
} from './playerDirectoryParams';
import { formatFixed, formatMonthDay, formatPercent, headshotRate, NO_VALUE } from './playerStats';

/** How long the box waits after the last keystroke before it filters. */
export const SEARCH_DEBOUNCE_MS = 250;

/**
 * Column ids *are* the service's sort names, so 「点表头排序」 needs no lookup
 * table and a column that cannot be sorted server-side simply does not declare
 * `sortable`. `PlayerDirectorySort` is imported for the cast-free check below.
 */
/*
 * A function, not a `const` table: `headerLabel` is copy — it is the column's
 * accessible name and its entry in 列配置 — so it goes through a `t` macro, and
 * a macro evaluated at module scope freezes whichever locale was active when
 * the module first loaded. Built per render, memoised by the caller.
 */
function directoryColumns(): readonly DataTableColumn<PlayerDirectoryItem>[] {
  return [
    {
      id: 'player',
      header: <Trans>选手</Trans>,
      headerLabel: t`选手`,
      hideable: false,
      minWidth: '180px',
      sortable: true,
      truncate: true,
      cell: (row) => (
        <span className="flex min-w-0 items-baseline gap-2" title={row.last_team === null ? row.name : `${row.name} · ${row.last_team}`}>
          <span className="min-w-0 truncate text-base">{row.name}</span>
          {row.last_team === null ? null : (
            <span className="flex-none text-xs text-neutral-600">· {row.last_team}</span>
          )}
        </span>
      ),
    },
    {
      id: 'matches',
      header: <Trans>比赛</Trans>,
      headerLabel: t`比赛`,
      variant: 'numeric',
      sortable: true,
      cell: (row) => formatFixed(row.stats.matches, 0),
    },
    {
      id: 'kd',
      header: <Trans>K/D</Trans>,
      headerLabel: t`K/D`,
      variant: 'numeric',
      sortable: true,
      cell: (row) => formatFixed(row.stats.average_kill_death_ratio, 2),
    },
    {
      id: 'adr',
      header: <Trans>ADR</Trans>,
      headerLabel: t`ADR`,
      variant: 'numeric',
      sortable: true,
      cell: (row) => formatFixed(row.stats.average_adr, 1),
    },
    {
      id: 'headshots',
      header: <Trans>爆头率</Trans>,
      headerLabel: t`爆头率`,
      variant: 'numeric',
      sortable: true,
      cell: (row) => formatPercent(headshotRate(row.stats)),
    },
    {
      id: 'kills',
      header: <Trans>击杀</Trans>,
      headerLabel: t`击杀`,
      variant: 'numeric',
      sortable: true,
      cell: (row) => formatFixed(row.stats.kills, 0),
    },
    {
      id: 'deaths',
      header: <Trans>死亡</Trans>,
      headerLabel: t`死亡`,
      variant: 'numeric',
      sortable: true,
      cell: (row) => formatFixed(row.stats.deaths, 0),
    },
    {
      id: 'last_match',
      header: <Trans>最近出场</Trans>,
      headerLabel: t`最近出场`,
      variant: 'numeric',
      sortable: true,
      cell: (row) => {
        const day = formatMonthDay(row.last_match_date);
        return day === '' ? NO_VALUE : day;
      },
    },
    {
      id: 'profile',
      headerLabel: t`档案`,
      hideable: false,
      width: '90px',
      cell: (row) => (
        <RouteLink to={`/players/${encodeURIComponent(row.steam_id)}`}>
          <Trans>档案</Trans>
        </RouteLink>
      ),
    },
  ];
}

export function PlayersPage() {
  // See `players/PlayerMapTable.tsx` for why the deps are empty.
  const columns = useMemo(directoryColumns, []);
  const [params, setParams] = useSearchParams();
  const collapsed = useCollapsed(undefined);

  const state = readPlayerDirectory(params);
  const directory = usePlayerDirectory(toPlayerQuery(state));
  // Selection belongs to the URL, so its profiles must survive page and search changes.
  const firstCompared = usePlayer(state.compare[0] ?? null);
  const secondCompared = usePlayer(state.compare[1] ?? null);

  const commit = (next: PlayerDirectoryState, options?: { replace: boolean }) => {
    setParams(writePlayerDirectory(next), options);
  };

  /* The search draft, re-seeded whenever the address changes `q` under it
     (React's own "adjusting state when a prop changes" shape). */
  const [draft, setDraft] = useState(state.search);
  const [composing, setComposing] = useState(false);
  const [seededFrom, setSeededFrom] = useState(state.search);
  if (seededFrom !== state.search) {
    setSeededFrom(state.search);
    setDraft(state.search);
  }
  const commitSearch = (search: string) => {
    if (search === state.search) return;
    commit({ ...state, search, page: 1, activeId: '' }, { replace: true });
  };
  const pending = draft.trim();
  useEffect(() => {
    if (composing || pending === state.search) return undefined;
    const timer = window.setTimeout(() => commitSearch(pending), SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
    // `commitSearch` closes over `state`, which is derived from `params` — the
    // dependency that decides what the timer would write.
  }, [composing, pending, params]);

  const rows = directory.data?.items ?? [];
  const total = directory.data?.total ?? 0;
  const selected = new Set(state.compare);
  const activePlayer = rows.find(
    (row) => row.steam_id === (state.activeId || rows[0]?.steam_id),
  );
  const comparisonReads = state.compare.map((id, index) => ({
    id,
    query: index === 0 ? firstCompared : secondCompared,
  }));
  const comparePlayers = comparisonReads.flatMap(({ query }) => query.data === undefined ? [] : [query.data.player]);
  const pendingPlayers = comparisonReads
    .filter(({ query }) => query.data === undefined)
    .map(({ id, query }) => ({ id, error: toDataError(query.error, t`请重试`)?.message ?? null, onRetry: () => void query.refetch() }));

  /*
   * `nextSortState` cycles unsorted → asc → desc → unsorted, and `listPlayers`
   * has no unsorted mode: the third step falls back to the artboard's own
   * ordering (K/D descending) rather than sending nothing.
   */
  const sort: SortState = { columnId: state.sort, direction: state.direction };
  const onSortChange = (next: SortState | null) => {
    if (next === null) {
      commit({ ...state, sort: DEFAULT_PLAYER_SORT, direction: DEFAULT_PLAYER_DIRECTION, page: 1 });
      return;
    }
    commit({
      ...state,
      sort: next.columnId as PlayerDirectorySort,
      direction: next.direction,
      page: 1,
    });
  };

  const error = toDataError(directory.error, t`请重试`)?.message ?? null;
  const clearCompare = () => commit({ ...state, compare: [] });
  /* Folded, the drawer is the only action surface, so the panel gets 清空选择;
     docked, the `SelectionBar` under the table owns it. */
  const panel = (
    <PlayerComparePanel
      players={comparePlayers}
      pendingPlayers={pendingPlayers}
      focusedPlayer={activePlayer}
      onComparePlayer={(steamId) => commit({ ...state, compare: reconcileCompare(state.compare, new Set([...state.compare, steamId])) })}
      limit={PLAYER_COMPARE_LIMIT}
      onClear={collapsed ? clearCompare : undefined}
    />
  );

  return (
    <Page
      scroll={false}
      toolbar={
        <Toolbar
          title={<Trans>选手目录</Trans>}
          meta={
            directory.data === undefined ? null : (
              <Trans>
                {total} 名选手 · 来自 {directory.data.coverage.projected_demos} 场已分析比赛
              </Trans>
            )
          }
        />
      }
      bar={
        <Toolbar height="bar" tone="chrome">
          <div className="w-[var(--w-panel)] max-w-full">
            <Input
              type="search"
              ground="bg"
              value={draft}
              aria-label={t`搜索选手或别名`}
              placeholder={t`搜索选手或别名`}
              onChange={(event) => setDraft(event.currentTarget.value)}
              onCompositionStart={() => setComposing(true)}
              onCompositionEnd={(event) => {
                setDraft(event.currentTarget.value);
                setComposing(false);
              }}
              onKeyDown={(event) => {
                if (event.key !== 'Enter' || composing || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
                event.preventDefault();
                commitSearch(event.currentTarget.value.trim());
              }}
            />
          </div>
        </Toolbar>
      }
      footer={
        collapsed ? (
          panel
        ) : state.compare.length === 0 ? null : (
          <SelectionBar
            summary={
              <Trans>
                已选 {state.compare.length} 名 · 比较上限 {PLAYER_COMPARE_LIMIT} 名
              </Trans>
            }
          >
            <Button variant="secondary" size="sm" onClick={clearCompare}>
              <Trans>清空选择</Trans>
            </Button>
          </SelectionBar>
        )
      }
    >
      <div className="flex min-h-0 min-w-0 flex-1">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {error === null ? null : (
            <div className="p-6">
              <Alert
                variant="danger"
                action={{ label: <Trans>重试</Trans>, onAction: () => void directory.refetch() }}

              >
                <Trans>无法加载选手目录：{error}</Trans>
              </Alert>
            </div>
          )}
          {error !== null && directory.data === undefined ? null : <DataTable
            caption={<Trans>选手目录</Trans>}
            columns={columns}
            rows={rows}
            rowId={(row) => row.steam_id}
            rowLabel={(row) => row.name}
            selectable
            selected={selected}
            selectionLimit={PLAYER_COMPARE_LIMIT}
            onSelectedChange={(next) =>
              commit({ ...state, compare: reconcileCompare(state.compare, next) })
            }
            activeRowId={activePlayer?.steam_id ?? null}
            onRowActivate={(rowId) => commit({ ...state, activeId: rowId })}
            sort={sort}
            onSortChange={onSortChange}
            loading={directory.isPending}
            skeleton={<TableSkeleton rows={8} stage={t`正在读取选手目录`} className="m-7" />}
            empty={
              <Empty
                className="m-7"
                title={
                  state.search === '' ? <Trans>还没有选手</Trans> : <Trans>没有匹配的选手</Trans>
                }
                description={
                  state.search === '' ? (
                    <Trans>分析比赛后，参赛选手会出现在这里。</Trans>
                  ) : (
                    <Trans>
                      没有找到「{state.search}」，请尝试其他名字或别名。
                    </Trans>
                  )
                }
                actions={
                  state.search === '' ? (
                    <RouteLink to="/library">
                      <Trans>去资料库分析一场</Trans>
                    </RouteLink>
                  ) : (
                    <Button
                      variant="secondary"
                      onClick={() => commit({ ...state, search: '', page: 1 })}
                    >
                      <Trans>清空搜索</Trans>
                    </Button>
                  )
                }
              />
            }
            footer={
              <Pagination
                page={state.page}
                pageSize={PLAYER_PAGE_SIZE}
                total={total}
                onPageChange={(page) => commit({ ...state, page })}
                summary={<Trans>共 {total} 名选手</Trans>}
              />
            }
          />}
        </div>
        {collapsed ? null : panel}
      </div>
    </Page>
  );
}
