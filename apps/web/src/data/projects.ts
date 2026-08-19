import { useMemo } from 'react';

import { aggregateProjects, type ProjectAggregationWarning } from '../domain/project/projectViewModel';
import { useAgentPlanList } from './plans';
import { useEditorProjects } from './editor';
import { useMontageProjects } from './montage';
import { useOutputList } from './outputs';
import { useTaskFeed } from './tasks';
import { dataErrorMessage } from './errors';

/** Purely client-side project aggregation over existing query contracts. */
export function useProjects() {
  const plans = useAgentPlanList({ limit: 100 });
  const montages = useMontageProjects();
  const editors = useEditorProjects();
  const tasks = useTaskFeed({ page: 1, page_size: 50 });
  const outputs = useOutputList({ page: 1, page_size: 100 });

  const data = useMemo(() => {
    const warnings: ProjectAggregationWarning[] = [];
    addWarning(warnings, 'plans', plans.error);
    addWarning(warnings, 'montages', montages.error);
    addWarning(warnings, 'editors', editors.error);
    addWarning(warnings, 'tasks', tasks.error);
    addWarning(warnings, 'outputs', outputs.error);
    return aggregateProjects({
      plans: plans.data ?? [],
      montages: montages.data?.items ?? [],
      editors: editors.data ?? [],
      tasks: tasks.data?.items ?? [],
      outputs: outputs.data?.items ?? [],
      warnings,
    });
  }, [editors.data, editors.error, montages.data, montages.error, outputs.data, outputs.error, plans.data, plans.error, tasks.data, tasks.error]);

  return {
    data,
    isPending: plans.isPending || montages.isPending || editors.isPending,
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
