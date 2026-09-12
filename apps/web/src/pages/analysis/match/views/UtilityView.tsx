import { t } from '@lingui/core/macro';
import { useLingui } from '@lingui/react';
import { Trans } from '@lingui/react/macro';
import { useMemo, type ReactNode } from 'react';

import { DataTable, Empty, type DataTableColumn } from '../../../../design/data';
import type { CountedItemRecord } from '../../../../shared/desktop/dto';
import type { MatchViewModule, MatchViewProps } from '../viewContract';
import { rosterIndex } from './duelsModel';
import { formatCount, formatFixed, NO_VALUE, teamNames } from './playersModel';
import {
  economyRows,
  economySide,
  ECONOMY_SIDES,
  UTILITY_ITEM_LABEL,
  utilityItemKind,
  utilityItems,
  utilityRows,
  utilityTotals,
  type EconomyRow,
  type UtilityRow,
  type UtilityItemKind,
} from './utilityModel';
import { useAnalysisGate, ViewFrame } from './viewChrome';
import { EquipmentChart } from './EquipmentChart';
import { BUY_TYPE_LABEL, equipmentRounds } from './equipmentModel';

/* ── pieces ──────────────────────────────────────────────────────────────── */

/**
 * A sub-panel head. The artboard draws it at 32px; `--h-thead` (34) is the §3.4
 * token for a header strip above rows, which is the 2px fold `DataTable` already
 * signed off on, so no bare 32 is written down.
 */
function PanelHead({ children }: { readonly children: ReactNode }) {
  return (
    <div className="flex h-[var(--h-thead)] flex-none items-center border-b border-divider px-2.5 font-heading text-xs tracking-widest text-neutral-700">
      {children}
    </div>
  );
}

