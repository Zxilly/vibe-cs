import { act, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type {
  AgentSession,
  AgentSessionEntry,
  AgentSessionEntryDraft,
  AgentToolCall,
  AgentTurnUpdate,
} from '../shared/desktop/dto';
import type { DesktopClientStub } from './desktopClient';
import { useAgentChatStream, useAgentSession } from './sessions';
import { renderDataHook } from './test/renderDataHook';

const SESSION_ID = '00000000-0000-4000-8000-000000000001';
const PROJECT_ID = '00000000-0000-4000-8000-000000000002';
const AT = '2026-08-29T00:00:00Z';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

describe('useAgentChatStream', () => {
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
