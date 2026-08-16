import {
  Check,
  Eye,
  ListFilter,
  Map as MapIcon,
  Play,
  Plus,
  Target,
} from 'lucide-react';
import { useMemo, useState } from 'react';

import type { AnalysisWorkspace } from '../../shared/desktop/viewModels';
import { currentLocale, useI18n } from '../../shared/i18n';
import { Badge, Button, EmptyState } from '../../shared/ui';
import type { AnalysisNavigationPatch } from './analysisNavigation';
import { economyEvidenceActionContract } from './economyEvidenceActions';
import {
  buildEconomyEvidenceWorkspace,
  type EconomyAtomicEvidence,
  type EconomyMetricAvailability,
  type EconomyRoundRow,
  type EconomySideAggregate,
} from './economyEvidenceWorkspace';
import './EconomyAnalysisWorkspace.css';

export type EconomyAnalysisWorkspaceProps = {
  workspace: AnalysisWorkspace;
  selectedPlayerId?: string | null;
  selectedRound?: number | null;
  serviceAvailable: boolean;
  runtimeIdle: boolean;
  watchPending: boolean;
  onNavigate: (navigation: AnalysisNavigationPatch) => void;
  onWatch: (evidence: EconomyAtomicEvidence) => void;
  onAddProduction: (evidence: EconomyAtomicEvidence) => void;
  addedEvidenceIds?: ReadonlySet<string>;
  focusedEvidenceId?: string | null;
};

function availabilityTone(state: EconomyMetricAvailability['state']) {
  if (state === 'available') return 'success' as const;
  if (state === 'partial') return 'warning' as const;
  return 'neutral' as const;
}

function availabilityLabel(state: EconomyMetricAvailability['state']): 'analysis.roundContext.verified' | 'analysis.roundContext.partial' | 'analysis.roundContext.unavailable' {
  if (state === 'available') return 'analysis.roundContext.verified';
  if (state === 'partial') return 'analysis.roundContext.partial';
  return 'analysis.roundContext.unavailable';
}

function money(value: number | null): string {
  return value === null ? '—' : `$${value.toLocaleString(currentLocale())}`;
}

function itemSummary(side: EconomySideAggregate): string {
  if (side.items.length === 0) return '—';
  return side.items
    .map((item) => `${item.name.replace(/^weapon_/iu, '').toLocaleUpperCase()} ×${item.count}`)
    .join(' · ');
}

function SideAggregateCell({ value }: { value: EconomySideAggregate }) {
  const { t } = useI18n();
  return (
    <span
      className={`economy-analysis-side economy-analysis-side--${value.side.toLocaleLowerCase()}`}
      data-aggregate-scope={value.aggregate_scope}
      title={value.purchase_availability.reason ?? value.spend_availability.reason ?? undefined}
    >
      <i>{value.side}</i>
      <strong>{value.purchase_count}</strong>
      <small>{t('analysis.economy.purchases')} · {money(value.spend)}</small>
      <em>{itemSummary(value)}</em>
    </span>
  );
}

function capabilityName(key: 'equipment_value' | 'economy_type' | 'advantage' | 'money_snapshot') {
  if (key === 'equipment_value') return 'analysis.economy.equipmentValue' as const;
  if (key === 'economy_type') return 'analysis.economy.economyType' as const;
  if (key === 'advantage') return 'analysis.economy.advantage' as const;
  return 'analysis.economy.moneySnapshot' as const;
}

