/*
 * pages/agent — block A: the conversation, and the three shapes it takes
 * (「07 Agent 创作面板」, 「Agent 形态 · 第二轮」, 「补齐 · 手动编辑与编辑感知」).
 *
 * `agentContract.ts` is the contract; this file is the half of it that renders
 * the transcript, the proposals inside it, and the instruction bar.
 *
 * ── The shape is the address ──────────────────────────────────────────────
 *
 * `?mode=changes|inline|takes` and nothing else. The switch writes
 * `updateContext({ mode })`, which clears neither `plan` nor `session`
 * (invariant 4), so a copied link restores the same shape over the same plan
 * and the same session. An unknown value falls back to `changes` in
 * `readAgentContext` — a stale deep link is a navigation, not an error — and
 * the fallback happens *before* the block sees it, so nothing here re-decides
 * it.
 *
 * ── What survives a shape switch, and what this block does not own ───────
 *
 * The selection — the shot 2b attaches the conversation to — is owned by this
 * component rather than by the three heads, precisely so that switching shape
 * does not throw it away. It is not in the address either: §7 fixes three
 * parameters, and a fourth that nothing else in the product writes would be an
 * invented address (see `ConversationModes.tsx`).
 *
 * The **decisions are not this block's** (invariant 6). The same change is drawn
 * again in the plan panel, and 「已接受」 is a fact about the change rather than
 * about the column it was pressed in, so the map lives on the shell and arrives
 * as `props.changes`. This block reads it and writes through
 * `props.changes.accept` / `.decide`; it holds no `useState` of its own for
 * them, which is what makes a shape switch — and a glance at the panel — keep
 * the same answer. There is still no route that stores a decision
 * (`agentContract.ts` gap 3), so the line above the composer still says they
 * are lost on reload.
 *
 * ── §4.5.3 ①, in this block ──────────────────────────────────────────────
 *
 * 「接受变更不触发录制」. No hook in this file can start anything —
 * `useAgentPlan`, `useAgentSession` and `useCreateAgentSession` are the whole
 * list — and 接受 goes to `props.changes.accept`, which is `applyPlanChange`
 * plus an `editNotifier.record`: an ordinary buffered plan edit and nothing
 * that could execute. The 「确认并生成视频」 button lives on the shell's toolbar
 * and is the only place recording could ever begin.
 *
 * Accepting *does* change the plan, and that is the point: a card that turned
 * 已接受 while the shots stayed where they were told the user something had
 * happened that had not. What the payload cannot carry out — `replace` and
 * `insert` have prose and no shot — is disabled with the reason written on it
 * (`changeApplicability`), the same way the panel does it, rather than accepted
 * into nothing.
 *
 * ── Streaming ────────────────────────────────────────────────────────────
 *
 * The stream belongs to the shell (`props.chat`), which is why the composer,
 * the transcript and the confirm action cannot disagree about whether the Agent
 * is speaking. This block never opens a `Channel`: `data/sessions.ts` keeps
 * in-flight text in React state and out of the query cache, and
 * `AgentTranscript`'s `streamingContent` is the other end of that decision.
 * Cancelling goes through `chat.cancel`, and a cancelled reply is never written
 * into the session.
 *
 * The end-to-end case the artboard 「修订冲突 · 旧提议自动过期」 draws — the user
 * edits the plan while a reply is being generated — needs no code here at all,
 * and that is the point: the revision the proposal was stamped with is compared
 * against the revision `useAgentPlan` currently holds, every render, by
 * `resolveChangeSet`. When the edit lands the plan query moves and the card
 * that arrives is already `stale`.
 */

import { t } from '@lingui/core/macro';
import { useLingui } from '@lingui/react';
import { Trans } from '@lingui/react/macro';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';

