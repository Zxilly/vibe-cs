/*
 * Domain layer — agent/, the closed vocabularies of the Agent workspace
 * (spec §4.5.2, phase 3e).
 *
 * ── Why this file re-uses the wire types instead of redeclaring them ───────
 *
 * `domain/match/types.ts` and `domain/task/types.ts` both open by saying they
 * are *display* models and deliberately not `shared/desktop/dto` re-exports.
 * This directory does the opposite, on purpose, and the difference is worth
 * stating because it looks like an inconsistency:
 *
 *   A match is **read**. The analysis document is fetched, projected onto a
 *   scoreboard, and never sent back, so a display copy costs one mapper.
 *
 *   A plan is **edited and written back**. `applyAgentPlanEdit` takes the whole
 *   `shots: AgentPlanShot[]` array plus an `expected_revision`, so a display
 *   copy would need a reverse mapper as well — and a reverse mapper is exactly
 *   where a round trip silently drops `params` (typed `unknown`) or renames a
 *   field the server compares against. §4.5.3 rule ③ makes the plan the object
 *   the *whole concurrency story* hangs on; it must go through one shape only.
 *
 * So `AgentSession`, `AgentSessionEntry`, `AgentObjectRef`, `AgentPlan`,
 * `AgentPlanShot`, `AgentPlanOrigin`, `WorkspaceEditNotice`,
 * `AgentWorkspaceSettings`, `AgentSessionStorageStats` and friends are used
 * from `shared/desktop/dto` unchanged, by every layer. Nothing here shadows
 * them. What lives here is only what the wire does *not* carry:
 *
 *   1. the closed vocabularies plus one `Record<Union, meta>` table each, so no
 *      component grows an `if (kind === …)` chain (the `matchEnums.ts` rule: a
 *      chain is where a new member renders as nothing, a total `Record` fails
 *      to compile);
 *   2. the change-set display model, which the wire types as `unknown`
 *      (`AgentSessionProposal.payload`) — see the block below.
 *
 * ── §4.5.2's ideal types vs. what the backend actually sends ───────────────
 *
 *   §4.5.2                     wire (dto.ts)                    verdict
 *   Session                    AgentSession                     same
 *   ObjectRef                  AgentObjectRef                   same (+ touch_count)
 *   Entry (3 kinds)            AgentSessionEntry                same
 *   WorkspaceEditNotice        WorkspaceEditNotice              same
 *   Plan / Shot / PlanOrigin   AgentPlan / AgentPlanShot / …    same
 *   Shot.kind (5 members)      camera_style (7 members)         wire is wider ↓
 *   ChangeSet / Change         *nothing*                        modelled here ↓
 *   Take / Composition         *nothing*                        gap, see below
 *
 * **Shot kind.** §4.5.2 lists five (Static / Tracking / POV / Crane / Flyby)
 * but `AgentPlanShot.kind` is `RecordingRequest['camera_style']`, which has
 * seven — `orbit` and `dolly` as well, and the artboard's own edit dialog shows
 * a 「镜头类型」 dropdown whose options must be the ones the recorder can
 * actually execute. A table over five members would fail to render a plan the
 * backend can legally return, so the table is total over the wire union and the
 * two extras are labelled. The reference names `Dolly` in prose (「第 2 个镜头
 * 由 Dolly 改为 Tracking」), which confirms the wider set is the real one.
 *
 * **ChangeSet.** There is no change type anywhere on the wire.
 * `AgentSessionProposal` is `{ kind: string, title, plan_id, based_on_revision,
 * payload: unknown }` and the streaming `AgentProposal` is narrower still. So
 * the per-change diff the 2a board is built from — op, target shot, before,
 * after, delta, rationale, warning — has no server type, and this file declares
 * it as the shape the UI parses `payload` *into*, with `readPlanChangeSet`
 * returning `null` rather than a half-filled object when the payload does not
 * match. Nothing is invented: a field that is missing stays `null` and the card
 * omits that line. The gap is reported in `agentContract.ts`'s header.
 *
 * **`state` is client state.** `pending / accepted / rejected` exist nowhere on
 * the wire and no route records them — accepting a change is expressed as an
 * ordinary `applyAgentPlanEdit`. So the state lives in the page for the life of
 * the panel and is lost on reload; `stale` is the one member that is *derived*,
 * by `planRevision.ts`, from the server-authoritative revision.
 *
 * ── Labels ────────────────────────────────────────────────────────────────
 *
 * `MessageDescriptor`s (`msg` from `@lingui/core/macro`), like `matchEnums.ts`:
 * half these labels are accessible names or `title` strings and need a
 * `string`, which `<Trans>` cannot give. Read one with `useLingui().i18n._(…)`.
 *
 * Two vocabularies are tagged with a `context`, whole-table, because a word in
 * them is already published elsewhere with a different sense (§10.4 deviation
 * 3's rule: tag the whole vocabulary, never just the colliding member):
 *
 *   `agent-object`  「输出」 is a nav section (Outputs, plural) in `/delivery`;
 *                   here it is one object kind (Output, singular).
 *   `plan-change`   「已过期」 is 「Valve 不再保留这份 Demo」 on the history page;
 *                   here it is 「这条提议基于旧修订」, which is not an error at
 *                   all. 「待处理」 and 「删除」 collide the same way.
 *
 * Everything else is deliberately left untagged and shares the existing entry:
 * 「等待确认」 already means exactly this on a task card, and splitting it would
 * produce two entries free to drift apart (§10.5 deviation 4).
 */

