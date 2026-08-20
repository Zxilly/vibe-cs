import { describe, expect, it } from 'vitest';

import { buildAgentReadiness } from './AgentReadiness';

const READY = {
  projectId: 'plan:p-1',
  demoId: 'demo-1',
  demoStatus: 'ready' as const,
  demoPending: false,
  demoError: null,
  modelConfigured: true,
  modelPending: false,
  modelError: null,
  recordingMissing: [] as string[],
  recordingPending: false,
  recordingError: null,
};

describe('Agent readiness', () => {
  it('opens the first sentence when Demo and model are ready', () => {
    const state = buildAgentReadiness(READY);
    expect(state.gate).toEqual({ disabled: false });
    expect(state.items.map((item) => item.state)).toEqual(['ok', 'ok', 'ok', 'ok']);
    expect(state.items.find((item) => item.key === 'model')).toMatchObject({
      detail: '模型运行时已就绪', action: null,
    });
  });

  it('treats analysis as an automatic stage rather than another prerequisite form', () => {
    for (const demoStatus of ['discovered', 'indexing', 'analyzing', 'failed'] as const) {
      const state = buildAgentReadiness({ ...READY, demoStatus });
      expect(state.gate).toEqual({ disabled: false });
      expect(state.items.find((item) => item.key === 'analysis')).toMatchObject({
        blocking: false,
      });
    }
    expect(buildAgentReadiness({ ...READY, demoStatus: 'missing' }).gate.disabled).toBe(true);
  });

  it('names the first blocking fact and routes directly to its repair', () => {
    const state = buildAgentReadiness({ ...READY, modelConfigured: false });
    expect(state.gate).toMatchObject({ disabled: true, disabledReason: '还没有可用的模型配置' });
    expect(state.items.find((item) => item.key === 'model')?.action?.to)
      .toBe('/settings?section=ai&item=model');
  });

  it('reports missing recording tools without blocking the shot-list draft', () => {
    const state = buildAgentReadiness({ ...READY, recordingMissing: ['HLAE', 'NVENC'] });
    expect(state.gate).toEqual({ disabled: false });
    expect(state.items.find((item) => item.key === 'recording')).toMatchObject({
      state: 'warn', blocking: false,
    });
  });
});