import { dataErrorMessage } from '../../data/errors';
import { useAgentPlan } from '../../data/plans';
import {
  useAgentSession,
  useAgentWorkspaceSettings,
  useCreateAgentSession,
} from '../../data/sessions';
import { Empty, Skeleton } from '../../design/data';
import { Alert } from '../../design/feedback';
import { Button, Seg, cn } from '../../design/primitives';
import {
  AgentProposalCard,
  AgentTranscript,
  PlanChangeCard,
  type AgentEntryExtras,
  type PlanChange,
  type PlanChangeSet,
} from '../../domain/agent';
import type { AgentPlan, AgentPlanShot, AgentSessionEntry } from '../../shared/desktop/dto';
import {
  AGENT_MODE,
  AGENT_MODES,
  type AgentBlock,
  type AgentBlockProps,
  type AgentGuardedAction,
} from './agentContract';
import { AgentComposer } from './AgentComposer';
import { AgentConfirmationCard, confirmationProposalId } from './AgentConfirmationCard';
import { AGENT_MODE_HEAD } from './ConversationModes';
import { changeApplicability } from './planChangeApply';
import { settingsPath } from '../settings/settingsRoutes';
import { ChangePreviewDialog } from './ChangePreviewDialog';
import { recordingHref } from '../recording/recordingContract';
import {
  changeDecisionKey,
  changesForShot,
  collectProposals,
  pendingTotal,
  proposalsByEntry,
  resolveChangeSet,
  shotLabelOf,
  staleTotal,
  type ProposalSlot,
} from './conversationModel';

