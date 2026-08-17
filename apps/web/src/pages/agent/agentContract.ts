/*
 * pages/agent — the contract the three blocks of 「07 Agent 创作面板」 are built
 * against (spec §7 `/agent?plan=&session=&mode=`, §4.5, phase 3e).
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  READ THIS FIRST if you are filling in one of the three blocks
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `AgentPage` is the shell. It owns the address, the toolbar, the one edit
 * notifier and the one chat stream, and it renders three blocks that each get
 * the same `AgentBlockProps`:
 *
 *   A  对话流（主列）   the transcript, the composer, and the 2a/2b/2c switch
 *                       (`?mode=changes|inline|takes`)
 *   B  方案面板（右列）  the shot list, manual editing, the revision, the change
 *                       cards and their stale state
 *   C  会话抽屉 + 新建会话与引用 + 设置「AI 与 Agent」
 *
 * Replace the placeholder in `AgentPage.tsx` with your block's component and
 * put the component itself under `pages/agent/`. **Keep `AgentPage`'s named
 * export** — `src/routes.tsx` imports it and that seam is frozen.
 *
 * ── hook → block ──────────────────────────────────────────────────────────
 *
 *   data/sessions.ts
 *     useAgentSessionList          C  drawer list + search + 「共 14 条」
 *     useAgentSession              A  the transcript; C for the drawer's 当前
 *     useAgentObjectSessions       B  a plan's 「改动来源」 (§4.5.1 reverse index)
 *     useAgentWorkspaceReferences  C  新建会话's 「工作区里正在进行的」
 *     useAgentWorkspaceSettings    C  设置 › 会话 (retention, take limit)
 *     useAgentSessionStorage       C  「当前占用 38 MB · 14 条会话」
 *     useCreateAgentSession        C      useRenameAgentSession        C
 *     useDeleteAgentSession        C      useAppendAgentSessionEntry   A
 *     useTouchAgentObjectRef       C      useUpdateAgentWorkspaceSettings C
 *     useExportAgentSessions       C      useClearAgentSessions        C
 *     useApplyAgentSessionRetention C
 *     useAgentChatStream           — the shell holds it; read `props.chat`
 *
 *   data/plans.ts
 *     useAgentPlan                 B, and the shell's toolbar. Call it; do not
 *                                  ask the shell to pass the plan down. Two
 *                                  callers of one key is one request.
 *     useAgentPlanList             A/C  the plan switcher and 等待确认 rows
 *     useCreateAgentPlan           A    turning a proposal into a plan
 *     useApplyAgentPlanEdit        —  **only through `props.editNotifier`**
 *     useRestoreAgentPlanBaseline  B    「还原为 Agent 版本」
 *     isRevisionConflict           B    the 409 → 「基于修订 7 重算」 dialog
 *
 *   data/editNotifier.ts           the shell builds it; use `props.editNotifier`
 *   data/config.ts                 C    设置 › 模型 is `AppConfig.llm`
 *   data/serviceAction.ts          all  `props.service`, already derived once
 *
 *   domain/agent
 *     AGENT_SHOT_KIND / _VIEW / AGENT_PLAN_AUTHOR / AGENT_PLAN_STATUS /
 *     AGENT_OBJECT_KIND / AGENT_ENTRY_KIND / WORKSPACE_EDIT_OPERATION /
 *     PLAN_CHANGE_OP / PLAN_CHANGE_STATE     — labels and glyphs, never inline
 *     readPlanChangeSet                       — proposal payload → change cards
 *     markStale / PLAN_CHANGE_AFFORDANCE      — §4.5.3 rule ③, see invariant 3
 *
 *   pages/agent
 *     conversationModel.ts   A/B  the decision key, the map, and the one
 *                                 decisions-then-`markStale` composition
 *     planProposals.ts       B    「这个方案的提议」, the plan-side projection
 *     planChangeApply.ts     —  **only through `props.changes.accept`**
 *
 * ── the six invariants ────────────────────────────────────────────────────
 *
 * **1. Recording starts from exactly one explicit confirmation.** (§4.5.3 ①)
 * Accepting a change does not record. A manual edit does not record. Switching
 * sessions does not record. `data/plans.ts` and `data/sessions.ts` between them
 * expose no command that can execute anything, which is the first line of
 * defence; the second is that 「确认并生成视频」 lives on the shell toolbar and
 * nowhere else. The settings toggle 「录制前始终由你确认」 is drawn **on and
 * disabled** — 不可关闭 — and it is not backed by a stored field (gap 4).
 *
 * **2. A manual edit never needs Agent approval, and the Agent never rolls one
 * back.** (§4.5.3 ②) There is no approval state on an edit anywhere in this
 * contract, and the only restore in the product is `restoreAgentPlanBaseline`,
 * which a *user* triggers from 「还原为 Agent 版本」. A shot the user touched is
 * badged 「你改过」 (`AGENT_PLAN_AUTHOR.user.sourceBadge`), never 「待批准」.
 *
 * **3. The revision decides whether a proposal still holds.** (§4.5.3 ③) Call
 * `markStale(changeSet, plan.revision)` and read `PLAN_CHANGE_AFFORDANCE`. Do
 * not re-derive either: an expired card is 55% opaque, its 「接受」 is disabled
 * *with a reason*, its chip says 「已过期」, and **its body stays fully
 * readable** — 过期不等于错误. Already-accepted and already-rejected changes are
 * never re-marked.
 *
 * **4. The address is the only truth for `plan` / `session` / `mode`.** One
 * `updateContext(patch)` entry point, as §4.4 established for the match
 * workspace — there is no `onSelectPlan` / `onSelectSession` / `onSelectMode`
 * triple. Unlike the match workspace, **a patch clears nothing else**: a session
 * may touch many objects and an object may be touched by many sessions
 * (§4.5.1), and the
 * reference explicitly says 「新建一条会话不会丢掉上下文……它可以直接接管当前那
 * 个」. The session drawer's open state is component state, not a route: §7 says
 * 「会话抽屉是浮层，不是路由」.
 *
 * **5. There is exactly one edit notifier, and it belongs to the shell.** Its
 * flush occasions span all three blocks (the composer sends, the panel edits,
 * the drawer switches sessions), so a second instance would hold half a buffer
 * and write half a notice. Never call `useApplyAgentPlanEdit` from a block:
 * route every manual edit through `props.editNotifier.record(...)`. Seven of the
 * eight flush occasions are already wired — including 「发送消息前」, which the
 * shell performs inside `props.chat.send`, so the composer cannot forget it.
 * The one left to a caller is `flush('confirm-video')`, which belongs to
 * whoever ends up owning the confirm action.
 *
 * **6. There is exactly one accept, one decision map and one edit buffer, and
 * they belong to the shell.** Same reason as invariant 5, applied to the other
 * thing two blocks both touch: the Agent's change cards are drawn **twice** —
 * in block A's transcript and in block B's 本次变更 — and 「已接受」 is a
 * statement about the change, not about the column it was pressed in. Two
 * `useState` maps produced exactly that contradiction on one screen, and the
 * worse half of it was that block A's 接受 only coloured the card: it wrote a
 * decision and never touched the plan, so the user read 「已接受」 over a plan
 * that had not moved. So `props.changes` (`AgentChangeDesk`) carries the map,
 * the local shots and **one** `accept(key, change)` that applies the change,
 * records the edit and files the decision together. A block never holds a
 * decision of its own, never calls `applyPlanChange` itself, and never keeps a
 * second copy of the edited shots. 拒绝 stays what it always was — a decision
 * and nothing else, no shots touched. The key is `changeDecisionKey`
 * (`conversationModel.ts`), spelled once and identical in both projections.
 *
 * ── two contract facts that shape block B ─────────────────────────────────
 *
 * **An edit needs a session.** `AgentPlanEdit.origin` is not nullable, so a
 * plan edit must name the session it was made in. With no `?session=` the shell
 * hands you `props.edit.disabled` with a written reason; render the fields
 * read-only rather than letting an edit fail at flush time.
 *
 * **The plan on screen is ahead of the server between flushes.** The 5-second
 * merge window means the revision does not move — and proposals therefore do
 * not go stale — until the notifier writes. That is deliberate (see
 * `data/editNotifier.ts`); hold the edited shots locally and pass the whole
 * array on every `record`.
 *
 * ── backend gaps found while writing this contract ────────────────────────
 *
 * §4.6's ten gaps are closed — the routes exist, so **nothing here is an
 * adapter and nothing is kept in `localStorage`.** These are new, found by
 * reading `dto.ts` against the four artboards. None of them is worked around:
 *
 *  1. **An `AgentPlan` is not bound to a Demo, and an `AgentPlanShot` carries
 *     no `demo_id` / `player_id`.** So a confirmed plan cannot be turned into
 *     the `RecordingQueueRequest` that `planRecording` + `executeRecordingPlan`
 *     need. 「确认并生成视频」 is therefore rendered disabled with that reason.
 *     This is the one gap that blocks the page's main action.
 *  2. **No change-set type on the wire.** `AgentSessionProposal.payload` is
 *     `unknown`; `domain/agent/types.ts` parses it and returns `null` when it
 *     does not match, so an unrecognised proposal shows its title and no cards.
 *  3. **No accept / reject state anywhere.** Which changes were handled lives in
 *     the panel and is lost on reload. Accepting is expressed as an ordinary
 *     `applyAgentPlanEdit`, which means the wire cannot tell 「我接受了 Agent 的
 *     建议」 from 「我自己改的」 either — `WorkspaceEditNotice.by` is `'user'` and
 *     nothing else.
 *  4. **`AgentWorkspaceSettings` has only `session_retention` and
 *     `take_limit`.** The 行为边界 block's other four controls (应用剪辑变更前先
 *     预览 / 显示 Agent 读取了哪些证据 / 默认成片时长 / 点评语气) have nowhere to
 *     be stored, and 录制前始终由你确认 is a constant rather than a field.
 *  5. **The streaming Agent and the session store are two stores.**
 *     `agent_chat` writes `AgentThread`; `/api/agent/sessions` is separate, and
 *     `AgentChatInput` has `threadId`, not `sessionId`. `useAgentChatStream`
 *     bridges them by appending both entries itself. A consequence: a stream
 *     that is interrupted between the user entry and the assistant entry leaves
 *     a question with no answer in the transcript.
 *  6. **The streaming `AgentProposal` carries no `plan_id` / `based_on_revision`.**
 *     Its `kind` is `CapturedPlanKind` — a real enum since the gap-closing
 *     round, and still with no plan-change member. So the revision a proposal
 *     is based on is stamped by the client from what it read when the user
 *     pressed send. That is the only place the number exists, and it is why
 *     §4.5.3 ③ works at all here.
 *  7. **`AgentSessionEntry` has no per-entry token / cost / model.** The
 *     工作进度 block of artboard 07 (读取比赛结构 · 筛选候选片段 · 读取空间证据 ·
 *     设计镜头) can only be rebuilt from `tool_calls`, whose `input` / `output`
 *     are `unknown`.
 *  8. **No take model.** §4.5.2's `Take` / `Composition` (the 2c board's three
 *     takes and the composed result) have no wire type and no route, and
 *     `AgentWorkspaceSettings.take_limit` counts something the API cannot list.
 *     `?mode=takes` therefore has no data behind it this round.
 *  9. **`AgentObjectRef.status` and `AgentWorkspaceReference.status` are free
 *     text**, so a status cannot be mapped to `StatusDot`'s closed set without
 *     guessing. Print the server's own words.
 * 10. **No 「预览这条」.** Nothing renders a shot or a change to a frame; the 2a
 *     board's per-change preview and the 2b board's 换一个镜头 previews have no
 *     command behind them (same root as §10.3 gap 8 — no playable URL under
 *     Tauri's `default-src 'self'`).
 *
 * ── house rules that apply to every block ─────────────────────────────────
 *
 * Three states, always: `Skeleton` while loading (**never an invented
 * percentage**), `Empty` with a real recovery action when empty, an
 * in-place `Notice` with a retry when failed. A field the backend does not have
 * is omitted, never rendered as `0` or an empty row. Service-backed actions use
 * `props.service` (disabled + reason + 「· 需要服务」). §8 folding uses
 * `props.collapsed`, never a media query of your own. And the layer lint will
 * stop you: no `app/**` import, no bare hex (comments included), no font size or
 * colour in an arbitrary value, no direct `shared/desktop/client`. Run
 * `node scripts/check-web-layers.mjs`.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Pure below this line, so `agentContract.test.ts` covers the address in the
 * `unit` project with no DOM and no router.
 */

