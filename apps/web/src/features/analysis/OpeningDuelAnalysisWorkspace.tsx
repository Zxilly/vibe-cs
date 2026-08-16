import {
  Check,
  CircleAlert,
  Crosshair,
  ListFilter,
  Map as MapIcon,
  Play,
  Plus,
  ScanSearch,
  Swords,
} from 'lucide-react';
import { useMemo, useState } from 'react';

import type { AnalysisWorkspace } from '../../shared/desktop/viewModels';
import { useI18n } from '../../shared/i18n';
import { Badge, Button, EmptyState } from '../../shared/ui';
import type { AnalysisNavigationPatch } from './analysisNavigation';
import {
  openingDuelEvidenceActionContract,
} from './openingDuelEvidenceActions';
import {
  buildOpeningDuelWorkspace,
  type OpeningDuelEvidence,
  type OpeningDuelOutcome,
  type OpeningRoundUnavailableReason,
} from './openingDuelWorkspace';
import type { PlayerEvidenceCompilationIntent } from './playerEvidenceActions';
import './OpeningDuelAnalysisWorkspace.css';

export type OpeningDuelAnalysisWorkspaceProps = {
  workspace: AnalysisWorkspace;
  selectedPlayerId: string | null;
  selectedOpponentId?: string | null;
  selectedRound: number | null;
  serviceAvailable: boolean;
  runtimeIdle: boolean;
  watchPending: boolean;
  onNavigate: (navigation: AnalysisNavigationPatch) => void;
  onWatch: (evidence: OpeningDuelEvidence) => void;
  onAddProduction: (compilation: PlayerEvidenceCompilationIntent) => void;
  addedEvidenceIds?: ReadonlySet<string>;
  focusedEvidenceId?: string | null;
};

function availabilityTone(state: 'available' | 'partial' | 'unavailable') {
  if (state === 'available') return 'success' as const;
  if (state === 'partial') return 'warning' as const;
  return 'neutral' as const;
}

function positionLabel(position: [number, number, number] | null): string {
  return position ? position.map((value) => Math.round(value)).join(' / ') : '—';
}

function reasonLabel(
  code: OpeningRoundUnavailableReason,
  t: ReturnType<typeof useI18n>['t'],
): string {
  if (code === 'no_kill_event') return t('analysis.openings.reason.noKill');
  if (code === 'outside_round_bounds') return t('analysis.openings.reason.outsideBounds');
  if (code === 'missing_actor') return t('analysis.openings.reason.missingActor');
  if (code === 'missing_target') return t('analysis.openings.reason.missingTarget');
  if (code === 'unknown_actor') return t('analysis.openings.reason.unknownActor');
  if (code === 'unknown_target') return t('analysis.openings.reason.unknownTarget');
  return t('analysis.openings.reason.selfElimination');
}