import { msg } from '@lingui/core/macro';
import type { MessageDescriptor } from '@lingui/core';
import {
  Archive,
  Binoculars,
  Bot,
  Camera,
  CircleAlert,
  CircleCheck,
  CircleDashed,
  CircleX,
  Eye,
  FileVideo,
  Hourglass,
  Layers,
  ListPlus,
  Minus,
  MoveHorizontal,
  MoveVertical,
  Orbit,
  PencilLine,
  PersonStanding,
  Plane,
  Plus,
  Replace,
  RotateCcw,
  Route,
  Scissors,
  SquarePen,
  Trash2,
  User,
  Video,
  type LucideIcon,
} from 'lucide-react';

import type {
  AgentObjectKind,
  AgentPlanAuthor,
  AgentPlanShot,
  AgentPlanStatus,
  AgentSessionEntry,
  AgentSessionProposal,
  AgentShotView,
  WorkspaceEditOperation,
} from '../../shared/desktop/dto';

/** The one meta shape every table below shares. */
export interface AgentVocabularyMeta {
  readonly label: MessageDescriptor;
  readonly icon: LucideIcon;
}

/* ── shot kind ───────────────────────────────────────────────────────────── */

/**
 * How the camera moves. Taken from the wire (`AgentPlanShot['kind']`, i.e.
 * `RecordingRequest['camera_style']`) rather than from §4.5.2's five, for the
 * reason in the header — the recorder can execute seven and the plan can carry
 * any of them.
 */
export type AgentShotKind = AgentPlanShot['kind'];

/**
 * Reading order is the reference's: the five §4.5.2 names first, in the order
 * the 07 board's four shots introduce them, then the two the wire adds.
 */
export const AGENT_SHOT_KINDS: readonly AgentShotKind[] = [
  'static',
  'tracking',
  'pov',
  'crane',
  'flyby',
  'orbit',
  'dolly',
];

export interface AgentShotKindMeta extends AgentVocabularyMeta {
  /**
   * 「Static」/「Tracking」. The reference prints the Latin camera term on the
   * shot card and in the 镜头类型 dropdown, and camera vocabulary stays Latin in
   * both locales — the same decision `TEAM_SIDE.abbreviation` made for CT / T.
   * `label` is the readable gloss beside it, and is what an accessible name
   * uses.
   */
  readonly code: string;
}

