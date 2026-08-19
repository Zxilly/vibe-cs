/*
 * pages/ — 07 Agent 创作面板 (spec §7 `/agent?plan=&session=&mode=`, phase 3e).
 *
 * The shell, and only the shell. The three blocks it renders are documented in
 * `pages/agent/agentContract.ts`, which is where a block owner starts; this
 * file explains what the shell keeps for itself and why.
 *
 * ── The address ───────────────────────────────────────────────────────────
 *
 * §7 fixes three parameters and its own note fixes their roles: 「顶栏主体是
 * 『方案』，会话切换器在左列顶部（设计稿第五轮连带修订）；会话抽屉是浮层，不是
 * 路由」. So the toolbar's subject is the plan, `?session=` *selects* a session
 * without opening anything, and the drawer's visibility never reaches the URL.
 * Reading and writing all three lives here, behind one `updateContext`.
 *
 * ── The three things the shell owns because they cannot be owned twice ────
 *
 * `useEditNotifier` — §4.5.4's merge window has flush occasions in every block
 * (the composer sends, the panel edits, the drawer switches sessions). Three
 * instances would each hold part of the buffer and write part of the notice.
 *
 * `useAgentChatStream` — one in-flight reply. The transcript renders it, the
 * composer disables on it and the confirm action waits for it; a second stream
 * would let two of those three disagree about whether the Agent is speaking.
 *
 * `AgentChangeDesk` — the accept/reject map, the shots edited but not yet
 * written, and the one 接受. The Agent's change cards are drawn in two columns
 * at once (block A's transcript and block B's 本次变更), so a decision held by a
 * block is a decision the other column cannot read: 已接受 on one side of the
 * screen and 待处理 on the other. Accepting also *edits the plan* — it is
 * `applyPlanChange` plus an `editNotifier.record` — which is exactly the half a
 * per-block handler forgot, leaving 「已接受」 written over a plan nothing had
 * happened to. Both halves are `changeDesk` below, and neither block can do one
 * without the other. See invariant 6 in `pages/agent/agentContract.ts`.
 *
 * ── Why the shell also reads the plan and the session ─────────────────────
 *
 * The toolbar prints 「4 个镜头 · 修订 7 · 等待确认」 and the notifier's commit
 * needs `AgentPlanEdit.origin`, which carries the session's *title*. Both are
 * the same `useAgentPlan` / `useAgentSession` calls the blocks make, deduped by
 * query key — the arrangement `MatchWorkspacePage` and the nine match views
 * already use for `useMatchAnalysis`.
 *
 * ── 「确认并生成视频」 goes to `/recording/<planId>`, and does not record ────
 *
 * §8 forbids the main action from ever folding into an overflow menu, so it is
 * on the toolbar at every width. Until phase 3f-be it was also permanently
 * disabled: an `AgentPlanShot` carried no Demo or player, so there was nothing
 * to build a recording queue from. `AgentPlanShot.recording` closed that (§10.6
 * gap 1 → §10.7), so the button now navigates, and `confirmGuard` refuses only
 * for the two reasons the server would — every shot removed, or some shot still
 * unbound — said before the round trip rather than after it.
 *
 * §4.5.3 rule ① is unchanged and is the reason this navigates rather than
 * starts: recording begins at exactly one 开始录制, on 「08」, under the check
 * list. This button hands over a plan; it does not queue a job.
 */

