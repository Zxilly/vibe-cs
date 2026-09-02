import { t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import {
  CheckCircle2,
  CircleAlert,
  CircleX,
  LoaderCircle,
  Send,
  Sparkles,
  Square,
} from 'lucide-react';
import { memo, useEffect, useRef, useState, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

import { toast } from '../../design/feedback';
import { Button, cn } from '../../design/primitives';
import type {
  AgentSession,
  AgentSessionEntry,
  AgentToolCall,
  AgentToolCallStatus,
  JsonValue,
  ProjectChangeGroup,
} from '../../shared/desktop/dto';
import { deliveryDecisionChangeGroupId } from '../../shared/desktop/deliveryReview';
import type { ActivityItem } from '../../shared/desktop/viewModels';

export interface ProjectAgentToolActivity {
  readonly id: string;
  readonly name: string;
  readonly input: JsonValue;
  readonly output: JsonValue | null;
  readonly status: AgentToolCallStatus | 'running';
}

export interface ProjectAgentConversation {
  readonly streaming: boolean;
  readonly draft: string;
  readonly error: string | null;
  readonly activity?: readonly ProjectAgentToolActivity[] | undefined;
  readonly cancel: () => void;
}

export interface AgentPanelProps {
  readonly showHeader?: boolean;
  readonly session: AgentSession | null;
  readonly chat: ProjectAgentConversation;
  readonly creatingSession: boolean;
  readonly selectedClipId: string | null;
  readonly onSend: (message: string, selectedClipId: string | null) => Promise<void>;
  readonly changeGroups: readonly ProjectChangeGroup[];
  readonly readOnly: boolean;
  readonly agentReady: boolean;
  readonly agentStatusPending: boolean;
  readonly deliveryReady: boolean;
  readonly deliveryGatePending: boolean;
  readonly externalExecutions: readonly ActivityItem[];
  readonly executionActionPending: boolean;
  readonly onCancelExecution: (execution: ActivityItem) => void;
  readonly onOpenOutputs: () => void;
  readonly onOpenAgentSettings: () => void;
  readonly onOpenExternalUrl: (url: string) => Promise<boolean>;
  readonly confirming: boolean;
  readonly projectId: string;
  readonly projectRevision: number;
  readonly onConfirmRecording: (toolCallId: string, confirmation: ExternalExecutionConfirmation) => Promise<void>;
  readonly onConfirmExport: (toolCallId: string, confirmation: ExternalExecutionConfirmation) => Promise<void>;
  readonly onRejectConfirmation: (toolCallId: string) => Promise<void>;
  readonly onAcceptDelivery: (changeGroupId: string) => Promise<void>;
  readonly onReturnDelivery: (
    changeGroupId: string,
    feedback: string,
    selectedClipId: string | null,
  ) => Promise<void>;
  readonly onDirectEdit: (changeGroupId: string, selectedClipId: string | null) => void;
}

export const AgentPanel = memo(function AgentPanel({
  showHeader = true,
  session,
  chat,
  creatingSession,
  selectedClipId,
  onSend,
  changeGroups,
  readOnly,
  agentReady,
  agentStatusPending,
  deliveryReady,
  deliveryGatePending,
  externalExecutions,
  executionActionPending,
  onCancelExecution,
  onOpenOutputs,
  onOpenAgentSettings,
  onOpenExternalUrl,
  confirming,
  projectId,
  projectRevision,
  onConfirmRecording,
  onConfirmExport,
  onRejectConfirmation,
  onAcceptDelivery,
  onReturnDelivery,
  onDirectEdit,
}: AgentPanelProps) {
  const [message, setMessage] = useState('');
  const [returningChangeGroupId, setReturningChangeGroupId] = useState<string | null>(null);
  const conversationEnd = useRef<HTMLDivElement>(null);
  const messageInput = useRef<HTMLInputElement>(null);
  const entries = session?.entries ?? [];
  const pendingConfirmationToolCallId = pendingConfirmationToolCall(entries);
  const toolDecisions = new Map<string, ToolDecisionEntry>();
  for (const entry of entries) {
    if (entry.kind === 'tool_decision') toolDecisions.set(entry.tool_call_id, entry);
  }
  const reviewGroup = pendingDeliveryGroup(changeGroups, session);
  const hasDelivery = !chat.streaming
    && pendingConfirmationToolCallId === null
    && reviewGroup !== null
    && [...entries].reverse().some((entry) => entry.kind === 'assistant' && entry.status === 'completed');
  const submit = () => {
    const next = message.trim();
    if (next === '' || chat.streaming || creatingSession || readOnly || !agentReady) return;
    setMessage('');
    const changeGroupId = returningChangeGroupId;
    setReturningChangeGroupId(null);
    if (changeGroupId === null) void onSend(next, selectedClipId);
    else void onReturnDelivery(changeGroupId, next, selectedClipId);
  };
  useEffect(() => {
    if (returningChangeGroupId !== null && reviewGroup?.id !== returningChangeGroupId) {
      setReturningChangeGroupId(null);
    }
  }, [returningChangeGroupId, reviewGroup?.id]);
  useEffect(() => {
    conversationEnd.current?.scrollIntoView({ block: 'end' });
  }, [session?.id, entries.length, chat.draft, chat.activity?.length]);
  return (
    <aside className="flex min-h-0 flex-col border-l border-divider bg-bg" aria-label={t`Agent 面板`}>
      {showHeader ? <header className="flex h-[42px] flex-none items-center gap-2 border-b border-divider px-5">
        <span className="grid size-6 place-items-center rounded-full bg-accent-100 text-accent-text"><Sparkles className="size-3.5" aria-hidden="true" /></span>
        <h2 className="text-base font-semibold"><Trans>Agent</Trans></h2>
      </header> : null}
      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-3">
        <ol className="relative ml-1 flex list-none flex-col gap-3 border-l border-accent-200 py-1 pl-5">
            {session === null || entries.length === 0 ? (
              <ConversationShell actor="Agent" tone="agent">
                <Sparkles className="mb-2 size-5 text-accent-text" aria-hidden="true" />
                <p className="text-xs leading-5 text-neutral-600"><Trans>告诉我你想怎么剪。我会直接修改左侧时间线，所有改动都能撤销。</Trans></p>
              </ConversationShell>
            ) : null}
            {!agentStatusPending && !agentReady ? (
              <ConversationShell actor={t`系统`} tone="error">
                <div className="flex items-center gap-2 text-xs font-medium text-fail-text">
                  <CircleAlert className="size-4" aria-hidden="true" />
                  <Trans>还没配置 Agent 模型</Trans>
                </div>
                <p className="mt-1 text-xs leading-5 text-neutral-600"><Trans>配置提供方、模型、API 地址和密钥后即可在这里继续。</Trans></p>
                <Button className="mt-2" size="sm" variant="secondary" onClick={onOpenAgentSettings}><Trans>打开模型设置</Trans></Button>
              </ConversationShell>
            ) : null}
            {entries.map((entry) => (
              <ConversationEntry
                key={`entry:${entry.id}`}
                entry={entry}
                pendingConfirmationToolCallId={pendingConfirmationToolCallId}
                confirming={confirming}
                deliveryReady={deliveryReady}
                deliveryGatePending={deliveryGatePending}
                onConfirmRecording={onConfirmRecording}
                onConfirmExport={onConfirmExport}
                onRejectConfirmation={onRejectConfirmation}
                toolDecisions={toolDecisions}
                projectId={projectId}
                projectRevision={projectRevision}
                onOpenExternalUrl={onOpenExternalUrl}
              />
            ))}
            {chat.draft === '' ? null : (
              <ConversationShell actor="Agent" tone="agent">
                <AgentMarkdown onOpenExternalUrl={onOpenExternalUrl}>{chat.draft}</AgentMarkdown>
              </ConversationShell>
            )}
            {chat.activity?.map((call) => (
              <ConversationShell key={`live-tool:${call.id}`} actor={t`Agent · 工具`} tone="tool">
                <ToolCallCard call={call} projectId={projectId} projectRevision={projectRevision} />
              </ConversationShell>
            ))}
            {externalExecutions.map((execution) => (
              <ConversationShell key={`execution:${execution.id}`} actor={t`外部执行`} tone={execution.status === 'failed' ? 'error' : 'status'}>
                <div className="flex items-center gap-2 text-xs font-medium">
                  {execution.status === 'completed'
                    ? <CheckCircle2 className="size-4 text-ok" aria-hidden="true" />
                    : execution.status === 'failed'
                      ? <CircleAlert className="size-4 text-fail-text" aria-hidden="true" />
                      : <LoaderCircle className="size-4 animate-spin text-accent-text" aria-hidden="true" />}
                  <span>{execution.kind === 'recording' ? <Trans>录制片段</Trans> : <Trans>导出成片</Trans>}</span>
                  <span className="ml-auto text-2xs text-neutral-500">{execution.progress_percent ?? 0}%</span>
                </div>
                <p className="mt-1 text-2xs text-neutral-600">
                  {execution.status === 'completed'
                    ? <Trans>已完成，Agent 将自动读取结果并继续。</Trans>
                    : execution.status === 'failed'
                      ? execution.error
                      : <Trans>任务正在本机执行，完成后会回到这段对话。</Trans>}
                </p>
                <div className="mt-2 flex gap-2">
                  {execution.job_id === null || !execution.available_actions.includes('cancel') ? null : (
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={executionActionPending}
                      aria-label={execution.kind === 'export' ? t`取消导出任务` : t`取消录制任务`}
                      onClick={() => onCancelExecution(execution)}
                    >
                      <Trans>取消</Trans>
                    </Button>
                  )}
                  {!execution.available_actions.includes('open_outputs') ? null : (
                    <Button size="sm" variant="secondary" onClick={onOpenOutputs}><Trans>查看成品</Trans></Button>
                  )}
                </div>
              </ConversationShell>
            ))}
            {readOnly ? (
              <ConversationShell actor="Agent" tone="status">
                <div className="flex items-center gap-2 text-xs font-medium text-accent-text">
                  <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
                  <Trans>Agent 正在编辑 · 你暂时只能查看</Trans>
                </div>
                <p className="mt-1 text-xs leading-5 text-neutral-600"><Trans>你仍可查看预览和时间轴。Agent 完成后即可继续编辑。</Trans></p>
              </ConversationShell>
            ) : null}
            {hasDelivery ? (
              <ConversationShell actor="Agent" tone="delivery">
                <p className="text-xs font-medium"><Trans>所有修改都已完成，成片可以交付了。</Trans></p>
                <div className="mt-3 grid grid-cols-3 gap-2">
                  <Button size="sm" variant="primary" disabled={confirming} onClick={() => {
                    setReturningChangeGroupId(null);
                    if (reviewGroup !== null) void onAcceptDelivery(reviewGroup.id);
                  }}><Trans>接受交付</Trans></Button>
                  <Button size="sm" variant="secondary" disabled={confirming} onClick={() => {
                    if (reviewGroup === null) return;
                    setReturningChangeGroupId(reviewGroup.id);
                    globalThis.setTimeout(() => messageInput.current?.focus(), 0);
                  }}><Trans>退回修改</Trans></Button>
                  <Button size="sm" variant="secondary" disabled={readOnly || confirming} onClick={() => {
                    setReturningChangeGroupId(null);
                    if (reviewGroup !== null) onDirectEdit(reviewGroup.id, selectedClipId);
                  }}><Trans>直接修改</Trans></Button>
                </div>
              </ConversationShell>
            ) : null}
          </ol>
        <div ref={conversationEnd} />
        {chat.error === null ? null : <p className="mt-2 text-xs text-fail-text">{chat.error}</p>}
      </div>
      <footer className="border-t border-divider p-3">
        {returningChangeGroupId === null ? null : (
          <div className="mb-2 flex items-center gap-2 text-2xs text-neutral-600">
            <span><Trans>说明需要 Agent 修改什么</Trans></span>
            <Button className="ml-auto" size="sm" variant="ghost" onClick={() => {
              setReturningChangeGroupId(null);
              setMessage('');
            }}><Trans>取消</Trans></Button>
          </div>
        )}
        <div className="flex gap-2">
          <input
            ref={messageInput}
            className="h-10 min-w-0 flex-1 rounded-sm border border-divider bg-neutral-50 px-3 text-xs outline-none focus:border-accent-400"
            value={message}
            disabled={chat.streaming || creatingSession || readOnly || !agentReady}
            placeholder={!agentReady
              ? t`先配置 Agent 模型`
              : returningChangeGroupId === null
                ? t`例如：重新规划成 3 分钟 NiKo 集锦`
                : t`例如：删除第二个标记，并保持其他内容不变`}
            onChange={(event) => setMessage(event.currentTarget.value)}
            onKeyDown={(event) => { if (event.key === 'Enter') submit(); }}
          />
          {chat.streaming ? (
            <Button variant="secondary" aria-label={t`停止 Agent`} onClick={chat.cancel}><Square className="size-4" aria-hidden="true" /></Button>
          ) : (
            <Button aria-label={returningChangeGroupId === null ? t`发送给 Agent` : t`发送修改意见`} disabled={message.trim() === '' || creatingSession || readOnly || !agentReady} onClick={submit}><Send className="size-4" aria-hidden="true" /></Button>
          )}
        </div>
      </footer>
    </aside>
  );
}, areAgentPanelPropsEqual);

function areAgentPanelPropsEqual(previous: AgentPanelProps, next: AgentPanelProps): boolean {
  const previousActivity = previous.chat.activity ?? [];
  const nextActivity = next.chat.activity ?? [];
  const sameExecutions = previous.externalExecutions.length === next.externalExecutions.length
    && previous.externalExecutions.every((item, index) => item === next.externalExecutions[index]);
  return previous.showHeader === next.showHeader
    && previous.session === next.session
    && previous.chat.streaming === next.chat.streaming
    && previous.chat.draft === next.chat.draft
    && previous.chat.error === next.chat.error
    && previousActivity === nextActivity
    && previous.creatingSession === next.creatingSession
    && previous.selectedClipId === next.selectedClipId
    && previous.changeGroups === next.changeGroups
    && previous.readOnly === next.readOnly
    && previous.agentReady === next.agentReady
    && previous.agentStatusPending === next.agentStatusPending
    && previous.deliveryReady === next.deliveryReady
    && previous.deliveryGatePending === next.deliveryGatePending
    && previous.confirming === next.confirming
    && previous.projectId === next.projectId
    && previous.projectRevision === next.projectRevision
    && previous.executionActionPending === next.executionActionPending
    && previous.onOpenExternalUrl === next.onOpenExternalUrl
    && sameExecutions;
}

function ConversationEntry({
  entry,
  pendingConfirmationToolCallId,
  confirming,
  deliveryReady,
  deliveryGatePending,
  onConfirmRecording,
  onConfirmExport,
  onRejectConfirmation,
  toolDecisions,
  projectId,
  projectRevision,
  onOpenExternalUrl,
}: {
  readonly entry: AgentSessionEntry;
  readonly pendingConfirmationToolCallId: string | null;
  readonly confirming: boolean;
  readonly deliveryReady: boolean;
  readonly deliveryGatePending: boolean;
  readonly onConfirmRecording: (toolCallId: string, confirmation: ExternalExecutionConfirmation) => Promise<void>;
  readonly onConfirmExport: (toolCallId: string, confirmation: ExternalExecutionConfirmation) => Promise<void>;
  readonly onRejectConfirmation: (toolCallId: string) => Promise<void>;
  readonly toolDecisions: ReadonlyMap<string, ToolDecisionEntry>;
  readonly projectId: string;
  readonly projectRevision: number;
  readonly onOpenExternalUrl: (url: string) => Promise<boolean>;
}) {
  if (entry.kind === 'user') {
    return (
      <ConversationShell actor={t`你`} at={entry.at} tone="human">
        <p className="whitespace-pre-wrap text-xs leading-5">{entry.content}</p>
      </ConversationShell>
    );
  }
  if (entry.kind === 'tool_decision') {
    const changeGroupId = deliveryDecisionChangeGroupId(entry);
    if (changeGroupId === null) return null;
    return (
      <ConversationShell actor={t`你 · 交付审阅`} at={entry.at} tone="human">
        <p className="text-xs font-medium">
          {entry.decision === 'approved' ? <Trans>已接受 Agent 修改</Trans> : <Trans>已要求 Agent 继续修改</Trans>}
        </p>
        <p className="mt-1 text-2xs leading-4 text-neutral-600">{entry.content}</p>
        <span className="mt-1 block font-mono text-2xs text-neutral-400">{changeGroupId}</span>
      </ConversationShell>
    );
  }
  return (
    <ConversationShell actor="Agent" at={entry.at} tone={entry.status === 'failed' ? 'error' : 'agent'}>
      {entry.content.trim() === '' ? null : (
        <AgentMarkdown onOpenExternalUrl={onOpenExternalUrl}>{entry.content}</AgentMarkdown>
      )}
      {entry.tool_calls.map((call) => (
        <ToolCallCard
          key={`${entry.id}:tool:${call.id}`}
          call={call}
          confirmationActive={call.id === pendingConfirmationToolCallId}
          confirming={confirming}
          deliveryReady={deliveryReady}
          deliveryGatePending={deliveryGatePending}
          onConfirmRecording={onConfirmRecording}
          onConfirmExport={onConfirmExport}
          onRejectConfirmation={onRejectConfirmation}
          decision={toolDecisions.get(call.id) ?? null}
          projectId={projectId}
          projectRevision={projectRevision}
        />
      ))}
      {entry.status === 'failed' && entry.error !== null ? <p className="mt-2 text-xs text-fail-text">{entry.error}</p> : null}
    </ConversationShell>
  );
}

function AgentMarkdown({
  children,
  onOpenExternalUrl,
}: {
  readonly children: string;
  readonly onOpenExternalUrl: (url: string) => Promise<boolean>;
}) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        p: ({ children: content }) => <p className="mb-2 whitespace-pre-wrap text-xs leading-5 last:mb-0">{content}</p>,
        ul: ({ children: content }) => <ul className="mb-2 list-disc space-y-1 pl-4 text-xs leading-5 last:mb-0">{content}</ul>,
        ol: ({ children: content }) => <ol className="mb-2 list-decimal space-y-1 pl-4 text-xs leading-5 last:mb-0">{content}</ol>,
        strong: ({ children: content }) => <strong className="font-semibold text-text">{content}</strong>,
        code: ({ children: content }) => <code className="rounded-sm bg-neutral-100 px-1 font-mono text-2xs">{content}</code>,
        table: ({ children: content }) => <div className="mb-2 overflow-x-auto last:mb-0"><table className="w-full border-collapse text-left text-xs leading-5">{content}</table></div>,
        th: ({ children: content }) => <th className="border border-divider bg-neutral-50 px-2 py-1.5 font-semibold text-text">{content}</th>,
        td: ({ children: content }) => <td className="border border-divider px-2 py-1.5 align-top text-neutral-700">{content}</td>,
        a: ({ children: content, href }) => (
          <a
            className="text-accent-text underline underline-offset-2 hover:text-accent-700"
            href={href}
            rel="noreferrer"
            onClick={(event) => {
              event.preventDefault();
              const target = href ?? '';
              void onOpenExternalUrl(target).then((opened) => {
                if (!opened) toast.error(t`无法安全打开这个链接`, { description: target });
              }).catch(() => toast.error(t`无法打开这个链接`, { description: target }));
            }}
          >
            {content}
          </a>
        ),
      }}
    >
      {children}
    </ReactMarkdown>
  );
}