export const AGENT_SHOT_KIND: Readonly<Record<AgentShotKind, AgentShotKindMeta>> = {
  static: { code: 'Static', label: msg`固定机位`, icon: Camera },
  tracking: { code: 'Tracking', label: msg`跟随`, icon: Route },
  pov: { code: 'POV', label: msg`选手视角`, icon: Eye },
  crane: { code: 'Crane', label: msg`升降`, icon: MoveVertical },
  flyby: { code: 'Flyby', label: msg`掠过`, icon: Plane },
  orbit: { code: 'Orbit', label: msg`环绕`, icon: Orbit },
  dolly: { code: 'Dolly', label: msg`推轨`, icon: MoveHorizontal },
};

/* ── shot view ───────────────────────────────────────────────────────────── */

/** Observer camera or the player's own eyes (`AgentPlanShot.view`). */
export const AGENT_SHOT_VIEWS: readonly AgentShotView[] = ['observer', 'player_pov'];

export const AGENT_SHOT_VIEW: Readonly<Record<AgentShotView, AgentVocabularyMeta>> = {
  observer: { label: msg`观察者`, icon: Binoculars },
  player_pov: { label: msg`选手 POV`, icon: PersonStanding },
};

/* ── who authored a shot ─────────────────────────────────────────────────── */

export const AGENT_PLAN_AUTHORS: readonly AgentPlanAuthor[] = ['agent', 'user'];

export interface AgentPlanAuthorMeta extends AgentVocabularyMeta {
  /** The 来源徽标 on a shot card: 「Agent」 / 「你改过」. */
  readonly sourceBadge: MessageDescriptor;
  /** The badge on a soft-removed shot: 「你删除的」, which stays undoable. */
  readonly removedBadge: MessageDescriptor;
}

/**
 * §4.5.3 rule ② lives in this table's wording as much as in the code: a shot
 * the user touched says 「你改过」, never 「待 Agent 批准」, because a manual edit
 * never needs approval and the Agent may not roll it back.
 */
export const AGENT_PLAN_AUTHOR: Readonly<Record<AgentPlanAuthor, AgentPlanAuthorMeta>> = {
  agent: {
    label: msg`Agent`,
    sourceBadge: msg`Agent`,
    removedBadge: msg`Agent 删除的`,
    icon: Bot,
  },
  user: {
    label: msg`你`,
    sourceBadge: msg`你改过`,
    removedBadge: msg`你删除的`,
    icon: User,
  },
};

/* ── plan status ─────────────────────────────────────────────────────────── */

export const AGENT_PLAN_STATUSES: readonly AgentPlanStatus[] = [
  'draft',
  'awaiting_confirmation',
  'confirmed',
  'archived',
];

/**
 * Untagged on purpose: 「等待确认」 already exists on a task card meaning the
 * same thing, and a plan waiting for its one explicit confirmation (§4.5.3 rule
 * ①) is that same state seen from the plan's side.
 */
export const AGENT_PLAN_STATUS: Readonly<Record<AgentPlanStatus, AgentVocabularyMeta>> = {
  draft: { label: msg`草案`, icon: SquarePen },
  awaiting_confirmation: { label: msg`等待确认`, icon: CircleAlert },
  confirmed: { label: msg`已确认`, icon: CircleCheck },
  archived: { label: msg`已归档`, icon: Archive },
};

/* ── referencable object kinds ───────────────────────────────────────────── */

export const AGENT_OBJECT_KINDS: readonly AgentObjectKind[] = [
  'plan',
  'recording_task',
  'edit_project',
  'output',
];

/**
 * §4.5.1's four object lifecycles. Whole-table `context: 'agent-object'` — see
 * the header for 「输出」.
 */
export const AGENT_OBJECT_KIND: Readonly<Record<AgentObjectKind, AgentVocabularyMeta>> = {
  plan: { label: msg({ message: '方案', context: 'agent-object' }), icon: Layers },
  recording_task: {
    label: msg({ message: '录制任务', context: 'agent-object' }),
    icon: Video,
  },
  edit_project: {
    label: msg({ message: '剪辑工程', context: 'agent-object' }),
    icon: Scissors,
  },
  output: { label: msg({ message: '输出', context: 'agent-object' }), icon: FileVideo },
};

