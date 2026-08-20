/*
 * pages/agent — the shell's `AgentChangeDesk`, as a hook (invariant 6).
 *
 * `/agent` draws the Agent's change cards **twice**: block A puts them in the
 * transcript under the proposal that carried them, block B puts them in the
 * plan panel's 本次变更. That is deliberate — 2a's board is a conversation of
 * changes and the panel is where the plan is — but it means every fact about a
 * change is a fact two components render. Held per block, they disagreed:
 *
 *   the decision   two `useState` maps, two key spellings (`#` against `:`), so
 *                  one press left 已接受 in one column and 待处理 in the other
 *   the plan       block B applied an accepted change to its own `localShots`
 *                  and block A applied nothing at all — 接受 there wrote a
 *                  decision and stopped, which the user read as 「生效了」
 *
 * So the state lives here, in one hook the shell calls once, and 接受 is a
 * single function that cannot do half of itself. The hook is exported rather
 * than inlined into `AgentPage` for one reason: a block test needs the real
 * desk around the block it mounts, and a second implementation written for the
 * tests would be free to drift from the one that ships.
 *
 * ── What this hook does not do ───────────────────────────────────────────
 *
 * It never writes. `record` hands the edit to `props.editNotifier` and §4.5.4's
 * window decides when it leaves; nothing here can reach `useApplyAgentPlanEdit`
 * (invariant 5) and nothing here can reach a recording command (§4.5.3 ①).
 * `accept` is `applyPlanChange` — arithmetic on `duration_seconds` and a soft
 * delete — and that is the whole of it.
 *
 * It also does not store a decision anywhere it would outlive the page: gap 3,
 * the wire has no accept/reject state, and a `localStorage` copy of 「我拒绝过这
 * 条」 that the server does not share would disagree with the next window.
 */

import { useMemo, useState } from 'react';

import type { EditNotifierHandle } from '../../data/editNotifier';
import type { PlanChange } from '../../domain/agent';
import type { AgentPlanShot } from '../../shared/desktop/dto';

import type { AgentChangeDesk } from './agentContract';
import {
  NO_CHANGE_DECISIONS,
  type ChangeDecision,
  type ChangeDecisions,
} from './conversationModel';
import { applyPlanChange } from './planChangeApply';
import type { ShotEditResult } from './planEditModel';

export interface AgentChangeDeskInput {
  /** The plan on screen, or `null` when `?plan=` names nothing. */
  readonly planId: string | null;
  /** That plan's shots as the **server** has them. */
  readonly shots: readonly AgentPlanShot[];
  /** The page's one notifier — the desk records through it, never around it. */
  readonly editNotifier: EditNotifierHandle;
  readonly storedDecisions?: ChangeDecisions | undefined;
  readonly persistDecision?: ((key: string, decision: ChangeDecision | null) => Promise<void>) | undefined;
}

/** The buffer carries the plan it belongs to; see `bufferedShots` below. */
interface PlanShotBuffer {
  readonly planId: string;
  readonly shots: readonly AgentPlanShot[];
}

export function useAgentChangeDesk(input: AgentChangeDeskInput): AgentChangeDesk {
  const { planId, shots, editNotifier } = input;

  const [localDecisions, setLocalDecisions] = useState<ReadonlyMap<string, ChangeDecision | null>>(
    NO_CHANGE_DECISIONS,
  );
  const [buffer, setBuffer] = useState<PlanShotBuffer | null>(null);
  const decisions = useMemo(() => {
    const merged = new Map(input.storedDecisions ?? NO_CHANGE_DECISIONS);
    for (const [key, decision] of localDecisions) {
      if (decision === null) merged.delete(key);
      else merged.set(key, decision);
    }
    return merged;
  }, [input.storedDecisions, localDecisions]);

  /*
   * The buffer is read back only when it names the plan on screen, rather than
   * being cleared by an effect: a plan switch then drops it in the same render
   * the new plan arrives in, with no window in which one plan's shots are drawn
   * under another plan's title. 一个 buffer 不跨对象.
   *
   * The decisions are **not** cleared with it. A decision is about a proposal,
   * and a proposal belongs to the session; the transcript goes on showing it
   * after the plan selection moves, so forgetting the answer would lose work
   * the user did by navigating.
   */
  const bufferedShots = buffer !== null && buffer.planId === planId ? buffer.shots : null;
  const currentShots = bufferedShots ?? shots;

  const decide = (key: string, decision: ChangeDecision | null) => {
    setLocalDecisions((current) => {
      const next = new Map(current);
      next.set(key, decision);
      return next;
    });
    void input.persistDecision?.(key, decision);
  };

  const record = (result: ShotEditResult, note?: string) => {
    // An edit needs the plan it was made on: `PlanEditRecord.planId` is what
    // keeps a buffer from crossing objects, and there is nothing to name here.
    if (planId === null) return;
    setBuffer({ planId, shots: result.shots });
    const trimmed = note === undefined || note.trim() === '' ? null : note.trim();
    for (const change of result.changes) {
      editNotifier.record({ planId, change, shots: result.shots, note: trimmed });
    }
  };

  return {
    decisions,
    decide,
    accept: (key: string, change: PlanChange) => {
      /* Both halves or neither. `applyPlanChange` returns `null` for a change
         the payload cannot carry out (`replace` / `insert` carry prose and no
         shot) and for one whose target is gone; marking such a card 已接受 over
         a plan nothing happened to is the silent no-op this desk exists to make
         impossible. Both blocks disable 接受 with that reason
         (`changeApplicability`), so this branch is the backstop rather than the
         user's experience of it. */
      const result = applyPlanChange(currentShots, change);
      if (result === null) return;
      record(result);
      decide(key, 'accepted');
    },
    shots: bufferedShots,
    record,
    reset: () => {
      setBuffer(null);
    },
  };
}
