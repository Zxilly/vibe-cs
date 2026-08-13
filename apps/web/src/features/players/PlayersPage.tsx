import { msg, msgf } from '../../shared/i18n';
import {
  ChevronLeft,
  ChevronRight,
  Database,
  RefreshCw,
  Search,
  Trash2,
  UsersRound,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';

import { DesktopError, commands, readableError } from '../../shared/desktop/client';
import type {
  AvatarCacheStatus,
  EvidenceSearchResponse,
  PlayerComparison,
  PlayerDirectoryItem,
  PlayerProfile,
} from '../../shared/desktop/dto';
import { useI18n } from '../../shared/i18n';
import { Button, Card, Drawer, EmptyState, Notice, PageHeader, Spinner } from '../../shared/ui';
import { LibrarySectionNav } from '../library/LibrarySectionNav';
import {
  PlayerDetailPlaceholder,
  PlayerDetailView,
} from './PlayerViews';
import {
  PlayerCompareInspector,
  PlayerComparisonSelectionBar,
  PlayerDirectoryScope,
  PlayerPowerTable,
} from './PlayerComparisonViews';
import {
  PLAYER_PAGE_SIZE,
  PLAYER_SEARCH_DEBOUNCE_MS,
  formatCacheBytes,
  isCurrentRequest,
  normalizePlayerSearch,
  playerPageCount,
  reconcileComparedPlayerIds,
  toggleComparedPlayerIds,
  type PlayerDirectorySort,
} from './playerPresentation';

type LoadState = 'idle' | 'loading' | 'ready' | 'error';
type CacheActionState = 'idle' | 'clearing' | 'success' | 'error';

function useWidePlayerInspector(): boolean {
  const [wide, setWide] = useState(() => typeof window !== 'undefined' && window.matchMedia('(min-width: 1400px)').matches);
  useEffect(() => {
    const query = window.matchMedia('(min-width: 1400px)');
    const update = () => setWide(query.matches);
    update();
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);
  return wide;
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
  const [directorySort, setDirectorySort] = useState<PlayerDirectorySort>({ key: 'last_match', direction: 'desc' });
  const [comparedIds, setComparedIds] = useState<string[]>([]);
  const [comparison, setComparison] = useState<PlayerComparison | null>(null);
  const [comparisonState, setComparisonState] = useState<LoadState>('idle');
  const [comparisonError, setComparisonError] = useState<string | null>(null);
  const [comparisonNotice, setComparisonNotice] = useState<string | null>(null);
  const [comparisonRefreshRevision, setComparisonRefreshRevision] = useState(0);
  const [compactInspectorOpen, setCompactInspectorOpen] = useState(false);
  const [listState, setListState] = useState<LoadState>('idle');
  const [listError, setListError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [profile, setProfile] = useState<PlayerProfile | null>(null);
  const [detailState, setDetailState] = useState<LoadState>('idle');
  const [detailError, setDetailError] = useState<string | null>(null);
  const [playerEvidence, setPlayerEvidence] = useState<EvidenceSearchResponse | null>(null);
  const [playerEvidenceState, setPlayerEvidenceState] = useState<LoadState>('idle');
  const [playerEvidenceError, setPlayerEvidenceError] = useState<string | null>(null);
  const [cache, setCache] = useState<AvatarCacheStatus | null>(null);
  const [cacheState, setCacheState] = useState<LoadState>('idle');
  const [cacheError, setCacheError] = useState<string | null>(null);
  const [cacheActionState, setCacheActionState] = useState<CacheActionState>('idle');
  const [cacheActionMessage, setCacheActionMessage] = useState<string | null>(null);
  const [refreshRevision, setRefreshRevision] = useState(0);
  const listRequestRevision = useRef(0);
  const detailRequestRevision = useRef(0);
  const evidenceRequestRevision = useRef(0);
  const comparisonRequestRevision = useRef(0);
  const cacheStatusRequestRevision = useRef(0);
  const cacheMutationRequestRevision = useRef(0);
  const cacheMutationController = useRef<AbortController | null>(null);
  const wideInspector = useWidePlayerInspector();
  const comparedIdsIdentity = comparedIds.join('\0');
  const comparedIdsIdentityRef = useRef(comparedIdsIdentity);
  comparedIdsIdentityRef.current = comparedIdsIdentity;

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
        sort: directorySort.key,
        direction: directorySort.direction,
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
  }, [debouncedSearch, directorySort, page, refreshRevision]);

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
    if (comparedIds.length !== 2) {
      setComparison(null);
      setComparisonState('idle');
      setComparisonError(null);
      return undefined;
    }

    const left = comparedIds[0] as string;
    const right = comparedIds[1] as string;
    const requestedIds = [left, right] as const;
    const requestedSelectionIdentity = comparedIdsIdentity;
    const controller = new AbortController();
    const requestRevision = ++comparisonRequestRevision.current;
    setComparison(null);
    setComparisonState('loading');
    setComparisonError(null);

    void (async () => {
      try {
        const response = await commands.comparePlayers(left, right, controller.signal);
        if (
          controller.signal.aborted
          || !isCurrentRequest(comparisonRequestRevision.current, requestRevision)
          || comparedIdsIdentityRef.current !== requestedSelectionIdentity
        ) return;
        if (
          response.players[0]?.steam_id !== left
          || response.players[1]?.steam_id !== right
        ) {
          throw new DesktopError(
            'Player comparison response does not match the current contract.',
            502,
            'INVALID_PLAYER_COMPARISON_CONTRACT',
          );
        }
        setComparison(response);
        setComparisonState('ready');
      } catch (error: unknown) {
        if (
          controller.signal.aborted
          || !isCurrentRequest(comparisonRequestRevision.current, requestRevision)
          || comparedIdsIdentityRef.current !== requestedSelectionIdentity
        ) return;
        if (error instanceof DesktopError && error.status === 404) {
          try {
            const reconciliation = await reconcileComparedPlayerIds(
              requestedIds,
              async (id) => { await commands.getPlayer(id, controller.signal); },
              (readError) => readError instanceof DesktopError && readError.status === 404,
            );
            if (
              controller.signal.aborted
              || !isCurrentRequest(comparisonRequestRevision.current, requestRevision)
              || comparedIdsIdentityRef.current !== requestedSelectionIdentity
            ) return;
            if (reconciliation.missingIds.length > 0) {
              setComparedIds((current) => current.join('\0') === requestedSelectionIdentity
                ? reconciliation.retainedIds
                : current);
              setSelectedId(reconciliation.retainedIds[0] ?? null);
              setProfile(null);
              setPlayerEvidence(null);
              setCompactInspectorOpen(reconciliation.retainedIds.length > 0);
              setComparisonNotice(
                t('players.compare.missingRemoved').replace(
                  '{ids}',
                  reconciliation.missingIds.join(', '),
                ),
              );
              return;
            }
          } catch (reconciliationError: unknown) {
            if (
              controller.signal.aborted
              || !isCurrentRequest(comparisonRequestRevision.current, requestRevision)
              || comparedIdsIdentityRef.current !== requestedSelectionIdentity
            ) return;
            setComparisonError(readableError(reconciliationError));
            setComparisonState('error');
            return;
          }
        }
        setComparisonError(readableError(error));
        setComparisonState('error');
      }
    })();
    return () => controller.abort();
  }, [comparedIdsIdentity, comparisonRefreshRevision, refreshRevision, t]);

  useEffect(() => {
    if (selectedId === null) {
      setPlayerEvidence(null);
      setPlayerEvidenceState('idle');
      setPlayerEvidenceError(null);
      return undefined;
    }
    const controller = new AbortController();
    const requestRevision = ++evidenceRequestRevision.current;
    setPlayerEvidence(null);
    setPlayerEvidenceState('loading');
    setPlayerEvidenceError(null);
    void commands.searchEvidence({
      player: selectedId,
      page: 1,
      page_size: 10,
    }, controller.signal).then((response) => {
      if (controller.signal.aborted || !isCurrentRequest(evidenceRequestRevision.current, requestRevision)) return;
      setPlayerEvidence(response);
      setPlayerEvidenceState('ready');
    }).catch((error: unknown) => {
      if (controller.signal.aborted || !isCurrentRequest(evidenceRequestRevision.current, requestRevision)) return;
      setPlayerEvidenceError(readableError(error));
      setPlayerEvidenceState('error');
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
    setPlayerEvidence(null);
    setPlayerEvidenceError(null);
  };

  const inspectPlayer = (player: PlayerDirectoryItem) => {
    setComparedIds([player.steam_id]);
    setComparisonNotice(null);
    setCompactInspectorOpen(true);
    selectPlayer(player.steam_id);
  };

  const togglePlayerComparison = (player: PlayerDirectoryItem) => {
    const next = toggleComparedPlayerIds(comparedIds, player.steam_id);
    setComparedIds(next);
    setComparisonNotice(null);
    setCompactInspectorOpen(next.length === 2);
    setProfile(null);
    setDetailError(null);
    if (next.length === 1) setSelectedId(next[0] ?? null);
    else setSelectedId(null);
  };

  const clearPlayerComparison = () => {
    setComparedIds([]);
    setComparisonNotice(null);
    setCompactInspectorOpen(false);
    setSelectedId(null);
    setProfile(null);
    setDetailError(null);
  };

  const focusComparedPlayer = (player: PlayerDirectoryItem) => {
    setComparedIds([player.steam_id]);
    setComparisonNotice(null);
    setCompactInspectorOpen(true);
    selectPlayer(player.steam_id);
  };

  const changeDirectorySort = (key: PlayerDirectorySort['key']) => {
    setPage(1);
    setDirectorySort((current) => ({
      key,
      direction: current.key === key && current.direction === 'asc' ? 'desc' : 'asc',
    }));
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
  const comparedIdSet = useMemo(
    () => new Set(comparedIds),
    [comparedIds],
  );
  const profileIsCurrent = profile?.player.steam_id === selectedId;
  const allProfilesUnconfigured = items.length > 0
    && items.every((item) => item.steam.state === 'not_configured');
  const comparisonIsCurrent = comparison !== null
    && comparison.players[0].steam_id === comparedIds[0]
    && comparison.players[1].steam_id === comparedIds[1];
  const playerInspector = comparedIds.length === 2 ? (
    comparisonIsCurrent && comparison ? (
      <PlayerCompareInspector
        players={comparison.players}
        scannedDemos={comparison.scanned_demos}
        scanComplete={comparison.scan_complete}
        onFocus={focusComparedPlayer}
        onClear={clearPlayerComparison}
      />
    ) : (
      <Card className="player-detail-card">
        {comparisonState === 'error' ? (
          <EmptyState
            icon={<UsersRound size={27} />}
            title={t('players.compare.error')}
            description={comparisonError ?? t('players.compare.error')}
            action={(
              <Button size="sm" onClick={() => setComparisonRefreshRevision((value) => value + 1)}>
                <RefreshCw size={13} />{t('common.retry')}
              </Button>
            )}
          />
        ) : (
          <div className="players-loading">
            <Spinner label={t('players.compare.loading')} />
            <strong>{t('players.compare.loading')}</strong>
            <span>{t('players.table.scopeBehavior')}</span>
          </div>
        )}
      </Card>
    )
  ) : (
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
        <PlayerDetailView
          key={profile.player.steam_id}
          profile={profile}
          evidence={playerEvidence}
          evidenceLoading={playerEvidenceState === 'loading'}
          evidenceError={playerEvidenceError}
        />
      ) : (
        <PlayerDetailPlaceholder />
      )}
    </Card>
  );

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
      {comparisonNotice ? <Notice tone="warning">{comparisonNotice}</Notice> : null}

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
            <PlayerPowerTable
              players={items}
              comparedIds={comparedIdSet}
              sort={directorySort}
              onSort={changeDirectorySort}
              onToggleCompare={togglePlayerComparison}
              onInspect={inspectPlayer}
            />
          )}

          {items.length > 0 ? (
            <PlayerDirectoryScope page={page} pages={pageCount} visible={items.length} total={total} />
          ) : null}
          {!wideInspector && comparedIds.length > 0 && !compactInspectorOpen ? (
            <PlayerComparisonSelectionBar
              count={comparedIds.length}
              onOpen={() => setCompactInspectorOpen(true)}
              onClear={clearPlayerComparison}
            />
          ) : null}

          <footer className="player-directory-footer">
            <span>{scannedDemos} {msg("m0199")}</span>
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

        {wideInspector ? <aside className="player-inspector-shell">{playerInspector}</aside> : null}
      </div>

      <Drawer
        open={!wideInspector && compactInspectorOpen && comparedIds.length > 0}
        title={comparedIds.length === 2
          ? t('players.compare.title')
          : profileIsCurrent ? profile.player.name : t('players.table.details')}
        description={comparedIds.length === 2 ? t('players.table.scopeBehavior') : comparedIds[0]}
        onClose={() => setCompactInspectorOpen(false)}
        footer={<Button onClick={() => setCompactInspectorOpen(false)}>{t('shell.close')}</Button>}
      >
        <div className="player-inspector-drawer">{playerInspector}</div>
      </Drawer>
    </div>
  );
}
