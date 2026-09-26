/*
 * pages/players — the 「比较」 panel of 「06 玩家目录」.
 *
 * Two cards, then one bar pair per metric with both numbers written out
 * (「1.42 · 1.28」), then the artboard's honest failure: 「段位分布 · 数据不可用」
 * drawn as a dashed empty rail rather than as a zero bar. That last row is
 * copied deliberately — it is the reference telling us what to do with a
 * statistic the data does not carry, and the same treatment is what the missing
 * 首杀 / 残局胜率 columns get in the table beside it.
 *
 * The page resolves the selected IDs through the existing player-profile query.
 * This panel remains a presentation of those reads, including partial failures,
 * so paging and searching the directory cannot change who is being compared.
 *
 * The bars are widths, not a chart: `style={{ width: '71%' }}` rather than a
 * Tailwind arbitrary value, because the number is data. Both bars are scaled
 * against the larger of the two so the comparison is between them and not
 * against an invented ceiling; the numbers above them are the actual values, so
 * the bar can never be the only place a reader gets the fact.
 *
 * ── One place per action ───────────────────────────────────────────────────
 *
 * Each card carries its own 「打开档案」, so both players have an entry and the
 * panel never has to pick one of them for a footer link. 「清空选择」 is drawn
 * here only when the caller hands over `onClear` — the folded drawer, where
 * this panel is the only action surface. Docked, the page's `SelectionBar`
 * already owns that button under the table, and the same action drawn twice
 * on one screen reads as two different actions.
 */

