import { currentLocale, msg, msgf, useI18n } from '../../shared/i18n';
import {
  CalendarDays,
  ExternalLink,
  Gamepad2,
  ImageOff,
  ListFilter,
  ShieldCheck,
  UserRound,
} from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router-dom';

import { desktopMediaUrl } from '../../shared/desktop/client';
import { formatKillDeathRatioValue } from '../../shared/performanceMetrics';
import type {
  PlayerAggregateStats,
  PlayerDirectoryItem,
  PlayerProfile,
  PlayerSteamProfile,
  EvidenceSearchResponse,
} from '../../shared/desktop/dto';
import { Badge, EmptyState, Notice } from '../../shared/ui';
import {
  formatOptionalMetric,
  localPlayerAvatarPath,
  playerHeadshotRate,
  playerInitials,
  playerKd,
  steamEvidence,
} from './playerPresentation';
import { evidenceSearchResultHref } from '../evidence-search/evidenceSearchPresentation';

const dateFormatter = new Intl.DateTimeFormat(currentLocale(), {
  dateStyle: 'medium',
  timeStyle: 'short',
});

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? msg("m0717") : dateFormatter.format(date);
}

export function PlayerMonogram({ player }: { player: PlayerDirectoryItem }) {
  return (
    <span className="player-monogram" aria-hidden="true">
      {playerInitials(player.name)}
    </span>
  );
}

export function PlayerAvatar({ player }: { player: PlayerDirectoryItem }) {
  const path = localPlayerAvatarPath(player);
  const [failedPath, setFailedPath] = useState<string | null>(null);
  const showImage = path !== null && failedPath !== path;

  return (
    <div className="player-avatar">
      {showImage ? (
        <img
          src={desktopMediaUrl(path)}
          alt={msgf("m0110", [player.name])}
          decoding="async"
          referrerPolicy="no-referrer"
          onError={() => setFailedPath(path)}
        />
      ) : (
        <PlayerMonogram player={player} />
      )}
    </div>
  );
}

export function SteamEvidenceView({ profile }: { profile: PlayerSteamProfile }) {
  const evidence = steamEvidence(profile);
  return (
    <section className="player-steam-evidence" aria-label={msg("m0069")}>
      <header>
        <div>
          <ShieldCheck size={15} />
          <strong>{msg("m0070")}</strong>
        </div>
        <Badge tone={evidence.tone}>{evidence.label}</Badge>
      </header>
      <p>{evidence.detail}</p>
      {profile.state === 'available' ? (
        <dl>
          <div><dt>{msg("m0237")}</dt><dd>{profile.persona_name ?? msg("m0751")}</dd></div>
          <div><dt>{msg("m0445")}</dt><dd>{profile.real_name ?? msg("m0751")}</dd></div>
          <div><dt>{msg("m0395")}</dt><dd>{profile.country_code ?? msg("m0751")}</dd></div>
          <div><dt>{msg("m1157")}</dt><dd>{profile.created_at ? formatDate(profile.created_at) : msg("m0751")}</dd></div>
          <div><dt>{msg("m0734")}</dt><dd>{profile.last_logoff ? formatDate(profile.last_logoff) : msg("m0751")}</dd></div>
          <div><dt>{msg("m0236")}</dt><dd>{profile.profile_url ? msg("m0533") : msg("m0768")}</dd></div>
        </dl>
      ) : null}
    </section>
  );
}

