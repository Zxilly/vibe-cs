/*
 * pages/onboarding — which of the three steps this machine has already taken.
 *
 * Read from the data, never from a stored flag, for the same reason
 * `FirstRunStrip` decides "first use" from an empty library: a flag stays set
 * after the user clears their data, and is missing on their second machine.
 *
 *   import   the library has at least one Demo
 *   analyse  at least one of them has finished analysis (`ready`)
 *   create   at least one 作品 exists
 *
 * Three one-row reads rather than one page of fifty: each question is a
 * boolean, and the list page's own query would be a page of data to answer it.
 * A read that fails counts as "not done" — the guide then points at the step
 * again, which is the harmless direction to be wrong in.
 */

import { useDemoList } from '../../../data/demos';
import { useProjects } from '../../../data/projects';
import { FIRST_RUN_STEPS, type FirstRunStep } from './firstRunSteps';

export interface FirstRunProgress {
  readonly done: ReadonlySet<FirstRunStep['id']>;
  /** The first step not yet taken; null once all three are. */
  readonly current: FirstRunStep['id'] | null;
}

/** `null` while any of the three reads is still in flight. */
export function useFirstRunProgress(): FirstRunProgress | null {
  const demos = useDemoList({ page: 1, page_size: 1 });
  const analysed = useDemoList({ status: 'ready', page: 1, page_size: 1 });
  const projects = useProjects();

  if (demos.isPending || analysed.isPending || projects.isPending) return null;

  const done = new Set<FirstRunStep['id']>();
  if ((demos.data?.items.length ?? 0) > 0) done.add('import');
  if ((analysed.data?.items.length ?? 0) > 0) done.add('analyse');
  if ((projects.data?.length ?? 0) > 0) done.add('create');

  return {
    done,
    current: FIRST_RUN_STEPS.find((step) => !done.has(step.id))?.id ?? null,
  };
}