import { msg } from '@lingui/core/macro';
import type { MessageDescriptor } from '@lingui/core';
import type { ComponentType } from 'react';

import type { EditNotifierHandle } from '../../data/editNotifier';
import type { AgentChatStream } from '../../data/sessions';
import type { ServiceActionState } from '../../data/serviceAction';
import type { PlanChange } from '../../domain/agent';
import type { AgentPlanShot } from '../../shared/desktop/dto';
import { pickQueryValue } from '../routeQuery';
/* Types only, and therefore erased: this module stays free of anything a `unit`
   test would need a DOM for, which is what `agentContract.test.ts` relies on. */
import type { ChangeDecision, ChangeDecisions } from './conversationModel';
import type { ShotEditResult } from './planEditModel';

/* ── the three shapes of the conversation (§7, 「Agent 形态 · 第二轮」) ────── */

/**
 * `changes` is the 2a board (变更优先 · 方案编辑器), `inline` the 2b board
 * (就地对话 · 意图落到参数), `takes` the 2c board (分支比较 · 三条 Take).
 */
export type AgentMode = 'changes' | 'inline' | 'takes';

export const AGENT_MODES: readonly AgentMode[] = ['changes', 'inline', 'takes'];

/** §7's default face of the page. */
export const DEFAULT_AGENT_MODE: AgentMode = 'changes';

