/**
 * data layer — Agent sessions (spec §2 `data/sessions.ts`, §4.5, §4.6).
 *
 * ## There is no adapter here
 *
 * §4.6 listed ten contract gaps and proposed a short-term frontend adapter with
 * `localStorage` standing in for titles and refs. **That is not what this file
 * is.** The ten routes landed on the backend before this phase started
 * (`crates/application/src/routes/agent_sessions.rs`), so every hook below is a
 * direct call and nothing about a session, a reference or a revision is kept in
 * browser storage. A field the backend does not have is reported as a gap in
 * `pages/agent/agentContract.ts`'s header and omitted from the UI; it is never
 * reconstructed on the client.
 *
 * ## §4.5.1's three lifecycles, and what that means for invalidation
 *
 *   Session    一条对话线程。删除只删对话，它改过的方案、任务、视频全部留下。
 *   Object     方案 / 录制任务 / 剪辑工程 / 输出。存在于会话之外。
 *   Reference  一次操作的双向记录。
 *
 * The invalidation rules follow from those three sentences, and the one that is
 * easiest to get wrong is stated as a prohibition:
 *
 *   **Deleting a session must not invalidate `qk.plans.*`.** The plans it
 *   touched are untouched by the deletion — the server keeps the origin trail,
 *   which captured `session_title` at edit time precisely so it survives (see
 *   `AgentPlanOrigin` in dto.ts). Invalidating plans here would refetch them for
 *   no reason and, worse, would encode 「会话拥有方案」 in the cache, which is
 *   the relationship §4.5.1 says does not exist. `sessions.interaction.test.tsx`
 *   asserts the *absence* of that invalidation.
 *
 * The reverse direction does invalidate both, and for a real reason: touching an
 * object writes a row that both `qk.sessions.detail(id)` (the session's refs)
 * and `qk.sessions.ofObject(kind, id)` (the object's 「改动来源」) read.
 *
 * ## 流式期间 data/ 怎么表达
 *
 * The Agent's reply arrives over the `agent_chat` Tauri `Channel` — the one
 * streaming command in the bridge (§4.7) — not by polling. So:
 *
 *   **The stream is never a query.** A `useQuery` whose data mutates dozens of
 *   times a second would re-render every subscriber of that key, would fight
 *   `staleTime`, and would leave a half-finished answer in the cache when the
 *   window closes. `useAgentChatStream` keeps the in-flight text in React state
 *   in the component that shows it, and the cache learns nothing until the
 *   stream completes.
 *
 *   **The session is the record; the stream is not.** This hook writes the user
 *   entry and a stable assistant turn before opening the channel, then advances
 *   that turn conditionally through streaming/completed/cancelled/failed. It
 *   also sends completed session entries as the model history, so the desktop
 *   thread file is only a request trace rather than a second conversation.
 *   Desktop stamps `plan_id` + `based_on_revision` while capturing each
 *   proposal from the validated request context; this hook stores that base
 *   unchanged and never reconstructs it from whatever plan is open later.
 *
 *   **Every terminal state invalidates.** Cancellation and failure are durable
 *   states with retry identity, not missing assistant messages.
 */

