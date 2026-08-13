import {
  Check,
  Eye,
  ListFilter,
  Map as MapIcon,
  Play,
  Plus,
  ShieldAlert,
  Target,
  Trophy,
} from 'lucide-react';
import { useMemo, useState } from 'react';

import type { AnalysisWorkspace } from '../../shared/desktop/dto';
import { useI18n } from '../../shared/i18n';
import { Badge, Button, EmptyState } from '../../shared/ui';
import type { AnalysisNavigationPatch } from './analysisNavigation';
import { clutchReviewActionContract } from './clutchReviewActions';
import {
  buildClutchReviewWorkspace,
  type ClutchOutcome,
  type ClutchReviewEvidence,
  type ClutchReviewFilter,
} from './clutchReviewWorkspace';
import './ClutchReviewAnalysisWorkspace.css';

export type ClutchReviewAnalysisWorkspaceProps = {
  workspace: AnalysisWorkspace;
  serviceAvailable: boolean;
  runtimeIdle: boolean;
  watchPending: boolean;
  onNavigate: (navigation: AnalysisNavigationPatch) => void;
  onWatch: (evidence: ClutchReviewEvidence) => void;
  onAddProduction: (evidence: ClutchReviewEvidence) => void;
  addedEvidenceIds?: ReadonlySet<string>;
  focusedEvidenceId?: string | null;
};

const emptyFilter: ClutchReviewFilter = {
  outcome: null,
  opponent_count: null,
  player_id: null,
};

function outcomeTone(outcome: ClutchOutcome): 'success' | 'danger' {
  return outcome === 'won' ? 'success' : 'danger';
}

