/*
 * pages/agent, block B — 方案面板 (「07 Agent 创作面板」's right column and the
 * whole of 「补齐 · 手动编辑与编辑感知」).
 *
 * The shot list, the manual edit, the revision, the Agent's change cards and the
 * state they fall into when the revision moves. `agentContract.ts` is the
 * contract this is built against; what follows is only what block B decided.
 *
 * ── §4.5.3 ②: an edit is never pending anything ──────────────────────────
 *
 * There is no approval anywhere below. 保存改动 saves, 删除 removes (softly, and
 * 撤销删除 stays offered next to it), and the shot is badged 「你改过」 rather
 * than 「待批准」 — `PlanShotRow` reads that word out of `AGENT_PLAN_AUTHOR`, so
 * the rule is one table away from every surface that shows a shot. The only
 * rollback on the page is 还原为 Agent 版本, and the user presses it.
 *
 * ── §4.5.3 ③: the revision is the server's, and the panel never guesses it ─
 *
 * `plan.revision` is printed, never incremented here. A proposal's cards go
 * through `resolveChangeSet` — decisions first, `markStale` second — and the
 * card's own appearance comes from `PLAN_CHANGE_AFFORDANCE`. Nothing in this
 * file re-derives 「已过期」, and `planPanel.interaction.test.tsx` pins that an
 * expired card is still fully readable: 过期不等于错误.
 *
 * ── §4.5.3 ①: this panel cannot start a recording ────────────────────────
 *
 * It holds one mutation of its own — `restoreAgentPlanBaseline` — and every
 * edit goes out through `props.changes` / `props.editNotifier`; none of them can
 * execute anything. 接受 a change is an edit. 保存改动 is an edit. 删除 is an
 * edit. The one button that could ever record is the shell toolbar's
 * 「确认并生成视频」, and this panel's footer points at it rather than growing a
 * second one: two buttons with one name is how a page ends up with two ways to
 * start a recording.
 *
 * ── The decisions and the buffer are the shell's ─────────────────────────
 *
 * §4.5.4's window means an edit is buffered for up to five seconds, so what is
 * drawn is the plan *after* the edits nobody has written yet. That buffer and
 * the accept/reject map both live on the shell (`props.changes`, invariant 6)
 * rather than here, because block A draws the same change cards over the same
 * plan: a decision held here would be invisible to the transcript, and 接受
 * pressed there would colour a card without moving a shot. This panel therefore
 * owns no `localShots` and no `decisions` — it reads
 * `props.changes.shots ?? plan.shots` and calls `props.changes.accept`. The
 * buffer is dropped by the shell when the plan id changes, and by this panel
 * after a restore, which replaces the whole array.
 */

import { t } from '@lingui/core/macro';
import { useLingui } from '@lingui/react';
import { Trans } from '@lingui/react/macro';
import { useMemo, useState, type ReactNode } from 'react';

import { dataErrorMessage } from '../../data/errors';
import { isRevisionConflict, useAgentPlan, useRestoreAgentPlanBaseline } from '../../data/plans';
import { useAgentSession } from '../../data/sessions';
import { Empty, Skeleton } from '../../design/data';
import { Dialog, Alert } from '../../design/feedback';
import { Button, Badge, cn } from '../../design/primitives';
import {
  AGENT_PLAN_STATUS,
  AGENT_SHOT_KIND,
  AGENT_SHOT_VIEW,
  PlanChangeCard,
  PlanShotRow,
  PlanShotRowSkeleton,
  PlanStrip,
  formatShotDuration,
  planDuration,
  planShotCount,
} from '../../domain/agent';
import type { PlanChange } from '../../domain/agent';
import type { AgentPlan, AgentPlanShot } from '../../shared/desktop/dto';
import { RouteLink } from '../RouteLink';