export interface AgentModeMeta {
  readonly label: MessageDescriptor;
  /** The one line under the switch that says what this shape is for. */
  readonly hint: MessageDescriptor;
}

/**
 * Whole-table `context: 'agent-mode'`: 「变更列表」 and 「候选镜头」 are this
 * page's own words for its own shapes, and tagging the table together keeps a
 * later collision from splitting only the member that collided.
 */
export const AGENT_MODE: Readonly<Record<AgentMode, AgentModeMeta>> = {
  changes: {
    label: msg({ message: '变更列表', context: 'agent-mode' }),
    hint: msg({ message: '每次回应都是一次可逐条接受或拒绝的变更', context: 'agent-mode' }),
  },
  inline: {
    label: msg({ message: '就地编辑', context: 'agent-mode' }),
    hint: msg({ message: '对话附着在选中的镜头上，意图同时给出参数', context: 'agent-mode' }),
  },
  takes: {
    label: msg({ message: '候选镜头', context: 'agent-mode' }),
    hint: msg({ message: '每次改动生成一条 take，并排比较后再合成', context: 'agent-mode' }),
  },
};

/* ── the address (§4.4's rule, §7's three parameters) ────────────────────── */

/** The query-string names, spelled once. §7 fixes all three. */
export const AGENT_PARAM = {
  plan: 'plan',
  session: 'session',
  mode: 'mode',
} as const;

