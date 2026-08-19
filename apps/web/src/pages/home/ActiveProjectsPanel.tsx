/*
 * pages/home — 进行中的工程.
 *
 *   Aurora 赛点集锦      多轨编辑 · 6 段素材 · 上次保存 2 小时前
 *   Kael 个人集锦 v2     快速合辑 · 4 段素材 · 上次保存 昨天
 *
 * Two kinds of project in one list, which is the point: the user thinks of
 * them as "the thing I was working on", and which editor opens it is a
 * property of the row rather than a reason to split the block in two. The
 * board draws them interleaved and sorted by when they were last saved, and so
 * does this.
 *
 * ── The two reads are deliberately not merged in `data/` ─────────────────
 *
 * `useEditorProjects` and `useMontageProjects` stay separate hooks over
 * separate routes; the join happens here, in the one place that wants both.
 * A `useAllProjects` in `data/` would be a third cache entry that has to be
 * invalidated by both domains' writes, and the first write that forgot it
 * would leave this block stale with nothing pointing at why.
 */

import { Plural, Trans } from '@lingui/react/macro';
import { useMemo } from 'react';

import { Skeleton } from '../../design/data';
import { Alert } from '../../design/feedback';
import { useEditorProjects } from '../../data/editor';
import { dataErrorMessage } from '../../data/errors';
import { useMontageProjects } from '../../data/montage';
import { formatTaskClock } from '../../domain/task';
import { RouteLink } from '../RouteLink';

const SHOWN = 3;

interface ProjectRow {
  readonly id: string;
  readonly name: string;
  readonly kind: 'editor' | 'montage';
  readonly clipCount: number;
  readonly updatedAt: string;
  readonly href: string;
}

function projectStep(row: ProjectRow) {
  return row.clipCount === 0 ? <Trans>选材中</Trans> : <Trans>剪辑中</Trans>;
}

export function ActiveProjectsPanel() {
  const editors = useEditorProjects();
  const montages = useMontageProjects();

  const rows = useMemo<ProjectRow[]>(() => {
    const editorRows: ProjectRow[] = (editors.data ?? []).map((project) => ({
      id: project.id,
      name: project.name,
      kind: 'editor',
      clipCount: project.tracks.reduce((total, track) => total + track.clips.length, 0),
      updatedAt: project.updated_at,
      href: `/editor/${encodeURIComponent(project.id)}`,
    }));
    const montageRows: ProjectRow[] = (montages.data?.items ?? []).map((project) => ({
      id: project.id,
      name: project.name,
      kind: 'montage',
      clipCount: project.clips.length,
      updatedAt: project.updated_at,
      href: `/projects/${encodeURIComponent(`montage:${project.id}`)}?step=shotlist`,
    }));
    return [...editorRows, ...montageRows].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }, [editors.data, montages.data]);

  /* One read failing is reported and the other still renders: a montage list
     that would not load is no reason to hide the editor projects. */
  const error = dataErrorMessage(editors.error) ?? dataErrorMessage(montages.error);
  const loading = editors.isPending || montages.isPending;

  return (
    <div className="flex flex-col gap-3" data-home-block="projects">

      {error === null ? null : (
        <Alert
          variant="warning"
          action={{
            label: <Trans>重试</Trans>,
            onAction: () => {
              void editors.refetch();
              void montages.refetch();
            },
          }}
        >
          <Trans>有一份作品列表没能读出来：{error}</Trans>
        </Alert>
      )}

      {loading ? (
        <div className="flex flex-col gap-2.5">
          <Skeleton />
          <Skeleton width="76%" />
        </div>
      ) : rows.length === 0 ? (
        <p className="text-xs leading-normal text-neutral-600">
          <Trans>还没有作品。快速剪辑串一条视频，多轨编辑器做需要叠加与字幕的片子。</Trans>
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {rows.slice(0, SHOWN).map((row) => (
            <li key={`${row.kind}:${row.id}`} className="flex items-center justify-between gap-3 border border-divider p-3 text-sm">
              <div className="flex min-w-0 flex-col gap-0.5">
                <RouteLink to={row.href} className="truncate">
                  {row.name}
                </RouteLink>
                <span className="text-xs text-neutral-600">
                  {projectStep(row)}
                  {' · '}
                  {row.kind === 'editor' ? <Trans>多轨编辑</Trans> : <Trans>快速剪辑</Trans>}
                  {' · '}
                  <Plural value={row.clipCount} other="# 段素材" />
                  {' · '}
                  <Trans>上次保存 {formatTaskClock(row.updatedAt, { now: new Date() })}</Trans>
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
