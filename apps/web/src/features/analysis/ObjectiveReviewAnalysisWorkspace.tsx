import {
  Check,
  CircleDot,
  Eye,
  ListFilter,
  Map as MapIcon,
  PanelRightOpen,
  Play,
  Plus,
  ShieldAlert,
} from 'lucide-react';
import { useMemo, useState } from 'react';

import type { AnalysisWorkspace } from '../../shared/desktop/dto';
import { useI18n } from '../../shared/i18n';
import { Badge, Button, Drawer, EmptyState } from '../../shared/ui';
import type { AnalysisNavigationPatch } from './analysisNavigation';
import { objectiveReviewEvidenceActionContract } from './objectiveReviewEvidenceActions';
import {
  buildObjectiveReviewWorkspace,
  type ObjectiveReviewAtom,
  type ObjectiveReviewAtomKind,
} from './objectiveReviewWorkspace';
import './ObjectiveReviewAnalysisWorkspace.css';

export type ObjectiveReviewAnalysisWorkspaceProps = {
  workspace: AnalysisWorkspace;
  selectedRound: number;
  serviceAvailable: boolean;
  runtimeIdle: boolean;
  watchPending: boolean;
  onNavigate: (navigation: AnalysisNavigationPatch) => void;
  onWatch: (evidence: ObjectiveReviewAtom) => void;
  onAddProduction: (evidence: ObjectiveReviewAtom) => void;
  addedEvidenceIds?: ReadonlySet<string>;
  focusedEvidenceId?: string | null;
};

const atomLabelKeys = {
  plant: 'analysis.objective.plant',
  kill: 'analysis.objective.kill',
  damage: 'analysis.objective.damageAtom',
  defuse: 'analysis.objective.defuse',
  explode: 'analysis.objective.explode',
  round_end: 'analysis.objective.roundEnd',
} as const satisfies Record<ObjectiveReviewAtomKind, Parameters<ReturnType<typeof useI18n>['t']>[0]>;