export function OpeningDuelAnalysisWorkspace({
  workspace,
  selectedPlayerId,
  selectedOpponentId = null,
  selectedRound,
  serviceAvailable,
  runtimeIdle,
  watchPending,
  onNavigate,
  onWatch,
  onAddProduction,
  addedEvidenceIds,
  focusedEvidenceId = null,
}: OpeningDuelAnalysisWorkspaceProps) {
  const { t } = useI18n();
  const [outcome, setOutcome] = useState<OpeningDuelOutcome>('all');
  const [localFocusId, setLocalFocusId] = useState<string | null>(null);
  const matrixView = useMemo(
    () => buildOpeningDuelWorkspace(workspace, {
      playerId: selectedPlayerId,
      round: selectedRound,
      outcome: 'all',
    }),
    [workspace, selectedPlayerId, selectedRound],
  );
  const selectedMatrixCell = matrixView.matrix.cells.find((cell) => (
    cell.actor_id === selectedPlayerId
      && cell.target_id === selectedOpponentId
      && cell.opening_kills > 0
  )) ?? null;
  const activeTargetId = selectedMatrixCell?.target_id ?? null;
  const effectiveOutcome: OpeningDuelOutcome = activeTargetId
    ? 'opening_kill'
    : selectedPlayerId ? outcome : 'all';
  const view = useMemo(
    () => buildOpeningDuelWorkspace(workspace, {
      playerId: selectedPlayerId,
      targetId: activeTargetId,
      round: selectedRound,
      outcome: effectiveOutcome,
    }),
    [workspace, selectedPlayerId, activeTargetId, selectedRound, effectiveOutcome],
  );
  const targetOptions = selectedPlayerId
    ? matrixView.matrix.cells.filter((cell) => (
        cell.actor_id === selectedPlayerId && cell.opening_kills > 0
      ))
    : [];
  const activeEvidence = view.evidence.find((item) => item.evidence_id === focusedEvidenceId)
    ?? view.evidence.find((item) => item.evidence_id === localFocusId)
    ?? view.evidence[0]
    ?? null;
  const activeAdded = activeEvidence
    ? addedEvidenceIds?.has(activeEvidence.evidence_id) ?? false
    : false;
  const activeActions = activeEvidence
    ? openingDuelEvidenceActionContract(workspace, selectedPlayerId, activeEvidence, {
        serviceAvailable,
        runtimeIdle,
        watchPending,
        alreadyAdded: activeAdded,
      })
    : null;
  const verifiedRounds = view.round_assessments.length - view.unavailable_rounds.count;
  const orderedAggregates = [...view.player_aggregates].sort(
    (left, right) => right.atomic_evidence_count - left.atomic_evidence_count
      || left.player_name.localeCompare(right.player_name),
  );

  const selectEvidence = (evidence: OpeningDuelEvidence) => {
    setLocalFocusId(evidence.evidence_id);
    onNavigate({
      round: evidence.round,
      tick: evidence.tick,
      evidenceId: evidence.evidence_id,
    });
  };

  return (
    <section
      className="opening-analysis-workspace"
      data-testid="opening-duel-workspace"
      aria-label={t('analysis.openings.title')}
    >
      <header className="opening-analysis-toolbar">
        <div className="opening-analysis-toolbar__title">
          <span className="eyebrow">{t('analysis.openings.eyebrow')}</span>
          <h2>{t('analysis.openings.title')}</h2>
          <p>{t('analysis.openings.description')}</p>
        </div>
        <div className="opening-analysis-filters">
          <label>
            <span>{t('analysis.openings.playerFilter')}</span>
            <select
              data-testid="opening-filter-player"
              value={selectedPlayerId ?? ''}
              onChange={(event) => {
                const playerId = event.target.value || null;
                if (!playerId) setOutcome('all');
                onNavigate({ playerId, evidenceId: null });
              }}
            >
              <option value="">{t('analysis.openings.allPlayers')}</option>
              {workspace.players.map((player) => (
                <option value={player.id} key={player.id}>{player.name}</option>
              ))}
            </select>
          </label>
          <label>
            <span>{t('analysis.openings.targetFilter')}</span>
            <select
              data-testid="opening-filter-target"
              value={activeTargetId ?? ''}
              disabled={!selectedPlayerId || targetOptions.length === 0}
              onChange={(event) => {
                setOutcome('all');
                setLocalFocusId(null);
                onNavigate({
                  opponentId: event.target.value || null,
                  tick: null,
                  evidenceId: null,
                });
              }}
            >
              <option value="">{t('analysis.openings.allTargets')}</option>
              {targetOptions.map((cell) => {
                const target = matrixView.matrix.players.find(
                  (player) => player.player_id === cell.target_id,
                );
                return target ? (
                  <option value={target.player_id} key={target.player_id}>
                    {target.player_name} · {cell.opening_kills}
                  </option>
                ) : null;
              })}
            </select>
          </label>
          <label>
            <span>{t('analysis.openings.roundFilter')}</span>
            <select
              data-testid="opening-filter-round"
              value={selectedRound ?? ''}
              onChange={(event) => onNavigate({
                round: event.target.value ? Number(event.target.value) : null,
                tick: null,
                evidenceId: null,
              })}
            >
              <option value="">{t('analysis.openings.allRounds')}</option>
              {workspace.rounds.map((round) => (
                <option value={round.number} key={round.number}>R{round.number}</option>
              ))}
            </select>
          </label>
          <label>
            <span>{t('analysis.openings.outcomeFilter')}</span>
            <select
              data-testid="opening-filter-outcome"
              value={effectiveOutcome}
              disabled={!selectedPlayerId || activeTargetId !== null}
              onChange={(event) => setOutcome(event.target.value as OpeningDuelOutcome)}
            >
              <option value="all">{t('analysis.openings.allOutcomes')}</option>
              <option value="opening_kill">{t('analysis.openings.openingKill')}</option>
              <option value="opening_death">{t('analysis.openings.openingDeath')}</option>
            </select>
          </label>
        </div>
        <div className="opening-analysis-truth">
          <span><strong>{verifiedRounds}</strong>{t('analysis.openings.verifiedRounds')}</span>
          <span><strong>{view.unavailable_rounds.count}</strong>{t('analysis.openings.unavailableRounds')}</span>
          <span><strong>{view.evidence.length}</strong>{t('analysis.openings.atomicOpenings')}</span>
          <span title={view.availability.reason ?? undefined}>
            <Badge tone={availabilityTone(view.availability.state)}>
              {view.availability.state === 'available'
                ? t('analysis.roundContext.verified')
                : view.availability.state === 'partial'
                  ? t('analysis.roundContext.partial')
                  : t('analysis.roundContext.unavailable')}
            </Badge>
          </span>
        </div>
      </header>

      <div className="opening-analysis-summary">
        <header>
          <span>{t('analysis.openings.playerSummary')}</span>
          <small>{orderedAggregates.length}</small>
        </header>
        <div className="opening-analysis-summary__players">
          {orderedAggregates.map((aggregate) => (
            <button
              type="button"
              className={selectedPlayerId === aggregate.player_id ? 'is-active' : undefined}
              data-testid="opening-player-aggregate"
              key={aggregate.player_id}
              onClick={() => onNavigate({
                playerId: selectedPlayerId === aggregate.player_id ? null : aggregate.player_id,
                evidenceId: null,
              })}
            >
              <span className={`opening-team opening-team--${aggregate.player_team.toLocaleLowerCase()}`}>
                {aggregate.player_team}
              </span>
              <strong>{aggregate.player_name}</strong>
              <span><b>{aggregate.opening_kills}</b> {t('analysis.openings.openingKills')}</span>
              <span><b>{aggregate.opening_deaths}</b> {t('analysis.openings.openingDeaths')}</span>
            </button>
          ))}
        </div>
        {view.unavailable_rounds.count > 0 ? (
          <div className="opening-analysis-unavailable" data-testid="opening-unavailable-summary">
            <CircleAlert size={13} />
            <strong>{t('analysis.openings.unavailableSummary')}</strong>
            {view.unavailable_rounds.reasons.map((reason) => (
              <span data-reason-code={reason.code} key={reason.code}>
                {reasonLabel(reason.code, t)} <b>{reason.count}</b>
              </span>
            ))}
          </div>
        ) : null}
      </div>

      <div className="opening-analysis-canvas">
        <section
          className="opening-analysis-matrix"
          data-testid="opening-duel-matrix"
          aria-label={t('analysis.openings.matrix')}
        >
          <header>
            <div>
              <span className="eyebrow">{t('analysis.openings.matrix')}</span>
              <strong>{t('analysis.openings.matrixDescription')}</strong>
            </div>
            {selectedMatrixCell ? (
              <Badge tone="blue">{selectedMatrixCell.opening_kills}</Badge>
            ) : null}
          </header>
          <div className="opening-analysis-matrix__scroll">
            <table>
              <thead>
                <tr>
                  <th scope="col">{t('analysis.openings.matrixAxis')}</th>
                  {matrixView.matrix.players.map((target) => (
                    <th scope="col" title={target.player_name} key={target.player_id}>
                      <span className={`opening-team opening-team--${target.player_team.toLocaleLowerCase()}`}>
                        {target.player_team}
                      </span>
                      <span>{target.player_name}</span>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {matrixView.matrix.players.map((actor) => (
                  <tr key={actor.player_id}>
                    <th scope="row" title={actor.player_name}>
                      <span className={`opening-team opening-team--${actor.player_team.toLocaleLowerCase()}`}>
                        {actor.player_team}
                      </span>
                      <span>{actor.player_name}</span>
                    </th>
                    {matrixView.matrix.players.map((target) => {
                      if (actor.player_id === target.player_id) {
                        return <td className="opening-analysis-matrix__diagonal" key={target.player_id}>—</td>;
                      }
                      const cell = matrixView.matrix.cells.find((candidate) => (
                        candidate.actor_id === actor.player_id
                          && candidate.target_id === target.player_id
                      ));
                      const count = cell?.opening_kills ?? 0;
                      const selected = actor.player_id === selectedPlayerId
                        && target.player_id === activeTargetId;
                      const firstEvidenceId = cell?.evidence_ids[0] ?? null;
                      return (
                        <td key={target.player_id}>
                          <button
                            type="button"
                            className={selected ? 'is-active' : undefined}
                            data-testid="opening-matrix-cell"
                            data-actor-id={actor.player_id}
                            data-target-id={target.player_id}
                            disabled={count === 0}
                            aria-pressed={selected}
                            aria-label={`${actor.player_name} → ${target.player_name}: ${count} ${t('analysis.openings.openingKills')}`}
                            onClick={() => {
                              setOutcome('all');
                              setLocalFocusId(selected ? null : firstEvidenceId);
                              onNavigate({
                                playerId: actor.player_id,
                                opponentId: selected ? null : target.player_id,
                                tick: null,
                                evidenceId: selected ? null : firstEvidenceId,
                              });
                            }}
                          >{count}</button>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section className="opening-analysis-table" aria-label={t('analysis.openings.atomicEvidence')}>
          <header className="opening-analysis-table__title">
            <div>
              <span className="eyebrow">{t('analysis.openings.atomicEvidence')}</span>
              <strong>{view.evidence.length}</strong>
            </div>
            <Badge tone={availabilityTone(view.availability.state)}>
              {view.availability.state === 'available'
                ? t('analysis.roundContext.verified')
                : view.availability.state === 'partial'
                  ? t('analysis.roundContext.partial')
                  : t('analysis.roundContext.unavailable')}
            </Badge>
          </header>
          <div className="opening-analysis-table__head" aria-hidden="true">
            <span>{t('analysis.openings.round')}</span>
            <span>{t('analysis.openings.participants')}</span>
            <span>{t('analysis.openings.weapon')}</span>
            <span>{t('analysis.openings.tick')}</span>
          </div>
          <div className="opening-analysis-table__rows">
            {view.evidence.length > 0 ? view.evidence.map((item) => {
              const focused = activeEvidence?.evidence_id === item.evidence_id;
              return (
                <button
                  type="button"
                  className={`opening-analysis-row${focused ? ' is-focused' : ''}`}
                  data-testid="opening-evidence-row"
                  data-evidence-id={item.evidence_id}
                  aria-current={focused ? 'true' : undefined}
                  key={item.evidence_id}
                  onClick={() => selectEvidence(item)}
                >
                  <span className="opening-analysis-row__round">R{item.round}</span>
                  <span className="opening-analysis-row__participants">
                    <strong>{item.actor_name} <i aria-hidden="true">→</i> {item.target_name}</strong>
                    <small>{item.actor_team} → {item.target_team}</small>
                  </span>
                  <span className="opening-analysis-row__weapon">
                    <strong>{item.weapon?.replace(/^weapon_/i, '').toLocaleUpperCase() ?? '—'}</strong>
                    <small>{[item.headshot ? 'HS' : null, item.penetrated ? 'WALL' : null].filter(Boolean).join(' · ') || '—'}</small>
                  </span>
                  <span className="opening-analysis-row__tick">
                    <strong>{item.tick}</strong>
                    <small>{item.seconds.toFixed(2)}s</small>
                  </span>
                </button>
              );
            }) : (
              <EmptyState
                icon={<Swords size={21} />}
                title={t('analysis.openings.noEvidence')}
                description={view.availability.reason ?? t('analysis.openings.noEvidenceDescription')}
              />
            )}
          </div>
        </section>

        <aside className="opening-analysis-inspector" data-testid="opening-inspector">
          <header>
            <ScanSearch size={15} />
            <span>{t('analysis.openings.inspector')}</span>
          </header>
          {activeEvidence && activeActions ? (
            <>
              <div className="opening-analysis-inspector__hero">
                <span className="opening-analysis-inspector__round">R{activeEvidence.round}</span>
                <div>
                  <strong>{activeEvidence.actor_name} <i>→</i> {activeEvidence.target_name}</strong>
                  <small>{activeEvidence.weapon?.replace(/^weapon_/i, '').toLocaleUpperCase() ?? '—'} · tick {activeEvidence.tick}</small>
                </div>
              </div>
              <dl>
                <div><dt>{t('analysis.openings.canonicalEvidence')}</dt><dd>{activeEvidence.evidence_id}</dd></div>
                <div><dt>{t('analysis.openings.sourceEvent')}</dt><dd>{activeEvidence.source_id}</dd></div>
                <div><dt>{t('analysis.openings.position')}</dt><dd>{positionLabel(activeEvidence.position)}</dd></div>
                <div>
                  <dt>{t('analysis.openings.flags')}</dt>
                  <dd>{[
                    activeEvidence.headshot ? t('analysis.openings.headshot') : null,
                    activeEvidence.penetrated ? t('analysis.openings.wallbang') : null,
                  ].filter(Boolean).join(' · ') || t('analysis.openings.noFlags')}</dd>
                </div>
              </dl>
              <footer>
                <Button
                  size="sm"
                  variant="secondary"
                  data-action="round"
                  disabled={!activeActions.round.available}
                  title={activeActions.round.reason ?? t('analysis.openings.openRound')}
                  onClick={() => onNavigate(activeActions.round.navigation)}
                ><ListFilter size={13} />{t('analysis.openings.openRound')}</Button>
                <Button
                  size="sm"
                  variant="secondary"
                  data-action="replay"
                  disabled={!activeActions.replay.available}
                  title={activeActions.replay.reason ?? t('analysis.openings.openReplay')}
                  onClick={() => onNavigate(activeActions.replay.navigation)}
                ><MapIcon size={13} />{t('analysis.openings.openReplay')}</Button>
                <Button
                  size="sm"
                  variant="secondary"
                  data-action="watch"
                  disabled={!activeActions.watch.available}
                  title={activeActions.watch.reason ?? t('analysis.openings.watch')}
                  onClick={() => onWatch(activeEvidence)}
                ><Play size={13} />{t('analysis.openings.watch')}</Button>
                <Button
                  size="sm"
                  data-action="add"
                  disabled={!activeActions.add.available}
                  title={activeActions.add.reason ?? t('analysis.openings.add')}
                  onClick={() => activeActions.add.compilation
                    && onAddProduction(activeActions.add.compilation)}
                >{activeAdded ? <Check size={13} /> : <Plus size={13} />}{t('analysis.openings.add')}</Button>
              </footer>
            </>
          ) : (
            <EmptyState
              icon={<Crosshair size={20} />}
              title={t('analysis.openings.noEvidence')}
              description={t('analysis.openings.noEvidenceDescription')}
            />
          )}
        </aside>
      </div>
    </section>
  );
}
