import { describe, expect, it } from 'vitest';

import { deriveAgentRouteContext, resolveAgentNavigation } from './agentNavigation';

describe('AI workspace navigation', () => {
  it('turns a typed replay intent into an exact current-Demo route', () => {
    expect(resolveAgentNavigation({
      name: 'navigate_workspace',
      input: { destination: 'replay' },
      output: { accepted: true, destination: 'replay', reason: null },
    }, {
      demoId: '11111111-1111-4111-8111-111111111111',
      projectId: null,
    })).toBe('/analysis?demo=11111111-1111-4111-8111-111111111111&tab=replay');
  });

  it('rejects arbitrary paths, missing context, and non-exact tool output', () => {
    const context = { demoId: null, projectId: null };
    expect(resolveAgentNavigation({
      name: 'navigate_workspace', input: { destination: 'replay' },
      output: { accepted: true, destination: 'replay', reason: null },
    }, context)).toBeNull();
    expect(resolveAgentNavigation({
      name: 'navigate_workspace', input: { destination: '/settings' },
      output: { accepted: true, destination: '/settings', reason: null },
    }, context)).toBeNull();
    expect(resolveAgentNavigation({
      name: 'navigate_workspace', input: { destination: 'review' },
      output: { accepted: true, destination: 'review', reason: null, path: '/settings' },
    }, context)).toBeNull();
  });

  it('derives review and edit context only from canonical route parameters', () => {
    expect(deriveAgentRouteContext(
      '/analysis',
      '?demo=11111111-1111-4111-8111-111111111111&tab=replay&round=7&tick=640&player=76561198000000001',
    )).toEqual({
      workflow: 'review', destination: 'replay', demoId: '11111111-1111-4111-8111-111111111111',
      projectId: null, playerId: '76561198000000001', roundNumber: 7, tick: 640,
    });
    expect(deriveAgentRouteContext(
      '/studio/editor',
      '?project=22222222-2222-4222-8222-222222222222',
    )).toEqual({
      workflow: 'edit', destination: 'studio', demoId: null,
      projectId: '22222222-2222-4222-8222-222222222222', playerId: null, roundNumber: null, tick: null,
    });
    expect(deriveAgentRouteContext('/analysis', '?demo=../forged')).toEqual({
      workflow: 'review', destination: 'review', demoId: null, projectId: null,
      playerId: null, roundNumber: null, tick: null,
    });
  });
});
