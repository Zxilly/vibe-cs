/*
 * pages/agent — 「用 Agent 制作视频」's one implementation.
 *
 * Split from `agentHandoff.ts` for one reason: that module is pure and is
 * covered by a `unit`-project test that runs in node with no DOM, and a
 * `useMutation` three imports down would pull the whole desktop bridge into it.
 * The address and the payload live there; the two side effects live here.
 *
 * The sender decides *what* is selected and how to say why it cannot be sent.
 * This hook owns the pair that must not vary from page to page:
 *
 *   1. create the **bound** plan (`AgentPlanShot.recording` on every shot), and
 *   2. `navigate(agentPlanHandoff(plan.id))`.
 *
 * A page that built the address itself would still be building it after §7
 * changes; a page that built the plan itself would eventually build an unbound
 * one, and an unbound plan is a plan `/recording/:planId` can only refuse
 * (422 `agent_plan_shots_unbound`).
 */

import { useCallback } from 'react';
import { useNavigate } from 'react-router-dom';

import { useCreateAgentPlan } from '../../data/plans';
import {
  agentPlanDraftFromHighlights,
  agentPlanHandoff,
  type HighlightHandoffInput,
} from './agentHandoff';

export interface AgentVideoHandoff {
  /** Creates the plan and navigates. Rejects if the write does. */
  readonly run: (input: HighlightHandoffInput) => Promise<void>;
  readonly pending: boolean;
  readonly error: unknown;
}

export function useAgentVideoHandoff(): AgentVideoHandoff {
  const navigate = useNavigate();
  const createPlan = useCreateAgentPlan();

  const run = useCallback(
    async (input: HighlightHandoffInput) => {
      const draft = agentPlanDraftFromHighlights(input);
      /* A refused draft never reaches the service. The sender is expected to
         have disabled the action already — this is the second lock, not the
         first, and it returns quietly because the disabled reason has already
         said everything there is to say. */
      if (!draft.ok) return;
      const plan = await createPlan.mutateAsync(draft.plan);
      await navigate(agentPlanHandoff(plan.id));
    },
    [createPlan, navigate],
  );

  return { run, pending: createPlan.isPending, error: createPlan.error };
}
