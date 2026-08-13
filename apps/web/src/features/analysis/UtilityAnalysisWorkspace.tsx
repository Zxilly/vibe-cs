import {
  Check,
  CircleDot,
  Eye,
  ListFilter,
  Map as MapIcon,
  Play,
  Plus,
  Target,
} from 'lucide-react';
import { useMemo, useState } from 'react';

import type { AnalysisWorkspace } from '../../shared/desktop/dto';
import { useI18n, type MessageKey } from '../../shared/i18n';
import { Badge, Button, EmptyState } from '../../shared/ui';
import type { AnalysisNavigationPatch } from './analysisNavigation';
import { utilityEvidenceActionContract } from './utilityEvidenceActions';
import {
  buildUtilityEvidenceWorkspace,
  type UtilityAtomicEvidence,
  type UtilityMetricAvailability,
  type UtilityType,
} from './utilityEvidenceWorkspace';
import './UtilityAnalysisWorkspace.css';

export type UtilityAnalysisWorkspaceProps = {
  workspace: AnalysisWorkspace;
  selectedPlayerId?: string | null;
  selectedRound?: number | null;
  serviceAvailable: boolean;
  runtimeIdle: boolean;
  watchPending: boolean;
  onNavigate: (navigation: AnalysisNavigationPatch) => void;
  onWatch: (evidence: UtilityAtomicEvidence) => void;
  onAddProduction: (evidence: UtilityAtomicEvidence) => void;
  addedEvidenceIds?: ReadonlySet<string>;
  focusedEvidenceId?: string | null;
};

const utilityTypes: UtilityType[] = ['smoke', 'flash', 'he', 'fire', 'decoy', 'other'];

const typeKey: Record<UtilityType, MessageKey> = {
  smoke: 'analysis.utility.type.smoke',
  flash: 'analysis.utility.type.flash',
  he: 'analysis.utility.type.he',
  fire: 'analysis.utility.type.fire',
  decoy: 'analysis.utility.type.decoy',
  other: 'analysis.utility.type.other',
};

const phaseKey: Record<UtilityAtomicEvidence['phase'], MessageKey> = {
  throw_event: 'analysis.utility.phase.throwEvent',
  activation_event: 'analysis.utility.phase.activationEvent',
  expiration_event: 'analysis.utility.phase.expirationEvent',
  blind_event: 'analysis.utility.phase.blindEvent',
  damage_event: 'analysis.utility.phase.damageEvent',
  timeline_event: 'analysis.utility.phase.timelineEvent',
};

function availabilityTone(state: UtilityMetricAvailability['state']) {
  if (state === 'available') return 'success' as const;
  if (state === 'partial') return 'warning' as const;
  return 'neutral' as const;
}

function availabilityKey(state: UtilityMetricAvailability['state']): MessageKey {
  if (state === 'available') return 'analysis.roundContext.verified';
  if (state === 'partial') return 'analysis.roundContext.partial';
  return 'analysis.roundContext.unavailable';
}

function compactNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/0+$/u, '').replace(/\.$/u, '');
}

function eventValue(evidence: UtilityAtomicEvidence): string {
  if (evidence.event_kind === 'damage') {
    return evidence.damage === null ? '—' : `${compactNumber(evidence.damage)} DMG`;
  }
  if (evidence.event_kind === 'flash') {
    return evidence.blind_duration_seconds === null
      ? '—'
      : `${compactNumber(evidence.blind_duration_seconds)}s`;
  }
  return '—';
}

function coordinates(evidence: UtilityAtomicEvidence): string {
  return evidence.position?.map((value) => compactNumber(value)).join(', ') ?? '—';
}

