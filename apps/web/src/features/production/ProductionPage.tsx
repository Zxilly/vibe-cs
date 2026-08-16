import {
  Activity,
  ArrowRight,
  CheckCircle2,
  Clapperboard,
  FileOutput,
  Library,
  ListVideo,
  Video,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';

import { commands, readableError } from '../../shared/desktop/client';
import type { ActivityStatus } from '../../shared/desktop/dto';
import type { ActivityItem } from '../../shared/desktop/viewModels';
import { type MessageKey, useI18n } from '../../shared/i18n';
import { useQueueStore } from '../queue/queueStore';
import { Notice, PageHeader } from '../../shared/ui';
import { activityHref } from '../activity/activitySelection';
import { startProductionActivityObservationAfterInitial } from './productionActivityObservation';
import { ProductionSectionNav } from './ProductionSectionNav';

type CountState = {
  available: boolean;
  value: number;
};

type ProductionOverview = {
  matches: CountState;
  clips: CountState;
  projects: CountState;
  outputs: CountState;
  activities: { available: boolean; items: ActivityItem[] };
  errors: string[];
};

const emptyOverview: ProductionOverview = {
  matches: { available: false, value: 0 },
  clips: { available: false, value: 0 },
  projects: { available: false, value: 0 },
  outputs: { available: false, value: 0 },
  activities: { available: false, items: [] },
  errors: [],
};

const activityStatusKeys: Record<ActivityStatus, MessageKey> = {
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

export function productionActivityPreview(items: ActivityItem[]): ActivityItem[] {
  return items.slice(0, 4);
}

export function productionActivityHref(activityId: string): string {
  return activityHref(activityId);
}

export function ProductionPage() {
  const { locale, t } = useI18n();
  const queuedSegments = useQueueStore((state) => state.items.length);
  const [loading, setLoading] = useState(true);
  const [overview, setOverview] = useState<ProductionOverview>(emptyOverview);
  const [activityRefresh, setActivityRefresh] = useState<{
    stale: boolean;
    error: string | null;
  }>({ stale: false, error: null });
  const activityDateFormatter = useMemo(() => new Intl.DateTimeFormat(locale, {
    dateStyle: 'short',
    timeStyle: 'short',
  }), [locale]);

  useEffect(() => {
    const controller = new AbortController();
    let disposed = false;
    setLoading(true);
    const activities = commands.listActivities({ page: 1, page_size: 4 }, controller.signal);
    const overviewReady = Promise.allSettled([
      commands.listDemos({ page: 1, page_size: 1, sort: 'updated_desc' }, controller.signal),
      commands.listRecordedClips(controller.signal),
      commands.listEditorProjects(controller.signal),
      commands.listOutputs({ page: 1, page_size: 1 }, controller.signal),
      activities,
    ]).then(([matchesResult, clipsResult, projectsResult, outputsResult, activitiesResult]) => {
      if (disposed || controller.signal.aborted) return;
      const errors = [matchesResult, clipsResult, projectsResult, outputsResult, activitiesResult]
        .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
        .map((result) => readableError(result.reason));
      setOverview({
        matches: matchesResult.status === 'fulfilled'
          ? { available: true, value: matchesResult.value.total }
          : { available: false, value: 0 },
        clips: clipsResult.status === 'fulfilled'
          ? { available: true, value: clipsResult.value.total }
          : { available: false, value: 0 },
        projects: projectsResult.status === 'fulfilled'
          ? { available: true, value: projectsResult.value.items.length }
          : { available: false, value: 0 },
        outputs: outputsResult.status === 'fulfilled'
          ? { available: true, value: outputsResult.value.total }
          : { available: false, value: 0 },
        activities: activitiesResult.status === 'fulfilled'
          ? { available: true, items: productionActivityPreview(activitiesResult.value.items) }
          : { available: false, items: [] },
        errors,
      });
      setLoading(false);
      return activitiesResult.status === 'fulfilled' ? activitiesResult.value : undefined;
    });
    const stopActivityObservation = startProductionActivityObservationAfterInitial({
      initial: overviewReady.then((feed) => {
        if (!feed) throw new Error('Activity preview is unavailable.');
        return feed;
      }),
      load: (signal) => commands.listActivities({ page: 1, page_size: 4 }, signal),
      onChange: ({ feed, stale, error }) => {
        setOverview((current) => ({
          ...current,
          activities: {
            available: true,
            items: productionActivityPreview(feed.items),
          },
        }));
        setActivityRefresh({ stale, error });
      },
    });
    return () => {
      disposed = true;
      controller.abort();
      stopActivityObservation();
    };
  }, []);

  const count = (state: CountState) => loading || !state.available ? '—' : String(state.value);

  return (
    <div className="page page--production">
      <PageHeader
        eyebrow="PRODUCTION PIPELINE"
        title={t('production.title')}
        description={t('production.description')}
        actions={<Link className="button button--secondary button--md" to="/outputs"><FileOutput size={15} />{t('production.openDelivery')}</Link>}
      />
      <ProductionSectionNav />

      {overview.errors.length > 0 || activityRefresh.error ? (
        <Notice tone="warning" title={t('common.unavailable')}>
          {activityRefresh.stale ? t('activity.observationStale') : t('production.serviceUnavailable')}
          <small>{activityRefresh.error ?? overview.errors[0]}</small>
        </Notice>
      ) : null}

      <section className="production-summary" aria-label={t('production.summary')}>
        <div><span>{count(overview.matches)}</span><small>{t('production.matchesReady')}</small></div>
        <div><span>{queuedSegments}</span><small>{t('production.segmentsQueued')}</small></div>
        <div><span>{count(overview.clips)}</span><small>{t('production.clipsReady')}</small></div>
        <div><span>{count(overview.projects)}</span><small>{t('production.projectsReady')}</small></div>
      </section>

      <div className="production-workspace">
        <section className="production-flow" aria-label={t('production.workflow')}>
          <article>
            <span className="production-flow__number">01</span>
            <div className="production-flow__icon"><Library size={22} /></div>
            <div><span className="eyebrow">SOURCE</span><h2>{t('production.selectMatches')}</h2><p>{t('production.selectMatchesDescription')}</p></div>
            <strong>{count(overview.matches)}</strong>
            <Link to="/library">{t('production.openMatches')}<ArrowRight size={14} /></Link>
          </article>
          <article>
            <span className="production-flow__number">02</span>
            <div className="production-flow__icon"><ListVideo size={22} /></div>
            <div><span className="eyebrow">CAPTURE</span><h2>{t('production.planRecording')}</h2><p>{t('production.planRecordingDescription')}</p></div>
            <strong>{queuedSegments}</strong>
            <Link to="/queue">{t('production.openRecording')}<ArrowRight size={14} /></Link>
          </article>
          <article>
            <span className="production-flow__number">03</span>
            <div className="production-flow__icon"><Clapperboard size={22} /></div>
            <div><span className="eyebrow">EDIT</span><h2>{t('production.editProjects')}</h2><p>{t('production.editProjectsDescription')}</p></div>
            <strong>{count(overview.projects)}</strong>
            <Link to="/studio">{t('production.openEditing')}<ArrowRight size={14} /></Link>
          </article>
          <article>
            <span className="production-flow__number">04</span>
            <div className="production-flow__icon"><CheckCircle2 size={22} /></div>
            <div><span className="eyebrow">DELIVER</span><h2>{t('production.reviewDelivery')}</h2><p>{t('production.reviewDeliveryDescription')}</p></div>
            <strong>{count(overview.outputs)}</strong>
            <Link to="/outputs">{t('production.openDelivery')}<ArrowRight size={14} /></Link>
          </article>
        </section>

        <aside className="production-activity" aria-label={t('activity.title')}>
          <header><div><span className="eyebrow">ACTIVITY</span><h2>{t('activity.title')}</h2></div><Link to="/activity">{t('nav.activity')}<ArrowRight size={13} /></Link></header>
          {overview.activities.items.length > 0 ? (
            <div className="production-activity__list">
              {overview.activities.items.map((item) => (
                <Link key={item.id} to={productionActivityHref(item.id)} data-status={item.status}>
                  <span><Activity size={15} /></span>
                  <div><strong>{item.subject ?? item.context_id ?? item.id}</strong><small>{t(activityStatusKeys[item.status])} · {activityDateFormatter.format(new Date(item.updated_at))}</small></div>
                </Link>
              ))}
            </div>
          ) : <p>{overview.activities.available ? t('activity.empty') : t('common.unavailable')}</p>}
        </aside>

        <section className="production-next-step">
          <Video size={20} />
          <div><strong>{t('production.nextStep')}</strong><p>{queuedSegments > 0 ? t('production.continueRecording') : overview.clips.value > 0 ? t('production.continueEditing') : t('production.startFromMatch')}</p></div>
          <Link className="button button--primary button--md" to={queuedSegments > 0 ? '/queue' : overview.clips.value > 0 ? '/studio' : '/library'}>
            {queuedSegments > 0 ? t('production.openRecording') : overview.clips.value > 0 ? t('production.openEditing') : t('production.openMatches')}<ArrowRight size={14} />
          </Link>
        </section>
      </div>
    </div>
  );
}
