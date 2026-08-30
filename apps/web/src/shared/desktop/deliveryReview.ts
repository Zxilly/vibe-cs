import type { AgentSessionEntry } from './dto';

const DELIVERY_DECISION_PREFIX = 'delivery:';

export function deliveryDecisionToolCallId(changeGroupId: string): string {
  return `${DELIVERY_DECISION_PREFIX}${changeGroupId}`;
}

export function deliveryDecisionChangeGroupId(entry: AgentSessionEntry): string | null {
  if (entry.kind !== 'tool_decision' || !entry.tool_call_id.startsWith(DELIVERY_DECISION_PREFIX)) return null;
  const changeGroupId = entry.tool_call_id.slice(DELIVERY_DECISION_PREFIX.length);
  return changeGroupId === '' ? null : changeGroupId;
}