import {
  skipToken,
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';

import type {
  AgentChatInput,
  AgentChatHistoryMessage,
  AgentEvent,
  AgentObjectKind,
  AgentObjectRefTouch,
  AgentProposalDecisionUpdate,
  AgentSessionEntryDraft,
  AgentSessionQuery,
  AgentSessionRetention,
  AgentWorkspaceSettings,
} from '../shared/desktop/dto';
import { useDesktopClient } from './desktopClient';
import { qk } from './keys';
import { resolveQueryTuning, type DataQueryTuning } from './queryTuning';

/* ── reads ───────────────────────────────────────────────────────────────── */

/**
 * The session drawer's list, and its search over title, Demo and player
 * (`AgentSessionQuery.q`). `total` is the drawer's 「共 14 条」 — the server's
 * count, not `items.length`, so a limited page never prints a smaller total.
 *
 * Invalidated by: create / rename / delete / append entry / touch ref / clear /
 * retention → `invalidateSessions`. Every one of those changes either the
 * membership of the list or the `updated_at` it is ordered by.
 */
export function useAgentSessionList(query: AgentSessionQuery = {}, tuning: DataQueryTuning = {}) {
  const client = useDesktopClient();
  return useQuery({
    queryKey: qk.sessions.list(query),
    queryFn: ({ signal }) => client.listAgentSessions(query, signal),
    ...resolveQueryTuning(tuning),
  });
}

/**
 * One session with its entries and its refs — the conversation column.
 *
 * `null` disables the read: 「没有选中会话」 is a real state of `/agent` (the page
 * opens with no `?session=`), not a loading state.
 */
export function useAgentSession(sessionId: string | null, tuning: DataQueryTuning = {}) {
  const client = useDesktopClient();
  return useQuery({
    queryKey: qk.sessions.detail(sessionId ?? ''),
    queryFn:
      sessionId === null
        ? skipToken
        : ({ signal }: { signal: AbortSignal }) => client.getAgentSession(sessionId, signal),
    ...resolveQueryTuning(tuning, { enabled: sessionId !== null }),
  });
}

/**
 * §4.5.1's reverse index: which sessions touched this object, newest first.
 * This is the plan panel's 「改动来源」 and the task detail's equivalent.
 *
 * Note that `AgentObjectSessionRef.session_title` is nullable — a deleted
 * session leaves its reference behind. The row is still rendered; the title is
 * the part that is gone, which is exactly 「删除只删对话」 made visible.
 */
export function useAgentObjectSessions(
  kind: AgentObjectKind,
  objectId: string | null,
  tuning: DataQueryTuning = {},
) {
  const client = useDesktopClient();
  return useQuery({
    queryKey: qk.sessions.ofObject(kind, objectId ?? ''),
    queryFn:
      objectId === null
        ? skipToken
        : ({ signal }: { signal: AbortSignal }) =>
          client.listAgentObjectSessions(kind, objectId, signal),
    ...resolveQueryTuning(tuning, { enabled: objectId !== null }),
  });
}

/**
 * 「工作区里正在进行的」 — the cross-source picker a new session opens with
 * (§4.6 gap 8): pending plans, running recording tasks, edit projects, failed
 * exports.
 *
 * Invalidated by: anything that starts or finishes work. That lives in
 * `tasks.ts` / `outputs.ts`, so this key is *also* refreshed by
 * `invalidateSessions`, and the new-session sheet refetches on open (its data is
 * a snapshot of other domains and 30s of staleness is visible there).
 */
export function useAgentWorkspaceReferences(tuning: DataQueryTuning = {}) {
  const client = useDesktopClient();
  return useQuery({
    queryKey: qk.sessions.workspaceReferences(),
    queryFn: ({ signal }) => client.listAgentWorkspaceReferences(signal),
    ...resolveQueryTuning(tuning),
  });
}

/** 设置 › AI 与 Agent › 会话: retention policy and the per-session take limit. */
export function useAgentWorkspaceSettings(tuning: DataQueryTuning = {}) {
  const client = useDesktopClient();
  return useQuery({
    queryKey: qk.sessions.settings(),
    queryFn: ({ signal }) => client.getAgentWorkspaceSettings(signal),
    ...resolveQueryTuning(tuning),
  });
}

/** 「当前占用 38 MB · 14 条会话」. `plan_bytes` is what a clear will *not* free. */
export function useAgentSessionStorage(tuning: DataQueryTuning = {}) {
  const client = useDesktopClient();
  return useQuery({
    queryKey: qk.sessions.storage(),
    queryFn: ({ signal }) => client.getAgentSessionStorage(signal),
    ...resolveQueryTuning(tuning),
  });
}

/* ── writes ──────────────────────────────────────────────────────────────── */

/**
 * 新建会话. Invalidates the session namespace: the list gains a row and the
 * drawer's total changes. Nothing else is touched — a new session references no
 * object yet, so no plan and no task has changed.
 */
export function useCreateAgentSession() {
  const client = useDesktopClient();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (title: string) => client.createAgentSession(title),
    onSuccess: () => invalidateSessions(queryClient),
  });
}

/**
 * 重命名. Invalidates the namespace rather than the one detail key: the title
 * is printed on the list row, on the drawer's 「当前」 row and inside every
 * `AgentObjectSessionRef` of every object this session touched.
 */
