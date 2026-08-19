/*
 * pages/match/views — 队伍 (`?view=teams`).
 *
 * §7 creates this view and the supplement artboard's merge table names it
 * 「队伍（阵营 · 经济 · 回合）」 with the disposition 「三套团队工作区合成一个子视图，
 * 同时接管 /lineups，为将来的持久队伍页留位置」. **No artboard draws it**, so the
 * three blocks below are derived from that title plus the language the rest of
 * the workspace already speaks, and each one says where it comes from:
 *
 *   阵营      one panel per team, each a roster table in the columns 「03 比赛
 *             工作区」's 记分板 draws (选手 / K / D / A / K/D / ADR / HS%). Picking
 *             a row focuses that player — the §4.4 `player` parameter, the same
 *             one the context bar's chip clears.
 *   经济      `insights.round_economy`, one row per round. See below: it is
 *             **by side**, and the table says so.
 *   回合      how each team's rounds ended, from `RoundEndReason`. This is the
 *             one block that is per-team all the way down, because a round's
 *             winner is the only per-team fact the round record carries.
 *
 * ── Scoped to this match, and that is the point ──────────────────────────
 *
 * §7 retires `/lineups` without a redirect, and `data/match.ts` gap 4 records
 * why the takeover is not reachable yet: `listLineups` is a cross-match
 * directory keyed by a lineup id nothing maps a demo onto. So this view is built
 * from this match's own `teams` / `players` / `insights` and claims nothing
 * about a persistent team. When the mapping lands, this is where the link to it
 * goes.
 *
 * ── 经济 is by side, not by team ─────────────────────────────────────────
 *
 * `RoundEconomyInsightRecord.teams[].team` is `'CT'` / `'T'`, and the analyser
 * says why on the line that builds it: 「A player's side changes at halftime.
 * Only the team carried by this purchase event is valid for a per-round side
 * total.」 Joining those onto Aurora and Meridian needs a per-round side
 * assignment that is not on the wire. The table therefore keeps the side
 * labelling and states it in its own head, rather than picking a half boundary
 * and attributing half the match to the wrong team. `economyModel.ts` carries
 * the full reasoning, including why a total spend is `null` rather than low.
 *
 * ── Fields the artboard's 记分板 has and this one omits ──────────────────
 *
 * 首杀 / 残局 / 高光 are three of the artboard's scoreboard columns.
 * `PlayerAnalysis` carries none of them, and only 高光 is derivable at all
 * (count the candidates whose `player_id` matches). It is offered; the other two
 * are omitted rather than rendered as 0 — the rule from the previous phases.
 */

import { msg } from '@lingui/core/macro';
import { useLingui } from '@lingui/react';
import { Trans } from '@lingui/react/macro';
import type { ReactNode } from 'react';

import { DataTable, Empty, type DataTableColumn } from '../../../design/data';
import { Alert } from '../../../design/feedback';
import { Button, Badge } from '../../../design/primitives';
import {
  ROUND_END_REASON,
  ROUND_END_REASONS,
  TEAM_SIDE,
  type TeamSide,
} from '../../../domain/match';
import type { AnalysisWorkspace, PlayerAnalysis } from '../../../shared/desktop/viewModels';
import { MatchInspectorPanel } from '../MatchInspectorPanel';
import type { MatchContextPatch } from '../workspaceContext';
import type { MatchViewModule, MatchViewProps } from '../viewContract';
import {
  playerDirectory,
  rosters,
  teamNames,
  winsByReason,
  type TeamKey,
} from './matchAggregates';
import { economyAvailability, economyTotals, sideEconomyRows, type SideEconomyRow } from './economyModel';
import { SelectedRoundLine, useAnalysisGate, ViewFrame, ViewPanel } from './viewChrome';

/* ── formatting ──────────────────────────────────────────────────────────── */

/** 「1.93」 — two decimals, the precision the artboard's K/D column prints. */
function ratio(value: number): string {
  return Number.isFinite(value) ? value.toFixed(2) : '—';
}

/** 「98.4」 — one decimal, as ADR is printed everywhere in this product. */
function adr(value: number): string {
  return Number.isFinite(value) ? value.toFixed(1) : '—';
}

/** 「62%」 from the 0…1 fraction the wire sends (`headshots ÷ kills`). */
function percent(fraction: number): string {
  return Number.isFinite(fraction) ? `${Math.round(fraction * 100)}%` : '—';
}

