/*
 * pages/match/views — 道具与经济 (`?view=utility`).
 *
 * 「补齐 · 比赛工作区子视图 · 道具与经济」, whose caption is the whole design
 * brief: 「不完整的投掷物生命周期会明确降级」. The segmented control swaps between
 * two different records — per-player utility and per-round economy — and the
 * four tiles at the top belong to the first of them.
 *
 * ── What was drawn and is not here, and why ───────────────────────────────
 *
 *   · **The 投掷物查找 table's 结果 column** (「致盲 2 人 · 3.1s」, 「封 A 大道」).
 *     It needs a link from one throw to its own detonation and blind events;
 *     the wire has no grenade entity id and `TimelineEvent.detail` is `unknown`,
 *     so the link cannot be made without guessing which smoke was whose. The
 *     per-player totals below state the same facts at the granularity the data
 *     actually supports, and the per-throw table is reported as a gap.
 *   · **The equipment-value bar chart.** `spend` is the cost of decoded
 *     purchases, not the value carried into the round, and it is `null` the
 *     moment one price is missing. Drawing purchases as equipment value would
 *     relabel a number instead of showing one — and 枪局胜率 / 经济劣势翻盘 both
 *     classify rounds using that same missing value.
 *
 * What *is* here and is not decoration: 「生命周期不完整」 is `throws −
 * detonations`, which is exactly the artboard's dashed tile — the service counts
 * a throw and an activation separately (`crates/domain/src/insights.rs`), so a
 * demo whose grenade lifecycle did not decode leaves the first without the
 * second. See `utilityModel.ts`.
 *
 * ── Density ───────────────────────────────────────────────────────────────
 *
 * 道具 is at most `MATCH_ROSTER_SIZE` rows. 经济 is one row per round, bounded
 * by `LONG_OVERTIME_ROUNDS` (58); both scroll inside `DataTable`'s own scroller
 * and the header prints the total, so nothing is silently cut.
 */

import { t } from '@lingui/core/macro';
import { useLingui } from '@lingui/react';
import { Trans } from '@lingui/react/macro';
import { useMemo, useState, type ReactNode } from 'react';

import { useMatchAnalysis } from '../../../data/match';
import { DataTable, EmptyState, type DataTableColumn } from '../../../design/data';
import { Button, Seg } from '../../../design/primitives';
import type { CountedItemRecord } from '../../../shared/desktop/dto';
import { MatchInspectorPanel } from '../MatchInspectorPanel';
import type { MatchViewModule, MatchViewProps } from '../viewContract';
import { rosterIndex, type RosterEntry } from './duelsModel';
import { formatCount, formatFixed, NO_VALUE, teamNames } from './playersModel';
import {
  capabilityReason,
  economyRows,
  economyPurchaseTotal,
  economySide,
  ECONOMY_SIDES,
  UTILITY_ITEM_LABEL,
  utilityItemKind,
  utilityItems,
  utilityRows,
  utilityTotals,
  type EconomyRow,
  type UtilityRow,
  type UtilityTotals,
} from './utilityModel';
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

/* ── the four tiles ──────────────────────────────────────────────────────── */

export interface UtilityTilesProps {
  readonly totals: UtilityTotals;
  /** `false` greys the damage tile's number out — the events did not decode. */
  readonly damageAvailable: boolean;
  readonly flashAvailable: boolean;
}

/**
 * 投掷物 · 道具伤害 · 致盲人次 · 生命周期不完整.
 *
 * The third tile is the artboard's 「有效闪」 renamed to what the field is:
 * `flash_events` counts `player_blind` events attributed to a thrower, which is
 * blinded-player-instances, not a judgement about whether the flash was useful.
 * The fourth carries the artboard's dashed border because it is the degradation
 * marker, not a metric anyone wants to be high.
 */
