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
    expect(gates[2]).toMatchObject({ enabled: false, disabledReason: '还没有片段，不能开始录制' });
    expect(gates[3]).toMatchObject({ enabled: false, disabledReason: '还没有片段，不能导出' });
  });

  it('allows recording with clips but gates export until an Agent shot list is confirmed', () => {
    const gates = projectStepAvailability(project({ clipCount: 3, shotList: { planId: 'p-1', status: 'awaiting_confirmation', shotCount: 3 } }));
    expect(gates[2]?.enabled).toBe(true);
    expect(gates[3]).toMatchObject({ enabled: false, disabledReason: '剪辑单还没有确认，不能导出' });
  });

  it('allows every step for confirmed or non-Agent cuts with clips', () => {
    expect(projectStepAvailability(project({ clipCount: 2, shotList: { planId: 'p-1', status: 'confirmed', shotCount: 2 } })).every((entry) => entry.enabled)).toBe(true);
    expect(projectStepAvailability(project({ clipCount: 2, shotList: null })).every((entry) => entry.enabled)).toBe(true);
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
      step: 'shotlist', changed: false, blockedReason: '还没有片段，不能开始录制',
    });
    expect(transitionProjectStep(project(), 'shotlist', 'export')).toEqual({
      step: 'shotlist', changed: false, blockedReason: '还没有片段，不能导出',
    });
  });
});
