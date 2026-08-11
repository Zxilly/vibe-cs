import { currentLocale, msg, msgf } from '../../shared/i18n';
import {
  CalendarDays,
  ExternalLink,
  Gamepad2,
  ImageOff,
  ShieldCheck,
  UserRound,
} from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router-dom';

import { desktopMediaUrl } from '../../shared/desktop/client';
import type {
  PlayerAggregateStats,
  PlayerDirectoryItem,
  PlayerProfile,
  PlayerSteamProfile,
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
    [msg("m0551"), formatOptionalMetric(stats.average_rating, 2)],
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

export function PlayerDetailView({ profile }: { profile: PlayerProfile }) {
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
                  <div><dt>Rating</dt><dd>{formatOptionalMetric(match.rating, 2)}</dd></div>
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