/**
 * Everything `/agent` knows about what the user is looking at.
 *
 * `null` means 「没有选中」 and is a normal state — the page opens this way, and
 * it is never a stand-in for 「加载中」.
 */
export interface AgentRouteContext {
  /** `AgentPlan.id`. The toolbar's subject: §7, 「顶栏主体是方案」. */
  readonly plan: string | null;
  /** `AgentSession.id`. Selects a session; it does not open the drawer. */
  readonly session: string | null;
  readonly mode: AgentMode;
}

/**
 * A change to the context. An omitted field is unchanged; an explicit `null`
 * clears it. Two different requests, which is why this is not a `Partial` with
 * `undefined` doing double duty.
 */
export interface AgentContextPatch {
  readonly plan?: string | null | undefined;
  readonly session?: string | null | undefined;
  readonly mode?: AgentMode | undefined;
}

export interface AgentContextUpdateOptions {
  /** Replace the history entry instead of pushing one. */
  readonly replace?: boolean | undefined;
}

export function readAgentContext(params: URLSearchParams): AgentRouteContext {
  return {
    plan: readIdentifier(params.get(AGENT_PARAM.plan)),
    session: readIdentifier(params.get(AGENT_PARAM.session)),
    mode: pickQueryValue(params.get(AGENT_PARAM.mode), AGENT_MODES, DEFAULT_AGENT_MODE),
  };
}

/**
 * The context as a query string. Absent selections are omitted rather than
 * written empty; `mode` is always written, including the default, because the
 * address bar is what users copy and a link that omits the mode depends
 * silently on the default never changing (`workspaceContext.ts` made the same
 * call for `view`).
 */
export function writeAgentContext(context: AgentRouteContext): URLSearchParams {
  const params = new URLSearchParams();
  if (context.plan !== null) params.set(AGENT_PARAM.plan, context.plan);
  if (context.session !== null) params.set(AGENT_PARAM.session, context.session);
  params.set(AGENT_PARAM.mode, context.mode);
  return params;
}

/**
 * Applies a patch. **It clears nothing** — see invariant 4. A session and a
 * plan are two independent lifecycles (§4.5.1), so switching one keeps the
 * other; that is what makes 「新建会话直接接管当前方案」 a navigation rather than
 * a re-generation.
 */
export function patchAgentContext(
  context: AgentRouteContext,
  patch: AgentContextPatch,
): AgentRouteContext {
  return {
    plan: patch.plan === undefined ? context.plan : patch.plan,
    session: patch.session === undefined ? context.session : patch.session,
    mode: patch.mode ?? context.mode,
  };
}

