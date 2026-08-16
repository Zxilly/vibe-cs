/*
 * pages/match/views — 玩家 (`?view=players`).
 *
 * 「补齐 · 比赛工作区子视图 · 玩家单场分析」, with the same columns the 03 artboard
 * draws on its 记分板. The two halves of the artboard map onto the two halves of
 * a view: the roster with its numbers is the body, and 「按选手浏览这一场」 — the
 * tiles, the weapon breakdown and 这一场的高光 — is the Inspector, because that
 * is where the workspace puts the detail of whatever is selected, and because
 * the selection is `?player=`, which every other view reads too.
 *
 * ── Not the same screen as `/players` ─────────────────────────────────────
 *
 * 「06 玩家目录」 ranks a player across matches out of `PlayerAggregateStats`.
 * This ranks the ten people in *this* match out of `AnalysisWorkspace.players`.
 * The column headers are deliberately the same words as the directory's
 * (`pages/PlayersPage.tsx`) so the two tables read as one product; the records
 * behind them are different and are never mixed.
 *
 * ── Three states ──────────────────────────────────────────────────────────
 *
 * Pending → `TableSkeleton` with a stage name and no invented percentage.
 * A 404 → 「这场还没分析」, which is a state and not an error (`analysisIsMissing`).
 * Anything else → an in-place `Notice` with a retry, per §4.1's
 * `throwOnError: false`.
 *
 * ── Density ───────────────────────────────────────────────────────────────
 *
 * Ten rows, bounded by `MATCH_ROSTER_SIZE`; there is nothing to page. The
 * horizontal overflow of ten columns happens inside `DataTable`'s own scroller,
 * so the shell never grows a second scrollbar at the 1100px fold.
 */

import { Trans } from '@lingui/react/macro';
import { useMemo, useState, type ReactNode } from 'react';

import { useMatchAnalysis } from '../../../data/match';
import { DataTable, EmptyState, type DataTableColumn, type SortState } from '../../../design/data';
import { Button } from '../../../design/primitives';
import { HighlightRow, type HighlightCandidate } from '../../../domain/match';
import type { AnalysisWorkspace, Highlight } from '../../../shared/desktop/viewModels';
import { MatchInspectorPanel } from '../MatchInspectorPanel';
import type { MatchViewModule, MatchViewProps } from '../viewContract';
import { rosterIndex } from './duelsModel';
import { SelectedRoundLine, useAnalysisGate, ViewFrame, ViewPanel } from './viewChrome';
import {
  formatFixed,
  formatPercent,
  highlightKindOf,
  NO_VALUE,
  playerHighlights,
  scoreboardRows,
  sortScoreboardRows,
  weaponBreakdown,
  type ScoreboardRow,
} from './playersModel';

/* ── pieces ──────────────────────────────────────────────────────────────── */

/**
 * A sub-panel head. The artboard draws it at 32px; `--h-thead` (34) is the
 * §3.4 token for a header strip above rows and is the 2px fold that table
 * already signed off on, so no bare 32 is written down.
 */
function PanelHead({ children }: { readonly children: ReactNode }) {
  return (
    <div className="flex h-[var(--h-thead)] items-center border-b border-divider px-2.5 font-heading text-2xs tracking-widest text-neutral-700">
      {children}
    </div>
  );
}

/* ── the scoreboard ──────────────────────────────────────────────────────── */

export interface MatchScoreboardProps {
  readonly rows: readonly ScoreboardRow[];
  /** The player the Inspector is showing — `?player=`. */
  readonly activePlayerId: string | null;
  readonly onSelect: (playerId: string) => void;
  readonly sort: SortState | null;
  readonly onSortChange: (next: SortState | null) => void;
  /** Hides 首杀 / 首死 when the analysis carries no kill events at all. */
  readonly showOpeningDuels: boolean;
}

/**
 * The 单场记分板.
 *
 * Presentational and exported so the `markup` project can render it with real
 * rows — `renderToStaticMarkup` never lets a query resolve, so a table that
 * lived only inside the container could be asserted on in its loading state and
 * nowhere else.
 */
export function MatchScoreboard({
  rows,
  activePlayerId,
  onSelect,
  sort,
  onSortChange,
  showOpeningDuels,
}: MatchScoreboardProps) {
  const columns = useMemo(() => scoreboardColumns(showOpeningDuels), [showOpeningDuels]);

  return (
    <DataTable
      /* The scroll — both axes of it — happens in the table's own container,
         so a ten-column scoreboard never puts a second scrollbar on the shell
         (`base.css` sets `overflow: hidden` on `body`; it would simply clip). */
      className="max-h-96"
      caption={<Trans>这一场的记分板</Trans>}
      columns={columns}
      rows={rows}
      rowId={(row) => row.id}
      rowLabel={(row) => row.name}
      sort={sort}
      onSortChange={onSortChange}
      activeRowId={activePlayerId}
      onRowActivate={(rowId) => onSelect(rowId)}
    />
  );
}

