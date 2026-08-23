import { useEffect, useMemo, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';

import { aggregateProjects, type ProjectAggregationWarning } from '../domain/project/projectViewModel';
import { useAgentPlanList } from './plans';
import { useEditorProjects } from './editor';
import { useMontageProjects } from './montage';
import { useOutputList } from './outputs';
import { useTaskFeed } from './tasks';
import { dataErrorMessage } from './errors';
import { useProjectCollections } from './projectCollections';
import { qk } from './keys';

/** Purely client-side project aggregation over existing query contracts. */
export function useProjects(options: { readonly taskPollWhileActiveMs?: number | undefined } = {}) {
  const queryClient = useQueryClient();
  const plans = useAgentPlanList({ limit: 100 });
  const montages = useMontageProjects();
  const editors = useEditorProjects();
  const tasks = useTaskFeed(
    { page: 1, page_size: 50 },
    options.taskPollWhileActiveMs === undefined
      ? {}
      : { pollWhileActiveMs: options.taskPollWhileActiveMs },
  );
  const outputs = useOutputList({ page: 1, page_size: 100 });
  const collections = useProjectCollections();
  const previousTaskStatus = useRef<ReadonlyMap<string, string>>(new Map());

  useEffect(() => {
    const items = tasks.data?.items;
    if (items === undefined) return;
    const next = new Map(items.map((item) => [item.id, item.status]));
    const finishedMediaTask = items.some((item) => {
      const previous = previousTaskStatus.current.get(item.id);
      return (item.kind === 'recording' || item.kind === 'export')
        && previous !== undefined
        && !['completed', 'failed', 'cancelled'].includes(previous)
        && ['completed', 'failed', 'cancelled'].includes(item.status);
    });
    previousTaskStatus.current = next;
    if (finishedMediaTask) {
      void Promise.all([
        queryClient.invalidateQueries({ queryKey: qk.outputs.all }),
        queryClient.invalidateQueries({ queryKey: qk.plans.all }),
        queryClient.invalidateQueries({ queryKey: qk.montage.all }),
      ]);
    }
  }, [queryClient, tasks.data?.items]);

  const data = useMemo(() => {
    const warnings: ProjectAggregationWarning[] = [];
    addWarning(warnings, 'plans', plans.error);
    addWarning(warnings, 'montages', montages.error);
    addWarning(warnings, 'editors', editors.error);
    addWarning(warnings, 'tasks', tasks.error);
    addWarning(warnings, 'outputs', outputs.error);
    const aggregated = aggregateProjects({
      plans: plans.data ?? [],
      montages: montages.data?.items ?? [],
      editors: editors.data ?? [],
      tasks: tasks.data?.items ?? [],
      outputs: outputs.data?.items ?? [],
      warnings,
    });
    return {
      ...aggregated,
      projects: aggregated.projects.map((project) => {
        const collected = collections.state[project.id] ?? [];
        if (collected.length === 0) return project;
        return {
          ...project,
          demoIds: [...new Set([...project.demoIds, ...collected.map((clip) => clip.demoId)])],
          updatedAt: [project.updatedAt, ...collected.map((clip) => clip.addedAt)].sort((a, b) => b.localeCompare(a))[0] ?? project.updatedAt,
        };
      }),
    };
  }, [collections.state, editors.data, editors.error, montages.data, montages.error, outputs.data, outputs.error, plans.data, plans.error, tasks.data, tasks.error]);

  return {
    data,
    // A completed output changes both the project status and the reachable
    // step. Rendering before this query settles can rewrite a valid
    // `?step=export` deep link to `select` and lose the user's destination.
    isPending: plans.isPending || montages.isPending || editors.isPending || outputs.isPending,
    tasksPending: tasks.isPending,
    tasksError: dataErrorMessage(tasks.error),
    refetchTasks: tasks.refetch,
    refetch: async () => Promise.all([plans.refetch(), montages.refetch(), editors.refetch(), tasks.refetch(), outputs.refetch()]),
  };
}

function addWarning(
  warnings: ProjectAggregationWarning[],
  source: ProjectAggregationWarning['source'],
  error: Error | null,
): void {
  if (error === null) return;
  warnings.push({ source, message: dataErrorMessage(error) ?? error.message });
}
