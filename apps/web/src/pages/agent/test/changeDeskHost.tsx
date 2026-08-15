/*
 * Test-only — the page shell's `AgentChangeDesk`, mounted around one block.
 *
 * A block test wants the block alone with the props `AgentBlockProps` promises,
 * and `props.changes` is the one prop that is *stateful*: pressing 接受 in
 * either block writes a decision and edits the plan, and the block re-renders
 * from what came back. A stub of `vi.fn()`s would therefore turn every accept
 * assertion into an assertion about the stub.
 *
 * So this mounts the real `useAgentChangeDesk` — the same hook `AgentPage`
 * calls, not a second implementation written for the tests — and hands the desk
 * to a render prop. Two consequences worth stating:
 *
 *   a block test that clicks 接受 exercises the shipped accept path, including
 *   `applyPlanChange` and the `editNotifier.record` that follows it;
 *
 *   `inertChangeDesk` is for the `markup` project only, where nothing is
 *   pressed and the desk is just a prop that has to exist.
 *
 * The two columns agreeing with *each other* cannot be seen from here — that
 * needs both blocks in one tree, which is `changeDecision.interaction.test.tsx`.
 */

import type { ReactNode } from 'react';
import { vi } from 'vitest';

import type { EditNotifierHandle } from '../../../data/editNotifier';
import type { AgentPlanShot } from '../../../shared/desktop/dto';
import type { AgentChangeDesk } from '../agentContract';
import { useAgentChangeDesk } from '../changeDesk';
import { NO_CHANGE_DECISIONS } from '../conversationModel';

/** A desk nothing has been pressed on. Every write is recorded and ignored. */
export function inertChangeDesk(): AgentChangeDesk {
  return {
    decisions: NO_CHANGE_DECISIONS,
    decide: vi.fn(),
    accept: vi.fn(),
    shots: null,
    record: vi.fn(),
    reset: vi.fn(),
  };
}

export interface ChangeDeskHostProps {
  readonly planId: string | null;
  /** The plan's shots as the (mocked) query hands them out. */
  readonly shots: readonly AgentPlanShot[];
  readonly editNotifier: EditNotifierHandle;
  readonly children: (changes: AgentChangeDesk) => ReactNode;
}

export function ChangeDeskHost({ planId, shots, editNotifier, children }: ChangeDeskHostProps) {
  const changes = useAgentChangeDesk({ planId, shots, editNotifier });
  return <>{children(changes)}</>;
}
