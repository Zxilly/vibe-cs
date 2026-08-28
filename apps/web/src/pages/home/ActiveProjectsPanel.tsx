import { Plural, Trans } from '@lingui/react/macro';
import { FileVideo2 } from 'lucide-react';

import { Skeleton } from '../../design/data';
import { Alert } from '../../design/feedback';
import { dataErrorMessage } from '../../data/errors';
import { useProjects } from '../../data/projects';
import { formatTaskClock } from '../../domain/task';
import { RouteLink } from '../RouteLink';

const SHOWN = 3;

export function ActiveProjectsPanel() {
  const projects = useProjects();
  const error = dataErrorMessage(projects.error);
  const rows = [...(projects.data ?? [])]
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
    .slice(0, SHOWN);

  return (
    <div className="flex flex-col gap-3" data-home-block="projects">
      {error === null ? null : (
        <Alert variant="warning" action={{ label: <Trans>重试</Trans>, onAction: () => void projects.refetch() }}>
          <Trans>作品列表没能读出来：{error}</Trans>
        </Alert>
      )}

      {projects.isPending ? (
        <div className="flex flex-col gap-2.5"><Skeleton /><Skeleton width="76%" /></div>
      ) : rows.length === 0 ? (
        <p className="text-xs leading-normal text-neutral-600"><Trans>还没有作品。</Trans></p>
      ) : (
        <ul className="flex flex-col border border-divider">
          {rows.map((project) => {
            const clipCount = project.document.tracks.reduce(
              (total, track) => total + track.clips.length,
              0,
            );
            return (
              <li key={project.id} className="flex min-h-row-task items-center gap-3 border-b border-divider px-3 py-2 text-sm last:border-b-0">
                <FileVideo2 className="size-5 flex-none text-accent-700" strokeWidth={1.5} aria-hidden="true" />
                <div className="flex min-w-0 flex-col gap-0.5">
                  <RouteLink to={`/projects/${encodeURIComponent(project.id)}`} className="truncate">{project.name}</RouteLink>
                  <span className="text-xs text-neutral-600">
                    {clipCount === 0 ? <Trans>选材中</Trans> : <Trans>剪辑中</Trans>}{' · '}
                    <Plural value={clipCount} other="# 段素材" />{' · '}
                    <Trans>上次保存 {formatTaskClock(project.updated_at, { now: new Date() })}</Trans>
                  </span>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
