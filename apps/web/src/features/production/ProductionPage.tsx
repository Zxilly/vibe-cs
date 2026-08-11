import {
  ArrowRight,
  CheckCircle2,
  Clapperboard,
  FileOutput,
  Library,
  ListVideo,
  Video,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';

import { api, readableError } from '../../shared/api/client';
import { useI18n } from '../../shared/i18n';
import { useQueueStore } from '../queue/queueStore';
import { Notice, PageHeader } from '../../shared/ui';
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
  errors: string[];
};

const emptyOverview: ProductionOverview = {
  matches: { available: false, value: 0 },
  clips: { available: false, value: 0 },
  projects: { available: false, value: 0 },
  outputs: { available: false, value: 0 },
  errors: [],
};

export function ProductionPage() {
  const { t } = useI18n();
  const queuedSegments = useQueueStore((state) => state.items.length);
  const [loading, setLoading] = useState(true);
  const [overview, setOverview] = useState<ProductionOverview>(emptyOverview);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    void Promise.allSettled([
      api.listDemos({ page: 1, page_size: 1, sort: 'newest' }, controller.signal),
      api.listRecordedClips(controller.signal),
      api.listLiteCutProjects(controller.signal),
      api.listOutputs({ page: 1, page_size: 1 }, controller.signal),
    ]).then(([matchesResult, clipsResult, projectsResult, outputsResult]) => {
      if (controller.signal.aborted) return;
      const errors = [matchesResult, clipsResult, projectsResult, outputsResult]
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
        errors,
      });
      setLoading(false);
    });
    return () => controller.abort();
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

      {overview.errors.length > 0 ? (
        <Notice tone="warning" title={t('common.unavailable')}>
          {t('production.serviceUnavailable')}
          <small>{overview.errors[0]}</small>
        </Notice>
      ) : null}

      <section className="production-summary" aria-label={t('production.summary')}>
        <div><span>{count(overview.matches)}</span><small>{t('production.matchesReady')}</small></div>
        <div><span>{queuedSegments}</span><small>{t('production.segmentsQueued')}</small></div>
        <div><span>{count(overview.clips)}</span><small>{t('production.clipsReady')}</small></div>
        <div><span>{count(overview.projects)}</span><small>{t('production.projectsReady')}</small></div>
      </section>

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

      <section className="production-next-step">
        <Video size={20} />
        <div><strong>{t('production.nextStep')}</strong><p>{queuedSegments > 0 ? t('production.continueRecording') : overview.clips.value > 0 ? t('production.continueEditing') : t('production.startFromMatch')}</p></div>
        <Link className="button button--primary button--md" to={queuedSegments > 0 ? '/queue' : overview.clips.value > 0 ? '/studio' : '/library'}>
          {queuedSegments > 0 ? t('production.openRecording') : overview.clips.value > 0 ? t('production.openEditing') : t('production.openMatches')}<ArrowRight size={14} />
        </Link>
      </section>
    </div>
  );
}