export function ObjectiveReviewAnalysisWorkspace({
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
}: ObjectiveReviewAnalysisWorkspaceProps) {
  const { t } = useI18n();
  const [selectedEvidenceId, setSelectedEvidenceId] = useState<string | null>(null);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const model = useMemo(() => buildObjectiveReviewWorkspace(workspace), [workspace]);
  const activeRound = model.rounds.find((round) => round.round === selectedRound) ?? null;
  const roundAtoms = activeRound?.timeline_groups.flatMap((group) => group.atoms) ?? [];
  const localSelection = roundAtoms.find((atom) => atom.evidence_id === selectedEvidenceId) ?? null;
  const focusedSelection = roundAtoms.find((atom) => atom.evidence_id === focusedEvidenceId) ?? null;
  const selectedEvidence = localSelection
    ?? (focusedEvidenceId === null ? roundAtoms[0] ?? null : focusedSelection);
  const selectedGroup = selectedEvidence
    ? activeRound?.timeline_groups.find((group) => group.atomic_event_ids.includes(
        selectedEvidence.source_id,
      )) ?? null
    : null;
  const selectedActions = useMemo(() => selectedEvidence
    ? objectiveReviewEvidenceActionContract(workspace, selectedEvidence, {
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
  const selectedRoundHasNoPlant = model.rounds.length > 0 && activeRound === null;

  const actionButtons = selectedEvidence && selectedActions ? (
    <div
      className="objective-review-actions"
      data-selected-evidence-id={selectedEvidence.evidence_id}
    >
      <Button
        size="sm"
        variant="ghost"
        data-action="round"
        data-action-evidence-id={selectedEvidence.evidence_id}
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
        data-action-evidence-id={selectedEvidence.evidence_id}
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
        data-action-evidence-id={selectedEvidence.evidence_id}
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
        data-action-evidence-id={selectedEvidence.evidence_id}
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

  const inspectorBody = selectedEvidence && selectedGroup ? (
    <div className="objective-review-inspector__body">
      <span className="eyebrow">{t('analysis.objective.selectedEvidence')}</span>
      <h3>{t(atomLabelKeys[selectedEvidence.kind])} · tick {selectedEvidence.tick}</h3>
      <p>
        {selectedEvidence.actor_name ?? t('analysis.objective.actorUnavailable')}
        {selectedEvidence.actor_team && selectedEvidence.actor_side
          ? ` · Team ${selectedEvidence.actor_team} · ${selectedEvidence.actor_side}`
          : ''}
      </p>
      <dl>
        <div>
          <dt>{t('analysis.objective.actor')}</dt>
          <dd>{selectedEvidence.actor_name ?? '—'}</dd>
        </div>
        <div>
          <dt>{t('analysis.objective.target')}</dt>
          <dd>{selectedEvidence.target_name ?? '—'}</dd>
        </div>
        <div>
          <dt>{t('analysis.objective.weapon')}</dt>
          <dd>{selectedEvidence.weapon ?? '—'}</dd>
        </div>
        <div>
          <dt>{t('analysis.objective.damageHealth')}</dt>
          <dd>{selectedEvidence.damage_health ?? '—'}</dd>
        </div>
        {selectedEvidence.kind === 'plant' ? (
          <div>
            <dt>{t('analysis.objective.rawSiteCode')}</dt>
            <dd>{activeRound?.plant?.raw_site_code ?? '—'}</dd>
          </div>
        ) : null}
      </dl>
      <div>
        <span>{t('analysis.objective.sourceEvent')}</span>
        <strong>{selectedEvidence.source_id}</strong>
      </div>
      <div>
        <span>{t('analysis.objective.canonicalEvidence')}</span>
        <code>{selectedEvidence.evidence_id}</code>
      </div>
      <div>
        <span>{t('analysis.objective.roundEndEvidence')}</span>
        <code>{activeRound?.round_end?.evidence_id ?? '—'}</code>
      </div>
      <section className="objective-review-inspector__atoms">
        <span>{t('analysis.objective.sameTick')}</span>
        <small>{t('analysis.objective.sameTickTruth')}</small>
        {selectedGroup.atoms.map((atom) => (
          <code key={atom.evidence_id}>{atom.evidence_id}</code>
        ))}
      </section>
    </div>
  ) : (
    <EmptyState
      icon={<CircleDot size={20} />}
      title={selectedRoundHasNoPlant
        ? t('analysis.objective.selectedRoundNoPlant')
        : focusedEvidenceId
        ? t('analysis.objective.focusUnavailable')
        : t('analysis.objective.noPlants')}
      description={selectedRoundHasNoPlant
        ? t('analysis.objective.selectedRoundNoPlantDescription')
        : focusedEvidenceId
        ? t('analysis.objective.focusUnavailableDescription')
        : t('analysis.objective.noPlantsDescription')}
    />
  );

  return (
    <section
      className="objective-review-workspace"
      data-testid="objective-review-workspace"
      data-verified-plants={`${model.summary.verified_plant_rounds}/${model.summary.plant_rounds}`}
      aria-label={t('analysis.objective.title')}
    >
      <header className="objective-review-toolbar">
        <div>
          <span className="eyebrow">{t('analysis.objective.eyebrow')}</span>
          <h2>{t('analysis.objective.title')}</h2>
          <p>{t('analysis.objective.description')}</p>
        </div>
        <Badge tone={model.availability.state === 'available' ? 'success' : 'warning'}>
          {model.availability.state === 'available'
            ? t('analysis.objective.canonical')
            : t('analysis.objective.failClosed')}
          {' · '}{model.summary.verified_plant_rounds}/{model.summary.plant_rounds}
        </Badge>
      </header>

      {model.availability.state === 'unavailable' && model.rounds.length === 0 ? (
        <div className="objective-review-unavailable">
          <EmptyState
            icon={<ShieldAlert size={22} />}
            title={t('analysis.objective.unavailable')}
            description={model.availability.reason ?? t('analysis.objective.description')}
          />
        </div>
      ) : model.rounds.length === 0 ? (
        <div className="objective-review-unavailable">
          <EmptyState
            icon={<CircleDot size={22} />}
            title={t('analysis.objective.noPlants')}
            description={t('analysis.objective.noPlantsDescription')}
          />
        </div>
      ) : (
        <>
          <section className="objective-review-summary" aria-label={t('analysis.objective.plants')}>
            <span><small>{t('analysis.objective.plants')}</small><strong>{model.summary.verified_plant_rounds}/{model.summary.plant_rounds}</strong></span>
            <span><small>{t('analysis.objective.wins')}</small><strong>{model.summary.planting_team_wins}</strong></span>
            <span><small>{t('analysis.objective.losses')}</small><strong>{model.summary.planting_team_losses}</strong></span>
            <span><small>{t('analysis.objective.defuses')}</small><strong>{model.summary.defuses}</strong></span>
            <span><small>{t('analysis.objective.explosions')}</small><strong>{model.summary.explosions}</strong></span>
            <span><small>{t('analysis.objective.noTerminal')}</small><strong>{model.summary.no_terminal_events}</strong></span>
            <span><small>{t('analysis.objective.kills')}</small><strong>{model.summary.post_plant_kills}</strong></span>
            <span><small>{t('analysis.objective.damage')}</small><strong>{model.summary.post_plant_damage}</strong></span>
          </section>

          <div className="objective-review-canvas">
            <nav className="objective-review-rounds" aria-label={t('analysis.objective.roundNavigator')}>
              <header>
                <strong>{t('analysis.objective.rounds')}</strong>
                <Badge tone={model.summary.unavailable_plant_rounds > 0 ? 'warning' : 'blue'}>
                  {model.summary.unavailable_plant_rounds} {t('analysis.objective.unavailableRounds')}
                </Badge>
              </header>
              <div className="objective-review-rounds__list">
                {model.rounds.map((round) => (
                  <button
                    type="button"
                    className={round.round === activeRound?.round ? 'is-active' : undefined}
                    data-testid="objective-round"
                    data-state={round.state}
                    aria-current={round.round === activeRound?.round ? 'true' : undefined}
                    onClick={() => onNavigate({ round: round.round, tick: null, evidenceId: null })}
                    key={round.round}
                  >
                    <strong>R{round.round}</strong>
                    <small>{round.state === 'available' && round.plant
                      ? `Team ${round.plant.actor_team} · ${round.plant.actor_side}`
                      : t('analysis.objective.unavailable')}</small>
                  </button>
                ))}
              </div>
            </nav>

            <section className="objective-review-stream" data-testid="objective-review-stream">
              <header>
                <div><CircleDot size={14} /><strong>{t('analysis.objective.stream')}</strong></div>
                <Button
                  className="objective-review-inspector-trigger"
                  size="sm"
                  variant="ghost"
                  disabled={!selectedEvidence}
                  onClick={() => setInspectorOpen(true)}
                >
                  <PanelRightOpen size={13} />{t('analysis.objective.inspector')}
                </Button>
              </header>
              {activeRound?.state === 'unavailable' ? (
                <EmptyState
                  icon={<ShieldAlert size={20} />}
                  title={t('analysis.objective.roundUnavailable')}
                  description={activeRound.reason_code ?? t('analysis.objective.unavailable')}
                />
              ) : activeRound ? (
                <div className="objective-review-stream__body">
                  <article className="objective-review-round-facts">
                    <span>{t('analysis.objective.plantTeam')} <strong>Team {activeRound.plant?.actor_team} · {activeRound.plant?.actor_side}</strong></span>
                    <span>{t('analysis.objective.winner')} <strong>Team {activeRound.winner}</strong></span>
                    <span>{t('analysis.objective.terminal')} <strong>{activeRound.terminal
                      ? `Canonical ${t(atomLabelKeys[activeRound.terminal.kind])}`
                      : t('analysis.objective.terminalUndecoded')}</strong></span>
                    <span>{t('analysis.objective.rawSiteCode')} <strong>{activeRound.plant?.raw_site_code ?? '—'}</strong></span>
                  </article>
                  {activeRound.timeline_groups.map((group) => (
                    <article
                      className="objective-review-tick-group"
                      data-testid="objective-tick-group"
                      data-tick={group.tick}
                      data-atomic-count={group.atoms.length}
                      aria-label={`${t('analysis.objective.sameTick')} ${group.tick}; ${group.atoms.length}`}
                      key={group.key}
                    >
                      <header>
                        <div><time>tick {group.tick}</time><small>{t('analysis.objective.sameTickTruth')}</small></div>
                        {group.damage_event_count > 0 ? (
                          <Badge tone="neutral">
                            {group.damage_event_count} {t('analysis.objective.damageEvents')} · {group.damage_total === null
                              ? t('analysis.objective.damageUnavailable')
                              : `${group.damage_total} ${t('analysis.objective.decodedDamage')}`}
                          </Badge>
                        ) : null}
                      </header>
                      <div>
                        {group.atoms.map((atom) => (
                          <button
                            type="button"
                            className={selectedEvidence?.evidence_id === atom.evidence_id ? 'is-active' : undefined}
                            data-testid="objective-atom"
                            data-evidence-id={atom.evidence_id}
                            aria-current={selectedEvidence?.evidence_id === atom.evidence_id ? 'true' : undefined}
                            onClick={() => setSelectedEvidenceId(atom.evidence_id)}
                            key={atom.evidence_id}
                          >
                            <span>{t(atomLabelKeys[atom.kind])}</span>
                            <strong>{atom.actor_name ?? t('analysis.objective.actorUnavailable')}</strong>
                            <small>{atom.target_name
                              ? `→ ${atom.target_name}`
                              : atom.weapon ?? atom.evidence_id}</small>
                          </button>
                        ))}
                      </div>
                    </article>
                  ))}
                </div>
              ) : (
                <EmptyState
                  icon={<CircleDot size={20} />}
                  title={t('analysis.objective.selectedRoundNoPlant')}
                  description={t('analysis.objective.selectedRoundNoPlantDescription')}
                />
              )}
            </section>

            <aside className="objective-review-inspector" data-testid="objective-review-inspector">
              <header><Eye size={14} /><strong>{t('analysis.objective.inspector')}</strong></header>
              {inspectorBody}
              <footer>{actionButtons}</footer>
            </aside>
          </div>

          <Drawer
            open={inspectorOpen}
            title={t('analysis.objective.inspector')}
            description={t('analysis.objective.inspectorDescription')}
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
