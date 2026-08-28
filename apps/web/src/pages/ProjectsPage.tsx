import { Plural, Trans } from '@lingui/react/macro';
import { useNavigate } from 'react-router-dom';

import { useCreateProject, useProjects } from '../data/projects';
import { Empty, Skeleton } from '../design/data';
import { Alert } from '../design/feedback';
import { Page, Toolbar } from '../design/layout';
import { Button } from '../design/primitives';
import type { Project } from '../shared/desktop/dto';
import { formatTaskClock } from '../domain/task';
import { RouteLink } from './RouteLink';

export function ProjectsPage() {
  const navigate = useNavigate();
  const projects = useProjects();
  const create = useCreateProject();
  const rows = projects.data ?? [];

  const createProject = () => {
    create.mutate(
      { name: '新作品', width: 1920, height: 1080, fps: 60 },
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
          title={<Trans>作品</Trans>}
          meta={projects.isPending ? undefined : <Plural value={rows.length} other="# 个作品" />}
          primary={newProject}
        />
      }
    >
      <div className="flex flex-col gap-5 p-7" data-projects-list>
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
            title={<Trans>还没有作品</Trans>}
            description={<Trans>新建后，人类与 Agent 会在同一条多轨时间线上编辑。</Trans>}
            actions={newProject}
          />
        ) : (
          <ProjectTable rows={rows} />
        )}
      </div>
    </Page>
  );
}

function ProjectTable({ rows }: { readonly rows: readonly Project[] }) {
  return (
    <div className="min-w-0 overflow-x-auto border border-divider">
      <table className="w-full min-w-[var(--w-overlay)] border-collapse text-left">
        <thead className="bg-surface-chrome">
          <tr className="h-[var(--h-thead)] border-b border-divider text-2xs tracking-wide text-neutral-600">
            <th scope="col" className="px-4 font-normal"><Trans>作品</Trans></th>
            <th scope="col" className="px-4 font-normal"><Trans>轨道</Trans></th>
            <th scope="col" className="px-4 font-normal"><Trans>片段</Trans></th>
            <th scope="col" className="px-4 font-normal"><Trans>修订</Trans></th>
            <th scope="col" className="px-4 font-normal"><Trans>最近修改</Trans></th>
          </tr>
        </thead>
        <tbody>
          {rows.map((project) => (
            <tr key={project.id} className="h-[var(--h-row-task)] border-b border-divider last:border-b-0 hover:bg-surface">
              <td className="max-w-[var(--w-split)] px-4">
                <RouteLink to={`/projects/${encodeURIComponent(project.id)}`} className="block truncate text-base">
                  {project.name}
                </RouteLink>
              </td>
              <td className="px-4 text-sm">{project.document.tracks.length}</td>
              <td className="px-4 text-sm">
                {project.document.tracks.reduce((count, track) => count + track.clips.length, 0)}
              </td>
              <td className="px-4 font-mono text-xs">r{project.revision}</td>
              <td className="px-4 font-mono text-xs">
                {formatTaskClock(project.updated_at, { now: new Date() })}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
