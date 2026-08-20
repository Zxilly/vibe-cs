import type { ProjectStep, ProjectViewModel } from './projectViewModel';

export const PROJECT_STEPS: readonly ProjectStep[] = ['select', 'shotlist', 'record', 'export'];

export interface ProjectStepAvailability {
  readonly step: ProjectStep;
  readonly enabled: boolean;
  readonly disabledReason: string | null;
}

export interface ProjectStepTransition {
  readonly step: ProjectStep;
  readonly changed: boolean;
  readonly blockedReason: string | null;
}

export function projectStepAvailability(project: ProjectViewModel): readonly ProjectStepAvailability[] {
  const hasClips = project.clipCount > 0;
  const confirmed = project.shotList === null || project.shotList.status === 'confirmed';
  const hasCompletedOutput = project.outputFiles.some((output) => output.status === 'completed');
  const recordsThroughGame = project.source.kind === 'plan';
  return [
    { step: 'select', enabled: true, disabledReason: null },
    { step: 'shotlist', enabled: true, disabledReason: null },
    {
      step: 'record',
      enabled: hasClips && recordsThroughGame,
      disabledReason: !hasClips
        ? '还没有片段，不能开始录制'
        : recordsThroughGame ? null : '快速模式和精剪模式直接导出，不需要录制',
    },
    {
      step: 'export',
      enabled: hasClips && (confirmed || hasCompletedOutput),
      disabledReason: !hasClips
        ? '还没有片段，不能导出'
        : confirmed || hasCompletedOutput ? null : '剪辑单还没有确认，不能导出',
    },
  ];
}

export function resolveProjectStep(
  project: ProjectViewModel,
  requested: string | null,
): ProjectStep {
  const availability = projectStepAvailability(project);
  if (requested === null) {
    const current = availability.find((entry) => entry.step === project.currentStep && entry.enabled);
    return current?.step ?? firstEnabled(availability);
  }
  if (PROJECT_STEPS.includes(requested as ProjectStep)) {
    const target = availability.find((entry) => entry.step === requested);
    if (target?.enabled === true) return target.step;
  }
  return firstEnabled(availability);
}

export function transitionProjectStep(
  project: ProjectViewModel,
  current: ProjectStep,
  target: ProjectStep,
): ProjectStepTransition {
  const gate = projectStepAvailability(project).find((entry) => entry.step === target);
  if (gate?.enabled !== true) {
    return { step: current, changed: false, blockedReason: gate?.disabledReason ?? '这个步骤当前不可用' };
  }
  return { step: target, changed: target !== current, blockedReason: null };
}

function firstEnabled(availability: readonly ProjectStepAvailability[]): ProjectStep {
  return availability.find((entry) => entry.enabled)?.step ?? 'select';
}