function ConversationShell({
  actor,
  at,
  tone,
  children,
}: {
  readonly actor: string;
  readonly at?: string | undefined;
  readonly tone: 'agent' | 'human' | 'tool' | 'status' | 'delivery' | 'error';
  readonly children: ReactNode;
}) {
  return (
    <li className="relative">
      <span className={cn(
        'absolute -left-[25px] top-1.5 size-2 rounded-full ring-4 ring-bg',
        tone === 'human' ? 'bg-neutral-500' : tone === 'error' ? 'bg-fail-text' : 'bg-accent-600',
      )} />
      <div className={cn(
        'min-w-0',
        tone === 'human' && 'rounded-sm bg-neutral-50 px-3 py-2',
        tone === 'status' && 'rounded-sm border border-accent-200 bg-accent-100 px-3 py-2',
        tone === 'delivery' && 'rounded-sm border border-ok-border bg-ok-surface px-3 py-3',
        tone === 'error' && 'rounded-sm border border-fail-border bg-fail-surface px-3 py-2',
      )}>
        <header className="mb-1.5 flex items-center gap-2 text-2xs text-neutral-400">
          <span className="text-xs font-semibold text-neutral-700">{actor}</span>
          {at === undefined ? null : <time className="ml-auto" dateTime={at}>{conversationTime(at)}</time>}
        </header>
        {children}
      </div>
    </li>
  );
}