export function PlayerStatsView({ stats }: { stats: PlayerAggregateStats }) {
  const metrics = [
    [msg("m0797"), String(stats.matches)],
    ['K / D', playerKd(stats)],
    [msg("m0252"), String(stats.kills)],
    [msg("m0878"), String(stats.deaths)],
    [msg("m0308"), String(stats.assists)],
    [msg("m0950"), playerHeadshotRate(stats)],
    [msg("m0550"), formatOptionalMetric(stats.average_adr)],
    [msg("m0551"), formatKillDeathRatioValue(stats.average_kill_death_ratio, 2)],
    [msg("m0617"), stats.damage.toLocaleString('zh-CN')],
  ] as const;

  return (
    <dl className="player-stat-grid" aria-label={msg("m0775")}>
      {metrics.map(([label, value]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function evidenceParticipants(item: EvidenceSearchResponse['items'][number], unknown: string): string {
  const actor = item.actor_name ?? item.actor_id;
  const target = item.target_name ?? item.target_id;
  if (actor && target) return `${actor} → ${target}`;
  const victimNames = Array.isArray(item.attributes.victim_names) ? item.attributes.victim_names : [];
  const victimIds = Array.isArray(item.attributes.victim_ids) ? item.attributes.victim_ids : [];
  const highlightVictims = Array.from({ length: Math.max(victimNames.length, victimIds.length) }, (_, index) => {
    const name = victimNames[index];
    const id = victimIds[index];
    return typeof name === 'string' && name.length > 0
      ? name
      : typeof id === 'string' && id.length > 0
        ? id
        : null;
  }).filter((value): value is string => value !== null);
  if (actor && highlightVictims.length > 0) {
    return `${actor} → ${highlightVictims.join(', ')}`;
  }
  if (actor) return actor;
  if (target) return target;
  return unknown;
}

export function PlayerCrossMatchEvidence({
  playerId,
  evidence,
}: {
  playerId: string;
  evidence: EvidenceSearchResponse;
}) {
  const { t } = useI18n();
  const allEvidenceHref = `/evidence-search?${new URLSearchParams({
    player: playerId,
    page: '1',
    page_size: '50',
  }).toString()}`;
  return (
    <section className="player-cross-match-evidence" aria-label={t('players.evidence.title')}>
      <header>
        <div><ListFilter size={16} /><strong>{t('players.evidence.title')}</strong></div>
        <span>{t('players.evidence.scope')
          .replace('{0}', String(evidence.items.length))
          .replace('{1}', String(evidence.total))
          .replace('{2}', String(evidence.availability.indexed_demos))}</span>
      </header>
      {evidence.items.length > 0 ? (
        <div role="list" aria-label={t('players.evidence.title')}>
          {evidence.items.map((item) => (
            <article key={item.evidence_id} role="listitem" data-evidence-id={item.evidence_id}>
              <div>
                <strong>{evidenceParticipants(item, t('players.evidence.unknownParticipants'))}</strong>
                <span>{item.demo_display_name} · {item.map_name} · R{item.round} / TICK {item.tick}</span>
                <small>{item.weapon ?? item.event_type} · {item.evidence_id}</small>
              </div>
              <nav aria-label={t('players.evidence.actions').replace('{0}', item.evidence_id)}>
                <Link to={evidenceSearchResultHref(item, 'rounds', playerId)}>{t('players.evidence.round')}<ExternalLink size={12} /></Link>
                <Link to={evidenceSearchResultHref(item, 'replay', playerId)}>{t('players.evidence.replay')}<ExternalLink size={12} /></Link>
              </nav>
            </article>
          ))}
        </div>
      ) : (
        <EmptyState
          icon={<ListFilter size={24} />}
          title={t('players.evidence.empty')}
          description={t('players.evidence.emptyDescription')}
        />
      )}
      {!evidence.availability.scan_complete ? (
        <Notice tone="info">{t('evidenceSearch.scanIncomplete')}</Notice>
      ) : null}
      {evidence.total > evidence.items.length ? (
        <Link className="player-cross-match-evidence__all" to={allEvidenceHref}>
          {t('players.evidence.openAll')}<ExternalLink size={12} />
        </Link>
      ) : null}
    </section>
  );
}

export function PlayerDetailView({
  profile,
  evidence = null,
  evidenceLoading = false,
  evidenceError = null,
}: {
  profile: PlayerProfile;
  evidence?: EvidenceSearchResponse | null;
  evidenceLoading?: boolean;
  evidenceError?: string | null;
}) {
  const { t } = useI18n();
  const { player } = profile;
  return (
    <div className="player-detail-view">
      <header className="player-detail-identity">
        <PlayerAvatar player={player} />
        <div>
          <span className="eyebrow">STEAM64 · {player.steam_id}</span>
          <h2>{player.name}</h2>
          <p>
            {player.last_team ? msgf("m0740", [player.last_team]) : msg("m0741")}
            {' · '}

           {msg("m0735")} {formatDate(player.last_match_at)}
          </p>
          {player.aliases.length > 0 ? (
            <small>{msg("m0787")}{player.aliases.join('、')}</small>
          ) : null}
        </div>
      </header>

      {!profile.scan_complete ? (
        <Notice tone="warning">

         {msg("m0589")} {profile.scanned_demos} {msg("m0201")}
        </Notice>
      ) : null}

      <PlayerStatsView stats={player.stats} />
      <SteamEvidenceView profile={player.steam} />

      {evidenceLoading ? (
        <div className="player-cross-match-evidence__loading">{t('players.evidence.loading')}</div>
      ) : evidenceError ? (
        <Notice tone="danger">{evidenceError}</Notice>
      ) : evidence ? (
        <PlayerCrossMatchEvidence playerId={player.steam_id} evidence={evidence} />
      ) : null}

      <section className="player-recent-matches">
        <header>
          <div><Gamepad2 size={16} /><strong>{msg("m0738")}</strong></div>
          <span>{msg("m0182")}</span>
        </header>
        {profile.recent_matches.length > 0 ? (
          <div role="list" aria-label={msg("m0738")}>
            {profile.recent_matches.map((match) => (
              <article key={match.demo_id} role="listitem">
                <div className="player-match-main">
                  <strong>{match.map_name ?? msg("m0398")}</strong>
                  <span><CalendarDays size={12} />{formatDate(match.played_at)}</span>
                  <small title={match.demo_name}>{match.demo_name}</small>
                </div>
                <div className="player-match-team">
                  <span>{msg("m1283")}</span>
                  <strong>{match.team ?? '—'}</strong>
                </div>
                <dl>
                  <div><dt>K / D / A</dt><dd>{match.kills} / {match.deaths} / {match.assists}</dd></div>
                  <div><dt>ADR</dt><dd>{formatOptionalMetric(match.adr)}</dd></div>
                  <div><dt>K/D</dt><dd>{formatKillDeathRatioValue(match.kill_death_ratio, 2)}</dd></div>
                </dl>
                <Link to={`/analysis?demo=${encodeURIComponent(match.demo_id)}`}>

                 {msg("m0814")}<ExternalLink size={12} />
                </Link>
              </article>
            ))}
          </div>
        ) : (
          <EmptyState
            icon={<ImageOff size={24} />}
            title={msg("m0897")}
            description={msg("m1122")}
          />
        )}
      </section>
    </div>
  );
}

export function PlayerDetailPlaceholder() {
  return (
    <EmptyState
      icon={<UserRound size={28} />}
      title={msg("m1228")}
      description={msg("m1127")}
    />
  );
}