import { t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import type { ReactNode } from 'react';

import { Empty, Skeleton } from '../../../design/data';
import { Alert } from '../../../design/feedback';
import { Inspector } from '../../../design/layout';
import { Button } from '../../../design/primitives';
import type { PlayerDirectoryItem } from '../../../shared/desktop/dto';
import { RouteLink } from '../../shared/navigation/RouteLink';
import { formatFixed, formatPercent, headshotRate, NO_VALUE } from './playerStats';

/* ── one metric row ──────────────────────────────────────────────────────── */

interface MetricRow {
  readonly id: string;
  readonly label: ReactNode;
  /** `null` when the player has no value for it. */
  readonly left: number | null;
  readonly right: number | null;
  readonly print: (value: number | null) => string;
}

function metricRows(left: PlayerDirectoryItem, right: PlayerDirectoryItem): readonly MetricRow[] {
  return [
    {
      id: 'kd',
      label: <Trans>K/D</Trans>,
      left: left.stats.average_kill_death_ratio,
      right: right.stats.average_kill_death_ratio,
      print: (value) => formatFixed(value, 2),
    },
    {
      id: 'adr',
      label: <Trans>ADR</Trans>,
      left: left.stats.average_adr,
      right: right.stats.average_adr,
      print: (value) => formatFixed(value, 1),
    },
    {
      id: 'headshot',
      label: <Trans>爆头率</Trans>,
      left: headshotRate(left.stats),
      right: headshotRate(right.stats),
      print: formatPercent,
    },
    {
      id: 'matches',
      label: <Trans>比赛数</Trans>,
      left: left.stats.matches,
      right: right.stats.matches,
      print: (value) => formatFixed(value, 0),
    },
  ];
}

/** Both bars against the larger value, so 100% means "the better of these
 *  two" and never "the maximum imaginable". `0` when neither was measured. */
function barPercent(value: number | null, other: number | null): number {
  if (value === null || !Number.isFinite(value) || value <= 0) return 0;
  const ceiling = Math.max(value, other ?? 0);
  if (ceiling <= 0) return 0;
  return Math.round((value / ceiling) * 100);
}

function PlayerCard({
  player,
  emphasis,
}: {
  readonly player: PlayerDirectoryItem;
  readonly emphasis: boolean;
}) {
  return (
    <div
      data-compare-card={player.steam_id}
      className={`flex min-w-0 flex-1 flex-col gap-1 border p-3 ${emphasis ? 'border-accent-400' : 'border-divider'}`}
    >
      <div className="truncate font-heading text-lg">{player.name}</div>
      <div className="truncate text-xs text-neutral-600">
        {player.last_team ?? NO_VALUE}
        {' · '}
        <Trans>{player.stats.matches} 场</Trans>
      </div>
      <RouteLink
        to={`/players/${encodeURIComponent(player.steam_id)}`}
        className="text-xs"
        aria-label={t`打开 ${player.name} 的档案`}
      >
        <Trans>打开档案</Trans>
      </RouteLink>
    </div>
  );
}

/** The folded drawer's only way to clear; docked, `SelectionBar` has it. */
function ClearFooter({ onClear }: { readonly onClear: () => void }) {
  return (
    <Button variant="secondary" size="md" block onClick={onClear}>
      <Trans>清空选择</Trans>
    </Button>
  );
}

/* ── the panel ───────────────────────────────────────────────────────────── */

export interface PlayerComparePanelProps {
  /** In the order the boxes were ticked; 0, 1 or 2 entries. */
  readonly players: readonly PlayerDirectoryItem[];
  readonly pendingPlayers?: readonly {
    readonly id: string;
    readonly error: string | null;
    readonly onRetry: () => void;
  }[] | undefined;
  /** The active table row. It gives the persistent panel useful context
   * without silently adding that player to the compare selection. */
  readonly focusedPlayer?: PlayerDirectoryItem | undefined;
  /** How many may be compared, for the 「还差一名」 copy. */
  readonly limit: number;
  /**
   * Clears the selection. Pass it only where this panel is the sole action
   * surface (the folded drawer); the docked page draws the same button on its
   * `SelectionBar` and must not get a second one here.
   */
  readonly onClear?: (() => void) | undefined;
}

export function PlayerComparePanel({
  players,
  pendingPlayers = [],
  focusedPlayer,
  limit,
  onClear,
}: PlayerComparePanelProps) {
  const [left, right] = players;

  if (pendingPlayers.length > 0) {
    const selectedCount = players.length + pendingPlayers.length;
    const failed = pendingPlayers.some((player) => player.error !== null);
    return (
      <Inspector
        title={<Trans>比较</Trans>}
        label={t`比较`}
        summary={failed
          ? <Trans>已选 {selectedCount} 名 · 部分档案未能读取</Trans>
          : <Trans>已选 {selectedCount} 名 · 正在读取档案</Trans>}
        summaryActions={onClear === undefined ? undefined : <Button size="sm" onClick={onClear}><Trans>清空选择</Trans></Button>}
        footer={onClear === undefined ? undefined : <ClearFooter onClear={onClear} />}
      >
        {players.length === 0 ? null : (
          <div className="flex flex-col gap-3">
            {players.map((player) => <PlayerCard key={player.steam_id} player={player} emphasis={false} />)}
          </div>
        )}
        {pendingPlayers.map((player) => (
          <div key={player.id} data-compare-pending={player.id}>
            {player.error === null ? (
              <div role="status" aria-busy="true" className="flex flex-col gap-2">
                <Skeleton className="h-16" />
                <p className="break-words text-sm text-neutral-600"><Trans>正在读取 {player.id} 的档案</Trans></p>
              </div>
            ) : (
              <Alert
                variant="danger"
                action={{ label: <Trans>重试</Trans>, onAction: player.onRetry }}
                detail={player.error}
              >
                <Trans>选手 {player.id} 的档案未能读取</Trans>
              </Alert>
            )}
          </div>
        ))}
      </Inspector>
    );
  }

  if (left === undefined) {
    if (focusedPlayer !== undefined) {
      const metrics = [
        { id: 'matches', label: <Trans>比赛</Trans>, value: formatFixed(focusedPlayer.stats.matches, 0) },
        { id: 'kd', label: <Trans>K/D</Trans>, value: formatFixed(focusedPlayer.stats.average_kill_death_ratio, 2) },
        { id: 'adr', label: <Trans>ADR</Trans>, value: formatFixed(focusedPlayer.stats.average_adr, 1) },
        { id: 'headshots', label: <Trans>爆头率</Trans>, value: formatPercent(headshotRate(focusedPlayer.stats)) },
        { id: 'kills', label: <Trans>击杀</Trans>, value: formatFixed(focusedPlayer.stats.kills, 0) },
        { id: 'deaths', label: <Trans>死亡</Trans>, value: formatFixed(focusedPlayer.stats.deaths, 0) },
      ];
      return (
        <Inspector
          title={<Trans>比较</Trans>}
          label={t`比较`}
          summary={<Trans>当前查看 {focusedPlayer.name} · 尚未加入比较</Trans>}
          footer={
            <RouteLink to={`/players/${encodeURIComponent(focusedPlayer.steam_id)}`}>
              <Trans>打开 {focusedPlayer.name} 的档案</Trans>
            </RouteLink>
          }
        >
          <section className="border border-divider" data-focused-player={focusedPlayer.steam_id}>
            <header className="border-l-2 border-accent px-3 py-2">
              <h3 className="font-heading text-xl">{focusedPlayer.name}</h3>
              <p className="text-xs text-neutral-600">
                {focusedPlayer.last_team ?? NO_VALUE}
                {' · '}
                <Trans>尚未加入比较</Trans>
              </p>
            </header>
            <dl className="border-t border-divider px-3 py-2 text-sm">
              {metrics.map((metric) => (
                <div key={metric.id} className="flex min-h-7 items-center justify-between gap-3">
                  <dt className="text-neutral-600">{metric.label}</dt>
                  <dd className="font-mono text-xs">{metric.value}</dd>
                </div>
              ))}
            </dl>
          </section>
          <p className="border border-dashed border-divider p-3 text-xs leading-normal text-neutral-700">
            <Trans>
              勾选 {focusedPlayer.name}，再勾选另一名选手，即可并排比较。最多 {limit} 名。
            </Trans>
          </p>
        </Inspector>
      );
    }
    return (
      <Inspector title={<Trans>比较</Trans>} label={t`比较`}>
        <Empty
          title={<Trans>还没有选中选手</Trans>}
          description={
            <Trans>勾选最多 {limit} 名选手，这里会把他们的 K/D、ADR 和爆头率并排放在一起。</Trans>
          }
          actions={null}
        />
      </Inspector>
    );
  }

  if (right === undefined) {
    return (
      <Inspector
        title={<Trans>比较</Trans>}
        label={t`比较`}
        summary={<Trans>已选 {left.name}，还差一名</Trans>}
        footer={onClear === undefined ? undefined : <ClearFooter onClear={onClear} />}
      >
        <div className="flex gap-3">
          <PlayerCard player={left} emphasis />
        </div>
        <p className="text-xs leading-normal text-neutral-700">
          <Trans>再勾一名选手才能比较。最多 {limit} 名，选得太多会挤窄每一列。</Trans>
        </p>
      </Inspector>
    );
  }

  const rows = metricRows(left, right);

  return (
    <Inspector
      title={<Trans>比较</Trans>}
      label={t`比较`}
      summary={
        <Trans>
          比较 {left.name} 与 {right.name}
        </Trans>
      }
      footer={onClear === undefined ? undefined : <ClearFooter onClear={onClear} />}
    >
      <div className="flex gap-3">
        <PlayerCard player={left} emphasis />
        <PlayerCard player={right} emphasis={false} />
      </div>

      <div className="flex flex-col gap-3">
        {rows.map((row) => (
          <div key={row.id} data-compare-metric={row.id}>
            <div className="mb-1 flex justify-between text-xs text-neutral-600">
              <span>{row.label}</span>
              <span className="font-mono">
                {row.print(row.left)} · {row.print(row.right)}
              </span>
            </div>
            <div className="flex h-3 gap-1">
              <div
                className="bg-accent"
                style={{ width: `${String(barPercent(row.left, row.right))}%` }}
                aria-hidden="true"
              />
              <div
                className="bg-neutral-400"
                style={{ width: `${String(barPercent(row.right, row.left))}%` }}
                aria-hidden="true"
              />
            </div>
          </div>
        ))}

        {/* Verbatim from the artboard: a statistic the demos do not carry gets a
            dashed empty rail and the words 「数据不可用」, never a zero bar. */}
        <div data-compare-metric="rank">
          <div className="mb-1 flex justify-between text-xs text-neutral-600">
            <span>
              <Trans>段位分布</Trans>
            </span>
            <span>
              <Trans>数据不可用</Trans>
            </span>
          </div>
          <div className="h-3 border border-dashed border-neutral-400" aria-hidden="true" />
        </div>
      </div>

      <p className="text-xs leading-normal text-neutral-600">
        <Trans>首杀、残局胜率和常用地图还没有分析结果，暂不显示。</Trans>
      </p>
    </Inspector>
  );
}
