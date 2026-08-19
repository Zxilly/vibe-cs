import { Plural, Trans } from '@lingui/react/macro';

import { useProjects } from '../data/projects';
import { Empty, Skeleton } from '../design/data';
import { Alert } from '../design/feedback';
import { Page, Toolbar } from '../design/layout';
import { Button } from '../design/primitives';
import type { ProjectStatus, ProjectStep, ProjectViewModel } from '../domain/project/projectViewModel';
import { formatTaskClock } from '../domain/task';
import { RouteLink } from './RouteLink';

export function ProjectsPage() {
  const projects = useProjects();
  const rows = projects.data.projects;

  const newProject = (
    <Button asChild variant="primary" size="md">
      <RouteLink to="/agent"><Trans>新建作品</Trans></RouteLink>
    </Button>
  );

  return (
    <Page
      toolbar={
        <Toolbar
          title={<Trans>作品</Trans>}
          meta={projects.isPending ? undefined : <Plural value={rows.length} other="# 个作品" />}
          primary={projects.isPending || rows.length > 0 ? newProject : undefined}
        />
      }
    >
      <div className="flex flex-col gap-5 p-7" data-projects-list>
        {projects.data.warnings.length === 0 ? null : (
          <Alert variant="warning" action={{ label: <Trans>重新加载</Trans>, onAction: () => void projects.refetch() }}>
            <Trans>部分来源暂时读不到，下面仍显示已经取到的作品。</Trans>
          </Alert>
        )}

        {projects.isPending ? (
          <div role="status" aria-busy="true" className="grid gap-5 lg:grid-cols-2">
            {[0, 1, 2].map((index) => <Skeleton key={index} className="h-36" />)}
          </div>
        ) : rows.length === 0 ? (
          <Empty
            title={<Trans>还没有作品</Trans>}
            description={<Trans>新建作品后，选材、剪辑单、录制和成品文件会集中在同一个工作区。</Trans>}
            actions={newProject}
          />
        ) : (
          <ul className="m-0 grid list-none gap-5 p-0 lg:grid-cols-2">
            {rows.map((project) => <ProjectCard key={project.id} project={project} />)}
          </ul>
        )}
      </div>
    </Page>
  );
}

function ProjectCard({ project }: { readonly project: ProjectViewModel }) {
  return (
    <li>
      <article className="flex h-full flex-col gap-3 border border-divider p-4" data-project={project.id}>
        <div className="flex items-start justify-between gap-3">
          <h2 className="min-w-0 truncate text-lg">
            <RouteLink to={`/projects/${encodeURIComponent(project.id)}`}>{project.name}</RouteLink>
          </h2>
          <span className="flex-none text-xs text-neutral-600"><ProjectStatusLabel status={project.status} /></span>
        </div>
        <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
          <dt className="text-neutral-600"><Trans>当前步骤</Trans></dt>
          <dd className="m-0"><ProjectStepLabel step={project.currentStep} /></dd>
          <dt className="text-neutral-600"><Trans>关联比赛</Trans></dt>
          <dd className="m-0">
            {project.demoIds.length === 0
              ? <Trans>尚未关联比赛</Trans>
              : <Plural value={project.demoIds.length} other="已关联 # 场比赛" />}
          </dd>
          <dt className="text-neutral-600"><Trans>最近活动</Trans></dt>
          <dd className="m-0 font-mono text-xs">{formatTaskClock(project.updatedAt, { now: new Date() })}</dd>
        </dl>
      </article>
    </li>
  );
}

function ProjectStepLabel({ step }: { readonly step: ProjectStep }) {
  switch (step) {
    case 'select': return <Trans>选材</Trans>;
    case 'shotlist': return <Trans>剪辑单</Trans>;
    case 'record': return <Trans>录制</Trans>;
    case 'export': return <Trans>导出</Trans>;
  }
}

function ProjectStatusLabel({ status }: { readonly status: ProjectStatus }) {
  switch (status) {
    case 'active': return <Trans>进行中</Trans>;
    case 'needs-attention': return <Trans>需要处理</Trans>;
    case 'complete': return <Trans>已有成品</Trans>;
  }
}
