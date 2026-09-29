/**
 * Durable AgentSession queries and the renderer Adapter for the host-owned Agent turn.
 * The host persists requests, terminal replies and tool evidence before returning them.
 * This Module holds only the live projection and sends instruction/cancel intents.
 */

import { t } from '@lingui/core/macro';
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
  AgentEvent,
  AgentSession,
  AgentSessionEntry,
  AgentToolCall,
  AgentToolCallStarted,
  AgentToolCallStatus,
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
/**
 * Records that this session touched this object — 「引用」 in the new-session
 * sheet, and the implicit touch when a plan is edited from a session.
 *
 * Invalidates both directions of §4.5.1's bidirectional record: the session's
 * `refs` and the object's session list. The object itself is untouched — a
 * reference is a record *about* an edit, not an edit.
 */
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
 * invalidates nothing.
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
  readonly projectId: string;
  readonly workspaceContext?: Partial<AgentChatInput['workspaceContext']>;
}

export interface AgentChatStream {
  /** `true` from the moment `send` is called until complete / error / cancel. */
  readonly streaming: boolean;
  /** The assistant text accumulated so far. Never written to the cache. */
  readonly draft: string;
  /** The service's message when the stream failed, for an in-place Notice. */
  readonly error: string | null;
  /** Completed structured tool calls from the in-flight turn, in execution order. */
  readonly activity?: readonly AgentToolActivity[] | undefined;
  send: (input: AgentChatSend) => Promise<void>;
  cancel: () => void;
}

export interface AgentToolActivity {
  readonly id: string;
  readonly name: string;
  readonly input: import('../shared/desktop/dto').JsonValue;
  readonly output: import('../shared/desktop/dto').JsonValue | null;
  readonly status: AgentToolCallStatus | 'running';
}

export interface AgentChatStreamOptions {
  /** The durable session to continue. `null` disables `send`. */
  readonly sessionId: string | null;
}

/** One live projection of a Desktop-owned Agent turn. */
export function useAgentChatStream(options: AgentChatStreamOptions): AgentChatStream {
  const client = useDesktopClient();
  const queryClient = useQueryClient();
  const [streaming, setStreaming] = useState(false);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [activity, setActivity] = useState<readonly AgentToolActivity[]>([]);
  const requestIdRef = useRef<string | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      const requestId = requestIdRef.current;
      requestIdRef.current = null;
      if (requestId !== null) {
        void client.cancelAgentChat(requestId).catch((cause: unknown) => {
          console.error('Unable to stop the Agent while leaving the workspace', cause);
        });
      }
    };
  }, [client]);

  const cancel = useCallback(() => {
    const requestId = requestIdRef.current;
    if (requestId === null) return;
    // Keep the live projection until the host confirms its durable terminal turn.
    void client.cancelAgentChat(requestId).catch((cause: unknown) => {
      if (mountedRef.current && requestIdRef.current === requestId) {
        const detail = messageOf(cause);
        setError(t`停止 Agent 时发生错误：${detail}`);
      }
    });
  }, [client]);

  const sessionId = options.sessionId;
  const send = useCallback(async (input: AgentChatSend) => {
    const targetSessionId = input.sessionId ?? sessionId;
    if (targetSessionId === null || requestIdRef.current !== null) return;
    const requestId = createRequestId();
    requestIdRef.current = requestId;
    setStreaming(true);
    setDraft('');
    setError(null);
    setActivity([]);
    let text = '';
    try {
      const result = await client.streamAgentChat(buildChatInput(requestId, targetSessionId, input), (event: AgentEvent) => {
        if (requestIdRef.current !== requestId) return;
        switch (event.type) {
          case 'started':
            void invalidateSessions(queryClient);
            break;
          case 'textDelta':
            text += event.delta;
            if (mountedRef.current) setDraft(text);
            break;
          case 'toolCallStarted':
            if (mountedRef.current) setActivity((current) => upsertToolActivity(current, runningToolActivity(event.toolCall)));
            break;
          case 'toolCallFinished':
            if (mountedRef.current) setActivity((current) => upsertToolActivity(current, event.toolCall));
            if (event.toolCall.status === 'completed' && projectMutatingTool(event.toolCall.name)) {
              void invalidateAgentProject(queryClient, input.projectId);
            }
            break;
          case 'complete':
            cacheAgentTurn(queryClient, targetSessionId, event.turn);
            break;
        }
      });
      // The returned turn is already durable, including cancellation and provider failures.
      cacheAgentTurn(queryClient, result.sessionId, result.turn);
      if (requestIdRef.current === requestId && mountedRef.current) {
        setError(result.turn.kind === 'assistant' ? result.turn.error : null);
        setDraft('');
      }
    } catch (cause) {
      if (requestIdRef.current === requestId && mountedRef.current) {
        const detail = messageOf(cause);
        setError(t`对话保存失败，请重试。${detail}`);
      }
      throw cause;
    } finally {
      if (requestIdRef.current === requestId) {
        requestIdRef.current = null;
        if (mountedRef.current) {
          setStreaming(false);
          setActivity([]);
        }
      }
      await Promise.all([
        invalidateSessions(queryClient),
        invalidateAgentProject(queryClient, input.projectId),
      ]);
    }
  }, [client, queryClient, sessionId]);

  return { streaming, draft, error, activity, send, cancel };
}

function runningToolActivity(call: AgentToolCallStarted): AgentToolActivity {
  return { ...call, output: null, status: 'running' };
}

function upsertToolActivity(
  activity: readonly AgentToolActivity[],
  call: AgentToolActivity | AgentToolCall,
): AgentToolActivity[] {
  const next = [...activity];
  const index = next.findIndex((candidate) => candidate.id === call.id);
  if (index < 0) next.push(call);
  else next[index] = call;
  return next;
}

function projectMutatingTool(name: string): boolean {
  return name === 'apply_project_patch' || name === 'replace_story_timeline';
}

function invalidateAgentProject(queryClient: QueryClient, projectId: string): Promise<void> {
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: qk.projects.detail(projectId) }),
    queryClient.invalidateQueries({ queryKey: qk.projects.changeGroups(projectId) }),
    queryClient.invalidateQueries({ queryKey: qk.projects.editLease(projectId) }),
  ]).then(() => undefined);
}

function cacheAgentTurn(
  queryClient: QueryClient,
  sessionId: string,
  turn: AgentSessionEntry,
): void {
  queryClient.setQueryData<AgentSession>(qk.sessions.detail(sessionId), (session) => {
    if (session === undefined) return session;
    const index = session.entries.findIndex((entry) => entry.id === turn.id);
    const entries = [...session.entries];
    if (index < 0) entries.push(turn);
    else entries[index] = turn;
    return { ...session, updated_at: turn.at, entries };
  });
}

function buildChatInput(
  requestId: string,
  sessionId: string,
  input: AgentChatSend,
): AgentChatInput {
  const context = input.workspaceContext ?? {};
  return {
    requestId,
    sessionId,
    projectId: input.projectId,
    retryOf: input.retryOf ?? null,
    workspaceContext: {
      projectId: context.projectId ?? input.projectId,
      lens: context.lens ?? 'quick',
      selectedClipId: context.selectedClipId ?? null,
      selectedClipIds: context.selectedClipIds ?? [],
      targetTrackId: context.targetTrackId ?? null,
      targetTrackIds: context.targetTrackIds ?? [],
      playheadSeconds: context.playheadSeconds ?? null,
      rangeInSeconds: context.rangeInSeconds ?? null,
      rangeOutSeconds: context.rangeOutSeconds ?? null,
    },
    message: input.message,
  };
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
