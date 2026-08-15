/*
 * Domain layer, 2 of 3 — agent/, the 工作进度 vocabulary.
 *
 * `types.ts` holds the eight closed sets that come off the wire. This one does
 * not: a work step's state is a *presentation* state, invented by the 07
 * artboard's own trail (four rows that happened, one that is waiting for the
 * user), with nothing behind it on the wire — `AgentSessionEntry` has no
 * per-step record at all (`agentContract.ts` gap 7).
 *
 * It lives in its own small module rather than in `types.ts` for two reasons:
 * `types.ts` is not mine to edit this round, and mixing a UI-only union into
 * the file whose header says 「这里只放 wire 没有携带的闭集」 would blur the one
 * distinction that file is organised around.
 *
 * Same shape as every table there — a total `Record` over the union, so a
 * fourth state cannot be added without deciding what it says.
 */

import { msg } from '@lingui/core/macro';
import type { MessageDescriptor } from '@lingui/core';

/** Done, happening, or waiting on the user. The trail draws exactly these. */
export type AgentWorkStepState = 'done' | 'active' | 'waiting';

export const AGENT_WORK_STEP_STATES: readonly AgentWorkStepState[] = ['done', 'active', 'waiting'];

export interface AgentWorkStepStateMeta {
  /** The screen-reader reading of the marker. The square is never alone (§6.2). */
  readonly label: MessageDescriptor;
}

/**
 * Untagged, deliberately. 「已完成」 and 「进行中」 already mean exactly this on a
 * task card, and 「等待你确认」 is a longer string than the task card's
 * 「等待确认」 — so nothing here collides with a different sense, and splitting a
 * shared word would produce two entries free to drift (§10.5 deviation 4).
 */
export const AGENT_WORK_STEP_STATE: Readonly<Record<AgentWorkStepState, AgentWorkStepStateMeta>> = {
  done: { label: msg`已完成` },
  active: { label: msg`进行中` },
  waiting: { label: msg`等待你确认` },
};