export const AgentConversationBlock: AgentBlock = ({
  context,
  updateContext,
  changes,
  chat,
  service,
  edit,
  readiness,
  collapsed,
}: AgentBlockProps) => {
  const { i18n } = useLingui();
  const navigate = useNavigate();

  const plan = useAgentPlan(context.plan);
  const session = useAgentSession(context.session);
  const createSession = useCreateAgentSession();
  const workspaceSettings = useAgentWorkspaceSettings();

  const [selectedShotId, setSelectedShotId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [autoMode, setAutoMode] = useState(readAutoMode);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const lastMessageRef = useRef<string | null>(null);
  const [preview, setPreview] = useState<{
    readonly slotKey: string;
    readonly change: PlanChange;
    readonly shot: AgentPlanShot;
    readonly basedOnRevision: number | null;
    readonly acceptAfterPreview: boolean;
  } | null>(null);

  useEffect(() => {
    try {
      globalThis.localStorage?.setItem(AUTO_MODE_STORAGE_KEY, autoMode ? '1' : '0');
    } catch {
      // A storage-denied webview still keeps Auto stable for this mount.
    }
  }, [autoMode]);

  const decisions = changes.decisions;
  const planData = plan.data;
  const sessionData = session.data;
  /* The shots the shell holds, which include the edits §4.5.4 has not written
     yet. Reading `planData.shots` instead would draw 2b's shot band and the
     change cards' 「02 跟随突破」 from a plan the panel next door is already
     past — the same two-answers-on-one-screen the decisions had. */
  const bufferedShots = changes.shots;
  const shots = bufferedShots ?? planData?.shots ?? EMPTY_SHOTS;
  const headPlan: AgentPlan | undefined = useMemo(
    () =>
      planData === undefined || bufferedShots === null
        ? planData
        : { ...planData, shots: [...bufferedShots] },
    [planData, bufferedShots],
  );
  const revision = planData === undefined ? null : planData.revision;

  const slots = useMemo(() => collectProposals(sessionData?.entries ?? []), [sessionData]);
  const byEntry = useMemo(() => proposalsByEntry(slots), [slots]);
  const setByKey = useMemo(() => {
    const resolved = new Map<string, PlanChangeSet | null>();
    for (const slot of slots) resolved.set(slot.key, resolveChangeSet(slot, decisions, revision));
    return resolved;
  }, [slots, decisions, revision]);
  const pendingChanges = useMemo(() => pendingTotal([...setByKey.values()]), [setByKey]);
  const staleChanges = useMemo(() => staleTotal([...setByKey.values()]), [setByKey]);
  const hasChangeSets = useMemo(
    () => [...setByKey.values()].some((set) => set !== null),
    [setByKey],
  );

  /* A plan switch can leave a selection pointing at a shot that is gone; the
     id is only ever read back through the plan, so a stale one selects
     nothing rather than filtering everything away. */
  const selectedShot = shots.find((shot) => shot.id === selectedShotId) ?? null;
  const filterShotId = context.mode === 'inline' ? (selectedShot?.id ?? null) : null;

  /* 接受 is the shell's one path — apply, record, decide — and 拒绝 is a
     decision and nothing else. Neither is re-implemented here (invariant 6). */
  const onAccept = useCallback(
    (slotKey: string, change: PlanChange, basedOnRevision: number | null) => {
      const shot = shots.find((item) => item.id === change.targetShotId);
      if (workspaceSettings.data?.preview_before_apply === true && shot !== undefined) {
        setPreview({ slotKey, change, shot, basedOnRevision, acceptAfterPreview: true });
        return;
      }
      changes.accept(changeDecisionKey(slotKey, change.id), change, basedOnRevision);
    },
    [changes, shots, workspaceSettings.data?.preview_before_apply],
  );

  const onPreview = useCallback(
    (slotKey: string, change: PlanChange, basedOnRevision: number | null) => {
      const shot = shots.find((item) => item.id === change.targetShotId);
      if (shot !== undefined) {
        setPreview({ slotKey, change, shot, basedOnRevision, acceptAfterPreview: false });
      }
    },
    [shots],
  );

  const onReject = useCallback(
    (slotKey: string, changeId: string) => {
      changes.decide(changeDecisionKey(slotKey, changeId), 'rejected');
    },
    [changes],
  );

  const onSelectShot = useCallback((shot: AgentPlanShot) => {
    /* Clicking the selected shot again clears the filter: 2b has no 「全部」
       option, and a filter with no way out is a trap. */
    setSelectedShotId((current) => (current === shot.id ? null : shot.id));
  }, []);

  const send = useCallback(
    async (message: string) => {
      lastMessageRef.current = message;
      let sessionId = context.session;
      if (sessionId === null) {
        const created = await createSession.mutateAsync(sessionTitle(message, planData?.title));
        sessionId = created.id;
        updateContext({ session: sessionId });
      }
      setDraft('');
      /* `chat.send` is the shell's wrapper: it flushes the edit notifier first,
         so the model reads the manual edit before the question about it. */
      await chat.send({ message, sessionId, autoMode });
    },
    [autoMode, chat, context.session, createSession, planData?.title, updateContext],
  );
  const hasResultView = hasChangeSets || shots.length > 0;
  const latestFailedTurn = [...(sessionData?.entries ?? EMPTY_ENTRIES)]
    .reverse()
    .find((entry) => entry.kind === 'assistant' && entry.status === 'failed');

  const sendDisabledReason =
    service.blocked
      ? service.buttonProps.disabledReason
      : readiness.disabled
        ? readiness.disabledReason
      : createSession.isPending
        ? t`正在准备对话`
        : chat.streaming
          ? t`Agent 正在回答，先等它说完或点停止`
          : undefined;

  const Head = AGENT_MODE_HEAD[context.mode];

  const renderExtras = (entry: AgentSessionEntry): AgentEntryExtras | undefined => {
    const entrySlots = byEntry.get(entry.id);
    const confirmations = entry.kind === 'assistant'
      ? entry.tool_calls
        .map((call, index) => ({ call, index, proposalId: confirmationProposalId(call) }))
        .filter((item) => item.proposalId !== null)
      : [];
    const entryProposals = entry.kind === 'assistant' ? entry.proposals : [];
    const failedPrompt = entry.kind === 'assistant' && entry.status === 'failed'
      ? promptBeforeEntry(sessionData?.entries ?? EMPTY_ENTRIES, entry.id)
      : null;
    if (
      (entrySlots === undefined || entrySlots.length === 0)
      && confirmations.length === 0
      && failedPrompt === null
    ) {
      return undefined;
    }
    return {
      children: [
        ...(entrySlots ?? []).map((slot) => (
          <ProposalBlock
            key={slot.key}
            slot={slot}
            changeSet={setByKey.get(slot.key) ?? null}
            shots={shots}
            currentRevision={revision}
            filterShotId={filterShotId}
            edit={edit}
            onAccept={onAccept}
            onPreview={onPreview}
            onReject={onReject}
          />
        )),
        ...confirmations.map(({ call, index, proposalId }) => (
          <AgentConfirmationCard
            key={`${entry.id}-confirmation-${String(index)}`}
            call={call}
            proposal={proposalId === null
              ? undefined
              : entryProposals.find((proposal) => proposal.proposal_id === proposalId)}
            sessionId={context.session ?? sessionData?.id ?? ''}
            chat={chat}
            onContinueVideo={() => {
              if (planData !== undefined) void navigate(recordingHref(planData.id));
            }}
          />
        )),
      ],
      ...(failedPrompt === null
        ? {}
        : {
            actions: [{
              id: `retry-${entry.id}`,
              label: <Trans>重试</Trans>,
              primary: true,
              onAction: () => void chat.send({ message: failedPrompt, retryOf: entry.id, autoMode }),
            }],
          }),
    };
  };

  return (
    <section
      data-agent-block="conversation"
      data-agent-mode={context.mode}
      className="flex min-h-0 min-w-0 flex-1 flex-col"
    >
      {hasResultView ? (
        <div className="flex flex-none flex-col gap-2 border-b border-divider p-3.5">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <Seg
            name="agent-conversation-mode"
            value={context.mode}
            size="sm"
            aria-label={t`对话形态`}
            options={AGENT_MODES.map((mode) => ({
              value: mode,
              label: i18n._(AGENT_MODE[mode].label),
            }))}
            onChange={(mode) => updateContext({ mode })}
          />
          {collapsed ? null : (
            <p data-agent-mode-hint="" className="min-w-0 flex-1 text-xs text-neutral-600">
              {i18n._(AGENT_MODE[context.mode].hint)}
            </p>
          )}
          </div>

          <Head
            context={context}
            updateContext={updateContext}
            plan={headPlan}
            planPending={context.plan !== null && plan.isPending}
            pendingChanges={pendingChanges}
            staleChanges={staleChanges}
            selectedShotId={selectedShot === null ? null : selectedShot.id}
            onSelectShot={onSelectShot}
            collapsed={collapsed}
          />
        </div>
      ) : null}

      {chat.error === null ? null : (
        <Alert
          className="m-3.5 mb-0"
          variant="danger"
          action={
            isModelConfigurationError(chat.error)
              ? {
                  label: <Trans>配置模型</Trans>,
                  onAction: () => void navigate(settingsPath('model')),
                }
              : {
                  label: <Trans>重试</Trans>,
                  onAction: () => {
                    const message = lastMessageRef.current;
                    if (message !== null) {
                      void chat.send({
                        message,
                        retryOf: latestFailedTurn?.kind === 'assistant' ? latestFailedTurn.id : null,
                        autoMode,
                      });
                    }
                  },
                }
          }
        >
          {isModelConfigurationError(chat.error)
            ? <Trans>还没有配置可用的 AI 模型。保存模型设置并测试连接后，再回来重试这句话。</Trans>
            : <Trans>这次回答没有完成：{chat.error}</Trans>}
        </Alert>
      )}

      <Transcript
        sessionId={context.session}
        pending={session.isPending}
        failure={dataErrorMessage(session.error)}
        onRetry={() => void session.refetch()}
        title={sessionData?.title ?? ''}
        entries={sessionData?.entries ?? EMPTY_ENTRIES}
        renderExtras={renderExtras}
        streaming={chat.streaming}
        draft={chat.draft}
        onFocusComposer={() => composerRef.current?.focus()}
      />

      {chat.streaming && (chat.activity?.length ?? 0) > 0 ? (
        <div className="flex-none border-t border-divider px-3.5 py-2 text-xs text-neutral-700" aria-live="polite">
          <Trans>工作进度</Trans>
          {' · '}
          {chat.activity?.map(agentActivityLabel).join(' → ')}
        </div>
      ) : null}

      {hasChangeSets ? (
        <p
          data-agent-change-note=""
          className="flex-none border-t border-divider px-3.5 pt-2.5 text-xs leading-normal text-neutral-700"
        >
          <Trans>接受变更不会启动录制：录制只在顶部确认一次之后才开始。</Trans>{' '}
          <Trans>接受与拒绝会保存到这条对话，刷新或重启后仍会保留。</Trans>
        </p>
      ) : null}

      <AgentComposer
        mode={context.mode}
        value={draft}
        onChange={setDraft}
        onSend={send}
        streaming={chat.streaming}
        onCancel={chat.cancel}
        autoMode={autoMode}
        onAutoModeChange={setAutoMode}
        inputRef={composerRef}
        showSuggestions={hasResultView}
        className={hasResultView ? undefined : 'min-h-0 flex-1'}
        workspace={
          hasResultView ? undefined : (
            <button
              type="button"
              data-agent-draft-canvas=""
              className="flex size-full min-h-40 flex-col items-center justify-center px-6 text-center text-neutral-600 hover:bg-neutral-100"
              onClick={() => composerRef.current?.focus()}
            >
              <span className="font-heading text-base text-neutral-700"><Trans>剪辑单草稿</Trans></span>
              <span className="mt-1 max-w-[42ch] text-xs leading-normal">
                <Trans>发送指令后，Agent 会把镜头结构、顺序和依据整理在这里。</Trans>
              </span>
            </button>
          )
        }
        {...(hasResultView ? {} : { sendLabel: <Trans>生成剪辑单</Trans> })}
        {...(sendDisabledReason === undefined ? {} : { disabledReason: sendDisabledReason })}
        hint={
          !hasResultView ? (
            <Trans>发送后会自动建立对话并生成第一版剪辑单</Trans>
          ) : context.mode === 'inline' && selectedShot !== null ? (
            <Trans>只影响这一个镜头：{selectedShot.title}</Trans>
          ) : (
            <Trans>手动编辑不会打断 Agent，也不需要它批准</Trans>
          )
        }
      />
      <ChangePreviewDialog
        open={preview !== null}
        change={preview?.change ?? null}
        shot={preview?.shot ?? null}
        onClose={() => setPreview(null)}
        {...(preview?.acceptAfterPreview === true
          ? {
              onAccept: () => {
                changes.accept(
                  changeDecisionKey(preview.slotKey, preview.change.id),
                  preview.change,
                  preview.basedOnRevision,
                );
              },
            }
          : {})}
      />
    </section>
  );
};

/* ── the transcript, and its three states ────────────────────────────────── */

interface TranscriptProps {
  readonly sessionId: string | null;
  readonly pending: boolean;
  readonly failure: string | null;
  readonly onRetry: () => void;
  readonly title: string;
  readonly entries: readonly AgentSessionEntry[];
  readonly renderExtras: (entry: AgentSessionEntry) => AgentEntryExtras | undefined;
  readonly streaming: boolean;
  readonly draft: string;
  readonly onFocusComposer: () => void;
}

function Transcript({
  sessionId,
  pending,
  failure,
  onRetry,
  title,
  entries,
  renderExtras,
  streaming,
  draft,
  onFocusComposer,
}: TranscriptProps) {
  if (sessionId === null) {
    return (
      <Frame state="no-session">
        <div className="flex flex-none flex-col items-center gap-2 px-6 pb-5 pt-8 text-center">
          <h3 className="font-heading text-xl"><Trans>告诉 Agent 你想要什么视频</Trans></h3>
          <p className="max-w-[52ch] text-sm leading-normal text-neutral-600">
            <Trans>
              一句话说清时长、重点和用途就够了。发送后会自动建立对话，并结合当前 Demo 生成第一版剪辑单。
            </Trans>
          </p>
        </div>
      </Frame>
    );
  }

  if (failure !== null) {
    return (
      <Frame state="error">
        <Alert
          className="m-3.5"
          variant="danger"
          action={{ label: <Trans>重试</Trans>, onAction: onRetry }}
          detail={<Trans>没有任何数据被改动，重试是安全的。</Trans>}
        >
          <Trans>读不到这条对话：{failure}</Trans>
        </Alert>
      </Frame>
    );
  }

  if (pending) {
    return (
      <Frame state="loading">
        {/* Bars, never a percentage: a transcript that has not arrived has no
            length to state. */}
        <div role="status" aria-busy="true" className="flex flex-col gap-3 p-3.5">
          {['62%', '84%', '48%', '76%'].map((width, index) => (
            <Skeleton
              key={width}
              width={width}
              className={cn('h-10', index % 2 === 0 ? 'self-end' : null)}
            />
          ))}
        </div>
      </Frame>
    );
  }

  return (
    <AgentTranscript
      className="p-3.5"
      label={title === '' ? t`对话` : t`对话 · ${title}`}
      entries={entries}
      renderExtras={renderExtras}
      {...(streaming ? { streamingContent: draft } : {})}
      empty={
        <Empty
          className="m-3.5"
          title={<Trans>这条对话还没有消息</Trans>}
          description={
            <Trans>说清楚你要的片子——多长、重点在哪、给谁看——Agent 会先给出一版镜头方案，再由你逐条处理。</Trans>
          }
          actions={
            <Button variant="secondary" onClick={onFocusComposer}>
              <Trans>写第一条指令</Trans>
            </Button>
          }
        />
      }
    />
  );
}

function sessionTitle(message: string, planTitle: string | undefined): string {
  const source = planTitle?.trim() || message.trim();
  const characters = [...source];
  return characters.length <= 40 ? source : `${characters.slice(0, 40).join('')}…`;
}

function isModelConfigurationError(message: string): boolean {
  return message.toLowerCase().includes('configure an ai provider');
}

function promptBeforeEntry(entries: readonly AgentSessionEntry[], entryId: string): string | null {
  const index = entries.findIndex((entry) => entry.id === entryId);
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    const entry = entries[cursor];
    if (entry?.kind === 'user' && entry.content.trim() !== '') return entry.content;
  }
  return null;
}