export function UtilityTiles({ totals, damageAvailable, flashAvailable }: UtilityTilesProps) {
  return (
    <div data-utility-tiles="" className="flex flex-none flex-wrap gap-3">
      <Tile label={<Trans>投掷物</Trans>} value={formatCount(totals.throws)} />
      <Tile
        label={<Trans>道具伤害</Trans>}
        value={damageAvailable ? formatCount(totals.damage) : NO_VALUE}
      />
      <Tile
        label={<Trans>致盲人次</Trans>}
        value={flashAvailable ? formatCount(totals.flashEvents) : NO_VALUE}
      />
      <Tile
        label={<Trans>生命周期不完整</Trans>}
        value={formatCount(totals.incompleteLifecycle)}
        degraded
      />
    </div>
  );
}

function Tile({
  label,
  value,
  degraded = false,
}: {
  readonly label: ReactNode;
  readonly value: string;
  readonly degraded?: boolean | undefined;
}) {
  return (
    <div
      className={
        degraded
          ? 'min-w-0 flex-1 border border-dashed border-neutral-400 px-3 py-2.5'
          : 'min-w-0 flex-1 border border-divider px-3 py-2.5'
      }
    >
      <div className="text-2xs text-neutral-600">{label}</div>
      <div className={degraded ? 'font-mono text-lg text-neutral-600' : 'font-mono text-lg'}>
        {value}
      </div>
    </div>
  );
}

/* ── the 道具 table ──────────────────────────────────────────────────────── */

export interface UtilityTableProps {
  readonly rows: readonly UtilityRow[];
  readonly activePlayerId: string | null;
  readonly onSelect: (playerId: string) => void;
  readonly damageAvailable: boolean;
  readonly flashAvailable: boolean;
}

/** One row per player who has a utility record. Exported for the markup tests. */
export function UtilityTable({
  rows,
  activePlayerId,
  onSelect,
  damageAvailable,
  flashAvailable,
}: UtilityTableProps) {
  const { i18n } = useLingui();

  const columns = useMemo<readonly DataTableColumn<UtilityRow>[]>(() => {
    const built: DataTableColumn<UtilityRow>[] = [
      {
        id: 'player',
        header: <Trans>选手</Trans>,
        headerLabel: '选手',
        hideable: false,
        truncate: true,
        cell: (row) => <span className="truncate text-base">{row.name}</span>,
      },
      {
        id: 'throws',
        header: <Trans>投出</Trans>,
        headerLabel: '投出',
        variant: 'numeric',
        cell: (row) => formatFixed(row.throws, 0),
      },
      {
        id: 'detonations',
        header: <Trans>生效</Trans>,
        headerLabel: '生效',
        variant: 'numeric',
        cell: (row) => formatFixed(row.detonations, 0),
      },
    ];

    /* Both blocks are gated on the service's own capability flags. A zero from
       「没有解出这类事件」 and a zero from 「他真的没造成伤害」 are different
       statements, and only the second one belongs in a cell. */
    if (damageAvailable) {
      built.push({
        id: 'damage',
        header: <Trans>道具伤害</Trans>,
        headerLabel: '道具伤害',
        variant: 'numeric',
        cell: (row) => formatFixed(row.damage, 0),
      });
    }
    if (flashAvailable) {
      built.push(
        {
          id: 'flash',
          header: <Trans>致盲人次</Trans>,
          headerLabel: '致盲人次',
          variant: 'numeric',
          cell: (row) => formatFixed(row.flashEvents, 0),
        },
        {
          id: 'flashed',
          header: <Trans>致盲人数</Trans>,
          headerLabel: '致盲人数',
          variant: 'numeric',
          cell: (row) => formatFixed(row.playersFlashed, 0),
        },
        {
          id: 'blind',
          header: <Trans>致盲时长</Trans>,
          headerLabel: '致盲时长',
          variant: 'numeric',
          /* `null` when one decoded blind event omitted its duration — the wire
             says so explicitly, so the dash is the service's own answer. */
          cell: (row) =>
            row.flashDurationSeconds === null ? NO_VALUE : `${formatFixed(row.flashDurationSeconds, 1)}s`,
        },
      );
    }

    built.push({
      id: 'items',
      header: <Trans>投掷物构成</Trans>,
      headerLabel: '投掷物构成',
      truncate: true,
      cell: (row) => <ItemSummary items={row.items} label={(key) => i18n._(UTILITY_ITEM_LABEL[key])} />,
    });

    return built;
  }, [damageAvailable, flashAvailable, i18n]);

  return (
    <DataTable
      /* The panel already draws the rule; the cap keeps both axes of the
         scroll inside the table's own container (§10.3). */
      className="max-h-96"
      caption={<Trans>每名选手的道具使用</Trans>}
      columns={columns}
      rows={rows}
      rowId={(row) => row.playerId}
      rowLabel={(row) => row.name}
      activeRowId={activePlayerId}
      onRowActivate={(rowId) => onSelect(rowId)}
    />
  );
}

