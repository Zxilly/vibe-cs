/*
 * pages/agent — the page's proposal model (spec §7 `?mode=`, §4.5.2, §4.5.3).
 *
 * Everything `/agent` decides about the Agent's proposals that does not need a
 * DOM lives here, so the `unit` project covers it: which proposals a transcript
 * carries, what a user did with each change, and what state a change is
 * therefore in.
 *
 * Block A's transcript projection (`collectProposals`) is here because it is
 * pure; **the decision model below it is the whole page's**. Block B has its own
 * projection — `planProposals.readPlanProposals`, 「这个方案的提议」 — and it
 * files its decisions under the same keys, through the same functions, because
 * one change drawn in two columns cannot have two answers (invariant 6).
 *
 * ── The one ordering that matters ─────────────────────────────────────────
 *
 * `resolveChangeSet` applies the user's decisions **first** and the revision
 * **second**. That is not an implementation detail; it is §4.5.3 rule ③ read
 * literally — 「未处理的变更立即变 stale……已接受过的变更不受影响」. `markStale`
 * only ever touches a `pending` change, so a change the user already accepted
 * or rejected survives a revision bump untouched, and a change nobody has
 * looked at expires. Reversing the two would expire decisions that were made
 * before the edit, which is the failure the rule exists to prevent.
 *
 * ── Why decisions are a map in the page and not a field on the change ─────
 *
 * `agentContract.ts` gap 3: **no accept / reject state exists on the wire.**
 * There is no route that records a decision, and `WorkspaceEditNotice.by` is
 * `'user'` for an accepted Agent suggestion exactly as it is for a hand edit,
 * so even after the fact the server cannot tell them apart. The decisions
 * therefore live in the page shell for the life of the page and are lost on
 * reload, and block A says so on screen rather than implying they were saved.
 *
 * The key is `entryId # proposalIndex # changeId` and not `changeId` alone:
 * `readPlanChangeSet` falls back to `op-target-index` when a payload carries no
 * id, so two proposals in one session can legitimately produce the same change
 * id, and a single-part key would let a decision on one leak onto the other.
 * Both projections spell it the same way, byte for byte — that is what makes
 * one map readable from both columns.
 *
 * ── Composer copy is a total record ──────────────────────────────────────
 *
 * The three shapes ask for different things — 2a's bottom bar is a command
 * line (「给方案下一条指令」), 2b's is scoped to one shot (「对这个镜头说」), 2c
 * has no instruction bar of its own — so the placeholder, the suggestions and
 * the send label are per mode. A `Record<AgentMode, …>` rather than a switch,
 * for `matchEnums.ts`'s reason: a fourth mode must not be addable without
 * deciding what its composer says.
 */

import { msg } from '@lingui/core/macro';
import type { MessageDescriptor } from '@lingui/core';

import {
  markStale,
  pendingChangeCount,
  readPlanChangeSet,
  type PlanChange,
  type PlanChangeSet,
} from '../../domain/agent';
import type {
  AgentPlanShot,
  AgentSessionEntry,
  AgentSessionProposal,
} from '../../shared/desktop/dto';
import { AGENT_MODES, type AgentMode } from './agentContract';

/* ── proposals, located in the transcript ────────────────────────────────── */

/**
 * A proposal a decision can be filed against.
 *
 * The two projections of the same session — block A's `ProposalSlot` and block
 * B's `PlanProposal` — differ in what they carry beside the change set (a
 * prompt, a timestamp), and agree on the only two fields a decision needs. This
 * is the shape `resolveChangeSet` and `changeDecisionKey` speak, so neither
 * column gets its own copy of §4.5.3 ③.
 */
export interface DecidableProposal {
  /** `entryId#index` — stable for the life of the entry, and unique in it. */
  readonly key: string;
  /** `null` when the payload is not a change set we recognise. */
  readonly changeSet: PlanChangeSet | null;
}

