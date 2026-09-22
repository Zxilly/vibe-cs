import { t } from '@lingui/core/macro';
import { useMemo, useState } from 'react';
import { Plural, Trans } from '@lingui/react/macro';
import { useNavigate } from 'react-router-dom';

import { useCreateProject, useProjects, useProjectDeliveryGate } from '../../../data/projects';
import { Empty, Skeleton } from '../../../design/data';
import { Alert } from '../../../design/feedback';
import { Page, Toolbar } from '../../../design/layout';
import { Badge, Button, Input } from '../../../design/primitives';
import { formatTimecode } from '../../../design/timeline';
import type { Project } from '../../../shared/desktop/dto';
import { ProjectOutputLink } from '../../../domain/project/ProjectOutputLink';
import { formatTaskClock } from '../../../domain/task';
import { RouteLink } from '../../shared/navigation/RouteLink';

export function ProjectsPage() {
  const navigate = useNavigate();
  const projects = useProjects();
  const create = useCreateProject();
  const [query, setQuery] = useState('');
  const rows = useMemo(() => [...(projects.data ?? [])].sort((a, b) => b.updated_at.localeCompare(a.updated_at)).filter((project) => project.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())), [projects.data, query]);

  const createProject = () => {
    create.mutate(
      { name: t`新作品`, width: 1920, height: 1080, fps: 60, source_demo_ids: [] },
      { onSuccess: (project) => void navigate(`/projects/${encodeURIComponent(project.id)}`) },
    );
  };
  const newProject = (
    <Button variant="primary" size="md" disabled={create.isPending} aria-busy={create.isPending} onClick={createProject}>
      {create.isPending ? <Trans>正在创建…</Trans> : <Trans>新建作品</Trans>}
    </Button>
  );

  const search = query.trim();
  const searching = search !== '';

  return (
    <Page
      toolbar={
        <Toolbar
          title={<Trans>作品</Trans>}
          meta={projects.data === undefined ? undefined : <Plural value={rows.length} other="# 个作品" />}
          primary={newProject}
        >
          <Input size="sm" type="search" aria-label={t`搜索作品`} placeholder={t`搜索作品…`} value={query} onChange={(event) => setQuery(event.currentTarget.value)} />
        </Toolbar>
      }
    >
      <div className="flex flex-col gap-5 p-6" data-projects-list>
        {projects.error === null ? null : (
          <Alert variant="danger" action={{ label: projects.isFetching ? <Trans>正在加载…</Trans> : <Trans>重新加载</Trans>, disabled: projects.isFetching, onAction: () => void projects.refetch() }}>
            <Trans>作品列表暂时读不到。</Trans>
          </Alert>
        )}
        {create.error === null ? null : (
          <Alert variant="danger" action={{ label: <Trans>重试</Trans>, disabled: create.isPending, onAction: createProject }}>
            <Trans>没有创建作品。</Trans>
          </Alert>
        )}

        {projects.isPending ? (
          <div role="status" aria-busy="true" className="flex flex-col gap-3">
            <p className="text-sm text-neutral-600"><Trans>正在加载作品…</Trans></p>
            <div className="flex flex-col gap-px border border-divider bg-divider">
              {[0, 1, 2].map((index) => <Skeleton key={index} className="h-[var(--h-row-task)] bg-bg" />)}
            </div>
          </div>
        ) : projects.data === undefined ? null : rows.length === 0 ? searching ? (
          /* A miss is the search's, not the library's: the way out is clearing
             it, and the toolbar already holds the one primary 新建作品. */
          <Empty
            title={<Trans>没有匹配的作品</Trans>}
            description={<Trans>没有名字包含「{search}」的作品。</Trans>}
            actions={
              <Button variant="secondary" onClick={() => setQuery('')}>
                <Trans>清空搜索</Trans>
              </Button>
            }
          />
        ) : (
          <Empty title={<Trans>还没有作品</Trans>} description={<Trans>新建作品后，添加素材开始剪辑。</Trans>} actions={newProject} />
        ) : (
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">{rows.map((project) => <ProjectCard key={project.id} project={project} />)}</div>
        )}
      </div>
    </Page>
  );
}

function ProjectCard({ project }: { readonly project: Project }) {
  const gate = useProjectDeliveryGate(project.id);
  const clips = project.document.tracks.flatMap((track) => track.clips).filter((clip) => clip.placement.enabled && clip.text === null);
  const currentGate = gate.data?.revision === project.revision ? gate.data : null;
  const ready = currentGate === null ? null : clips.length - currentGate.blockers.length;
  /*
   * The whole card is the title link's hit area — `after:` stretches the one
   * real anchor over the card, so middle-click, the status bar and the focus
   * ring all stay the anchor's, and nothing is nested inside it. The 成片 link
   * is lifted above that layer so it still takes its own click.
   */
  return <article className="relative flex min-w-0 flex-col gap-4 rounded-lg border border-divider bg-bg p-5 transition-colors hover:bg-action-hover" data-project-card={project.id}>
    <div className="flex min-w-0 items-start gap-3">
      <RouteLink to={`/projects/${encodeURIComponent(project.id)}`} className="min-w-0 flex-1 truncate text-base font-medium after:absolute after:inset-0 after:rounded-lg">{project.name}</RouteLink>
      <Badge variant="neutral"><Trans>第 {project.revision} 版</Trans></Badge>
    </div>
    <div className="flex flex-wrap items-center justify-between gap-3 text-xs text-neutral-600">
      <span>
        {clips.length === 0 ? <Trans>还没有素材</Trans> : <Plural value={clips.length} other="# 段素材" />}
        {clips.length === 0 ? null : <> · {gate.error !== null ? <Trans>素材状态暂时不可用</Trans> : ready === null ? gate.isFetching ? <Trans>正在检查素材…</Trans> : <Trans>素材状态待更新</Trans> : currentGate?.ready ? <Trans>全部就绪</Trans> : <Trans>{ready} 段就绪</Trans>}</>}
      </span>
      <ProjectOutputLink projectId={project.id} inline className="relative z-10" />
    </div>
    <dl className="mt-auto grid grid-cols-2 gap-4 border-t border-divider pt-4">
      <div className="min-w-0">
        <dt className="text-xs text-neutral-600"><Trans>时长</Trans></dt>
        <dd className="mt-1 font-mono text-sm tabular-nums">{formatTimecode(project.document.duration_seconds)}</dd>
      </div>
      <div className="min-w-0">
        <dt className="text-xs text-neutral-600"><Trans>最近更新</Trans></dt>
        <dd className="mt-1 text-sm tabular-nums"><time dateTime={project.updated_at}>{formatTaskClock(project.updated_at, { now: new Date() })}</time></dd>
      </div>
    </dl>
  </article>;
}