function Frame({ state, children }: { readonly state: string; readonly children: ReactNode }) {
  return (
    <div
      data-agent-transcript-state={state}
      className={cn(
        'flex min-h-0 flex-col overflow-y-auto',
        state === 'no-session' ? 'flex-none' : 'flex-1',
      )}
    >
      {children}
    </div>
  );
}

/* ── one proposal, with its change cards ─────────────────────────────────── */

interface ProposalBlockProps {
  readonly slot: ProposalSlot;
  readonly changeSet: PlanChangeSet | null;
  readonly shots: readonly AgentPlanShot[];
  readonly currentRevision: number | null;
  /** 2b's 「只影响这一个镜头」. `null` in the other two shapes. */
  readonly filterShotId: string | null;
  readonly edit: AgentGuardedAction;
  readonly onAccept: (
    slotKey: string,
    change: PlanChange,
    basedOnRevision: number | null,
  ) => void;
  readonly onPreview: (
    slotKey: string,
    change: PlanChange,
    basedOnRevision: number | null,
  ) => void;
  readonly onReject: (slotKey: string, changeId: string) => void;
}

function ProposalBlock({
  slot,
  changeSet,
  shots,
  currentRevision,
  filterShotId,
  edit,
  onAccept,
  onPreview,
  onReject,
}: ProposalBlockProps) {
  const { i18n } = useLingui();
  const visible = changeSet === null ? [] : changesForShot(changeSet.changes, filterShotId);
  const filteredOut = changeSet !== null && filterShotId !== null && visible.length === 0;

  return (
    <AgentProposalCard
      proposal={slot.proposal}
      changeSet={changeSet}
      {...(currentRevision === null ? {} : { currentRevision })}
    >
      {/* 2a's 「本次变更 来自『把它压到 30 秒以内』」. Printed only when it adds
          something the title does not already say. */}
      {slot.prompt === null || slot.prompt === slot.proposal.title ? null : (
        <p data-proposal-prompt="" className="min-w-0 truncate text-xs text-neutral-600">
          <Trans>来自「{slot.prompt}」</Trans>
        </p>
      )}

      {filteredOut ? (
        <p data-proposal-filtered="" className="text-xs text-neutral-600">
          <Trans>这条提议没有涉及选中的镜头。</Trans>
        </p>
      ) : null}

      {visible.map((change, index) => {
        const label = shotLabelOf(shots, change.targetShotId);
        /* The same pair of reasons the panel prints, in the same order: why the
           page cannot edit at all first, then why this particular change cannot
           be carried out. 接受 here is the panel's 接受, so it must be dead in
           exactly the cases the panel's is dead in. */
        const applicability = changeApplicability(change, shots);
        const blockedReason = edit.disabled
          ? edit.disabledReason
          : applicability.reason === null
            ? undefined
            : i18n._(applicability.reason);

        return (
          <PlanChangeCard
            key={change.id}
            change={change}
            index={index + 1}
            {...(label === null ? {} : { targetLabel: `${label.number} ${label.title}` })}
            {...(blockedReason === undefined ? {} : { acceptDisabledReason: blockedReason })}
            onAccept={() => {
              onAccept(slot.key, change, slot.proposal.based_on_revision);
            }}
            {...(shots.some((item) => item.id === change.targetShotId)
              ? {
                  onPreview: () => {
                    onPreview(slot.key, change, slot.proposal.based_on_revision);
                  },
                }
              : {})}
            onReject={() => {
              onReject(slot.key, change.id);
            }}
          />
        );
      })}
    </AgentProposalCard>
  );
}

