/*
 * pages/history — the table of 「比赛历史与 Steam 下载」.
 *
 * Columns are the artboard's: a checkbox, 比赛, 地图, 时间, 比分, 状态 and one
 * action link. `design/data/DataTable` supplies the 42px row, the sticky head,
 * the accent-100 active row and the capped-selection rules; everything this
 * file adds is the state vocabulary and which action each state offers.
 *
 * The component takes rows as props and holds no query: `HistoryPage` owns the
 * read (`data/history.ts`), the paging and the selection, and this file owns
 * how a row looks and which action each state offers. That split is what lets
 * the table be tested against fixtures without a query client.
 *
 * `DataTable`'s selection is uncapped here on purpose: 「下载选中的 2 场」 has no
 * upper bound the artboard states, unlike 資料庫's 「上限 12 场」 and 玩家目录's
 * 「比较上限 2 名」. That also means the select-all box appears, which is correct
 * — with no cap there is nothing for it to contradict.
 */

import { t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import type { ReactNode } from 'react';

import { DataTable, type DataTableColumn } from '../../design/data';
import { StatusDot } from '../../design/feedback';
import { Badge, Button } from '../../design/primitives';
import type { MatchHistoryItem } from '../../shared/desktop/dto';
import { RouteLink } from '../RouteLink';
import {
  isDownloadable,
  matchHistoryState,
  type MatchHistoryState,
  type MatchHistoryStateOptions,
} from './matchHistoryRows';

function stateLabel(state: MatchHistoryState): ReactNode {
  switch (state) {
    case 'downloaded':
      return <Trans>已入库</Trans>;
    case 'downloading':
      return <Trans>下载中</Trans>;
    case 'available':
      return <Trans>未下载</Trans>;
    case 'failed':
      return <Trans>下载失败</Trans>;
    case 'expired':
      return <Trans>已过期</Trans>;
  }
}

function StateCell({ item, state }: { readonly item: MatchHistoryItem; readonly state: MatchHistoryState }) {
  if (state === 'downloading') {
    /* No percentage: `MatchHistoryItem` carries none, and the download job that
       does is a separate record. 「有真实分母时才用进度条，否则只给阶段名」. */
    return (
      <span className="inline-flex items-center gap-2 text-2xs">
        <StatusDot status="running" size="sm" />
        {stateLabel(state)}
      </span>
    );
  }
  if (state === 'expired') {
    return (
      <span className="text-2xs text-neutral-600">
        <Trans>已过期 · Valve 不再保留</Trans>
      </span>
    );
  }
  if (state === 'failed') {
    return (
      <span className="inline-flex items-center gap-2 text-2xs text-fail-text" title={item.last_error ?? undefined}>
        <StatusDot status="fail" size="sm" />
        {stateLabel(state)}
      </span>
    );
  }
  return <Badge variant={state === 'downloaded' ? 'accent' : 'neutral'}>{stateLabel(state)}</Badge>;
}

export interface MatchHistoryTableProps {
  readonly rows: readonly MatchHistoryItem[];
  readonly stateOptions: MatchHistoryStateOptions;
  readonly selected: ReadonlySet<string>;
  readonly onSelectedChange: (next: Set<string>) => void;
  /** 「下载」 for one row. */
  readonly onDownload: (item: MatchHistoryItem) => void;
  /** 「取消」 for a row already downloading. */
  readonly onCancel: (item: MatchHistoryItem) => void;
  /** Why the download actions cannot run; disables them and says so. */
  readonly actionDisabledReason?: string | undefined;
  readonly loading?: boolean | undefined;
  /** What `loading` shows. Omitted, `DataTable` falls back to its own. */
  readonly skeleton?: ReactNode | undefined;
  readonly empty?: ReactNode | undefined;
  readonly footer?: ReactNode | undefined;
}

export function MatchHistoryTable({
  rows,
  stateOptions,
  selected,
  onSelectedChange,
  onDownload,
  onCancel,
  actionDisabledReason,
  loading = false,
  skeleton,
  empty,
  footer,
}: MatchHistoryTableProps) {
  const stateOf = (item: MatchHistoryItem): MatchHistoryState =>
    matchHistoryState(item, stateOptions);

  const columns: readonly DataTableColumn<MatchHistoryItem>[] = [
    {
      id: 'match',
      header: <Trans>比赛</Trans>,
      headerLabel: t`比赛`,
      hideable: false,
      truncate: true,
      cell: (item) => <Trans>竞技 · {item.map_name ?? '—'}</Trans>,
    },
    {
      id: 'map',
      header: <Trans>地图</Trans>,
      headerLabel: t`地图`,
      cell: (item) => item.map_name ?? '—',
    },
    {
      id: 'played_at',
      header: <Trans>时间</Trans>,
      headerLabel: t`时间`,
      variant: 'numeric',
      cell: (item) => (item.played_at === null ? '—' : item.played_at.slice(0, 16).replace('T', ' ')),
    },
    {
      id: 'score',
      header: <Trans>比分</Trans>,
      headerLabel: t`比分`,
      variant: 'numeric',
      cell: (item) => item.score ?? '—',
    },
    {
      id: 'state',
      header: <Trans>状态</Trans>,
      headerLabel: t`状态`,
      cell: (item) => <StateCell item={item} state={stateOf(item)} />,
    },
    {
      id: 'action',
      headerLabel: t`操作`,
      hideable: false,
      width: '120px',
      cell: (item) => {
        const state = stateOf(item);
        if (state === 'downloaded') {
          return item.demo_id === null ? null : (
            <RouteLink to={`/match/${encodeURIComponent(item.demo_id)}`}>
              <Trans>打开工作区</Trans>
            </RouteLink>
          );
        }
        if (state === 'downloading') {
          return (
            <Button
              variant="ghost"
              size="sm"
              disabled={actionDisabledReason !== undefined}
              {...(actionDisabledReason === undefined ? {} : { disabledReason: actionDisabledReason })}
              onClick={() => onCancel(item)}
            >
              <Trans>取消</Trans>
            </Button>
          );
        }
        if (state === 'expired') return null;
        return (
          <Button
            variant="ghost"
            size="sm"
            disabled={actionDisabledReason !== undefined}
            {...(actionDisabledReason === undefined ? {} : { disabledReason: actionDisabledReason })}
            onClick={() => onDownload(item)}
          >
            <Trans>下载</Trans>
          </Button>
        );
      },
    },
  ];

  return (
    <DataTable
      caption={t`Steam 比赛历史`}
      columns={columns}
      rows={rows}
      rowId={(item) => item.id}
      rowLabel={(item) => `${item.map_name ?? t`未知地图`} ${item.played_at ?? ''}`}
      selectable
      selected={selected}
      onSelectedChange={(next) => {
        /* A row that cannot be downloaded cannot be selected: the artboard's
           expired row has no checkbox at all, and letting one into 「下载选中的
           N 场」 would produce a batch that silently drops members. */
        const allowed = new Set(
          [...next].filter((id) => {
            const item = rows.find((row) => row.id === id);
            return item !== undefined && isDownloadable(stateOf(item));
          }),
        );
        onSelectedChange(allowed);
      }}
      loading={loading}
      {...(skeleton === undefined ? {} : { skeleton })}
      {...(empty === undefined ? {} : { empty })}
      {...(footer === undefined ? {} : { footer })}
    />
  );
}