/** One proposal of one assistant entry, with everything needed to draw it. */
export interface ProposalSlot extends DecidableProposal {
  readonly key: string;
  readonly entryId: string;
  readonly proposal: AgentSessionProposal;
  /**
   * `readPlanChangeSet(proposal)`. `null` means 「这条提议不是方案变更，或者它的
   * payload 不是我们认识的形状」 — the card prints its title and no change cards.
   */
  readonly changeSet: PlanChangeSet | null;
  /**
   * The user message this proposal answers — the 2a board's 「本次变更 来自
   * 『把它压到 30 秒以内』」. `null` when the session opens with an assistant
   * entry, which a resumed session can. Never invented from the proposal.
   */
  readonly prompt: string | null;
}

/**
 * Every proposal in the transcript, in reading order.
 *
 * The prompt is carried forward from the most recent user entry: an assistant
 * that answers twice is still answering the same question, and a
 * `workspace_edit` line between them is a notice, not a question (§4.5.2).
 */
export function collectProposals(entries: readonly AgentSessionEntry[]): readonly ProposalSlot[] {
  const slots: ProposalSlot[] = [];
  let prompt: string | null = null;

  for (const entry of entries) {
    if (entry.kind === 'user') {
      prompt = entry.content === '' ? null : entry.content;
      continue;
    }
    if (entry.kind !== 'assistant') continue;

    entry.proposals.forEach((proposal, index) => {
      slots.push({
        key: `${entry.id}#${String(index)}`,
        entryId: entry.id,
        proposal,
        changeSet: readPlanChangeSet(proposal),
        prompt,
      });
    });
  }

  return slots;
}

/** The slots of one entry, for `AgentTranscript`'s per-entry extras. */
export function proposalsByEntry(
  slots: readonly ProposalSlot[],
): ReadonlyMap<string, readonly ProposalSlot[]> {
  const byEntry = new Map<string, ProposalSlot[]>();
  for (const slot of slots) {
    const existing = byEntry.get(slot.entryId);
    if (existing === undefined) byEntry.set(slot.entryId, [slot]);
    else existing.push(slot);
  }
  return byEntry;
}

/* ── what the user did with a change ─────────────────────────────────────── */

/** The two decisions a user can make. `pending` is the absence of one. */
export type ChangeDecision = 'accepted' | 'rejected';

export type ChangeDecisions = ReadonlyMap<string, ChangeDecision>;

/** The empty map, shared so a fresh block does not allocate one per render. */
export const NO_CHANGE_DECISIONS: ChangeDecisions = new Map<string, ChangeDecision>();

/** See the header on why the key has three parts. */
export function changeDecisionKey(slotKey: string, changeId: string): string {
  return `${slotKey}#${changeId}`;
}

/**
 * Records a decision, or clears it with `null` (「撤销拒绝」 goes through
 * `'accepted'`, so `null` is for a caller that wants the change back to
 * untouched). Returns the same map when nothing would change, so the block can
 * call it from an event handler without re-rendering the whole transcript.
 */
export function withChangeDecision(
  decisions: ChangeDecisions,
  key: string,
  decision: ChangeDecision | null,
): ChangeDecisions {
  if (decision === null) {
    if (!decisions.has(key)) return decisions;
    const next = new Map(decisions);
    next.delete(key);
    return next;
  }

  if (decisions.get(key) === decision) return decisions;
  const next = new Map(decisions);
  next.set(key, decision);
  return next;
}

/**
 * One proposal's change set as it should be drawn: the user's decisions, then
 * §4.5.3 rule ③. See the header for why that order is the rule.
 *
 * The one implementation of that composition. Both columns call it with their
 * own projection of the same proposal, so a card cannot be 已接受 in one and
 * 待处理 in the other.
 *
 * `currentRevision` is `null` when no plan is on screen — nothing can be called
 * expired without the number it is being compared against.
 */
export function resolveChangeSet(
  proposal: DecidableProposal,
  decisions: ChangeDecisions,
  currentRevision: number | null,
): PlanChangeSet | null {
  const set = proposal.changeSet;
  if (set === null) return null;

  const decided = applyDecisions(set, proposal.key, decisions);
  return currentRevision === null ? decided : markStale(decided, currentRevision);
}

function applyDecisions(
  set: PlanChangeSet,
  slotKey: string,
  decisions: ChangeDecisions,
): PlanChangeSet {
  if (decisions.size === 0) return set;

  let changed = false;
  const changes = set.changes.map((change) => {
    const decision = decisions.get(changeDecisionKey(slotKey, change.id));
    if (decision === undefined || change.state === decision) return change;
    changed = true;
    return { ...change, state: decision };
  });

  return changed ? { ...set, changes } : set;
}

