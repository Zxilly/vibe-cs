/*
 * `interaction` project — `useAgentChatStream`, the bridge between the
 * streaming `agent_chat` command and the session store.
 *
 * The two stores are separate on the backend (`AgentChatInput` has `threadId`,
 * not `sessionId`), so this hook is what puts the conversation into the session
 * — and it is the only place that can stamp a proposal with the revision the
 * model was answering about. Both facts are asserted here, because §4.5.3 rule
 * ③ has nothing to compare against if the stamp is missing.
 */

import { act, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type {
  AgentChatInput,
  AgentEvent,
  AgentSession,
  AgentSessionEntry,
  AgentSessionEntryDraft,
} from '../shared/desktop/dto';
import type { DesktopClientStub } from './desktopClient';
import { useAgentChatStream, useAgentSession } from './sessions';
import { renderDataHook } from './test/renderDataHook';

const SESSION: AgentSession = {
  id: 'S-1',
  title: 'Kael 的 1v3',
  created_at: '2026-08-15T09:02:00.000Z',
  updated_at: '2026-08-15T09:47:00.000Z',
  entries: [],
  refs: [],
};

const ENTRY: AgentSessionEntry = {
  kind: 'user',
  id: 'e-1',
  at: '2026-08-15T09:47:00.000Z',
  content: '把它压到 30 秒以内',
};

function stubClient(events: AgentEvent[]) {
  const drafts: AgentSessionEntryDraft[] = [];
  const inputs: AgentChatInput[] = [];
  let sessionReads = 0;

  const client: DesktopClientStub = {
    getAgentSession: () => {
      sessionReads += 1;
      return Promise.resolve(SESSION);
    },
    appendAgentSessionEntry: (_sessionId: string, draft: AgentSessionEntryDraft) => {
      drafts.push(draft);
      return Promise.resolve(ENTRY);
    },
    streamAgentChat: (input: AgentChatInput, onEvent: (event: AgentEvent) => void) => {
      inputs.push(input);
      for (const event of events) onEvent(event);
      return Promise.resolve({ thread_id: 'T-1' });
    },
  };

  return { client, drafts, inputs, sessionReads: () => sessionReads };
}

describe('useAgentChatStream', () => {
  it('writes the question first, streams, then writes the answer', async () => {
    const { client, drafts } = stubClient([
      { type: 'started', threadId: 'T-1' },
      { type: 'textDelta', delta: '我把第 2 个镜头' },
      { type: 'textDelta', delta: '从 Dolly 改成了 Tracking。' },
      { type: 'complete', thread: { id: 'T-1', messages: [], updatedAt: '' } },
    ]);

    const { result } = renderDataHook(
      () => useAgentChatStream({ sessionId: 'S-1', plan: { id: 'P-118', revision: 7 } }),
      { client },
    );

    await act(async () => {
      await result.current.send({ message: '把它压到 30 秒以内' });
    });

    expect(drafts).toHaveLength(2);
    expect(drafts[0]).toEqual({ kind: 'user', content: '把它压到 30 秒以内' });
    expect(drafts[1]).toMatchObject({
      kind: 'assistant',
      content: '我把第 2 个镜头从 Dolly 改成了 Tracking。',
    });
    // The in-flight text never became cache state, and is cleared once the
    // transcript is the record.
    expect(result.current.draft).toBe('');
    expect(result.current.streaming).toBe(false);
  });

  it('stamps every proposal with the plan revision the model saw', async () => {
    const { client, drafts } = stubClient([
      {
        type: 'proposal',
        proposal: { kind: 'highlight_edit', title: '压到 30 秒', payload: { changes: [] } },
      },
      { type: 'complete', thread: { id: 'T-1', messages: [], updatedAt: '' } },
    ]);

    const { result } = renderDataHook(
      () => useAgentChatStream({ sessionId: 'S-1', plan: { id: 'P-118', revision: 6 } }),
      { client },
    );

    await act(async () => {
      await result.current.send({ message: '压一压' });
    });

    const assistant = drafts[1];
    expect(assistant?.kind).toBe('assistant');
    if (assistant?.kind !== 'assistant') throw new Error('expected an assistant draft');
    expect(assistant.proposals).toEqual([
      {
        kind: 'highlight_edit',
        title: '压到 30 秒',
        plan_id: 'P-118',
        based_on_revision: 6,
        payload: { changes: [] },
      },
    ]);
  });

  it('leaves the stamp null when no plan is open, rather than guessing one', async () => {
    const { client, drafts } = stubClient([
      {
        type: 'proposal',
        proposal: { kind: 'video_render', title: '生成视频', payload: null },
      },
      { type: 'complete', thread: { id: 'T-1', messages: [], updatedAt: '' } },
    ]);

    const { result } = renderDataHook(() => useAgentChatStream({ sessionId: 'S-1' }), { client });

    await act(async () => {
      await result.current.send({ message: '随便聊聊' });
    });

    const assistant = drafts[1];
    if (assistant?.kind !== 'assistant') throw new Error('expected an assistant draft');
    expect(assistant.proposals[0]).toMatchObject({ plan_id: null, based_on_revision: null });
  });

  it('refreshes the transcript once the answer is stored', async () => {
    const { client, sessionReads } = stubClient([
      { type: 'textDelta', delta: '好' },
      { type: 'complete', thread: { id: 'T-1', messages: [], updatedAt: '' } },
    ]);

    const { result } = renderDataHook(
      () => ({
        session: useAgentSession('S-1'),
        chat: useAgentChatStream({ sessionId: 'S-1' }),
      }),
      { client },
    );

    await waitFor(() => {
      expect(result.current.session.isSuccess).toBe(true);
    });
    const before = sessionReads();

    await act(async () => {
      await result.current.chat.send({ message: '压一压' });
    });

    await waitFor(() => {
      expect(sessionReads()).toBeGreaterThan(before);
    });
  });

  it('keeps the question in the transcript when the stream fails', async () => {
    const { client, drafts } = stubClient([{ type: 'error', message: '模型未配置' }]);

    const { result } = renderDataHook(() => useAgentChatStream({ sessionId: 'S-1' }), { client });

    await act(async () => {
      await result.current.send({ message: '压一压' });
    });

    // The user entry was written; no assistant entry was invented for it.
    expect(drafts).toHaveLength(1);
    expect(drafts[0]?.kind).toBe('user');
    expect(result.current.error).toBe('模型未配置');
    expect(result.current.streaming).toBe(false);
  });

  it('stores nothing for a reply the user stopped', async () => {
    /* The stub calls back synchronously, so cancelling from inside the first
       delta is the same race the real channel has: the request is already in
       flight when the user presses stop. */
    const drafts: AgentSessionEntryDraft[] = [];
    let cancelledRequest: string | null = null;
    let stop: (() => void) | null = null;

    const client: DesktopClientStub = {
      appendAgentSessionEntry: (_sessionId: string, draft: AgentSessionEntryDraft) => {
        drafts.push(draft);
        return Promise.resolve(ENTRY);
      },
      cancelAgentChat: (requestId: string) => {
        cancelledRequest = requestId;
        return Promise.resolve(true);
      },
      streamAgentChat: (_input: AgentChatInput, onEvent: (event: AgentEvent) => void) => {
        onEvent({ type: 'textDelta', delta: '我把第 2 个镜头' });
        stop?.();
        onEvent({ type: 'complete', thread: { id: 'T-1', messages: [], updatedAt: '' } });
        return Promise.resolve({ thread_id: 'T-1' });
      },
    };

    const { result } = renderDataHook(() => useAgentChatStream({ sessionId: 'S-1' }), { client });
    stop = () => {
      result.current.cancel();
    };

    await act(async () => {
      await result.current.send({ message: '压一压' });
    });

    expect(cancelledRequest).not.toBeNull();
    // The question stays; no assistant entry was written for a stopped reply.
    expect(drafts).toHaveLength(1);
    expect(drafts[0]?.kind).toBe('user');
    expect(result.current.streaming).toBe(false);
    expect(result.current.draft).toBe('');
  });

  it('does nothing at all without a session to write into', async () => {
    const { client, drafts, inputs } = stubClient([]);
    const { result } = renderDataHook(() => useAgentChatStream({ sessionId: null }), { client });

    await act(async () => {
      await result.current.send({ message: '压一压' });
    });

    expect(drafts).toEqual([]);
    expect(inputs).toEqual([]);
  });

  it('uses a newly-created session override for the atomic first send', async () => {
    const { client, drafts, inputs } = stubClient([
      { type: 'complete', thread: { id: 'T-1', messages: [], updatedAt: '' } },
    ]);
    const { result } = renderDataHook(() => useAgentChatStream({ sessionId: null }), { client });

    await act(async () => {
      await result.current.send({ message: '做一条 40 秒残局集锦', sessionId: 'S-new' });
    });

    expect(drafts.map((draft) => draft.kind)).toEqual(['user', 'assistant']);
    expect(inputs).toHaveLength(1);
  });

  it('sends the workspace context the caller gave it, and no thread of its own', async () => {
    const { client, inputs } = stubClient([
      { type: 'complete', thread: { id: 'T-1', messages: [], updatedAt: '' } },
    ]);

    const { result } = renderDataHook(() => useAgentChatStream({ sessionId: 'S-1' }), { client });

    await act(async () => {
      await result.current.send({
        message: '第 3 个镜头前面留 1 秒',
        demoId: 'demo-1',
        workspaceContext: {
          projectId: 'plan:P-118',
          planId: 'P-118',
          planRevision: 6,
          playerId: 'STEAM_1',
          roundNumber: 21,
        },
      });
    });

    expect(inputs[0]?.threadId).toBeNull();
    expect(inputs[0]?.demoId).toBe('demo-1');
    expect(inputs[0]?.workspaceContext).toMatchObject({
      demoId: 'demo-1',
      projectId: 'plan:P-118',
      planId: 'P-118',
      planRevision: 6,
      playerId: 'STEAM_1',
      roundNumber: 21,
    });
    expect(inputs[0]?.requestId).not.toBe('');
  });
});
