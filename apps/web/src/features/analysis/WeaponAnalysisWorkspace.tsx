import {
  Check,
  Crosshair,
  ListFilter,
  Map as MapIcon,
  Play,
  Plus,
  Target,
} from 'lucide-react';
import { useMemo, useState } from 'react';

import type { AnalysisWorkspace } from '../../shared/desktop/viewModels';
import { useI18n } from '../../shared/i18n';
import { Badge, Button, EmptyState } from '../../shared/ui';
import type { AnalysisNavigationPatch } from './analysisNavigation';
import { weaponEvidenceActionContract } from './weaponEvidenceActions';
import {
  buildWeaponEvidenceWorkspace,
  type WeaponAtomicEvidence,
} from './weaponEvidenceWorkspace';
import './WeaponAnalysisWorkspace.css';

export type WeaponAnalysisWorkspaceProps = {
  workspace: AnalysisWorkspace;
  selectedPlayerId?: string | null;
  selectedRound?: number | null;
  serviceAvailable: boolean;
  runtimeIdle: boolean;
  watchPending: boolean;
  onNavigate: (navigation: AnalysisNavigationPatch) => void;
  onWatch: (evidence: WeaponAtomicEvidence) => void;
  onAddProduction: (evidence: WeaponAtomicEvidence) => void;
  addedEvidenceIds?: ReadonlySet<string>;
  focusedEvidenceId?: string | null;
};

function metricTone(state: 'available' | 'partial' | 'unavailable') {
  if (state === 'available') return 'success' as const;
  if (state === 'partial') return 'warning' as const;
  return 'neutral' as const;
}

function eventFlags(evidence: WeaponAtomicEvidence): string {
  if (evidence.event_kind === 'damage') {
    return evidence.damage === null ? 'DMG —' : String(evidence.damage) + ' DMG';
  }
  return [evidence.headshot ? 'HS' : null, evidence.penetrated ? 'WALLBANG' : null]
    .filter(Boolean)
    .join(' · ') || 'KILL';
}

