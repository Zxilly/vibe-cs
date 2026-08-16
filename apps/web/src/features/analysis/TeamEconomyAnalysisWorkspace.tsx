import {
  Check,
  ChevronLeft,
  ChevronRight,
  DollarSign,
  Eye,
  ListFilter,
  Map as MapIcon,
  Play,
  Plus,
  ShieldCheck,
} from 'lucide-react';
import { useMemo, useState } from 'react';

import type { AnalysisWorkspace } from '../../shared/desktop/viewModels';
import { currentLocale, useI18n } from '../../shared/i18n';
import { Badge, Button, EmptyState } from '../../shared/ui';
import type { AnalysisNavigationPatch } from './analysisNavigation';
import { teamEconomyEvidenceActionContract } from './teamEconomyEvidenceActions';
import {
  buildTeamEconomyWorkspace,
  type TeamEconomyCell,
  type TeamEconomyEvidence,
} from './teamEconomyWorkspace';
import './TeamEconomyAnalysisWorkspace.css';

const TEAM_ECONOMY_CELL_ITEM_LIMIT = 3;

export type TeamEconomyAnalysisWorkspaceProps = {
  workspace: AnalysisWorkspace;
  serviceAvailable: boolean;
  runtimeIdle: boolean;
  watchPending: boolean;
  onNavigate: (navigation: AnalysisNavigationPatch) => void;
  onWatch: (evidence: TeamEconomyEvidence) => void;
  onAddProduction: (evidence: TeamEconomyEvidence) => void;
  addedEvidenceIds?: ReadonlySet<string>;
  focusedEvidenceId?: string | null;
};

function cellKey(cell: Pick<TeamEconomyCell, 'team' | 'side'>): string {
  return `${cell.team}:${cell.side}`;
}

function decodedCost(value: number | null): string {
  return value === null ? '—' : `$${value.toLocaleString(currentLocale())}`;
}

