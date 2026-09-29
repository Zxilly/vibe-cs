import { act, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { AgentChatInput, AgentEvent, AgentSession, AgentSessionEntry, AgentSessionEntryDraft, AgentToolCall, Project } from '../shared/desktop/dto';
import type { DesktopClientStub } from './desktopClient';
import { qk } from './keys';
import { useProject } from './projects';
import { useAgentChatStream, useAgentSession, useAppendAgentSessionEntry } from './sessions';
import { renderDataHook } from './test/renderDataHook';

const SESSION_ID = '00000000-0000-4000-8000-000000000001';
const PROJECT_ID = '00000000-0000-4000-8000-000000000002';
const AT = '2026-08-29T00:00:00Z';
const SESSION: AgentSession = { id: SESSION_ID, title: 'Host-owned Agent', created_at: AT, updated_at: AT, entries: [] };
const PROJECT: Project = {
  id: PROJECT_ID, name: 'Agent Project', revision: 1,
  document: {
    width: 1920, height: 1080, fps: 60, duration_seconds: 0,
    story_track_id: '00000000-0000-4000-8000-000000000003', tracks: [], markers: [],
    settings: { source_demo_ids: [], ripple_sequence_markers: false, use_media_proxies: false },
  }, created_at: AT, updated_at: AT,
};
const TOOL: AgentToolCall = { id: 'request:tool:1', name: 'read_workspace', input: {}, output: { revision: 1 }, status: 'completed' };
function terminal(status: 'completed' | 'failed' | 'cancelled' = 'completed', tools: AgentToolCall[] = []): AgentSessionEntry {
  return { kind: 'assistant', id: 'turn', at: AT, request_id: 'request', retry_of: null,
    content: 'Host reply', tool_calls: tools, status, error: status === 'failed' ? 'Provider unavailable' : null, metadata: null };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}

describe('useAgentChatStream', () => {
  it('sends workspace selection and retry identity without authoring a durable turn', async () => {
    let captured: AgentChatInput | undefined;
    const append = vi.fn();
    const workspaceContext = {
      projectId: PROJECT_ID, lens: 'multitrack' as const,
      selectedClipId: 'clip-b', selectedClipIds: ['clip-a', 'clip-b'],
      targetTrackId: 'video-track', targetTrackIds: ['video-track', 'audio-track'],
      playheadSeconds: 12.5, rangeInSeconds: 10, rangeOutSeconds: 20,
    };
    const client: DesktopClientStub = {
      appendAgentSessionEntry: append,
      streamAgentChat: async (input) => { captured = input; return { sessionId: SESSION_ID, turn: terminal() }; },
    };
    const { result } = renderDataHook(() => useAgentChatStream({ sessionId: SESSION_ID }), { client });
    await act(async () => result.current.send({ message: '压缩选区', projectId: PROJECT_ID, workspaceContext, retryOf: 'failed-turn' }));
    expect(captured?.workspaceContext).toEqual(workspaceContext);
    expect(captured?.retryOf).toBe('failed-turn');
    expect(captured).not.toHaveProperty('history');
    expect(append).not.toHaveBeenCalled();
  });

  it('renders a durable provider failure returned by the host', async () => {
    const { result } = renderDataHook(() => useAgentChatStream({ sessionId: SESSION_ID }), { client: {
      streamAgentChat: async () => ({ sessionId: SESSION_ID, turn: terminal('failed') }),
    } });
    await act(async () => result.current.send({ message: '修改开场', projectId: PROJECT_ID }));
    expect(result.current.streaming).toBe(false);
    expect(result.current.error).toBe('Provider unavailable');
  });

  it('releases the composer when the host cannot persist its terminal state', async () => {
    const { result } = renderDataHook(() => useAgentChatStream({ sessionId: SESSION_ID }), { client: {
      streamAgentChat: async () => { throw new Error('无法保存对话'); },
    } });
    await act(async () => {
      await expect(result.current.send({ message: '修改开场', projectId: PROJECT_ID })).rejects.toThrow('无法保存对话');
    });
    expect(result.current.streaming).toBe(false);
    expect(result.current.error).toContain('无法保存对话');
  });

  it('keeps live tool evidence until cancellation returns a durable turn', async () => {
    const completion = deferred<void>();
    const cancelled = terminal('cancelled', [TOOL]);
    let session = SESSION;
    const cancelAgentChat = vi.fn(async () => true);
    const streamAgentChat = vi.fn(async (_input: AgentChatInput, emit: (event: AgentEvent) => void) => {
      emit({ type: 'textDelta', delta: 'Partial reply' });
      emit({ type: 'toolCallFinished', toolCall: TOOL });
      await completion.promise;
      session = { ...SESSION, entries: [cancelled] };
      return { sessionId: SESSION_ID, turn: cancelled };
    });
    const { result, queryClient } = renderDataHook(() => ({
      session: useAgentSession(SESSION_ID), chat: useAgentChatStream({ sessionId: SESSION_ID }),
    }), { client: { getAgentSession: async () => session, streamAgentChat, cancelAgentChat } });
    await waitFor(() => expect(result.current.session.data).toEqual(SESSION));
    let sending!: Promise<void>;
    act(() => { sending = result.current.chat.send({ message: '开始', projectId: PROJECT_ID }); });
    await waitFor(() => expect(result.current.chat.activity).toContainEqual(TOOL));
    act(() => result.current.chat.cancel());
    expect(cancelAgentChat).toHaveBeenCalledTimes(1);
    expect(result.current.chat.streaming).toBe(true);
    expect(result.current.chat.activity).toContainEqual(TOOL);
    await act(async () => result.current.chat.send({ message: 'too early', projectId: PROJECT_ID }));
    expect(streamAgentChat).toHaveBeenCalledTimes(1);
    await act(async () => { completion.resolve(); await sending; });
    expect(queryClient.getQueryData<AgentSession>(qk.sessions.detail(SESSION_ID))?.entries).toContainEqual(cancelled);
    expect(result.current.chat.streaming).toBe(false);
    expect(result.current.chat.activity).toEqual([]);
  });

  it('asks the host to stop on unmount while the host retains finalization ownership', async () => {
    const completion = deferred<void>();
    const cancelAgentChat = vi.fn(async () => true);
    const appendAgentSessionEntry = vi.fn();
    const { result, unmount } = renderDataHook(() => useAgentChatStream({ sessionId: SESSION_ID }), { client: {
      cancelAgentChat, appendAgentSessionEntry,
      streamAgentChat: async () => { await completion.promise; return { sessionId: SESSION_ID, turn: terminal('cancelled') }; },
    } });
    let sending!: Promise<void>;
    act(() => { sending = result.current.send({ message: '开始', projectId: PROJECT_ID }); });
    unmount();
    expect(cancelAgentChat).toHaveBeenCalledTimes(1);
    expect(appendAgentSessionEntry).not.toHaveBeenCalled();
    await act(async () => { completion.resolve(); await sending; });
  });

  it('refreshes the Project Head when a live edit finishes before the host terminal reply', async () => {
    const completion = deferred<void>();
    let project = PROJECT;
    const edit = { ...TOOL, name: 'apply_project_patch' };
    const { result } = renderDataHook(() => ({
      project: useProject(PROJECT_ID), chat: useAgentChatStream({ sessionId: SESSION_ID }),
    }), { client: {
      getProject: async () => project,
      streamAgentChat: async (_input, emit) => {
        project = { ...PROJECT, revision: 2 };
        emit({ type: 'toolCallFinished', toolCall: edit });
        await completion.promise;
        return { sessionId: SESSION_ID, turn: terminal('completed', [edit]) };
      },
    } });
    await waitFor(() => expect(result.current.project.data?.revision).toBe(1));
    let sending!: Promise<void>;
    act(() => { sending = result.current.chat.send({ message: '修改', projectId: PROJECT_ID }); });
    await waitFor(() => expect(result.current.project.data?.revision).toBe(2));
    expect(result.current.chat.streaming).toBe(true);
    await act(async () => { completion.resolve(); await sending; });
  });

  it('keeps human decisions durable and sends only session identity for continuation', async () => {
    let session = SESSION;
    const append = vi.fn(async (_id: string, draft: AgentSessionEntryDraft) => {
      const entry: AgentSessionEntry = { ...draft, id: 'decision', at: AT };
      session = { ...session, entries: [...session.entries, entry] };
      return entry;
    });
    const stream = vi.fn(async (_input: AgentChatInput) => {
      expect(session.entries).toHaveLength(1);
      return { sessionId: SESSION_ID, turn: terminal() };
    });
    const { result } = renderDataHook(() => ({
      append: useAppendAgentSessionEntry(), chat: useAgentChatStream({ sessionId: SESSION_ID }),
    }), { client: { appendAgentSessionEntry: append, streamAgentChat: stream } });
    await act(async () => {
      await result.current.append.mutateAsync({ sessionId: SESSION_ID, draft: { kind: 'tool_decision', tool_call_id: TOOL.id, decision: 'approved', content: '批准' } });
      await result.current.chat.send({ message: '继续', projectId: PROJECT_ID });
    });
    expect(append).toHaveBeenCalledTimes(1);
    expect(stream.mock.calls[0]?.[0]).not.toHaveProperty('history');
  });
});