/* ── session entry kinds ─────────────────────────────────────────────────── */

/** The discriminant of `AgentSessionEntry`. Two bubbles and one grey line. */
export type AgentEntryKind = AgentSessionEntry['kind'];

export const AGENT_ENTRY_KINDS: readonly AgentEntryKind[] = [
  'user',
  'assistant',
  'workspace_edit',
];

export interface AgentEntryKindMeta extends AgentVocabularyMeta {
  /**
   * Whether this entry is drawn as a chat bubble. `workspace_edit` is not:
   * 「不进入对话气泡流，默认渲染为一行系统灰字，可展开查看原文」. Encoded here
   * so the three page blocks cannot disagree about it.
   */
  readonly bubble: boolean;
}

export const AGENT_ENTRY_KIND: Readonly<Record<AgentEntryKind, AgentEntryKindMeta>> = {
  user: { label: msg`你`, icon: User, bubble: true },
  assistant: { label: msg`Agent`, icon: Bot, bubble: true },
  workspace_edit: { label: msg`编辑通知`, icon: PencilLine, bubble: false },
};

/* ── workspace-edit operations ───────────────────────────────────────────── */

/** What one line of a `WorkspaceEditNotice` did. */
export const WORKSPACE_EDIT_OPERATIONS: readonly WorkspaceEditOperation[] = [
  'updated',
  'removed',
  'inserted',
  'restored',
];

/** Same `plan-change` context as the proposal ops: 「删除」 collides with the
 *  ubiquitous delete *button*, and the whole vocabulary is tagged together. */
export const WORKSPACE_EDIT_OPERATION: Readonly<
  Record<WorkspaceEditOperation, AgentVocabularyMeta>
> = {
  updated: { label: msg({ message: '修改', context: 'plan-change' }), icon: PencilLine },
  removed: { label: msg({ message: '删除', context: 'plan-change' }), icon: Minus },
  inserted: { label: msg({ message: '新增', context: 'plan-change' }), icon: Plus },
  restored: { label: msg({ message: '还原', context: 'plan-change' }), icon: RotateCcw },
};

/* ── the change set (no wire type — see the header) ──────────────────────── */

/** §4.5.2's four ops, as the 2a board's change cards label them. */
export type PlanChangeOp = 'shorten' | 'delete' | 'replace' | 'insert';

export const PLAN_CHANGE_OPS: readonly PlanChangeOp[] = [
  'shorten',
  'delete',
  'replace',
  'insert',
];

export const PLAN_CHANGE_OP: Readonly<Record<PlanChangeOp, AgentVocabularyMeta>> = {
  shorten: { label: msg({ message: '缩短', context: 'plan-change' }), icon: Scissors },
  delete: { label: msg({ message: '删除', context: 'plan-change' }), icon: Trash2 },
  replace: { label: msg({ message: '替换', context: 'plan-change' }), icon: Replace },
  insert: { label: msg({ message: '插入', context: 'plan-change' }), icon: ListPlus },
};

/**
 * Where one change stands. `pending / accepted / rejected` are the user's
 * doing and live in the page; `stale` is derived from the plan revision by
 * `planRevision.ts` and is the only one nobody clicks.
 */
export type PlanChangeState = 'pending' | 'accepted' | 'rejected' | 'stale';

export const PLAN_CHANGE_STATES: readonly PlanChangeState[] = [
  'pending',
  'accepted',
  'rejected',
  'stale',
];

export const PLAN_CHANGE_STATE: Readonly<Record<PlanChangeState, AgentVocabularyMeta>> = {
  pending: { label: msg({ message: '待处理', context: 'plan-change' }), icon: CircleDashed },
  accepted: { label: msg({ message: '已接受', context: 'plan-change' }), icon: CircleCheck },
  rejected: { label: msg({ message: '已拒绝', context: 'plan-change' }), icon: CircleX },
  stale: { label: msg({ message: '已过期', context: 'plan-change' }), icon: Hourglass },
};