/** 「闪光 6 · 烟雾 4 · 高爆 3」 — an unrecognised name keeps its raw spelling. */
function ItemSummary({
  items,
  label,
}: {
  readonly items: readonly CountedItemRecord[];
  readonly label: (key: keyof typeof UTILITY_ITEM_LABEL) => string;
}) {
  if (items.length === 0) return <span className="text-neutral-500">{NO_VALUE}</span>;
  return (
    <span className="truncate">
      {items
        .map((item) => {
          const kind = utilityItemKind(item.name);
          const name = kind === null ? item.name : label(kind);
          return `${name} ${String(item.count)}`;
        })
        .join(' · ')}
    </span>
  );
}

/* ── the 经济 table ──────────────────────────────────────────────────────── */

export interface EconomyTableProps {
  readonly rows: readonly EconomyRow[];
  readonly teamAName: string;
  readonly teamBName: string;
  readonly activeRound: number | null;
  readonly onSelect: (round: number) => void;
  /** `false` prints the dash in the 花费 columns instead of a partial sum. */
  readonly spendAvailable: boolean;
}

/**
 * Per round, per *side*.
 *
 * 「CT」/「T」 are sides and not teams: sides swap at the half, and the only
 * side-to-team fact the wire carries (`TeamSummary.side`) describes now, not
 * round 3. The winner column is a team because the analysis states that one
 * directly.
 */
export function EconomyTable({
  rows,
  teamAName,
  teamBName,
  activeRound,
  onSelect,
  spendAvailable,
}: EconomyTableProps) {
  const columns = useMemo<readonly DataTableColumn<EconomyRow>[]>(() => {
    const built: DataTableColumn<EconomyRow>[] = [
      {
        id: 'round',
        header: <Trans>回合</Trans>,
        headerLabel: '回合',
        variant: 'numeric',
        hideable: false,
        width: '72px',
        cell: (row) => formatFixed(row.round, 0),
      },
      {
        id: 'winner',
        header: <Trans>胜方</Trans>,
        headerLabel: '胜方',
        truncate: true,
        cell: (row) => {
          if (row.winner === null) return NO_VALUE;
          const name = row.winner === 'A' ? teamAName : teamBName;
          return name === '' ? NO_VALUE : name;
        },
      },
    ];

    for (const side of ECONOMY_SIDES) {
      built.push({
        id: `${side}-purchases`,
        header: <Trans>{side} 购买</Trans>,
        headerLabel: `${side} 购买`,
        variant: 'numeric',
        cell: (row) => formatFixed(economySide(row, side)?.purchaseCount ?? null, 0),
      });
      if (spendAvailable) {
        built.push({
          id: `${side}-spend`,
          header: <Trans>{side} 花费</Trans>,
          headerLabel: `${side} 花费`,
          variant: 'numeric',
          cell: (row) => {
            const spend = economySide(row, side)?.spend ?? null;
            return spend === null ? NO_VALUE : formatCount(spend);
          },
        });
      }
    }

    built.push({
      id: 'unattributed',
      header: <Trans>未归属</Trans>,
      headerLabel: '未归属',
      variant: 'numeric',
      /* The service counts purchases whose event carried no side. Printed
         rather than folded into a side, because folding would invent an owner. */
      cell: (row) => formatFixed(row.unattributed, 0),
    });

    return built;
  }, [teamAName, teamBName, spendAvailable]);

  return (
    <DataTable
      /* The panel already draws the rule; the cap keeps both axes of the
         scroll inside the table's own container (§10.3). */
      className="max-h-96"
      caption={<Trans>每个回合的购买记录</Trans>}
      columns={columns}
      rows={rows}
      rowId={(row) => String(row.round)}
      rowLabel={(row) => `R${String(row.round)}`}
      activeRowId={activeRound === null ? null : String(activeRound)}
      onRowActivate={(_rowId, row) => onSelect(row.round)}
    />
  );
}

