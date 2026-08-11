import {
  ArrowRight,
  Clapperboard,
  Clock3,
  FileOutput,
  Film,
  Layers3,
  Video,
  WandSparkles,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';

import { api, readableError } from '../../shared/api/client';
import type { LiteCutProject, OutputItem, RecordedClip } from '../../shared/api/dto';
import { useI18n } from '../../shared/i18n';
import { Badge, Card, Notice, PageHeader, Spinner } from '../../shared/ui';
import { ProductionSectionNav } from '../production/ProductionSectionNav';

type ResourceState<T> = {
  available: boolean;
  items: T[];
};

type StudioOverview = {
  projects: ResourceState<LiteCutProject>;
  clips: ResourceState<RecordedClip>;
  outputs: ResourceState<OutputItem> & { total: number };
  errors: string[];
};

const emptyOverview: StudioOverview = {
  projects: { available: false, items: [] },
  clips: { available: false, items: [] },
  outputs: { available: false, items: [], total: 0 },
  errors: [],
};

export function StudioPage() {
  const { locale, t } = useI18n();
  const [loading, setLoading] = useState(true);
  const [overview, setOverview] = useState<StudioOverview>(emptyOverview);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    void Promise.allSettled([
      api.listLiteCutProjects(controller.signal),
      api.listRecordedClips(controller.signal),
      api.listOutputs({ page: 1, page_size: 6 }, controller.signal),
    ]).then(([projectsResult, clipsResult, outputsResult]) => {
      if (controller.signal.aborted) return;
      const errors = [projectsResult, clipsResult, outputsResult]
        .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
        .map((result) => readableError(result.reason));
      setOverview({
        projects: projectsResult.status === 'fulfilled'
          ? { available: true, items: projectsResult.value.items }
          : { available: false, items: [] },
        clips: clipsResult.status === 'fulfilled'
          ? { available: true, items: clipsResult.value.items }
          : { available: false, items: [] },
        outputs: outputsResult.status === 'fulfilled'
          ? { available: true, items: outputsResult.value.items, total: outputsResult.value.total }
          : { available: false, items: [], total: 0 },
        errors,
      });
      setLoading(false);
    });
    return () => controller.abort();
  }, []);

  const recentProjects = useMemo(
    () => [...overview.projects.items]
      .sort((left, right) => Date.parse(right.updated_at) - Date.parse(left.updated_at))
      .slice(0, 4),
    [overview.projects.items],
  );

  const metric = (available: boolean, value: number) => loading ? '—' : available ? String(value) : '—';

  return (
    <div className="page page--studio">
      <PageHeader
        eyebrow="CREATION WORKSPACE"
        title={t('studio.title')}
        description={t('studio.description')}
        actions={<Link className="button button--secondary button--md" to="/outputs"><FileOutput size={15} />{t('studio.openWorks')}</Link>}
      />
      <ProductionSectionNav />

      {overview.errors.length > 0 ? (
        <Notice tone="warning" title={t('common.unavailable')}>
          {t('studio.serviceUnavailable')}
          <small>{overview.errors[0]}</small>
        </Notice>
      ) : null}

      <section className="studio-metrics" aria-label={t('studio.title')}>
        <Card><span><Video size={17} /></span><div><strong>{metric(overview.clips.available, overview.clips.items.length)}</strong><small>{t('studio.recordedClips')}</small></div></Card>
        <Card><span><Layers3 size={17} /></span><div><strong>{metric(overview.projects.available, overview.projects.items.length)}</strong><small>{t('studio.projects')}</small></div></Card>
        <Card><span><FileOutput size={17} /></span><div><strong>{metric(overview.outputs.available, overview.outputs.total)}</strong><small>{t('studio.outputs')}</small></div></Card>
      </section>

      <section className="studio-mode-grid">
        <article className="studio-mode-card studio-mode-card--montage">
          <div className="studio-mode-card__icon"><Clapperboard size={25} /></div>
          <div>
            <span className="eyebrow">FAST ASSEMBLY</span>
            <h2>{t('studio.montageTitle')}</h2>
            <p>{t('studio.montageDescription')}</p>
          </div>
          <div className="studio-mode-card__meta">
            <Badge tone={overview.clips.available && overview.clips.items.length > 0 ? 'success' : 'neutral'}>
              {metric(overview.clips.available, overview.clips.items.length)} {t('studio.recordedClips')}
            </Badge>
          </div>
          <Link className="button button--primary button--md" to="/montage"><WandSparkles size={15} />{t('studio.montageAction')}<ArrowRight size={14} /></Link>
        </article>

        <article className="studio-mode-card studio-mode-card--editor">
          <div className="studio-mode-card__icon"><Film size={25} /></div>
          <div>
            <span className="eyebrow">MULTITRACK EDITOR</span>
            <h2>{t('studio.editorTitle')}</h2>
            <p>{t('studio.editorDescription')}</p>
          </div>
          <div className="studio-mode-card__meta">
            <Badge tone={overview.projects.available && overview.projects.items.length > 0 ? 'accent' : 'neutral'}>
              {metric(overview.projects.available, overview.projects.items.length)} {t('studio.projects')}
            </Badge>
          </div>
          <Link className="button button--primary button--md" to="/lite-cut"><Layers3 size={15} />{t('studio.editorAction')}<ArrowRight size={14} /></Link>
        </article>
      </section>

      <section className="studio-recent">
        <header><div><span className="eyebrow">RECENT PROJECTS</span><h2>{t('studio.latestProjects')}</h2></div>{loading ? <Spinner /> : null}</header>
        {recentProjects.length > 0 ? (
          <div className="studio-project-list">
            {recentProjects.map((project) => (
              <Link key={project.id} to={`/lite-cut?project=${encodeURIComponent(project.id)}`}>
                <span className="studio-project-list__icon"><Film size={17} /></span>
                <span><strong>{project.name}</strong><small><Clock3 size={12} />{new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(project.updated_at))} · {project.duration_seconds.toFixed(1)}s</small></span>
                <span>{t('studio.continueProject')}<ArrowRight size={13} /></span>
              </Link>
            ))}
          </div>
        ) : !loading && overview.projects.available ? <p className="studio-recent__empty">{t('studio.noProjects')}</p> : null}
      </section>
    </div>
  );
}
