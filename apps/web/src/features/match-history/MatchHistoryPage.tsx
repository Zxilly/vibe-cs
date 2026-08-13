import { msg, msgf } from '../../shared/i18n';
import {
  Activity,
  CalendarDays,
  CheckCircle2,
  Download,
  FileDown,
  History,
  KeyRound,
  RefreshCw,
  Search,
  Settings2,
  Square,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';

import { commands, readableError } from '../../shared/desktop/client';
import type { MatchDownloadJob, MatchHistoryItem, Paginated } from '../../shared/desktop/dto';
import { useAsyncAction } from '../../shared/hooks/useAsyncAction';
import { useI18n } from '../../shared/i18n';
import { Badge, Button, Card, EmptyState, Notice, PageHeader, Spinner } from '../../shared/ui';
import { LibrarySectionNav } from '../library/LibrarySectionNav';
import {
  MATCH_HISTORY_PAGE_SIZES,
  MAXIMUM_MATCH_HISTORY_SEARCH_CHARACTERS,
  commitCurrentMatchHistoryPage,
  matchHistoryQueryFromParams,
  matchHistoryQueryToParams,
  patchMatchHistoryQuery,
  type MatchHistoryQueryState,
} from './matchHistoryQuery';

const EXPORT_PAGE_SIZE = 200;
const TERMINAL_DOWNLOAD_STATES = new Set<MatchDownloadJob['status']>(['completed', 'cancelled', 'failed']);

function csvCell(value: string | number | boolean): string {
  const raw = String(value);
  const safe = /^[=+\-@]/.test(raw) ? `'${raw}` : raw;
  return `"${safe.replaceAll('"', '""')}"`;
}

export function matchesCsv(matches: MatchHistoryItem[]): string {
  const header = ['match_id', 'map', 'played_at', 'score', 'result', 'demo_status'];
  const rows = matches.map((match) => [
    match.match_id,
    match.map_name ?? '',
    match.played_at ?? '',
    match.score ?? '',
    match.result,
    match.demo_status,
  ]);
  return [header, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n');
}

export async function loadAllMatchHistory(
  load: (page: number, pageSize: number, search: string) => Promise<Paginated<MatchHistoryItem>>,
  search: string,
): Promise<MatchHistoryItem[]> {
  const first = await load(1, EXPORT_PAGE_SIZE, search);
  const items = [...first.items];
  const pageCount = Math.ceil(first.total / first.page_size);
  for (let page = 2; page <= pageCount; page += 1) {
    const next = await load(page, EXPORT_PAGE_SIZE, search);
    items.push(...next.items);
  }
  return items;
}

function isDownloadActive(job: MatchDownloadJob): boolean {
  return !TERMINAL_DOWNLOAD_STATES.has(job.status);
}

type DownloadLabels = { imported: string; redownload: string; retry: string; download: string };
type MatchHistoryActionLabels = DownloadLabels & {
  processing: string;
  cancel: string;
  openAnalysis: string;
};
type MatchHistoryEmptyLabels = {
  connectFirst: string;
  credentialsDescription: string;
  empty: string;
  emptyDescription: string;
  noSearchResults: string;
  noSearchResultsDescription: string;
  openSettings: string;
  startSync: string;
  clearSearch: string;
};

function downloadLabel(job: MatchDownloadJob | undefined, match: MatchHistoryItem, labels: DownloadLabels): string {
  if (job?.status === 'completed' || match.demo_status === 'downloaded') return labels.imported;
  if (job?.status === 'cancelled') return labels.redownload;
  if (job?.status === 'failed' || match.demo_status === 'failed') return labels.retry;
  if (job) return `${Math.round(job.progress * 100)}%`;
  return labels.download;
}

export function MatchHistoryAnalysisLink({
  match,
  demoId = match.demo_id,
  label,
}: {
  match: MatchHistoryItem;
  demoId?: string | null;
  label: string;
}) {
  if (!demoId) return null;
  const parameters = new URLSearchParams({ demo: demoId });
  return <Link className="button button--secondary button--sm" to={`/analysis?${parameters.toString()}`}><Activity size={13} />{label}</Link>;
}

export function indexMatchDownloadJobs(jobs: MatchDownloadJob[]): Record<string, MatchDownloadJob> {
  return Object.fromEntries(jobs.map((job) => [job.match_record_id, job]));
}

export function MatchHistoryDownloadControl({
  match,
  job,
  labels,
  cancelDisabled,
  downloadDisabled,
  onCancel,
  onDownload,
}: {
  match: MatchHistoryItem;
  job?: MatchDownloadJob | undefined;
  labels: MatchHistoryActionLabels;
  cancelDisabled: boolean;
  downloadDisabled: boolean;
  onCancel: () => void;
  onDownload: () => void;
}) {
  const analysisDemoId = match.demo_id ?? job?.demo_id ?? null;
  if (analysisDemoId) {
    return <MatchHistoryAnalysisLink match={match} demoId={analysisDemoId} label={labels.openAnalysis} />;
  }
  if (job && isDownloadActive(job)) {
    return <Button size="sm" variant="danger" disabled={cancelDisabled} onClick={onCancel}><Square size={12} />{labels.cancel}</Button>;
  }
  if (!job && match.demo_status === 'downloading') {
    return <Button size="sm" disabled><Spinner />{labels.processing}</Button>;
  }
  return <Button size="sm" disabled={match.demo_status === 'downloaded' || downloadDisabled} onClick={onDownload}>{match.demo_status === 'downloaded' ? <CheckCircle2 size={13} /> : <Download size={13} />}{downloadLabel(job, match, labels)}</Button>;
}

export function matchHistoryVisibleError(
  configured: boolean | null,
  error: unknown,
): string | null {
  return configured === false ? null : readableError(error);
}

export function MatchHistoryEmptyWorkspace({
  configured,
  filtered,
  labels,
  onSync,
  onClearSearch,
}: {
  configured: boolean;
  filtered: boolean;
  labels: MatchHistoryEmptyLabels;
  onSync: () => void;
  onClearSearch: () => void;
}) {
  return (
    <Card className="history-empty-card history-empty-card--compact">
      <EmptyState
        icon={configured ? <History size={26} /> : <KeyRound size={26} />}
        title={!configured ? labels.connectFirst : filtered ? labels.noSearchResults : labels.empty}
        description={!configured ? labels.credentialsDescription : filtered ? labels.noSearchResultsDescription : labels.emptyDescription}
        action={!configured
          ? <Link className="button button--primary button--md" to="/settings"><Settings2 size={14} />{labels.openSettings}</Link>
          : filtered
            ? <Button variant="secondary" onClick={onClearSearch}>{labels.clearSearch}</Button>
            : <Button variant="primary" onClick={onSync}><RefreshCw size={14} />{labels.startSync}</Button>}
      />
    </Card>
  );
}

export function MatchHistoryPage() {
  const { locale, t } = useI18n();
  const [searchParams, setSearchParams] = useSearchParams();
  const parameterKey = searchParams.toString();
  const historyQuery = useMemo(
    () => matchHistoryQueryFromParams(new URLSearchParams(parameterKey)),
    [parameterKey],
  );
  const currentHistoryQuery = useRef(historyQuery);
  currentHistoryQuery.current = historyQuery;
  const downloadLabels: DownloadLabels = {
    imported: t('history.imported'),
    redownload: t('history.redownload'),
    retry: t('history.retryDownload'),
    download: t('history.downloadDemo'),
  };
  const actionLabels: MatchHistoryActionLabels = {
    ...downloadLabels,
    processing: t('history.processing'),
    cancel: t('history.cancel'),
    openAnalysis: t('history.openAnalysis'),
  };
  const emptyLabels: MatchHistoryEmptyLabels = {
    connectFirst: t('history.connectFirst'),
    credentialsDescription: t('history.credentialsDescription'),
    empty: t('history.empty'),
    emptyDescription: t('history.emptyDescription'),
    noSearchResults: t('history.noSearchResults'),
    noSearchResultsDescription: t('history.noSearchResultsDescription'),
    openSettings: t('history.openSettings'),
    startSync: t('history.startSync'),
    clearSearch: t('history.clearSearch'),
  };
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [matches, setMatches] = useState<MatchHistoryItem[]>([]);
  const [total, setTotal] = useState(0);
  const [queryInput, setQueryInput] = useState(historyQuery.search);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [jobs, setJobs] = useState<Record<string, MatchDownloadJob>>({});
  const [taskMessage, setTaskMessage] = useState<string | null>(null);
  const syncAction = useAsyncAction<unknown>();
  const downloadAction = useAsyncAction<MatchDownloadJob>();
  const cancelAction = useAsyncAction<MatchDownloadJob>();
  const exportAction = useAsyncAction<MatchHistoryItem[]>();

  const updateHistoryQuery = useCallback((
    patch: Partial<MatchHistoryQueryState>,
    replace = false,
  ) => {
    const next = patchMatchHistoryQuery(historyQuery, patch);
    setSearchParams(matchHistoryQueryToParams(next), { replace });
  }, [historyQuery, setSearchParams]);

  const loadPage = useCallback(async (
    requestedQuery: MatchHistoryQueryState,
    signal?: AbortSignal,
  ) => {
    return commitCurrentMatchHistoryPage(
      requestedQuery,
      () => commands.listMatchHistory(
        requestedQuery.page,
        requestedQuery.pageSize,
        signal,
        requestedQuery.search,
      ),
      () => currentHistoryQuery.current,
      (response) => {
        setMatches(response.items);
        setTotal(response.total);
        setLoadError(null);
      },
      signal,
    );
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void Promise.allSettled([
      commands.getConfig(controller.signal).then((config) => Boolean(
          config.steam.steam_id
          && config.steam_has_web_api_key
          && config.steam_has_authentication_code
          && config.steam_has_share_code,
        )),
      loadPage(historyQuery, controller.signal),
      commands.listActiveMatchDownloadJobs(controller.signal).then((activeJobs) => {
        setJobs(indexMatchDownloadJobs(activeJobs));
      }),
    ]).then((results) => {
      const configResult = results[0];
      const historyResult = results[1];
      const jobsResult = results[2];
      const resolvedConfiguration = configResult.status === 'fulfilled' ? configResult.value : null;
      setConfigured(resolvedConfiguration);
      const failedRequest = historyResult.status === 'rejected'
        ? historyResult.reason
        : jobsResult.status === 'rejected'
          ? jobsResult.reason
          : null;
      if (failedRequest !== null && !controller.signal.aborted) {
        setLoadError(matchHistoryVisibleError(resolvedConfiguration, failedRequest));
      }
    });
    return () => controller.abort();
  }, [historyQuery, loadPage]);

  useEffect(() => {
    setQueryInput(historyQuery.search);
  }, [historyQuery.search]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const normalized = queryInput.trim();
      if (normalized !== historyQuery.search) {
        updateHistoryQuery({ search: normalized }, true);
      }
    }, 250);
    return () => window.clearTimeout(timer);
  }, [historyQuery.search, queryInput, updateHistoryQuery]);

  const activeJobIds = useMemo(
    () => Object.values(jobs).filter(isDownloadActive).map((job) => job.id).sort().join(','),
    [jobs],
  );

  useEffect(() => {
    if (!activeJobIds) return undefined;
    const controller = new AbortController();
    const poll = async () => {
      const ids = activeJobIds.split(',');
      const settled = await Promise.allSettled(ids.map((id) => commands.getMatchDownloadJob(id, controller.signal)));
      if (controller.signal.aborted) return;
      let completed = false;
      setJobs((current) => {
        const updated = { ...current };
        settled.forEach((result) => {
          if (result.status !== 'fulfilled') return;
          updated[result.value.match_record_id] = result.value;
          if (result.value.status === 'completed') completed = true;
        });
        return updated;
      });
      if (completed) {
        setTaskMessage(msg("m0035"));
        await loadPage(historyQuery, controller.signal).catch(() => undefined);
      }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), 750);
    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, [activeJobIds, historyQuery, loadPage]);

  const sync = async () => {
    const result = await syncAction.run(() => commands.syncMatchHistory(), msg("m0890"));
    if (!result) return;
    const latestQuery = currentHistoryQuery.current;
    const firstPageQuery = patchMatchHistoryQuery(latestQuery, { page: 1 });
    if (latestQuery.page !== firstPageQuery.page) {
      setSearchParams(matchHistoryQueryToParams(firstPageQuery));
      return;
    }
    await loadPage(firstPageQuery).catch((error: unknown) => {
      const requestedKey = matchHistoryQueryToParams(firstPageQuery).toString();
      const currentKey = matchHistoryQueryToParams(currentHistoryQuery.current).toString();
      if (requestedKey === currentKey) setLoadError(readableError(error));
    });
  };

  const startDownload = async (match: MatchHistoryItem) => {
    setTaskMessage(null);
    const job = await downloadAction.run(() => commands.downloadMatchDemo(match.id));
    if (job) setJobs((current) => ({ ...current, [match.id]: job }));
  };

  const cancelDownload = async (match: MatchHistoryItem, job: MatchDownloadJob) => {
    const cancelled = await cancelAction.run(() => commands.cancelMatchDownload(job.id), msg("m0537"));
    if (cancelled) setJobs((current) => ({ ...current, [match.id]: cancelled }));
  };

  const exportCsv = async () => {
    const exported = await exportAction.run(() => loadAllMatchHistory(
      (requestedPage, pageSize, search) => commands.listMatchHistory(requestedPage, pageSize, undefined, search),
      historyQuery.search,
    ));
    if (!exported) return;
    const url = URL.createObjectURL(new Blob([matchesCsv(exported)], { type: 'text/csv;charset=utf-8' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `vibe-cs-match-history-${new Date().toISOString().slice(0, 10)}.csv`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const pageCount = Math.max(1, Math.ceil(total / historyQuery.pageSize));

  return (
    <div className="page page--match-history">
      <PageHeader
        eyebrow="MATCH ARCHIVE"
        title={t('history.title')}
        description={t('history.description')}
        actions={<Button variant="primary" disabled={configured !== true || syncAction.state.status === 'loading'} onClick={() => void sync()}>{syncAction.state.status === 'loading' ? <Spinner /> : <RefreshCw size={15} />}{t('history.sync')}</Button>}
      />
      <LibrarySectionNav />

      {loadError ? <Notice tone="danger">{loadError}</Notice> : null}
      {syncAction.state.message ? <Notice tone={syncAction.state.status === 'error' ? 'danger' : 'success'}>{syncAction.state.message}</Notice> : null}
      {downloadAction.state.message ? <Notice tone={downloadAction.state.status === 'error' ? 'danger' : 'info'}>{downloadAction.state.message}</Notice> : null}
      {cancelAction.state.message ? <Notice tone={cancelAction.state.status === 'error' ? 'danger' : 'info'}>{cancelAction.state.message}</Notice> : null}
      {taskMessage ? <Notice tone="success">{taskMessage}</Notice> : null}
      {exportAction.state.message ? <Notice tone={exportAction.state.status === 'error' ? 'danger' : 'info'}>{exportAction.state.message}</Notice> : null}

      {matches.length > 0 ? (
        <>
          <Card className="history-toolbar">
            <form
              className="search-box"
              onSubmit={(event) => {
                event.preventDefault();
                updateHistoryQuery({ search: queryInput.trim() });
              }}
            >
              <Search size={15} />
              <input
                value={queryInput}
                maxLength={MAXIMUM_MATCH_HISTORY_SEARCH_CHARACTERS}
                onChange={(event) => setQueryInput(event.target.value)}
                placeholder={t('history.searchPlaceholder')}
                aria-label={t('history.searchLabel')}
              />
            </form>
            <label className="compact-select">
              <span>{t('library.pagination.pageSize')}</span>
              <select
                value={historyQuery.pageSize}
                aria-label={t('library.pagination.pageSize')}
                onChange={(event) => updateHistoryQuery({
                  pageSize: Number(event.target.value) as MatchHistoryQueryState['pageSize'],
                })}
              >
                {MATCH_HISTORY_PAGE_SIZES.map((pageSize) => (
                  <option key={pageSize} value={pageSize}>{pageSize}</option>
                ))}
              </select>
            </label>
            <Button size="sm" disabled={total === 0 || exportAction.state.status === 'loading'} onClick={() => void exportCsv()}>{exportAction.state.status === 'loading' ? <Spinner /> : <FileDown size={13} />}{t('history.exportCsv')}</Button>
          </Card>
          <div className="history-list">
          {matches.map((match) => {
            const job = jobs[match.id];
            const active = job ? isDownloadActive(job) : false;
            const date = match.played_at ?? match.synced_at;
            return (
              <Card key={match.id} className="history-row">
                <span className={`history-result history-result--${match.result}`}>{match.result === 'win' ? 'W' : match.result === 'loss' ? 'L' : match.result === 'draw' ? 'D' : '?'}</span>
                <div className="history-map-art"><span>{match.map_name?.replace('de_', '').slice(0, 3).toUpperCase() ?? 'DEM'}</span></div>
                <div className="history-row__main">
                  <div><strong>{match.map_name?.replace('de_', '').toUpperCase() ?? `MATCH ${match.match_id.slice(-8)}`}</strong><Badge tone={match.demo_status === 'downloaded' ? 'success' : match.demo_status === 'failed' ? 'danger' : 'neutral'}>{match.demo_status === 'downloaded' ? t('history.imported') : match.demo_status === 'failed' ? t('history.downloadFailed') : active || match.demo_status === 'downloading' ? t('history.processing') : t('history.available')}</Badge></div>
                  <span><CalendarDays size={12} />{new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(date))}{match.played_at ? t('history.matchTime') : t('history.syncTime')}</span>
                  {job && active ? <progress value={job.progress} max={1} aria-label={msgf("m0142", [Math.round(job.progress * 100)])} /> : null}
                  {job?.error ?? match.last_error ? <small>{job?.error ?? match.last_error}</small> : null}
                </div>
                <div className="history-score"><span>{t('history.score')}</span><strong>{match.score ?? t('history.pending')}</strong></div>
                <MatchHistoryDownloadControl
                  match={match}
                  job={job}
                  labels={actionLabels}
                  cancelDisabled={cancelAction.state.status === 'loading'}
                  downloadDisabled={downloadAction.state.status === 'loading'}
                  onCancel={() => { if (job) void cancelDownload(match, job); }}
                  onDownload={() => void startDownload(match)}
                />
              </Card>
            );
          })}
          </div>
          <div className="history-footer">
            <span><CheckCircle2 size={13} />{t('history.completedHint')}</span>
            <span>{total} {t('history.records')} · {t('history.page')} {historyQuery.page} {t('history.of')} {pageCount}</span>
            <div><Button size="sm" disabled={historyQuery.page <= 1} onClick={() => updateHistoryQuery({ page: Math.max(1, historyQuery.page - 1) })}>{t('common.previous')}</Button><Button size="sm" disabled={historyQuery.page >= pageCount} onClick={() => updateHistoryQuery({ page: Math.min(pageCount, historyQuery.page + 1) })}>{t('common.next')}</Button></div>
          </div>
        </>
      ) : !loadError && configured !== null ? (
        <MatchHistoryEmptyWorkspace
          configured={configured}
          filtered={Boolean(historyQuery.search)}
          labels={emptyLabels}
          onSync={() => void sync()}
          onClearSearch={() => {
            setQueryInput('');
            updateHistoryQuery({ search: '' });
          }}
        />
      ) : null}
    </div>
  );
}
