import { msg, msgf } from '../../shared/i18n';
import {
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
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';

import { api, readableError } from '../../shared/api/client';
import type { MatchDownloadJob, MatchHistoryItem } from '../../shared/api/dto';
import { useAsyncAction } from '../../shared/hooks/useAsyncAction';
import { useI18n } from '../../shared/i18n';
import { Badge, Button, Card, EmptyState, Notice, PageHeader, Spinner } from '../../shared/ui';
import { LibrarySectionNav } from '../library/LibrarySectionNav';

const PAGE_SIZE = 20;
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

function isDownloadActive(job: MatchDownloadJob): boolean {
  return !TERMINAL_DOWNLOAD_STATES.has(job.status);
}

type DownloadLabels = { imported: string; redownload: string; retry: string; download: string };

function downloadLabel(job: MatchDownloadJob | undefined, match: MatchHistoryItem, labels: DownloadLabels): string {
  if (job?.status === 'completed' || match.demo_status === 'downloaded') return labels.imported;
  if (job?.status === 'cancelled') return labels.redownload;
  if (job?.status === 'failed' || match.demo_status === 'failed') return labels.retry;
  if (job) return `${Math.round(job.progress * 100)}%`;
  return labels.download;
}

export function MatchHistoryPage() {
  const { locale, t } = useI18n();
  const downloadLabels: DownloadLabels = {
    imported: t('history.imported'),
    redownload: t('history.redownload'),
    retry: t('history.retryDownload'),
    download: t('history.downloadDemo'),
  };
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [matches, setMatches] = useState<MatchHistoryItem[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [query, setQuery] = useState('');
  const [loadError, setLoadError] = useState<string | null>(null);
  const [jobs, setJobs] = useState<Record<string, MatchDownloadJob>>({});
  const [taskMessage, setTaskMessage] = useState<string | null>(null);
  const syncAction = useAsyncAction<unknown>();
  const downloadAction = useAsyncAction<MatchDownloadJob>();
  const cancelAction = useAsyncAction<MatchDownloadJob>();

  const loadPage = useCallback(async (requestedPage: number, signal?: AbortSignal) => {
    const response = await api.listMatchHistory(requestedPage, PAGE_SIZE, signal);
    setMatches(response.items);
    setTotal(response.total);
    setPage(response.page);
    setLoadError(null);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void Promise.allSettled([
      api.getConfig(controller.signal).then((config) => {
        setConfigured(Boolean(
          config.steam.steam_id
          && config.steam_has_web_api_key
          && config.steam_has_authentication_code
          && config.steam_has_share_code,
        ));
      }),
      loadPage(page, controller.signal),
    ]).then((results) => {
      const configResult = results[0];
      const historyResult = results[1];
      if (configResult.status === 'rejected') setConfigured(false);
      if (historyResult.status === 'rejected' && !controller.signal.aborted) {
        setLoadError(readableError(historyResult.reason));
      }
    });
    return () => controller.abort();
  }, [loadPage, page]);

  const activeJobIds = useMemo(
    () => Object.values(jobs).filter(isDownloadActive).map((job) => job.id).sort().join(','),
    [jobs],
  );

  useEffect(() => {
    if (!activeJobIds) return undefined;
    const controller = new AbortController();
    const poll = async () => {
      const ids = activeJobIds.split(',');
      const settled = await Promise.allSettled(ids.map((id) => api.getMatchDownloadJob(id, controller.signal)));
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
        await loadPage(page, controller.signal).catch(() => undefined);
      }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), 750);
    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, [activeJobIds, loadPage, page]);

  const filtered = useMemo(() => {
    const value = query.trim().toLocaleLowerCase();
    return matches.filter((match) => !value || `${match.map_name ?? ''} ${match.score ?? ''} ${match.match_id} ${match.result}`.toLocaleLowerCase().includes(value));
  }, [matches, query]);

  const sync = async () => {
    const result = await syncAction.run(() => api.syncMatchHistory(), msg("m0890"));
    if (!result) return;
    setPage(1);
    await loadPage(1).catch((error: unknown) => setLoadError(readableError(error)));
  };

  const startDownload = async (match: MatchHistoryItem) => {
    setTaskMessage(null);
    const job = await downloadAction.run(() => api.downloadMatchDemo(match.id));
    if (job) setJobs((current) => ({ ...current, [match.id]: job }));
  };

  const cancelDownload = async (match: MatchHistoryItem, job: MatchDownloadJob) => {
    const cancelled = await cancelAction.run(() => api.cancelMatchDownload(job.id), msg("m0537"));
    if (cancelled) setJobs((current) => ({ ...current, [match.id]: cancelled }));
  };

  const exportCsv = () => {
    const url = URL.createObjectURL(new Blob([matchesCsv(filtered)], { type: 'text/csv;charset=utf-8' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `vibe-cs-match-history-${new Date().toISOString().slice(0, 10)}.csv`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="page page--match-history">
      <PageHeader
        eyebrow="MATCH ARCHIVE"
        title={t('history.title')}
        description={t('history.description')}
        actions={<Button variant="primary" disabled={configured !== true || syncAction.state.status === 'loading'} onClick={() => void sync()}>{syncAction.state.status === 'loading' ? <Spinner /> : <RefreshCw size={15} />}{t('history.sync')}</Button>}
      />
      <LibrarySectionNav />

      {configured === false ? <Notice tone="warning" title={t('history.disconnectedTitle')}>{t('history.disconnectedDescription')}<div><Link to="/settings"><Settings2 size={13} />{t('history.openSettings')}</Link></div></Notice> : null}
      {loadError ? <Notice tone="danger">{loadError}</Notice> : null}
      {syncAction.state.message ? <Notice tone={syncAction.state.status === 'error' ? 'danger' : 'success'}>{syncAction.state.message}</Notice> : null}
      {downloadAction.state.message ? <Notice tone={downloadAction.state.status === 'error' ? 'danger' : 'info'}>{downloadAction.state.message}</Notice> : null}
      {cancelAction.state.message ? <Notice tone={cancelAction.state.status === 'error' ? 'danger' : 'info'}>{cancelAction.state.message}</Notice> : null}
      {taskMessage ? <Notice tone="success">{taskMessage}</Notice> : null}

      <Card className="history-toolbar">
        <div className="search-box"><Search size={15} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t('history.searchPlaceholder')} aria-label={t('history.searchLabel')} /></div>
        <Button size="sm" disabled={filtered.length === 0} onClick={exportCsv}><FileDown size={13} />{t('history.exportCsv')}</Button>
      </Card>

      {filtered.length > 0 ? (
        <div className="history-list">
          {filtered.map((match) => {
            const job = jobs[match.id];
            const active = job ? isDownloadActive(job) : false;
            const date = match.played_at ?? match.synced_at;
            return (
              <Card key={match.id} className="history-row">
                <span className={`history-result history-result--${match.result}`}>{match.result === 'win' ? 'W' : match.result === 'loss' ? 'L' : match.result === 'draw' ? 'D' : '?'}</span>
                <div className="history-map-art"><span>{match.map_name?.replace('de_', '').slice(0, 3).toUpperCase() ?? 'DEM'}</span></div>
                <div className="history-row__main">
                  <div><strong>{match.map_name?.replace('de_', '').toUpperCase() ?? `MATCH ${match.match_id.slice(-8)}`}</strong><Badge tone={match.demo_status === 'downloaded' ? 'success' : match.demo_status === 'failed' ? 'danger' : 'neutral'}>{match.demo_status === 'downloaded' ? t('history.imported') : match.demo_status === 'failed' ? t('history.downloadFailed') : active ? t('history.processing') : t('history.available')}</Badge></div>
                  <span><CalendarDays size={12} />{new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(date))}{match.played_at ? t('history.matchTime') : t('history.syncTime')}</span>
                  {job && active ? <progress value={job.progress} max={1} aria-label={msgf("m0142", [Math.round(job.progress * 100)])} /> : null}
                  {job?.error ?? match.last_error ? <small>{job?.error ?? match.last_error}</small> : null}
                </div>
                <div className="history-score"><span>{t('history.score')}</span><strong>{match.score ?? t('history.pending')}</strong></div>
                {active && job ? <Button size="sm" variant="danger" disabled={cancelAction.state.status === 'loading'} onClick={() => void cancelDownload(match, job)}><Square size={12} />{t('history.cancel')}</Button> : <Button size="sm" disabled={match.demo_status === 'downloaded' || downloadAction.state.status === 'loading'} onClick={() => void startDownload(match)}>{match.demo_status === 'downloaded' ? <CheckCircle2 size={13} /> : <Download size={13} />}{downloadLabel(job, match, downloadLabels)}</Button>}
              </Card>
            );
          })}
        </div>
      ) : (
        <Card className="history-empty-card">
          <EmptyState
            icon={configured === false ? <KeyRound size={26} /> : <History size={26} />}
            title={configured === false ? t('history.connectFirst') : t('history.empty')}
            description={configured === false ? t('history.credentialsDescription') : t('history.emptyDescription')}
            action={configured === true ? <Button variant="primary" onClick={() => void sync()}><RefreshCw size={14} />{t('history.startSync')}</Button> : <Link className="button button--primary button--md" to="/settings"><Settings2 size={14} />{t('history.openSettings')}</Link>}
          />
        </Card>
      )}

      <div className="history-footer">
        <span><CheckCircle2 size={13} />{t('history.completedHint')}</span>
        <span>{total} {t('history.records')} · {t('history.page')} {page} {t('history.of')} {pageCount}</span>
        <div><Button size="sm" disabled={page <= 1} onClick={() => setPage((current) => Math.max(1, current - 1))}>{t('common.previous')}</Button><Button size="sm" disabled={page >= pageCount} onClick={() => setPage((current) => Math.min(pageCount, current + 1))}>{t('common.next')}</Button></div>
      </div>
    </div>
  );
}
