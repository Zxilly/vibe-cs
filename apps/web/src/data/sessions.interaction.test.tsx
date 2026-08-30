import { act, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type {
  AgentChatInput,
  AgentSession,
  AgentSessionEntry,
  AgentSessionEntryDraft,
  AgentToolCall,
  AgentTurnUpdate,
  Project,
} from '../shared/desktop/dto';
import type { DesktopClientStub } from './desktopClient';
import { useProject } from './projects';
import { useAgentChatStream, useAgentSession, useAppendAgentSessionEntry } from './sessions';
import { renderDataHook } from './test/renderDataHook';

const SESSION_ID = '00000000-0000-4000-8000-000000000001';
const PROJECT_ID = '00000000-0000-4000-8000-000000000002';
const AT = '2026-08-29T00:00:00Z';
const PROJECT: Project = {
  id: PROJECT_ID,
  name: 'Agent Project',
  revision: 1,
  document: {
    width: 1920,
    height: 1080,
    fps: 60,
    duration_seconds: 0,
    story_track_id: '00000000-0000-4000-8000-000000000003',
    tracks: [],
    markers: [],
    settings: { source_demo_ids: [] },
  },
  created_at: AT,
  updated_at: AT,
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

describe('useAgentChatStream', () => {
  it('includes a just-persisted human tool decision when a stale confirmation handler sends the follow-up', async () => {
    const pendingToolCall: AgentToolCall = {
      id: 'request-export:tool:1',
      name: 'request_project_export',
      input: { projectId: PROJECT_ID, baseRevision: 1 },
      output: { status: 'requires_human_confirmation' },
      status: 'awaiting_confirmation',
    };
    let session: AgentSession = {
      id: SESSION_ID,
      title: 'Export confirmation',
      created_at: AT,
      updated_at: AT,
      entries: [{
        kind: 'assistant', id: 'turn-export', at: AT, content: '等待确认',
        tool_calls: [pendingToolCall], status: 'completed', request_id: 'request-export',
        retry_of: null, error: null, metadata: null,
      }],
    };
    const captured: { current: AgentChatInput | null } = { current: null };
    let entrySequence = 0;
    const client: DesktopClientStub = {
      getAgentSession: async () => session,
      appendAgentSessionEntry: async (_sessionId, draft) => {
        entrySequence += 1;
        const entry: AgentSessionEntry = draft.kind === 'user'
          ? { kind: 'user', id: `user-${entrySequence}`, at: AT, content: draft.content }
          : draft.kind === 'tool_decision'
            ? {
                kind: 'tool_decision', id: `decision-${entrySequence}`, at: AT,
                tool_call_id: draft.tool_call_id, decision: draft.decision, content: draft.content,
              }
            : {
                kind: 'assistant', id: `assistant-${entrySequence}`, at: AT, content: draft.content,
                tool_calls: draft.tool_calls, status: draft.status, request_id: draft.request_id,
                retry_of: draft.retry_of, error: draft.error, metadata: draft.metadata,
              };
        session = { ...session, entries: [...session.entries, entry] };
        return entry;
      },
      updateAgentTurn: async (_sessionId, entryId, update) => {
        const entry: AgentSessionEntry = {
          kind: 'assistant', id: entryId, at: AT, request_id: 'follow-up', retry_of: null, ...update,
        };
        session = {
          ...session,
          entries: session.entries.map((candidate) => candidate.id === entryId ? entry : candidate),
        };
        return entry;
      },
      streamAgentChat: async (input) => {
        captured.current = input;
        return { thread_id: 'thread-confirmation' };
      },
    };
    const { result } = renderDataHook(
      () => {
        const sessionQuery = useAgentSession(SESSION_ID);
        return {
          session: sessionQuery,
          append: useAppendAgentSessionEntry(),
          chat: useAgentChatStream({ sessionId: SESSION_ID, history: sessionQuery.data?.entries ?? [] }),
        };
      },
      { client },
    );
    await waitFor(() => expect(result.current.session.isSuccess).toBe(true));

    const sendFromConfirmationRender = result.current.chat.send;
    await act(async () => {
      await result.current.append.mutateAsync({
        sessionId: SESSION_ID,
        draft: {
          kind: 'tool_decision', tool_call_id: pendingToolCall.id,
          decision: 'rejected', content: '拒绝这次外部执行请求。',
        },
      });
      await result.current.append.mutateAsync({
        sessionId: SESSION_ID,
        draft: {
          kind: 'tool_decision',
          tool_call_id: 'delivery:00000000-0000-4000-8000-000000000099',
          decision: 'approved',
          content: '已接受这组 Agent 变更。',
        },
      });
      await sendFromConfirmationRender({ message: '保留时间线并继续。', projectId: PROJECT_ID });
    });

    const decision = captured.current?.history.find((message) => message.content.includes('human_tool_decision'));
    expect(JSON.parse(decision?.content ?? '{}')).toMatchObject({
      type: 'human_tool_decision',
      tool_call_id: pendingToolCall.id,
      decision: 'rejected',
    });
    const deliveryReview = captured.current?.history.find((message) => message.content.includes('human_delivery_review'));
    expect(JSON.parse(deliveryReview?.content ?? '{}')).toEqual({
      type: 'human_delivery_review',
      change_group_id: '00000000-0000-4000-8000-000000000099',
      decision: 'accepted',
      content: '已接受这组 Agent 变更。',
    });
  });

  it('tells the model which prior action claims have no host-verified tool evidence', async () => {
    const priorEntries: AgentSessionEntry[] = [
      { kind: 'user', id: 'prior-user', at: AT, content: '请求导出' },
      {
        kind: 'assistant', id: 'prior-assistant', at: AT,
        content: '导出请求已经提交。', tool_calls: [], status: 'completed',
        request_id: 'prior-request', retry_of: null, error: null, metadata: null,
      },
    ];
    const captured: { current: AgentChatInput | null } = { current: null };
    const client: DesktopClientStub = {
      appendAgentSessionEntry: async (_sessionId, draft) => {
        if (draft.kind === 'user') return { kind: 'user', id: 'next-user', at: AT, content: draft.content };
        if (draft.kind === 'tool_decision') {
          return {
            kind: 'tool_decision', id: 'next-decision', at: AT,
            tool_call_id: draft.tool_call_id, decision: draft.decision, content: draft.content,
          };
        }
        return {
          kind: 'assistant', id: 'next-assistant', at: AT, content: draft.content,
          tool_calls: draft.tool_calls, status: draft.status, request_id: draft.request_id,
          retry_of: draft.retry_of, error: draft.error, metadata: draft.metadata,
        };
      },
      updateAgentTurn: async (_sessionId, entryId, update) => ({
        kind: 'assistant', id: entryId, at: AT, request_id: 'next-request', retry_of: null, ...update,
      }),
      streamAgentChat: async (input) => {
        captured.current = input;
        return { thread_id: 'thread-history' };
      },
    };
    const { result } = renderDataHook(
      () => useAgentChatStream({ sessionId: SESSION_ID, history: priorEntries }),
      { client },
    );

    await act(async () => {
      await result.current.send({ message: '你没有调用工具', projectId: PROJECT_ID });
    });

    const checkpoint = captured.current?.history.find((message) => message.content.includes('prior_turn_tool_evidence'));
    expect(checkpoint?.role).toBe('user');
    expect(JSON.parse(checkpoint?.content ?? '{}')).toMatchObject({
      type: 'prior_turn_tool_evidence',
      assistant_prose: '导出请求已经提交。',
      tool_calls: [],
    });
    expect(captured.current?.history).not.toContainEqual({
      role: 'assistant',
      content: '导出请求已经提交。',
    });
  });

  it('refreshes the Project Head as soon as an Agent edit tool finishes', async () => {
    const finishStream = deferred<void>();
    let projectReads = 0;
    const client: DesktopClientStub = {
      getProject: async () => {
        projectReads += 1;
        return projectReads === 1 ? PROJECT : { ...PROJECT, revision: 2 };
      },
      appendAgentSessionEntry: async (_sessionId, draft) => {
        if (draft.kind === 'user') {
          return { kind: 'user', id: 'user-edit', at: AT, content: draft.content };
        }
        if (draft.kind === 'tool_decision') {
          return {
            kind: 'tool_decision', id: 'decision-edit', at: AT,
            tool_call_id: draft.tool_call_id, decision: draft.decision, content: draft.content,
          };
        }
        return {
          kind: 'assistant', id: 'turn-edit', at: AT, content: draft.content,
          tool_calls: draft.tool_calls, status: draft.status, request_id: draft.request_id,
          retry_of: draft.retry_of, error: draft.error, metadata: draft.metadata,
        };
      },
      updateAgentTurn: async (_sessionId, entryId, update) => ({
        kind: 'assistant', id: entryId, at: AT, request_id: 'request-edit', retry_of: null, ...update,
      }),
      cancelAgentChat: async () => true,
      streamAgentChat: async (_input, onEvent) => {
        onEvent({
          type: 'toolCallFinished',
          toolCall: {
            id: 'request-edit:tool:1',
            name: 'apply_project_patch',
            input: { projectId: PROJECT_ID, baseRevision: 1 },
            output: { status: 'applied', revision: 2 },
            status: 'completed',
          },
        });
        await finishStream.promise;
        return { thread_id: 'thread-edit' };
      },
    };
    const { result } = renderDataHook(
      () => ({
        project: useProject(PROJECT_ID),
        chat: useAgentChatStream({ sessionId: SESSION_ID }),
      }),
      { client },
    );
    await waitFor(() => expect(result.current.project.data?.revision).toBe(1));

    let send!: Promise<void>;
    act(() => {
      send = result.current.chat.send({ message: '修改标记', projectId: PROJECT_ID });
    });

    await waitFor(() => expect(result.current.project.data?.revision).toBe(2));
    expect(result.current.chat.streaming).toBe(true);
    expect(projectReads).toBe(2);

    finishStream.resolve();
    await act(async () => send);
  });

  it('hands a terminal tool call to the durable conversation before clearing its live projection', async () => {
    let session: AgentSession = {
      id: SESSION_ID,
      title: 'Agent lifecycle',
      created_at: AT,
      updated_at: AT,
      entries: [],
    };
    let reads = 0;
    const persist = deferred<void>();
    const refetchStarted = deferred<void>();
    const refetch = deferred<AgentSession>();
    const toolCall: AgentToolCall = {
      id: 'request-1:tool:1',
      name: 'read_workspace',
      input: {},
      output: { revision: 1 },
      status: 'completed',
    };

    const appendAgentSessionEntry = async (_sessionId: string, draft: AgentSessionEntryDraft) => {
      const entry: AgentSessionEntry = draft.kind === 'user'
        ? { kind: 'user', id: 'user-1', at: AT, content: draft.content }
        : draft.kind === 'tool_decision'
          ? {
              kind: 'tool_decision',
              id: 'decision-1',
              at: AT,
              tool_call_id: draft.tool_call_id,
              decision: draft.decision,
              content: draft.content,
            }
          : {
              kind: 'assistant',
              id: 'turn-1',
              at: AT,
              content: draft.content,
              tool_calls: draft.tool_calls,
              status: draft.status,
              request_id: draft.request_id,
              retry_of: draft.retry_of,
              error: draft.error,
              metadata: draft.metadata,
            };
      session = { ...session, entries: [...session.entries, entry] };
      return entry;
    };
    const updateAgentTurn = async (_sessionId: string, entryId: string, update: AgentTurnUpdate) => {
      await persist.promise;
      const entry: AgentSessionEntry = {
        kind: 'assistant',
        id: entryId,
        at: AT,
        request_id: 'request-1',
        retry_of: null,
        ...update,
      };
      session = {
        ...session,
        entries: session.entries.map((candidate) => candidate.id === entryId ? entry : candidate),
      };
      return entry;
    };
    const client: DesktopClientStub = {
      getAgentSession: () => {
        reads += 1;
        if (reads <= 2) return Promise.resolve(session);
        refetchStarted.resolve();
        return refetch.promise;
      },
      appendAgentSessionEntry,
      updateAgentTurn,
      cancelAgentChat: async () => true,
      streamAgentChat: async (_input, onEvent) => {
        onEvent({
          type: 'toolCallStarted',
          toolCall: { id: toolCall.id, name: toolCall.name, input: toolCall.input },
        });
        onEvent({ type: 'toolCallFinished', toolCall });
        return { thread_id: 'thread-1' };
      },
    };

    const { result } = renderDataHook(
      () => ({
        session: useAgentSession(SESSION_ID),
        chat: useAgentChatStream({ sessionId: SESSION_ID }),
      }),
      { client },
    );
    await waitFor(() => expect(result.current.session.isSuccess).toBe(true));

    let send!: Promise<void>;
    act(() => {
      send = result.current.chat.send({ message: '读取作品', projectId: PROJECT_ID });
    });
    await waitFor(() => expect(result.current.chat.activity).toEqual([toolCall]));
    await act(async () => {
      persist.resolve();
      await refetchStarted.promise;
    });

    expect(result.current.chat.activity).toEqual([]);
    expect(result.current.chat.streaming).toBe(false);

    refetch.resolve(session);
    await act(async () => send);
    expect(result.current.session.data?.entries.at(-1)).toMatchObject({
      kind: 'assistant',
      tool_calls: [toolCall],
      status: 'completed',
    });
  });
});
