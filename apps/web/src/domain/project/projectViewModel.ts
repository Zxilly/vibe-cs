import type {
  AgentPlanSummary,
  EditorProject,
  MontageProjectRecord,
  OutputItem,
} from '../../shared/desktop/dto';
import type { ActivityItem } from '../../shared/desktop/viewModels';

export type ProjectSourceKind = 'plan' | 'montage' | 'editor';
export type ProjectEditingMode = 'agent' | 'quick' | 'multitrack';
export type ProjectStep = 'select' | 'shotlist' | 'record' | 'export';
export type ProjectStatus = 'active' | 'needs-attention' | 'complete';

export interface ProjectViewModel {
  readonly id: string;
  readonly source: { readonly kind: ProjectSourceKind; readonly id: string };
  readonly name: string;
  readonly editingMode: ProjectEditingMode;
  readonly shotList: {
    readonly planId: string;
    readonly status: AgentPlanSummary['status'];
    readonly shotCount: number;
  } | null;
  readonly clipCount: number;
  readonly recordingTasks: readonly ActivityItem[];
  readonly outputFiles: readonly OutputItem[];
  readonly demoIds: readonly string[];
  readonly currentStep: ProjectStep;
  readonly status: ProjectStatus;
  readonly updatedAt: string;
}

export type ProjectAggregationSource = 'plans' | 'montages' | 'editors' | 'tasks' | 'outputs';

export interface ProjectAggregationWarning {
  readonly source: ProjectAggregationSource;
  readonly message: string;
}

export interface ProjectAggregationInput {
  readonly plans?: readonly AgentPlanSummary[] | undefined;
  readonly montages?: readonly MontageProjectRecord[] | undefined;
  readonly editors?: readonly EditorProject[] | undefined;
  readonly tasks?: readonly ActivityItem[] | undefined;
  readonly outputs?: readonly OutputItem[] | undefined;
  readonly warnings?: readonly ProjectAggregationWarning[] | undefined;
}

export interface ProjectAggregationResult {
  readonly projects: readonly ProjectViewModel[];
  readonly orphanTasks: readonly ActivityItem[];
  readonly orphanOutputs: readonly OutputItem[];
  readonly warnings: readonly ProjectAggregationWarning[];
}

interface Anchor {
  readonly kind: ProjectSourceKind;
  readonly id: string;
  readonly name: string;
  readonly mode: ProjectEditingMode;
  readonly clipCount: number;
  readonly updatedAt: string;
  readonly plan: AgentPlanSummary | null;
}

const TERMINAL = new Set<ActivityItem['status']>(['completed', 'failed', 'cancelled']);