/** 「$12 350」, or 「—」 when one of the rounds in the sum carried no price. */
function money(value: number | null): string {
  return value === null ? '—' : `$${value.toLocaleString('en-US')}`;
}

/* ── one team ────────────────────────────────────────────────────────────── */

export interface TeamRosterPanelProps {
  readonly team: TeamKey;
  readonly name: ReactNode;
  /** The side this team is on *now*; sides swap, so it is not an identity. */
  readonly side: TeamSide | undefined;
  readonly score: number | null;
  readonly players: readonly PlayerAnalysis[];
  /** Highlight candidates per player id — the one artboard column that survives. */
  readonly highlightsByPlayer: ReadonlyMap<string, number>;
  readonly selectedPlayer: string | null;
  readonly onUpdateContext: (patch: MatchContextPatch) => void;
}

export function TeamRosterPanel({
  team,
  name,
  side,
  score,
  players,
  highlightsByPlayer,
  selectedPlayer,
  onUpdateContext,
}: TeamRosterPanelProps) {
  const { i18n } = useLingui();
  const anyHighlights = players.some((player) => (highlightsByPlayer.get(player.id) ?? 0) > 0);

  const columns: DataTableColumn<PlayerAnalysis>[] = [
    {
      id: 'name',
      header: <Trans>选手</Trans>,
      truncate: true,
      hideable: false,
      cell: (player) => player.name,
    },
    { id: 'kills', header: <Trans>K</Trans>, variant: 'numeric', width: '3.5rem', cell: (p) => p.kills },
    { id: 'deaths', header: <Trans>D</Trans>, variant: 'numeric', width: '3.5rem', cell: (p) => p.deaths },
    { id: 'assists', header: <Trans>A</Trans>, variant: 'numeric', width: '3.5rem', cell: (p) => p.assists },
    {
      id: 'kd',
      header: <Trans>K/D</Trans>,
      variant: 'numeric',
      width: '4.5rem',
      cell: (p) => ratio(p.kill_death_ratio),
    },
    { id: 'adr', header: <Trans>ADR</Trans>, variant: 'numeric', width: '4.5rem', cell: (p) => adr(p.adr) },
    {
      id: 'hs',
      header: <Trans>爆头率</Trans>,
      variant: 'numeric',
      width: '4.5rem',
      cell: (p) => percent(p.headshot_rate),
    },
  ];

  /* The column only exists when the highlight pass produced something for this
     team. A column of zeros beside a real scoreboard reads as a claim that
     nobody had a highlight, which is not the same as 「没有跑高光检出」. */
  if (anyHighlights) {
    columns.push({
      id: 'highlights',
      header: <Trans>高光</Trans>,
      variant: 'numeric',
      width: '4rem',
      cell: (player) => highlightsByPlayer.get(player.id) ?? 0,
    });
  }

  return (
    <ViewPanel
      id={`team-${team}`}
      title={name}
      hint={
        <span className="flex items-center gap-2">
          {side === undefined ? null : (
            <Badge variant="neutral">{i18n._(TEAM_SIDE[side].label)}</Badge>
          )}
          {score === null ? null : (
            <span className="font-mono">
              <Trans>{score} 回合</Trans>
            </span>
          )}
        </span>
      }
    >
      <DataTable
        caption={<Trans>队伍名单与本场数据</Trans>}
        columns={columns}
        rows={players}
        rowId={(player) => player.id}
        rowLabel={(player) => player.name}
        activeRowId={selectedPlayer}
        onRowActivate={(id) => onUpdateContext({ player: id })}
        empty={
          <Empty
            headingLevel={4}
            className="border-0"
            title={<Trans>这一队没有选手记录</Trans>}
            description={<Trans>这场分析里没有属于这一队的选手。</Trans>}
            actions={
              <Button variant="secondary" onClick={() => onUpdateContext({ view: 'overview' })}>
                <Trans>回到概览</Trans>
              </Button>
            }
          />
        }
      />
    </ViewPanel>
  );
}

/* ── the economy table ───────────────────────────────────────────────────── */

export interface EconomyPanelProps {
  readonly analysis: AnalysisWorkspace;
  readonly teamAName: ReactNode;
  readonly teamBName: ReactNode;
  readonly selectedRound: number | null;
  readonly onUpdateContext: (patch: MatchContextPatch) => void;
}

