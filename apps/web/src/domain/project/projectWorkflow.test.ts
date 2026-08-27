import { describe, expect, it } from 'vitest';

import type { ProjectViewModel } from './projectViewModel';
import { PROJECT_STEPS, projectStepAvailability, resolveProjectStep, transitionProjectStep } from './projectWorkflow';

function project(overrides: Partial<ProjectViewModel> = {}): ProjectViewModel {
  return {
    id: 'plan:p-1', source: { kind: 'plan', id: 'p-1' }, name: 'Project', editingMode: 'agent',
    shotList: { planId: 'p-1', status: 'draft', shotCount: 0 }, clipCount: 0,
    recordingTasks: [], outputFiles: [], demoIds: [], currentStep: 'shotlist', status: 'active',
    updatedAt: '2026-08-20T00:00:00Z', ...overrides,
  };
}

describe('project workflow gates', () => {
  it('keeps selection and shot-list navigation available for every project', () => {
    expect(projectStepAvailability(project()).slice(0, 2).map((entry) => entry.enabled)).toEqual([true, true]);
  });

  it('explains why recording and export are blocked without clips', () => {
    const gates = projectStepAvailability(project());
    expect(gates[2]).toMatchObject({ enabled: false, disabledReason: '添加片段后即可开始录制' });
    expect(gates[3]).toMatchObject({ enabled: false, disabledReason: '添加片段后即可导出' });
  });

  it('allows recording with clips but gates export until an Agent shot list is confirmed', () => {
    const gates = projectStepAvailability(project({ clipCount: 3, shotList: { planId: 'p-1', status: 'awaiting_confirmation', shotCount: 3 } }));
    expect(gates[2]?.enabled).toBe(true);
    expect(gates[3]).toMatchObject({ enabled: false, disabledReason: '确认剪辑单后即可导出' });
  });

  it('allows every step for a confirmed Agent cut', () => {
    expect(projectStepAvailability(project({ clipCount: 2, shotList: { planId: 'p-1', status: 'confirmed', shotCount: 2 } })).every((entry) => entry.enabled)).toBe(true);
  });

  it('keeps an exported Agent result reachable even when the plan status is stale', () => {
    const gates = projectStepAvailability(project({
      clipCount: 1,
      shotList: { planId: 'p-1', status: 'awaiting_confirmation', shotCount: 1 },
      outputFiles: [{ status: 'completed' } as ProjectViewModel['outputFiles'][number]],
    }));

    expect(gates[3]).toMatchObject({ enabled: true, disabledReason: null });
  });

  it('sends quick and multitrack cuts straight to export instead of the game recorder', () => {
    for (const kind of ['montage', 'editor'] as const) {
      const gates = projectStepAvailability(project({
        source: { kind, id: 'cut-1' },
        clipCount: 2,
        shotList: null,
      }));
      expect(gates.find((entry) => entry.step === 'record')).toMatchObject({
        enabled: false,
        disabledReason: '快速模式和精剪模式可直接导出',
      });
      expect(gates.find((entry) => entry.step === 'export')?.enabled).toBe(true);
    }
  });

  it('falls illegal or gated queries back to the first reachable step, while omission resumes current work', () => {
    const input = project();
    expect(resolveProjectStep(input, null)).toBe('shotlist');
    expect(resolveProjectStep(input, 'record')).toBe('select');
    expect(resolveProjectStep(input, 'unknown')).toBe('select');
    expect(resolveProjectStep(input, 'select')).toBe('select');
  });

  it('allows every backward or forward transition when all gates are open', () => {
    const open = project({ clipCount: 2, shotList: { planId: 'p-1', status: 'confirmed', shotCount: 2 } });
    for (const current of PROJECT_STEPS) {
      for (const target of PROJECT_STEPS) {
        expect(transitionProjectStep(open, current, target)).toEqual({
          step: target,
          changed: current !== target,
          blockedReason: null,
        });
      }
    }
  });

  it('keeps the current step and returns the gate reason for illegal transitions', () => {
    expect(transitionProjectStep(project(), 'shotlist', 'record')).toEqual({
      step: 'shotlist', changed: false, blockedReason: '添加片段后即可开始录制',
    });
    expect(transitionProjectStep(project(), 'shotlist', 'export')).toEqual({
      step: 'shotlist', changed: false, blockedReason: '添加片段后即可导出',
    });
  });
});