function scoreboardColumns(showOpeningDuels: boolean): readonly DataTableColumn<ScoreboardRow>[] {
  const columns: DataTableColumn<ScoreboardRow>[] = [
    {
      id: 'name',
      header: <Trans>选手</Trans>,
      headerLabel: '选手',
      hideable: false,
      sortable: true,
      truncate: true,
      cell: (row) => <span className="truncate text-base">{row.name}</span>,
    },
    {
      id: 'team',
      header: <Trans>队伍</Trans>,
      headerLabel: '队伍',
      truncate: true,
      /* An unnamed team prints the dash rather than 「队伍 A」 — the context bar
         above already carries whatever name the demo record knows. */
      cell: (row) => (row.teamName === '' ? NO_VALUE : row.teamName),
    },
    {
      id: 'kills',
      header: <Trans>击杀</Trans>,
      headerLabel: '击杀',
      variant: 'numeric',
      sortable: true,
      cell: (row) => formatFixed(row.kills, 0),
    },
    {
      id: 'deaths',
      header: <Trans>死亡</Trans>,
      headerLabel: '死亡',
      variant: 'numeric',
      sortable: true,
      cell: (row) => formatFixed(row.deaths, 0),
    },
    {
      id: 'assists',
      header: <Trans>助攻</Trans>,
      headerLabel: '助攻',
      variant: 'numeric',
      sortable: true,
      cell: (row) => formatFixed(row.assists, 0),
    },
    {
      id: 'kd',
      header: <Trans>K/D</Trans>,
      headerLabel: 'K/D',
      variant: 'numeric',
      sortable: true,
      cell: (row) => formatFixed(row.killDeathRatio, 2),
    },
    {
      id: 'adr',
      header: <Trans>ADR</Trans>,
      headerLabel: 'ADR',
      variant: 'numeric',
      sortable: true,
      cell: (row) => formatFixed(row.adr, 1),
    },
    {
      id: 'headshot',
      header: <Trans>爆头率</Trans>,
      headerLabel: '爆头率',
      variant: 'numeric',
      sortable: true,
      cell: (row) => formatPercent(row.headshotRate),
    },
  ];

  /* 首杀 / 首死 are derived from the round event stream. Without one the
     columns would read 0 for everybody, which is a claim rather than a
     placeholder — so they are absent instead. §10.4's rule: 永远空的列和静默
     截断是同一个谎. */
  if (showOpeningDuels) {
    columns.push({
      id: 'opening',
      header: <Trans>首杀 / 首死</Trans>,
      headerLabel: '首杀与首死',
      variant: 'numeric',
      sortable: true,
      cell: (row) => `${formatFixed(row.openingKills, 0)} / ${formatFixed(row.openingDeaths, 0)}`,
    });
  }

  columns.push({
    id: 'highlights',
    header: <Trans>高光</Trans>,
    headerLabel: '高光',
    variant: 'numeric',
    sortable: true,
    cell: (row) => formatFixed(row.highlights, 0),
  });

  return columns;
}

/* ── the body ────────────────────────────────────────────────────────────── */

function PlayersBody({ demoId, context, updateContext }: MatchViewProps) {
  const gate = useAnalysisGate(demoId);
  const [sort, setSort] = useState<SortState | null>(null);

  const natural = useMemo(() => scoreboardRows(gate.analysis), [gate.analysis]);
  const rows = useMemo(() => sortScoreboardRows(natural, sort), [natural, sort]);
  const showOpeningDuels = natural.some((row) => row.openingKills !== null);
  const empty = gate.analysis !== undefined && rows.length === 0;

  return (
    <ViewFrame view="players" state={empty ? 'empty' : gate.state}>
      <ViewPanel
        id="scoreboard"
        title={<Trans>玩家</Trans>}
        {...(gate.analysis === undefined || empty
          ? {}
          : { hint: <Trans>共 {rows.length} 名选手 · 点一行看他这一场</Trans> })}
      >
        {gate.fallback ??
          (empty ? (
            <EmptyState
              className="m-3.5"
              headingLevel={4}
              title={<Trans>这份分析里没有选手</Trans>}
              description={
                <Trans>
                  解析出的比赛没有可归属的选手记录，记分板因此是空的。重新分析这场比赛通常能补上。
                </Trans>
              }
              actions={
                <Button variant="secondary" onClick={() => updateContext({ view: 'overview' })}>
                  <Trans>回到概览</Trans>
                </Button>
              }
            />
          ) : (
            <MatchScoreboard
              rows={rows}
              activePlayerId={context.player}
              onSelect={(playerId) => updateContext({ player: playerId })}
              sort={sort}
              onSortChange={setSort}
              showOpeningDuels={showOpeningDuels}
            />
          ))}
      </ViewPanel>
      {/* The §4.4 selection, printed where the selection is — a deep link that
          arrives with a round has to say so inside the view too. */}
      <SelectedRoundLine round={context.round} />
    </ViewFrame>
  );
}

