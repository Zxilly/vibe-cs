/*
 * pages/players — 「按地图」 of 「玩家档案与趋势」.
 *
 * The artboard's columns are 地图 / 场次 / 胜率 / K/D / ADR. `PlayerMapItem`
 * carries `map_name` and a `PlayerAggregateStats`, which has matches, kills,
 * deaths, assists, headshots, damage, ADR and K/D — and **no wins**. 胜率 is
 * therefore not rendered: there is no numerator, and matches ÷ matches is not a
 * win rate. 爆头率 takes its place, because that one is derivable from fields
 * that are actually sent. Reported as a contract gap.
 *
 * `design/data/DataTable` rather than a hand-rolled `<table>`: it already owns
 * the 42px row, the 34px head, the sticky header and the scroll boundary, and
 * this table lives inside a column that has to keep its own scroll off `body`.
 */

import { Trans } from '@lingui/react/macro';

import { DataTable, EmptyState, type DataTableColumn } from '../../design/data';
import type { PlayerMapItem } from '../../shared/desktop/dto';
import { formatFixed, formatPercent, headshotRate, NO_VALUE } from './playerStats';

const COLUMNS: readonly DataTableColumn<PlayerMapItem>[] = [
  {
    id: 'map',
    header: <Trans>地图</Trans>,
    headerLabel: '地图',
    truncate: true,
    cell: (row) => row.map_name ?? NO_VALUE,
  },
  {
    id: 'matches',
    header: <Trans>场次</Trans>,
    headerLabel: '场次',
    variant: 'numeric',
    cell: (row) => formatFixed(row.stats.matches, 0),
  },
  {
    id: 'kd',
    header: <Trans>K/D</Trans>,
    headerLabel: 'K/D',
    variant: 'numeric',
    cell: (row) => formatFixed(row.stats.average_kill_death_ratio, 2),
  },
  {
    id: 'adr',
    header: <Trans>ADR</Trans>,
    headerLabel: 'ADR',
    variant: 'numeric',
    cell: (row) => formatFixed(row.stats.average_adr, 1),
  },
  {
    id: 'headshots',
    header: <Trans>爆头率</Trans>,
    headerLabel: '爆头率',
    variant: 'numeric',
    cell: (row) => formatPercent(headshotRate(row.stats)),
  },
];

export interface PlayerMapTableProps {
  readonly rows: readonly PlayerMapItem[];
  readonly loading?: boolean | undefined;
}

export function PlayerMapTable({ rows, loading = false }: PlayerMapTableProps) {
  return (
    <section className="flex min-h-0 flex-1 flex-col border border-divider" data-player-maps="">
      <div className="flex h-[var(--h-panel-head)] flex-none items-center border-b border-divider px-3 font-heading text-2xs tracking-caps">
        <Trans>按地图</Trans>
      </div>
      <DataTable
        caption={<Trans>按地图的成绩</Trans>}
        columns={COLUMNS}
        rows={rows}
        rowId={(row) => row.map_name ?? 'unknown'}
        loading={loading}
        empty={
          <EmptyState
            className="m-4"
            title={<Trans>还没有按地图的数据</Trans>}
            description={<Trans>分析这名选手的比赛之后，每张地图的场次与命中会在这里累积。</Trans>}
            actions={null}
          />
        }
      />
    </section>
  );
}
