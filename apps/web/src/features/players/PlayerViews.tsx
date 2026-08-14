import { currentLocale, msg, msgf, useI18n } from '../../shared/i18n';
import {
  CalendarDays,
  ChartNoAxesColumnIncreasing,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  Gamepad2,
  ImageOff,
  ListFilter,
  RefreshCw,
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
  PlayerHeatmap,
  PlayerMapPage,
  PlayerMatchPage,
  PlayerProfile,
  PlayerSteamProfile,
  EvidenceSearchResponse,
  RadarOverviewRecord,
} from '../../shared/desktop/dto';
import { Badge, Button, EmptyState, Notice, Spinner } from '../../shared/ui';
import {
  formatOptionalMetric,
  localPlayerAvatarPath,
  playerHeadshotRate,
  playerInitials,
  playerKd,
  playerMatchResultRange,
  steamEvidence,
} from './playerPresentation';
import { evidenceSearchResultHref } from '../evidence-search/evidenceSearchPresentation';
import { PlayerHeatmapWorkspace } from './PlayerHeatmapWorkspace';
import { PlayerTrendWorkspace } from './PlayerTrendWorkspace';

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
  matches,
  maps = null,
  mapsLoading = false,
  mapsError = null,
  onRetryMaps = () => undefined,
  onPreviousMaps = () => undefined,
  onNextMaps = () => undefined,
  heatmap = null,
  heatmapMap = null,
  heatmapKind = 'all',
  heatmapLoading = false,
  heatmapError = null,
  heatmapRadar = null,
  onOpenHeatmap = () => undefined,
  onCloseHeatmap = () => undefined,
  onHeatmapKindChange = () => undefined,
  onRetryHeatmap = () => undefined,
  matchesLoading = false,
  matchesError = null,
  onRetryMatches = () => undefined,
  onPreviousMatches = () => undefined,
  onNextMatches = () => undefined,
  evidence = null,
  evidenceLoading = false,
  evidenceError = null,
}: {
  profile: PlayerProfile;
  matches: PlayerMatchPage | null;
  maps?: PlayerMapPage | null;
  mapsLoading?: boolean;
  mapsError?: string | null;
  onRetryMaps?: () => void;
  onPreviousMaps?: () => void;
  onNextMaps?: () => void;
  heatmap?: PlayerHeatmap | null;
  heatmapMap?: string | null;
  heatmapKind?: 'all' | 'kills' | 'deaths';
  heatmapLoading?: boolean;
  heatmapError?: string | null;
  heatmapRadar?: RadarOverviewRecord | null;
  onOpenHeatmap?: (mapName: string) => void;
  onCloseHeatmap?: () => void;
  onHeatmapKindChange?: (kind: 'all' | 'kills' | 'deaths') => void;
  onRetryHeatmap?: () => void;
  matchesLoading?: boolean;
  matchesError?: string | null;
  onRetryMatches?: () => void;
  onPreviousMatches?: () => void;
  onNextMatches?: () => void;
  evidence?: EvidenceSearchResponse | null;
  evidenceLoading?: boolean;
  evidenceError?: string | null;
}) {
  const { t } = useI18n();
  const { player } = profile;
  const latestMatchDate = player.last_match_date
    ? formatDate(player.last_match_date)
    : t('players.matches.dateUnavailable');
  const projectionCopy = t('players.projection.incomplete')
    .replace('{projected}', String(profile.coverage.projected_demos))
    .replace('{total}', String(profile.coverage.total_analyses));
  return (
    <div className="player-detail-view">
      <header className="player-detail-identity">
        <PlayerAvatar player={player} />
        <div>
          <span className="eyebrow">STEAM64 · {player.steam_id}</span>
          <h2>{player.name}</h2>
          <p>
            {player.last_team
              ? t('players.profile.latestCatalogedTeam').replace('{team}', player.last_team)
              : t('players.profile.teamUnavailable')}
            {' · '}

           {t('players.matches.latestDate').replace('{date}', latestMatchDate)}
          </p>
          <small>{t('players.matches.catalogedAt').replace(
            '{date}',
            formatDate(player.last_cataloged_at),
          )}</small>
          {player.aliases_total > 0 ? (
            <small>{t('players.profile.aliases')
              .replace('{visible}', String(player.aliases.length))
              .replace('{total}', String(player.aliases_total))}{player.aliases.join('、')}</small>
          ) : null}
        </div>
      </header>

      {!profile.coverage.projection_complete ? (
        <Notice tone="warning">{projectionCopy}</Notice>
      ) : null}

      <PlayerStatsView stats={player.stats} />
      <SteamEvidenceView profile={player.steam} />

      <section className="player-map-performance" aria-label={t('players.maps.title')}>
          <header>
            <div><ChartNoAxesColumnIncreasing size={16} /><strong>{t('players.maps.title')}</strong></div>
            <span>{t('players.maps.scope')}</span>
          </header>
          {mapsLoading && !maps ? (
            <div className="players-loading"><Spinner label={t('players.maps.loading')} /></div>
          ) : mapsError ? (
            <Notice tone="danger" title={t('players.maps.error')}>
              <span>{mapsError}</span>
              <Button size="sm" variant="ghost" onClick={onRetryMaps}>
                <RefreshCw size={13} />{t('common.retry')}
              </Button>
            </Notice>
          ) : maps && maps.items.length > 0 ? (
          <div role="list" aria-label={t('players.maps.title')}>
            {maps.items.map((map) => (
              <article key={map.map_name ?? '__unknown__'} role="listitem">
                <div className="player-map-performance__identity">
                  <strong>{map.map_name ?? t('players.maps.unknown')}</strong>
                  <span>{t('players.maps.matches').replace('{count}', String(map.stats.matches))}</span>
                  {map.map_name ? (
                    <Button
                      size="sm"
                      variant={heatmapMap === map.map_name ? 'primary' : 'ghost'}
                      aria-pressed={heatmapMap === map.map_name}
                      onClick={() => onOpenHeatmap(map.map_name as string)}
                    >{t('players.heatmap.open')}</Button>
                  ) : null}
                </div>
                <div
                  className="player-map-performance__bar"
                  aria-label={t('players.maps.barLabel')
                    .replace('{map}', map.map_name ?? t('players.maps.unknown'))
                    .replace('{count}', String(map.stats.matches))}
                >
                  <span style={{ width: `${Math.max(4, (map.stats.matches / Math.max(1, maps.items[0]?.stats.matches ?? 1)) * 100)}%` }} />
                </div>
                <dl>
                  <div><dt>K / D / A</dt><dd>{map.stats.kills} / {map.stats.deaths} / {map.stats.assists}</dd></div>
                  <div><dt>ADR</dt><dd>{formatOptionalMetric(map.stats.average_adr)}</dd></div>
                  <div><dt>K/D</dt><dd>{formatKillDeathRatioValue(map.stats.average_kill_death_ratio, 2)}</dd></div>
                </dl>
              </article>
            ))}
          </div>
          ) : (
            <EmptyState
              icon={<ChartNoAxesColumnIncreasing size={24} />}
              title={t('players.maps.empty')}
              description={t('players.maps.emptyDescription')}
            />
          )}
          {maps && maps.total > 0 ? (
            <footer>
              <Button size="sm" disabled={maps.page <= 1} onClick={onPreviousMaps}>
                <ChevronLeft size={13} />{t('common.previous')}
              </Button>
              <span>{maps.page} / {Math.max(1, Math.ceil(maps.total / maps.page_size))}</span>
              <Button
                size="sm"
                disabled={maps.page >= Math.ceil(maps.total / maps.page_size)}
                onClick={onNextMaps}
              >{t('common.next')}<ChevronRight size={13} /></Button>
            </footer>
          ) : null}
        </section>

      {heatmapMap ? (
        heatmapLoading && !heatmap ? (
          <div className="players-loading player-heatmap-loading">
            <Spinner label={t('players.heatmap.title')} />
            <strong>{t('players.heatmap.title')}</strong>
          </div>
        ) : heatmapError ? (
          <Notice tone="danger" title={t('players.heatmap.title')}>
            <span>{heatmapError}</span>
            <Button size="sm" variant="ghost" onClick={onRetryHeatmap}>
              <RefreshCw size={13} />{t('common.retry')}
            </Button>
          </Notice>
        ) : heatmap ? (
          <PlayerHeatmapWorkspace
            key={`${heatmap.steam_id}:${heatmap.map_name}`}
            heatmap={heatmap}
            radar={heatmapRadar}
            kind={heatmapKind}
            onKindChange={onHeatmapKindChange}
            onClose={onCloseHeatmap}
          />
        ) : null
      ) : null}

      {evidenceLoading ? (
        <div className="player-cross-match-evidence__loading">{t('players.evidence.loading')}</div>
      ) : evidenceError ? (
        <Notice tone="danger">{evidenceError}</Notice>
      ) : evidence ? (
        <PlayerCrossMatchEvidence playerId={player.steam_id} evidence={evidence} />
      ) : null}

      {matches && matches.items.length > 0 ? <PlayerTrendWorkspace matches={matches} /> : null}

      <section className="player-match-history">
        <header>
          <div><Gamepad2 size={16} /><strong>{t('players.matches.title')}</strong></div>
          <span>{matches ? `${playerMatchResultRange(matches)} · ${msg("m0182")}` : msg("m0182")}</span>
        </header>
        <p className="player-match-history__scope">{t('players.matches.order')}</p>
        {matches && !matches.coverage.projection_complete ? (
          <Notice tone="warning">
            {t('players.projection.incomplete')
              .replace('{projected}', String(matches.coverage.projected_demos))
              .replace('{total}', String(matches.coverage.total_analyses))}
          </Notice>
        ) : null}
        {matchesLoading && !matches ? (
          <div className="players-loading">
            <Spinner label={t('players.matches.loading')} />
            <strong>{t('players.matches.loading')}</strong>
          </div>
        ) : matchesError ? (
          <Notice
            tone="danger"
            title={t('players.matches.error')}
            className="player-match-history__error"
          >
            <span>{matchesError}</span>
            <Button size="sm" variant="ghost" onClick={onRetryMatches}>
              <RefreshCw size={13} />{t('players.matches.retry')}
            </Button>
          </Notice>
        ) : matches && matches.items.length > 0 ? (
          <div role="list" aria-label={t('players.matches.title')}>
            {matches.items.map((match) => (
              <article key={match.demo_id} role="listitem">
                <div className="player-match-main">
                  <strong>{match.map_name ?? msg("m0398")}</strong>
                  <span><CalendarDays size={12} />{match.match_date
                    ? formatDate(match.match_date)
                    : t('players.matches.dateUnavailable')}</span>
                  <small title={match.demo_name}>{match.demo_name}</small>
                  <small>{t('players.matches.catalogedAt').replace(
                    '{date}',
                    formatDate(match.cataloged_at),
                  )}</small>
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
                <nav aria-label={`${match.demo_name} · ${player.name}`}>
                  <Link to={`/analysis?${new URLSearchParams({
                    demo: match.demo_id,
                    tab: 'players',
                    player: player.steam_id,
                  }).toString()}`}>
                    {msg("m0814")}<ExternalLink size={12} />
                  </Link>
                  <Link to={`/evidence-search?${new URLSearchParams({
                    player: player.steam_id,
                    demo_id: match.demo_id,
                    page: '1',
                    page_size: '50',
                  }).toString()}`}>
                    {t('players.evidence.title')}<ExternalLink size={12} />
                  </Link>
                </nav>
              </article>
            ))}
          </div>
        ) : (
          <EmptyState
            icon={<ImageOff size={24} />}
            title={t('players.matches.empty')}
            description={t('players.matches.emptyDescription')}
          />
        )}
        {matches && matches.total > 0 ? (
          <footer>
            <Button
              size="sm"
              disabled={matches.page <= 1}
              onClick={onPreviousMatches}
            ><ChevronLeft size={13} />{t('common.previous')}</Button>
            <span>{matches.page} / {Math.max(1, Math.ceil(matches.total / matches.page_size))}</span>
            <Button
              size="sm"
              disabled={matches.page >= Math.ceil(matches.total / matches.page_size)}
              onClick={onNextMatches}
            >{t('common.next')}<ChevronRight size={13} /></Button>
          </footer>
        ) : null}
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