/* ── the Inspector ───────────────────────────────────────────────────────── */

/** 「AK-47 16 杀」 — the artboard's four rows, with the tail folded into 其他. */
const WEAPON_LIMIT = 4;

export interface PlayerMatchDetailProps {
  readonly analysis: AnalysisWorkspace;
  readonly row: ScoreboardRow;
  /** Set when 加入视频 is disabled; the reason travels onto every row's button. */
  readonly addDisabledReason?: string | undefined;
}

/**
 * 「按选手浏览这一场」 — the tiles, the weapon breakdown and the highlights.
 *
 * Exported for the same reason `MatchScoreboard` is: it is the only way a
 * markup test gets to see it with real numbers.
 */
export function PlayerMatchDetail({ analysis, row, addDisabledReason }: PlayerMatchDetailProps) {
  const weapons = weaponBreakdown(analysis.rounds, row.id, WEAPON_LIMIT);
  const highlights = playerHighlights(analysis, row.id);

  return (
    <div data-player-detail={row.id} className="flex flex-col gap-3.5">
      <div className="flex border border-divider">
        <StatCell label={<Trans>K / D / A</Trans>}>
          {`${formatFixed(row.kills, 0)} / ${formatFixed(row.deaths, 0)} / ${formatFixed(row.assists, 0)}`}
        </StatCell>
        <StatCell label={<Trans>ADR</Trans>}>{formatFixed(row.adr, 1)}</StatCell>
        <StatCell label={<Trans>爆头率</Trans>} last={row.openingKills === null}>
          {formatPercent(row.headshotRate)}
        </StatCell>
        {/* 首杀 / 首死 only when the round event stream exists — see the table. */}
        {row.openingKills === null ? null : (
          <StatCell label={<Trans>首杀 / 首死</Trans>} last>
            {`${formatFixed(row.openingKills, 0)} / ${formatFixed(row.openingDeaths, 0)}`}
          </StatCell>
        )}
      </div>

      <section data-player-weapons="" className="border border-divider">
        <PanelHead>
          <Trans>武器</Trans>
        </PanelHead>
        {weapons === null ? (
          /* Not an empty list: 「这份分析没有事件流」 is a different sentence from
             「他没有击杀」, and only the first one is true here. The artboard's
             「命中 34%」 is missing for good (`data/match.ts` gap 3) — there is no
             weapon-fire event, so a hit rate has no denominator. */
          <p className="px-2.5 py-3 text-xs text-neutral-700">
            <Trans>这份分析没有逐条击杀事件，武器分布无法统计。</Trans>
          </p>
        ) : weapons.total === 0 ? (
          <p className="px-2.5 py-3 text-xs text-neutral-700">
            <Trans>这一场没有记到他的击杀。</Trans>
          </p>
        ) : (
          <ul className="flex list-none flex-col gap-2.5 p-2.5 text-sm">
            {weapons.entries.map((entry) => (
              <WeaponBar
                key={entry.weapon}
                name={entry.weapon}
                kills={entry.kills}
                total={weapons.total}
              />
            ))}
            {weapons.other === 0 ? null : (
              <WeaponBar name={<Trans>其他</Trans>} kills={weapons.other} total={weapons.total} />
            )}
          </ul>
        )}
      </section>

      <section data-player-highlights="" className="border border-divider">
        <PanelHead>
          <Trans>这一场的高光</Trans>
        </PanelHead>
        {highlights.length === 0 ? (
          <p className="px-2.5 py-3 text-xs text-neutral-700">
            <Trans>检测器没有在这一场里给他标出高光。</Trans>
          </p>
        ) : (
          <ul className="list-none">
            {highlights.map((highlight) => (
              <li key={highlight.id}>
                <HighlightRow
                  highlight={toCandidate(highlight, row.name)}
                  density="compact"
                  tickRate={analysis.tick_rate}
                  action={
                    <Button
                      variant="ghost"
                      size="sm"
                      {...(addDisabledReason === undefined
                        ? {}
                        : { disabled: true, disabledReason: addDisabledReason })}
                    >
                      <Trans>加入视频</Trans>
                    </Button>
                  }
                />
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function toCandidate(highlight: Highlight, subject: string): HighlightCandidate {
  return {
    id: highlight.id,
    kind: highlightKindOf(highlight.kind),
    /* The detector's own phrasing wins over the kind table's generic word —
       「1v3 残局」 says more than 「残局」 — and falls back to it when absent. */
    ...(highlight.label.trim() === '' ? {} : { label: highlight.label }),
    round: highlight.round,
    subject,
    ...(highlight.description.trim() === '' ? {} : { description: highlight.description }),
    startTick: highlight.start_tick,
    endTick: highlight.end_tick,
  };
}

function StatCell({
  label,
  last = false,
  children,
}: {
  readonly label: ReactNode;
  readonly last?: boolean | undefined;
  readonly children: ReactNode;
}) {
  return (
    <div className={last ? 'flex-1 px-3 py-2.5' : 'flex-1 border-r border-divider px-3 py-2.5'}>
      <div className="text-2xs text-neutral-600">{label}</div>
      <div className="font-mono text-lg">{children}</div>
    </div>
  );
}

function WeaponBar({
  name,
  kills,
  total,
}: {
  readonly name: ReactNode;
  readonly kills: number;
  readonly total: number;
}) {
  /* The bar is redundant with the number beside it — a shape for comparing rows
     at a glance, never the only carrier of the value (§6.2). The width is a
     computed percentage, so it is an inline style rather than a Tailwind
     arbitrary value; no colour or size is written down here. */
  const share = total <= 0 ? 0 : Math.round((kills / total) * 100);
  return (
    <li>
      <div className="mb-1 flex items-baseline justify-between gap-2">
        <span className="min-w-0 truncate">{name}</span>
        <span className="flex-none font-mono text-xs">
          <Trans>{kills} 杀</Trans>
        </span>
      </div>
      <div aria-hidden="true" className="h-2 bg-neutral-200">
        <div className="h-2 bg-accent" style={{ width: `${String(share)}%` }} />
      </div>
    </li>
  );
}

function PlayersInspector({
  demoId,
  context,
  updateContext,
  addToVideo,
  collapsed,
}: MatchViewProps) {
  const analysis = useMatchAnalysis(demoId === '' ? null : demoId);

  const rows = useMemo(() => scoreboardRows(analysis.data), [analysis.data]);
  const index = useMemo(() => rosterIndex(analysis.data), [analysis.data]);
  const row = context.player === null ? undefined : rows.find((entry) => entry.id === context.player);

  if (row === undefined || analysis.data === undefined) {
    /* A selected id the analysis does not know still gets a name — the raw id.
       An Inspector that goes mute while a selection is in effect hides the
       selection rather than explaining it. */
    const fallbackName =
      context.player === null ? '' : (index.get(context.player)?.name ?? context.player);
    return (
      <MatchInspectorPanel
        title={context.player === null ? <Trans>选中项</Trans> : <Trans>选中：{fallbackName}</Trans>}
        summary={context.player === null ? <Trans>未选中任何选手</Trans> : fallbackName}
        addToVideo={addToVideo}
        collapsed={collapsed}
      >
        <p className="text-sm text-neutral-700">
          {context.player === null ? (
            <Trans>点左侧记分板的一行，这里会显示他这一场的 K/D/A、武器分布和高光。</Trans>
          ) : (
            <Trans>这份分析里没有这名选手。地址上的选择保留着，换一场比赛可能就能对上。</Trans>
          )}
        </p>
      </MatchInspectorPanel>
    );
  }

  return (
    <MatchInspectorPanel
      title={<Trans>选中：{row.name}</Trans>}
      summary={`${row.name} · ${formatFixed(row.kills, 0)} / ${formatFixed(row.deaths, 0)} / ${formatFixed(row.assists, 0)}`}
      addToVideo={addToVideo}
      addLabel={<Trans>把这名选手加入视频</Trans>}
      selection={{ playerId: row.id }}
      collapsed={collapsed}
      /* The artboard's two seconds. Both are navigations inside the workspace,
         so the focused player travels with them — §4.4: changing the view
         clears nothing. */
      secondaryActions={
        <>
          <Button variant="secondary" size="sm" grow onClick={() => updateContext({ view: 'replay' })}>
            <Trans>2D 回放</Trans>
          </Button>
          <Button variant="secondary" size="sm" grow onClick={() => updateContext({ view: 'review' })}>
            <Trans>添加注释</Trans>
          </Button>
        </>
      }
    >
      <PlayerMatchDetail
        analysis={analysis.data}
        row={row}
        {...(addToVideo.disabledReason === undefined
          ? {}
          : { addDisabledReason: addToVideo.disabledReason })}
      />
    </MatchInspectorPanel>
  );
}

export const PlayersView: MatchViewModule = {
  id: 'players',
  Body: PlayersBody,
  Inspector: PlayersInspector,
};
