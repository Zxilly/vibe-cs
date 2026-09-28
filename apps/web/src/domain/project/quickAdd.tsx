/**
 * One-click collection into a project.
 *
 * Picking highlights is repetitive work: a confirmation dialog per clip turned
 * ten picks into twenty clicks. When the target is known — the project that
 * sent the user here (`?project=`), the one they chose earlier in this visit,
 * or else their most recently edited project — the clips go straight to the
 * end of its Story track and a toast offers 「撤销」, which reverts that exact
 * change group. The dialog remains the path for choosing another project or
 * creating the first one, and for a range that cannot be recorded.
 */

import { t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { dataErrorMessage } from '../../data/errors';
import { useApplyProjectPatch, useProjects, useRevertProjectChangeGroup } from '../../data/projects';
import { toast } from '../../design/feedback';
import { Button, NativeSelect } from '../../design/primitives';
import type { Project } from '../../shared/desktop/dto';
import type { AddedProjectTarget } from './AddToProjectDialog';
import { collectedClipsPatch, type ProjectCollectedClip } from './collectedClip';

export interface QuickAddToProject {
  /** The project a pick goes to, or null when the dialog has to ask. */
  readonly target: Project | null;
  /** True when the target came from the route rather than from recency. */
  readonly pinned: boolean;
  /** Clips added to the target during this visit. */
  readonly addedCount: number;
  readonly pending: boolean;
  /** Adds straight away; returns false when the caller must open the dialog. */
  readonly add: (clips: readonly ProjectCollectedClip[]) => boolean;
  /** Every project the target can switch to. */
  readonly projects: readonly Project[];
  /** Makes another project the target for later picks. */
  readonly choose: (projectId: string) => void;
  /** Makes a project chosen in the dialog the target for later picks. */
  readonly retarget: (project: AddedProjectTarget, added: number) => void;
}

export function useQuickAddToProject(preferredProjectId: string | null): QuickAddToProject {
  const projects = useProjects();
  const apply = useApplyProjectPatch();
  const [chosenId, setChosenId] = useState<string | null>(preferredProjectId);
  const [addedCount, setAddedCount] = useState(0);
  const rows = projects.data ?? [];
  const target = rows.find((project) => project.id === chosenId)
    ?? (chosenId === null ? mostRecent(rows) : null);
  const revert = useRevertProjectChangeGroup(target?.id ?? '');

  const add = (clips: readonly ProjectCollectedClip[]): boolean => {
    if (target === null || clips.length === 0) return false;
    if (clips.some((clip) => clip.startTick !== null && clip.endTick !== null && clip.endTick <= clip.startTick)) return false;
    if (apply.isPending) return true;
    const name = target.name;
    apply.mutate(collectedClipsPatch(target, clips), {
      onSuccess: ({ project, change_group: group }) => {
        setChosenId(project.id);
        setAddedCount((count) => count + clips.length);
        toast.success(
          clips.length === 1 ? t`已加入「${name}」` : t`已把 ${clips.length} 个片段加入「${name}」`,
          {
            description: t`放在 Story 末尾，录制后才能导出。`,
            action: {
              label: <Trans>撤销</Trans>,
              onAction: () => revert.mutate(
                { changeGroupId: group.id, expectedRevision: project.revision },
                {
                  onSuccess: () => setAddedCount((count) => Math.max(0, count - clips.length)),
                  onError: (error) => toast.error(t`没能撤销加入`, {
                    description: dataErrorMessage(error) ?? t`作品可能已被修改，请在作品的修订历史里撤销。`,
                  }),
                },
              ),
            },
          },
        );
      },
      onError: (error) => toast.error(t`没有加入「${name}」`, {
        description: dataErrorMessage(error) ?? t`作品没有被修改，请重试。`,
      }),
    });
    return true;
  };

  return {
    target,
    pinned: preferredProjectId !== null && target?.id === preferredProjectId,
    addedCount,
    pending: apply.isPending,
    add,
    projects: rows,
    choose: (projectId) => {
      if (projectId === target?.id) return;
      setChosenId(projectId);
      setAddedCount(0);
    },
    retarget: (project, added) => {
      setChosenId(project.id);
      setAddedCount((count) => (project.id === target?.id ? count + added : added));
    },
  };
}

function mostRecent(rows: readonly Project[]): Project | null {
  return rows.reduce<Project | null>(
    (latest, project) => (latest === null || project.updated_at > latest.updated_at ? project : latest),
    null,
  );
}

/**
 * The strip above a collecting page: where picks go, how many landed, and the
 * way back. It is what keeps 「选材」 inside the editing job instead of a detour
 * the user has to find their own way back from.
 */
export function CollectTargetBar({ quickAdd }: { readonly quickAdd: QuickAddToProject }) {
  const navigate = useNavigate();
  const { target, pinned, addedCount, projects } = quickAdd;
  if (target === null) return null;
  const name = target.name;
  return (
    <div
      data-collect-target={target.id}
      className="flex min-h-[var(--h-bar)] flex-none items-center gap-3 border-b border-divider bg-accent-100 px-4 text-sm"
    >
      <span className="flex-none text-accent-700">
        {pinned ? <Trans>正在为作品选材</Trans> : <Trans>加入作品会放进</Trans>}
      </span>
      <NativeSelect
        aria-label={t`选材目标作品`}
        className="w-auto max-w-80"
        value={target.id}
        onChange={(event) => quickAdd.choose(event.currentTarget.value)}
      >
        {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
      </NativeSelect>
      {addedCount === 0 ? null : <span className="flex-none text-neutral-700"><Trans>本次已加入 {addedCount} 个</Trans></span>}
      <Button
        className="ml-auto"
        size="sm"
        variant="secondary"
        onClick={() => void navigate(`/projects/${encodeURIComponent(target.id)}`)}
      >
        {pinned ? <Trans>返回「{name}」</Trans> : <Trans>打开作品</Trans>}
      </Button>
    </div>
  );
}
