/*
 * pages/match/views — 对位 (`?view=duels`).
 *
 * 「补齐 · 比赛工作区子视图 · 对位 · 首杀对决」. The artboard's caption fixes the
 * shape: 「单元格＝行方对列方的击杀数，点开进入证据列表」, behind a segmented
 * control that swaps the whole board between 对位矩阵 and 首杀对决.
 *
 * ── The artboard asks for a table *and* a picture; only the table is real ──
 *
 * Beside the matrix the artboard draws a 「首杀方向」 plate with three engagement
 * axes on a blueprint grid, and `domain/map/EngagementLayer` renders exactly
 * that. It is not drawn here, and the reason is not effort: an `Engagement`
 * needs an attacker point and a victim point, and `TimelineEvent` carries one
 * `position` with nothing on the wire saying whose it is. `describeEngagement`
 * would then print a bearing and a distance measured against a coordinate
 * nobody sent — a fabricated measurement wearing the legend 「经击杀验证的交战
 * 轴」. So the spatial half is reported as a contract gap and the view ships the
 * two tables, which are fully backed.
 *
 * That also settles §10.3 gap 1 for this view by removing the question: with no
 * layer, the markup this view emits is bounded by the matrix (5 × 5 cells plus
 * a total column) and by one table of at most `LONG_OVERTIME_ROUNDS` rows. No
 * sampling strategy is needed because nothing here is unbounded; the density
 * test pins both counts.
 *
 * ── One selection, and the one the URL cannot hold ────────────────────────
 *
 * Picking a cell means picking a *pair*, and §4.4 gives the address one
 * `player` parameter. The row player therefore goes into the URL — where every
 * other view reads it — and the opponent is view-local state, documented here
 * and reported as a gap rather than smuggled into `?evidence=`, which names a
 * piece of evidence and not a person. Consequence, stated plainly: a copied
 * link restores 「Kael」, not 「Kael → Sable」.
 */