export function useRenameAgentSession() {
  const client = useDesktopClient();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: { sessionId: string; title: string }) =>
      client.renameAgentSession(input.sessionId, input.title),
    onSuccess: () => invalidateSessions(queryClient),
  });
}

/**
 * 删除会话.
 *
 * **Invalidates sessions and nothing else.** 「删除只删对话，它改过的方案、任务、
 * 视频全部留下」 — see this file's header, and the reverse assertion in
 * `sessions.interaction.test.tsx`. The plan's origin trail keeps the title it
 * captured at edit time, so even the 「改动来源」 rows survive with their text
 * intact; only `AgentObjectSessionRef.session_title` goes null, and that read
 * lives under `qk.sessions.*` too.
 */
export function useDeleteAgentSession() {
  const client = useDesktopClient();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (sessionId: string) => client.deleteAgentSession(sessionId),
    onSuccess: () => invalidateSessions(queryClient),
  });
}

/**
 * Appends one entry. `AgentSessionEntryDraft` has no `workspace_edit` member by
 * construction: an edit notice is written by `applyAgentPlanEdit` in the same
 * transaction as the revision bump (§10 deviation 5), never posted separately.
 */
export function useAppendAgentSessionEntry() {
  const client = useDesktopClient();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: { sessionId: string; draft: AgentSessionEntryDraft }) =>
      client.appendAgentSessionEntry(input.sessionId, input.draft),
    onSuccess: () => invalidateSessions(queryClient),
  });
}

/** Persists one proposal-change review decision in its owning session entry. */
export function useSetAgentProposalDecision() {
  const client = useDesktopClient();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: { sessionId: string; update: AgentProposalDecisionUpdate }) =>
      client.setAgentProposalDecision(input.sessionId, input.update),
    onSuccess: (session) => {
      queryClient.setQueryData(qk.sessions.detail(session.id), session);
      return invalidateSessions(queryClient);
    },
  });
}

/**
 * Records that this session touched this object — 「引用」 in the new-session
 * sheet, and the implicit touch when a plan is edited from a session.
 *
 * Invalidates both directions of §4.5.1's bidirectional record: the session's
 * `refs` and the object's session list. The object itself is untouched — a
 * reference is a record *about* an edit, not an edit.
 */
export function useTouchAgentObjectRef() {
  const client = useDesktopClient();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: { sessionId: string; touch: AgentObjectRefTouch }) =>
      client.touchAgentObjectRef(input.sessionId, input.touch),
    onSuccess: (_ref, input) =>
      Promise.all([
        invalidateSessions(queryClient),
        invalidateObjectSessions(queryClient, input.touch.kind, input.touch.id),
      ]).then(() => undefined),
  });
}

/**
 * 设置 › 会话 › 保留多久 and the take limit. Invalidates the settings key and
 * the storage stats: changing retention does not itself delete anything (that
 * is `applyAgentSessionRetention`), but the panel prints what the current policy
 * would keep.
 */
export function useUpdateAgentWorkspaceSettings() {
  const client = useDesktopClient();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (settings: AgentWorkspaceSettings) =>
      client.updateAgentWorkspaceSettings(settings),
    onSuccess: (settings) => {
      queryClient.setQueryData(qk.sessions.settings(), settings);
      return queryClient.invalidateQueries({ queryKey: qk.sessions.storage() });
    },
  });
}

/**
 * 导出. A read-shaped action that is a mutation because it is expensive and
 * user-initiated (60s timeout on the route). It changes nothing, so it
 * invalidates nothing — see `tasks.ts`'s `planRecordingRetry` for the same
 * decision and the test that pins it.
 */
export function useExportAgentSessions() {
  const client = useDesktopClient();
  return useMutation({ mutationFn: () => client.exportAgentSessions() });
}

/**
 * 清空会话. Removes conversations only — `AgentSessionStorageStats.plan_bytes`
 * is the part it cannot free, and the settings panel says so. Invalidates the
 * session namespace, and not plans, for the same reason `useDeleteAgentSession`
 * does not.
 */
export function useClearAgentSessions() {
  const client = useDesktopClient();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: () => client.clearAgentSessions(),
    onSuccess: () => invalidateSessions(queryClient),
  });
}

