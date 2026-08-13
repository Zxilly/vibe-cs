import { currentLocale, msg, msgf } from '../../shared/i18n';
import {
  ArrowDown,
  ArrowUp,
  ChevronRight,
  CircleAlert,
  Clock3,
  GripVertical,
  ListChecks,
  PauseCircle,
  Play,
  Search,
  SlidersHorizontal,
  Sparkles,
  Timer,
  Trash2,
  UserRound,
  Video,
  X,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';

import { commands, readableError } from '../../shared/desktop/client';
import type {
  DemoPlaybackLaunch,
  DemoPlaybackPreflight,
  DemoPlaybackStatus,
  DemoPlaybackStop,
  HlaeStatus,
  JobStatus,
  RecordingExecutionResponse,
  RecordingJob,
  RecordingPlanResponse,
  RecordingQueueRequest,
} from '../../shared/desktop/dto';
import { useAsyncAction } from '../../shared/hooks/useAsyncAction';
import { type MessageKey, useI18n } from '../../shared/i18n';
import { runManagedPlaybackLaunch, useRuntimeStore } from '../../shared/stores/runtimeStore';
import { Badge, Button, Card, EmptyState, Field, IconButton, Notice, PageHeader, Spinner, TextInput } from '../../shared/ui';
import {
  buildRecordingQueueRequest,
  buildDemoPlaybackOptions,
  demoPlaybackFingerprint,
  demoPlaybackBlockReason,
  matchesRecordingQueueFingerprint,
  playbackReadinessRelevant,
  queueItemDurationSeconds,
  queueItemTickRate,
  recordingJobCancelTarget,
  recordingJobStage,
  recordingQueueFingerprint,
  requireManagedHlaeForRecording,
} from './queuePlan';
import { type QueueItem, useQueueStore } from './queueStore';
import { DirectorPlanPreview } from './DirectorPlanPreview';
import { ProductionSectionNav } from '../production/ProductionSectionNav';

type QueueFilter = 'all' | QueueItem['category'];

export function recordingExecutionOutcome(status: JobStatus): {
  tracksActiveJob: boolean;
  tone: 'info' | 'success' | 'warning' | 'danger';
  key: MessageKey;
} {
  if (status === 'failed') {
    return { tracksActiveJob: false, tone: 'danger', key: 'activity.status.failed' };
  }
  if (status === 'cancelled') {
    return { tracksActiveJob: false, tone: 'warning', key: 'activity.status.cancelled' };
  }
  if (status === 'completed') {
    return { tracksActiveJob: false, tone: 'success', key: 'activity.status.completed' };
  }
  return {
    tracksActiveJob: true,
    tone: status === 'cancelling' ? 'warning' : 'info',
    key: `activity.status.${status}`,
  };
}

const categoryLabel: Record<QueueItem['category'], string> = {
  'multi-kill': msg("m0424"),
  clutch: msg("m0879"),
  entry: msg("m1322"),
  utility: msg("m1250"),
  custom: msg("m1097"),
};

type ValidatedPlan = {
  response: RecordingPlanResponse;
  fingerprint: string;
};

type PreflightState =
  | { status: 'idle'; data: null; message: null }
  | { status: 'loading'; data: null; message: null }
  | { status: 'success'; data: DemoPlaybackPreflight; message: string }
  | { status: 'error'; data: null; message: string };

type QueuePlaybackReadinessProps = {
  itemCount: number;
  playbackActive: boolean;
  status: DemoPlaybackStatus | null;
  error: string | null;
};

export function QueuePlaybackReadiness({
  itemCount,
  playbackActive,
  status,
  error,
}: QueuePlaybackReadinessProps) {
  if (!playbackReadinessRelevant(itemCount, playbackActive)) return null;

  return (
    <>
      {error ? <Notice tone="warning" title={msg("m0783")}>{error}</Notice> : null}
      {status && !status.ready_to_launch ? (
        <Notice tone="danger" title={msg("m0782")}>{msg("m0900")}</Notice>
      ) : status && !status.gsi_ready ? (
        <Notice tone="warning" title={msg("m0345")}>{msg("m1140")}</Notice>
      ) : null}
    </>
  );
}

export function QueuePage() {
  const { t } = useI18n();
  const items = useQueueStore((state) => state.items);
  const selectedId = useQueueStore((state) => state.selectedId);
  const select = useQueueStore((state) => state.select);
  const update = useQueueStore((state) => state.update);
  const remove = useQueueStore((state) => state.remove);
  const clear = useQueueStore((state) => state.clear);
  const move = useQueueStore((state) => state.move);
  const reorder = useQueueStore((state) => state.reorder);
  const toggleAll = useQueueStore((state) => state.toggleAll);
  const [filter, setFilter] = useState<QueueFilter>('all');
  const [search, setSearch] = useState('');
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [validatedPlan, setValidatedPlan] = useState<ValidatedPlan | null>(null);
  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const [job, setJob] = useState<RecordingJob | null>(null);
  const [jobPollError, setJobPollError] = useState<string | null>(null);
  const [playbackStatus, setPlaybackStatus] = useState<DemoPlaybackStatus | null>(null);
  const [playbackStatusError, setPlaybackStatusError] = useState<string | null>(null);
  const [stopReconcileNotice, setStopReconcileNotice] = useState<string | null>(null);
  const runtimeSession = useRuntimeStore((state) => state.session);
  const beginRemoteRead = useRuntimeStore((state) => state.beginRemoteRead);
  const applyRemoteSession = useRuntimeStore((state) => state.applyRemoteSession);
  const beginPlaybackStop = useRuntimeStore((state) => state.beginPlaybackStop);
  const completeRuntimeTransition = useRuntimeStore((state) => state.completeTransition);
  const planAction = useAsyncAction<RecordingPlanResponse>();
  const hlaePreparationAction = useAsyncAction<HlaeStatus>();
  const executeAction = useAsyncAction<RecordingExecutionResponse>();
  const [executionNotice, setExecutionNotice] = useState<{
    tone: 'info' | 'success' | 'warning' | 'danger';
    message: string;
  } | null>(null);
  const abortAction = useAsyncAction<RecordingJob>();
  const previewAction = useAsyncAction<DemoPlaybackLaunch>();
  const stopPlaybackAction = useAsyncAction<DemoPlaybackStop>();
  const [preflightState, setPreflightState] = useState<PreflightState>({
    status: 'idle',
    data: null,
    message: null,
  });
  const preflightController = useRef<AbortController | null>(null);
  const preflightGeneration = useRef(0);
  const previewInFlight = useRef(false);

  const selected = items.find((item) => item.id === selectedId) ?? null;
  const jobStage = job ? recordingJobStage(job.message) : null;
  const enabledItems = items.filter((item) => item.enabled);
  const realEnabledItems = enabledItems.filter((item) => item.origin === 'demo');
  const localEstimatedSeconds = enabledItems.reduce<number | null>((total, item) => {
    if (total === null) return null;
    const duration = queueItemDurationSeconds(item);
    return duration === null ? null : total + duration;
  }, 0);
  const currentFingerprint = useMemo(() => recordingQueueFingerprint(items), [items]);
  const currentPlan = validatedPlan?.fingerprint === currentFingerprint ? validatedPlan.response : null;
  const estimatedSeconds = currentPlan ? currentPlan.estimated_seconds : localEstimatedSeconds;
  const planIsStale = validatedPlan !== null && currentPlan === null;
  const directorBlocked = (currentPlan?.director.unresolved_victim_requests ?? 0) > 0;
  const itemTickRates = enabledItems.map(queueItemTickRate);
  const hasUnavailableTickRate = itemTickRates.some((tickRate) => tickRate === null);
  const enabledTickRates = new Set(itemTickRates.filter((tickRate): tickRate is number => tickRate !== null));
  const tickRateLabel = hasUnavailableTickRate
    ? t('queue.tickRateUnavailableShort')
    : enabledTickRates.size === 1
      ? `${[...enabledTickRates][0]?.toLocaleString(currentLocale())} tick`
      : msg("m1245");
  const previewOnly = enabledItems.length > 0 && realEnabledItems.length === 0;
  const jobIsActive = activeJobId !== null || (job !== null && ['queued', 'preparing', 'running', 'cancelling'].includes(job.status));
  const playbackSessionActive = runtimeSession === 'playback' || runtimeSession === 'playback_launching' || runtimeSession === 'playback_stopping';
  const playbackBlockReason = demoPlaybackBlockReason(selected, jobIsActive, playbackSessionActive);
  const preflightBlockReason = selected?.origin !== 'demo'
    ? msg("m1003")
    : queueItemTickRate(selected) === null
      ? t('queue.tickRateUnavailable')
      : null;
  const selectedIdRef = useRef(selectedId);
  selectedIdRef.current = selectedId;
  const selectedPlaybackFingerprint = selected ? demoPlaybackFingerprint(selected) : null;
  const selectedPlaybackFingerprintRef = useRef(selectedPlaybackFingerprint);
  selectedPlaybackFingerprintRef.current = selectedPlaybackFingerprint;

  useEffect(() => {
    const controller = new AbortController();
    const runtimeStamp = beginRemoteRead();
    void commands.runtimeState(controller.signal).then((state) => {
      if (state.active_recording_job) setActiveJobId(state.active_recording_job);
      applyRemoteSession(state.runtime_session, runtimeStamp);
    }).catch(() => {
      // The page remains usable when the local service is still starting.
    });
    void commands.playbackStatus(controller.signal).then((status) => {
      setPlaybackStatus(status);
      setPlaybackStatusError(null);
    }).catch((error) => {
      if (!controller.signal.aborted) setPlaybackStatusError(readableError(error));
    });
    return () => controller.abort();
  }, [applyRemoteSession, beginRemoteRead]);

  useEffect(() => {
    preflightGeneration.current += 1;
    preflightController.current?.abort();
    preflightController.current = null;
    setPreflightState({ status: 'idle', data: null, message: null });
    return () => {
      preflightGeneration.current += 1;
      preflightController.current?.abort();
    };
  }, [selectedPlaybackFingerprint]);

  useEffect(() => {
    if (runtimeSession !== 'idle' || stopPlaybackAction.state.status !== 'error') return;
    stopPlaybackAction.reset();
    setStopReconcileNotice(msg("m0789"));
  }, [runtimeSession, stopPlaybackAction.reset, stopPlaybackAction.state.status]);

  useEffect(() => {
    if (!activeJobId) return undefined;
    let disposed = false;
    let timer: number | undefined;
    const controller = new AbortController();

    const refresh = async () => {
      try {
        const next = await commands.getRecordingJob(activeJobId, controller.signal);
        if (disposed) return;
        setJob(next);
        setJobPollError(null);
        if (['completed', 'failed', 'cancelled'].includes(next.status)) {
          setActiveJobId(null);
          return;
        }
        timer = window.setTimeout(() => void refresh(), 750);
      } catch (error) {
        if (disposed) return;
        setJobPollError(readableError(error));
        timer = window.setTimeout(() => void refresh(), 2_000);
      }
    };

    void refresh();
    return () => {
      disposed = true;
      controller.abort();
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [activeJobId]);

  const filtered = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    return items.filter((item) =>
      (filter === 'all' || item.category === filter) &&
      (!query || `${item.title} ${item.demoName} ${item.playerName}`.toLocaleLowerCase().includes(query)),
    );
  }, [filter, items, search]);

  const handlePlan = async () => {
    setValidatedPlan(null);
    const prepared = await hlaePreparationAction.run(
      () => requireManagedHlaeForRecording(
        commands.prepareManagedHlae,
        t('queue.movieEnginePreparationFailed'),
      ),
      t('queue.movieEnginePrepared'),
    );
    if (!prepared) return;
    const latestItems = useQueueStore.getState().items;
    const request: RecordingQueueRequest = buildRecordingQueueRequest(latestItems);
    const fingerprint = recordingQueueFingerprint(latestItems);
    const result = await planAction.run(() => commands.planRecording(request), msg("m0607"));
    if (result) setValidatedPlan({ response: result, fingerprint });
  };

  const handleExecute = async () => {
    const latestItems = useQueueStore.getState().items;
    if (!matchesRecordingQueueFingerprint(validatedPlan?.fingerprint, latestItems)) {
      setValidatedPlan(null);
      return;
    }
    const planId = validatedPlan?.response.plan_id;
    if (!planId) return;
    setExecutionNotice(null);
    const result = await executeAction.run(
      // The trusted confirmation is owned by the native desktop bridge. The
      // renderer never grants itself permission to start an insecure CS2.
      () => commands.executeRecordingPlan(planId, false),
    );
    if (result) {
      const outcome = recordingExecutionOutcome(result.status);
      setValidatedPlan(null);
      setJobPollError(null);
      if (outcome.tracksActiveJob) {
        setJob(null);
        setActiveJobId(result.job_id);
        setExecutionNotice({ tone: outcome.tone, message: t(outcome.key) });
      } else {
        setActiveJobId(null);
        let terminal: RecordingJob | null = null;
        try {
          terminal = await commands.getRecordingJob(result.job_id);
        } catch {
          // The execution response is still authoritative for its terminal status.
        }
        setJob(terminal);
        setExecutionNotice({
          tone: outcome.tone,
          message: terminal?.message.trim() || t(outcome.key),
        });
      }
      return;
    }

    // A transport failure can arrive after the native command was accepted.
    // Reconcile before allowing another launch so the recording does not
    // become detached from this page.
    try {
      const runtime = await commands.runtimeState();
      if (runtime.active_recording_job) {
        executeAction.reset();
        setValidatedPlan(null);
        setJob(null);
        setJobPollError(null);
        setActiveJobId(runtime.active_recording_job);
      }
    } catch {
      // The opaque plan remains available for an idempotent retry.
    }
  };

  const handleCancel = async () => {
    const targetId = recordingJobCancelTarget(activeJobId, job);
    if (!targetId) return;
    const result = await abortAction.run(() => commands.cancelRecordingJob(targetId), msg("m0539"));
    if (result) {
      setJob(result);
      setActiveJobId(result.id);
    }
  };

  const handlePlaybackPreflight = async () => {
    if (!selected || selected.origin !== 'demo') return;
    const playbackOptions = buildDemoPlaybackOptions(selected);
    if (playbackOptions === null) return;
    preflightController.current?.abort();
    const controller = new AbortController();
    const generation = preflightGeneration.current + 1;
    const item = selected;
    const fingerprint = demoPlaybackFingerprint(item);
    preflightGeneration.current = generation;
    preflightController.current = controller;
    setPreflightState({ status: 'loading', data: null, message: null });
    try {
      const result = await commands.preflightDemo(
        item.demoId,
        playbackOptions,
        controller.signal,
      );
      const currentItem = useQueueStore.getState().items.find(
        (candidate) => candidate.id === selectedIdRef.current,
      ) ?? null;
      if (
        controller.signal.aborted
        || generation !== preflightGeneration.current
        || selectedIdRef.current !== item.id
        || selectedPlaybackFingerprintRef.current !== fingerprint
        || currentItem?.origin !== 'demo'
        || demoPlaybackFingerprint(currentItem) !== fingerprint
      ) return;
      setPreflightState({
        status: 'success',
        data: result,
        message: item.perspective === 'victim'
          ? msg("m0034")
          : msg("m0033"),
      });
      setPlaybackStatus(result.status);
    } catch (error) {
      if (
        !controller.signal.aborted
        && generation === preflightGeneration.current
        && selectedIdRef.current === item.id
        && selectedPlaybackFingerprintRef.current === fingerprint
        && useQueueStore.getState().selectedId === item.id
        && useQueueStore.getState().items.some((candidate) =>
          candidate.id === item.id && demoPlaybackFingerprint(candidate) === fingerprint)
      ) {
        setPreflightState({ status: 'error', data: null, message: readableError(error) });
      }
    } finally {
      if (generation === preflightGeneration.current) preflightController.current = null;
    }
  };

  const handlePreview = async () => {
    if (previewInFlight.current || !selected || demoPlaybackBlockReason(selected, jobIsActive, playbackSessionActive) !== null) return;
    const playbackOptions = buildDemoPlaybackOptions(selected);
    if (playbackOptions === null) return;
    previewInFlight.current = true;
    try {
      const result = await previewAction.run(
        () => runManagedPlaybackLaunch(
          () => commands.playDemo(selected.demoId, playbackOptions),
        ),
        msg("m0548"),
      );
      if (result) {
        setPlaybackStatus(result.preflight.status);
      }
    } finally {
      previewInFlight.current = false;
    }
  };

  const handleStopPlayback = async () => {
    if (!window.confirm(msg("m0219"))) return;
    const transitionRevision = beginPlaybackStop();
    if (transitionRevision === null) return;
    setStopReconcileNotice(null);
    const result = await stopPlaybackAction.run(
      () => commands.stopPlayback(),
      msg("m0781"),
    );
    if (result) {
      completeRuntimeTransition(transitionRevision, 'idle');
      return;
    }
    try {
      const current = await commands.runtimeState();
      completeRuntimeTransition(transitionRevision, current.runtime_session);
      if (current.runtime_session === 'idle') {
        stopPlaybackAction.reset();
        setStopReconcileNotice(msg("m0221"));
      }
    } catch {
      completeRuntimeTransition(transitionRevision, 'playback_stopping');
    }
  };

  const formatEstimate = (seconds: number | null) => seconds === null
    ? t('queue.durationUnavailable')
    : msgf("m0102", [Math.floor(seconds / 60), Math.round(seconds % 60)]);

  return (
    <div className="page page--queue">
      <PageHeader
        eyebrow="RECORDING DIRECTOR"
        title={t('queue.title')}
        description={t('queue.description')}
        actions={items.length > 0 || playbackSessionActive ? (
          <>
            {items.length > 0 ? <>
              <Button onClick={() => toggleAll(enabledItems.length !== items.length)}>
                <ListChecks size={15} />{enabledItems.length === items.length ? t('queue.disableAll') : t('queue.enableAll')}
              </Button>
              <Button variant="danger" onClick={clear}><Trash2 size={14} />{t('common.clear')}</Button>
            </> : null}
            {playbackSessionActive ? <Button variant="danger" disabled={stopPlaybackAction.state.status === 'loading' || runtimeSession !== 'playback'} onClick={() => void handleStopPlayback()}>{stopPlaybackAction.state.status === 'loading' || runtimeSession === 'playback_stopping' ? <Spinner /> : <PauseCircle size={14} />}{runtimeSession === 'playback_launching' ? msg("m0846") : runtimeSession === 'playback_stopping' ? msg("m0844") : msg("m0220")}</Button> : null}
          </>
        ) : undefined}
      />
      <ProductionSectionNav />

      {previewOnly ? (
        <Notice tone="warning" title={msg("m0591")}>

         {msg("m0348")}
        </Notice>
      ) : null}
      <QueuePlaybackReadiness
        itemCount={items.length}
        playbackActive={playbackSessionActive}
        status={playbackStatus}
        error={playbackStatusError}
      />
      {planAction.state.message && (planAction.state.status === 'error' || currentPlan) ? <Notice tone={planAction.state.status === 'error' ? 'danger' : 'success'}>{planAction.state.message}</Notice> : null}
      {hlaePreparationAction.state.message ? <Notice tone={hlaePreparationAction.state.status === 'error' ? 'danger' : 'success'}>{hlaePreparationAction.state.message}</Notice> : null}
      {currentPlan ? <DirectorPlanPreview plan={currentPlan.director} /> : null}
      {planIsStale ? <Notice tone="warning" title={msg("m0606")}>{msg("m1280")}</Notice> : null}
      {executeAction.state.message ? <Notice tone={executeAction.state.status === 'error' ? 'danger' : 'success'}>{executeAction.state.message}</Notice> : null}
      {executionNotice ? <Notice tone={executionNotice.tone}>{executionNotice.message}</Notice> : null}
      {abortAction.state.message ? <Notice tone={abortAction.state.status === 'error' ? 'danger' : 'success'}>{abortAction.state.message}</Notice> : null}
      {previewAction.state.message ? <Notice tone={previewAction.state.status === 'error' ? 'danger' : 'success'}>{previewAction.state.message}</Notice> : null}
      {stopPlaybackAction.state.message ? <Notice tone={stopPlaybackAction.state.status === 'error' ? 'danger' : 'success'}>{stopPlaybackAction.state.message}</Notice> : null}
      {stopReconcileNotice ? <Notice tone="warning">{stopReconcileNotice}</Notice> : null}
      {preflightState.message ? <Notice tone={preflightState.status === 'error' ? 'danger' : 'success'}>{preflightState.message}{preflightState.data ? msgf("m0011", [(preflightState.data.demo_size / 1_048_576).toFixed(1), preflightState.data.demo_sha256.slice(0, 12)]) : ''}</Notice> : null}
      {jobPollError ? <Notice tone="warning" title={msg("m0605")}>{jobPollError}{msg("m1337")}</Notice> : null}
      {job ? (
        <Card className="queue-job-progress" aria-live="polite">
          <div>
            <span className="eyebrow">LIVE JOB</span>
            <strong>{job.status === 'completed' ? msg("m0598") : job.status === 'failed' ? msg("m0597") : job.status === 'cancelled' ? msg("m0599") : job.status === 'cancelling' ? msg("m0847") : msg("m0608")}</strong>
            <small>{jobStage ? t(jobStage.key) : job.message || msgf("m0195", [job.id])}</small>
          </div>
          <div
            className="queue-job-progress__bar"
            role="progressbar"
            aria-label={jobStage ? t(jobStage.key) : undefined}
            aria-valuemin={0}
            aria-valuemax={jobStage ? jobStage.total : 100}
            aria-valuenow={jobStage ? jobStage.ordinal : Math.round(job.progress * 100)}
          >
            <span style={{ width: `${Math.max(0, Math.min(100, job.progress * 100))}%` }} />
          </div>
          <div className="queue-job-progress__meta">
            <Badge tone={job.status === 'completed' ? 'success' : job.status === 'failed' ? 'danger' : job.status === 'cancelled' ? 'neutral' : 'blue'}>{job.status}</Badge>
            <span>{jobStage ? `${t('queue.recordingStageLabel')} ${jobStage.ordinal}/${jobStage.total}` : `${Math.round(job.progress * 100)}%`}</span>
            <span>{job.outputs.length} {msg("m0163")}</span>
          </div>
        </Card>
      ) : null}

      {items.length === 0 ? (
        <Card className="queue-empty-workspace">
          <EmptyState
            icon={<Video size={24} />}
            title={t('queue.empty')}
            description={t('production.startFromMatch')}
            action={
              <Link className="button button--primary button--md" to="/library">
                {t('guide.openLibrary')}<ChevronRight size={15} />
              </Link>
            }
          />
        </Card>
      ) : <>
      <section className="queue-stats">
        <Card><span className="queue-stat-icon"><Video size={17} /></span><div><small>{msg("m1281")}</small><strong>{items.length}</strong></div><Badge tone="neutral">{enabledItems.length} {msg("m0365")}</Badge></Card>
        <Card><span className="queue-stat-icon"><Clock3 size={17} /></span><div><small>{msg("m1312")}</small><strong>{formatEstimate(estimatedSeconds)}</strong></div><Badge tone="blue">{tickRateLabel}</Badge></Card>
        <Card><span className="queue-stat-icon"><UserRound size={17} /></span><div><small>{msg("m1016")}</small><strong>{new Set(items.map((item) => item.playerName)).size}</strong></div><Badge tone="neutral">{msg("m1017")}</Badge></Card>
        <Card><span className="queue-stat-icon"><Sparkles size={17} /></span><div><small>{msg("m1108")}</small><strong>{currentPlan ? msg("m0522") : msg("m0613")}</strong></div><Badge tone={currentPlan ? 'success' : 'warning'}>{currentPlan ? msgf("m0109", [currentPlan.active_items]) : msg("m0761")}</Badge></Card>
      </section>

      <div className="queue-layout">
        <section className="queue-list-panel">
          <Card className="queue-toolbar">
            <div className="search-box"><Search size={15} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder={msg("m0669")} aria-label={msg("m0665")} /></div>
            <div className="queue-filters" role="group" aria-label={msg("m0965")}>
              {(['all', 'multi-kill', 'clutch', 'entry', 'utility'] as const).map((value) => <button type="button" key={value} className={filter === value ? 'is-active' : undefined} onClick={() => setFilter(value)}>{value === 'all' ? msg("m0229") : categoryLabel[value]}</button>)}
            </div>
          </Card>

          {filtered.length > 0 ? (
            <div className="queue-list">
              {filtered.map((item) => {
                const index = items.findIndex((current) => current.id === item.id);
                const durationSeconds = queueItemDurationSeconds(item);
                return (
                  <article
                    key={item.id}
                    draggable
                    onDragStart={() => setDragIndex(index)}
                    onDragOver={(event) => event.preventDefault()}
                    onDrop={() => {
                      if (dragIndex !== null) reorder(dragIndex, index);
                      setDragIndex(null);
                    }}
                    className={`queue-item${selectedId === item.id ? ' is-selected' : ''}${item.enabled ? '' : ' is-disabled'}`}
                  >
                    <button className="queue-item__main" type="button" onClick={() => select(item.id)}>
                      <span className="queue-item__grip"><GripVertical size={16} /></span>
                      <span className={`queue-item__index category-${item.category}`}>{String(index + 1).padStart(2, '0')}</span>
                      <span className="queue-item__copy"><span><Badge tone={item.category === 'clutch' ? 'warning' : 'blue'}>{categoryLabel[item.category]}</Badge>{item.origin === 'preview' ? <Badge tone="neutral">{msg("m1038")}</Badge> : null}</span><strong>{item.title}</strong><small>{item.demoName} · {item.playerName}</small></span>
                      <span className="queue-item__timing"><strong>{durationSeconds === null ? t('queue.durationUnavailable') : `${durationSeconds.toFixed(1)}s`}</strong><small>{item.perspective === 'victim' ? msg("m0331") : msg("m1017")} · 1×</small></span>
                      <ChevronRight size={16} />
                    </button>
                    <div className="queue-item__buttons">
                      <IconButton label={msg("m0138")} disabled={index === 0} onClick={() => move(item.id, -1)}><ArrowUp size={14} /></IconButton>
                      <IconButton label={msg("m0141")} disabled={index === items.length - 1} onClick={() => move(item.id, 1)}><ArrowDown size={14} /></IconButton>
                      <IconButton label={msg("m1048")} onClick={() => remove(item.id)}><X size={14} /></IconButton>
                    </div>
                  </article>
                );
              })}
            </div>
          ) : (
            <Card><EmptyState icon={<Video size={24} />} title={t('queue.empty')} description={t('queue.emptyDescription')} /></Card>
          )}
        </section>

        <aside className="queue-inspector">
          {selected ? (
            <>
              <div className="inspector-header"><div><span className="eyebrow">CLIP INSPECTOR</span><h2>{msg("m0955")}</h2></div><Badge tone={selected.enabled ? 'success' : 'neutral'}>{selected.enabled ? msg("m0365") : msg("m0222")}</Badge></div>
              <div className="queue-preview"><div className="mini-crosshair"><span /><span /></div><span>{selected.demoName}</span><strong>{selected.title}</strong><small>tick {selected.startTick.toLocaleString(currentLocale())} — {selected.endTick.toLocaleString(currentLocale())}</small><div className="queue-preview__actions"><Button size="sm" disabled={preflightBlockReason !== null || preflightState.status === 'loading'} title={preflightBlockReason ?? (selected.perspective === 'victim' ? msg("m0823") : msg("m0822"))} onClick={() => void handlePlaybackPreflight()}>{preflightState.status === 'loading' ? <Spinner /> : <ListChecks size={13} />}{msg("m0364")}</Button><Button size="sm" disabled={playbackBlockReason !== null || previewAction.state.status === 'loading' || playbackStatus?.ready_to_launch === false} title={playbackBlockReason ?? (playbackStatus?.ready_to_launch === false ? msg("m0801") : msg("m1326"))} onClick={() => void handlePreview()}>{previewAction.state.status === 'loading' ? <Spinner /> : <Play size={13} />}{msg("m1311")}</Button></div>{selected.perspective === 'victim' ? <small role="status">{playbackBlockReason}</small> : null}</div>
              <div className="inspector-fields">
                <Field label={msg("m0964")}><TextInput value={selected.title} onChange={(event) => update(selected.id, { title: event.target.value })} /></Field>
                <Field label={msg("m1275")} hint={selected.hasVictimPov ? msg("m0332") : msg("m0583")}>
                  <select value={selected.perspective === 'victim' ? 'victim' : 'pov'} onChange={(event) => update(selected.id, { perspective: event.target.value as 'pov' | 'victim' })}>
                    <option value="pov">{msg("m1016")}</option>
                    <option value="victim" disabled={!selected.hasVictimPov}>{msg("m0331")}</option>
                  </select>
                </Field>
                <div className="field-row">
                  <Field label={msg("m0297")}><div className="number-control"><input type="number" min="0" max="15" step="0.5" value={selected.preRollSeconds} onChange={(event) => update(selected.id, { preRollSeconds: Number(event.target.value) })} /><span>{msg("m1044")}</span></div></Field>
                  <Field label={msg("m0361")}><div className="number-control"><input type="number" min="0" max="15" step="0.5" value={selected.postRollSeconds} onChange={(event) => update(selected.id, { postRollSeconds: Number(event.target.value) })} /><span>{msg("m1044")}</span></div></Field>
                </div>
                <Notice tone="info">
                  <strong>{t('queue.nativeCaptureTitle')}</strong> · {t('queue.nativeCaptureDescription')}
                </Notice>
                <Field label={t('queue.deterministicSpeed')}><div className="number-control"><strong>1.0×</strong><span>HLAE</span></div></Field>
                <div className="toggle-list">
                  <label><span><PauseCircle size={15} /><span><strong>{msg("m0319")}</strong><small>{msg("m0245")}</small></span></span><input type="checkbox" checked={selected.enabled} onChange={(event) => update(selected.id, { enabled: event.target.checked })} /></label>
                </div>
              </div>
            </>
          ) : (
            <EmptyState icon={<SlidersHorizontal size={24} />} title={t('queue.choose')} description={t('queue.chooseDescription')} />
          )}
        </aside>
      </div>

      <div className="queue-action-dock">
        <div className="queue-action-dock__summary"><span className="queue-stat-icon"><Timer size={17} /></span><div><small>{msg("m0810")}</small><strong>{enabledItems.length} {msg("m0157")} {formatEstimate(estimatedSeconds)}</strong></div>{previewOnly ? <Badge tone="warning"><CircleAlert size={11} />{msg("m1039")}</Badge> : null}</div>
        <div className="queue-action-dock__actions">
          {jobIsActive ? <Button variant="danger" onClick={() => void handleCancel()} disabled={abortAction.state.status === 'loading' || job?.status === 'cancelling'}>{abortAction.state.status === 'loading' ? <Spinner /> : <PauseCircle size={15} />}{msg("m1075")}</Button> : null}
          <Button disabled={realEnabledItems.length === 0 || planAction.state.status === 'loading' || hlaePreparationAction.state.status === 'loading'} onClick={() => void handlePlan()}>{planAction.state.status === 'loading' || hlaePreparationAction.state.status === 'loading' ? <Spinner /> : <ListChecks size={15} />}{msg("m0990")}</Button>
          <Button variant="primary" title={directorBlocked ? msg("m0742") : undefined} disabled={!currentPlan || directorBlocked || realEnabledItems.length === 0 || executeAction.state.status === 'loading' || jobIsActive} onClick={() => void handleExecute()}>{executeAction.state.status === 'loading' ? <Spinner /> : <Play size={15} />}{msg("m0558")}</Button>
        </div>
      </div>
      </>}
    </div>
  );
}