export function EconomyPanel({
  analysis,
  teamAName,
  teamBName,
  selectedRound,
  onUpdateContext,
}: EconomyPanelProps) {
  const { i18n } = useLingui();
  const availability = economyAvailability(analysis.insights);
  const rows = sideEconomyRows(analysis);
  const totals = economyTotals(rows);

  const columns: readonly DataTableColumn<SideEconomyRow>[] = [
    {
      id: 'round',
      header: <Trans>回合</Trans>,
      variant: 'numeric',
      width: '4.5rem',
      hideable: false,
      cell: (row) => row.round,
    },
    {
      id: 'winner',
      header: <Trans>胜方</Trans>,
      truncate: true,
      cell: (row) => (
        <span className="flex min-w-0 items-center gap-2">
          <span className="min-w-0 truncate">{row.winner === 'a' ? teamAName : teamBName}</span>
          <span className="flex-none text-xs text-neutral-600">
            {i18n._(ROUND_END_REASON[row.reason].label)}
          </span>
        </span>
      ),
    },
    {
      id: 'ct-purchases',
      header: <Trans>CT 购买</Trans>,
      variant: 'numeric',
      width: '6rem',
      cell: (row) => row.ct.purchases,
    },
    {
      id: 'ct-spend',
      header: <Trans>CT 花费</Trans>,
      variant: 'numeric',
      width: '7rem',
      cell: (row) => money(row.ct.spend),
    },
    {
      id: 't-purchases',
      header: <Trans>T 购买</Trans>,
      variant: 'numeric',
      width: '6rem',
      cell: (row) => row.t.purchases,
    },
    {
      id: 't-spend',
      header: <Trans>T 花费</Trans>,
      variant: 'numeric',
      width: '7rem',
      cell: (row) => money(row.t.spend),
    },
  ];

  return (
    <ViewPanel
      id="economy"
      title={<Trans>经济</Trans>}
      /* Stated in the head, not in a footnote: a reader who takes 「CT 购买」 for
         「主队购买」 would read the second half of the match backwards. */
      hint={<Trans>购买事件带的是当回合的阵营，不是队伍</Trans>}
    >
      {!availability.present ? (
        <p className="px-3.5 py-3 text-sm text-neutral-700">
          <Trans>这份分析结果里没有洞察数据，经济统计无法显示。</Trans>
        </p>
      ) : !availability.available ? (
        <div className="p-3.5">
          <Alert
            variant="info"
            action={{
              label: <Trans>看回合详情</Trans>,
              onAction: () => onUpdateContext({ view: 'rounds' }),
            }}
          >
            {/* The service's own sentence, not a rewrite of it: it knows why the
                pass could not run and this page does not. */}
            <Trans>这批 Demo 没有可用的购买事件{formatReason(availability.reason)}</Trans>
          </Alert>
        </div>
      ) : (
        <>
          <DataTable
            caption={<Trans>每回合按阵营统计的购买事件</Trans>}
            columns={columns}
            rows={rows}
            rowId={(row) => String(row.round)}
            activeRowId={selectedRound === null ? null : String(selectedRound)}
            onRowActivate={(_id, row) => onUpdateContext({ view: 'rounds', round: row.round })}
            className="max-h-96"
          />
          <p
            data-match-economy-total=""
            className="flex flex-wrap items-center gap-x-5 gap-y-1 border-t border-divider px-3.5 py-2 text-xs text-neutral-700"
          >
            <span>
              <Trans>共 {totals.rounds} 回合</Trans>
            </span>
            <span className="font-mono">
              <Trans>
                CT {totals.ct.purchases} 次 · {money(totals.ct.spend)}
              </Trans>
            </span>
            <span className="font-mono">
              <Trans>
                T {totals.t.purchases} 次 · {money(totals.t.spend)}
              </Trans>
            </span>
            {totals.unattributed > 0 ? (
              <span data-match-economy-unattributed="" className="text-warn-text">
                <Trans>{totals.unattributed} 次购买没能归属到阵营</Trans>
              </span>
            ) : null}
            {totals.ct.spend === null || totals.t.spend === null ? (
              <span className="text-neutral-600">
                <Trans>有回合缺少价格，花费合计以「—」表示而不是少算</Trans>
              </span>
            ) : null}
          </p>
        </>
      )}
    </ViewPanel>
  );
}

