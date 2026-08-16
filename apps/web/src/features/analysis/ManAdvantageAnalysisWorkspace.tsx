import {
  Activity,
  Check,
  Eye,
  Grid3X3,
  ListFilter,
  Map as MapIcon,
  PanelRightOpen,
  Play,
  Plus,
  ShieldAlert,
} from 'lucide-react';
import { useMemo, useState } from 'react';

import type { AnalysisWorkspace } from '../../shared/desktop/viewModels';
import { useI18n } from '../../shared/i18n';
import { Badge, Button, Drawer, EmptyState } from '../../shared/ui';
import type { AnalysisNavigationPatch } from './analysisNavigation';
import { manAdvantageEvidenceActionContract } from './manAdvantageEvidenceActions';
import {
  buildManAdvantageWorkspace,
  type ManAdvantageDeathEvidence,
  type ManAdvantageRoundFailureCode,
  type ManAdvantageTransition,
} from './manAdvantageWorkspace';
import './ManAdvantageAnalysisWorkspace.css';

export type ManAdvantageAnalysisWorkspaceProps = {
  workspace: AnalysisWorkspace;
  selectedRound: number;
  serviceAvailable: boolean;
  runtimeIdle: boolean;
  watchPending: boolean;
  onNavigate: (navigation: AnalysisNavigationPatch) => void;
  onWatch: (evidence: ManAdvantageDeathEvidence) => void;
  onAddProduction: (evidence: ManAdvantageDeathEvidence) => void;
  addedEvidenceIds?: ReadonlySet<string>;
  focusedEvidenceId?: string | null;
};

const reasonKeys: Record<ManAdvantageRoundFailureCode, Parameters<ReturnType<typeof useI18n>['t']>[0]> = {
  unknown_round_winner: 'analysis.advantage.reason.unknownWinner',
  missing_round_end: 'analysis.advantage.reason.missingRoundEnd',
  ambiguous_round_end: 'analysis.advantage.reason.ambiguousRoundEnd',
  kill_outside_round_bounds: 'analysis.advantage.reason.outsideBounds',
  missing_target: 'analysis.advantage.reason.missingTarget',
  unknown_target: 'analysis.advantage.reason.unknownTarget',
  unknown_actor: 'analysis.advantage.reason.unknownActor',
  duplicate_target_same_tick: 'analysis.advantage.reason.duplicateSameTick',
  target_already_eliminated: 'analysis.advantage.reason.repeatedTarget',
  duplicate_event_id: 'analysis.advantage.reason.duplicateEventId',
};

function countState(transition: ManAdvantageTransition, side: 'before' | 'after'): string {
  const count = side === 'before' ? transition.remaining_before : transition.remaining_after;
  return `${count.A}v${count.B}`;
}