function ToolCallCard({
  call,
  decision = null,
  confirmationActive = false,
  confirming = false,
  deliveryReady = false,
  deliveryGatePending = false,
  onConfirmRecording,
  onConfirmExport,
  onRejectConfirmation,
  projectId,
  projectRevision,
}: {
  readonly call: AgentToolCall | ProjectAgentToolActivity;
  readonly decision?: ToolDecisionEntry | null | undefined;
  readonly confirmationActive?: boolean | undefined;
  readonly confirming?: boolean | undefined;
  readonly deliveryReady?: boolean | undefined;
  readonly deliveryGatePending?: boolean | undefined;
  readonly onConfirmRecording?: ((toolCallId: string, confirmation: ExternalExecutionConfirmation) => Promise<void>) | undefined;
  readonly onConfirmExport?: ((toolCallId: string, confirmation: ExternalExecutionConfirmation) => Promise<void>) | undefined;
  readonly onRejectConfirmation?: ((toolCallId: string) => Promise<void>) | undefined;
  readonly projectId: string;
  readonly projectRevision: number;
}) {
  const confirmation = confirmationOf(call);
  const confirmationStale = confirmation !== null
    && (confirmation.projectId !== projectId || confirmation.baseRevision !== projectRevision);
  const running = call.status === 'running';
  const failed = call.status === 'failed';
  const awaitingDecision = confirmation !== null && decision === null;
  const rejected = decision?.decision === 'rejected';
  const approved = decision?.decision === 'approved';
  const exportBlocked = awaitingDecision
    && confirmation?.action === 'export'
    && (deliveryGatePending || !deliveryReady);
  return (
    <article className={cn(
      'mt-2 rounded-md border p-3 text-xs shadow-sm',
      awaitingDecision ? 'border-warn-border bg-warn-surface' : failed ? 'border-fail-border bg-fail-surface' : running ? 'border-accent-200 bg-accent-100' : 'border-divider bg-bg',
    )} data-tool-call-id={call.id} data-tool-call-status={decision?.decision ?? call.status} data-tool-call-decision={decision?.decision}>
      <div className="flex items-center gap-2">
        {rejected
          ? <CircleX className="size-4 text-neutral-500" aria-hidden="true" />
          : awaitingDecision
          ? <CircleAlert className="size-4 text-warn-text" aria-hidden="true" />
          : failed
            ? <CircleAlert className="size-4 text-fail-text" aria-hidden="true" />
            : running
              ? <LoaderCircle className="size-4 animate-spin text-accent-text" aria-hidden="true" />
              : <CheckCircle2 className="size-4 text-ok" aria-hidden="true" />}
        <span className="font-medium">{toolLabel(call)}</span>
        <span className={cn('ml-auto', awaitingDecision ? 'text-warn-text' : rejected ? 'text-neutral-500' : failed ? 'text-fail-text' : running ? 'text-accent-text' : 'text-ok')}>
          {rejected ? <Trans>已拒绝</Trans>
            : approved ? <Trans>已允许</Trans>
            : awaitingDecision
              ? confirmationActive ? <Trans>等待你确认</Trans> : <Trans>等待确认</Trans>
            : failed ? <Trans>执行失败</Trans> : running ? <Trans>执行中</Trans> : <Trans>已完成</Trans>}
        </span>
      </div>
      <p className="mt-1 text-2xs leading-4 text-neutral-600">{decision?.content ?? toolSummary(call)}</p>
      <details className="mt-2">
        <summary className="cursor-pointer select-none text-2xs text-neutral-500"><Trans>查看工具详情</Trans></summary>
        <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap border border-divider bg-bg p-2 font-mono text-2xs">{JSON.stringify({ input: call.input, output: call.output, decision }, null, 2)}</pre>
      </details>
      {!awaitingDecision || !confirmationActive ? null : (
        <div className="mt-3 border-t border-warn-border pt-3">
          <p className="font-medium"><Trans>需要你的确认</Trans></p>
          <p className="mt-1 text-neutral-600">
            {confirmation.action === 'recording'
              ? <Trans>缺失片段已排好录制任务。确认后才会启动 CS2 和采集组件。</Trans>
              : <Trans>成片已准备好导出。确认后才会写出 MP4 文件。</Trans>}
          </p>
          {!confirmationStale ? null : (
            <p className="mt-2 border border-warn-border bg-bg px-2 py-1.5 text-2xs text-warn-text">
              <Trans>作品版本已变化，这次请求已经过期。请拒绝后让 Agent 重新请求。</Trans>
            </p>
          )}
          {!exportBlocked ? null : (
            <p className="mt-2 border border-warn-border bg-bg px-2 py-1.5 text-2xs text-warn-text">
              {deliveryGatePending
                ? <Trans>正在检查当前作品能否交付。</Trans>
                : <Trans>时间线仍有未就绪素材；先录制、重录或重新链接后才能允许导出。</Trans>}
            </p>
          )}
          <div className="mt-2 flex gap-2">
            <Button
              size="sm"
              variant="primary"
              disabled={confirming || exportBlocked || confirmationStale}
              onClick={() => void (confirmation.action === 'recording'
                ? onConfirmRecording?.(call.id, confirmation)
                : onConfirmExport?.(call.id, confirmation))}
            >
              {confirmation.action === 'recording' ? <Trans>允许录制</Trans> : <Trans>允许导出</Trans>}
            </Button>
            <Button size="sm" variant="secondary" disabled={confirming} onClick={() => void onRejectConfirmation?.(call.id)}><Trans>拒绝</Trans></Button>
          </div>
        </div>
      )}
    </article>
  );
}

