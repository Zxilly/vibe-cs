import {
  Check,
  Eye,
  ListFilter,
  Map as MapIcon,
  Play,
  Plus,
  ShieldCheck,
  Swords,
  Users,
} from 'lucide-react';
import { useMemo, useReducer } from 'react';

import type { AnalysisWorkspace } from '../../shared/desktop/viewModels';
import { useI18n } from '../../shared/i18n';
import { Badge, Button, EmptyState } from '../../shared/ui';
import type { AnalysisNavigationPatch } from './analysisNavigation';
import { teamRoundEvidenceActionContract } from './teamRoundEvidenceActions';
import {
  buildTeamRoundWorkspace,
  initialTeamRoundSelection,
  reduceTeamRoundSelection,
  resolveTeamRoundEvidenceId,
  type TeamRoundEvidence,
} from './teamRoundWorkspace';
import type {
  CompetitiveSide,
  StableMatchTeam,
} from './stableMatchTeamContext';
import './TeamRoundAnalysisWorkspace.css';

export type TeamRoundAnalysisWorkspaceProps = {
  workspace: AnalysisWorkspace;
  serviceAvailable: boolean;
  runtimeIdle: boolean;
  watchPending: boolean;
  onNavigate: (navigation: AnalysisNavigationPatch) => void;
  onWatch: (evidence: TeamRoundEvidence) => void;
  onAddProduction: (evidence: TeamRoundEvidence) => void;
  addedEvidenceIds?: ReadonlySet<string>;
  focusedEvidenceId?: string | null;
};

function cellKey(team: StableMatchTeam, side: CompetitiveSide): string {
  return `${team}:${side}`;
}

function evidenceValue(item: TeamRoundEvidence, winnerLabel: string): string {
  if (item.event_kind === 'round_end') return `${winnerLabel} ${item.winner_team ?? '—'}`;
  return [
    item.weapon?.replace(/^weapon_/iu, '').toLocaleUpperCase() ?? null,
    item.headshot ? 'HS' : null,
    item.penetrated ? 'WALLBANG' : null,
  ].filter(Boolean).join(' · ') || 'KILL';
}

