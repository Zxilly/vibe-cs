import type { AgentEvent, AgentMessage } from '../../shared/desktop/dto';

export function proposalActivityKey(messageId: string, proposalIndex: number): string {
  return `${messageId}:proposal:${proposalIndex}`;
}

export function applyAgentEvent(
  messages: AgentMessage[],
  assistantId: string,
  event: AgentEvent,
): AgentMessage[] {
  if (event.type === 'complete') return event.thread.messages;
  if (event.type === 'started' || event.type === 'error') return messages;
  return messages.map((entry) => {
    if (entry.id !== assistantId) return entry;
    if (event.type === 'textDelta') return { ...entry, content: entry.content + event.delta };
    if (event.type === 'toolCall') return { ...entry, toolCalls: [...entry.toolCalls, event.toolCall] };
    return { ...entry, proposals: [...entry.proposals, event.proposal] };
  });
}

export function rollbackOptimisticRun(
  messages: AgentMessage[],
  userId: string,
  assistantId: string,
): AgentMessage[] {
  return messages.filter((entry) => entry.id !== userId && entry.id !== assistantId);
}