/** Applies the stored retention policy now, rather than at the next sweep. */
export function useApplyAgentSessionRetention() {
  const client = useDesktopClient();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: () => client.applyAgentSessionRetention(),
    onSuccess: () => invalidateSessions(queryClient),
  });
}

/* ── the streaming reply ─────────────────────────────────────────────────── */

/** What the composer hands `send`. Everything but the text is context. */
export interface AgentChatSend {
  readonly message: string;
  /** Overrides the selected session for the first atomic create-and-send action. */
  readonly sessionId?: string | undefined;
  /** Failed/cancelled assistant entry this new turn retries. */
  readonly retryOf?: string | null | undefined;
  readonly mode?: AgentChatInput['mode'];
  readonly demoId?: string | null;
  readonly editorProjectId?: string | null;
  readonly audioAssetId?: string | null;
  readonly workspaceContext?: Partial<AgentChatInput['workspaceContext']>;
}

export interface AgentChatStream {
  /** `true` from the moment `send` is called until complete / error / cancel. */
  readonly streaming: boolean;
  /** The assistant text accumulated so far. Never written to the cache. */
  readonly draft: string;
  /** The service's message when the stream failed, for an in-place Notice. */
  readonly error: string | null;
  send: (input: AgentChatSend) => Promise<void>;
  cancel: () => void;
}

export interface AgentChatStreamOptions {
  /** The session the two entries are appended to. `null` disables `send`. */
  readonly sessionId: string | null;
  /** Durable session transcript used as model history; failed/cancelled turns are excluded. */
  readonly history?: readonly import('../shared/desktop/dto').AgentSessionEntry[] | undefined;
}

/**
 * One in-flight `agent_chat` request, plus the two session writes around it.
 *
 * Held by the page shell, not by a bubble list — see `agentContract.ts`. The
 * text lives in state here and reaches the cache only at `complete`.
 */