type ToolDecisionEntry = Extract<AgentSessionEntry, { readonly kind: 'tool_decision' }>;

export function pendingDeliveryGroup(
  changeGroups: readonly ProjectChangeGroup[],
  session: AgentSession | null,
): ProjectChangeGroup | null {
  if (session === null) return null;
  const latestUserAt = [...session.entries].reverse().find((entry) => entry.kind === 'user')?.at ?? null;
  if (latestUserAt === null) return null;
  const decidedGroupIds = new Set(session.entries.flatMap((entry) => {
    const groupId = deliveryDecisionChangeGroupId(entry);
    return groupId === null ? [] : [groupId];
  }));
  return changeGroups.find((group) => (
    group.author.kind === 'agent'
      && group.author.session_id === session.id
      && group.created_at >= latestUserAt
      && !decidedGroupIds.has(group.id)
  )) ?? null;
}

function pendingConfirmationToolCall(entries: readonly AgentSessionEntry[]): string | null {
  const decided = new Set(entries.flatMap((entry) => entry.kind === 'tool_decision' ? [entry.tool_call_id] : []));
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]!;
    if (entry.kind !== 'assistant') continue;
    const call = [...entry.tool_calls].reverse().find((candidate) =>
      confirmationOf(candidate) !== null && !decided.has(candidate.id));
    if (call !== undefined) return call.id;
  }
  return null;
}

