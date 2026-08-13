import { GitCompareArrows, MoreHorizontal } from 'lucide-react';

import { currentLocale, useI18n } from '../../shared/i18n';
import type { PlayerDirectoryItem } from '../../shared/desktop/dto';
import { formatKillDeathRatio } from '../../shared/performanceMetrics';
import { Badge, Button, Card, IconButton, Notice } from '../../shared/ui';
import {
  formatOptionalMetric,
  playerHeadshotRate,
  steamEvidence,
  type PlayerDirectorySort,
} from './playerPresentation';
import { PlayerAvatar, PlayerMonogram } from './PlayerViews';

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return '—';
  return new Intl.DateTimeFormat(currentLocale(), {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

function PlayerSortHeader({
  label,
  sortKey,
  sort,
  onSort,
}: {
  label: string;
  sortKey: PlayerDirectorySort['key'];
  sort: PlayerDirectorySort;
  onSort: (key: PlayerDirectorySort['key']) => void;
}) {
  const active = sort.key === sortKey;
  return (
    <th scope="col" aria-sort={active ? (sort.direction === 'asc' ? 'ascending' : 'descending') : 'none'}>
      <button type="button" onClick={() => onSort(sortKey)}>
        {label}<span aria-hidden="true">{active ? (sort.direction === 'asc' ? '↑' : '↓') : '↕'}</span>
      </button>
    </th>
  );
}

export function PlayerPowerTable({
  players,
  comparedIds,
  sort,
  onSort,
  onToggleCompare,
  onInspect,
}: {
  players: readonly PlayerDirectoryItem[];
  comparedIds: ReadonlySet<string>;
  sort: PlayerDirectorySort;
  onSort: (key: PlayerDirectorySort['key']) => void;
  onToggleCompare: (player: PlayerDirectoryItem) => void;
  onInspect: (player: PlayerDirectoryItem) => void;
}) {
  const { t } = useI18n();
  return (
    <div className="player-power-table__scroll">
      <table className="player-power-table" aria-label={t('players.table.label')}>
        <thead>
          <tr>
            <th className="player-power-table__select" scope="col"><span className="sr-only">{t('players.table.addCompare')}</span></th>
            <PlayerSortHeader label={t('players.table.player')} sortKey="player" sort={sort} onSort={onSort} />
            <PlayerSortHeader label={t('players.table.team')} sortKey="team" sort={sort} onSort={onSort} />
            <PlayerSortHeader label={t('players.table.matches')} sortKey="matches" sort={sort} onSort={onSort} />
            <PlayerSortHeader label={t('players.table.kd')} sortKey="kd" sort={sort} onSort={onSort} />
            <PlayerSortHeader label={t('players.table.kills')} sortKey="kills" sort={sort} onSort={onSort} />
            <PlayerSortHeader label={t('players.table.deaths')} sortKey="deaths" sort={sort} onSort={onSort} />
            <PlayerSortHeader label={t('players.table.assists')} sortKey="assists" sort={sort} onSort={onSort} />
            <PlayerSortHeader label={t('players.table.headshots')} sortKey="headshots" sort={sort} onSort={onSort} />
            <PlayerSortHeader label={t('players.table.adr')} sortKey="adr" sort={sort} onSort={onSort} />
            <PlayerSortHeader label={t('players.table.damage')} sortKey="damage" sort={sort} onSort={onSort} />
            <PlayerSortHeader label={t('players.table.lastMatch')} sortKey="last_match" sort={sort} onSort={onSort} />
            <th scope="col">{t('players.table.steam')}</th>
            <th className="player-power-table__actions" scope="col">{t('players.table.actions')}</th>
          </tr>
        </thead>
        <tbody>
          {players.map((player) => {
            const compared = comparedIds.has(player.steam_id);
            const evidence = steamEvidence(player.steam);
            return (
              <tr key={player.steam_id} className={compared ? 'is-compared' : undefined} aria-selected={compared}>
                <td className="player-power-table__select">
                  <input
                    type="checkbox"
                    checked={compared}
                    aria-label={`${compared ? t('players.table.removeCompare') : t('players.table.addCompare')} · ${player.name}`}
                    onChange={() => onToggleCompare(player)}
                  />
                </td>
                <td className="player-power-table__identity">
                  <PlayerMonogram player={player} />
                  <span><strong>{player.name}</strong><small>{player.steam_id}</small></span>
                </td>
                <td>{player.last_team?.trim() || '—'}</td>
                <td className="player-power-table__number">{player.stats.matches}</td>
                <td className="player-power-table__number">{formatKillDeathRatio(player.stats)}</td>
                <td className="player-power-table__number">{player.stats.kills}</td>
                <td className="player-power-table__number">{player.stats.deaths}</td>
                <td className="player-power-table__number">{player.stats.assists}</td>
                <td className="player-power-table__number">{playerHeadshotRate(player.stats)}</td>
                <td className="player-power-table__number">{formatOptionalMetric(player.stats.average_adr)}</td>
                <td className="player-power-table__number">{player.stats.damage.toLocaleString(currentLocale())}</td>
                <td className="player-power-table__date">{formatDate(player.last_match_at)}</td>
                <td><Badge tone={evidence.tone}>{evidence.label}</Badge></td>
                <td className="player-power-table__actions">
                  <Button size="sm" onClick={() => onToggleCompare(player)}>
                    <GitCompareArrows size={13} />{compared ? t('players.table.removeCompare') : t('players.table.addCompare')}
                  </Button>
                  <IconButton label={t('players.table.details')} onClick={() => onInspect(player)}>
                    <MoreHorizontal size={15} />
                  </IconButton>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function formatTemplate(template: string, values: Record<string, number>): string {
  return Object.entries(values).reduce(
    (result, [key, value]) => result.replaceAll(`{${key}}`, String(value)),
    template,
  );
}

export function PlayerDirectoryScope({
  page,
  pages,
  visible,
  total,
}: {
  page: number;
  pages: number;
  visible: number;
  total: number;
}) {
  const { t } = useI18n();
  return (
    <div className="player-directory-scope" role="status">
      <strong>{formatTemplate(t('players.table.scope'), { page, pages, visible, total })}</strong>
      <span>{t('players.table.scopeBehavior')}</span>
    </div>
  );
}

export function PlayerComparisonSelectionBar({
  count,
  onOpen,
  onClear,
}: {
  count: number;
  onOpen: () => void;
  onClear: () => void;
}) {
  const { t } = useI18n();
  return (
    <div className="player-comparison-selection" role="status">
      <strong><GitCompareArrows size={14} />{formatTemplate(t('players.compare.selection'), { count })}</strong>
      <div>
        <Button size="sm" onClick={onClear}>{t('players.compare.clear')}</Button>
        <Button size="sm" variant="primary" onClick={onOpen}>{t('players.compare.open')}</Button>
      </div>
    </div>
  );
}

export function PlayerCompareInspector({
  players,
  scannedDemos,
  scanComplete,
  onFocus,
  onClear,
}: {
  players: readonly [PlayerDirectoryItem, PlayerDirectoryItem];
  scannedDemos: number;
  scanComplete: boolean;
  onFocus: (player: PlayerDirectoryItem) => void;
  onClear: () => void;
}) {
  const { t } = useI18n();
  const metrics = [
    [t('players.table.matches'), (player: PlayerDirectoryItem) => String(player.stats.matches)],
    [t('players.table.kd'), (player: PlayerDirectoryItem) => formatKillDeathRatio(player.stats)],
    [t('players.table.kills'), (player: PlayerDirectoryItem) => player.stats.kills.toLocaleString(currentLocale())],
    [t('players.table.deaths'), (player: PlayerDirectoryItem) => player.stats.deaths.toLocaleString(currentLocale())],
    [t('players.table.assists'), (player: PlayerDirectoryItem) => player.stats.assists.toLocaleString(currentLocale())],
    [t('players.table.headshots'), (player: PlayerDirectoryItem) => playerHeadshotRate(player.stats)],
    [t('players.table.adr'), (player: PlayerDirectoryItem) => formatOptionalMetric(player.stats.average_adr)],
    [t('players.compare.averageKd'), (player: PlayerDirectoryItem) => formatOptionalMetric(player.stats.average_kill_death_ratio, 2)],
    [t('players.table.damage'), (player: PlayerDirectoryItem) => player.stats.damage.toLocaleString(currentLocale())],
  ] as const;

  return (
    <Card className="player-compare-inspector" role="complementary" aria-label={t('players.compare.title')}>
      <header>
        <div><span className="eyebrow">PLAYER COMPARISON</span><h2>{t('players.compare.title')}</h2></div>
        <Button size="sm" onClick={onClear}>{t('players.compare.clear')}</Button>
      </header>
      {!scanComplete ? (
        <Notice tone="warning">{formatTemplate(t('players.compare.scopeIncomplete'), { count: scannedDemos })}</Notice>
      ) : (
        <p className="player-compare-inspector__scope">{formatTemplate(t('players.compare.scope'), { count: scannedDemos })}</p>
      )}
      <div className="player-compare-identities">
        {players.map((player) => (
          <section key={player.steam_id}>
            <PlayerAvatar player={player} />
            <div><strong>{player.name}</strong><small>{player.last_team?.trim() || '—'}</small></div>
            <Button size="sm" onClick={() => onFocus(player)}>{t('players.compare.focus')}</Button>
          </section>
        ))}
      </div>
      <table className="player-compare-metrics">
        <thead><tr><th scope="col"><span className="sr-only">{t('players.table.player')}</span></th>{players.map((player) => <th scope="col" key={player.steam_id}>{player.name}</th>)}</tr></thead>
        <tbody>
          {metrics.map(([label, value]) => (
            <tr key={label}><th scope="row">{label}</th>{players.map((player) => <td key={player.steam_id}>{value(player)}</td>)}</tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}