export function TeamRoundAnalysisWorkspace({
  workspace,
  serviceAvailable,
  runtimeIdle,
  watchPending,
  onNavigate,
  onWatch,
  onAddProduction,
  addedEvidenceIds,
  focusedEvidenceId = null,
}: TeamRoundAnalysisWorkspaceProps) {
  const { t } = useI18n();
  const base = useMemo(
    () => buildTeamRoundWorkspace(workspace, { team: null, side: null }),
    [workspace],
  );
  const defaultCell = base.cells.find((cell) => cell.rounds_played > 0) ?? base.cells[0] ?? null;
  const [selection, dispatchSelection] = useReducer(
    reduceTeamRoundSelection,
    undefined,
    initialTeamRoundSelection,
  );
  const activeCell = base.cells.find(
    (cell) => cellKey(cell.team, cell.side) === selection.cell_key,
  ) ?? defaultCell;
  const view = useMemo(
    () => buildTeamRoundWorkspace(workspace, {
      team: activeCell?.team ?? null,
      side: activeCell?.side ?? null,
    }),
    [activeCell?.side, activeCell?.team, workspace],
  );
  const selectedEvidenceId = resolveTeamRoundEvidenceId(
    selection,
    focusedEvidenceId,
    view.evidence.map((item) => item.evidence_id),
  );
  const selectedEvidence = view.evidence.find(
    (item) => item.evidence_id === selectedEvidenceId,
  ) ?? null;
  const selectedActions = selectedEvidence
    ? teamRoundEvidenceActionContract(workspace, selectedEvidence, {
        serviceAvailable,
        runtimeIdle,
        watchPending,
        alreadyAdded: addedEvidenceIds?.has(selectedEvidence.evidence_id) ?? false,
      })
    : null;

  return (
    <section
      className="team-round-workspace"
      data-testid="team-round-workspace"
      aria-label={t('analysis.teams.title')}
    >
      <header className="team-round-toolbar">
        <div>
          <span className="eyebrow">{t('analysis.teams.eyebrow')}</span>
          <h2>{t('analysis.teams.title')}</h2>
          <p>{t('analysis.teams.description')}</p>
        </div>
        <Badge tone={base.availability.state === 'available' ? 'success' : 'neutral'}>
          <ShieldCheck size={12} />
          {base.availability.state === 'available'
            ? t('analysis.roundContext.verified')
            : t('analysis.roundContext.unavailable')}
        </Badge>
      </header>

      {base.availability.state === 'available' ? (
        <>
          <div className="team-round-rosters" aria-label={t('analysis.teams.matchRoster')}>
            <span><Users size={13} />{t('analysis.teams.matchRoster')}</span>
            {base.teams.map((team) => (
              <div data-team={team.id} key={team.id}>
                <strong>TEAM {team.id}</strong>
                <small>{team.player_names.join(' · ')}</small>
              </div>
            ))}
          </div>

          <div className="team-round-canvas">
            <section className="team-round-matrix" data-testid="team-round-matrix">
              <header>
                <div><strong>{t('analysis.teams.matrix')}</strong><small>{t('analysis.teams.matrixDescription')}</small></div>
                <Badge tone="neutral">2 × 2</Badge>
              </header>
              <div className="team-round-matrix__grid">
                {base.cells.map((cell) => {
                  const active = activeCell?.team === cell.team && activeCell.side === cell.side;
                  return (
                    <button
                      type="button"
                      className={`team-round-cell team-round-cell--${cell.side.toLocaleLowerCase()}${active ? ' is-active' : ''}`}
                      data-testid="team-round-cell"
                      data-team={cell.team}
                      data-side={cell.side}
                      aria-pressed={active}
                      onClick={() => dispatchSelection({
                        type: 'select_cell',
                        cell_key: cellKey(cell.team, cell.side),
                      })}
                      key={cellKey(cell.team, cell.side)}
                    >
                      <span><strong>TEAM {cell.team}</strong><i>{cell.side}</i></span>
                      <b>{cell.round_wins}<small> / {cell.rounds_played}</small></b>
                      <span><small>{t('analysis.teams.roundWins')}</small><small>{t('analysis.teams.roundsPlayed')}</small></span>
                      <em>{cell.rounds.map((round) => `R${round}`).join(' · ') || '—'}</em>
                    </button>
                  );
                })}
              </div>
            </section>

            <section className="team-round-evidence" data-testid="team-round-evidence">
              <header>
                <div><Swords size={14} /><strong>{t('analysis.teams.atomicEvidence')}</strong></div>
                <Badge tone="blue">{view.evidence.length}</Badge>
              </header>
              <div className="team-round-evidence__head" aria-hidden="true">
                <span>{t('analysis.teams.columnType')}</span>
                <span>{t('analysis.teams.columnParticipants')}</span>
                <span>{t('analysis.teams.columnLocation')}</span>
                <span>{t('analysis.teams.columnValue')}</span>
              </div>
              <div className="team-round-evidence__rows">
                {view.evidence.length > 0 ? view.evidence.map((item) => {
                  const active = selectedEvidence?.evidence_id === item.evidence_id;
                  return (
                    <button
                      type="button"
                      className={`team-round-evidence-row${active ? ' is-active' : ''}`}
                      data-testid="team-round-evidence-row"
                      data-evidence-id={item.evidence_id}
                      aria-current={active ? 'true' : undefined}
                      onClick={() => dispatchSelection({
                        type: 'select_evidence',
                        cell_key: cellKey(item.selected_team, item.selected_side),
                        evidence_id: item.evidence_id,
                      })}
                      key={item.evidence_id}
                    >
                      <span className={`team-round-event-kind team-round-event-kind--${item.event_kind}`}>
                        {item.event_kind === 'kill'
                          ? t('analysis.teams.killEvent')
                          : t('analysis.teams.roundEndEvent')}
                      </span>
                      <span className="team-round-participants">
                        <strong>{item.event_kind === 'kill'
                          ? `${item.actor_name ?? '—'} → ${item.target_name ?? '—'}`
                          : `${t('analysis.teams.winner')} · TEAM ${item.winner_team ?? '—'}`}</strong>
                        <small>TEAM {item.selected_team} · {item.selected_side}</small>
                      </span>
                      <span className="team-round-location"><strong>R{item.round}</strong><small>tick {item.tick}</small></span>
                      <span className="team-round-value">{evidenceValue(item, t('analysis.teams.winner'))}</span>
                    </button>
                  );
                }) : (
                  <EmptyState
                    icon={<Swords size={20} />}
                    title={t('analysis.teams.noEvidence')}
                    description={t('analysis.teams.noEvidenceDescription')}
                  />
                )}
              </div>
            </section>

            <aside className="team-round-inspector" data-testid="team-round-inspector">
              <header><Eye size={14} /><strong>{t('analysis.teams.inspector')}</strong></header>
              {selectedEvidence && selectedActions ? (
                <>
                  <div className="team-round-inspector__body">
                    <span className="eyebrow">{t('analysis.teams.selectedContext')}</span>
                    <h3>TEAM {selectedEvidence.selected_team} · {selectedEvidence.selected_side} · R{selectedEvidence.round}</h3>
                    <dl>
                      <div><dt>{t('analysis.teams.columnType')}</dt><dd>{selectedEvidence.event_kind === 'kill' ? t('analysis.teams.killEvent') : t('analysis.teams.roundEndEvent')}</dd></div>
                      <div><dt>{t('analysis.teams.columnLocation')}</dt><dd>R{selectedEvidence.round} · {selectedEvidence.tick}</dd></div>
                    </dl>
                    <div><span>{t('analysis.teams.canonicalEvidence')}</span><code>{selectedEvidence.evidence_id}</code></div>
                  </div>
                  <footer>
                    <Button size="sm" variant="ghost" data-action="round" disabled={!selectedActions.round.available} title={selectedActions.round.reason ?? t('analysis.teams.openRound')} onClick={() => onNavigate(selectedActions.round.navigation)}><ListFilter size={12} /><span>{t('analysis.teams.openRound')}</span></Button>
                    <Button size="sm" variant="ghost" data-action="replay" disabled={!selectedActions.replay.available} title={selectedActions.replay.reason ?? t('analysis.teams.openReplay')} onClick={() => onNavigate(selectedActions.replay.navigation)}><MapIcon size={12} /><span>{t('analysis.teams.openReplay')}</span></Button>
                    <Button size="sm" variant="ghost" data-action="watch" disabled={!selectedActions.watch.available} title={selectedActions.watch.reason ?? t('analysis.teams.watch')} onClick={() => onWatch(selectedEvidence)}><Play size={12} /><span>{t('analysis.teams.watch')}</span></Button>
                    <Button size="sm" variant="ghost" data-action="add" disabled={!selectedActions.add.available} title={selectedActions.add.reason ?? t('analysis.teams.add')} onClick={() => onAddProduction(selectedEvidence)}>{addedEvidenceIds?.has(selectedEvidence.evidence_id) ? <Check size={12} /> : <Plus size={12} />}<span>{t('analysis.teams.add')}</span></Button>
                  </footer>
                </>
              ) : null}
            </aside>
          </div>
        </>
      ) : (
        <div
          className="team-round-unavailable"
          data-failure-code={base.availability.failure_code ?? undefined}
          data-failure-round={base.availability.failure_round ?? undefined}
        >
          <EmptyState
            icon={<Users size={22} />}
            title={t('analysis.teams.unavailable')}
            description={base.availability.reason ?? t('analysis.teams.description')}
          />
        </div>
      )}
    </section>
  );
}