import type { AgentBlock, AgentBlockProps } from './agentContract';
import { PlanOriginTrail } from './PlanOriginTrail';
import { changeApplicability } from './planChangeApply';
import {
  changeDecisionKey,
  resolveChangeSet,
  type ChangeDecisions,
} from './conversationModel';
import {
  readShotDraft,
  removeShot,
  restoreShot,
  saveShotDraft,
  shotPosition,
  userTouchedCount,
  type ShotDraft,
  type ShotLabelSource,
} from './planEditModel';
import { readPlanProposals, type PlanProposal } from './planProposals';
import { ShotEditForm } from './ShotEditForm';
import { CARD_LIST_GAP_CLASS } from '../../design/layout';

/* ── the block ───────────────────────────────────────────────────────────── */

export const PlanPanel: AgentBlock = (props) => {
  const plan = useAgentPlan(props.context.plan);

  if (props.context.plan === null) {
    return (
      <Empty
        className="m-5"
        title={<Trans>还没有选中剪辑单</Trans>}
        description={
          <Trans>
            方案是 Agent 交出来的镜头列表。在对话里让它出一份，或者从工作台打开一份已有的。
          </Trans>
        }
        actions={
          <RouteLink to="/">
            <Trans>返回工作台</Trans>
          </RouteLink>
        }
      />
    );
  }

  if (plan.isPending) return <PlanPanelSkeleton />;

  if (plan.data === undefined) {
    return (
      <div className="p-5">
        <Alert
          variant="danger"
          action={{ label: <Trans>重试</Trans>, onAction: () => void plan.refetch() }}
          detail={<Trans>方案本身没有被改动，重试是安全的。</Trans>}
        >
          <Trans>这份方案没能打开：{dataErrorMessage(plan.error) ?? ''}</Trans>
        </Alert>
      </div>
    );
  }

  /* Keyed by the plan: switching plans throws away the edit draft, the local
     shots and every accept/reject, which is what 「一个 buffer 不跨对象」 means
     at the page level. */
  return <PlanPanelBody key={plan.data.id} plan={plan.data} refetchPlan={plan.refetch} {...props} />;
};

function PlanPanelSkeleton() {
  return (
    <div data-plan-panel-skeleton="" role="status" aria-busy="true" className="flex flex-col gap-3 p-5">
      {/* No percentage: `AgentPlan` has no progress and §4.3 forbids inventing
          one. Bars only, in the shape of what is coming. */}
      <Skeleton className="h-[var(--h-ctl-sm)]" />
      <PlanShotRowSkeleton />
      <PlanShotRowSkeleton />
      <p className="sr-only">
        <Trans>正在读取方案</Trans>
      </p>
    </div>
  );
}

/* ── the body ────────────────────────────────────────────────────────────── */

interface PlanPanelBodyProps extends AgentBlockProps {
  readonly plan: AgentPlan;
  /** `useAgentPlan(...).refetch`, narrowed to the one field this file reads. */
  readonly refetchPlan: () => Promise<{ readonly data: AgentPlan | undefined }>;
}

