import { t } from '@lingui/core/macro';
import { useMemo, useState } from 'react';
import { Plural, Trans } from '@lingui/react/macro';
import { useNavigate } from 'react-router-dom';

import { useCreateProject, useProjects, useProjectDeliveryGate } from '../../../data/projects';
import { Empty, Skeleton } from '../../../design/data';
import { Alert } from '../../../design/feedback';
import { Page, Toolbar } from '../../../design/layout';
import { Button, Input } from '../../../design/primitives';
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
      { name: '新作品', width: 1920, height: 1080, fps: 60, source_demo_ids: [] },
      { onSuccess: (project) => void navigate(`/projects/${encodeURIComponent(project.id)}`) },
    );
  };
  const newProject = (
    <Button variant="primary" size="md" disabled={create.isPending} onClick={createProject}>
      <Trans>新建作品</Trans>
    </Button>
  );

  return (
    <Page
      toolbar={
        <Toolbar
          title={<Trans>作品库</Trans>}
          meta={projects.isPending ? undefined : <Plural value={rows.length} other="# 个作品" />}
          primary={newProject}
        >
          <Input size="sm" type="search" aria-label={t`搜索作品`} placeholder={t`搜索作品…`} value={query} onChange={(event) => setQuery(event.currentTarget.value)} />
        </Toolbar>
      }
    >
      <div className="flex flex-col gap-5 p-6" data-projects-list>
        {projects.error === null ? null : (
          <Alert variant="danger" action={{ label: <Trans>重新加载</Trans>, onAction: () => void projects.refetch() }}>
            <Trans>作品列表暂时读不到。</Trans>
          </Alert>
        )}
        {create.error === null ? null : (
          <Alert variant="danger" action={{ label: <Trans>重试</Trans>, onAction: createProject }}>
            <Trans>没有创建作品。</Trans>
          </Alert>
        )}

        {projects.isPending ? (
          <div role="status" aria-busy="true" className="flex flex-col gap-px border border-divider bg-divider">
            {[0, 1, 2].map((index) => <Skeleton key={index} className="h-[var(--h-row-task)] bg-bg" />)}
          </div>
        ) : rows.length === 0 ? (
          <Empty
            title={query.trim() === '' ? <Trans>还没有作品</Trans> : <Trans>没有匹配的作品</Trans>}
            actions={newProject}
          />
        ) : (
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">{rows.map((project) => <ProjectCard key={project.id} project={project} />)}</div>
        )}
      </div>
    </Page>
  );
}

function ProjectCard({ project }: { readonly project: Project }) {
  const gate = useProjectDeliveryGate(project.id);
  const clips = project.document.tracks.flatMap((track) => track.clips).filter((clip) => clip.placement.enabled);
  const ready = gate.data === undefined ? null : Math.max(0, clips.length - gate.data.blockers.length);
  return <article className="flex min-w-0 flex-col gap-4 rounded-lg border border-divider bg-bg p-5" data-project-card={project.id}>
    <div className="flex min-w-0 items-start gap-3">
      <RouteLink to={`/projects/${encodeURIComponent(project.id)}`} className="min-w-0 flex-1 truncate text-base font-medium">{project.name}</RouteLink>
      <span className="rounded-full bg-accent-100 px-2 py-0.5 font-mono text-xs text-accent-700">r{project.revision}</span>
    </div>
    <div className="flex flex-wrap items-center justify-between gap-3 text-xs text-neutral-600">
      <span><Trans>素材</Trans> · <span className="font-mono">{ready === null ? '—' : `${ready}/${clips.length}`}</span></span>
      <ProjectOutputLink projectId={project.id} inline />
    </div>
    <p className="text-xs text-neutral-600"><Trans>更新于 {formatTaskClock(project.updated_at, { now: new Date() })}</Trans></p>
  </article>;
}
