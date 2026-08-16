import {
  Check,
  ListFilter,
  Map as MapIcon,
  Play,
  Plus,
  Swords,
  Target,
} from 'lucide-react';
import { useMemo } from 'react';

import type { AnalysisWorkspace } from '../../shared/desktop/viewModels';
import { useI18n } from '../../shared/i18n';
import { Badge, Button, EmptyState } from '../../shared/ui';
import type { AnalysisNavigationPatch } from './analysisNavigation';
import { duelEvidenceActionContract } from './duelEvidenceActions';
import {
  buildDuelEvidenceWorkspace,
  type DuelMetricAvailability,
} from './duelEvidenceWorkspace';
import type { PlayerDuelInteraction, PlayerEvidenceAvailability } from './playerMatchEvidence';
import './DuelAnalysisWorkspace.css';

export type DuelAnalysisWorkspaceProps = {
  workspace: AnalysisWorkspace;
  selectedPlayerId: string | null;
  selectedOpponentId?: string | null;
  selectedRound?: number | null;
  serviceAvailable: boolean;
  runtimeIdle: boolean;
  watchPending: boolean;
  onNavigate: (navigation: AnalysisNavigationPatch) => void;
  onWatch: (evidence: PlayerDuelInteraction) => void;
  onAddProduction: (evidence: PlayerDuelInteraction) => void;
  addedEvidenceIds?: ReadonlySet<string>;
  focusedEvidenceId?: string | null;
};

function availabilityTone(
  availability: Pick<PlayerEvidenceAvailability | DuelMetricAvailability, 'state'>,
) {
  if (availability.state === 'available') return 'success' as const;
  if (availability.state === 'partial') return 'warning' as const;
  return 'neutral' as const;
}

function atomicValue(evidence: PlayerDuelInteraction): string {
  if (evidence.event_kind === 'damage') {
    return evidence.damage === null ? 'DMG —' : `${evidence.damage} DMG`;
  }
  return [evidence.weapon?.toLocaleUpperCase(), evidence.headshot ? 'HS' : null, evidence.penetrated ? 'WALLBANG' : null]
    .filter(Boolean)
    .join(' · ') || 'KILL';
}

