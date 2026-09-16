/*
 * Domain layer, 2 of 3 — project/createDemoProject.
 *
 * 「用这场比赛新建作品」, the one way a Demo becomes a project.
 *
 * Two entrances offer it — a row of 资料库 and the primary action of the match
 * workspace — and both mean the same thing: a project named after the match,
 * listing the Demo as its source, with the whole match already on the Story
 * track so the editor opens on something rather than on 「项目还没有素材」. A
 * project created with an empty `source_demo_ids` from inside a match is a
 * workflow that forgot where it started, which is what the workspace's button
 * used to do.
 *
 * Two IPC calls, not one: the service creates an empty project and takes the
 * first clips as an ordinary patch, the same patch `AddToProjectDialog` sends.
 */

import { t } from '@lingui/core/macro';

import { useApplyProjectPatch, useCreateProject } from '../../data/projects';
import type { Project } from '../../shared/desktop/dto';
import type { DemoSummary } from '../../shared/desktop/viewModels';
import { collectedClipsPatch, type ProjectCollectedClip } from './collectedClip';

export interface CreateDemoProject {
  /** Creates the project and resolves once the whole-match clips are on it. */
  readonly create: (demos: readonly DemoSummary[]) => Promise<Project>;
  /** Either step is in flight. */
  readonly pending: boolean;
  /** The rejection of whichever step failed, for a Notice. */
  readonly error: unknown;
}

export function useCreateDemoProject(): CreateDemoProject {
  const create = useCreateProject();
  const apply = useApplyProjectPatch();

  return {
    create: async (demos) => {
      const project = await create.mutateAsync({
        name: demoProjectName(demos),
        width: 1920,
        height: 1080,
        fps: 60,
        source_demo_ids: demos.map((demo) => demo.id),
      });
      const result = await apply.mutateAsync(collectedClipsPatch(project, demos.map(wholeMatchClip)));
      return result.project;
    },
    pending: create.isPending || apply.isPending,
    error: create.error ?? apply.error,
  };
}

/** 「NAVI vs FaZe · Mirage」, or 「… +2」 for a series. */
export function demoProjectName(demos: readonly DemoSummary[]): string {
  const first = demos[0];
  if (first === undefined) return t`新作品`;
  return demos.length === 1 ? first.display_name : `${first.display_name} +${String(demos.length - 1)}`;
}

/** The whole match as one collected clip; ticks unknown until the editor reads the Demo. */
export function wholeMatchClip(demo: DemoSummary): ProjectCollectedClip {
  return {
    id: `${demo.id}:selection:match`,
    demoId: demo.id,
    matchLabel: demo.display_name,
    kind: 'selection',
    label: t`整场比赛`,
    round: null,
    playerId: null,
    playerName: null,
    tickRate: null,
    highlightId: null,
    evidenceId: null,
    startTick: null,
    endTick: null,
    durationSeconds: demo.duration_seconds > 0 ? demo.duration_seconds : null,
    addedAt: new Date().toISOString(),
  };
}