export function EconomyAnalysisWorkspace({
  workspace,
  selectedPlayerId = null,
  selectedRound = null,
  serviceAvailable,
  runtimeIdle,
  watchPending,
  onNavigate,
  onWatch,
  onAddProduction,
  addedEvidenceIds,
  focusedEvidenceId = null,
}: EconomyAnalysisWorkspaceProps) {
  const { t } = useI18n();
  const evidenceWorkspace = useMemo(
    () => buildEconomyEvidenceWorkspace(workspace, {
      playerId: selectedPlayerId,
      round: selectedRound,
    }),
    [workspace, selectedPlayerId, selectedRound],
  );
  const focusedRound = evidenceWorkspace.evidence.find(
    (item) => item.evidence_id === focusedEvidenceId,
  )?.round ?? null;
  const [selectedRowRound, setSelectedRowRound] = useState<number | null>(
    focusedRound ?? selectedRound ?? evidenceWorkspace.rows[0]?.round ?? null,
  );
  const selectedRow = evidenceWorkspace.rows.find((row) => row.round === selectedRowRound)
    ?? evidenceWorkspace.rows[0]
    ?? null;
  const selectedEvidence = selectedRow
    ? evidenceWorkspace.evidence.filter((item) => item.round === selectedRow.round)
    : [];
  const unavailableMetrics = [
    ['equipment_value', 'equipment-value'],
    ['economy_type', 'economy-type'],
    ['advantage', 'advantage'],
    ['money_snapshot', 'money-snapshot'],
  ] as const;

  return (
    <section
      className="economy-analysis-workspace"
      data-testid="economy-evidence-workspace"
      aria-label={t('analysis.economy.title')}
    >
      <header className="economy-analysis-toolbar">
        <div className="economy-analysis-toolbar__title">
          <span className="eyebrow">{t('analysis.economy.eyebrow')}</span>
          <h2>{t('analysis.economy.title')}</h2>
          <p>{t('analysis.economy.description')}</p>
        </div>
        <div className="economy-analysis-filters">
          <label>
            <span>{t('analysis.economy.playerFilter')}</span>
            <select
              data-testid="economy-filter-player"
              value={selectedPlayerId ?? ''}
              onChange={(event) => onNavigate({
                playerId: event.target.value || null,
                tick: null,
                evidenceId: null,
              })}
            >
              <option value="">{t('analysis.economy.allPlayers')}</option>
              {workspace.players.map((player) => (
                <option value={player.id} key={player.id}>{player.name}</option>
              ))}
            </select>
          </label>
          <label>
            <span>{t('analysis.economy.roundFilter')}</span>
            <select
              data-testid="economy-filter-round"
              value={selectedRound ?? ''}
              onChange={(event) => onNavigate({
                round: event.target.value ? Number(event.target.value) : null,
                tick: null,
                evidenceId: null,
              })}
            >
              <option value="">{t('analysis.economy.allRounds')}</option>
              {workspace.rounds.map((round) => (
                <option value={round.number} key={round.number}>R{round.number}</option>
              ))}
            </select>
          </label>
        </div>
      </header>

      <div className="economy-analysis-capabilities">
        {unavailableMetrics.map(([key, dataKey]) => {
          const availability = evidenceWorkspace.availability[key];
          return (
            <div
              key={key}
              data-capability={dataKey}
              data-state={availability.state}
              title={availability.reason ?? undefined}
            >
              <span>{t(capabilityName(key))}</span>
              <small>{availability.reason}</small>
              <Badge tone={availabilityTone(availability.state)}>
                {t(availabilityLabel(availability.state))}
              </Badge>
            </div>
          );
        })}
      </div>

      {evidenceWorkspace.rows.length > 0 ? (
        <div className="economy-analysis-canvas">
          <section className="economy-analysis-table" aria-label={t('analysis.economy.roundSideContext')}>
            <header>
              <span><strong>{t('analysis.economy.roundSideContext')}</strong><small>{selectedPlayerId ? t('analysis.economy.playerContextHint') : t('analysis.economy.aggregateScope')}</small></span>
              <Badge tone={availabilityTone(evidenceWorkspace.availability.purchases.state)}>
                {evidenceWorkspace.evidence.length} {t('analysis.economy.atomicEvents')}
              </Badge>
            </header>
            <div className="economy-analysis-table__head" role="row">
              <span>{t('analysis.economy.round')}</span>
              <span>T · {t('analysis.economy.purchases')} / {t('analysis.economy.spend')} / {t('analysis.economy.items')}</span>
              <span>CT · {t('analysis.economy.purchases')} / {t('analysis.economy.spend')} / {t('analysis.economy.items')}</span>
              <span>{t('analysis.economy.atomicEvents')}</span>
              <span>{t('analysis.economy.unattributed')}</span>
            </div>
            <div className="economy-analysis-table__rows" role="rowgroup">
              {evidenceWorkspace.rows.map((row: EconomyRoundRow) => {
                const focused = selectedRow?.round === row.round;
                return (
                  <button
                    type="button"
                    className={`economy-analysis-round-row${focused ? ' is-focused' : ''}`}
                    data-testid="economy-round-row"
                    aria-current={focused ? 'true' : undefined}
                    onClick={() => setSelectedRowRound(row.round)}
                    key={row.id}
                  >
                    <span className="economy-analysis-round"><strong>R{row.round}</strong><small>{row.sides.T.summary_source === 'insights' || row.sides.CT.summary_source === 'insights' ? t('analysis.economy.insightsSource') : t('analysis.economy.eventsSource')}</small></span>
                    <SideAggregateCell value={row.sides.T} />
                    <SideAggregateCell value={row.sides.CT} />
                    <span className="economy-analysis-count"><strong>{row.matching_atomic_count}</strong><small>{t('analysis.economy.atomicEvents')}</small></span>
                    <span className={`economy-analysis-count${row.unattributed_purchase_count > 0 ? ' is-partial' : ''}`}><strong>{row.unattributed_purchase_count}</strong><small>{t('analysis.economy.unattributed')}</small></span>
                  </button>
                );
              })}
            </div>
          </section>

          <aside className="economy-analysis-inspector" data-testid="economy-evidence-inspector">
            <header>
              <span><Eye size={15} /><strong>{t('analysis.economy.inspector')}</strong></span>
              {selectedRow ? <Badge tone="blue">R{selectedRow.round} · {selectedEvidence.length}</Badge> : null}
            </header>
            {selectedRow ? (
              <div className="economy-analysis-inspector__body">
                <div className="economy-analysis-inspector__context">
                  <span className="eyebrow">{t('analysis.economy.aggregateScope')}</span>
                  <div><SideAggregateCell value={selectedRow.sides.T} /><SideAggregateCell value={selectedRow.sides.CT} /></div>
                  <small>{t('analysis.economy.playerContextHint')}</small>
                </div>
                <div className="economy-analysis-purchases">
                  <header><strong>{t('analysis.economy.atomicEvidence')}</strong><span>{selectedEvidence.length}</span></header>
                  <div className="economy-analysis-purchases__rows">
                    {selectedEvidence.map((item) => {
                      const added = addedEvidenceIds?.has(item.evidence_id) ?? false;
                      const actions = economyEvidenceActionContract(workspace, item, {
                        serviceAvailable,
                        runtimeIdle,
                        watchPending,
                        alreadyAdded: added,
                      });
                      return (
                        <article
                          className="economy-analysis-purchase-row"
                          data-testid="economy-purchase-row"
                          data-evidence-id={item.evidence_id}
                          key={item.evidence_id}
                        >
                          <span className={`economy-analysis-purchase-side economy-analysis-purchase-side--${item.side?.toLocaleLowerCase() ?? 'unknown'}`}><i>{item.side ?? '?'}</i><small>{item.side ? t('analysis.economy.side') : t('analysis.economy.unknownSide')}</small></span>
                          <span className="economy-analysis-purchase-identity"><strong>{item.actor_name ?? '—'} · {item.item?.toLocaleUpperCase() ?? '—'}</strong><code>{item.evidence_id}</code></span>
                          <span className="economy-analysis-purchase-location"><strong>R{item.round} · {item.tick}</strong><small>{money(item.cost)}</small></span>
                          <span className="economy-analysis-actions">
                            <Button size="sm" variant="ghost" data-action="round" disabled={!actions.round.available} title={actions.round.reason ?? t('analysis.economy.openRound')} onClick={() => onNavigate(actions.round.navigation)}><ListFilter size={12} /><span>{t('analysis.economy.openRound')}</span></Button>
                            <Button size="sm" variant="ghost" data-action="replay" disabled={!actions.replay.available} title={actions.replay.reason ?? t('analysis.economy.openReplay')} onClick={() => onNavigate(actions.replay.navigation)}><MapIcon size={12} /><span>{t('analysis.economy.openReplay')}</span></Button>
                            <Button size="sm" variant="ghost" data-action="watch" disabled={!actions.watch.available} title={actions.watch.reason ?? t('analysis.economy.watch')} onClick={() => onWatch(item)}><Play size={12} /><span>{t('analysis.economy.watch')}</span></Button>
                            <Button size="sm" variant="ghost" data-action="add" disabled={!actions.add.available} title={actions.add.reason ?? t('analysis.economy.add')} onClick={() => onAddProduction(item)}>{added ? <Check size={12} /> : <Plus size={12} />}<span>{t('analysis.economy.add')}</span></Button>
                          </span>
                        </article>
                      );
                    })}
                  </div>
                </div>
              </div>
            ) : null}
          </aside>
        </div>
      ) : (
        <div className="economy-analysis-empty">
          <EmptyState
            icon={<Target size={22} />}
            title={t('analysis.economy.noEvidence')}
            description={t('analysis.economy.noEvidenceDescription')}
          />
        </div>
      )}
    </section>
  );
}
