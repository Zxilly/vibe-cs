export type ActivityMutationLease = Readonly<{
  generation: number;
  contextId: string;
}>;

export type ActivityMutationGuard = {
  activate: () => void;
  setContext: (activityId: string | null) => void;
  begin: (activityId: string) => ActivityMutationLease;
  canApply: (lease: ActivityMutationLease) => boolean;
  isLatest: (lease: ActivityMutationLease) => boolean;
  dispose: () => void;
};

export function createActivityMutationGuard(): ActivityMutationGuard {
  let mounted = true;
  let generation = 0;
  let contextId: string | null = null;

  return {
    activate() {
      mounted = true;
    },
    setContext(activityId) {
      if (contextId !== activityId) generation += 1;
      contextId = activityId;
    },
    begin(activityId) {
      generation += 1;
      return { generation, contextId: activityId };
    },
    canApply(lease) {
      return mounted && lease.generation === generation && lease.contextId === contextId;
    },
    isLatest(lease) {
      return mounted && lease.generation === generation;
    },
    dispose() {
      mounted = false;
      generation += 1;
    },
  };
}