/**
 * One proposed edit to one shot.
 *
 * Every descriptive field is nullable because `payload` is `unknown` on the
 * wire and a proposal that omits one is legal. A card omits the line rather
 * than printing an empty row — the rule every phase-3 page report restates.
 */
export interface PlanChange {
  readonly id: string;
  readonly op: PlanChangeOp;
  /** `AgentPlanShot.id` this change targets. */
  readonly targetShotId: string;
  /** 「02 跟随突破 · 8.5s → 3.0s」's left half, as the proposal worded it. */
  readonly before: string | null;
  readonly after: string | null;
  /** Signed, in seconds — the card's 「−5.5s」. `null` when not supplied. */
  readonly deltaSeconds: number | null;
  readonly rationale: string | null;
  /** 「结尾会变硬，建议给 03 加 0.5 秒后留白」. Not an error. */
  readonly warning: string | null;
  readonly state: PlanChangeState;
}

/**
 * A proposal's changes, with the revision they were computed against.
 *
 * `basedOnRevision` is the whole of §4.5.3 rule ③ — see `planRevision.ts`.
 */
export interface PlanChangeSet {
  /** `AgentSessionProposal.kind`, free text on the wire. */
  readonly kind: string;
  readonly title: string;
  readonly planId: string;
  readonly basedOnRevision: number;
  readonly changes: readonly PlanChange[];
}

/**
 * Parses `AgentSessionProposal` into a change set, or returns `null`.
 *
 * `null` means 「这条提议不是方案变更，或者它的 payload 不是我们认识的形状」 —
 * the caller renders the proposal's title as an ordinary assistant proposal and
 * shows no change cards. It never means "empty change set": a proposal that
 * legitimately carries zero changes parses to `changes: []`.
 *
 * Deliberately tolerant per field and strict per record: a change without a
 * recognised `op` or without a target shot id is dropped (it cannot be drawn or
 * applied), while a change missing `rationale` or `delta_seconds` is kept with
 * those fields `null`. Both halves of that rule exist so a backend that starts
 * sending richer payloads improves the cards without a frontend change, and a
 * backend that sends something else does not produce a card whose 「接受」 would
 * do nothing.
 */
export function readPlanChangeSet(proposal: AgentSessionProposal): PlanChangeSet | null {
  if (proposal.plan_id === null || proposal.based_on_revision === null) return null;

  const payload = asRecord(proposal.payload);
  if (payload === null) return null;

  const rawChanges = payload['changes'];
  if (!Array.isArray(rawChanges)) return null;

  const changes: PlanChange[] = [];
  for (const [index, raw] of rawChanges.entries()) {
    const change = readPlanChange(raw, index);
    if (change !== null) changes.push(change);
  }

  return {
    kind: proposal.kind,
    title: proposal.title,
    planId: proposal.plan_id,
    basedOnRevision: proposal.based_on_revision,
    changes,
  };
}

function readPlanChange(raw: unknown, index: number): PlanChange | null {
  const record = asRecord(raw);
  if (record === null) return null;

  const op = record['op'];
  if (typeof op !== 'string' || !isPlanChangeOp(op)) return null;

  const target = record['target'];
  if (typeof target !== 'string' || target === '') return null;

  const id = record['id'];

  return {
    // A payload without ids still needs stable React keys; the index is stable
    // for a proposal that never changes after it is appended to the session.
    id: typeof id === 'string' && id !== '' ? id : `${op}-${target}-${String(index)}`,
    op,
    targetShotId: target,
    before: readText(record['before']),
    after: readText(record['after']),
    deltaSeconds: readFiniteNumber(record['delta_seconds']),
    rationale: readText(record['rationale']),
    warning: readText(record['warning']),
    // Everything arrives unhandled. `markStale` decides the rest.
    state: 'pending',
  };
}

export function isPlanChangeOp(value: string): value is PlanChangeOp {
  return (PLAN_CHANGE_OPS as readonly string[]).includes(value);
}

export function isPlanChangeState(value: string): value is PlanChangeState {
  return (PLAN_CHANGE_STATES as readonly string[]).includes(value);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function readText(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

function readFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