/**
 * 2b's 「只影响这一个镜头」: the changes that touch the selected shot. With no
 * selection every change is shown — a filter nobody set filters nothing.
 */
export function changesForShot(
  changes: readonly PlanChange[],
  shotId: string | null,
): readonly PlanChange[] {
  if (shotId === null) return changes;
  return changes.filter((change) => change.targetShotId === shotId);
}

/** The toolbar's 「3 项变更待处理」, across every proposal in the session. */
export function pendingTotal(sets: readonly (PlanChangeSet | null)[]): number {
  let total = 0;
  for (const set of sets) {
    if (set !== null) total += pendingChangeCount(set);
  }
  return total;
}

/**
 * How many changes expired — counted separately and printed separately.
 *
 * An expired change is not 「待处理」: it cannot be accepted, so folding it into
 * that count would ask the user to do something the card forbids. But it is
 * also not nothing — three dimmed cards on screen beside 「没有待处理的变更」 is
 * a head that contradicts its own body, and 「已过期」 is what reconciles them.
 */
export function staleTotal(sets: readonly (PlanChangeSet | null)[]): number {
  let total = 0;
  for (const set of sets) {
    if (set === null) continue;
    total += set.changes.filter((change) => change.state === 'stale').length;
  }
  return total;
}

/* ── naming a shot a change points at ────────────────────────────────────── */

/** 「02 跟随突破」 — the change card's `targetLabel`, resolved from the plan. */
export interface ShotLabel {
  /** Two digits, the same numbering the strip and the edit notice use. */
  readonly number: string;
  readonly title: string;
}

/**
 * The shot a change targets, or `null` when the plan on screen does not contain
 * it — a proposal can outlive the shot it was written about, and a card that
 * guessed a name from an id would be inventing one.
 */
export function shotLabelOf(
  shots: readonly AgentPlanShot[],
  shotId: string,
): ShotLabel | null {
  const index = shots.findIndex((shot) => shot.id === shotId);
  const shot = index < 0 ? undefined : shots[index];
  if (shot === undefined) return null;
  return { number: String(index + 1).padStart(2, '0'), title: shot.title };
}

/* ── the composer, per mode ──────────────────────────────────────────────── */

export interface ComposerCopy {
  /** The empty box's own sentence, from each artboard's own instruction bar. */
  readonly placeholder: MessageDescriptor;
  /** The chips beside it. Empty for a shape whose artboard draws none. */
  readonly suggestions: readonly MessageDescriptor[];
  readonly sendLabel: MessageDescriptor;
}

/**
 * Untagged: none of these strings is a word with a second sense elsewhere —
 * they are whole sentences, or the shape's own verb. 「发送」 is the same 发送
 * every composer in the product uses, and splitting it would produce two
 * entries free to drift (§10.5 deviation 4).
 */
export const AGENT_MODE_COMPOSER: Readonly<Record<AgentMode, ComposerCopy>> = {
  changes: {
    placeholder: msg`给剪辑单下一条指令，例如「02 再短一点」「把结尾留 1 秒」`,
    suggestions: [msg`压到 30 秒`, msg`去掉运动镜头`, msg`只保留击杀`, msg`加 0.5 秒尾巴`],
    sendLabel: msg`生成变更`,
  },
  inline: {
    placeholder: msg`对选中的片段说，例如「跟到他开第一枪就停」`,
    suggestions: [msg`再快一点`, msg`别贴这么近`, msg`从他起跳开始`],
    sendLabel: msg`发送`,
  },
  takes: {
    /* 2c's own bar is 「再生成一条 take」, which needs a Take model the wire does
       not have (gap 8). So this shape gets the ordinary composer and no chips
       that promise a branch nobody can store. */
    placeholder: msg`继续和 Agent 说，例如「第 3 个片段前面留 1 秒」`,
    suggestions: [],
    sendLabel: msg`发送`,
  },
};

/** Walked by the totality test, so a fourth mode cannot ship without copy. */
export const COMPOSER_MODES: readonly AgentMode[] = AGENT_MODES;
