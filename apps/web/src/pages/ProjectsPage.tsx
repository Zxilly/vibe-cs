import { Plural, Trans } from '@lingui/react/macro';

import { useProjects } from '../data/projects';
import { Empty, Skeleton } from '../design/data';
import { Alert, StatusDot } from '../design/feedback';
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
      <RouteLink to="/projects/new?step=shotlist"><Trans>新建作品</Trans></RouteLink>
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
          <div role="status" aria-busy="true" className="flex flex-col gap-px border border-divider bg-divider">
            {[0, 1, 2].map((index) => <Skeleton key={index} className="h-[var(--h-row-task)] bg-bg" />)}
          </div>
        ) : rows.length === 0 ? (
          <Empty
            title={<Trans>还没有作品</Trans>}
            description={<Trans>新建作品后，选材、剪辑单、录制和成品文件会集中在同一个工作区。</Trans>}
            actions={newProject}
          />
        ) : (
          <ProjectTable rows={rows} />
        )}
      </div>
    </Page>
  );
}

function ProjectTable({ rows }: { readonly rows: readonly ProjectViewModel[] }) {
  return (
    <div className="min-w-0 overflow-x-auto border border-divider">
      <table className="w-full min-w-[var(--w-overlay)] border-collapse text-left">
        <thead className="bg-surface-chrome">
          <tr className="h-[var(--h-thead)] border-b border-divider text-2xs tracking-wide text-neutral-600">
            <th scope="col" className="px-4 font-normal"><Trans>作品</Trans></th>
            <th scope="col" className="px-4 font-normal"><Trans>当前步骤</Trans></th>
            <th scope="col" className="px-4 font-normal"><Trans>关联比赛</Trans></th>
            <th scope="col" className="px-4 font-normal"><Trans>最近活动</Trans></th>
            <th scope="col" className="px-4 font-normal"><Trans>状态</Trans></th>
          </tr>
        </thead>
        <tbody>
          {rows.map((project) => (
            <tr
              key={project.id}
              data-project={project.id}
              className="h-[var(--h-row-task)] border-b border-divider last:border-b-0 hover:bg-surface"
            >
              <td className="max-w-[var(--w-split)] px-4">
                <RouteLink
                  to={`/projects/${encodeURIComponent(project.id)}`}
                  className="block truncate text-base"
                >
                  {project.name}
                </RouteLink>
              </td>
              <td className="whitespace-nowrap px-4 text-sm">
                <ProjectStepLabel step={project.currentStep} />
              </td>
              <td className="whitespace-nowrap px-4 text-sm">
                {project.demoIds.length === 0
                  ? <Trans>尚未关联比赛</Trans>
                  : <Plural value={project.demoIds.length} other="已关联 # 场比赛" />}
              </td>
              <td className="whitespace-nowrap px-4 font-mono text-xs">
                {formatTaskClock(project.updatedAt, { now: new Date() })}
              </td>
              <td className="whitespace-nowrap px-4 text-xs">
                <span className="inline-flex items-center gap-2">
                  <StatusDot
                    size="sm"
                    status={
                      project.status === 'complete'
                        ? 'ok'
                        : project.status === 'needs-attention'
                          ? 'warn'
                          : 'running'
                    }
                  />
                  <ProjectStatusLabel status={project.status} />
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
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