export function useAgentChatStream(options: AgentChatStreamOptions): AgentChatStream {
  const client = useDesktopClient();
  const queryClient = useQueryClient();
  const [streaming, setStreaming] = useState(false);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const requestIdRef = useRef<string | null>(null);
  const turnRef = useRef<{
    readonly sessionId: string;
    readonly entryId: string;
    readonly status: 'pending' | 'streaming';
  } | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    // Set on entry as well as cleared on exit: an effect that only cleared it
    // would leave the hook permanently mute after React re-ran the effect
    // (strict mode does exactly that on mount).
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      // Leaving the page must not leave a request running in the backend.
      if (requestIdRef.current !== null) void client.cancelAgentChat(requestIdRef.current);
      const turn = turnRef.current;
      turnRef.current = null;
      if (turn !== null) {
        void client.updateAgentTurn(turn.sessionId, turn.entryId, {
          expected_status: turn.status,
          status: 'cancelled',
          content: '',
          tool_calls: [],
          proposals: [],
          error: null,
        }).then(() => invalidateSessions(queryClient));
      }
    };
  }, [client, queryClient]);

  const cancel = useCallback(() => {
    const requestId = requestIdRef.current;
    if (requestId === null) return;
    requestIdRef.current = null;
    setStreaming(false);
    void client.cancelAgentChat(requestId);
    const turn = turnRef.current;
    turnRef.current = null;
    if (turn !== null) {
      void client.updateAgentTurn(turn.sessionId, turn.entryId, {
        expected_status: turn.status,
        status: 'cancelled',
        content: '',
        tool_calls: [],
        proposals: [],
        error: null,
      }).then(() => invalidateSessions(queryClient));
    }
  }, [client, queryClient]);

  const sessionId = options.sessionId;
  const history = options.history ?? [];

  const send = useCallback(
    async (input: AgentChatSend) => {
      const targetSessionId = input.sessionId ?? sessionId;
      if (targetSessionId === null || streaming) return;

      const requestId = createRequestId();
      requestIdRef.current = requestId;
      setStreaming(true);
      setDraft('');
      setError(null);

      // The user entry is written first, so a failed stream still leaves the
      // question in the transcript rather than losing what the user typed.
      await client.appendAgentSessionEntry(targetSessionId, {
        kind: 'user',
        content: input.message,
      });
      const activeTurn = await client.appendAgentSessionEntry(targetSessionId, {
        kind: 'assistant',
        content: '',
        tool_calls: [],
        proposals: [],
        status: 'streaming',
        request_id: requestId,
        retry_of: input.retryOf ?? null,
        error: null,
      });
      if (activeTurn.kind !== 'assistant') {
        throw new Error('agent turn creation did not return an assistant entry');
      }
      turnRef.current = { sessionId: targetSessionId, entryId: activeTurn.id, status: 'streaming' };
      await invalidateSessions(queryClient);

      let text = '';
      const toolCalls: AgentChatEventPayload['toolCalls'] = [];
      const proposals: AgentChatEventPayload['proposals'] = [];
      const completionMetadata = {
        current: null as Extract<AgentEvent, { type: 'complete' }>['metadata'] | null,
      };
      let failure: string | null = null;

      const onEvent = (event: AgentEvent) => {
        switch (event.type) {
          case 'textDelta':
            text += event.delta;
            if (mountedRef.current) setDraft(text);
            break;
          case 'toolCall':
            toolCalls.push(event.toolCall);
            break;
          case 'proposal':
            proposals.push(event.proposal);
            break;
          case 'error':
            failure = event.message;
            break;
          case 'complete':
            completionMetadata.current = event.metadata;
            break;
          default:
            break;
        }
      };

      try {
        await client.streamAgentChat(
          buildChatInput(requestId, targetSessionId, input, history),
          onEvent,
        );
      } catch (cause) {
        failure = messageOf(cause);
      }

      // `cancel` clears the ref, so this is how a cancelled request is told
      // apart from one that finished. A cancelled reply is not written to the
      // session: the user stopped it, and half an answer stored as the Agent's
      // word would be read back as the Agent's word.
      const cancelled = requestIdRef.current !== requestId;
      requestIdRef.current = null;

      if (cancelled) {
        if (mountedRef.current) {
          setStreaming(false);
          setDraft('');
        }
        return;
      }

      if (failure !== null) {
        const turn = turnRef.current;
        turnRef.current = null;
        if (turn !== null) {
          await client.updateAgentTurn(turn.sessionId, turn.entryId, {
            expected_status: turn.status,
            status: 'failed',
            content: text,
            tool_calls: toolCalls.map((call) => ({
              name: call.name, input: call.input, output: call.output,
            })),
            proposals: [],
            error: failure,
          });
          await invalidateSessions(queryClient);
        }
        if (mountedRef.current) {
          setError(failure);
          setStreaming(false);
        }
        return;
      }

      const turn = turnRef.current;
      turnRef.current = null;
      if (turn === null) return;
      await client.updateAgentTurn(turn.sessionId, turn.entryId, {
        expected_status: turn.status,
        status: 'completed',
        content: text,
        tool_calls: toolCalls.map((call) => ({
          name: call.name,
          input: call.input,
          output: call.output,
        })),
        proposals: proposals.map((item) => ({
          kind: item.kind,
          title: item.title,
          plan_id: item.planId,
          based_on_revision: item.basedOnRevision,
          payload: item.payload,
        })),
        error: null,
        metadata: completionMetadata.current === null ? null : {
          provider: completionMetadata.current.provider,
          model: completionMetadata.current.model,
          input_tokens: completionMetadata.current.inputTokens,
          output_tokens: completionMetadata.current.outputTokens,
          total_tokens: completionMetadata.current.totalTokens,
          cached_input_tokens: completionMetadata.current.cachedInputTokens,
          reasoning_tokens: completionMetadata.current.reasoningTokens,
          estimated_cost_usd: completionMetadata.current.estimatedCostUsd,
        },
      });
      await Promise.all([
        invalidateSessions(queryClient),
        input.workspaceContext?.planId === undefined
          || input.workspaceContext.planId === null
          ? Promise.resolve()
          : queryClient.invalidateQueries({ queryKey: qk.plans.all }),
      ]);

      if (mountedRef.current) {
        setStreaming(false);
        setDraft('');
      }
    },
    [client, history, queryClient, sessionId, streaming],
  );

  return { streaming, draft, error, send, cancel };
}

