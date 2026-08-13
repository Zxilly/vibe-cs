import {
  Bomb,
  Check,
  Crosshair,
  Map as MapIcon,
  Play,
  Plus,
  ShieldAlert,
  Sparkles,
  Swords,
  Zap,
} from 'lucide-react';
import { type ReactNode, useMemo } from 'react';

import type { AnalysisWorkspace } from '../../shared/desktop/dto';
import { msg, useI18n } from '../../shared/i18n';
import { Badge, Button } from '../../shared/ui';
import type {
  PlayerDuelInteraction,
  PlayerEvidenceAvailability,
  PlayerEvidenceRef,
  PlayerHighlightEvidence,
  PlayerObjectiveEvidence,
  PlayerUtilityEventEvidence,
} from './playerMatchEvidence';
import { buildPlayerMatchEvidence } from './playerMatchEvidence';
import './PlayerEvidenceWorkspace.css';

export type PlayerEvidenceWorkspaceProps = {
  workspace: AnalysisWorkspace;
  playerId: string;
  onWatch: (evidence: PlayerEvidenceRef) => void;
  onOpenReplay: (evidence: PlayerEvidenceRef) => void;
  onAddProduction: (evidence: PlayerEvidenceRef) => void;
  addedEvidenceIds?: ReadonlySet<string>;
  watchEnabled?: boolean;
  watchUnavailableReason?: string;
  focusedEvidenceId?: string | null;
};