const EMPTY_SHOTS: readonly AgentPlanShot[] = [];
const EMPTY_ENTRIES: readonly AgentSessionEntry[] = [];
const AUTO_MODE_STORAGE_KEY = 'vibe-cs.agent.auto-mode.v1';

function readAutoMode(): boolean {
  try {
    return globalThis.localStorage?.getItem(AUTO_MODE_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

function agentActivityLabel(name: string): string {
  switch (name) {
    case 'read_workspace_context': return t`读取工作区`;
    case 'read_demo_summary': return t`读取 Demo 摘要`;
    case 'read_players': return t`读取选手目录`;
    case 'search_rounds': return t`筛选回合`;
    case 'read_round_context': return t`读取回合上下文`;
    case 'read_round_events': return t`读取回合事件`;
    case 'read_player_matchups': return t`读取对位证据`;
    case 'read_highlights': return t`筛选高光`;
    case 'read_cinematic_context': return t`理解镜头与空间`;
    case 'read_editor_timeline': return t`读取编辑时间线`;
    case 'read_agent_plan': return t`读取 Agent 剪辑单`;
    case 'read_audio_evidence': return t`分析音频节奏`;
    case 'draft_video_plan': return t`生成视频方案`;
    case 'draft_edit_plan': return t`生成剪辑方案`;
    case 'draft_agent_plan_changes': return t`生成方案变更`;
    case 'draft_beat_alignment': return t`生成卡点方案`;
    case 'navigate_workspace': return t`导航工作区`;
    case 'confirm_video_plan':
    case 'confirm_edit_plan':
    case 'confirm_beat_alignment': return t`完成流程确认`;
    case 'proposal_ready': return t`方案已就绪`;
    default: return name;
  }
}