type AgentChatEventPayload = {
  toolCalls: Array<Extract<AgentEvent, { type: 'toolCall' }>['toolCall']>;
  proposals: Array<Extract<AgentEvent, { type: 'proposal' }>['proposal']>;
};

function buildChatInput(
  requestId: string,
  sessionId: string,
  input: AgentChatSend,
  entries: readonly import('../shared/desktop/dto').AgentSessionEntry[],
): AgentChatInput {
  const context = input.workspaceContext ?? {};
  return {
    requestId,
    // The embedded thread uses the durable session identity, but the explicit
    // session history below remains the model-history authority.
    threadId: sessionId,
    demoId: input.demoId ?? null,
    editorProjectId: input.editorProjectId ?? null,
    audioAssetId: input.audioAssetId ?? null,
    workspaceContext: {
      workflow: context.workflow ?? 'edit',
      destination: context.destination ?? 'neutral',
      demoId: context.demoId ?? input.demoId ?? null,
      projectId: context.projectId ?? input.editorProjectId ?? null,
      planId: context.planId ?? null,
      planRevision: context.planRevision ?? null,
      playerId: context.playerId ?? null,
      roundNumber: context.roundNumber ?? null,
      tick: context.tick ?? null,
    },
    history: sessionHistory(entries),
    mode: input.mode ?? 'edit',
    message: input.message,
  };
}

function sessionHistory(
  entries: readonly import('../shared/desktop/dto').AgentSessionEntry[],
): AgentChatHistoryMessage[] {
  const history: AgentChatHistoryMessage[] = [];
  for (const entry of entries) {
    if (entry.kind === 'user' && entry.content.trim() !== '') {
      history.push({ role: 'user', content: entry.content });
    } else if (
      entry.kind === 'assistant'
      && (entry.status === undefined || entry.status === null || entry.status === 'completed')
      && entry.content.trim() !== ''
    ) {
      history.push({ role: 'assistant', content: entry.content });
    }
  }
  return history.slice(-40);
}

function createRequestId(): string {
  const uuid = globalThis.crypto?.randomUUID;
  if (typeof uuid === 'function') return globalThis.crypto.randomUUID();
  const hex = (length: number): string =>
    Array.from({ length }, () => Math.floor(Math.random() * 16).toString(16)).join('');
  return `${hex(8)}-${hex(4)}-4${hex(3)}-a${hex(3)}-${hex(12)}`;
}

function messageOf(cause: unknown): string {
  if (cause instanceof Error && cause.message !== '') return cause.message;
  return String(cause);
}

/* ── invalidation ────────────────────────────────────────────────────────── */

/**
 * The whole session namespace: list, detail, reverse index, referencable
 * objects, settings and storage. They move together often enough — appending
 * one entry changes the detail, the list's `updated_at` order and the drawer's
 * preview — that a narrower call would be a bug waiting for the next feature.
 */
export function invalidateSessions(client: QueryClient): Promise<void> {
  return client.invalidateQueries({ queryKey: qk.sessions.all });
}

/** One session, for the rare write that provably touches nothing else. */
export function invalidateSession(client: QueryClient, sessionId: string): Promise<void> {
  return client.invalidateQueries({ queryKey: qk.sessions.detail(sessionId) });
}

/** One object's 「改动来源」 list — the reverse half of §4.5.1. */
export function invalidateObjectSessions(
  client: QueryClient,
  kind: AgentObjectKind,
  objectId: string,
): Promise<void> {
  return client.invalidateQueries({ queryKey: qk.sessions.ofObject(kind, objectId) });
}

/* ── helpers ─────────────────────────────────────────────────────────────── */

/**
 * The retention policy as one comparable string, for a `Seg` whose options are
 * 全部保留 / 最近 50 条 / 30 天 / 不保留. `AgentSessionRetention` is a tagged
 * union with a payload, and a segmented control needs a scalar; doing the
 * flattening here keeps the settings block from inventing a second encoding.
 */
export function retentionOptionId(retention: AgentSessionRetention): string {
  switch (retention.mode) {
    case 'recent_count':
      return `recent_count:${String(retention.count)}`;
    case 'max_age_days':
      return `max_age_days:${String(retention.days)}`;
    default:
      return retention.mode;
  }
}
