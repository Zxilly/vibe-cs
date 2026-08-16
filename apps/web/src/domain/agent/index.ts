/*
 * Domain layer — agent/ barrel (spec §2 `domain/agent/`, §4.5).
 *
 * Two modules and no components. The Agent workspace's pieces — the change
 * card, the shot card, the session row — are page-level in phase 3e because
 * each of them owns a mutation and a selection; what is shared and stable is
 * the vocabulary and the revision rule, and that is what lives here.
 *
 *   types.ts         the closed vocabularies (shot kind / view / author / plan
 *                    status / object kind / entry kind / workspace-edit op /
 *                    change op / change state), one total `Record` per union,
 *                    plus the change-set model the wire types as `unknown`
 *   planRevision.ts  §4.5.3 rule ③: `markStale`, and the one description of
 *                    what an expired card looks like
 *
 * The session, plan, shot and notice **types themselves come from
 * `shared/desktop/dto`** and are not re-exported here — see `types.ts`'s header
 * for why this directory does the opposite of `domain/match`.
 */

export {
  AGENT_ENTRY_KIND,
  AGENT_ENTRY_KINDS,
  AGENT_OBJECT_KIND,
  AGENT_OBJECT_KINDS,
  AGENT_PLAN_AUTHOR,
  AGENT_PLAN_AUTHORS,
  AGENT_PLAN_STATUS,
  AGENT_PLAN_STATUSES,
  AGENT_SHOT_KIND,
  AGENT_SHOT_KINDS,
  AGENT_SHOT_VIEW,
  AGENT_SHOT_VIEWS,
  PLAN_CHANGE_OP,
  PLAN_CHANGE_OPS,
  PLAN_CHANGE_STATE,
  PLAN_CHANGE_STATES,
  WORKSPACE_EDIT_OPERATION,
  WORKSPACE_EDIT_OPERATIONS,
  asAgentObjectKind,
  isPlanChangeOp,
  isPlanChangeState,
  knownWorkspaceReferences,
  readPlanChangeSet,
  type AgentEntryKind,
  type AgentEntryKindMeta,
  type AgentPlanAuthorMeta,
  type AgentShotKind,
  type AgentShotKindMeta,
  type AgentVocabularyMeta,
  type KnownWorkspaceReference,
  type PlanChange,
  type PlanChangeOp,
  type PlanChangeSet,
  type PlanChangeState,
} from './types';

export {
  PLAN_CHANGE_AFFORDANCE,
  STALE_OPACITY_CLASS,
  STALE_OPACITY_PERCENT,
  changeSetIsStale,
  markChangeStale,
  markStale,
  pendingChangeCount,
  planChangeAffordance,
  type PlanChangeAffordance,
} from './planRevision';

/*
 * ── Phase 3e, second pass: the presentation pieces ─────────────────────────
 *
 * The note above said this directory held no components, on the grounds that a
 * change card and a shot card each own a mutation. Reading the four Agent
 * artboards against each other overturned that: the same shot card is on 07, on
 * 2b, on 2c and on 手动编辑; the same proportional strip is on all five; the
 * same session row is in the drawer and in the plan's 改动来源. What each of
 * them owns is a *callback*, not a mutation — so they are presentation, they
 * are shared, and a second copy of any of them is a place for the two to drift.
 *
 * Every component below takes everything through props: no query, no router, no
 * business state (§2.1 rule 6). Local state exists in exactly one of them, for
 * one disclosure toggle, and `MatchContextBar` set that precedent.
 *
 *   AgentTranscript      the log: bubbles, edit lines, the streaming reply, and
 *                        the scroll container they need
 *   AgentBubble          user / assistant — the two kinds that *are* bubbles
 *   WorkspaceEditLine    the third kind, which is not: one grey line, expandable
 *                        to the typed notice (§4.5.2)
 *   AgentWorkTrail       工作进度, and an assistant's tool calls
 *   AgentProposalCard    a proposal's frame — title, kind, revision, 已过期
 *   PlanChangeCard       one change, in all four states (§4.5.3 ③)
 *   PlanShotRow          one shot, at the two densities the artboards draw
 *   PlanStrip            the proportional band of shots
 *   AgentObjectRefChip   「方案 #P-118 · 改过 2 次」
 *   AgentReferenceRow    「工作区里正在进行的」 + 引用
 *   AgentSessionRow      one row of the 会话抽屉
 *   TakeCard             one column of 2c, and CompositionRow one slot of its
 *                        合成结果 — both entirely prop-fed, because §4.5.2's
 *                        Take / Composition have no wire type at all
 *
 * and four pure modules, tested in the `unit` project:
 *
 *   planStripLayout.ts  the band's widths, the plan's length, the ruler's marks
 *   shotFormat.ts  「3.0s」「−5.5s」「00:42」, and the tick reading re-exported
 *                  from `domain/match` rather than copied
 *   editNotice.ts  the JSON behind 「查看发给 Agent 的内容」
 *   agentClock.ts  「09:02」/「昨天」/「08-13」
 *   workSteps.ts   the one vocabulary that is presentation-only, kept out of
 *                  `types.ts` because that file is 「wire 没有携带的闭集」
 */

export {
  AgentBubble,
  type AgentAssistantEntry,
  type AgentBubbleProps,
  type AgentInlineAction,
  type AgentUserEntry,
  type AgentWorkspaceEditEntry,
} from './AgentBubble';
export { AgentObjectRefChip, type AgentObjectRefChipProps } from './AgentObjectRefChip';
export { AgentProposalCard, type AgentProposalCardProps } from './AgentProposalCard';
export { AgentReferenceRow, type AgentReferenceRowProps } from './AgentReferenceRow';
export { AgentSessionRow, type AgentSessionRowProps } from './AgentSessionRow';
export { AgentTranscript, type AgentEntryExtras, type AgentTranscriptProps } from './AgentTranscript';
export { AgentWorkTrail, type AgentWorkStep, type AgentWorkTrailProps } from './AgentWorkTrail';
export { CompositionRow, type CompositionRowProps } from './CompositionRow';
export { PlanChangeCard, type PlanChangeCardProps } from './PlanChangeCard';
export { PlanShotRow, PlanShotRowSkeleton, type PlanShotDensity, type PlanShotRowProps } from './PlanShotRow';
export { PlanStrip, type PlanStripHeight, type PlanStripProps } from './PlanStrip';
export { TakeCard, type TakeCardProps, type TakeMetric, type TakeShotPick } from './TakeCard';
export { WorkspaceEditLine, type WorkspaceEditLineProps } from './WorkspaceEditLine';

export {
  formatAgentTime,
  readSessionStamp,
  type AgentClockOptions,
  type SessionStamp,
} from './agentClock';
export {
  formatWorkspaceEditNotice,
  workspaceEditChangeCount,
  workspaceEditObjectLabel,
} from './editNotice';
export {
  planDuration,
  planShotCount,
  planStripSegments,
  stripRulerMarks,
  type PlanStripOptions,
  type PlanStripSegment,
  type PlanStripTone,
} from './planStripLayout';
export {
  formatShotDuration,
  formatSignedSeconds,
  formatStripTimecode,
  formatTickCount,
  formatTickRange,
} from './shotFormat';
export {
  AGENT_WORK_STEP_STATE,
  AGENT_WORK_STEP_STATES,
  type AgentWorkStepState,
  type AgentWorkStepStateMeta,
} from './workSteps';
