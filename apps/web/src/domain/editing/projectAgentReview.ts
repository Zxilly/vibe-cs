import { deliveryDecisionChangeGroupId } from '../../shared/desktop/deliveryReview';
import type { AgentSession, ProjectChangeGroup } from '../../shared/desktop/dto';

export function pendingDeliveryGroup(
  changeGroups: readonly ProjectChangeGroup[],
  session: AgentSession | null,
): ProjectChangeGroup | null {
  if (session === null) return null;
  const latestUserAt = [...session.entries].reverse().find((entry) => entry.kind === 'user')?.at ?? null;
  if (latestUserAt === null) return null;
  const decidedGroupIds = new Set(session.entries.flatMap((entry) => {
    const groupId = deliveryDecisionChangeGroupId(entry);
    return groupId === null ? [] : [groupId];
  }));
  return changeGroups.find((group) => (
    group.author.kind === 'agent'
      && group.author.session_id === session.id
      && group.created_at >= latestUserAt
      && !decidedGroupIds.has(group.id)
  )) ?? null;
}
