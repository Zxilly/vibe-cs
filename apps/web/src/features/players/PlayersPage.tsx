import { currentLocale, msg, msgf } from '../../shared/i18n';
import {
  ChevronLeft,
  ChevronRight,
  Clock3,
  Database,
  RefreshCw,
  Search,
  Trash2,
  UsersRound,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import { commands, readableError } from '../../shared/desktop/client';
import type {
  AvatarCacheStatus,
  PlayerDirectoryItem,
  PlayerProfile,
} from '../../shared/desktop/dto';
import { useI18n } from '../../shared/i18n';
import { Badge, Button, Card, EmptyState, Notice, PageHeader, Spinner } from '../../shared/ui';
import { LibrarySectionNav } from '../library/LibrarySectionNav';
import {
  PlayerDetailPlaceholder,
  PlayerDetailView,
  PlayerMonogram,
} from './PlayerViews';
import {
  PLAYER_PAGE_SIZE,
  PLAYER_SEARCH_DEBOUNCE_MS,
  formatCacheBytes,
  isCurrentRequest,
  normalizePlayerSearch,
  playerPageCount,
  steamEvidence,
} from './playerPresentation';

type LoadState = 'idle' | 'loading' | 'ready' | 'error';
type CacheActionState = 'idle' | 'clearing' | 'success' | 'error';

const dateFormatter = new Intl.DateTimeFormat(currentLocale(), {
  dateStyle: 'medium',
  timeStyle: 'short',
});

function lastMatchLabel(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? msg("m0717") : dateFormatter.format(date);
}

export function PlayersPage() {
  const { t } = useI18n();
  const [searchInput, setSearchInput] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [page, setPage] = useState(1);
  const [items, setItems] = useState<PlayerDirectoryItem[]>([]);
  const [total, setTotal] = useState(0);
  const [scannedDemos, setScannedDemos] = useState(0);
  const [scanComplete, setScanComplete] = useState(true);
  const [listState, setListState] = useState<LoadState>('idle');
  const [listError, setListError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [profile, setProfile] = useState<PlayerProfile | null>(null);
  const [detailState, setDetailState] = useState<LoadState>('idle');
  const [detailError, setDetailError] = useState<string | null>(null);
  const [cache, setCache] = useState<AvatarCacheStatus | null>(null);
  const [cacheState, setCacheState] = useState<LoadState>('idle');
  const [cacheError, setCacheError] = useState<string | null>(null);
  const [cacheActionState, setCacheActionState] = useState<CacheActionState>('idle');
  const [cacheActionMessage, setCacheActionMessage] = useState<string | null>(null);
  const [refreshRevision, setRefreshRevision] = useState(0);
  const listRequestRevision = useRef(0);
  const detailRequestRevision = useRef(0);
  const cacheStatusRequestRevision = useRef(0);
  const cacheMutationRequestRevision = useRef(0);
  const cacheMutationController = useRef<AbortController | null>(null);

  useEffect(() => {
    const timer = globalThis.setTimeout(() => {
      setDebouncedSearch(normalizePlayerSearch(searchInput));
      setPage(1);
    }, PLAYER_SEARCH_DEBOUNCE_MS);
    return () => globalThis.clearTimeout(timer);
  }, [searchInput]);

  useEffect(() => {
    const controller = new AbortController();
    const requestRevision = ++listRequestRevision.current;
    setListState('loading');
    setListError(null);
    void commands.listPlayers(
      {
        page,
        page_size: PLAYER_PAGE_SIZE,
        ...(debouncedSearch ? { search: debouncedSearch } : {}),
      },
      controller.signal,
    ).then((response) => {
      if (controller.signal.aborted || !isCurrentRequest(listRequestRevision.current, requestRevision)) return;
      setItems(response.items);
      setTotal(response.total);
      setPage(response.page);
      setScannedDemos(response.scanned_demos);
      setScanComplete(response.scan_complete);
      setListState('ready');
    }).catch((error: unknown) => {
      if (controller.signal.aborted || !isCurrentRequest(listRequestRevision.current, requestRevision)) return;
      setListError(readableError(error));
      setListState('error');
    });
    return () => controller.abort();
  }, [debouncedSearch, page, refreshRevision]);

  useEffect(() => {
    if (selectedId === null) {
      setDetailState('idle');
      setDetailError(null);
      return undefined;
    }
    const controller = new AbortController();
    const requestRevision = ++detailRequestRevision.current;
    setDetailState('loading');
    setDetailError(null);
    void commands.getPlayer(selectedId, controller.signal).then((response) => {
      if (controller.signal.aborted || !isCurrentRequest(detailRequestRevision.current, requestRevision)) return;
      setProfile(response);
      setDetailState('ready');
    }).catch((error: unknown) => {
      if (controller.signal.aborted || !isCurrentRequest(detailRequestRevision.current, requestRevision)) return;
      setProfile(null);
      setDetailError(readableError(error));
      setDetailState('error');
    });
    return () => controller.abort();
  }, [refreshRevision, selectedId]);

  useEffect(() => {
    const controller = new AbortController();
    const requestRevision = ++cacheStatusRequestRevision.current;
    setCacheState('loading');
    setCacheError(null);
    void commands.avatarCacheStatus(controller.signal).then((response) => {
      if (controller.signal.aborted || !isCurrentRequest(cacheStatusRequestRevision.current, requestRevision)) return;
      setCache(response);
      setCacheState('ready');
    }).catch((error: unknown) => {
      if (controller.signal.aborted || !isCurrentRequest(cacheStatusRequestRevision.current, requestRevision)) return;
      setCacheError(readableError(error));
      setCacheState('error');
    });
    return () => controller.abort();
  }, [refreshRevision]);

  useEffect(() => () => cacheMutationController.current?.abort(), []);

  const selectPlayer = (steamId: string) => {
    if (steamId === selectedId) return;
    setSelectedId(steamId);
    setProfile(null);
    setDetailError(null);
  };

  const refresh = () => setRefreshRevision((revision) => revision + 1);

  const clearAvatarCache = async () => {
    cacheMutationController.current?.abort();
    const controller = new AbortController();
    cacheMutationController.current = controller;
    const requestRevision = ++cacheMutationRequestRevision.current;
    setCacheActionState('clearing');
    setCacheActionMessage(null);
    try {
      const cleanup = await commands.clearAvatarCache(controller.signal);
      if (controller.signal.aborted || !isCurrentRequest(cacheMutationRequestRevision.current, requestRevision)) return;
      const status = await commands.avatarCacheStatus(controller.signal);
      if (controller.signal.aborted || !isCurrentRequest(cacheMutationRequestRevision.current, requestRevision)) return;
      setCache(status);
      setCacheState('ready');
      setCacheActionState(cleanup.failed_entries > 0 ? 'error' : 'success');
      setCacheActionMessage(
        cleanup.failed_entries > 0
          ? msgf("m0529", [cleanup.removed_entries, cleanup.failed_entries])
          : msgf("m0524", [cleanup.removed_entries, formatCacheBytes(cleanup.freed_bytes)]),
      );
    } catch (error: unknown) {
      if (controller.signal.aborted || !isCurrentRequest(cacheMutationRequestRevision.current, requestRevision)) return;
      setCacheActionState('error');
      setCacheActionMessage(readableError(error));
    }
  };

  const pageCount = playerPageCount(total);
  const profileIsCurrent = profile?.player.steam_id === selectedId;
  const allProfilesUnconfigured = items.length > 0
    && items.every((item) => item.steam.state === 'not_configured');

  return (
    <div className="page page--players">
      <PageHeader
        eyebrow="LOCAL PLAYER DIRECTORY"
        title={t('players.title')}
        description={t('players.description')}
        actions={(
          <Button disabled={listState === 'loading'} onClick={refresh}>
            {listState === 'loading' ? <Spinner /> : <RefreshCw size={14} />}
            {t('common.refresh')}
          </Button>
        )}
      />
      <LibrarySectionNav />

      {!scanComplete ? (
        <Notice tone="warning">

         {msg("m0542")} {scannedDemos} {msg("m0200")}
        </Notice>
      ) : null}
      {allProfilesUnconfigured ? (
        <Notice tone="info">

         {msg("m0067")}
        </Notice>
      ) : null}
      {listError ? <Notice tone="danger">{listError}</Notice> : null}

      <div className="players-toolbar-row">
        <Card className="players-search-card">
          <label>
            <Search size={15} />
            <span className="sr-only">{msg("m0670")}</span>
            <input
              value={searchInput}
              maxLength={128}
              placeholder={msg("m0666")}
              onChange={(event) => setSearchInput(event.target.value)}
            />
          </label>
          <span>
            {listState === 'loading' ? <Spinner label={msg("m0670")} /> : <UsersRound size={13} />}
            {total} {msg("m0358")}
          </span>
        </Card>

        <Card className="avatar-cache-card">
          <div className="avatar-cache-card__title">
            <Database size={16} />
            <div><strong>{msg("m0427")}</strong><small>{msg("m0747")}</small></div>
          </div>
          {cache ? (
            <div className="avatar-cache-card__metrics">
              <span><strong>{cache.entries} / {cache.maximum_entries}</strong> {msg("m1306")}</span>
              <span><strong>{formatCacheBytes(cache.bytes)}</strong> / {formatCacheBytes(cache.maximum_bytes)}</span>
            </div>
          ) : (
            <span className="avatar-cache-card__loading">
              {cacheState === 'loading' ? <Spinner label={msg("m1150")} /> : msg("m0975")}
            </span>
          )}
          <Button
            size="sm"
            disabled={cacheActionState === 'clearing' || !cache || cache.entries === 0}
            onClick={() => void clearAvatarCache()}
          >
            {cacheActionState === 'clearing' ? <Spinner /> : <Trash2 size={13} />}

           {msg("m0926")}
          </Button>
        </Card>
      </div>

      {cacheError ? <Notice tone="danger">{msg("m0429")}{cacheError}</Notice> : null}
      {cache && !cache.scan_complete ? (
        <Notice tone="warning">{msg("m0428")}</Notice>
      ) : null}
      {cacheActionMessage ? (
        <Notice tone={cacheActionState === 'error' ? 'danger' : 'success'}>{cacheActionMessage}</Notice>
      ) : null}

      <div className="players-workspace">
        <section className="player-directory" aria-label={msg("m0981")}>
          {listState === 'loading' && items.length === 0 ? (
            <Card className="players-loading">
              <Spinner label={msg("m1152")} />
              <strong>{msg("m0861")}</strong>
              <span>{msg("m0314")}</span>
            </Card>
          ) : items.length === 0 ? (
            <Card className="players-empty">
              <EmptyState
                icon={<UsersRound size={28} />}
                title={debouncedSearch ? t('players.noMatch') : t('players.empty')}
                description={debouncedSearch
                  ? msg("m0470")
                  : t('players.emptyDescription')}
              />
            </Card>
          ) : (
            <div className="player-directory-list" role="list">
              {items.map((player) => {
                const evidence = steamEvidence(player.steam);
                return (
                  <button
                    type="button"
                    key={player.steam_id}
                    className={`player-directory-row${selectedId === player.steam_id ? ' is-selected' : ''}`}
                    aria-pressed={selectedId === player.steam_id}
                    onClick={() => selectPlayer(player.steam_id)}
                  >
                    <PlayerMonogram player={player} />
                    <span className="player-directory-row__main">
                      <strong>{player.name}</strong>
                      <small>{player.steam_id}</small>
                      <span><Clock3 size={11} />{lastMatchLabel(player.last_match_at)}</span>
                    </span>
                    <span className="player-directory-row__stats">
                      <strong>{player.stats.kills}</strong><small>{msg("m0252")}</small>
                      <strong>{player.stats.matches}</strong><small>{msg("m0885")}</small>
                    </span>
                    <Badge tone={evidence.tone}>{evidence.label}</Badge>
                  </button>
                );
              })}
            </div>
          )}

          <footer className="player-directory-footer">
            <span>{msg("m1058")} {page}/{pageCount} {msg("m1303")} {scannedDemos} {msg("m0199")}</span>
            <div>
              <Button
                size="sm"
                disabled={page <= 1 || listState === 'loading'}
                onClick={() => setPage((current) => Math.max(1, current - 1))}
              ><ChevronLeft size={13} />{t('common.previous')}</Button>
              <Button
                size="sm"
                disabled={page >= pageCount || listState === 'loading'}
                onClick={() => setPage((current) => Math.min(pageCount, current + 1))}
              >{t('common.next')}<ChevronRight size={13} /></Button>
            </div>
          </footer>
        </section>

        <Card className="player-detail-card">
          {selectedId === null ? (
            <PlayerDetailPlaceholder />
          ) : detailState === 'loading' && !profileIsCurrent ? (
            <div className="players-loading">
              <Spinner label={msg("m1153")} />
              <strong>{msg("m0867")}</strong>
              <span>{msg("m0239")}</span>
            </div>
          ) : detailError ? (
            <EmptyState
              icon={<UsersRound size={27} />}
              title={msg("m0983")}
              description={detailError}
              action={<Button size="sm" onClick={refresh}><RefreshCw size={13} />{t('common.retry')}</Button>}
            />
          ) : profileIsCurrent && profile ? (
            <PlayerDetailView key={profile.player.steam_id} profile={profile} />
          ) : (
            <PlayerDetailPlaceholder />
          )}
        </Card>
      </div>
    </div>
  );
}