/** The service's sentence, appended only when it sent one. */
function formatReason(reason: string | null): string {
  return reason === null || reason.trim() === '' ? '。' : `：${reason.trim()}`;
}

/* ── how the rounds ended ────────────────────────────────────────────────── */

export interface RoundOutcomePanelProps {
  readonly analysis: AnalysisWorkspace;
  readonly teamAName: ReactNode;
  readonly teamBName: ReactNode;
}

export function RoundOutcomePanel({ analysis, teamAName, teamBName }: RoundOutcomePanelProps) {
  const { i18n } = useLingui();
  const wins = winsByReason(analysis.rounds);
  const rows = ROUND_END_REASONS.map((reason) => ({
    reason,
    a: wins.a[reason],
    b: wins.b[reason],
  })).filter((row) => row.a > 0 || row.b > 0);

  const totalA = ROUND_END_REASONS.reduce((sum, reason) => sum + wins.a[reason], 0);
  const totalB = ROUND_END_REASONS.reduce((sum, reason) => sum + wins.b[reason], 0);

  return (
    <ViewPanel
      id="round-outcomes"
      title={<Trans>回合结束方式</Trans>}
      hint={<Trans>每一行是一种结束原因，数字是用这种方式赢下的回合数</Trans>}
    >
      {rows.length === 0 ? (
        <p className="px-3.5 py-3 text-sm text-neutral-700">
          <Trans>这场比赛还没有解析出回合。</Trans>
        </p>
      ) : (
        <DataTable
          caption={<Trans>两支队伍分别以哪种方式赢下回合</Trans>}
          columns={[
            {
              id: 'reason',
              header: <Trans>结束原因</Trans>,
              hideable: false,
              cell: (row) => i18n._(ROUND_END_REASON[row.reason].label),
            },
            { id: 'a', header: teamAName, variant: 'numeric', cell: (row) => row.a },
            { id: 'b', header: teamBName, variant: 'numeric', cell: (row) => row.b },
          ]}
          rows={rows}
          rowId={(row) => row.reason}
        />
      )}
      <p className="border-t border-divider px-3.5 py-2 font-mono text-xs text-neutral-700">
        {`${totalA} - ${totalB}`}
      </p>
    </ViewPanel>
  );
}

/* ── the body ────────────────────────────────────────────────────────────── */

export interface TeamsPanelsProps {
  readonly analysis: AnalysisWorkspace;
  readonly selectedPlayer: string | null;
  readonly selectedRound: number | null;
  readonly onUpdateContext: (patch: MatchContextPatch) => void;
}

export function TeamsPanels({
  analysis,
  selectedPlayer,
  selectedRound,
  onUpdateContext,
}: TeamsPanelsProps) {
  const names = teamNames(analysis);
  const teamAName = names.a === '' ? <Trans>队伍 A</Trans> : names.a;
  const teamBName = names.b === '' ? <Trans>队伍 B</Trans> : names.b;
  const roster = rosters(analysis.players);
  const [wireA, wireB] = analysis.teams;

  const highlightsByPlayer = new Map<string, number>();
  for (const highlight of analysis.highlights) {
    highlightsByPlayer.set(
      highlight.player_id,
      (highlightsByPlayer.get(highlight.player_id) ?? 0) + 1,
    );
  }

  return (
    <>
      <TeamRosterPanel
        team="a"
        name={teamAName}
        side={normaliseSide(wireA?.side)}
        score={wireA?.score ?? null}
        players={roster.a}
        highlightsByPlayer={highlightsByPlayer}
        selectedPlayer={selectedPlayer}
        onUpdateContext={onUpdateContext}
      />
      <TeamRosterPanel
        team="b"
        name={teamBName}
        side={normaliseSide(wireB?.side)}
        score={wireB?.score ?? null}
        players={roster.b}
        highlightsByPlayer={highlightsByPlayer}
        selectedPlayer={selectedPlayer}
        onUpdateContext={onUpdateContext}
      />
      <EconomyPanel
        analysis={analysis}
        teamAName={teamAName}
        teamBName={teamBName}
        selectedRound={selectedRound}
        onUpdateContext={onUpdateContext}
      />
      <RoundOutcomePanel analysis={analysis} teamAName={teamAName} teamBName={teamBName} />
    </>
  );
}