export function UtilityAnalysisWorkspace({
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
}: UtilityAnalysisWorkspaceProps) {
  const { t } = useI18n();
  const [selectedUtilityType, setSelectedUtilityType] = useState<UtilityType | null>(null);
  const [selectedEvidenceId, setSelectedEvidenceId] = useState<string | null>(focusedEvidenceId);
  const evidenceWorkspace = useMemo(
    () => buildUtilityEvidenceWorkspace(workspace, {
      playerId: selectedPlayerId,
      round: selectedRound,
      utilityType: selectedUtilityType,
    }),
    [workspace, selectedPlayerId, selectedRound, selectedUtilityType],
  );
  const selectedEvidence = evidenceWorkspace.evidence.find(
    (item) => item.evidence_id === (selectedEvidenceId ?? focusedEvidenceId),
  ) ?? evidenceWorkspace.evidence[0] ?? null;

  return (
    <section
      className="utility-analysis-workspace"
      data-testid="utility-evidence-workspace"
      aria-label={t('analysis.utility.title')}
    >
      <header className="utility-analysis-toolbar">
        <div className="utility-analysis-toolbar__title">
          <span className="eyebrow">{t('analysis.utility.eyebrow')}</span>
          <h2>{t('analysis.utility.title')}</h2>
          <p>{t('analysis.utility.description')}</p>
        </div>
        <div className="utility-analysis-filters">
          <label>
            <span>{t('analysis.utility.playerFilter')}</span>
            <select
              data-testid="utility-filter-player"
              value={selectedPlayerId ?? ''}
              onChange={(event) => onNavigate({
                playerId: event.target.value || null,
                tick: null,
                evidenceId: null,
              })}
            >
              <option value="">{t('analysis.utility.allPlayers')}</option>
              {workspace.players.map((player) => (
                <option value={player.id} key={player.id}>{player.name}</option>
              ))}
            </select>
          </label>
          <label>
            <span>{t('analysis.utility.roundFilter')}</span>
            <select
              data-testid="utility-filter-round"
              value={selectedRound ?? ''}
              onChange={(event) => onNavigate({
                round: event.target.value ? Number(event.target.value) : null,
                tick: null,
                evidenceId: null,
              })}
            >
              <option value="">{t('analysis.utility.allRounds')}</option>
              {workspace.rounds.map((round) => (
                <option value={round.number} key={round.number}>R{round.number}</option>
              ))}
            </select>
          </label>
          <label>
            <span>{t('analysis.utility.typeFilter')}</span>
            <select
              data-testid="utility-filter-type"
              value={selectedUtilityType ?? ''}
              onChange={(event) => {
                setSelectedUtilityType((event.target.value || null) as UtilityType | null);
                setSelectedEvidenceId(null);
              }}
            >
              <option value="">{t('analysis.utility.allTypes')}</option>
              {utilityTypes.map((type) => (
                <option value={type} key={type}>{t(typeKey[type])}</option>
              ))}
            </select>
          </label>
        </div>
      </header>

      <div className="utility-analysis-metrics" aria-label={t('analysis.utility.eventCapability')}>
        <div data-capability="utility-events" title={evidenceWorkspace.availability.events.reason ?? undefined}>
          <span>{t('analysis.utility.decodedEvents')}</span>
          <strong>{evidenceWorkspace.decoded_event_count}</strong>
          <small>{evidenceWorkspace.availability.events.reason ?? t(availabilityKey(evidenceWorkspace.availability.events.state))}</small>
          <Badge tone={availabilityTone(evidenceWorkspace.availability.events.state)}>
            {t(availabilityKey(evidenceWorkspace.availability.events.state))}
          </Badge>
        </div>
        <div data-capability="utility-damage" title={evidenceWorkspace.metrics.damage.availability.reason ?? undefined}>
          <span>{t('analysis.utility.verifiedDamage')}</span>
          <strong>{evidenceWorkspace.metrics.damage.value === null ? '—' : compactNumber(evidenceWorkspace.metrics.damage.value)}</strong>
          <small>{evidenceWorkspace.metrics.damage.availability.reason ?? `${evidenceWorkspace.metrics.damage.event_count} ${t('analysis.utility.decodedEvents')}`}</small>
          <Badge tone={availabilityTone(evidenceWorkspace.metrics.damage.availability.state)}>
            {t(availabilityKey(evidenceWorkspace.metrics.damage.availability.state))}
          </Badge>
        </div>
        <div data-capability="flash-effects" title={evidenceWorkspace.metrics.blind_duration.availability.reason ?? undefined}>
          <span>{t('analysis.utility.blindDuration')}</span>
          <strong>{evidenceWorkspace.metrics.blind_duration.value === null ? '—' : `${compactNumber(evidenceWorkspace.metrics.blind_duration.value)}s`}</strong>
          <small>{evidenceWorkspace.metrics.blind_duration.availability.reason ?? `${evidenceWorkspace.metrics.blind_duration.event_count} ${t('analysis.utility.decodedEvents')}`}</small>
          <Badge tone={availabilityTone(evidenceWorkspace.metrics.blind_duration.availability.state)}>
            {t(availabilityKey(evidenceWorkspace.metrics.blind_duration.availability.state))}
          </Badge>
        </div>
      </div>

      {evidenceWorkspace.evidence.length > 0 ? (
        <div className="utility-analysis-canvas">
          <section className="utility-analysis-evidence" aria-label={t('analysis.utility.atomicEvidence')}>
            <header>
              <span className="eyebrow">{t('analysis.utility.atomicEvidence')}</span>
              <strong>{evidenceWorkspace.evidence.length}</strong>
            </header>
            <div className="utility-analysis-evidence__head" role="row">
              <span>{t('analysis.utility.columnType')}</span>
              <span>{t('analysis.utility.columnParticipants')}</span>
              <span>{t('analysis.utility.columnLocation')}</span>
              <span>{t('analysis.utility.columnValue')}</span>
              <span>{t('analysis.utility.columnActions')}</span>
            </div>
            <div className="utility-analysis-evidence__rows" role="rowgroup">
              {evidenceWorkspace.evidence.map((item) => {
                const added = addedEvidenceIds?.has(item.evidence_id) ?? false;
                const actions = utilityEvidenceActionContract(workspace, item, {
                  serviceAvailable,
                  runtimeIdle,
                  watchPending,
                  alreadyAdded: added,
                });
                const focused = selectedEvidence?.evidence_id === item.evidence_id;
                return (
                  <article
                    className={`utility-analysis-evidence-row${focused ? ' is-focused' : ''}`}
                    data-testid="utility-evidence-row"
                    data-evidence-id={item.evidence_id}
                    data-utility-type={item.utility_type}
                    aria-current={focused ? 'true' : undefined}
                    key={item.evidence_id}
                  >
                    <button
                      type="button"
                      className="utility-analysis-evidence-row__select"
                      aria-label={`${t(phaseKey[item.phase])} · R${item.round} · tick ${item.tick}`}
                      onClick={() => setSelectedEvidenceId(item.evidence_id)}
                    >
                      <span className={`utility-analysis-event-kind utility-analysis-event-kind--${item.event_kind}`}>
                        <i>{t(typeKey[item.utility_type])}</i>
                        <small>{t(phaseKey[item.phase])}</small>
                      </span>
                      <span className="utility-analysis-participants">
                        <strong>{item.actor_name ?? '—'} <i>→</i> {item.target_name ?? '—'}</strong>
                        <small>{item.source_id}</small>
                      </span>
                      <span className="utility-analysis-location">
                        <strong>R{item.round}</strong>
                        <small>TICK {item.tick}</small>
                      </span>
                      <span className="utility-analysis-value">{eventValue(item)}</span>
                    </button>
                    <span className="utility-analysis-actions">
                      <Button
                        size="sm"
                        variant="ghost"
                        data-action="round"
                        disabled={!actions.round.available}
                        title={actions.round.reason ?? t('analysis.utility.openRound')}
                        aria-label={`${t('analysis.utility.openRound')} · R${item.round} tick ${item.tick}`}
                        onClick={() => onNavigate(actions.round.navigation)}
                      >
                        <ListFilter size={12} /><span>{t('analysis.utility.openRound')}</span>
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        data-action="replay"
                        disabled={!actions.replay.available}
                        title={actions.replay.reason ?? t('analysis.utility.openReplay')}
                        aria-label={`${t('analysis.utility.openReplay')} · R${item.round} tick ${item.tick}`}
                        onClick={() => onNavigate(actions.replay.navigation)}
                      >
                        <MapIcon size={12} /><span>{t('analysis.utility.openReplay')}</span>
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        data-action="watch"
                        disabled={!actions.watch.available}
                        title={actions.watch.reason ?? t('analysis.utility.watch')}
                        aria-label={`${t('analysis.utility.watch')} · R${item.round} tick ${item.tick}`}
                        onClick={() => onWatch(item)}
                      >
                        <Play size={12} /><span>{t('analysis.utility.watch')}</span>
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        data-action="add"
                        disabled={!actions.add.available}
                        title={actions.add.reason ?? t('analysis.utility.add')}
                        aria-label={`${t('analysis.utility.add')} · R${item.round} tick ${item.tick}`}
                        onClick={() => onAddProduction(item)}
                      >
                        {added ? <Check size={12} /> : <Plus size={12} />}<span>{t('analysis.utility.add')}</span>
                      </Button>
                    </span>
                  </article>
                );
              })}
            </div>
          </section>

          <aside className="utility-analysis-inspector" data-testid="utility-evidence-inspector">
            <header>
              <span className="eyebrow">{t('analysis.utility.selectedEvidence')}</span>
              <Eye size={15} />
            </header>
            {selectedEvidence ? (
              <div>
                <span className="utility-analysis-inspector__identity">
                  <CircleDot size={17} />
                  <strong>{t(typeKey[selectedEvidence.utility_type])}</strong>
                  <small>{t(phaseKey[selectedEvidence.phase])}</small>
                </span>
                <label>{t('analysis.utility.canonicalEvidence')}<code>{selectedEvidence.evidence_id}</code></label>
                <dl>
                  <div><dt>{t('analysis.utility.sourceEvent')}</dt><dd>{selectedEvidence.source_id}</dd></div>
                  <div><dt>{t('analysis.utility.columnLocation')}</dt><dd>R{selectedEvidence.round} · TICK {selectedEvidence.tick}</dd></div>
                  <div><dt>{t('analysis.utility.columnParticipants')}</dt><dd>{selectedEvidence.actor_name ?? '—'} → {selectedEvidence.target_name ?? '—'}</dd></div>
                  <div><dt>{t('analysis.utility.columnValue')}</dt><dd>{eventValue(selectedEvidence)}</dd></div>
                  <div><dt>{t('analysis.utility.position')}</dt><dd>{coordinates(selectedEvidence)}</dd></div>
                </dl>
              </div>
            ) : null}
          </aside>
        </div>
      ) : (
        <div className="utility-analysis-empty">
          <EmptyState
            icon={<Target size={22} />}
            title={t('analysis.utility.noEvidence')}
            description={t('analysis.utility.noEvidenceDescription')}
          />
        </div>
      )}
    </section>
  );
}