/* ── the four tiles ──────────────────────────────────────────────────────── */

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
        headerLabel: t`选手`,
        hideable: false,
        truncate: true,
        cell: (row) => <span className="truncate text-base">{row.name}</span>,
      },
      {
        id: 'throws',
        header: <Trans>投出</Trans>,
        headerLabel: t`投出`,
        variant: 'numeric',
        cell: (row) => formatFixed(row.throws, 0),
      },
      {
        id: 'detonations',
        header: <Trans>生效</Trans>,
        headerLabel: t`生效`,
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
        headerLabel: t`道具伤害`,
        variant: 'numeric',
        cell: (row) => formatFixed(row.damage, 0),
      });
    }
    if (flashAvailable) {
      built.push(
        {
          id: 'flash',
          header: <Trans>致盲人次</Trans>,
          headerLabel: t`致盲人次`,
          variant: 'numeric',
          cell: (row) => formatFixed(row.flashEvents, 0),
        },
        {
          id: 'flashed',
          header: <Trans>致盲人数</Trans>,
          headerLabel: t`致盲人数`,
          variant: 'numeric',
          cell: (row) => formatFixed(row.playersFlashed, 0),
        },
        {
          id: 'blind',
          header: <Trans>致盲时长</Trans>,
          headerLabel: t`致盲时长`,
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
      headerLabel: t`投掷物构成`,
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
        headerLabel: t`回合`,
        variant: 'numeric',
        hideable: false,
        width: '72px',
        cell: (row) => formatFixed(row.round, 0),
      },
      {
        id: 'winner',
        header: <Trans>胜方</Trans>,
        headerLabel: t`胜方`,
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
      headerLabel: t`未归属`,
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

function UtilityBody({ demoId, context, updateContext }: MatchViewProps) {
  const gate = useAnalysisGate(demoId);
  const { i18n } = useLingui();
  const analysis = gate.analysis;
  const index = useMemo(() => rosterIndex(analysis), [analysis]);
  const names = useMemo(() => teamNames(analysis), [analysis]);
  const insights = analysis?.insights;
  const rows = useMemo(() => utilityRows(insights, index), [insights, index]);
  const totals = useMemo(() => utilityTotals(insights), [insights]);
  const equipment = useMemo(() => analysis === undefined ? [] : equipmentRounds(analysis), [analysis]);
  const purchases = useMemo(() => economyRows(insights, analysis?.rounds ?? []), [insights, analysis]);
  const selected = equipment.find((row) => row.round === context.round) ?? equipment[0];
  const selectedPurchases = purchases.find((row) => row.round === selected?.round);
  const selectedPlayer = rows.find((row) => row.playerId === context.player);
  const damageAvailable = insights?.availability.utility_damage.available ?? false;
  const flashAvailable = insights?.availability.flash_effects.available ?? false;
  const spendAvailable = insights?.availability.purchase_spend.available ?? false;
  const utilityAvailable = insights?.availability.utility_events.available ?? false;
  const counts = new Map<UtilityItemKind, number>();
  for (const row of rows) for (const item of row.items) {
    const kind = utilityItemKind(item.name) ?? 'other';
    counts.set(kind, (counts.get(kind) ?? 0) + item.count);
  }
  const kinds: UtilityItemKind[] = ['smoke', 'flash', 'fire', 'he', 'decoy'];
  if (counts.has('other')) kinds.push('other');
  const money = (value: number | null) => value === null ? NO_VALUE : `$${new Intl.NumberFormat(i18n.locale).format(value)}`;
  const difference = selected?.a == null || selected.b === null ? null : selected.a - selected.b;

  return <ViewFrame view="utility" state={gate.state}>
    {gate.fallback ?? <>
      <div className="grid min-w-0 grid-cols-1 items-start gap-5 xl:grid-cols-2" data-utility-overview>
        <section className="overflow-hidden rounded-lg border border-divider bg-bg" aria-label={t`道具`}>
          <h3 className="px-5 py-3 text-sm font-medium"><Trans>道具</Trans></h3>
          <dl className="divide-y divide-divider">
            {kinds.map((kind) => <div key={kind} className="flex min-h-11 items-center justify-between gap-4 px-5 py-2 text-sm">
              <dt className="text-neutral-700">{i18n._(UTILITY_ITEM_LABEL[kind])}</dt>
              <dd className="font-mono">{utilityAvailable ? <Trans>{counts.get(kind) ?? 0} 次</Trans> : NO_VALUE}</dd>
            </div>)}
          </dl>
          {damageAvailable || flashAvailable ? <dl className="flex flex-wrap gap-4 border-t border-divider px-5 py-3 text-xs">
            {damageAvailable ? <div><dt className="text-neutral-600"><Trans>道具伤害</Trans></dt><dd className="font-mono">{totals.damage}</dd></div> : null}
            {flashAvailable ? <div><dt className="text-neutral-600"><Trans>致盲人次</Trans></dt><dd className="font-mono">{totals.flashEvents}</dd></div> : null}
          </dl> : null}
        </section>
        <section className="overflow-hidden rounded-lg border border-divider bg-bg" aria-label={t`回合经济`}>
          <h3 className="px-5 py-3 text-sm font-medium"><Trans>回合经济</Trans></h3>
          {selected === undefined ? <Empty title={<Trans>没有回合记录</Trans>} actions={null} /> : <>
            <EquipmentChart rounds={equipment} activeRound={selected.round} teamA={names.A} teamB={names.B}
              onSelect={(round) => updateContext({ round, player: null })} />
            <div className="flex items-center justify-between gap-4 border-t border-divider px-5 py-3 text-xs">
              <span>R{selected.round} · {selected.winner === null ? t`胜方未知` : t`${names[selected.winner]} 胜`}</span>
              <span>{names.A} / {names.B}</span>
            </div>
            <dl className="divide-y divide-divider border-t border-divider text-sm">
              <div className="flex justify-between gap-4 px-5 py-3"><dt><Trans>装备价值</Trans></dt><dd className="font-mono">{money(selected.a)} / {money(selected.b)}</dd></div>
              <div className="flex justify-between gap-4 px-5 py-3"><dt><Trans>购买类型</Trans></dt><dd>{selected.aBuyType === null ? NO_VALUE : i18n._(BUY_TYPE_LABEL[selected.aBuyType])} / {selected.bBuyType === null ? NO_VALUE : i18n._(BUY_TYPE_LABEL[selected.bBuyType])}</dd></div>
              <div className="flex justify-between gap-4 px-5 py-3"><dt><Trans>装备差额</Trans></dt><dd>{difference === null ? NO_VALUE : difference === 0 ? t`持平` : `${difference > 0 ? names.A : names.B} +${money(Math.abs(difference))}`}</dd></div>
            </dl>
          </>}
        </section>
      </div>
      <details className="rounded-lg border border-divider" open={context.player !== null}>
        <summary className="cursor-pointer px-4 py-3 text-sm font-medium"><Trans>选手道具明细</Trans></summary>
        <UtilityTable rows={rows} activePlayerId={context.player} onSelect={(player) => updateContext({ player })} damageAvailable={damageAvailable} flashAvailable={flashAvailable} />
        {selectedPlayer === undefined ? null : <div className="border-t border-divider p-4"><PlayerUtilityDetail row={selectedPlayer} damageAvailable={damageAvailable} flashAvailable={flashAvailable} /></div>}
      </details>
      <details className="rounded-lg border border-divider">
        <summary className="cursor-pointer px-4 py-3 text-sm font-medium"><Trans>购买明细</Trans></summary>
        <EconomyTable rows={purchases} teamAName={names.A} teamBName={names.B} activeRound={selected?.round ?? null} onSelect={(round) => updateContext({ round, player: null })} spendAvailable={spendAvailable} />
        {selectedPurchases === undefined ? null : <div className="border-t border-divider p-4"><RoundEconomyDetail row={selectedPurchases} spendAvailable={spendAvailable} /></div>}
      </details>
    </>}
  </ViewFrame>;
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
      <dt className="text-xs text-neutral-600">{label}</dt>
      <dd className="font-mono text-lg">{value}</dd>
    </div>
  );
}

export const UtilityView: MatchViewModule = { id: 'utility', Body: UtilityBody };