export function WeaponAnalysisWorkspace({
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
}: WeaponAnalysisWorkspaceProps) {
  const { t } = useI18n();
  const [selectedWeaponName, setSelectedWeaponName] = useState<string | null>(null);
  const evidenceWorkspace = useMemo(
    () => buildWeaponEvidenceWorkspace(workspace, {
      playerId: selectedPlayerId,
      round: selectedRound,
    }),
    [workspace, selectedPlayerId, selectedRound],
  );
  const selectedWeapon = evidenceWorkspace.weapons.find(
    (weapon) => weapon.name === selectedWeaponName,
  ) ?? null;
  const evidenceCount = evidenceWorkspace.weapons.reduce(
    (total, weapon) => total + weapon.evidence.length,
    0,
  );
  const visibleEvidence = (selectedWeapon
    ? selectedWeapon.evidence
    : evidenceWorkspace.weapons.flatMap((weapon) => weapon.evidence))
    .sort((left, right) => left.tick - right.tick || left.evidence_id.localeCompare(right.evidence_id));
  const totalKills = evidenceWorkspace.weapons.reduce((total, weapon) => total + weapon.kills, 0);
  const totalHeadshotKills = evidenceWorkspace.weapons.reduce(
    (total, weapon) => total + weapon.headshot_kills,
    0,
  );
  const totalDamageEvents = evidenceWorkspace.weapons.reduce(
    (total, weapon) => total + weapon.damage_events,
    0,
  );
  const totalDamage = totalDamageEvents > 0
    ? evidenceWorkspace.weapons.reduce((total, weapon) => total + (weapon.damage ?? 0), 0)
    : null;
  const visibleKills = selectedWeapon ? selectedWeapon.kills : totalKills;
  const visibleHeadshotKills = selectedWeapon ? selectedWeapon.headshot_kills : totalHeadshotKills;
  const visibleDamageEvents = selectedWeapon ? selectedWeapon.damage_events : totalDamageEvents;
  const visibleDamage = selectedWeapon ? selectedWeapon.damage : totalDamage;

  return (
    <section
      className="weapon-analysis-workspace"
      data-testid="weapon-evidence-workspace"
      aria-label={t('analysis.weapons.title')}
    >
      <header className="weapon-analysis-toolbar">
        <div className="weapon-analysis-toolbar__title">
          <span className="eyebrow">{t('analysis.weapons.eyebrow')}</span>
          <h2>{t('analysis.weapons.title')}</h2>
          <p>{t('analysis.weapons.description')}</p>
        </div>
        <div className="weapon-analysis-filters">
          <label>
            <span>{t('analysis.weapons.playerFilter')}</span>
            <select
              data-testid="weapon-filter-player"
              value={selectedPlayerId ?? ''}
              onChange={(event) => onNavigate({
                playerId: event.target.value || null,
                tick: null,
                evidenceId: null,
              })}
            >
              <option value="">{t('analysis.weapons.allPlayers')}</option>
              {workspace.players.map((player) => (
                <option value={player.id} key={player.id}>{player.name}</option>
              ))}
            </select>
          </label>
          <label>
            <span>{t('analysis.weapons.roundFilter')}</span>
            <select
              data-testid="weapon-filter-round"
              value={selectedRound ?? ''}
              onChange={(event) => onNavigate({
                round: event.target.value ? Number(event.target.value) : null,
                tick: null,
                evidenceId: null,
              })}
            >
              <option value="">{t('analysis.weapons.allRounds')}</option>
              {workspace.rounds.map((item) => (
                <option value={item.number} key={item.number}>R{item.number}</option>
              ))}
            </select>
          </label>
        </div>
        <div className="weapon-analysis-truth">
          <span><strong>{evidenceWorkspace.weapons.length}</strong>{t('analysis.weapons.weaponCount')}</span>
          <span><strong>{evidenceCount}</strong>{t('analysis.weapons.evidenceCount')}</span>
          <span title={evidenceWorkspace.availability.damage.reason ?? undefined}>
            <Badge tone={metricTone(evidenceWorkspace.availability.damage.state)}>
              {t('analysis.weapons.verifiedDamage')}
            </Badge>
          </span>
          <span title={evidenceWorkspace.availability.hits.reason ?? undefined}>
            <Badge tone="neutral">{t('analysis.weapons.hitsUnavailable')}</Badge>
          </span>
        </div>
      </header>

      {evidenceWorkspace.weapons.length > 0 ? (
        <div className="weapon-analysis-canvas">
          <aside className="weapon-analysis-ranking" aria-label={t('analysis.weapons.weaponRanking')}>
            <header>
              <span>{t('analysis.weapons.weaponRanking')}</span>
              <small>{evidenceWorkspace.weapons.length}</small>
            </header>
            <div role="listbox" aria-label={t('analysis.weapons.weaponRanking')}>
              <button
                type="button"
                role="option"
                aria-selected={selectedWeapon === null}
                className={selectedWeapon === null ? 'is-active' : undefined}
                data-weapon-name="all"
                onClick={() => setSelectedWeaponName(null)}
              >
                <span className="weapon-analysis-ranking__identity">
                  <Target size={14} />
                  <strong>{t('analysis.weapons.allWeapons')}</strong>
                  <small>{evidenceCount} {t('analysis.weapons.evidenceCount')}</small>
                </span>
                <dl>
                  <div><dt>K</dt><dd>{totalKills}</dd></div>
                  <div><dt>HS</dt><dd>{totalHeadshotKills}</dd></div>
                  <div><dt>DMG</dt><dd>{totalDamage ?? '—'}</dd></div>
                  <div><dt>EVT</dt><dd>{totalDamageEvents}</dd></div>
                </dl>
              </button>
              {evidenceWorkspace.weapons.map((weapon) => (
                <button
                  type="button"
                  role="option"
                  aria-selected={selectedWeapon?.name === weapon.name}
                  className={selectedWeapon?.name === weapon.name ? 'is-active' : undefined}
                  data-weapon-name={weapon.name}
                  key={weapon.id}
                  onClick={() => setSelectedWeaponName(weapon.name)}
                >
                  <span className="weapon-analysis-ranking__identity">
                    <Crosshair size={14} />
                    <strong>{weapon.name.toLocaleUpperCase()}</strong>
                    <small>{weapon.evidence.length} {t('analysis.weapons.evidenceCount')}</small>
                  </span>
                  <dl>
                    <div><dt>K</dt><dd>{weapon.kills}</dd></div>
                    <div><dt>HS</dt><dd>{weapon.headshot_kills}</dd></div>
                    <div title={weapon.damage_availability.reason ?? undefined}>
                      <dt>DMG</dt><dd>{weapon.damage ?? '—'}</dd>
                    </div>
                    <div><dt>EVT</dt><dd>{weapon.damage_events}</dd></div>
                  </dl>
                </button>
              ))}
            </div>
          </aside>

          <section className="weapon-analysis-evidence" aria-label={t('analysis.weapons.atomicEvidence')}>
            <header>
              <div>
                <span className="eyebrow">{t('analysis.weapons.atomicEvidence')}</span>
                <h3>{selectedWeapon ? selectedWeapon.name.toLocaleUpperCase() : t('analysis.weapons.allWeapons')}</h3>
              </div>
              <dl>
                <div><dt>{t('analysis.overview.kills')}</dt><dd>{visibleKills}</dd></div>
                <div><dt>{t('analysis.weapons.headshotKills')}</dt><dd>{visibleHeadshotKills}</dd></div>
                <div title={selectedWeapon?.damage_availability.reason ?? evidenceWorkspace.availability.damage.reason ?? undefined}>
                  <dt>{t('analysis.weapons.verifiedDamage')}</dt><dd>{visibleDamage ?? '—'}</dd>
                </div>
                <div><dt>{t('analysis.weapons.damageEvents')}</dt><dd>{visibleDamageEvents}</dd></div>
              </dl>
            </header>
            <div className="weapon-analysis-evidence__head" aria-hidden="true">
              <span>{t('analysis.weapons.columnType')}</span>
              <span>{t('analysis.weapons.columnParticipants')}</span>
              <span>{t('analysis.weapons.columnLocation')}</span>
              <span>{t('analysis.weapons.columnValue')}</span>
              <span>{t('analysis.weapons.columnActions')}</span>
            </div>
            <div className="weapon-analysis-evidence__rows">
              {visibleEvidence.map((item) => {
                const added = addedEvidenceIds?.has(item.evidence_id) ?? false;
                const actions = weaponEvidenceActionContract(workspace, item, {
                  serviceAvailable,
                  runtimeIdle,
                  watchPending,
                  alreadyAdded: added,
                });
                const roundLabel = t('analysis.weapons.openRound');
                const replayLabel = t('analysis.roundContext.open2d');
                const watchLabel = t('analysis.roundContext.watchGame');
                const addLabel = t('analysis.roundContext.addProduction');
                return (
                  <article
                    className={'weapon-analysis-evidence-row' + (focusedEvidenceId === item.evidence_id ? ' is-focused' : '')}
                    data-testid="weapon-evidence-row"
                    data-evidence-id={item.evidence_id}
                    aria-current={focusedEvidenceId === item.evidence_id ? 'true' : undefined}
                    key={item.evidence_id}
                  >
                    <span className={'weapon-analysis-event-kind weapon-analysis-event-kind--' + item.event_kind}>
                      {item.event_kind === 'kill'
                        ? t('analysis.weapons.killEvent')
                        : t('analysis.weapons.damageEvent')}
                    </span>
                    <span className="weapon-analysis-participants">
                      <strong>{item.actor_name ?? '—'} <i aria-hidden="true">→</i> {item.target_name ?? '—'}</strong>
                      <small>{item.weapon.toLocaleUpperCase()}</small>
                    </span>
                    <span className="weapon-analysis-location">
                      <strong>R{item.round}</strong>
                      <small>tick {item.tick}</small>
                    </span>
                    <span className="weapon-analysis-flags">{eventFlags(item)}</span>
                    <span className="weapon-analysis-actions">
                      <Button
                        size="sm"
                        variant="ghost"
                        data-action="round"
                        disabled={!actions.round.available}
                        title={actions.round.reason ?? roundLabel}
                        aria-label={roundLabel + ' · R' + item.round + ' tick ' + item.tick}
                        onClick={() => onNavigate(actions.round.navigation)}
                      >
                        <ListFilter size={12} /><span>{roundLabel}</span>
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        data-action="replay"
                        disabled={!actions.replay.available}
                        title={actions.replay.reason ?? replayLabel}
                        aria-label={replayLabel + ' · R' + item.round + ' tick ' + item.tick}
                        onClick={() => onNavigate(actions.replay.navigation)}
                      >
                        <MapIcon size={12} /><span>{replayLabel}</span>
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        data-action="watch"
                        disabled={!actions.watch.available}
                        title={actions.watch.reason ?? watchLabel}
                        aria-label={watchLabel + ' · R' + item.round + ' tick ' + item.tick}
                        onClick={() => onWatch(item)}
                      >
                        <Play size={12} /><span>{watchLabel}</span>
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        data-action="add"
                        disabled={!actions.add.available}
                        title={actions.add.reason ?? addLabel}
                        aria-label={addLabel + ' · R' + item.round + ' tick ' + item.tick}
                        onClick={() => onAddProduction(item)}
                      >
                        {added ? <Check size={12} /> : <Plus size={12} />}<span>{addLabel}</span>
                      </Button>
                    </span>
                  </article>
                );
              })}
            </div>
          </section>
        </div>
      ) : (
        <div className="weapon-analysis-empty">
          <EmptyState
            icon={<Target size={22} />}
            title={t('analysis.weapons.noEvidence')}
            description={t('analysis.weapons.noEvidenceDescription')}
          />
        </div>
      )}
    </section>
  );
}