import { t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { useMemo, useState, type ReactNode } from 'react';

import { useMatchAnalysis } from '../../../data/match';
import { DataTable, EmptyState, type DataTableColumn } from '../../../design/data';
import { Button, Seg, Badge } from '../../../design/primitives';
import { formatTickTimecode } from '../../../domain/match';
import type { PlayerMatchupInsightRecord } from '../../../shared/desktop/dto';
import type { AnalysisWorkspace } from '../../../shared/desktop/viewModels';
import { MatchInspectorPanel } from '../MatchInspectorPanel';
import type { MatchViewModule, MatchViewProps } from '../viewContract';
import {
  cellWashPercent,
  duelMatrix,
  hasKillEvents,
  matchupsAgainst,
  openingDuels,
  pairKills,
  rosterIndex,
  type DuelMatrix,
  type DuelMatrixRow,
  type OpeningDuel,
  type PairKill,
  type RosterEntry,
} from './duelsModel';
import { formatFixed, NO_VALUE, teamNames } from './playersModel';
import { SelectedRoundLine, useAnalysisGate, ViewFrame, ViewPanel } from './viewChrome';

/* ── pieces ──────────────────────────────────────────────────────────────── */

/**
 * A sub-panel head. The artboard draws it at 32px; `--h-thead` (34) is the §3.4
 * token for a header strip above rows, which is the 2px fold `DataTable` already
 * signed off on, so no bare 32 is written down.
 */
function PanelHead({ children }: { readonly children: ReactNode }) {
  return (
    <div className="flex h-[var(--h-thead)] flex-none items-center border-b border-divider px-2.5 font-heading text-2xs tracking-widest text-neutral-700">
      {children}
    </div>
  );
}

/* ── the matrix ──────────────────────────────────────────────────────────── */

export interface DuelMatrixTableProps {
  readonly matrix: DuelMatrix;
  /** 「Aurora ＼ Meridian」 — the corner cell of the artboard. */
  readonly rowTeamName: string;
  readonly columnTeamName: string;
  readonly activePlayerId: string | null;
  readonly activeOpponentId: string | null;
  readonly onSelectPlayer: (playerId: string) => void;
  readonly onSelectPair: (playerId: string, opponentId: string) => void;
}

/**
 * 对位矩阵. Presentational and exported so the `markup` project can render it
 * with resolved numbers.
 *
 * Every cell prints its count, so the accent wash on top of it is redundant by
 * construction — §6.2's 「不要用颜色单独承载含义」 holds in greyscale and for a
 * screen reader, which hears the full sentence off `aria-label`.
 */
export function DuelMatrixTable({
  matrix,
  rowTeamName,
  columnTeamName,
  activePlayerId,
  activeOpponentId,
  onSelectPlayer,
  onSelectPair,
}: DuelMatrixTableProps) {
  const columns = useMemo<readonly DataTableColumn<DuelMatrixRow>[]>(() => {
    const head: DataTableColumn<DuelMatrixRow> = {
      id: 'player',
      header:
        rowTeamName === '' || columnTeamName === '' ? (
          <Trans>行方 ＼ 列方</Trans>
        ) : (
          <>
            {rowTeamName} ＼ {columnTeamName}
          </>
        ),
      headerLabel: t`行方与列方`,
      hideable: false,
      truncate: true,
      cell: (row) => <span className="truncate">{row.player.name}</span>,
    };

    const cells = matrix.columns.map(
      (opponent): DataTableColumn<DuelMatrixRow> => ({
        id: opponent.id,
        header: opponent.name,
        headerLabel: opponent.name,
        /* `TableCellAlign` is start / end only — the design layer has no centre
           because no artboard column is centred except this matrix, and the
           cell button spans the column anyway. */
        align: 'end',
        variant: 'numeric',
        cell: (row) => {
          const cell = row.cells.find((entry) => entry.opponent.id === opponent.id);
          if (cell === undefined) return NO_VALUE;
          return (
            <MatrixCell
              killerName={row.player.name}
              victimName={opponent.name}
              kills={cell.kills}
              maxKills={matrix.maxKills}
              selected={row.player.id === activePlayerId && opponent.id === activeOpponentId}
              onSelect={() => onSelectPair(row.player.id, opponent.id)}
            />
          );
        },
      }),
    );

    const total: DataTableColumn<DuelMatrixRow> = {
      id: 'total',
      header: <Trans>合计</Trans>,
      headerLabel: t`合计`,
      align: 'end',
      variant: 'numeric',
      hideable: false,
      cell: (row) => formatFixed(row.kills, 0),
    };

    return [head, ...cells, total];
  }, [matrix, rowTeamName, columnTeamName, activePlayerId, activeOpponentId, onSelectPair]);

  return (
    <DataTable
      /* The panel already draws the rule; the cap keeps both axes of the
         scroll inside the table's own container (§10.3). */
      className="max-h-96"
      caption={<Trans>对位矩阵：行方对列方的击杀数</Trans>}
      columns={columns}
      rows={matrix.rows}
      rowId={(row) => row.player.id}
      rowLabel={(row) => row.player.name}
      activeRowId={activePlayerId}
      onRowActivate={(rowId) => onSelectPlayer(rowId)}
    />
  );
}

function MatrixCell({
  killerName,
  victimName,
  kills,
  maxKills,
  selected,
  onSelect,
}: {
  readonly killerName: string;
  readonly victimName: string;
  readonly kills: number;
  readonly maxKills: number;
  readonly selected: boolean;
  readonly onSelect: () => void;
}) {
  /* A zero is a measurement here — both players were on the server all match —
     but there is no evidence list behind it, so it is text rather than a
     control that would open an empty panel. */
  if (kills <= 0) {
    return <span className="text-neutral-500">{formatFixed(kills, 0)}</span>;
  }

  const wash = cellWashPercent(kills, maxKills);
  return (
    <button
      type="button"
      data-duel-cell={`${killerName}>${victimName}`}
      aria-pressed={selected}
      aria-label={t`${killerName} 击杀 ${victimName} ${kills} 次`}
      onClick={onSelect}
      className={
        selected
          ? 'block w-full cursor-pointer px-2 py-1 outline-2 -outline-offset-2 outline-accent'
          : 'block w-full cursor-pointer px-2 py-1'
      }
      /* The wash is a computed share of the accent ramp, so it is an inline
         style rather than a utility; the colour itself is still a token. */
      style={{ backgroundColor: `color-mix(in srgb, var(--color-accent) ${String(wash)}%, transparent)` }}
    >
      {formatFixed(kills, 0)}
    </button>
  );
}

/* ── the opening duels ───────────────────────────────────────────────────── */

export interface OpeningDuelTableProps {
  readonly duels: readonly OpeningDuel[];
  readonly index: ReadonlyMap<string, RosterEntry>;
  readonly tickRate: number;
  readonly activeRound: number | null;
  readonly onSelectRound: (duel: OpeningDuel) => void;
  readonly onLocate: (duel: OpeningDuel) => void;
}

/** 首杀对决 — one row per round that had an attributed first kill. */
export function OpeningDuelTable({
  duels,
  index,
  tickRate,
  activeRound,
  onSelectRound,
  onLocate,
}: OpeningDuelTableProps) {
  const columns = useMemo<readonly DataTableColumn<OpeningDuel>[]>(
    () => [
      {
        id: 'round',
        header: <Trans>回合</Trans>,
        headerLabel: t`回合`,
        variant: 'numeric',
        hideable: false,
        width: '72px',
        cell: (duel) => formatFixed(duel.round, 0),
      },
      /*
       * These two columns name *people*, not facts, so they carry
       * `context: 'duel-column'`: bare 首杀 is `domain/match`'s highlight kind
       * (Opening kill), and a column of player names headed "Opening kill"
       * reads as the wrong part of speech — it wants "Opening killer". 被击杀
       * is tagged with it as the other half of the pair rather than left bare,
       * so the two headers are translated as one thought.
       *
       * 回合 / 武器 / 时间码 below stay untagged on purpose. They are the same
       * word with the same meaning as everywhere else in the app, and forking
       * them would produce two catalogue entries free to drift — 穿墙 and 爆头
       * are each shared by eight call sites today and are the better model.
       */
      {
        id: 'killer',
        header: <Trans context="duel-column">首杀</Trans>,
        headerLabel: t`首杀`,
        truncate: true,
        cell: (duel) => index.get(duel.killerId)?.name ?? duel.killerId,
      },
      {
        id: 'victim',
        header: <Trans context="duel-column">被击杀</Trans>,
        headerLabel: t`被击杀`,
        truncate: true,
        cell: (duel) => index.get(duel.victimId)?.name ?? duel.victimId,
      },
      {
        id: 'weapon',
        header: <Trans>武器</Trans>,
        headerLabel: t`武器`,
        truncate: true,
        /* Rendered verbatim, as `domain/map/EngagementLayer` already
           established: the demo spells it `ak47` and no rename table exists. */
        cell: (duel) => duel.weapon ?? NO_VALUE,
      },
      {
        id: 'marks',
        header: <Trans>标记</Trans>,
        headerLabel: t`标记`,
        cell: (duel) => <DuelMarks headshot={duel.headshot} penetrated={duel.penetrated} />,
      },
      {
        id: 'timecode',
        header: <Trans>时间码</Trans>,
        headerLabel: t`时间码`,
        variant: 'numeric',
        cell: (duel) => formatTickTimecode(duel.tick, tickRate),
      },
      {
        id: 'locate',
        headerLabel: t`定位`,
        hideable: false,
        width: '86px',
        cell: (duel) => (
          <Button variant="ghost" size="sm" onClick={() => onLocate(duel)}>
            {/* Untagged, so it shares `EvidenceRow`'s 「定位」 catalogue entry —
                it is the same product action seeking the same playhead. */}
            <Trans>定位</Trans>
          </Button>
        ),
      },
    ],
    [index, tickRate, onLocate],
  );

  return (
    <DataTable
      /* The panel already draws the rule; the cap keeps both axes of the
         scroll inside the table's own container (§10.3). */
      className="max-h-96"
      caption={<Trans>每个回合的首杀对决</Trans>}
      columns={columns}
      rows={duels}
      rowId={(duel) => String(duel.round)}
      rowLabel={(duel) => `R${String(duel.round)}`}
      activeRowId={activeRound === null ? null : String(activeRound)}
      onRowActivate={(_rowId, duel) => onSelectRound(duel)}
    />
  );
}

function DuelMarks({
  headshot,
  penetrated,
}: {
  readonly headshot: boolean;
  readonly penetrated: boolean;
}) {
  if (!headshot && !penetrated) return <span className="text-neutral-500">{NO_VALUE}</span>;
  return (
    <span className="flex flex-wrap items-center gap-1">
      {headshot ? (
        <Badge variant="accent">
          <Trans>爆头</Trans>
        </Badge>
      ) : null}
      {penetrated ? (
        <Badge variant="neutral">
          <Trans>穿墙</Trans>
        </Badge>
      ) : null}
    </span>
  );
}

/* ── the pair panel ──────────────────────────────────────────────────────── */

export interface PairKillListProps {
  readonly killerName: string;
  readonly victimName: string;
  readonly kills: readonly PairKill[];
  readonly tickRate: number;
  readonly onLocate: (kill: PairKill) => void;
}

/**
 * 「Kael → Sable 的 7 次交手」.
 *
 * The artboard's 距离 and 位置 columns are absent: neither is on the wire for a
 * kill event, and a column that is always empty is the same lie as a silent
 * truncation (§10.4).
 */
export function PairKillList({
  killerName,
  victimName,
  kills,
  tickRate,
  onLocate,
}: PairKillListProps) {
  return (
    <section data-duel-pair="" className="flex min-w-0 flex-col border border-divider">
      <PanelHead>
        <Trans>
          {killerName} → {victimName} 的 {kills.length} 次交手
        </Trans>
      </PanelHead>
      {kills.length === 0 ? (
        <p className="px-2.5 py-3 text-xs text-neutral-700">
          <Trans>这份分析没有逐条击杀事件，所以列不出这一对的交手。</Trans>
        </p>
      ) : (
        <ul className="max-h-80 list-none overflow-y-auto overscroll-y-contain">
          {kills.map((kill) => (
            <li
              key={kill.eventId}
              className="flex h-[var(--h-row-compact)] items-center gap-3 border-b border-divider px-2.5 text-sm"
            >
              <span className="w-13 flex-none font-mono text-xs text-neutral-700">
                <Trans>R{kill.round}</Trans>
              </span>
              <span className="min-w-0 flex-1 truncate">{kill.weapon ?? NO_VALUE}</span>
              <DuelMarks headshot={kill.headshot} penetrated={kill.penetrated} />
              <span className="flex-none font-mono text-xs text-neutral-700">
                {formatTickTimecode(kill.tick, tickRate)}
              </span>
              <Button variant="ghost" size="sm" onClick={() => onLocate(kill)}>
                <Trans>定位</Trans>
              </Button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export interface MatchupListProps {
  readonly matchups: readonly PlayerMatchupInsightRecord[];
  readonly index: ReadonlyMap<string, RosterEntry>;
  readonly onSelectOpponent: (opponentId: string) => void;
  readonly activeOpponentId: string | null;
}

/** 「Kael 的对位」 — every opponent, strongest first. */
export function MatchupList({
  matchups,
  index,
  onSelectOpponent,
  activeOpponentId,
}: MatchupListProps) {
  return (
    <ul className="max-h-80 list-none overflow-y-auto overscroll-y-contain">
      {matchups.map((matchup) => {
        const name = index.get(matchup.opponent_id)?.name ?? matchup.opponent_id;
        const active = matchup.opponent_id === activeOpponentId;
        return (
          <li key={matchup.opponent_id}>
            <button
              type="button"
              data-duel-opponent={matchup.opponent_id}
              aria-current={active ? 'true' : undefined}
              onClick={() => onSelectOpponent(matchup.opponent_id)}
              className={
                active
                  ? 'flex h-[var(--h-row-compact)] w-full cursor-pointer items-center gap-3 border-b border-divider bg-accent-100 px-2.5 text-left text-sm shadow-[inset_2px_0_0_var(--color-accent)]'
                  : 'flex h-[var(--h-row-compact)] w-full cursor-pointer items-center gap-3 border-b border-divider px-2.5 text-left text-sm hover:bg-surface'
              }
            >
              <span className="min-w-0 flex-1 truncate">{name}</span>
              <span className="flex-none font-mono text-xs">
                <Trans>
                  {matchup.kills} 杀 / {matchup.deaths} 死
                </Trans>
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/* ── the body ────────────────────────────────────────────────────────────── */

type DuelMode = 'matrix' | 'opening';

function DuelsBody({ demoId, context, updateContext }: MatchViewProps) {
  const gate = useAnalysisGate(demoId);
  const [mode, setMode] = useState<DuelMode>('matrix');
  /* The opponent half of the pair. §4.4 has no parameter for it — see the
     module header — so it is view-local and is dropped when the row player
     changes, which is the only invariant the pair has. */
  const [opponentId, setOpponentId] = useState<string | null>(null);

  const index = useMemo(() => rosterIndex(gate.analysis), [gate.analysis]);
  const names = useMemo(() => teamNames(gate.analysis), [gate.analysis]);
  /* The row axis follows the focused player's side, so selecting someone on the
     记分板 and walking over here shows their half of the grid. */
  const rowTeam = context.player === null ? 'A' : (index.get(context.player)?.team ?? 'A');
  const matrix = useMemo(() => duelMatrix(gate.analysis, rowTeam), [gate.analysis, rowTeam]);
  const rounds = gate.analysis?.rounds ?? [];
  const duels = useMemo(() => openingDuels(rounds), [rounds]);

  const availability = gate.analysis?.insights?.availability.matchups;
  const matchupsUnavailable = availability !== undefined && !availability.available;
  /* The service's own English sentence, or `null`. Computed once so the JSX
     below does not have to re-narrow an optional through two levels. */
  const unavailableReason =
    matchupsUnavailable && availability.reason !== null && availability.reason.trim() !== ''
      ? availability.reason
      : null;

  const selectPlayer = (playerId: string) => {
    setOpponentId(null);
    updateContext({ player: playerId });
  };
  const selectPair = (playerId: string, nextOpponentId: string) => {
    setOpponentId(nextOpponentId);
    if (playerId !== context.player) updateContext({ player: playerId });
  };

  const activeOpponent = context.player === null ? null : opponentId;
  const killerName =
    context.player === null ? '' : (index.get(context.player)?.name ?? context.player);
  const victimName =
    activeOpponent === null ? '' : (index.get(activeOpponent)?.name ?? activeOpponent);

  const noMatrix = matchupsUnavailable || matrix.rows.length === 0 || matrix.columns.length === 0;

  return (
    <ViewFrame view="duels" state={gate.state}>
      <ViewPanel
        id="duels"
        title={<Trans>对位</Trans>}
        hint={
          mode === 'matrix' ? (
            <Trans>单元格＝行方对列方的击杀数，点开进入这一对的交手</Trans>
          ) : gate.analysis === undefined ? undefined : (
            <Trans>共 {duels.length} 个回合有可归属的首杀</Trans>
          )
        }
        actions={
          <Seg
            name="match-duels-mode"
            value={mode}
            onChange={setMode}
            aria-label={t`对位视图`}
            options={[
              { value: 'matrix', label: <Trans>对位矩阵</Trans> },
              { value: 'opening', label: <Trans>首杀对决</Trans> },
            ]}
          />
        }
      >
        {gate.fallback ??
          (mode === 'matrix' ? (
            noMatrix ? (
              <EmptyState
                className="m-3.5"
                headingLevel={4}
                title={<Trans>没有可用的对位数据</Trans>}
                description={
                  <Trans>
                    这份分析没有解出成对的击杀与伤害事件，所以矩阵是空的。原因见下方。
                  </Trans>
                }
                actions={
                  <Button variant="secondary" onClick={() => setMode('opening')}>
                    <Trans>改看首杀对决</Trans>
                  </Button>
                }
              />
            ) : (
              <DuelMatrixTable
                matrix={matrix}
                rowTeamName={rowTeam === 'A' ? names.A : names.B}
                columnTeamName={rowTeam === 'A' ? names.B : names.A}
                activePlayerId={context.player}
                activeOpponentId={activeOpponent}
                onSelectPlayer={selectPlayer}
                onSelectPair={selectPair}
              />
            )
          ) : duels.length === 0 ? (
            <EmptyState
              className="m-3.5"
              headingLevel={4}
              title={<Trans>没有可归属的首杀</Trans>}
              description={
                hasKillEvents(rounds) ? (
                  <Trans>每个回合的第一次击杀都缺少击杀者或被击杀者，因此无法成对。</Trans>
                ) : (
                  <Trans>这份分析没有逐条击杀事件，首杀要靠事件流才能推出来。</Trans>
                )
              }
              actions={
                <Button variant="secondary" onClick={() => setMode('matrix')}>
                  <Trans>改看对位矩阵</Trans>
                </Button>
              }
            />
          ) : (
            <OpeningDuelTable
              duels={duels}
              index={index}
              tickRate={gate.tickRate}
              activeRound={context.round}
              onSelectRound={(duel) => updateContext({ round: duel.round, tick: duel.tick })}
              onLocate={(duel) =>
                updateContext({ view: 'replay', round: duel.round, tick: duel.tick })
              }
            />
          ))}

        {unavailableReason === null ? null : (
          <p className="border-t border-divider px-3.5 py-2.5 text-2xs text-neutral-600">
            {/* The service's own English sentence, kept verbatim under the
                authored Chinese above so a bug report can quote it. */}
            <Trans>说明：{unavailableReason}</Trans>
          </p>
        )}
      </ViewPanel>

      {/* The pair panel is its own block, as the artboard draws it: the matrix
          answers 「谁压制谁」 and this answers 「那七次发生在哪些回合」. */}
      {gate.fallback !== null || mode !== 'matrix' || noMatrix ? null : context.player === null ? (
        <p className="text-xs text-neutral-600">
          <Trans>点一个单元格看这一对的每一次交手，点行首看这名选手的全部对位。</Trans>
        </p>
      ) : activeOpponent === null ? (
        <ViewPanel id="duel-matchups" title={<Trans>{killerName} 的对位</Trans>}>
          <MatchupList
            matchups={matchupsAgainst(gate.analysis?.insights, context.player, index)}
            index={index}
            activeOpponentId={activeOpponent}
            onSelectOpponent={(next) => setOpponentId(next)}
          />
        </ViewPanel>
      ) : (
        <PairKillList
          killerName={killerName}
          victimName={victimName}
          kills={pairKills(rounds, context.player, activeOpponent)}
          tickRate={gate.tickRate}
          onLocate={(kill) => updateContext({ view: 'replay', round: kill.round, tick: kill.tick })}
        />
      )}

      <SelectedRoundLine round={context.round} />
    </ViewFrame>
  );
}

/* ── the Inspector ───────────────────────────────────────────────────────── */

export interface DuelSummaryProps {
  readonly analysis: AnalysisWorkspace;
  readonly playerId: string;
  readonly index: ReadonlyMap<string, RosterEntry>;
}

/** The selected player's duel totals — measured fields only, no derived score. */
export function DuelSummary({ analysis, playerId, index }: DuelSummaryProps) {
  const matchups = matchupsAgainst(analysis.insights, playerId, index);
  const kills = matchups.reduce((total, matchup) => total + matchup.kills, 0);
  const deaths = matchups.reduce((total, matchup) => total + matchup.deaths, 0);
  const headshots = matchups.reduce((total, matchup) => total + matchup.headshot_kills, 0);
  const dealt = matchups.reduce((total, matchup) => total + matchup.damage_dealt, 0);
  const taken = matchups.reduce((total, matchup) => total + matchup.damage_taken, 0);

  return (
    <div data-duel-summary={playerId} className="flex flex-col gap-3.5">
      <dl className="grid grid-cols-2 gap-px border border-divider bg-divider">
        <SummaryCell label={<Trans>对位击杀</Trans>} value={formatFixed(kills, 0)} />
        <SummaryCell label={<Trans>对位死亡</Trans>} value={formatFixed(deaths, 0)} />
        <SummaryCell label={<Trans>爆头击杀</Trans>} value={formatFixed(headshots, 0)} />
        <SummaryCell label={<Trans>伤害 出 / 入</Trans>} value={`${formatFixed(dealt, 0)} / ${formatFixed(taken, 0)}`} />
      </dl>
      <section className="flex flex-col border border-divider">
        <PanelHead>
          <Trans>逐个对手</Trans>
        </PanelHead>
        {matchups.length === 0 ? (
          <p className="px-2.5 py-3 text-xs text-neutral-700">
            <Trans>这份分析没有这名选手的对位记录。</Trans>
          </p>
        ) : (
          <ul className="list-none">
            {matchups.map((matchup) => (
              <li
                key={matchup.opponent_id}
                className="flex h-[var(--h-row-compact)] items-center gap-3 border-b border-divider px-2.5 text-sm"
              >
                <span className="min-w-0 flex-1 truncate">
                  {index.get(matchup.opponent_id)?.name ?? matchup.opponent_id}
                </span>
                <span className="flex-none font-mono text-xs">
                  <Trans>
                    {matchup.kills} 杀 / {matchup.deaths} 死
                  </Trans>
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function SummaryCell({ label, value }: { readonly label: ReactNode; readonly value: string }) {
  return (
    <div className="bg-bg px-3 py-2.5">
      <dt className="text-2xs text-neutral-600">{label}</dt>
      <dd className="font-mono text-lg">{value}</dd>
    </div>
  );
}

function DuelsInspector({ demoId, context, updateContext, addToVideo, collapsed }: MatchViewProps) {
  const analysis = useMatchAnalysis(demoId === '' ? null : demoId);
  const index = useMemo(() => rosterIndex(analysis.data), [analysis.data]);

  const player = context.player === null ? undefined : index.get(context.player);

  if (player === undefined || analysis.data === undefined) {
    return (
      <MatchInspectorPanel
        title={<Trans>选中项</Trans>}
        summary={<Trans>未选中任何对位</Trans>}
        addToVideo={addToVideo}
        collapsed={collapsed}
      >
        <p className="text-sm text-neutral-700">
          <Trans>点矩阵里的一个单元格或一行，这里会显示这名选手的对位总账。</Trans>
        </p>
      </MatchInspectorPanel>
    );
  }

  return (
    <MatchInspectorPanel
      title={<Trans>选中：{player.name}</Trans>}
      summary={player.name}
      addToVideo={addToVideo}
      addLabel={<Trans>把这名选手加入视频</Trans>}
      selection={{ playerId: player.id }}
      collapsed={collapsed}
      secondaryActions={
        <>
          <Button variant="secondary" size="sm" grow onClick={() => updateContext({ view: 'replay' })}>
            <Trans>2D 回放</Trans>
          </Button>
          <Button variant="secondary" size="sm" grow onClick={() => updateContext({ view: 'players' })}>
            <Trans>单场记分板</Trans>
          </Button>
        </>
      }
    >
      <DuelSummary analysis={analysis.data} playerId={player.id} index={index} />
    </MatchInspectorPanel>
  );
}

export const DuelsView: MatchViewModule = {
  id: 'duels',
  Body: DuelsBody,
  Inspector: DuelsInspector,
};