/**
 * `TeamSummary.side` is free text on the wire (「CT」/「T」/「」). Anything else is
 * dropped rather than guessed — `matchModel.ts` makes the same call, and a badge
 * that says CT for a team that is on T is worse than no badge.
 */
function normaliseSide(side: string | undefined): TeamSide | undefined {
  const key = side?.trim().toLowerCase();
  if (key === 'ct') return 'ct';
  if (key === 't') return 't';
  return undefined;
}

function TeamsBody({ demoId, context, updateContext }: MatchViewProps) {
  const gate = useAnalysisGate(demoId);

  return (
    <ViewFrame view="teams" state={gate.state}>
      <SelectedRoundLine round={context.round} />
      {gate.analysis === undefined ? (
        <ViewPanel id="teams" title={<Trans>队伍</Trans>}>
          {gate.fallback}
        </ViewPanel>
      ) : (
        <TeamsPanels
          analysis={gate.analysis}
          selectedPlayer={context.player}
          selectedRound={context.round}
          onUpdateContext={updateContext}
        />
      )}
    </ViewFrame>
  );
}

/* ── the Inspector ───────────────────────────────────────────────────────── */

const NO_TEAM = msg`未归队`;

function TeamsInspector({ demoId, context, updateContext, addToVideo, collapsed }: MatchViewProps) {
  const { i18n } = useLingui();
  const gate = useAnalysisGate(demoId);
  const directory =
    gate.analysis === undefined ? null : playerDirectory(gate.analysis.players);
  const player = context.player === null ? undefined : directory?.get(context.player);

  if (player === undefined) {
    return (
      <MatchInspectorPanel
        title={<Trans>选中项</Trans>}
        summary={<Trans>未选中任何选手</Trans>}
        addToVideo={addToVideo}
        collapsed={collapsed}
      >
        <p className="text-sm text-neutral-700">
          <Trans>在上面的名单里点一名选手，他这一场的数据会出现在这里。</Trans>
        </p>
      </MatchInspectorPanel>
    );
  }

  const names = gate.analysis === undefined ? { a: '', b: '' } : teamNames(gate.analysis);
  const teamName = player.team === 'A' ? names.a : names.b;
  const highlights =
    gate.analysis?.highlights.filter((highlight) => highlight.player_id === player.id).length ?? 0;

  return (
    <MatchInspectorPanel
      title={<Trans>选中：{player.name}</Trans>}
      summary={<Trans>{player.name} · {player.kills} 杀</Trans>}
      addToVideo={addToVideo}
      addLabel={<Trans>把这名选手加入作品</Trans>}
      selection={{ playerId: player.id }}
      collapsed={collapsed}
      secondaryActions={
        <>
          <Button variant="secondary" size="sm" onClick={() => updateContext({ view: 'players' })}>
            <Trans>玩家视图</Trans>
          </Button>
          <Button variant="secondary" size="sm" onClick={() => updateContext({ view: 'duels' })}>
            <Trans>对位</Trans>
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Badge variant="accent">{teamName === '' ? i18n._(NO_TEAM) : teamName}</Badge>
        <dl className="grid grid-cols-2 gap-x-5 gap-y-3">
          <StatPair label={<Trans>K / D / A</Trans>} value={`${player.kills} / ${player.deaths} / ${player.assists}`} />
          <StatPair label={<Trans>K/D</Trans>} value={ratio(player.kill_death_ratio)} />
          <StatPair label={<Trans>ADR</Trans>} value={adr(player.adr)} />
          <StatPair label={<Trans>爆头率</Trans>} value={percent(player.headshot_rate)} />
          {highlights === 0 ? null : (
            <StatPair label={<Trans>高光候选</Trans>} value={String(highlights)} />
          )}
        </dl>
        {/* 首杀 / 残局 are two more columns of the artboard's 记分板.
            `PlayerAnalysis` carries neither and nothing derives them, so they are
            absent rather than zero. */}
      </div>
    </MatchInspectorPanel>
  );
}

function StatPair({ label, value }: { readonly label: ReactNode; readonly value: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <dt className="text-xs text-neutral-600">{label}</dt>
      <dd className="font-mono text-base text-accent-800">{value}</dd>
    </div>
  );
}

export const TeamsView: MatchViewModule = {
  id: 'teams',
  Body: TeamsBody,
  Inspector: TeamsInspector,
};