export function ManAdvantageAnalysisWorkspace({
  workspace,
  selectedRound,
  serviceAvailable,
  runtimeIdle,
  watchPending,
  onNavigate,
  onWatch,
  onAddProduction,
  addedEvidenceIds,
  focusedEvidenceId = null,
}: ManAdvantageAnalysisWorkspaceProps) {
  const { t } = useI18n();
  const [selectedEvidenceId, setSelectedEvidenceId] = useState<string | null>(null);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const model = useMemo(() => buildManAdvantageWorkspace(workspace), [workspace]);
  const activeRound = model.rounds.find((round) => round.round === selectedRound)
    ?? model.rounds[0]
    ?? null;
  const roundDeaths = activeRound?.transitions.flatMap((transition) => transition.deaths) ?? [];
  const locallySelectedEvidence = roundDeaths.find(
    (death) => death.evidence_id === selectedEvidenceId,
  ) ?? null;
  const focusedEvidence = roundDeaths.find(
    (death) => death.evidence_id === focusedEvidenceId,
  ) ?? null;
  const selectedEvidence = locallySelectedEvidence
    ?? (focusedEvidenceId === null ? roundDeaths[0] ?? null : focusedEvidence);
  const selectedTransition = selectedEvidence
    ? activeRound?.transitions.find((transition) => transition.deaths.some(
        (death) => death.evidence_id === selectedEvidence.evidence_id,
      )) ?? null
    : null;
  const selectedActions = useMemo(() => selectedEvidence
    ? manAdvantageEvidenceActionContract(workspace, selectedEvidence, {
        serviceAvailable,
        runtimeIdle,
        watchPending,
        alreadyAdded: addedEvidenceIds?.has(selectedEvidence.evidence_id) ?? false,
      })
    : null, [
    addedEvidenceIds,
    runtimeIdle,
    selectedEvidence,
    serviceAvailable,
    watchPending,
    workspace,
  ]);

  const actionButtons = selectedEvidence && selectedActions ? (
    <div className="man-advantage-actions">
      <Button
        size="sm"
        variant="ghost"
        data-action="round"
        disabled={!selectedActions.round.available}
        title={selectedActions.round.reason ?? t('analysis.advantage.openRound')}
        onClick={() => onNavigate(selectedActions.round.navigation)}
      >
        <ListFilter size={12} /><span>{t('analysis.advantage.openRound')}</span>
      </Button>
      <Button
        size="sm"
        variant="ghost"
        data-action="replay"
        disabled={!selectedActions.replay.available}
        title={selectedActions.replay.reason ?? t('analysis.advantage.openReplay')}
        onClick={() => onNavigate(selectedActions.replay.navigation)}
      >
        <MapIcon size={12} /><span>{t('analysis.advantage.openReplay')}</span>
      </Button>
      <Button
        size="sm"
        variant="ghost"
        data-action="watch"
        disabled={!selectedActions.watch.available}
        title={selectedActions.watch.reason ?? t('analysis.advantage.watch')}
        onClick={() => onWatch(selectedEvidence)}
      >
        <Play size={12} /><span>{t('analysis.advantage.watch')}</span>
      </Button>
      <Button
        size="sm"
        variant="ghost"
        data-action="add"
        disabled={!selectedActions.add.available}
        title={selectedActions.add.reason ?? t('analysis.advantage.add')}
        onClick={() => onAddProduction(selectedEvidence)}
      >
        {addedEvidenceIds?.has(selectedEvidence.evidence_id)
          ? <Check size={12} />
          : <Plus size={12} />}
        <span>{t('analysis.advantage.add')}</span>
      </Button>
    </div>
  ) : null;

  const inspectorBody = selectedEvidence && selectedTransition ? (
    <div className="man-advantage-inspector__body">
      <span className="eyebrow">{t('analysis.advantage.selectedEvidence')}</span>
      <h3>
        {selectedEvidence.actor_name ?? t('analysis.advantage.killerUnavailable')}
        {' → '}{selectedEvidence.target_name}
      </h3>
      <p>R{selectedEvidence.round} · tick {selectedEvidence.tick}</p>
      <dl>
        <div>
          <dt>{t('analysis.advantage.remainingBefore')}</dt>
          <dd>A {selectedTransition.remaining_before.A} · B {selectedTransition.remaining_before.B}</dd>
        </div>
        <div>
          <dt>{t('analysis.advantage.remainingAfter')}</dt>
          <dd>A {selectedTransition.remaining_after.A} · B {selectedTransition.remaining_after.B}</dd>
        </div>
        <div>
          <dt>{t('analysis.advantage.relation')}</dt>
          <dd>{selectedEvidence.elimination_relation === 'opponent'
            ? t('analysis.advantage.opponent')
            : selectedEvidence.elimination_relation === 'same_team'
              ? t('analysis.advantage.teamKill')
              : t('analysis.advantage.unattributed')}</dd>
        </div>
        <div>
          <dt>{t('analysis.advantage.weapon')}</dt>
          <dd>{selectedEvidence.weapon ?? '—'}</dd>
        </div>
        <div>
          <dt>{t('analysis.advantage.sameTickDeaths')}</dt>
          <dd>{selectedTransition.deaths.length}</dd>
        </div>
        <div>
          <dt>{t('analysis.advantage.eventFlags')}</dt>
          <dd>{[
            selectedEvidence.headshot ? t('analysis.advantage.headshot') : null,
            selectedEvidence.penetrated ? t('analysis.advantage.penetrated') : null,
          ].filter(Boolean).join(' · ') || t('analysis.advantage.noFlags')}</dd>
        </div>
        <div>
          <dt>{t('analysis.advantage.position')}</dt>
          <dd>{selectedEvidence.position?.join(', ') ?? '—'}</dd>
        </div>
      </dl>
      <div>
        <span>{t('analysis.advantage.sourceEvent')}</span>
        <strong>{selectedEvidence.source_id}</strong>
      </div>
      <div>
        <span>{t('analysis.advantage.canonicalEvidence')}</span>
        <code>{selectedEvidence.evidence_id}</code>
      </div>
      <div>
        <span>{t('analysis.advantage.roundEndEvidence')}</span>
        <code>{activeRound?.round_end_evidence_id ?? '—'}</code>
      </div>
    </div>
  ) : (
    <EmptyState
      icon={<Activity size={20} />}
      title={focusedEvidenceId
        ? t('analysis.advantage.focusUnavailable')
        : t('analysis.advantage.noDeaths')}
      description={focusedEvidenceId
        ? t('analysis.advantage.focusUnavailableDescription')
        : t('analysis.advantage.noDeathsDescription')}
    />
  );

  return (
    <section
      className="man-advantage-workspace"
      data-testid="man-advantage-workspace"
      data-verified-rounds={`${model.summary.verified_rounds}/${model.summary.total_rounds}`}
      aria-label={t('analysis.advantage.title')}
    >
      <header className="man-advantage-toolbar">
        <div>
          <span className="eyebrow">{t('analysis.advantage.eyebrow')}</span>
          <h2>{t('analysis.advantage.title')}</h2>
          <p>{t('analysis.advantage.description')}</p>
        </div>
        <Badge
          tone={model.availability.state === 'available' ? 'success' : 'warning'}
          className="man-advantage-availability"
        >
          <span data-testid="man-advantage-availability">
          {model.availability.state === 'available'
            ? t('analysis.advantage.canonical')
            : t('analysis.advantage.failClosed')}
          {' · '}{model.summary.verified_rounds}/{model.summary.total_rounds}
          </span>
        </Badge>
      </header>

      {model.availability.state === 'unavailable' && model.rounds.length === 0 ? (
        <div className="man-advantage-unavailable">
          <EmptyState
            icon={<ShieldAlert size={22} />}
            title={t('analysis.advantage.unavailable')}
            description={model.availability.reason ?? t('analysis.advantage.description')}
          />
        </div>
      ) : (
        <>
          <section className="man-advantage-matrix" aria-labelledby="man-advantage-matrix-title">
            <header>
              <div>
                <Grid3X3 size={14} />
                <strong id="man-advantage-matrix-title">{t('analysis.advantage.matrix')}</strong>
              </div>
              <span>{t('analysis.advantage.truthNote')}</span>
            </header>
            <div className="man-advantage-matrix__grid">
              <span className="man-advantage-matrix__corner">
                {t('analysis.advantage.firstLead')} ↓ / {t('analysis.advantage.finalWinner')} →
              </span>
              <strong>Team A</strong>
              <strong>Team B</strong>
              {(['A', 'B'] as const).map((firstLeadTeam) => (
                <div className="man-advantage-matrix__row" key={firstLeadTeam}>
                  <strong>Team {firstLeadTeam}</strong>
                  {(['A', 'B'] as const).map((winner) => {
                    const cell = model.matrix.find((candidate) => (
                      candidate.first_lead_team === firstLeadTeam && candidate.winner === winner
                    ));
                    const firstRound = cell?.rounds[0] ?? null;
                    return (
                      <button
                        type="button"
                        data-testid="man-advantage-matrix-cell"
                        data-first-lead={firstLeadTeam}
                        data-winner={winner}
                        aria-label={`${t('analysis.advantage.firstLead')} Team ${firstLeadTeam}, ${t('analysis.advantage.finalWinner')} Team ${winner}, ${cell?.round_count ?? 0} ${t('analysis.advantage.rounds')}`}
                        disabled={firstRound === null}
                        onClick={() => firstRound !== null && onNavigate({
                          round: firstRound,
                          tick: null,
                          evidenceId: null,
                        })}
                        key={`${firstLeadTeam}:${winner}`}
                      >
                        <strong>{cell?.round_count ?? 0}</strong>
                        <small>{t('analysis.advantage.rounds')}</small>
                      </button>
                    );
                  })}
                </div>
              ))}
            </div>
            <div className="man-advantage-summary">
              <span><small>{t('analysis.advantage.verifiedRounds')}</small><strong>{model.summary.verified_rounds}/{model.summary.total_rounds}</strong></span>
              <span><small>{t('analysis.advantage.firstLeadWon')}</small><strong>{model.summary.first_lead_won}</strong></span>
              <span><small>{t('analysis.advantage.firstLeadLost')}</small><strong>{model.summary.first_lead_lost}</strong></span>
              <span><small>{t('analysis.advantage.noLeadRounds')}</small><strong>{model.summary.no_lead_rounds}</strong></span>
              <span><small>{t('analysis.advantage.leadChangeRounds')}</small><strong>{model.summary.lead_change_rounds}</strong></span>
            </div>
          </section>

          <div className="man-advantage-canvas">
            <nav className="man-advantage-rounds" aria-label={t('analysis.advantage.roundNavigator')}>
              <header>
                <strong>{t('analysis.advantage.rounds')}</strong>
                <Badge tone={model.summary.unavailable_rounds > 0 ? 'warning' : 'blue'}>
                  {model.summary.unavailable_rounds} {t('analysis.advantage.unavailableRounds')}
                </Badge>
              </header>
              <div className="man-advantage-rounds__list">
                {model.rounds.map((round) => (
                  <button
                    type="button"
                    className={round.round === activeRound?.round ? 'is-active' : undefined}
                    data-testid="man-advantage-round"
                    data-state={round.state}
                    aria-current={round.round === activeRound?.round ? 'true' : undefined}
                    onClick={() => onNavigate({ round: round.round, tick: null, evidenceId: null })}
                    key={round.round}
                  >
                    <strong>R{round.round}</strong>
                    <small>{round.state === 'available'
                      ? `${t('analysis.advantage.winner')} ${round.winner}`
                      : t('analysis.advantage.unavailable')}</small>
                  </button>
                ))}
              </div>
            </nav>

            <section className="man-advantage-stream" data-testid="man-advantage-stream">
              <header>
                <div><Activity size={14} /><strong>{t('analysis.advantage.stream')}</strong></div>
                <Button
                  className="man-advantage-inspector-trigger"
                  size="sm"
                  variant="ghost"
                  disabled={!selectedEvidence}
                  onClick={() => setInspectorOpen(true)}
                >
                  <PanelRightOpen size={13} />{t('analysis.advantage.inspector')}
                </Button>
              </header>
              {activeRound?.state === 'unavailable' ? (
                <EmptyState
                  icon={<ShieldAlert size={20} />}
                  title={t('analysis.advantage.roundUnavailable')}
                  description={activeRound.reason_code
                    ? t(reasonKeys[activeRound.reason_code])
                    : t('analysis.advantage.unavailable')}
                />
              ) : activeRound && activeRound.transitions.length > 0 ? (
                <div className="man-advantage-stream__rows">
                  {activeRound.transitions.map((transition) => (
                    <article
                      className="man-advantage-transition"
                      data-testid="man-advantage-transition"
                      data-tick={transition.tick}
                      aria-label={`${t('analysis.advantage.round')} ${transition.round}, tick ${transition.tick}, ${countState(transition, 'before')} → ${countState(transition, 'after')}, ${transition.deaths.length} ${t('analysis.advantage.deaths')}`}
                      key={transition.key}
                    >
                      <header>
                        <time>tick {transition.tick}</time>
                        <strong>{countState(transition, 'before')} <span>→</span> {countState(transition, 'after')}</strong>
                        <Badge tone={transition.leading_team_after ? 'accent' : 'neutral'}>
                          {transition.leading_team_after
                            ? `${t('analysis.advantage.lead')} ${transition.leading_team_after}`
                            : t('analysis.advantage.tied')}
                        </Badge>
                      </header>
                      <div>
                        {transition.deaths.map((death) => (
                          <button
                            type="button"
                            className={selectedEvidence?.evidence_id === death.evidence_id ? 'is-active' : undefined}
                            data-testid="man-advantage-death"
                            data-evidence-id={death.evidence_id}
                            aria-current={selectedEvidence?.evidence_id === death.evidence_id ? 'true' : undefined}
                            onClick={() => setSelectedEvidenceId(death.evidence_id)}
                            key={death.evidence_id}
                          >
                            <span>{death.actor_name ?? t('analysis.advantage.killerUnavailable')}</span>
                            <strong>→ {death.target_name}</strong>
                            <small>{death.elimination_relation === 'same_team'
                              ? t('analysis.advantage.teamKill')
                              : death.elimination_relation === 'unattributed'
                                ? t('analysis.advantage.unattributed')
                                : death.weapon ?? '—'}</small>
                          </button>
                        ))}
                      </div>
                    </article>
                  ))}
                </div>
              ) : (
                <EmptyState
                  icon={<Activity size={20} />}
                  title={t('analysis.advantage.noDeaths')}
                  description={t('analysis.advantage.noDeathsDescription')}
                />
              )}
            </section>

            <aside className="man-advantage-inspector" data-testid="man-advantage-inspector">
              <header><Eye size={14} /><strong>{t('analysis.advantage.inspector')}</strong></header>
              {inspectorBody}
              <footer>{actionButtons}</footer>
            </aside>
          </div>

          <Drawer
            open={inspectorOpen}
            title={t('analysis.advantage.inspector')}
            description={t('analysis.advantage.inspectorDescription')}
            onClose={() => setInspectorOpen(false)}
            footer={actionButtons}
          >
            {inspectorBody}
          </Drawer>
        </>
      )}
    </section>
  );
}