import { t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { useLingui } from '@lingui/react';
import { useCallback, useRef, useState, type ReactNode } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';

import { useEditNotifier, type PendingPlanEdit } from '../data/editNotifier';
import { dataErrorMessage } from '../data/errors';
import { isRevisionConflict, useAgentPlan, useApplyAgentPlanEdit } from '../data/plans';
import { useServiceAction, type ServiceActionState } from '../data/serviceAction';
import { useAgentChatStream, useAgentSession, type AgentChatStream } from '../data/sessions';
import { Alert } from '../design/feedback';
import { Page, SplitPane, Toolbar, useCollapsed } from '../design/layout';
import { Button } from '../design/primitives';
import { AGENT_PLAN_STATUS } from '../domain/agent';
import type { AgentPlan, AgentPlanShot } from '../shared/desktop/dto';
import {
  AGENT_MODE,
  patchAgentContext,
  readAgentContext,
  writeAgentContext,
  type AgentBlockProps,
  type AgentContextPatch,
  type AgentContextUpdateOptions,
  type AgentGuardedAction,
} from './agent/agentContract';
import { AgentConversationBlock } from './agent/AgentConversationBlock';
import { AgentSessionsBlock, agentSessionsToolbarAction } from './agent/AgentSessionsBlock';
import { useAgentChangeDesk } from './agent/changeDesk';
import { PlanPanel } from './agent/PlanPanel';
import {
  agentPlanHasRecordableShot,
  agentPlanShotsNeedingBinding,
  recordingHref,
} from './recording/recordingContract';

export interface AgentWorkspaceProps {
  readonly embedded?: boolean | undefined;
  /** `undefined` follows the query (new project); a string pins an existing project plan. */
  readonly planId?: string | null | undefined;
  readonly recordingTarget?: string | undefined;
}

export function AgentPage() {
  return <AgentWorkspace />;
}

export function AgentWorkspace({ embedded = false, planId, recordingTarget }: AgentWorkspaceProps) {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const { i18n } = useLingui();
  const collapsed = useCollapsed(undefined);
  const service = useServiceAction();

  const routeContext = readAgentContext(params);
  const context = planId === undefined ? routeContext : { ...routeContext, plan: planId };

  const plan = useAgentPlan(context.plan);
  const session = useAgentSession(context.session);
  const applyEdit = useApplyAgentPlanEdit();

  const updateContext = useCallback(
    (patch: AgentContextPatch, options?: AgentContextUpdateOptions) => {
      const patched = patchAgentContext(context, patch);
      const fixed = planId === undefined ? patched : { ...patched, plan: planId };
      const next = writeAgentContext(fixed);
      const step = params.get('step');
      if (step !== null) next.set('step', step);
      /* An embedded fixed-plan workspace gets its plan identity from the path,
         so repeating it in the query creates two sources of truth. */
      if (planId !== undefined) next.delete('plan');
      setParams(next, {
        replace: options?.replace === true,
      });
    },
    [context, params, planId, setParams],
  );

  const planData = plan.data;
  const sessionData = session.data;

  const chatStream = useAgentChatStream({
    sessionId: context.session,
    // The revision the model is answering about — the only place §4.5.3 ③'s
    // `based_on_revision` can come from (contract gap 6).
    plan: planData === undefined ? null : { id: planData.id, revision: planData.revision },
  });

  /*
   * The last plan and the last session that were actually loaded.
   *
   * Two of §4.5.4's occasions — `switch-session` and `switch-plan` — flush
   * *after* the address moved, at which point the query for the new selection
   * is still pending and `plan.data` / `session.data` are `undefined`. Reading
   * those directly would throw and, since a failed commit is handed to
   * `onError` rather than re-queued, would lose the notice on exactly the two
   * occasions §4.5.4 added to stop it being lost.
   *
   * Keeping the last loaded pair is not a fallback but the correct reading:
   * 「通知属于它被做出的那条会话」 — the origin row must name the session the
   * edit was made in, which is the one being left, not the one being opened.
   */
  const lastPlanRef = useRef(planData);
  if (planData !== undefined) lastPlanRef.current = planData;
  const lastSessionRef = useRef(sessionData);
  if (sessionData !== undefined) lastSessionRef.current = sessionData;

  /*
   * The commit half of §4.5.4. Written here, once, because this is the only
   * place that holds everything `AgentPlanEdit` needs beyond the merged
   * changes: the conditional `expected_revision`, the plan's status, and the
   * origin row's session id *and* title.
   */
  const commitEdit = useCallback(
    async (pending: PendingPlanEdit) => {
      const plan = lastPlanRef.current;
      const session = lastSessionRef.current;

      // A plan that is not the one the buffer names would contribute someone
      // else's `expected_revision`; refusing is the only safe answer, and
      // throwing rather than silently dropping keeps a mis-wired block loud.
      if (plan === undefined || plan.id !== pending.planId || session === undefined) {
        throw new Error('a plan edit needs the plan it was made on and a session');
      }

      await applyEdit.mutateAsync({
        plan_id: pending.planId,
        expected_revision: plan.revision,
        status: plan.status,
        shots: [...pending.shots],
        origin: {
          session_id: session.id,
          session_title: session.title,
          summary: editSummary(pending),
        },
        changes: [...pending.changes],
        note: pending.note,
      });
    },
    [applyEdit],
  );

  /*
   * The flush that failed, kept on screen until the user acts on it.
   *
   * `createEditNotifier` hands a failed commit to `onError` and **does not
   * re-queue it** — a 409 replayed with the same `expected_revision` would loop
   * forever. So the buffer is gone, the shots are still on screen as though
   * they had been written, and without this the whole thing would be silent:
   * 「不隐藏、不静默失败」 applies hardest to the write nobody asked for.
   */
  const [editFailure, setEditFailure] = useState<{ readonly error: unknown } | null>(null);

  const editNotifier = useEditNotifier({
    sessionId: context.session,
    planId: context.plan,
    commit: commitEdit,
    onError: (error) => {
      setEditFailure({ error });
    },
  });

  /*
   * §4.5.3's decisions, §4.5.4's buffer and the one 接受 — held once, for the
   * page. See the header and invariant 6. The implementation is a hook rather
   * than state written out here so that a block test can mount the *real* desk
   * around the block it is testing.
   */
  const changeDesk = useAgentChangeDesk({
    planId: planData?.id ?? null,
    shots: planData?.shots ?? EMPTY_SHOTS,
    editNotifier,
  });

  /*
   * 「用户发送消息前」 is one of §4.5.4's forced flush occasions, and it is the
   * one the composer would have to remember. The shell wires it instead: the
   * merged notice reaches the session *before* the question that depends on it,
   * so the model never answers about a plan it has not been told about.
   */
  const chat: AgentChatStream = {
    ...chatStream,
    send: async (input) => {
      await editNotifier.flush('send-message');
      await chatStream.send(input);
    },
  };

  const edit = editGuard({
    hasPlan: context.plan !== null,
    hasSession: context.session !== null,
    service,
  });

  const confirm = confirmGuard({ plan: planData ?? null, service });

  const blockProps: AgentBlockProps = {
    context,
    updateContext,
    editNotifier,
    changes: changeDesk,
    chat,
    service,
    edit,
    confirm,
    collapsed,
  };

  const planError = dataErrorMessage(plan.error);
  const modeLabel = i18n._(AGENT_MODE[context.mode].label);

  /* Block C's overlay. §7: 「会话抽屉是浮层，不是路由」, so the open state is
     component state here rather than a fourth query parameter — but it belongs
     to the shell rather than to the block, because a `ToolbarAction`'s control
     is not rendered once §8 folds it into 「更多」, and a drawer parked inside
     that control would unmount as the window narrowed. */
  const [sessionsOpen, setSessionsOpen] = useState(false);

  return (
    <AgentFrame
      embedded={embedded}
      toolbar={
        <Toolbar
          height={embedded ? 'bar' : 'topbar'}
          title={planData === undefined ? <Trans>Agent 创作</Trans> : planData.title}
          meta={
            <>
              {planData === undefined ? (
                <Trans>尚未选择剪辑单</Trans>
              ) : (
                <Trans>
                  {planData.shots.length} 个镜头 · 修订 {planData.revision} ·{' '}
                  {i18n._(AGENT_PLAN_STATUS[planData.status].label)}
                </Trans>
              )}
              {' · '}
              {modeLabel}
            </>
          }
          actions={[
            agentSessionsToolbarAction(() => {
              setSessionsOpen(true);
            }),
          ]}
          primary={
            /* The eighth flush occasion, and the last one left to a caller:
               「确认并生成视频」 must plan the recording from what the user last
               saw, so the merge window is written out **before** the address
               changes. `/recording/<planId>` mints its lease from the stored
               plan, so a buffered edit that had not been committed yet would be
               recorded as though it never happened. Awaited, therefore, not
               fired alongside.

               It is wired here rather than in a block because this is the one
               button §8 keeps on the toolbar at every width. */
            <Button
              variant="primary"
              {...confirm}
              onClick={() => {
                if (planData === undefined) return;
                void (async () => {
                  await editNotifier.flush('confirm-video');
                  await navigate(recordingTarget ?? recordingHref(planData.id));
                })();
              }}
            >
              {embedded ? <Trans>送去录制</Trans> : <Trans>确认并生成视频</Trans>}
            </Button>
          }
        />
      }
    >
      {planError === null ? null : (
        <Alert
          className="mx-7 mt-5"
          variant="danger"
          action={{ label: <Trans>重试</Trans>, onAction: () => void plan.refetch() }}
        >
          <Trans>读不到这个方案：{planError}</Trans>
        </Alert>
      )}
      {editFailure === null ? null : (
        <EditFailureNotice
          error={editFailure.error}
          revision={planData?.revision ?? null}
          recomputeDisabled={context.session === null || chat.streaming || service.blocked}
          onRecompute={(revision) => {
            setEditFailure(null);
            void plan.refetch();
            void chat.send({
              message: t`方案已经是第 ${String(revision)} 版了，请基于最新的镜头重新给出变更。`,
            });
          }}
          onReread={() => {
            setEditFailure(null);
            /* The buffer is what the failed write was made of; keeping it after
               a re-read would put the plan back out of step with the server the
               moment the query lands. Dropping it is what 「重新读取方案」 says
               on the button. */
            changeDesk.reset();
            void plan.refetch();
          }}
          onDismiss={() => {
            setEditFailure(null);
          }}
        />
      )}
      <SplitPane
        className="min-h-0 flex-1"
        asideWidth="inspector-wide"
        storageId="agent-plan"
        asideLabel={t`方案面板`}
        aside={<PlanPanel {...blockProps} />}
      >
        <AgentConversationBlock {...blockProps} />
      </SplitPane>
      {/* Block C: the session drawer and 新建会话与引用. Mounted only while
          open, so `/agent` does not fetch a session list nobody asked for. */}
      <AgentSessionsBlock
        {...blockProps}
        open={sessionsOpen}
        onClose={() => {
          setSessionsOpen(false);
        }}
      />
    </AgentFrame>
  );
}

function AgentFrame({ embedded, toolbar, children }: { readonly embedded: boolean; readonly toolbar: ReactNode; readonly children: ReactNode }) {
  if (embedded) {
    return <section data-agent-workspace className="flex min-h-0 flex-1 flex-col">{toolbar}{children}</section>;
  }
  return <Page scroll={false} toolbar={toolbar}>{children}</Page>;
}

/*
 * The three blocks all live in `pages/agent/` and are rendered above through
 * the shared `AgentBlock` props, which is what keeps this file a composition
 * root rather than a second implementation:
 *
 *   Block A — `AgentConversationBlock.tsx`, the transcript and the composer.
 *   Block B — `PlanPanel.tsx`, the plan with its changes, edits and takes.
 *   Block C — `AgentSessionsBlock.tsx`, the session drawer plus 新建会话与引用;
 *             an overlay, so it mounts beside `SplitPane` and its trigger sits
 *             in the toolbar's `actions`.
 */

/* ── helpers ─────────────────────────────────────────────────────────────── */

const EMPTY_SHOTS: readonly AgentPlanShot[] = [];

interface EditFailureNoticeProps {
  readonly error: unknown;
  /** The plan's current revision, or `null` while no plan is loaded. */
  readonly revision: number | null;
  readonly recomputeDisabled: boolean;
  readonly onRecompute: (revision: number) => void;
  readonly onReread: () => void;
  readonly onDismiss: () => void;
}

/**
 * A merged edit that did not reach the server (§4.5.4), said out loud.
 *
 * The two failures are not the same event and do not get the same recovery. A
 * **409** means the plan moved under the buffer — nothing is wrong with the
 * edit, it was simply computed against a revision that no longer exists — so
 * the way out is the one the artboard already draws for a stale proposal,
 * 「基于修订 N 重算」. Anything else is an ordinary failed write, and the way out
 * is to read the plan again and see what is actually stored.
 *
 * Both say the same second line, because it is the part the user cannot see for
 * themselves: the shots on screen are still the edited ones and they are not in
 * the plan. Dismissing is offered — the write already happened or didn't, and
 * acknowledging it is a legitimate answer — but nothing auto-dismisses.
 */
function EditFailureNotice({
  error,
  revision,
  recomputeDisabled,
  onRecompute,
  onReread,
  onDismiss,
}: EditFailureNoticeProps) {
  const conflict = isRevisionConflict(error);
  const failure = dataErrorMessage(error) ?? '';

  return (
    /* `Notice` does not forward unknown props, so the probe the tests read the
       branch by is on the wrapper rather than sprayed onto the component. */
    <div data-agent-edit-failure={conflict ? 'conflict' : 'failed'}>
      <Alert
        className="mx-7 mt-5"
        variant={conflict ? 'warning' : 'danger'}
        detail={<Trans>屏幕上的改动还没有写进方案。</Trans>}
        onDismiss={onDismiss}
        action={
          conflict && revision !== null
            ? {
              label: <Trans>基于第 {revision} 版重算</Trans>,
              onAction: () => {
                onRecompute(revision);
              },
              disabled: recomputeDisabled,
            }
            : { label: <Trans>重新读取剪辑单</Trans>, onAction: onReread }
        }
      >
        {conflict ? (
          <Trans>方案在这期间被改过了，这次改动没有写进方案。</Trans>
        ) : (
          <Trans>这次改动没能写进方案：{failure}</Trans>
        )}
      </Alert>
    </div>
  );
}

/**
 * 「确认并生成视频」's state.
 *
 * Until phase 3f-be this returned a hard `disabled: true` with the reason 「方案
 * 的镜头没有带上 Demo 与选手」, which stopped being true the day `AgentPlanShot`
 * gained `recording` (§10.6 gap 1, closed in §10.7). The two refusals below are
 * the client-side halves of the two 422s `POST /agent/plans/{id}/recording-plan`
 * can answer with — said *before* the round trip, so the button explains itself
 * instead of failing and then explaining.
 *
 * Enabled, it does not record. It navigates to `/recording/<planId>`, where the
 * plan is reviewed and 开始录制 is pressed — §4.5.3 rule ① keeps exactly one
 * place recording can start from, and this is not it.
 */
function confirmGuard(input: {
  plan: AgentPlan | null;
  service: ServiceActionState;
}): AgentGuardedAction {
  if (input.service.blocked) return input.service.buttonProps;
  if (input.plan === null) return { disabled: true, disabledReason: t`先选择一份剪辑单` };
  if (!agentPlanHasRecordableShot(input.plan)) {
    return { disabled: true, disabledReason: t`方案里的镜头都被移除了，没有可以录制的内容` };
  }
  const unbound = agentPlanShotsNeedingBinding(input.plan);
  if (unbound.length > 0) {
    return {
      disabled: true,
      disabledReason: t`还有 ${unbound.length} 个镜头没有绑定 Demo 与选手，不能转成录制任务`,
    };
  }
  return { disabled: false };
}

function editGuard(input: {
  hasPlan: boolean;
  hasSession: boolean;
  service: ServiceActionState;
}): AgentGuardedAction {
  if (input.service.blocked) return input.service.buttonProps;
  if (!input.hasPlan) return { disabled: true, disabledReason: t`先选择一份剪辑单` };
  // `AgentPlanEdit.origin` is not nullable — an edit must name its session.
  if (!input.hasSession) {
    return { disabled: true, disabledReason: t`编辑会记入对话，请先选择或新建一条对话` };
  }
  return { disabled: false };
}

/**
 * The one line the origin trail shows — 「镜头 02 由 Dolly 改为 Tracking；总时长
 * 38 → 42 秒」 in the reference, counted rather than described, because it is
 * built from the merged changes and must not claim an edit that did not happen.
 * A block that can say something better passes its own note through
 * `PlanEditRecord.note`, which travels beside this on the same write.
 */
function editSummary(pending: PendingPlanEdit): string {
  const shots = new Set(pending.changes.map((change) => change.shot)).size;
  return t`在 ${shots} 个镜头上做了 ${pending.changes.length} 处改动`;
}