export function ClutchReviewAnalysisWorkspace({
  workspace,
  serviceAvailable,
  runtimeIdle,
  watchPending,
  onNavigate,
  onWatch,
  onAddProduction,
  addedEvidenceIds,
  focusedEvidenceId = null,
}: ClutchReviewAnalysisWorkspaceProps) {
  const { t } = useI18n();
  const [filter, setFilter] = useState<ClutchReviewFilter>(emptyFilter);
  const [selectedEvidenceId, setSelectedEvidenceId] = useState<string | null>(null);
  const base = useMemo(
    () => buildClutchReviewWorkspace(workspace, emptyFilter),
    [workspace],
  );
  const view = useMemo(
    () => buildClutchReviewWorkspace(workspace, filter),
    [filter, workspace],
  );
  const availablePlayers = useMemo(() => {
    const ids = new Set(base.evidence.map((item) => item.player_id));
    return workspace.players.filter((player) => ids.has(player.id));
  }, [base.evidence, workspace.players]);
  const selectedEvidence = view.evidence.find((item) => item.evidence_id === selectedEvidenceId)
    ?? view.evidence.find((item) => item.evidence_id === focusedEvidenceId)
    ?? view.evidence[0]
    ?? null;
  const selectedActions = selectedEvidence
    ? clutchReviewActionContract(workspace, selectedEvidence, {
        serviceAvailable,
        runtimeIdle,
        watchPending,
        alreadyAdded: addedEvidenceIds?.has(selectedEvidence.evidence_id) ?? false,
      })
    : null;

  return (
    <section
      className="clutch-review-workspace"
      data-testid="clutch-review-workspace"
      aria-label={t('analysis.clutches.title')}
    >
      <header className="clutch-review-toolbar">
        <div>
          <span className="eyebrow">{t('analysis.clutches.eyebrow')}</span>
          <h2>{t('analysis.clutches.title')}</h2>
          <p>{t('analysis.clutches.description')}</p>
        </div>
        <Badge tone={base.availability.state === 'available' ? 'success' : 'warning'}>
          {base.availability.state === 'available' ? <Trophy size={12} /> : <ShieldAlert size={12} />}
          {base.availability.state === 'available'
            ? t('analysis.clutches.canonical')
            : t('analysis.clutches.failClosed')}
        </Badge>
      </header>

      <div className="clutch-review-summary" data-testid="clutch-review-summary">
        <span><small>{t('analysis.clutches.opportunities')}</small><strong>{base.summary.opportunities}</strong></span>
        <span><small>{t('analysis.clutches.wins')}</small><strong>{base.summary.wins}</strong></span>
        <span><small>{t('analysis.clutches.attempts')}</small><strong>{base.summary.attempts}</strong></span>
        <span><small>{t('analysis.clutches.rejected')}</small><strong>{base.summary.rejected}</strong></span>
      </div>

      {base.availability.state === 'unavailable' ? (
        <div className="clutch-review-unavailable">
          <EmptyState
            icon={<ShieldAlert size={22} />}
            title={t('analysis.clutches.unavailable')}
            description={base.availability.reason ?? t('analysis.clutches.description')}
          />
        </div>
      ) : (
        <>
          {base.availability.state === 'partial' ? (
            <p className="clutch-review-warning" role="status">{base.availability.reason}</p>
          ) : null}

          <div className="clutch-review-filters">
            <label>
              <span>{t('analysis.clutches.outcome')}</span>
              <select
                data-testid="clutch-review-filter-outcome"
                value={filter.outcome ?? ''}
                onChange={(event) => setFilter((current) => ({
                  ...current,
                  outcome: event.target.value ? event.target.value as ClutchOutcome : null,
                }))}
              >
                <option value="">{t('analysis.clutches.allOutcomes')}</option>
                <option value="won">{t('analysis.clutches.won')}</option>
                <option value="attempt">{t('analysis.clutches.lost')}</option>
              </select>
            </label>
            <label>
              <span>{t('analysis.clutches.scenario')}</span>
              <select
                data-testid="clutch-review-filter-opponents"
                value={filter.opponent_count ?? ''}
                onChange={(event) => setFilter((current) => ({
                  ...current,
                  opponent_count: event.target.value ? Number(event.target.value) : null,
                }))}
              >
                <option value="">{t('analysis.clutches.allScenarios')}</option>
                {[2, 3, 4, 5].map((count) => <option value={count} key={count}>1v{count}</option>)}
              </select>
            </label>
            <label>
              <span>{t('analysis.clutches.player')}</span>
              <select
                data-testid="clutch-review-filter-player"
                value={filter.player_id ?? ''}
                onChange={(event) => setFilter((current) => ({
                  ...current,
                  player_id: event.target.value || null,
                }))}
              >
                <option value="">{t('analysis.clutches.allPlayers')}</option>
                {availablePlayers.map((player) => (
                  <option value={player.id} key={player.id}>{player.name}</option>
                ))}
              </select>
            </label>
            <Button size="sm" variant="ghost" onClick={() => setFilter(emptyFilter)}>
              {t('analysis.clutches.reset')}
            </Button>
          </div>

          <div className="clutch-review-canvas">
            <section className="clutch-review-evidence" data-testid="clutch-review-evidence">
              <header>
                <div><Target size={14} /><strong>{t('analysis.clutches.atomicEvidence')}</strong></div>
                <Badge tone="blue">{view.evidence.length}</Badge>
              </header>
              <div className="clutch-review-evidence__head" aria-hidden="true">
                <span>{t('analysis.clutches.result')}</span>
                <span>{t('analysis.clutches.player')}</span>
                <span>{t('analysis.clutches.scenario')}</span>
                <span>{t('analysis.clutches.roundTick')}</span>
                <span>{t('analysis.clutches.eliminations')}</span>
              </div>
              <div className="clutch-review-evidence__rows">
                {view.evidence.length > 0 ? view.evidence.map((item) => {
                  const active = selectedEvidence?.evidence_id === item.evidence_id;
                  return (
                    <button
                      type="button"
                      className={`clutch-review-evidence-row${active ? ' is-active' : ''}`}
                      data-testid="clutch-review-evidence-row"
                      data-evidence-id={item.evidence_id}
                      aria-current={active ? 'true' : undefined}
                      onClick={() => setSelectedEvidenceId(item.evidence_id)}
                      key={item.evidence_id}
                    >
                      <Badge tone={outcomeTone(item.outcome)}>
                        {item.outcome === 'won' ? t('analysis.clutches.won') : t('analysis.clutches.lost')}
                      </Badge>
                      <span><strong>{item.player_name}</strong><small>{item.survived ? t('analysis.clutches.survived') : t('analysis.clutches.eliminated')}</small></span>
                      <strong>1v{item.opponent_count}</strong>
                      <span><strong>R{item.round}</strong><small>tick {item.tick}</small></span>
                      <span><strong>{item.eliminations}</strong><small>{item.victim_names.join(' · ') || '—'}</small></span>
                    </button>
                  );
                }) : (
                  <EmptyState
                    icon={<Target size={20} />}
                    title={t('analysis.clutches.noEvidence')}
                    description={t('analysis.clutches.noEvidenceDescription')}
                  />
                )}
              </div>
            </section>

            <aside className="clutch-review-inspector" data-testid="clutch-review-inspector">
              <header><Eye size={14} /><strong>{t('analysis.clutches.inspector')}</strong></header>
              {selectedEvidence && selectedActions ? (
                <>
                  <div className="clutch-review-inspector__body">
                    <span className="eyebrow">{t('analysis.clutches.selectedEvidence')}</span>
                    <h3>{selectedEvidence.player_name} · 1v{selectedEvidence.opponent_count}</h3>
                    <p>{selectedEvidence.outcome === 'won' ? t('analysis.clutches.won') : t('analysis.clutches.lost')} · R{selectedEvidence.round}</p>
                    <dl>
                      <div><dt>{t('analysis.clutches.eliminations')}</dt><dd>{selectedEvidence.eliminations}</dd></div>
                      <div><dt>{t('analysis.clutches.survival')}</dt><dd>{selectedEvidence.survived ? t('analysis.clutches.survived') : t('analysis.clutches.eliminated')}</dd></div>
                      <div><dt>{t('analysis.clutches.clipRange')}</dt><dd>{selectedEvidence.tick}–{selectedEvidence.end_tick}</dd></div>
                    </dl>
                    <div><span>{t('analysis.clutches.victims')}</span><strong>{selectedEvidence.victim_names.join(' · ') || '—'}</strong></div>
                    <div><span>{t('analysis.clutches.canonicalEvidence')}</span><code>{selectedEvidence.evidence_id}</code></div>
                  </div>
                  <footer>
                    <Button size="sm" variant="ghost" data-action="round" disabled={!selectedActions.round.available} title={selectedActions.round.reason ?? t('analysis.clutches.openRound')} onClick={() => onNavigate(selectedActions.round.navigation)}><ListFilter size={12} /><span>{t('analysis.clutches.openRound')}</span></Button>
                    <Button size="sm" variant="ghost" data-action="replay" disabled={!selectedActions.replay.available} title={selectedActions.replay.reason ?? t('analysis.clutches.openReplay')} onClick={() => onNavigate(selectedActions.replay.navigation)}><MapIcon size={12} /><span>{t('analysis.clutches.openReplay')}</span></Button>
                    <Button size="sm" variant="ghost" data-action="watch" disabled={!selectedActions.watch.available} title={selectedActions.watch.reason ?? t('analysis.clutches.watch')} onClick={() => onWatch(selectedEvidence)}><Play size={12} /><span>{t('analysis.clutches.watch')}</span></Button>
                    <Button size="sm" variant="ghost" data-action="add" disabled={!selectedActions.add.available} title={selectedActions.add.reason ?? t('analysis.clutches.add')} onClick={() => onAddProduction(selectedEvidence)}>{addedEvidenceIds?.has(selectedEvidence.evidence_id) ? <Check size={12} /> : <Plus size={12} />}<span>{t('analysis.clutches.add')}</span></Button>
                  </footer>
                </>
              ) : null}
            </aside>
          </div>
        </>
      )}
    </section>
  );
}
