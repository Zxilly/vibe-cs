/*
 * pages/ — 06 玩家目录 (spec §7 `/players`, phase 3d).
 *
 * ── The contract §10.3 wrote down ──────────────────────────────────────────
 *
 * 「312 人、选择上限 2 时 20 个复选框禁用 18 个且不出现全选」. All three halves of
 * that sentence are `design/data/DataTable` behaviour, reached by passing one
 * prop — `selectionLimit={PLAYER_COMPARE_LIMIT}`:
 *
 *   · 20 boxes         `PLAYER_PAGE_SIZE`, and the server pages, so the table
 *                      never holds 312 rows in the first place.
 *   · 18 disabled      `tableModel.isSelectionBlocked` disables the unselected
 *                      rows at the cap. Disabled, not hidden — §8.
 *   · no select-all    `DataTable` suppresses the header box whenever a limit
 *                      is present: 「a select-all contradicts a cap」.
 *
 * `players/density.test.tsx` renders the page against 312 rows and counts all
 * three, so the contract is a test rather than a comment.
 *
 * ── Columns the artboard draws and the service does not send ───────────────
 *
 * 「06」 has 首杀, 残局胜率 and 常用地图. `PlayerAggregateStats` carries matches,
 * kills, deaths, assists, headshots, damage, ADR and K/D — and none of those
 * three. They are omitted rather than rendered as zeros or as dashes in a
 * column header nobody can ever fill, and the comparison panel says so in
 * words. Reported as a contract gap.
 *
 * 爆头率 is not a wire field either, but it *is* derivable — headshots ÷ kills
 * — so it is computed (`playerStats.headshotRate`) and shows the dash only when
 * the denominator is missing.
 */

import { t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';

import { usePlayerDirectory } from '../data/players';
import { dataErrorMessage } from '../data/errors';
import {
  DataTable,
  EmptyState,
  Pagination,
  TableSkeleton,
  type DataTableColumn,
  type SortState,
} from '../design/data';
import { Alert } from '../design/feedback';
import { Page, SelectionBar, Toolbar, useCollapsed } from '../design/layout';
import { Button, Input } from '../design/primitives';
import type { PlayerDirectorySort } from '../data/keys';
import type { PlayerDirectoryItem } from '../shared/desktop/dto';
import { RouteLink } from './RouteLink';
import { PlayerComparePanel } from './players/PlayerComparePanel';
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
} from './players/playerDirectoryParams';
import { formatFixed, formatMonthDay, formatPercent, headshotRate, NO_VALUE } from './players/playerStats';

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
      sortable: true,
      truncate: true,
      cell: (row) => (
        <span className="flex min-w-0 items-baseline gap-2">
          <span className="truncate text-base">{row.name}</span>
          {row.last_team === null ? null : (
            <span className="flex-none text-2xs text-neutral-600">· {row.last_team}</span>
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

  const commit = (next: PlayerDirectoryState) => {
    setParams(writePlayerDirectory(next));
  };

  const rows = directory.data?.items ?? [];
  const total = directory.data?.total ?? 0;
  const selected = new Set(state.compare);
  const comparePlayers = state.compare
    .map((id) => rows.find((row) => row.steam_id === id))
    .filter((row): row is PlayerDirectoryItem => row !== undefined);

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

  const error = dataErrorMessage(directory.error);
  const panel = (
    <PlayerComparePanel
      players={comparePlayers}
      limit={PLAYER_COMPARE_LIMIT}
      onClear={() => commit({ ...state, compare: [] })}
    />
  );

  return (
    <Page
      scroll={false}
      toolbar={
        <Toolbar
          title={<Trans>玩家目录</Trans>}
          meta={
            directory.data === undefined ? null : (
              <Trans>
                {total} 名选手 · 来自 {directory.data.coverage.projected_demos} 场已分析比赛
              </Trans>
            )
          }
          /* Short title (four glyphs) plus one 32px control: §10.3 gap 2 asks
             such a page to keep its secondaries on the bar at the fold. */
          inlineActionsWhenCollapsed={1}
          /* The search box goes in `primary`, not in `actions`: the artboard
             draws it flush right and it must never fold, and `actions` is the
             slot that MAY be handed to `OverflowMenu` — a search field inside a
             menu is not a search field. `primary` is defined as the node that
             never folds, which is exactly the guarantee this needs. */
          primary={
            <div className="w-64">
              <Input
                type="search"
                ground="bg"
                defaultValue={state.search}
                aria-label={t`搜索选手或别名`}
                placeholder={t`搜索选手或别名`}
                onKeyDown={(event) => {
                  if (event.key !== 'Enter') return;
                  event.preventDefault();
                  commit({
                    ...state,
                    search: event.currentTarget.value.trim(),
                    page: 1,
                    activeId: '',
                  });
                }}
              />
            </div>
          }
        />
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
            primary={
              comparePlayers.length === PLAYER_COMPARE_LIMIT ? (
                <RouteLink
                  to={`/players/${encodeURIComponent(comparePlayers[0]?.steam_id ?? '')}`}
                >
                  <Trans>打开 {comparePlayers[0]?.name} 的档案</Trans>
                </RouteLink>
              ) : null
            }
          >
            <Button variant="secondary" size="sm" onClick={() => commit({ ...state, compare: [] })}>
              <Trans>清空选择</Trans>
            </Button>
          </SelectionBar>
        )
      }
    >
      <div className="flex min-h-0 min-w-0 flex-1">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {error === null ? null : (
            <div className="p-7">
              <Alert
                variant="danger"
                action={{ label: <Trans>重试</Trans>, onAction: () => void directory.refetch() }}
                detail={<Trans>目录是只读的，重试不会改动任何数据。</Trans>}
              >
                <Trans>玩家目录没能读出来：{error}</Trans>
              </Alert>
            </div>
          )}
          <DataTable
            caption={<Trans>玩家目录</Trans>}
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
            activeRowId={state.activeId === '' ? null : state.activeId}
            onRowActivate={(rowId) => commit({ ...state, activeId: rowId })}
            sort={sort}
            onSortChange={onSortChange}
            loading={directory.isPending}
            skeleton={<TableSkeleton rows={8} stage={t`正在读取玩家目录`} className="m-7" />}
            empty={
              <EmptyState
                className="m-7"
                title={
                  state.search === '' ? <Trans>还没有玩家</Trans> : <Trans>没有匹配的选手</Trans>
                }
                description={
                  state.search === '' ? (
                    <Trans>目录是从已分析的比赛里累积出来的。分析一场之后，出场的选手就会出现在这里。</Trans>
                  ) : (
                    <Trans>
                      「{state.search}」没有匹配到选手或别名。目录只按名字和别名做前缀与子串匹配，不做拼音和模糊匹配。
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
          />
        </div>
        {collapsed ? null : panel}
      </div>
    </Page>
  );
}