function PlanPanelBody({
  plan,
  refetchPlan,
  context,
  updateContext,
  editNotifier,
  changes,
  chat,
  service,
  edit,
  confirm,
  collapsed,
}: PlanPanelBodyProps) {
  const { i18n } = useLingui();
  const session = useAgentSession(context.session);
  const restore = useRestoreAgentPlanBaseline();

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<ShotDraft | null>(null);
  const [restoreOpen, setRestoreOpen] = useState(false);

  const decisions = changes.decisions;
  const shots = changes.shots ?? plan.shots;
  /* The whole transcript is walked to find this plan's proposals, and the shell
     re-renders every block on each streaming token — so this is memoised on the
     two things it actually depends on rather than repeated per token. */
  const sessionData = session.data;
  const proposals = useMemo(() => readPlanProposals(sessionData, plan.id), [sessionData, plan.id]);

  const labels: ShotLabelSource = {
    kind: (kind) => AGENT_SHOT_KIND[kind].code,
    view: (view) => i18n._(AGENT_SHOT_VIEW[view].label),
  };

  /**
   * The one way an edit leaves this panel — the shell's, so what the panel edits
   * and what the transcript reads are the same array (invariant 6). It updates
   * what is on screen and hands each line to the notifier; never to
   * `useApplyAgentPlanEdit`, which is invariant 5, and never to anything that
   * could record, which is rule ①.
   */
  const record = changes.record;

  const startEditing = (shot: AgentPlanShot) => {
    setSelectedId(shot.id);
    setEditingId(shot.id);
    setDraft(readShotDraft(shot));
  };

  const stopEditing = () => {
    setEditingId(null);
    setDraft(null);
  };

  const saveDraft = () => {
    if (editingId === null || draft === null) return;
    const result = saveShotDraft(shots, editingId, draft, labels);
    // A save that moved nothing is not an edit — see `saveShotDraft`. Closing
    // the card is still the right answer; sending a notice would not be.
    if (result !== null) record(result, draft.note);
    stopEditing();
  };

  const onRemove = (shot: AgentPlanShot) => {
    const result = removeShot(shots, shot.id);
    if (result === null) return;
    if (editingId === shot.id) stopEditing();
    record(result);
  };

  const onRestore = (shot: AgentPlanShot) => {
    const result = restoreShot(shots, shot.id);
    if (result !== null) record(result);
  };

  /* 接受 applies the change, records the edit and files the decision — all
     three, in the shell, so pressing it here and pressing it in the transcript
     are one press. 拒绝 files a decision and touches no shot. */
  const onAccept = (proposal: PlanProposal, change: PlanChange) => {
    changes.accept(changeDecisionKey(proposal.key, change.id), change);
  };

  const onReject = (proposal: PlanProposal, change: PlanChange) => {
    changes.decide(changeDecisionKey(proposal.key, change.id), 'rejected');
  };

  /* 「基于修订 7 重算」. The shell wraps `chat.send` with the 「发送消息前」 flush,
     so pressing it writes the pending edit into the session first and the model
     recomputes against a plan it has already been told about. */
  const onRecompute = () => {
    void chat.send({
      message: t`方案已经是第 ${plan.revision} 版了，请基于最新的镜头重新给出变更。`,
    });
  };

  /* 全部丢弃: every card that is still open — expired or waiting — becomes a
     rejection, one decision at a time through the shell's one map. Nothing is
     applied to the plan, which is what 丢弃 means. */
  const onDiscardStale = (proposal: PlanProposal) => {
    const resolved = resolveChangeSet(proposal, decisions, plan.revision);
    if (resolved === null) return;
    for (const change of resolved.changes) {
      if (change.state === 'stale' || change.state === 'pending') {
        changes.decide(changeDecisionKey(proposal.key, change.id), 'rejected');
      }
    }
  };

  const onConfirmRestore = () => {
    setRestoreOpen(false);
    void (async () => {
      /* The buffered notice belongs to the plan as the user last edited it, and
         a restore replaces that plan wholesale. Flushing first also stops the
         window from landing *after* the restore and quietly undoing it. The
         reason is `restore`, its own member: borrowing `switch-plan` put a word
         in the log for something that did not happen, and a lost notice is
         diagnosed by its reason. */
      await editNotifier.flush('restore');
      /* The flush above may have moved the revision, and a restore is a
         conditional write like any other — so the number it is conditional on
         is re-read rather than remembered. */
      const latest = await refetchPlan();
      const revision = latest.data?.revision ?? plan.revision;
      const origin = sessionData;
      if (origin === undefined) return;

      restore.mutate(
        {
          plan_id: plan.id,
          expected_revision: revision,
          origin: {
            session_id: origin.id,
            session_title: origin.title,
            summary: t`还原为 Agent 版本`,
          },
          note: null,
        },
        {
          onSuccess: () => {
            /* The restore replaced the whole array, so the buffer describes a
               plan that no longer exists. */
            changes.reset();
            stopEditing();
          },
        },
      );
    })();
  };

  const duration = planDuration(shots);
  const count = planShotCount(shots);
  const touched = userTouchedCount(shots);
  const status = AGENT_PLAN_STATUS[plan.status];
  const density = collapsed ? 'compact' : 'card';

  const restoreBlocked = edit.disabled || restore.isPending;
  const restoreReason = edit.disabled ? edit.disabledReason : undefined;
  const restoreError = restore.error;

  return (
    <section data-agent-block="plan" className="flex min-h-0 flex-1 flex-col">
      <header className="flex min-h-[var(--h-panel-head)] flex-none flex-wrap items-center gap-2 border-b border-divider px-4 py-1.5">
        <h2 className="min-w-0 flex-1 truncate font-heading text-base tracking-wide">
          <Trans>镜头方案</Trans>
        </h2>
        <Badge variant="accent" data-plan-revision={plan.revision}>
          <Trans>第 {plan.revision} 版</Trans>
        </Badge>
        <Badge variant="neutral">{i18n._(status.label)}</Badge>
        <Button
          size="sm"
          data-plan-restore=""
          disabled={restoreBlocked}
          {...(restoreReason === undefined ? {} : { disabledReason: restoreReason })}
          onClick={() => {
            setRestoreOpen(true);
          }}
        >
          <Trans>还原为 Agent 版本</Trans>
        </Button>
      </header>

      <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto p-4">
        <p data-plan-summary="" className="flex flex-wrap items-baseline gap-x-2 text-xs text-neutral-700">
          <span className="font-mono">{formatShotDuration(duration)}</span>
          <span>·</span>
          <Trans>{count} 个镜头</Trans>
          {touched === 0 ? null : (
            <>
              <span>·</span>
              <span data-plan-touched={touched} className="text-accent-800">
                <Trans>你改过 {touched} 处</Trans>
              </span>
            </>
          )}
        </p>

        {shots.length === 0 ? null : (
          <PlanStrip
            label={t`当前方案`}
            shots={shots}
            ruler={!collapsed}
            selectedShotId={selectedId}
            onSelectShot={(shot) => {
              setSelectedId(shot.id);
            }}
          />
        )}

        {restoreError === null ? null : (
          <Alert
            variant="danger"
            action={{
              label: <Trans>重新读取剪辑单</Trans>,
              onAction: () => {
                restore.reset();
                changes.reset();
                void refetchPlan();
              },
            }}
          >
            {isRevisionConflict(restoreError) ? (
              <Trans>方案在这期间被改过了，还原没有执行。读一次最新的再来。</Trans>
            ) : (
              <Trans>还原没能完成：{dataErrorMessage(restoreError) ?? ''}</Trans>
            )}
          </Alert>
        )}

        <ProposalSection
          proposals={proposals}
          decisions={decisions}
          revision={plan.revision}
          shots={shots}
          edit={edit}
          onAccept={onAccept}
          onReject={onReject}
          onRecompute={onRecompute}
          onDiscardStale={onDiscardStale}
          recomputeDisabled={context.session === null || chat.streaming || service.blocked}
        />

        <PanelSection title={<Trans>片段</Trans>}>
          {shots.length === 0 ? (
            <Empty
              headingLevel={4}
              title={<Trans>这份剪辑单还没有片段</Trans>}
              description={<Trans>在对话里说清楚你想要的节奏，Agent 会给出第一版镜头。</Trans>}
              actions={null}
            />
          ) : (
            <ol className="flex flex-col gap-3">
              {shots.map((shot, index) => {
                const position = index + 1;
                const removed = shot.removed_by !== null;
                return (
                  <li key={shot.id}>
                    {editingId === shot.id && draft !== null ? (
                      <ShotEditForm
                        shot={shot}
                        index={position}
                        draft={draft}
                        onChange={setDraft}
                        onSave={saveDraft}
                        onCancel={stopEditing}
                        disabled={edit.disabled}
                        {...(edit.disabledReason === undefined
                          ? {}
                          : { disabledReason: edit.disabledReason })}
                      />
                    ) : (
                      <PlanShotRow
                        shot={shot}
                        index={position}
                        density={density}
                        selected={shot.id === selectedId}
                        onSelect={() => {
                          setSelectedId(shot.id);
                        }}
                        onRestore={onRestore}
                        {...(edit.disabled && edit.disabledReason !== undefined
                          ? { restoreDisabledReason: edit.disabledReason }
                          : {})}
                        action={
                          removed ? undefined : (
                            <span className="flex items-center gap-2">
                              <Button
                                size="sm"
                                data-shot-edit-open={shot.id}
                                disabled={edit.disabled}
                                {...(edit.disabledReason === undefined
                                  ? {}
                                  : { disabledReason: edit.disabledReason })}
                                onClick={() => {
                                  startEditing(shot);
                                }}
                              >
                                <Trans>编辑</Trans>
                              </Button>
                              <Button
                                size="sm"
                                data-shot-remove={shot.id}
                                disabled={edit.disabled}
                                {...(edit.disabledReason === undefined
                                  ? {}
                                  : { disabledReason: edit.disabledReason })}
                                onClick={() => {
                                  onRemove(shot);
                                }}
                              >
                                <Trans>删除</Trans>
                              </Button>
                            </span>
                          )
                        }
                      />
                    )}
                  </li>
                );
              })}
            </ol>
          )}
        </PanelSection>

        <PanelSection title={<Trans>改动来源</Trans>}>
          <PlanOriginTrail
            origins={plan.origin}
            currentSessionId={context.session}
            onOpenSession={(sessionId) => {
              updateContext({ session: sessionId });
            }}
          />
        </PanelSection>
      </div>

      <footer className="flex flex-none flex-col gap-1 border-t border-divider px-4 py-3">
        <p className="text-xs leading-normal text-neutral-800">
          {/* Rule ①, said where the plan is: the confirmation is one press, it
              is on the toolbar, and nothing on this panel is it. */}
          <Trans>
            顶栏的「确认并生成视频」会按这份方案录制 {count} 个镜头，共 {formatShotDuration(duration)}。
          </Trans>
        </p>
        {confirm.disabled && confirm.disabledReason !== undefined ? (
          <p data-plan-confirm-reason="" className="text-xs leading-normal text-warn-text">
            {confirm.disabledReason}
          </p>
        ) : null}
      </footer>

      <Dialog
        open={restoreOpen}
        tone="destructive"
        title={<Trans>还原为 Agent 版本？</Trans>}
        confirmLabel={<Trans>还原</Trans>}
        onConfirm={onConfirmRestore}
        onClose={() => {
          setRestoreOpen(false);
        }}
      >
        <Trans>
          你在这份方案上的 {touched} 处改动会被 Agent 的第 {plan.agent_baseline.revision} 版覆盖。这一步也会记入会话。
        </Trans>
      </Dialog>
    </section>
  );
}