export function DuelAnalysisWorkspace({
  workspace,
  selectedPlayerId,
  selectedOpponentId = null,
  selectedRound = null,
  serviceAvailable,
  runtimeIdle,
  watchPending,
  onNavigate,
  onWatch,
  onAddProduction,
  addedEvidenceIds,
  focusedEvidenceId = null,
}: DuelAnalysisWorkspaceProps) {
  const { t } = useI18n();
  const allMatchups = useMemo(
    () => buildDuelEvidenceWorkspace(workspace, {
      playerId: selectedPlayerId,
      opponentId: null,
      round: selectedRound,
    }),
    [workspace, selectedPlayerId, selectedRound],
  );
  const activeOpponentId = allMatchups.matchups.some(
    (matchup) => matchup.opponent_id === selectedOpponentId,
  ) ? selectedOpponentId : null;
  const view = useMemo(
    () => buildDuelEvidenceWorkspace(workspace, {
      playerId: selectedPlayerId,
      opponentId: activeOpponentId,
      round: selectedRound,
    }),
    [workspace, selectedPlayerId, activeOpponentId, selectedRound],
  );

  const selectOpponent = (opponentId: string | null) => onNavigate({
    opponentId,
    tick: null,
    evidenceId: null,
  });
  const summary = view.atomic_summary;
  const selectedMatchup = activeOpponentId
    ? view.matchups.find((matchup) => matchup.opponent_id === activeOpponentId) ?? null
    : null;

  return (
    <section
      className="duel-analysis-workspace"
      data-testid="duel-evidence-workspace"
      aria-label={t('analysis.duels.title')}
    >
      <header className="duel-analysis-toolbar">
        <div className="duel-analysis-toolbar__title">
          <span className="eyebrow">{t('analysis.duels.eyebrow')}</span>
          <h2>{t('analysis.duels.title')}</h2>
          <p>{t('analysis.duels.description')}</p>
        </div>
        <div className="duel-analysis-filters">
          <label>
            <span>{t('analysis.duels.playerFilter')}</span>
            <select
              data-testid="duel-filter-player"
              value={selectedPlayerId ?? ''}
              onChange={(event) => onNavigate({
                playerId: event.target.value || null,
                evidenceId: null,
              })}
            >
              <option value="">{t('analysis.duels.allPlayers')}</option>
              {workspace.players.map((player) => (
                <option value={player.id} key={player.id}>{player.name}</option>
              ))}
            </select>
          </label>
          <label>
            <span>{t('analysis.duels.opponentFilter')}</span>
            <select
              data-testid="duel-filter-opponent"
              value={activeOpponentId ?? ''}
              disabled={!selectedPlayerId || allMatchups.matchups.length === 0}
              onChange={(event) => selectOpponent(event.target.value || null)}
            >
              <option value="">{t('analysis.duels.allOpponents')}</option>
              {allMatchups.matchups.map((matchup) => (
                <option value={matchup.opponent_id} key={matchup.opponent_id}>
                  {matchup.opponent_name}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>{t('analysis.duels.roundFilter')}</span>
            <select
              data-testid="duel-filter-round"
              value={selectedRound ?? ''}
              onChange={(event) => onNavigate({
                round: event.target.value ? Number(event.target.value) : null,
                tick: null,
                evidenceId: null,
              })}
            >
              <option value="">{t('analysis.duels.allRounds')}</option>
              {workspace.rounds.map((round) => (
                <option value={round.number} key={round.number}>R{round.number}</option>
              ))}
            </select>
          </label>
        </div>
        <div className="duel-analysis-truth">
          <span><strong>{view.matchups.length}</strong>{t('analysis.duels.matchupCount')}</span>
          <span><strong>{view.evidence.length}</strong>{t('analysis.duels.engagementCount')}</span>
          <span title={view.availability.reason ?? undefined}>
            <Badge tone={availabilityTone(view.availability)}>
              {view.availability.state === 'available'
                ? t('analysis.roundContext.verified')
                : view.availability.state === 'partial'
                  ? t('analysis.roundContext.partial')
                  : t('analysis.roundContext.unavailable')}
            </Badge>
          </span>
          <span title={summary.damage_availability.reason ?? undefined}>
            <Badge tone={availabilityTone(summary.damage_availability)}>
              {t('analysis.duels.verifiedDamage')}
            </Badge>
          </span>
        </div>
      </header>

      {allMatchups.matchups.length > 0 ? (
        <div className="duel-analysis-canvas">
          <aside className="duel-analysis-matchups" aria-label={t('analysis.duels.matchupRanking')}>
            <header>
              <span>{t('analysis.duels.matchupRanking')}</span>
              <small>{allMatchups.matchups.length}</small>
            </header>
            <div role="listbox" aria-label={t('analysis.duels.matchupRanking')}>
              {allMatchups.matchups.map((matchup) => (
                <button
                  type="button"
                  role="option"
                  aria-selected={activeOpponentId === matchup.opponent_id}
                  className={activeOpponentId === matchup.opponent_id ? 'is-active' : undefined}
                  data-testid="duel-matchup-row"
                  data-aggregate-scope={matchup.aggregate_scope}
                  key={matchup.id}
                  onClick={() => selectOpponent(
                    activeOpponentId === matchup.opponent_id ? null : matchup.opponent_id,
                  )}
                >
                  <span className="duel-analysis-matchup__identity">
                    <Swords size={15} />
                    <strong>{matchup.player_name} <i>vs</i> {matchup.opponent_name}</strong>
                    <small>{t('analysis.duels.matchScope')} · {matchup.summary_source === 'insights'
                      ? t('analysis.duels.insightsSource')
                      : t('analysis.duels.eventsSource')}</small>
                  </span>
                  <strong className="duel-analysis-matchup__score">{matchup.kills}–{matchup.deaths}</strong>
                  <dl>
                    <div><dt>HS</dt><dd>{matchup.headshot_kills}</dd></div>
                    <div><dt>DMG+</dt><dd>{matchup.damage_dealt ?? '—'}</dd></div>
                    <div><dt>DMG−</dt><dd>{matchup.damage_taken ?? '—'}</dd></div>
                    <div><dt>ATOM</dt><dd>{matchup.atomic_evidence_count}</dd></div>
                  </dl>
                </button>
              ))}
            </div>
          </aside>

          <section className="duel-analysis-evidence" aria-label={t('analysis.duels.atomicEvidence')}>
            <header>
              <div>
                <span className="eyebrow">{t('analysis.duels.atomicEvidence')}</span>
                <h3>{selectedMatchup
                  ? `${view.player?.name ?? '—'} vs ${selectedMatchup.opponent_name}`
                  : `${view.player?.name ?? '—'} vs ${t('analysis.duels.allOpponents')}`}</h3>
              </div>
              <dl>
                <div><dt>{t('analysis.duels.kill')}</dt><dd>{summary.kill_events}</dd></div>
                <div><dt>{t('analysis.duels.death')}</dt><dd>{summary.death_events}</dd></div>
                <div title={summary.damage_availability.reason ?? undefined}>
                  <dt>{t('analysis.duels.verifiedDamage')}</dt>
                  <dd>{summary.verified_damage_dealt ?? '—'} / {summary.verified_damage_taken ?? '—'}</dd>
                </div>
                <div><dt>{t('analysis.duels.damageEvents')}</dt><dd>{summary.damage_dealt_events + summary.damage_taken_events}</dd></div>
              </dl>
            </header>
            <div className="duel-analysis-evidence__head" aria-hidden="true">
              <span>{t('analysis.duels.columnPerspective')}</span>
              <span>{t('analysis.duels.columnParticipants')}</span>
              <span>{t('analysis.duels.columnLocation')}</span>
              <span>{t('analysis.duels.columnValue')}</span>
              <span>{t('analysis.duels.columnActions')}</span>
            </div>
            <div className="duel-analysis-evidence__rows">
              {view.evidence.length > 0 ? view.evidence.map((item) => {
                const added = addedEvidenceIds?.has(item.evidence_id) ?? false;
                const actions = duelEvidenceActionContract(workspace, selectedPlayerId ?? '', item, {
                  serviceAvailable,
                  runtimeIdle,
                  watchPending,
                  alreadyAdded: added,
                });
                const perspectiveLabel = item.perspective === 'kill'
                  ? t('analysis.duels.kill')
                  : item.perspective === 'death'
                    ? t('analysis.duels.death')
                    : item.perspective === 'damage_dealt'
                      ? t('analysis.duels.damageDealt')
                      : t('analysis.duels.damageTaken');
                const roundLabel = t('analysis.duels.openRound');
                const replayLabel = t('analysis.roundContext.open2d');
                const watchLabel = t('analysis.roundContext.watchGame');
                const addLabel = t('analysis.roundContext.addProduction');
                return (
                  <article
                    className={'duel-analysis-evidence-row' + (focusedEvidenceId === item.evidence_id ? ' is-focused' : '')}
                    data-testid="duel-engagement-row"
                    data-evidence-id={item.evidence_id}
                    aria-current={focusedEvidenceId === item.evidence_id ? 'true' : undefined}
                    key={`${item.evidence_id}:${item.perspective}`}
                  >
                    <span className={`duel-analysis-perspective duel-analysis-perspective--${item.perspective}`}>
                      {perspectiveLabel}
                    </span>
                    <span className="duel-analysis-participants">
                      <strong>{item.actor_name ?? '—'} <i aria-hidden="true">→</i> {item.target_name ?? '—'}</strong>
                      <small>{item.weapon?.toLocaleUpperCase() ?? '—'}</small>
                    </span>
                    <span className="duel-analysis-location">
                      <strong>R{item.round}</strong>
                      <small>tick {item.tick}</small>
                    </span>
                    <span className="duel-analysis-value">{atomicValue(item)}</span>
                    <span className="duel-analysis-actions">
                      <Button size="sm" variant="ghost" data-action="round"
                        disabled={!actions.round.available} title={actions.round.reason ?? roundLabel}
                        aria-label={`${roundLabel} · R${item.round} tick ${item.tick}`}
                        onClick={() => onNavigate(actions.round.navigation)}>
                        <ListFilter size={12} /><span>{roundLabel}</span>
                      </Button>
                      <Button size="sm" variant="ghost" data-action="replay"
                        disabled={!actions.replay.available} title={actions.replay.reason ?? replayLabel}
                        aria-label={`${replayLabel} · R${item.round} tick ${item.tick}`}
                        onClick={() => onNavigate(actions.replay.navigation)}>
                        <MapIcon size={12} /><span>{replayLabel}</span>
                      </Button>
                      <Button size="sm" variant="ghost" data-action="watch"
                        disabled={!actions.watch.available} title={actions.watch.reason ?? watchLabel}
                        aria-label={`${watchLabel} · R${item.round} tick ${item.tick}`}
                        onClick={() => onWatch(item)}>
                        <Play size={12} /><span>{watchLabel}</span>
                      </Button>
                      <Button size="sm" variant="ghost" data-action="add"
                        disabled={!actions.add.available} title={actions.add.reason ?? addLabel}
                        aria-label={`${addLabel} · R${item.round} tick ${item.tick}`}
                        onClick={() => onAddProduction(item)}>
                        {added ? <Check size={12} /> : <Plus size={12} />}<span>{addLabel}</span>
                      </Button>
                    </span>
                  </article>
                );
              }) : (
                <div className="duel-analysis-empty duel-analysis-empty--inline">
                  <EmptyState
                    icon={<Target size={20} />}
                    title={t('analysis.duels.noEngagements')}
                    description={t('analysis.duels.noEngagementsDescription')}
                  />
                </div>
              )}
            </div>
          </section>
        </div>
      ) : (
        <div className="duel-analysis-empty">
          <EmptyState
            icon={<Swords size={22} />}
            title={t('analysis.duels.noMatchups')}
            description={view.availability.reason ?? t('analysis.duels.noMatchupsDescription')}
          />
        </div>
      )}
    </section>
  );
}
