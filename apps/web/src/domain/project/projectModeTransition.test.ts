import { describe, expect, it } from 'vitest';

import { projectModeTransition } from './projectModeTransition';

describe('projectModeTransition', () => {
  it('allows only one-way escalation and always uses copy semantics', () => {
    expect(projectModeTransition('agent', 'quick', 'composition-1')).toMatchObject({
      action: 'open_copy',
      copyProjectId: 'composition-1',
    });
    expect(projectModeTransition('quick', 'multitrack', null)).toMatchObject({
      action: 'create_copy',
      reason: 'quick_to_multitrack_copy',
    });
    expect(projectModeTransition('quick', 'agent', null).action).toBe('none');
    expect(projectModeTransition('multitrack', 'quick', null).action).toBe('none');
    expect(projectModeTransition('multitrack', 'agent', null).action).toBe('none');
  });

  it('does not claim an Agent to Quick copy before a persisted Composition exists', () => {
    expect(projectModeTransition('agent', 'quick', null)).toMatchObject({
      action: 'none',
      reason: 'agent_needs_composition',
    });
  });
});