export function TeamEconomyAnalysisWorkspace({
  workspace,
  serviceAvailable,
  runtimeIdle,
  watchPending,
  onNavigate,
  onWatch,
  onAddProduction,
  addedEvidenceIds,
  focusedEvidenceId = null,
}: TeamEconomyAnalysisWorkspaceProps) {
  const { t } = useI18n();
  const base = useMemo(
    () => buildTeamEconomyWorkspace(workspace, {
      team: null,
      side: null,
      round: null,
      page: 1,
    }),
    [workspace],
  );
  const [selectedCellKey, setSelectedCellKey] = useState<string | null>(null);
  const [selectedRound, setSelectedRound] = useState<number | null>(null);
  const [requestedPage, setRequestedPage] = useState(1);
  const [localEvidenceId, setLocalEvidenceId] = useState<string | null>(null);
  const defaultCell = base.cells.find((cell) => cell.purchase_count > 0) ?? base.cells[0] ?? null;
  const activeCell = base.cells.find((cell) => cellKey(cell) === selectedCellKey) ?? defaultCell;
  const effectiveRound = selectedRound !== null && activeCell?.rounds.includes(selectedRound)
    ? selectedRound
    : null;
  const view = useMemo(
    () => buildTeamEconomyWorkspace(workspace, {
      team: activeCell?.team ?? null,
      side: activeCell?.side ?? null,
      round: effectiveRound,
      page: requestedPage,
    }),
    [activeCell?.side, activeCell?.team, effectiveRound, requestedPage, workspace],
  );
  const selectedEvidence = view.page.items.find(
    (item) => item.evidence_id === localEvidenceId,
  ) ?? view.page.items.find((item) => item.evidence_id === focusedEvidenceId)
    ?? view.page.items[0]
    ?? null;
  const selectedEvidenceAlreadyAdded = selectedEvidence
    ? addedEvidenceIds?.has(selectedEvidence.evidence_id) ?? false
    : false;
  const selectedActions = useMemo(
    () => selectedEvidence
      ? teamEconomyEvidenceActionContract(workspace, selectedEvidence, {
          serviceAvailable,
          runtimeIdle,
          watchPending,
          alreadyAdded: selectedEvidenceAlreadyAdded,
        })
      : null,
    [
      runtimeIdle,
      selectedEvidence,
      selectedEvidenceAlreadyAdded,
      serviceAvailable,
      watchPending,
      workspace,
    ],
  );

  const selectCell = (cell: TeamEconomyCell) => {
    setSelectedCellKey(cellKey(cell));
    setSelectedRound(null);
    setRequestedPage(1);
    setLocalEvidenceId(null);
  };
  const selectRound = (round: number | null) => {
    setSelectedRound(round);
    setRequestedPage(1);
    setLocalEvidenceId(null);
  };
  const selectPage = (page: number) => {
    setRequestedPage(page);
    setLocalEvidenceId(null);
  };

  return (
    <section
      className="team-economy-workspace"
      data-testid="team-economy-workspace"
      data-page-size={view.page.page_size}
      data-total={view.page.total}
      aria-label={t('analysis.teams.economy.title')}
    >
      <header className="team-economy-toolbar">
        <div>
          <span className="eyebrow">{t('analysis.teams.economy.eyebrow')}</span>
          <h2>{t('analysis.teams.economy.title')}</h2>
          <p>{t('analysis.teams.economy.description')}</p>
        </div>
        <Badge tone={base.availability.state === 'available'
          ? 'success'
          : base.availability.state === 'partial'
            ? 'warning'
            : 'neutral'}>
          <ShieldCheck size={12} />
          {base.availability.state === 'available'
            ? t('analysis.roundContext.verified')
            : base.availability.state === 'partial'
              ? t('analysis.roundContext.partial')
              : t('analysis.roundContext.unavailable')}
        </Badge>
      </header>

      {base.availability.state !== 'unavailable' ? (
        <div className="team-economy-canvas">
          <section className="team-economy-matrix" data-testid="team-economy-matrix">
            <header>
              <span><strong>{t('analysis.teams.economy.matrix')}</strong><small>{t('analysis.teams.economy.matrixHint')}</small></span>
              <Badge tone={base.availability.state === 'partial' ? 'warning' : 'neutral'}>
                {base.availability.rejected_purchase_count > 0
                  ? `${base.availability.rejected_purchase_count} ${t('analysis.teams.economy.rejected')}`
                  : '2 × 2'}
              </Badge>
            </header>
            <div className="team-economy-matrix__grid">
              {base.cells.map((cell) => {
                const active = activeCell?.team === cell.team && activeCell.side === cell.side;
                const visibleItems = cell.items.slice(0, TEAM_ECONOMY_CELL_ITEM_LIMIT);
                const itemRemainder = cell.items.length - visibleItems.length;
                return (
                  <button
                    type="button"
                    className={`team-economy-cell team-economy-cell--${cell.side.toLocaleLowerCase()}${active ? ' is-active' : ''}`}
                    data-testid="team-economy-cell"
                    data-team={cell.team}
                    data-side={cell.side}
                    aria-pressed={active}
                    onClick={() => selectCell(cell)}
                    key={cellKey(cell)}
                  >
                    <span><strong>TEAM {cell.team}</strong><i>{cell.side}</i></span>
                    <b>{cell.purchase_count}<small>{t('analysis.teams.economy.purchases')}</small></b>
                    <span
                      data-metric="decoded-purchase-cost"
                      title={cell.cost_availability.reason ?? undefined}
                    >
                      <strong>{decodedCost(cell.decoded_purchase_cost)}</strong>
                      <small>{t('analysis.teams.economy.decodedCost')}</small>
                    </span>
                    <span
                      className="team-economy-cell__items"
                      aria-label={t('analysis.teams.economy.itemBreakdown')}
                      data-item-limit={TEAM_ECONOMY_CELL_ITEM_LIMIT}
                    >
                      {visibleItems.length > 0 ? visibleItems.map((item) => (
                        <span
                          data-testid="team-economy-cell-item"
                          data-item-name={item.name}
                          data-item-count={item.count}
                          key={item.name}
                        >
                          <strong>{item.name.toLocaleUpperCase()}</strong>
                          <small>×{item.count}</small>
                        </span>
                      )) : <span className="team-economy-cell__items-empty">—</span>}
                      {itemRemainder > 0 ? (
                        <span
                          className="team-economy-cell__items-remainder"
                          data-testid="team-economy-cell-item-remainder"
                          data-item-remainder={itemRemainder}
                        >
                          {t('analysis.teams.economy.itemRemainder').replace(
                            '{count}',
                            itemRemainder.toLocaleString(currentLocale()),
                          )}
                        </span>
                      ) : null}
                    </span>
                    <em>{cell.rounds.map((round) => `R${round}`).join(' · ') || '—'}</em>
                  </button>
                );
              })}
            </div>
          </section>

          <section className="team-economy-evidence">
            <header>
              <span><DollarSign size={14} /><strong>{t('analysis.teams.economy.atomicEvidence')}</strong></span>
              <label>
                <span>{t('analysis.teams.economy.roundFilter')}</span>
                <select
                  value={effectiveRound ?? ''}
                  onChange={(event) => selectRound(event.target.value ? Number(event.target.value) : null)}
                  data-testid="team-economy-round-filter"
                >
                  <option value="">{t('analysis.teams.economy.allRounds')}</option>
                  {activeCell?.rounds.map((round) => (
                    <option value={round} key={round}>R{round}</option>
                  ))}
                </select>
              </label>
              <Badge tone="blue">{view.page.total} {t('analysis.teams.economy.totalAtoms')}</Badge>
            </header>
            <div className="team-economy-evidence__head" aria-hidden="true">
              <span>{t('analysis.teams.economy.columnActor')}</span>
              <span>{t('analysis.teams.economy.columnItem')}</span>
              <span>{t('analysis.teams.economy.columnLocation')}</span>
              <span>{t('analysis.teams.economy.decodedCost')}</span>
            </div>
            <div className="team-economy-evidence__rows">
              {view.page.items.map((item) => {
                const active = selectedEvidence?.evidence_id === item.evidence_id;
                return (
                  <button
                    type="button"
                    className={`team-economy-evidence-row${active ? ' is-active' : ''}`}
                    data-testid="team-economy-evidence-row"
                    data-evidence-id={item.evidence_id}
                    aria-current={active ? 'true' : undefined}
                    onClick={() => setLocalEvidenceId(item.evidence_id)}
                    key={item.evidence_id}
                  >
                    <span><strong>{item.actor_name ?? '—'}</strong><small>TEAM {item.stable_team} · {item.side}</small></span>
                    <span><strong>{item.item?.toLocaleUpperCase() ?? '—'}</strong><code>{item.source_id}</code></span>
                    <span><strong>R{item.round}</strong><small>tick {item.tick}</small></span>
                    <span><strong>{decodedCost(item.cost)}</strong><small>{t('analysis.teams.economy.decodedCost')}</small></span>
                  </button>
                );
              })}
            </div>
            <footer className="team-economy-pagination" aria-label={t('analysis.teams.economy.pagination')}>
              <Button
                size="sm"
                variant="ghost"
                disabled={view.page.page <= 1}
                aria-label={t('analysis.teams.economy.previousPage')}
                onClick={() => selectPage(view.page.page - 1)}
              >
                <ChevronLeft size={13} />{t('analysis.teams.economy.previous')}
              </Button>
              <span>{t('analysis.teams.economy.page')} {view.page.page} / {Math.max(1, view.page.total_pages)}</span>
              <Button
                size="sm"
                variant="ghost"
                disabled={view.page.page >= view.page.total_pages}
                aria-label={t('analysis.teams.economy.nextPage')}
                onClick={() => selectPage(view.page.page + 1)}
              >
                {t('analysis.teams.economy.next')}<ChevronRight size={13} />
              </Button>
            </footer>
          </section>

          <aside className="team-economy-inspector" data-testid="team-economy-inspector">
            <header><span><Eye size={14} /><strong>{t('analysis.teams.economy.inspector')}</strong></span></header>
            {selectedEvidence && selectedActions ? (
              <div className="team-economy-inspector__body">
                <span className="team-economy-inspector__identity">
                  <DollarSign size={18} />
                  <strong>{selectedEvidence.item?.toLocaleUpperCase() ?? '—'}</strong>
                  <small>{selectedEvidence.actor_name ?? '—'} · TEAM {selectedEvidence.stable_team} / {selectedEvidence.side}</small>
                </span>
                <label>{t('analysis.teams.economy.canonicalEvidence')}<code>{selectedEvidence.evidence_id}</code></label>
                <dl>
                  <div><dt>{t('analysis.teams.economy.columnLocation')}</dt><dd>R{selectedEvidence.round} · TICK {selectedEvidence.tick}</dd></div>
                  <div><dt>{t('analysis.teams.economy.columnActor')}</dt><dd>{selectedEvidence.actor_name ?? '—'}</dd></div>
                  <div><dt>{t('analysis.teams.economy.decodedCost')}</dt><dd>{decodedCost(selectedEvidence.cost)}</dd></div>
                </dl>
                <div className="team-economy-inspector__actions">
                  <Button size="sm" variant="secondary" data-action="round" disabled={!selectedActions.round.available} title={selectedActions.round.reason ?? t('analysis.economy.openRound')} onClick={() => onNavigate(selectedActions.round.navigation)}><ListFilter size={12} />{t('analysis.economy.openRound')}</Button>
                  <Button size="sm" variant="secondary" data-action="replay" disabled={!selectedActions.replay.available} title={selectedActions.replay.reason ?? t('analysis.economy.openReplay')} onClick={() => onNavigate(selectedActions.replay.navigation)}><MapIcon size={12} />{t('analysis.economy.openReplay')}</Button>
                  <Button size="sm" variant="secondary" data-action="watch" disabled={!selectedActions.watch.available} title={selectedActions.watch.reason ?? t('analysis.economy.watch')} onClick={() => onWatch(selectedEvidence)}><Play size={12} />{t('analysis.economy.watch')}</Button>
                  <Button size="sm" data-action="add" disabled={!selectedActions.add.available} title={selectedActions.add.reason ?? t('analysis.economy.add')} onClick={() => onAddProduction(selectedEvidence)}>{addedEvidenceIds?.has(selectedEvidence.evidence_id) ? <Check size={12} /> : <Plus size={12} />}{t('analysis.economy.add')}</Button>
                </div>
              </div>
            ) : null}
          </aside>
        </div>
      ) : (
        <div className="team-economy-empty">
          <EmptyState
            icon={<DollarSign size={22} />}
            title={t('analysis.teams.economy.unavailable')}
            description={base.availability.reason ?? t('analysis.teams.economy.unavailableDescription')}
          />
        </div>
      )}
    </section>
  );
}
