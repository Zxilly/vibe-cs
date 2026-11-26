import { Plural, Trans } from '@lingui/react/macro';
import { ArrowUpRight, FileVideo2 } from 'lucide-react';

import { Skeleton } from '../../../design/data';
import { Alert } from '../../../design/feedback';
import { formatTimecode } from '../../../design/timeline';
import { useProjects } from '../../../data/projects';
import { formatTaskClock } from '../../../domain/task';
import { RouteLink } from '../../shared/navigation/RouteLink';

const SHOWN = 3;

export function ActiveProjectsPanel() {
  const projects = useProjects();
  const rows = [...(projects.data ?? [])]
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
    .slice(0, SHOWN);

  return (
    <div className="flex flex-col gap-3" data-home-block="projects">
      {!projects.isError ? null : (
        <Alert variant="warning" action={{ label: <Trans>重新加载</Trans>, disabled: projects.isFetching, onAction: () => void projects.refetch() }}>
          <Trans>无法加载作品列表。</Trans>
        </Alert>
      )}

      {projects.isPending ? (
        <div role="status" aria-busy="true" className="flex flex-col gap-2.5">
          <p className="text-sm text-neutral-600"><Trans>正在加载作品…</Trans></p>
          <Skeleton /><Skeleton width="76%" />
        </div>
      ) : projects.isError && projects.data === undefined ? null : rows.length === 0 ? (
        <p className="rounded-lg border border-divider bg-surface-chrome/60 px-4 py-3 text-sm text-neutral-600"><Trans>还没有作品，点击「新建作品」开始剪辑。</Trans></p>
      ) : (
        <ul className="flex flex-col divide-y divide-divider overflow-hidden rounded-lg border border-divider bg-bg">
          {rows.map((project) => {
            const clipCount = project.document.tracks.reduce(
              (total, track) => total + track.clips.length,
              0,
            );
            /* The row is the link's hit area: `after:` stretches the one real
               anchor over the `li`, so the accessible name stays the title. */
            return (
              <li key={project.id} className="group relative flex min-h-row-task items-center gap-3.5 px-4 py-3 text-sm transition-colors hover:bg-neutral-100 focus-within:bg-accent-100">
                <span className="grid size-9 flex-none place-items-center rounded-md border border-divider bg-surface-chrome text-neutral-600 transition-colors group-hover:border-accent-300 group-hover:bg-accent-100 group-hover:text-accent-700" aria-hidden="true">
                  <FileVideo2 className="size-4" strokeWidth={1.6} aria-hidden="true" />
                </span>
                <div className="flex min-w-0 flex-1 flex-col gap-1">
                  <RouteLink to={`/projects/${encodeURIComponent(project.id)}`} title={project.name} className="truncate text-base font-medium text-text no-underline after:absolute after:inset-0">{project.name}</RouteLink>
                  <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs tabular-nums text-neutral-600">
                    <span>{clipCount === 0 ? <Trans>选材中</Trans> : <Trans>剪辑中</Trans>}</span>
                    <span aria-hidden="true">·</span>
                    <span><Plural value={clipCount} other="# 段素材" /></span>
                    {project.document.duration_seconds > 0 ? (
                      <>
                        <span aria-hidden="true">·</span>
                        <span className="font-mono">{formatTimecode(project.document.duration_seconds)}</span>
                      </>
                    ) : null}
                    <span aria-hidden="true">·</span>
                    <time dateTime={project.updated_at}>{formatTaskClock(project.updated_at, { now: new Date() })}</time>
                  </span>
                </div>
                <span
                  aria-hidden="true"
                  className="inline-flex flex-none items-center gap-1 rounded-md border border-divider bg-bg px-2.5 py-1 text-xs font-medium text-neutral-700 transition-colors group-hover:border-accent-300 group-hover:bg-accent-100 group-hover:text-accent-700"
                >
                  <Trans>继续剪辑</Trans>
                  <ArrowUpRight className="size-3.5" aria-hidden="true" />
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
