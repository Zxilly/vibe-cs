import { describe, expect, it } from 'vitest';

import type { AgentMessage } from '../../shared/desktop/dto';
import { applyAgentEvent, proposalActivityKey, rollbackOptimisticRun } from './agentSession';

const messages: AgentMessage[] = [
  { id: 'user', role: 'user', content: 'hello', createdAt: '', toolCalls: [], proposals: [] },
  { id: 'assistant', role: 'assistant', content: '', createdAt: '', toolCalls: [], proposals: [] },
];

describe('agent streaming session', () => {
  it('keeps optimistic messages across started and applies the next delta', () => {
    const started = applyAgentEvent(messages, 'assistant', {
      type: 'started', threadId: '00000000-0000-4000-8000-000000000001',
    });
    const updated = applyAgentEvent(started, 'assistant', { type: 'textDelta', delta: 'answer' });
    expect(updated).toHaveLength(2);
    expect(updated[1]?.content).toBe('answer');
  });

  it('rolls back both optimistic messages when a run fails', () => {
    expect(rollbackOptimisticRun(messages, 'user', 'assistant')).toEqual([]);
  });

  it('does not reuse a proposal card for a same-title proposal in a new message', () => {
    expect(proposalActivityKey('message-a', 0)).not.toBe(proposalActivityKey('message-b', 0));
  });
});