export interface ExternalExecutionConfirmation {
  readonly action: 'recording' | 'export';
  readonly projectId: string;
  readonly baseRevision: number;
  readonly clipIds: string[];
}

function confirmationOf(call: AgentToolCall | ProjectAgentToolActivity): ExternalExecutionConfirmation | null {
  if (call.status !== 'awaiting_confirmation' || call.output === null) return null;
  const output = jsonObject(call.output);
  if (output?.status !== 'requires_human_confirmation') return null;
  const action = output.action;
  if (action !== 'recording' && action !== 'export') return null;
  const projectId = output.projectId;
  const baseRevision = output.baseRevision;
  if (typeof projectId !== 'string' || !Number.isSafeInteger(baseRevision) || Number(baseRevision) < 1) return null;
  const input = jsonObject(call.input);
  const rawIds = input?.clipIds;
  const clipIds = Array.isArray(rawIds) ? rawIds.filter((value): value is string => typeof value === 'string') : [];
  return { action, projectId, baseRevision: Number(baseRevision), clipIds };
}

function jsonObject(value: JsonValue): Record<string, JsonValue> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function toolLabel(call: AgentToolCall | ProjectAgentToolActivity): string {
  switch (call.name) {
    case 'read_workspace': return jsonObject(call.input)?.detail === 'timeline'
      ? t`读取时间线详情`
      : t`读取作品摘要`;
    case 'read_demo_evidence': return t`分析 Demo`;
    case 'read_cinematic_context': return t`读取镜头上下文`;
    case 'apply_project_patch': return t`修改时间线`;
    case 'replace_story_timeline': return t`重排时间线`;
    case 'request_project_recording': return t`请求录制片段`;
    case 'request_project_export': return t`请求导出`;
    default: return call.name;
  }
}