/* ── the change cards ────────────────────────────────────────────────────── */

interface ProposalSectionProps {
  readonly proposals: readonly PlanProposal[];
  /** The shell's one map — see invariant 6. */
  readonly decisions: ChangeDecisions;
  readonly revision: number;
  readonly shots: readonly AgentPlanShot[];
  readonly edit: AgentBlockProps['edit'];
  readonly onAccept: (proposal: PlanProposal, change: PlanChange) => void;
  readonly onReject: (proposal: PlanProposal, change: PlanChange) => void;
  readonly onRecompute: () => void;
  readonly onDiscardStale: (proposal: PlanProposal) => void;
  readonly recomputeDisabled: boolean;
}

function ProposalSection({
  proposals,
  decisions,
  revision,
  shots,
  edit,
  onAccept,
  onReject,
  onRecompute,
  onDiscardStale,
  recomputeDisabled,
}: ProposalSectionProps) {
  const { i18n } = useLingui();

  if (proposals.length === 0) return null;

  return (
    <PanelSection title={<Trans>本次修改</Trans>}>
      <div className="flex flex-col gap-4">
        {proposals.map((proposal) => {
          /* `null` cannot happen for a `PlanProposal` — `readPlanProposals`
             leaves out everything that did not parse — but the shared resolver
             speaks for both projections, and drawing nothing is the honest
             answer to a change set that is not there. */
          const changeSet = resolveChangeSet(proposal, decisions, revision);
          if (changeSet === null || changeSet.changes.length === 0) return null;
          const stale = changeSet.changes.some((change) => change.state === 'stale');

          return (
            <div key={proposal.key} data-plan-proposal={proposal.key} className="flex flex-col gap-2">
              <div className="flex flex-wrap items-baseline gap-x-2">
                <h4 className="min-w-0 flex-1 truncate font-heading text-sm">{changeSet.title}</h4>
                <span className="flex-none font-mono text-2xs text-neutral-600">
                  <Trans>基于第 {changeSet.basedOnRevision} 版</Trans>
                </span>
              </div>

              {stale ? (
                /* The artboard's amber banner. 「逐条查看」 is not a button here:
                   the cards it would scroll to are the next thing on the page,
                   already open and already readable — 过期不等于错误. */
                <div data-plan-stale-notice="">
                  <Alert
                    variant="warning"
                    action={{
                      label: <Trans>基于第 {revision} 版重算</Trans>,
                      onAction: onRecompute,
                      disabled: recomputeDisabled,
                    }}
                    detail={
                      <Button
                        size="sm"
                        onClick={() => {
                          onDiscardStale(proposal);
                        }}
                      >
                        <Trans>全部丢弃</Trans>
                      </Button>
                    }
                  >
                    <Trans>
                      这组变更基于第 {changeSet.basedOnRevision} 版，方案已经是第 {revision} 版。内容仍可查看。
                    </Trans>
                  </Alert>
                </div>
              ) : null}

              <ol className={cn('flex flex-col', CARD_LIST_GAP_CLASS)}>
                {changeSet.changes.map((change, index) => {
                  const applicability = changeApplicability(change, shots);
                  const target = shots.find((shot) => shot.id === change.targetShotId);
                  const blockedReason = edit.disabled
                    ? edit.disabledReason
                    : applicability.reason === null
                      ? undefined
                      : i18n._(applicability.reason);

                  return (
                    <li key={changeDecisionKey(proposal.key, change.id)}>
                      <PlanChangeCard
                        change={change}
                        index={index + 1}
                        {...(target === undefined
                          ? {}
                          : {
                            targetLabel: `${String(shotPosition(shots, target.id)).padStart(2, '0')} ${target.title}`,
                          })}
                        {...(blockedReason === undefined ? {} : { acceptDisabledReason: blockedReason })}
                        onAccept={() => {
                          onAccept(proposal, change);
                        }}
                        onReject={() => {
                          onReject(proposal, change);
                        }}
                      />
                    </li>
                  );
                })}
              </ol>
            </div>
          );
        })}
      </div>
    </PanelSection>
  );
}

/* ── helpers ─────────────────────────────────────────────────────────────── */

function PanelSection({
  title,
  children,
  className,
}: {
  readonly title: ReactNode;
  readonly children: ReactNode;
  readonly className?: string | undefined;
}) {
  return (
    <section className={cn('flex min-w-0 flex-col gap-2.5', className)}>
      <h3 className="font-heading text-2xs tracking-widest text-neutral-600 uppercase">{title}</h3>
      {children}
    </section>
  );
}
