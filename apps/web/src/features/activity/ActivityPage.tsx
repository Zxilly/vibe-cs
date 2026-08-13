import {
  Activity as ActivityIcon,
  BrainCircuit,
  Download,
  ExternalLink,
  FileOutput,
  RefreshCw,
  RotateCcw,
  Search,
  StopCircle,
  Video,
} from 'lucide-react';
import { useCallback, useDeferredValue, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';

import { commands, readableError } from '../../shared/desktop/client';
import type {
  ActivityAction,
  ActivityItem,
  ActivityKind,
  ActivityStatus,
} from '../../shared/desktop/dto';
import { type MessageKey, useI18n } from '../../shared/i18n';
import { Badge, Button, Card, EmptyState, Notice, PageHeader, Spinner } from '../../shared/ui';
import {
  activityActionHref,
  activityProgressLabel,
  activityUnitLabel,
  type ActivityStateFilter,
} from './activityPresentation';

type ActivityWorkspaceProps = {
  items: ActivityItem[];
  selectedId: string | null;
  busyId: string | null;
  onSelect: (id: string) => void;
  onAction: (item: ActivityItem, action: ActivityAction) => void;
};

const kindKeys: Record<ActivityKind, MessageKey> = {
  recording: 'activity.recording',
  export: 'activity.export',
  download: 'activity.download',
  analysis: 'activity.analysis',
};

const statusKeys: Record<ActivityStatus, MessageKey> = {
  queued: 'activity.status.queued',
  preparing: 'activity.status.preparing',
  running: 'activity.status.running',
  cancelling: 'activity.status.cancelling',
  completed: 'activity.status.completed',
  failed: 'activity.status.failed',
  cancelled: 'activity.status.cancelled',
  downloading: 'activity.status.downloading',
  decompressing: 'activity.status.decompressing',
  importing: 'activity.status.importing',
  analyzing: 'activity.status.analyzing',
};

const actionKeys: Record<ActivityAction, MessageKey> = {
  cancel: 'activity.cancel',
  retry_analysis: 'activity.retryAnalysis',
  retry_download: 'activity.retryDownload',
  open_analysis: 'activity.openAnalysis',
  open_library: 'activity.openLibrary',
  open_match_history: 'activity.openHistory',
  open_outputs: 'activity.openOutputs',
};

const recordingStageKeys: Partial<Record<string, MessageKey>> = {
  'recording.stage.launching': 'queue.recordingStage.launching',
  'recording.stage.seeking': 'queue.recordingStage.seeking',
  'recording.stage.capturing': 'queue.recordingStage.capturing',
  'recording.stage.stabilizing': 'queue.recordingStage.stabilizing',
  'recording.stage.encoding': 'queue.recordingStage.encoding',
};

const ACTIVITY_PAGE_SIZE = 50;

function statusTone(status: ActivityStatus): 'neutral' | 'success' | 'warning' | 'danger' | 'blue' {
  if (status === 'completed') return 'success';
  if (status === 'failed') return 'danger';
  if (status === 'cancelled') return 'neutral';
  if (status === 'cancelling') return 'warning';
  return 'blue';
}

function kindIcon(kind: ActivityKind) {
  if (kind === 'analysis') return <BrainCircuit size={15} />;
  if (kind === 'download') return <Download size={15} />;
  if (kind === 'recording') return <Video size={15} />;
  return <FileOutput size={15} />;
}

function actionIcon(action: ActivityAction) {
  if (action === 'cancel') return <StopCircle size={13} />;
  if (action === 'retry_analysis' || action === 'retry_download') return <RotateCcw size={13} />;
  return <ExternalLink size={13} />;
}

export async function executeActivityAction(
  item: ActivityItem,
  action: ActivityAction,
): Promise<ActivityStatus | null> {
  if (action === 'cancel' && item.job_id) {
    if (item.kind === 'recording') await commands.cancelRecordingJob(item.job_id);
    else if (item.kind === 'export') await commands.cancelExportJob(item.job_id);
    else if (item.kind === 'download') await commands.cancelMatchDownload(item.job_id);
  } else if (action === 'retry_analysis' && item.context_id) {
    await commands.analyzeDemo(item.context_id);
  } else if (action === 'retry_download' && item.context_id) {
    const job = await commands.downloadMatchDemo(item.context_id);
    return job.status;
  }
  return null;
}

export function ActivityWorkspace({
  items,
  selectedId,
  busyId,
  onSelect,
  onAction,
}: ActivityWorkspaceProps) {
  const { locale, t } = useI18n();
  const selected = items.find((item) => item.id === selectedId) ?? items[0] ?? null;
  const dateFormatter = useMemo(() => new Intl.DateTimeFormat(locale, {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }), [locale]);

  return (
    <div className="activity-workspace">
      <Card className="activity-table-panel">
        {items.length === 0 ? (
          <EmptyState
            icon={<ActivityIcon size={24} />}
            title={t('activity.empty')}
            description={t('activity.emptyDescription')}
          />
        ) : (
          <div className="activity-table-scroll">
            <table className="activity-table">
              <thead>
                <tr>
                  <th>{t('activity.task')}</th>
                  <th>{t('activity.state')}</th>
                  <th>{t('activity.progress')}</th>
                  <th>{t('activity.updated')}</th>
                </tr>
              </thead>
              <tbody>
                {items.map((item) => {
                  const progress = activityProgressLabel(item);
                  const units = activityUnitLabel(item);
                  const stageKey = item.stage ? recordingStageKeys[item.stage] : undefined;
                  const active = selected?.id === item.id;
                  return (
                    <tr
                      key={item.id}
                      data-activity-id={item.id}
                      aria-selected={active}
                      className={active ? 'activity-row activity-row--selected' : 'activity-row'}
                    >
                      <td>
                        <button type="button" className="activity-row__select" onClick={() => onSelect(item.id)}>
                          <span className={`activity-kind activity-kind--${item.kind}`}>{kindIcon(item.kind)}</span>
                          <span>
                            <strong>{item.subject || item.id}</strong>
                            <small>{t(kindKeys[item.kind])}{item.subtype ? ` · ${item.subtype}` : ''} · {item.job_id || item.context_id}</small>
                          </span>
                        </button>
                      </td>
                      <td>
                        <Badge tone={statusTone(item.status)}>{t(statusKeys[item.status])}</Badge>
                        {item.stage ? <small className="activity-stage" title={item.stage}>{stageKey ? t(stageKey) : item.stage}</small> : null}
                      </td>
                      <td>
                        {progress ? (
                          <div className="activity-progress">
                            <progress value={item.progress_percent ?? 0} max={100} aria-label={progress} />
                            <span>{progress}</span>
                          </div>
                        ) : units ? <span className="activity-units">{units}</span> : <span className="activity-unknown">—</span>}
                      </td>
                      <td><time dateTime={item.updated_at}>{dateFormatter.format(new Date(item.updated_at))}</time></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card className="activity-inspector">
        {selected ? (
          <>
            <header className="activity-inspector__header">
              <div>
                <span className="eyebrow">{t('activity.details')}</span>
                <h2>{selected.subject || selected.id}</h2>
              </div>
              <Badge tone={statusTone(selected.status)}>{t(statusKeys[selected.status])}</Badge>
            </header>

            <dl className="activity-inspector__facts">
              <div><dt>{t('activity.activityId')}</dt><dd title={selected.id}>{selected.id}</dd></div>
              <div><dt>{t('activity.jobId')}</dt><dd title={selected.job_id ?? undefined}>{selected.job_id ?? t('activity.noJobId')}</dd></div>
              <div><dt>{t('activity.contextId')}</dt><dd title={selected.context_id ?? undefined}>{selected.context_id ?? '—'}</dd></div>
              <div><dt>{t('activity.state')}</dt><dd><code>{selected.status}</code></dd></div>
              <div><dt>{t('activity.stage')}</dt><dd>{selected.stage ? (recordingStageKeys[selected.stage] ? t(recordingStageKeys[selected.stage]!) : selected.stage) : t('activity.noStage')}</dd></div>
              <div><dt>{t('activity.progress')}</dt><dd>{activityProgressLabel(selected) ?? activityUnitLabel(selected) ?? '—'}</dd></div>
              <div><dt>{t('activity.created')}</dt><dd><time dateTime={selected.created_at}>{dateFormatter.format(new Date(selected.created_at))}</time></dd></div>
              <div><dt>{t('activity.updated')}</dt><dd><time dateTime={selected.updated_at}>{dateFormatter.format(new Date(selected.updated_at))}</time></dd></div>
            </dl>

            {selected.error ? (
              <Notice tone="danger" title={t('activity.error')}>{selected.error}</Notice>
            ) : selected.status === 'failed' ? (
              <Notice tone="warning" title={t('activity.error')}>{t('activity.errorUnavailable')}</Notice>
            ) : null}

            <div className="activity-inspector__actions">
              {selected.available_actions.map((action) => {
                const href = activityActionHref(selected, action);
                if (href) {
                  return (
                    <Link key={action} className="button button--secondary button--sm" data-action={action} to={href}>
                      {actionIcon(action)}{t(actionKeys[action])}
                    </Link>
                  );
                }
                return (
                  <Button
                    key={action}
                    size="sm"
                    variant={action === 'cancel' ? 'danger' : 'primary'}
                    data-action={action}
                    disabled={busyId !== null}
                    onClick={() => onAction(selected, action)}
                  >
                    {busyId === selected.id ? <Spinner /> : actionIcon(action)}{t(actionKeys[action])}
                  </Button>
                );
              })}
            </div>
          </>
        ) : (
          <EmptyState icon={<ActivityIcon size={24} />} title={t('activity.details')} description={t('activity.select')} />
        )}
      </Card>
    </div>
  );
}

export function ActivityPagination({
  page,
  pageSize,
  total,
  onPageChange,
}: {
  page: number;
  pageSize: number;
  total: number;
  onPageChange: (page: number) => void;
}) {
  const { t } = useI18n();
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  return (
    <nav
      className="activity-pagination"
      aria-label={t('activity.title')}
      data-page={page}
      data-page-count={pageCount}
    >
      <Button
        size="sm"
        variant="ghost"
        data-direction="previous"
        disabled={page <= 1}
        onClick={() => onPageChange(page - 1)}
      >
        {t('common.previous')}
      </Button>
      <span><strong>{page}</strong> / {pageCount} · {total}</span>
      <Button
        size="sm"
        variant="ghost"
        data-direction="next"
        disabled={page >= pageCount}
        onClick={() => onPageChange(page + 1)}
      >
        {t('common.next')}
      </Button>
    </nav>
  );
}

export function ActivityPage() {
  const { t } = useI18n();
  const [items, setItems] = useState<ActivityItem[]>([]);
  const [total, setTotal] = useState(0);
  const [summary, setSummary] = useState({ total: 0, active: 0, failed: 0, completed: 0 });
  const [page, setPage] = useState(1);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const serverQuery = useDeferredValue(query.trim());
  const [kind, setKind] = useState<ActivityKind | ''>('');
  const [state, setState] = useState<ActivityStateFilter>('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    let timer: number | undefined;
    let disposed = false;
    const load = async (quiet: boolean) => {
      if (!quiet) {
        setLoading(true);
        setItems([]);
        setSelectedId(null);
      }
      try {
        const response = await commands.listActivities({
          page,
          page_size: ACTIVITY_PAGE_SIZE,
          ...(serverQuery ? { search: serverQuery } : {}),
          ...(kind ? { kind } : {}),
          ...(state ? { state } : {}),
        }, controller.signal);
        if (disposed) return;
        setItems(response.items);
        setTotal(response.total);
        setSummary(response.summary);
        setSelectedId((current) => (
          current && response.items.some((item) => item.id === current)
            ? current
            : response.items[0]?.id ?? null
        ));
        setError(null);
        if (response.summary.active > 0) {
          timer = window.setTimeout(() => void load(true), 1_500);
        }
      } catch (cause) {
        if (!controller.signal.aborted && !disposed) setError(readableError(cause));
      } finally {
        if (!quiet && !disposed) setLoading(false);
      }
    };
    void load(false);
    return () => {
      disposed = true;
      controller.abort();
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [kind, page, revision, serverQuery, state]);

  const pageCount = Math.max(1, Math.ceil(total / ACTIVITY_PAGE_SIZE));

  useEffect(() => {
    if (page <= pageCount) return;
    setPage(pageCount);
  }, [page, pageCount]);

  const runAction = useCallback(async (item: ActivityItem, action: ActivityAction) => {
    if (busyId !== null) return;
    setBusyId(item.id);
    setError(null);
    setNotice(null);
    try {
      const persistedStatus = await executeActivityAction(item, action);
      setNotice(persistedStatus ? t(statusKeys[persistedStatus]) : t('activity.actionSucceeded'));
      setRevision((current) => current + 1);
    } catch (cause) {
      setError(readableError(cause));
    } finally {
      setBusyId(null);
    }
  }, [busyId, t]);

  return (
    <div className="page page--activity">
      <PageHeader
        eyebrow={t('activity.eyebrow')}
        title={t('activity.title')}
        description={t('activity.description')}
        actions={(
          <Button size="sm" disabled={loading || busyId !== null} onClick={() => setRevision((current) => current + 1)}>
            {loading ? <Spinner /> : <RefreshCw size={13} />}{t('common.refresh')}
          </Button>
        )}
      />

      {error ? <Notice tone="danger">{error}</Notice> : null}
      {notice ? <Notice tone="success">{notice}</Notice> : null}

      <div className="activity-summary" aria-label={t('activity.title')}>
        <span><strong>{summary.total}</strong>{t('activity.total')}</span>
        <span><strong>{summary.active}</strong>{t('activity.active')}</span>
        <span><strong>{summary.failed}</strong>{t('activity.failed')}</span>
        <span><strong>{summary.completed}</strong>{t('activity.completed')}</span>
      </div>

      <Card className="activity-toolbar">
        <label className="activity-search">
          <Search size={14} />
          <span className="sr-only">{t('activity.search')}</span>
          <input
            value={query}
            maxLength={128}
            placeholder={t('activity.search')}
            onChange={(event) => {
              setQuery(event.target.value);
              setPage(1);
            }}
          />
        </label>
        <label>
          <span>{t('activity.kind')}</span>
          <select value={kind} onChange={(event) => {
            setKind(event.target.value as ActivityKind | '');
            setPage(1);
          }}>
            <option value="">{t('activity.all')}</option>
            {(Object.keys(kindKeys) as ActivityKind[]).map((value) => <option key={value} value={value}>{t(kindKeys[value])}</option>)}
          </select>
        </label>
        <label>
          <span>{t('activity.state')}</span>
          <select value={state} onChange={(event) => {
            setState(event.target.value as ActivityStateFilter);
            setPage(1);
          }}>
            <option value="">{t('activity.all')}</option>
            <option value="active">{t('activity.active')}</option>
            <option value="failed">{t('activity.failed')}</option>
            <option value="completed">{t('activity.completed')}</option>
          </select>
        </label>
      </Card>

      {total > 0 ? (
        <ActivityPagination
          page={page}
          pageSize={ACTIVITY_PAGE_SIZE}
          total={total}
          onPageChange={setPage}
        />
      ) : null}

      {loading && items.length === 0 ? (
        <Card className="activity-loading"><Spinner label={t('activity.loading')} /><span>{t('activity.loading')}</span></Card>
      ) : (
        <ActivityWorkspace
          items={items}
          selectedId={selectedId}
          busyId={busyId}
          onSelect={setSelectedId}
          onAction={(item, action) => void runAction(item, action)}
        />
      )}
    </div>
  );
}