/** A shareable address — what a plan card, a session row and 「打开」 all need. */
export function agentHref(context: AgentRouteContext): string {
  return `/agent?${writeAgentContext(context).toString()}`;
}

function readIdentifier(raw: string | null): string | null {
  if (raw === null) return null;
  const trimmed = raw.trim();
  return trimmed === '' ? null : trimmed;
}

/* ── what every block receives ───────────────────────────────────────────── */

/**
 * An action that has a reason when it cannot be taken — the pair `Button`
 * already understands, so a block spreads it rather than writing its own
 * sentence. Same shape `MatchVideoAction` established in phase 3c.
 */
export interface AgentGuardedAction {
  readonly disabled: boolean;
  readonly disabledReason?: string;
}

/**
 * The one accept/reject record and the one uncommitted plan, held by the shell.
 * See invariant 6 — the short version is that the Agent's change cards are drawn
 * in two columns at once, and 「已接受」 is a fact about the change rather than
 * about the column.
 */
export interface AgentChangeDesk {
  /** Keyed by `changeDecisionKey(proposal.key, change.id)`. Never written to
   *  storage: gap 3 — the wire has nowhere to keep this. */
  readonly decisions: ChangeDecisions;
  /**
   * Files one decision, or clears it with `null`. **Writes no shots** — 拒绝 is
   * a judgement and §4.5.3 ② is not in play. Accepting goes through `accept`,
   * which cannot forget the plan half.
   */
  readonly decide: (key: string, decision: ChangeDecision | null) => void;
  /**
   * 接受, whole: `applyPlanChange` onto the shots on screen, `record` of the
   * resulting edit, and the decision — in that order, in one call, so a caller
   * cannot do the second thing without the first. A change that cannot be
   * carried out (`changeApplicability`) is left undecided rather than marked
   * accepted over a plan nothing happened to; blocks disable 接受 with that
   * reason rather than relying on this.
   */
  readonly accept: (key: string, change: PlanChange) => void;
  /**
   * The plan as edited but **not yet written** — §4.5.4's merge window means the
   * screen is ahead of the server for up to five seconds. `null` while nothing
   * has been edited since the plan was loaded, so a block reads
   * `props.changes.shots ?? plan.shots`. It is dropped by the shell the moment
   * the plan id changes: 一个 buffer 不跨对象.
   */
  readonly shots: readonly AgentPlanShot[] | null;
  /**
   * The one way an edit leaves a block: onto the screen, then into
   * `props.editNotifier`. Never `useApplyAgentPlanEdit` (invariant 5), never
   * anything that could record (§4.5.3 ①).
   */
  readonly record: (result: ShotEditResult, note?: string) => void;
  /** Drops the buffer — for a restore, which replaces the whole array. */
  readonly reset: () => void;
}

/**
 * The props of all three blocks. Deliberately small; what is *not* here is as
 * considered as what is:
 *
 *   *No plan and no session document.* Blocks call `useAgentPlan` /
 *   `useAgentSession` themselves. TanStack deduplicates by key, while threading
 *   the documents through props would re-render all three blocks on every
 *   refetch and force the shell to know which block needs which half.
 *
 *   *No `onSelectPlan` / `onSelectSession` / `onSelectMode`.* One
 *   `updateContext`, for the reason §4.4 gives.
 *
 *   *No drawer-open flag.* §7: the drawer is an overlay, not a route, so its
 *   open state belongs to block C alone.
 */
export interface AgentBlockProps {
  readonly context: AgentRouteContext;
  readonly updateContext: (
    patch: AgentContextPatch,
    options?: AgentContextUpdateOptions,
  ) => void;
  /** The one instance. See invariant 5. */
  readonly editNotifier: EditNotifierHandle;
  /** The one decision map, the one edit buffer, the one 接受. See invariant 6. */
  readonly changes: AgentChangeDesk;
  /** The one in-flight reply. Held by the shell so the composer, the transcript
   *  and the confirm button agree about whether the Agent is speaking. */
  readonly chat: AgentChatStream;
  /** 「不隐藏、不静默失败」, derived once for the page. */
  readonly service: ServiceActionState;
  /** Whether manual plan editing is possible right now, and why not. */
  readonly edit: AgentGuardedAction;
  /** 「确认并生成视频」's state, so the blocks and the toolbar say one sentence. */
  readonly confirm: AgentGuardedAction;
  /** The §8 observation, made once by the shell. */
  readonly collapsed: boolean;
}

export type AgentBlock = ComponentType<AgentBlockProps>;