function percentage(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function availabilityTone(state: PlayerEvidenceAvailability['state']) {
  if (state === 'available') return 'success' as const;
  if (state === 'partial') return 'warning' as const;
  return 'neutral' as const;
}

function Availability({ value }: { value: PlayerEvidenceAvailability }) {
  const { t } = useI18n();
  const label = value.state === 'available'
    ? t('analysis.roundContext.verified')
    : value.state === 'partial'
      ? t('analysis.roundContext.partial')
      : t('analysis.roundContext.unavailable');
  return (
    <span className="player-evidence-availability" title={value.reason ?? undefined}>
      <Badge tone={availabilityTone(value.state)}>{label}</Badge>
    </span>
  );
}

type EvidenceActionsProps = {
  evidence: PlayerEvidenceRef;
  onWatch: PlayerEvidenceWorkspaceProps['onWatch'];
  onOpenReplay: PlayerEvidenceWorkspaceProps['onOpenReplay'];
  onAddProduction: PlayerEvidenceWorkspaceProps['onAddProduction'];
  addedEvidenceIds: ReadonlySet<string> | undefined;
  watchEnabled: boolean;
  watchUnavailableReason: string | undefined;
  focusedEvidenceId: string | null;
  labels: {
    watch: string;
    replay: string;
    add: string;
  };
};

function EvidenceActions({
  evidence,
  onWatch,
  onOpenReplay,
  onAddProduction,
  addedEvidenceIds,
  watchEnabled,
  watchUnavailableReason,
  labels,
}: EvidenceActionsProps) {
  const added = addedEvidenceIds?.has(evidence.evidence_id) ?? false;
  return (
    <div className="player-evidence-actions">
      <Button
        size="sm"
        variant="ghost"
        data-action="watch"
        disabled={!watchEnabled}
        title={watchEnabled ? labels.watch : watchUnavailableReason ?? labels.watch}
        aria-label={`${labels.watch} · R${evidence.round} tick ${evidence.tick}`}
        onClick={() => onWatch(evidence)}
      >
        <Play size={12} /><span>{labels.watch}</span>
      </Button>
      <Button
        size="sm"
        variant="ghost"
        data-action="replay"
        title={labels.replay}
        aria-label={`${labels.replay} · R${evidence.round} tick ${evidence.tick}`}
        onClick={() => onOpenReplay(evidence)}
      >
        <MapIcon size={12} /><span>{labels.replay}</span>
      </Button>
      <Button
        size="sm"
        variant="ghost"
        data-action="add"
        disabled={added}
        title={labels.add}
        aria-label={`${labels.add} · R${evidence.round} tick ${evidence.tick}`}
        onClick={() => onAddProduction(evidence)}
      >
        {added ? <Check size={12} /> : <Plus size={12} />}
        <span>{labels.add}</span>
      </Button>
    </div>
  );
}

function EvidenceRow({
  evidence,
  icon,
  title,
  detail,
  actions,
}: {
  evidence: PlayerEvidenceRef;
  icon: ReactNode;
  title: ReactNode;
  detail?: ReactNode;
  actions: Omit<EvidenceActionsProps, 'evidence'>;
}) {
  return (
    <article
      className={`player-evidence-row${actions.focusedEvidenceId === evidence.evidence_id ? ' is-focused' : ''}`}
      data-testid="player-evidence-row"
      data-evidence-id={evidence.evidence_id}
      aria-current={actions.focusedEvidenceId === evidence.evidence_id ? 'true' : undefined}
    >
      <span className="player-evidence-row__icon" aria-hidden="true">{icon}</span>
      <div className="player-evidence-row__copy">
        <strong>{title}</strong>
        {detail ? <small>{detail}</small> : null}
      </div>
      <div className="player-evidence-row__location">
        <strong>R{evidence.round}</strong>
        <span>tick {evidence.tick}{evidence.end_tick === null ? '' : `–${evidence.end_tick}`}</span>
      </div>
      <EvidenceActions evidence={evidence} {...actions} />
    </article>
  );
}

function EvidencePanel({
  testId,
  icon,
  title,
  count,
  availability,
  children,
}: {
  testId: string;
  icon: ReactNode;
  title: string;
  count: number;
  availability: PlayerEvidenceAvailability;
  children: ReactNode;
}) {
  return (
    <section className="player-evidence-panel" data-testid={testId}>
      <header>
        <div className="player-evidence-panel__title">{icon}<h3>{title}</h3><span>{count}</span></div>
        <Availability value={availability} />
      </header>
      {availability.reason && availability.state !== 'available'
        ? <p className="player-evidence-panel__reason">{availability.reason}</p>
        : null}
      <div className="player-evidence-panel__body">{children}</div>
    </section>
  );
}

function CapabilityStatus({
  capability,
  label,
  value,
}: {
  capability: string;
  label: string;
  value: PlayerEvidenceAvailability;
}) {
  return (
    <div className="player-evidence-capability" data-capability={capability}>
      <span>{label}</span>
      <Availability value={value} />
      {value.reason ? <small>{value.reason}</small> : null}
    </div>
  );
}

function combatTitle(actor: string | null, target: string | null): ReactNode {
  return <>{actor ?? '—'} <span aria-hidden="true">→</span> {target ?? '—'}</>;
}

function combatDetail(weapon: string | null, headshot: boolean, penetrated: boolean): string {
  return [weapon?.toLocaleUpperCase() ?? 'WEAPON —', headshot ? 'HS' : null, penetrated ? 'WALLBANG' : null]
    .filter(Boolean)
    .join(' · ');
}

function duelLabel(event: PlayerDuelInteraction): string {
  if (event.perspective === 'kill') return 'KILL';
  if (event.perspective === 'death') return 'DEATH';
  if (event.perspective === 'damage_dealt') return 'DMG →';
  return 'DMG ←';
}

function utilityLabel(event: PlayerUtilityEventEvidence): string {
  if (event.phase === 'throw') return 'THROW';
  if (event.phase === 'detonation') return 'DETONATE';
  return 'DAMAGE';
}

function objectiveLabel(event: PlayerObjectiveEvidence): string {
  if (event.objective === 'plant') return 'PLANT';
  if (event.objective === 'defuse') return 'DEFUSE';
  return 'EXPLODE';
}

function highlightDetail(highlight: PlayerHighlightEvidence): string {
  const confidence = `${Math.round(highlight.confidence * 100)}%`;
  return [highlight.kind.replaceAll('_', ' ').toLocaleUpperCase(), confidence, highlight.description]
    .filter(Boolean)
    .join(' · ');
}

export function PlayerEvidenceWorkspace({
  workspace,
  playerId,
  onWatch,
  onOpenReplay,
  onAddProduction,
  addedEvidenceIds,
  watchEnabled = true,
  watchUnavailableReason,
  focusedEvidenceId = null,
}: PlayerEvidenceWorkspaceProps) {
  const { t } = useI18n();
  const evidence = useMemo(
    () => buildPlayerMatchEvidence(workspace, playerId),
    [workspace, playerId],
  );
  if (!evidence) return null;

  const { player } = evidence;
  const actionProps = {
    onWatch,
    onOpenReplay,
    onAddProduction,
    addedEvidenceIds,
    watchEnabled,
    watchUnavailableReason,
    focusedEvidenceId,
    labels: {
      watch: t('analysis.roundContext.watchGame'),
      replay: t('analysis.roundContext.open2d'),
      add: t('analysis.roundContext.addProduction'),
    },
  };
  const utilitySummary = evidence.utility.summary;
  return (
    <section className="player-evidence-workspace" aria-label={t('analysis.playerContext')}>
      <header className="player-evidence-summary" data-testid="player-evidence-summary">
        <div className="player-evidence-summary__identity">
          <span className="eyebrow">PLAYER EVIDENCE · TEAM {player.team}</span>
          <h2>{player.name}</h2>
          <p>{t('analysis.overview.evidenceDescription')}</p>
        </div>
        <dl className="player-evidence-summary__metrics">
          <div><dt>K / D / A</dt><dd>{player.kills} / {player.deaths} / {player.assists}</dd></div>
          <div><dt>ADR</dt><dd>{player.adr.toFixed(1)}</dd></div>
          <div><dt>HS</dt><dd>{percentage(player.headshot_rate)}</dd></div>
        </dl>
      </header>

      <div className="player-evidence-grid">
        <EvidencePanel
          testId="player-evidence-kills"
          icon={<Crosshair size={14} />}
          title={t('analysis.overview.kills')}
          count={evidence.kills.length}
          availability={evidence.availability.kills}
        >
          {evidence.kills.map((kill) => (
            <EvidenceRow
              key={kill.evidence_id}
              evidence={kill}
              icon={<Crosshair size={13} />}
              title={combatTitle(kill.actor_name, kill.target_name)}
              detail={combatDetail(kill.weapon, kill.headshot, kill.penetrated)}
              actions={actionProps}
            />
          ))}
        </EvidencePanel>

        <EvidencePanel
          testId="player-evidence-deaths"
          icon={<ShieldAlert size={14} />}
          title={msg("m0878")}
          count={evidence.deaths.length}
          availability={evidence.availability.deaths}
        >
          {evidence.deaths.map((death) => (
            <EvidenceRow
              key={death.evidence_id}
              evidence={death}
              icon={<ShieldAlert size={13} />}
              title={combatTitle(death.actor_name, death.target_name)}
              detail={combatDetail(death.weapon, death.headshot, death.penetrated)}
              actions={actionProps}
            />
          ))}
        </EvidencePanel>

        <EvidencePanel
          testId="player-evidence-weapons"
          icon={<Crosshair size={14} />}
          title={t('analysis.overview.weapons')}
          count={evidence.weapons.length}
          availability={evidence.availability.weapons}
        >
          <div className="player-evidence-table player-evidence-table--weapons" role="table">
            {evidence.weapons.map((weapon) => (
              <div key={weapon.id} role="row">
                <strong role="cell">{weapon.name.toLocaleUpperCase()}</strong>
                <span role="cell">{weapon.kills} K</span>
                <span role="cell">{weapon.headshots} HS</span>
                <span role="cell">{weapon.damage} DMG</span>
                <small role="cell">{weapon.evidence_ids.length} EVIDENCE</small>
              </div>
            ))}
          </div>
        </EvidencePanel>

        <EvidencePanel
          testId="player-evidence-duels"
          icon={<Swords size={14} />}
          title={t('analysis.overview.duels')}
          count={evidence.duels.length}
          availability={evidence.availability.duels}
        >
          {evidence.duels.map((duel) => (
            <div className="player-evidence-duel" key={duel.id}>
              <div className="player-evidence-duel__summary">
                <strong>{player.name} <span>vs</span> {duel.opponent_name}</strong>
                <span>{duel.kills}–{duel.deaths}</span>
                <small>{duel.damage_dealt === null ? 'DMG —' : `${duel.damage_dealt} DMG`} · {duel.summary_source.toLocaleUpperCase()}</small>
              </div>
              {duel.engagements.map((engagement) => (
                <EvidenceRow
                  key={`${duel.id}:${engagement.evidence_id}:${engagement.perspective}`}
                  evidence={engagement}
                  icon={<Swords size={13} />}
                  title={`${duelLabel(engagement)} · ${duel.opponent_name}`}
                  detail={[
                    engagement.weapon?.toLocaleUpperCase(),
                    engagement.damage === null ? null : `${engagement.damage} DMG`,
                    engagement.headshot ? 'HS' : null,
                  ].filter(Boolean).join(' · ')}
                  actions={actionProps}
                />
              ))}
            </div>
          ))}
        </EvidencePanel>

        <EvidencePanel
          testId="player-evidence-utility"
          icon={<Zap size={14} />}
          title={t('analysis.roundContext.utility')}
          count={evidence.utility.events.length}
          availability={evidence.availability.utility_events}
        >
          <div className="player-evidence-capabilities">
            <CapabilityStatus
              capability="utility-damage"
              label="UTILITY DAMAGE"
              value={evidence.availability.utility_damage}
            />
            <CapabilityStatus
              capability="flash-effects"
              label="FLASH EFFECTS"
              value={evidence.availability.flash_effects}
            />
          </div>
          {utilitySummary ? (
            <dl className="player-evidence-mini-metrics">
              <div><dt>THROWS</dt><dd>{utilitySummary.throws}</dd></div>
              <div><dt>DETONATIONS</dt><dd>{utilitySummary.detonations}</dd></div>
              {evidence.availability.utility_damage.state === 'unavailable'
                ? null
                : <div><dt>UTILITY DMG</dt><dd>{utilitySummary.damage}</dd></div>}
              {evidence.availability.flash_effects.state === 'available'
                ? <div><dt>FLASHED</dt><dd>{utilitySummary.players_flashed}</dd></div>
                : null}
            </dl>
          ) : null}
          {evidence.utility.events.map((utilityEvent) => (
            <EvidenceRow
              key={utilityEvent.evidence_id}
              evidence={utilityEvent}
              icon={<Zap size={13} />}
              title={`${utilityLabel(utilityEvent)} · ${utilityEvent.utility_name.toLocaleUpperCase()}`}
              detail={utilityEvent.damage === null ? undefined : `${utilityEvent.damage} DMG`}
              actions={actionProps}
            />
          ))}
        </EvidencePanel>

        <EvidencePanel
          testId="player-evidence-objectives"
          icon={<Bomb size={14} />}
          title={t('analysis.roundContext.objective')}
          count={evidence.objectives.length}
          availability={evidence.availability.objectives}
        >
          {evidence.objectives.map((objective) => (
            <EvidenceRow
              key={objective.evidence_id}
              evidence={objective}
              icon={<Bomb size={13} />}
              title={`${objectiveLabel(objective)} · ${objective.actor_name ?? player.name}`}
              detail={objective.attribution.replaceAll('_', ' ').toLocaleUpperCase()}
              actions={actionProps}
            />
          ))}
        </EvidencePanel>

        <EvidencePanel
          testId="player-evidence-highlights"
          icon={<Sparkles size={14} />}
          title={t('analysis.tab.highlights')}
          count={evidence.highlights.length}
          availability={evidence.availability.highlights}
        >
          {evidence.highlights.map((highlight) => (
            <EvidenceRow
              key={highlight.evidence_id}
              evidence={highlight}
              icon={<Sparkles size={13} />}
              title={highlight.label}
              detail={highlightDetail(highlight)}
              actions={actionProps}
            />
          ))}
        </EvidencePanel>
      </div>
    </section>
  );
}