/* ── the body ────────────────────────────────────────────────────────────── */

type UtilityMode = 'utility' | 'economy';

function UtilityBody({ demoId, context, updateContext }: MatchViewProps) {
  const gate = useAnalysisGate(demoId);
  const [mode, setMode] = useState<UtilityMode>('utility');

  const index = useMemo(() => rosterIndex(gate.analysis), [gate.analysis]);
  const names = useMemo(() => teamNames(gate.analysis), [gate.analysis]);
  const insights = gate.analysis?.insights;
  const rounds = gate.analysis?.rounds ?? [];
  const totals = useMemo(() => utilityTotals(insights), [insights]);
  const rows = useMemo(() => utilityRows(insights, index), [insights, index]);
  const economy = useMemo(() => economyRows(insights, rounds), [insights, rounds]);

  const damageAvailable = insights?.availability.utility_damage.available ?? false;
  const flashAvailable = insights?.availability.flash_effects.available ?? false;
  const spendAvailable = insights?.availability.purchase_spend.available ?? false;
  const purchaseTotal = economyPurchaseTotal(economy);

  /* The service's own English sentence for whichever half is on screen. */
  const degraded =
    mode === 'utility'
      ? capabilityReason(insights?.availability.utility_events)
      : capabilityReason(insights?.availability.purchase_events);

  return (
    <ViewFrame view="utility" state={gate.state}>
      <ViewPanel
        id="utility"
        title={<Trans>道具与经济</Trans>}
        hint={
          gate.analysis === undefined ? undefined : mode === 'utility' ? (
            <Trans>共 {rows.length} 名选手有道具记录 · 点一行看他的构成</Trans>
          ) : (
            <Trans>共 {economy.length} 个回合 · 解出 {purchaseTotal} 条购买事件</Trans>
          )
        }
        actions={
          <Seg
            name="match-utility-mode"
            value={mode}
            onChange={setMode}
            aria-label={t`道具与经济视图`}
            options={[
              { value: 'utility', label: <Trans>道具</Trans> },
              { value: 'economy', label: <Trans>经济</Trans> },
            ]}
          />
        }
      >
        {gate.fallback ??
          (mode === 'utility' ? (
            <div className="flex flex-col gap-3 p-3.5">
              <UtilityTiles
                totals={totals}
                damageAvailable={damageAvailable}
                flashAvailable={flashAvailable}
              />
              {rows.length === 0 ? (
                <EmptyState
                  headingLevel={4}
                  title={<Trans>没有道具记录</Trans>}
                  description={
                    <Trans>
                      这份分析没有解出投掷物的生命周期事件，所以逐选手的道具账目是空的。
                    </Trans>
                  }
                  actions={
                    <Button variant="secondary" onClick={() => setMode('economy')}>
                      <Trans>改看经济</Trans>
                    </Button>
                  }
                />
              ) : (
                <UtilityTable
                  rows={rows}
                  activePlayerId={context.player}
                  onSelect={(playerId) => updateContext({ player: playerId })}
                  damageAvailable={damageAvailable}
                  flashAvailable={flashAvailable}
                />
              )}
            </div>
          ) : economy.length === 0 ? (
            <EmptyState
              className="m-3.5"
              headingLevel={4}
              title={<Trans>没有购买记录</Trans>}
              description={<Trans>这份分析没有解出物品购买事件，所以每回合的经济账目是空的。</Trans>}
              actions={
                <Button variant="secondary" onClick={() => setMode('utility')}>
                  <Trans>改看道具</Trans>
                </Button>
              }
            />
          ) : (
            <div className="flex flex-col gap-3 p-3.5">
              {spendAvailable ? null : (
                <p className="text-xs text-neutral-600">
                  {/* 花费 is dropped rather than summed from the purchases that
                      did carry a price — a partial sum looks like a total. */}
                  <Trans>有购买事件没有带价格，因此不列花费，只列购买条数。</Trans>
                </p>
              )}
              <EconomyTable
                rows={economy}
                teamAName={names.A}
                teamBName={names.B}
                activeRound={context.round}
                onSelect={(round) => updateContext({ round })}
                spendAvailable={spendAvailable}
              />
            </div>
          ))}

        {gate.fallback !== null || degraded === null ? null : (
          <p className="border-t border-divider px-3.5 py-2.5 text-2xs text-neutral-600">
            {/* The service's own English sentence, verbatim, so a bug report can
                quote the reason the block above is degraded. */}
            <Trans>服务端说明：{degraded}</Trans>
          </p>
        )}
      </ViewPanel>

      <SelectedRoundLine round={context.round} />
    </ViewFrame>
  );
}