export function aggregateProjects(input: ProjectAggregationInput): ProjectAggregationResult {
  const anchors: Anchor[] = [
    ...(input.plans ?? []).map((plan): Anchor => ({
      kind: 'plan', id: plan.id, name: plan.title, mode: 'agent', clipCount: plan.shot_count,
      updatedAt: plan.updated_at, plan,
    })),
    ...(input.montages ?? []).map((project): Anchor => ({
      kind: 'montage', id: project.id, name: project.name, mode: 'quick', clipCount: project.clips.length,
      updatedAt: project.updated_at, plan: null,
    })),
    ...(input.editors ?? []).map((project): Anchor => ({
      kind: 'editor', id: project.id, name: project.name, mode: 'multitrack',
      clipCount: project.tracks.reduce((count, track) => count + track.clips.length, 0),
      updatedAt: project.updated_at, plan: null,
    })),
  ];

  const taskBuckets = new Map<string, ActivityItem[]>();
  const outputBuckets = new Map<string, OutputItem[]>();
  const orphanTasks: ActivityItem[] = [];
  const orphanOutputs: OutputItem[] = [];

  for (const task of input.tasks ?? []) {
    const anchor = taskAnchor(task, anchors);
    if (anchor === null) orphanTasks.push(task);
    else pushBucket(taskBuckets, projectId(anchor), task);
  }
  for (const output of input.outputs ?? []) {
    const anchor = outputAnchor(output, anchors);
    if (anchor === null) orphanOutputs.push(output);
    else pushBucket(outputBuckets, projectId(anchor), output);
  }

  const projects = anchors.map((anchor): ProjectViewModel => {
    const id = projectId(anchor);
    const tasks = taskBuckets.get(id) ?? [];
    const outputs = outputBuckets.get(id) ?? [];
    const recordings = tasks.filter((task) => task.kind === 'recording');
    const currentStep = inferProjectStep(anchor, recordings, outputs);
    const timestamps = [anchor.updatedAt, ...tasks.map((task) => task.updated_at), ...outputs.map((output) => output.updated_at)];
    return {
      id,
      source: { kind: anchor.kind, id: anchor.id },
      name: anchor.name,
      editingMode: anchor.mode,
      shotList: anchor.plan === null ? null : {
        planId: anchor.plan.id,
        status: anchor.plan.status,
        shotCount: anchor.plan.shot_count,
      },
      clipCount: anchor.clipCount,
      recordingTasks: recordings,
      outputFiles: outputs,
      demoIds: [...new Set(outputs.flatMap((output) => output.demo_id === null ? [] : [output.demo_id]))],
      currentStep,
      status: projectStatus(anchor, tasks, outputs),
      updatedAt: timestamps.sort((a, b) => b.localeCompare(a))[0] ?? anchor.updatedAt,
    };
  }).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

  return { projects, orphanTasks, orphanOutputs, warnings: input.warnings ?? [] };
}

function inferProjectStep(
  anchor: Anchor,
  recordings: readonly ActivityItem[],
  outputs: readonly OutputItem[],
): ProjectStep {
  if (outputs.some((output) => output.status === 'completed')) return 'export';
  if (recordings.some((task) => !TERMINAL.has(task.status))) return 'record';
  if (anchor.plan?.status === 'confirmed' && anchor.plan.shot_count > 0) return 'record';
  if (anchor.plan !== null && anchor.plan.status !== 'archived') return 'shotlist';
  return anchor.clipCount > 0 ? 'shotlist' : 'select';
}

function projectStatus(
  anchor: Anchor,
  tasks: readonly ActivityItem[],
  outputs: readonly OutputItem[],
): ProjectStatus {
  if (anchor.plan?.status === 'awaiting_confirmation' || tasks.some((task) => task.status === 'failed')) {
    return 'needs-attention';
  }
  if (outputs.some((output) => output.status === 'completed')) return 'complete';
  return 'active';
}

function taskAnchor(task: ActivityItem, anchors: readonly Anchor[]): Anchor | null {
  if (task.context_id === null) return null;
  const candidates = anchors.filter((anchor) => anchor.id === task.context_id);
  if (task.kind === 'recording') return unique(candidates.filter((anchor) => anchor.kind === 'plan'));
  if (task.kind === 'export' && task.subtype === 'montage') {
    return unique(candidates.filter((anchor) => anchor.kind === 'montage'));
  }
  if (task.kind === 'export' && task.subtype === 'editor') {
    return unique(candidates.filter((anchor) => anchor.kind === 'editor'));
  }
  return unique(candidates);
}

function outputAnchor(output: OutputItem, anchors: readonly Anchor[]): Anchor | null {
  if (output.project_id === null) return null;
  return unique(anchors.filter((anchor) => anchor.id === output.project_id));
}

function unique<T>(items: readonly T[]): T | null {
  return items.length === 1 ? items[0] ?? null : null;
}

function projectId(anchor: Pick<Anchor, 'kind' | 'id'>): string {
  return `${anchor.kind}:${anchor.id}`;
}

function pushBucket<T>(buckets: Map<string, T[]>, key: string, item: T): void {
  const bucket = buckets.get(key);
  if (bucket === undefined) buckets.set(key, [item]);
  else bucket.push(item);
}