function toolSummary(call: AgentToolCall | ProjectAgentToolActivity): string {
  const confirmation = confirmationOf(call);
  if (confirmation?.action === 'recording') return t`还没有开始录制，等你确认。`;
  if (confirmation?.action === 'export') return t`还没有开始导出，等你确认。`;
  if (call.status === 'failed') {
    const error = jsonObject(call.output)?.error;
    return typeof error === 'string' && error.trim() !== ''
      ? error.trim().slice(0, 500)
      : t`工具执行失败，作品没有改动。`;
  }
  if (call.status === 'running') {
    switch (call.name) {
      case 'read_workspace': return jsonObject(call.input)?.detail === 'timeline'
        ? t`正在按目标身份读取可编辑时间线字段…`
        : t`正在读取作品版本和素材概况…`;
      case 'read_demo_evidence': return t`正在读取经过验证的 Demo 事件…`;
      case 'read_cinematic_context': return t`正在读取镜头路径与战术上下文…`;
      case 'apply_project_patch': return t`正在校验并提交增量修改…`;
      case 'replace_story_timeline': return t`正在检查整条 Story 轨道…`;
      default: return t`正在执行工具…`;
    }
  }
  switch (call.name) {
    case 'read_workspace': return jsonObject(call.input)?.detail === 'timeline'
      ? t`已读取目标轨道或片段的可编辑时间线字段。`
      : t`已读取作品版本、轨道和素材概况。`;
    case 'read_demo_evidence': return t`已读取经过验证的 Demo 事件。`;
    case 'read_cinematic_context': return t`已读取镜头路径与战术上下文。`;
    case 'apply_project_patch': return t`修改已写入时间线。`;
    case 'replace_story_timeline': return t`整条 Story 轨道已替换。`;
    default: return t`工具已返回结果。`;
  }
}

function conversationTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