/* ── the Inspector ───────────────────────────────────────────────────────── */

export interface PlayerUtilityDetailProps {
  readonly row: UtilityRow;
  readonly damageAvailable: boolean;
  readonly flashAvailable: boolean;
}

/** One player's utility account: the counted items, then the measured effects. */
export function PlayerUtilityDetail({
  row,
  damageAvailable,
  flashAvailable,
}: PlayerUtilityDetailProps) {
  const { i18n } = useLingui();
  const items = utilityItems(row);
  const most = items.reduce((maximum, item) => Math.max(maximum, item.count), 0);

  return (
    <div data-utility-detail={row.playerId} className="flex flex-col gap-3.5">
      <dl className="grid grid-cols-2 gap-px border border-divider bg-divider">
        <DetailCell label={<Trans>投出</Trans>} value={formatFixed(row.throws, 0)} />
        <DetailCell label={<Trans>生效</Trans>} value={formatFixed(row.detonations, 0)} />
        {damageAvailable ? (
          <DetailCell label={<Trans>道具伤害</Trans>} value={formatFixed(row.damage, 0)} />
        ) : null}
        {flashAvailable ? (
          <DetailCell label={<Trans>致盲人次</Trans>} value={formatFixed(row.flashEvents, 0)} />
        ) : null}
      </dl>

      <section className="border border-divider">
        <PanelHead>
          <Trans>投掷物构成</Trans>
        </PanelHead>
        {items.length === 0 ? (
          <p className="px-2.5 py-3 text-xs text-neutral-700">
            <Trans>这一场没有记到他投出的道具。</Trans>
          </p>
        ) : (
          <ul className="flex list-none flex-col gap-2.5 p-2.5 text-sm">
            {items.map((item) => {
              const kind = utilityItemKind(item.name);
              const share = most <= 0 ? 0 : Math.round((item.count / most) * 100);
              return (
                <li key={item.name}>
                  <div className="mb-1 flex items-baseline justify-between gap-2">
                    <span className="min-w-0 truncate">
                      {kind === null ? item.name : i18n._(UTILITY_ITEM_LABEL[kind])}
                    </span>
                    <span className="flex-none font-mono text-xs">{formatFixed(item.count, 0)}</span>
                  </div>
                  {/* Redundant with the count beside it; a computed width, so an
                      inline style rather than a Tailwind arbitrary value. */}
                  <div aria-hidden="true" className="h-2 bg-neutral-200">
                    <div className="h-2 bg-accent" style={{ width: `${String(share)}%` }} />
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}

export interface RoundEconomyDetailProps {
  readonly row: EconomyRow;
  readonly spendAvailable: boolean;
}

/** One round's purchases, by side. */
export function RoundEconomyDetail({ row, spendAvailable }: RoundEconomyDetailProps) {
  return (
    <div data-economy-detail={row.round} className="flex flex-col gap-3.5">
      {row.sides.map((side) => (
        <section key={side.side} className="border border-divider">
          <PanelHead>{side.side}</PanelHead>
          <dl className="grid grid-cols-2 gap-px bg-divider">
            <DetailCell label={<Trans>购买条数</Trans>} value={formatFixed(side.purchaseCount, 0)} />
            {spendAvailable ? (
              <DetailCell
                label={<Trans>花费</Trans>}
                value={side.spend === null ? NO_VALUE : formatCount(side.spend)}
              />
            ) : null}
          </dl>
          {side.items.length === 0 ? null : (
            <p className="px-2.5 py-2.5 text-xs text-neutral-700">
              {side.items.map((item) => `${item.name} ${String(item.count)}`).join(' · ')}
            </p>
          )}
        </section>
      ))}
      {row.unattributed === 0 ? null : (
        <p className="text-xs text-neutral-600">
          <Trans>还有 {row.unattributed} 条购买事件没有带阵营，无法归属到任何一方。</Trans>
        </p>
      )}
    </div>
  );
}

function DetailCell({ label, value }: { readonly label: ReactNode; readonly value: string }) {
  return (
    <div className="bg-bg px-3 py-2.5">
      <dt className="text-2xs text-neutral-600">{label}</dt>
      <dd className="font-mono text-lg">{value}</dd>
    </div>
  );
}

function UtilityInspector({ demoId, context, updateContext, addToVideo, collapsed }: MatchViewProps) {
  const analysis = useMatchAnalysis(demoId === '' ? null : demoId);
  const index = useMemo(() => rosterIndex(analysis.data), [analysis.data]);
  const insights = analysis.data?.insights;
  const rows = useMemo(() => utilityRows(insights, index), [insights, index]);
  const economy = useMemo(
    () => economyRows(insights, analysis.data?.rounds ?? []),
    [insights, analysis.data],
  );

  const damageAvailable = insights?.availability.utility_damage.available ?? false;
  const flashAvailable = insights?.availability.flash_effects.available ?? false;
  const spendAvailable = insights?.availability.purchase_spend.available ?? false;

  const player: RosterEntry | undefined = context.player === null ? undefined : index.get(context.player);
  const utilityRow = context.player === null ? undefined : rows.find((row) => row.playerId === context.player);
  const economyRow = context.round === null ? undefined : economy.find((row) => row.round === context.round);

  if (utilityRow !== undefined) {
    return (
      <MatchInspectorPanel
        title={<Trans>选中：{player?.name ?? utilityRow.name}</Trans>}
        summary={<Trans>{utilityRow.name} · 投出 {utilityRow.throws}</Trans>}
        addToVideo={addToVideo}
        addLabel={<Trans>把这名选手加入视频</Trans>}
        selection={{ playerId: utilityRow.playerId }}
        collapsed={collapsed}
        secondaryActions={
          <Button variant="secondary" size="sm" grow onClick={() => updateContext({ view: 'players' })}>
            <Trans>单场记分板</Trans>
          </Button>
        }
      >
        <PlayerUtilityDetail
          row={utilityRow}
          damageAvailable={damageAvailable}
          flashAvailable={flashAvailable}
        />
      </MatchInspectorPanel>
    );
  }

  if (economyRow !== undefined) {
    return (
      <MatchInspectorPanel
        title={<Trans>选中：第 {economyRow.round} 回合</Trans>}
        summary={<Trans>第 {economyRow.round} 回合的购买</Trans>}
        addToVideo={addToVideo}
        addLabel={<Trans>把这个回合加入视频</Trans>}
        selection={{ round: economyRow.round }}
        collapsed={collapsed}
        secondaryActions={
          <Button variant="secondary" size="sm" grow onClick={() => updateContext({ view: 'rounds' })}>
            <Trans>逐回合复盘</Trans>
          </Button>
        }
      >
        <RoundEconomyDetail row={economyRow} spendAvailable={spendAvailable} />
      </MatchInspectorPanel>
    );
  }

  return (
    <MatchInspectorPanel
      title={<Trans>选中项</Trans>}
      summary={<Trans>未选中任何选手或回合</Trans>}
      addToVideo={addToVideo}
      collapsed={collapsed}
    >
      <p className="text-sm text-neutral-700">
        <Trans>点道具表的一行看这名选手的投掷物构成，点经济表的一行看这个回合的购买。</Trans>
      </p>
    </MatchInspectorPanel>
  );
}

export const UtilityView: MatchViewModule = {
  id: 'utility',
  Body: UtilityBody,
  Inspector: UtilityInspector,
};
