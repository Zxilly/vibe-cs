import { useState } from 'react';
import { fireEvent, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { renderInteractive, renderMarkup } from '../../test/render';
import { AgentPanel, type AgentPanelProps } from './ProjectAgentPanel';

type TestPanelProps = Omit<AgentPanelProps, 'draftMessage' | 'onDraftChange'>;
function TestPanel(props: TestPanelProps) {
  const [draft, setDraft] = useState('');
  return <AgentPanel {...props} draftMessage={draft} onDraftChange={setDraft} />;
}

const AT = '2026-09-05T00:00:00Z';
const noop = async () => {};
function props(overrides: Partial<TestPanelProps> = {}): TestPanelProps {
  return {
    session: {
      id: 'session', title: 'Agent', created_at: AT, updated_at: AT,
      entries: [
        { kind: 'user', id: 'u', at: AT, content: '安排尚未录制的开场' },
        { kind: 'assistant', id: 'a', at: AT, content: '已安排', status: 'completed', request_id: 'r', retry_of: null, error: null, metadata: null, tool_calls: [] },
      ],
    },
    chat: { streaming: false, draft: '', error: null, activity: [], cancel: () => {} },
    creatingSession: false, selectedClipId: null, onSend: noop,
    changeGroups: [{ id: 'group', project_id: 'project', from_revision: 1, to_revision: 2,
      author: { kind: 'agent', session_id: 'session', turn_id: 'r' }, status: 'completed', summary: '安排开场',
      reverts_change_group_id: null, operations: [], inverse_operations: [], created_at: AT, completed_at: AT }],
    readOnly: false, agentReady: true, agentStatusPending: false, deliveryReady: false, deliveryGatePending: false,
    externalExecutions: [], executionActionPending: false, onCancelExecution: () => {},
    onOpenOutputs: () => {}, onOpenAgentSettings: () => {}, onOpenExternalUrl: async () => true,
    confirming: false, projectId: 'project', projectRevision: 2,
    onConfirmRecording: noop, onConfirmExport: noop, onRejectConfirmation: noop,
    onAcceptDelivery: noop, onReturnDelivery: noop, onDirectEdit: () => {}, ...overrides,
  };
}

describe('Agent edit review', () => {
  it('shows cancellation as terminal instead of a running spinner', () => {
    const view = renderInteractive(<TestPanel {...props({ externalExecutions: [{
      id: 'recording:cancelled', kind: 'recording', subtype: null, job_id: 'cancelled',
      context_id: 'project', subject: 'Cancelled shots', status: 'cancelled', stage: null,
      progress_percent: null, completed_units: null, total_units: null, unit: null,
      error: null, failure: null, created_at: AT, updated_at: AT, available_actions: [],
    }] })} />);
    const task = view.getByRole('region', { name: '录制已取消' });
    expect(task.querySelector('.animate-spin')).toBeNull();
    expect(task.textContent).toContain('录制已取消');
  });
  it('does not turn an absent completed recording percentage into zero', () => {
    const view = renderInteractive(<TestPanel {...props({ externalExecutions: [{
      id: 'recording:job', kind: 'recording', subtype: null, job_id: 'job',
      context_id: 'project', subject: 'Recorded shots', status: 'completed', stage: null,
      progress_percent: null, completed_units: null, total_units: null, unit: null,
      error: null, failure: null, created_at: AT, updated_at: AT, available_actions: ['open_outputs'],
    }] })} />);
    expect(view.getByRole('region', { name: '录制完成' })).toBeTruthy();
    expect(view.queryByText('0%')).toBeNull();
  });

  it.each([
    [{}, '读取作品摘要'],
    [{ detail: 'coverage' }, '检查镜头范围'],
  ])('expands a completed workspace tool %j with the correct title', (input, label) => {
    const panel = props();
    const session = panel.session!;
    const view = renderInteractive(<TestPanel {...panel} session={{ ...session, entries: session.entries.map((entry) => entry.kind === 'assistant'
      ? { ...entry, tool_calls: [{ id: 'read-tool', name: 'read_workspace', input, output: { result: 'unique tool output' }, status: 'completed' }] }
      : entry) }} />);
    const article = view.container.querySelector('[data-tool-call-id="read-tool"]')!;
    const details = article.querySelector('details')!;
    const summary = details.querySelector('summary')!;
    expect(summary.textContent).toContain(label);
    expect(summary.textContent).toContain('已完成');
    expect(details.open).toBe(false);
    fireEvent.click(summary);
    expect(details.open).toBe(true);
    expect(article.textContent?.match(/unique tool output/gu)).toHaveLength(1);
    fireEvent.click(summary);
    expect(details.open).toBe(false);
  });

  it('offers review of edits without promising a deliverable video', () => {
    const markup = renderMarkup(<TestPanel {...props()} />);
    expect(markup).toContain('接受修改');
    expect(markup).not.toContain('成片可以交付');
    expect(markup).not.toContain('接受交付');
  });

  it('restores the instruction and shows an error if sending fails', async () => {
    const view = renderInteractive(<TestPanel {...props({ onSend: async () => { throw new Error('会话保存失败'); } })} />);
    fireEvent.change(view.getByRole('textbox'), { target: { value: '保留结尾' } });
    fireEvent.click(view.getByRole('button', { name: '发送给 Agent' }));
    await waitFor(() => expect((view.getByRole('textbox') as HTMLInputElement).value).toBe('保留结尾'));
    expect(view.getByText(/会话保存失败/)).toBeTruthy();
  });
});

describe('Agent composer', () => {
  it('offers example instructions when there is no conversation yet', () => {
    const view = renderInteractive(<TestPanel {...props({ session: null, changeGroups: [] })} />);
    expect(view.getByRole('heading', { name: '还没有对话' })).toBeTruthy();
    fireEvent.click(view.getByRole('button', { name: '把每个片段前面留 1 秒缓冲' }));
    const composer = view.getByRole('textbox', { name: '给 Agent 的指令' }) as HTMLTextAreaElement;
    expect(composer.value).toBe('把每个片段前面留 1 秒缓冲');
    expect(document.activeElement).toBe(composer);
  });

  it('is a multi-line box at body size that sends on Enter and breaks lines on Shift+Enter', async () => {
    const sent: string[] = [];
    const view = renderInteractive(<TestPanel {...props({ onSend: async (message) => { sent.push(message); } })} />);
    const composer = view.getByRole('textbox', { name: '给 Agent 的指令' }) as HTMLTextAreaElement;
    expect(composer.tagName).toBe('TEXTAREA');
    expect(composer.rows).toBe(2);
    expect(composer.className).toContain('text-base');
    fireEvent.change(composer, { target: { value: '把每个片段前面留 1 秒缓冲' } });
    const shiftEnter = fireEvent.keyDown(composer, { key: 'Enter', shiftKey: true });
    expect(shiftEnter).toBe(true);
    expect(sent).toEqual([]);
    fireEvent.keyDown(composer, { key: 'Enter' });
    await waitFor(() => expect(sent).toEqual(['把每个片段前面留 1 秒缓冲']));
    expect(view.queryByRole('heading', { name: '还没有对话' })).toBeNull();
  });

  it('explains why the composer is disabled while Agent is editing', () => {
    const view = renderInteractive(<TestPanel {...props({ readOnly: true })} />);
    const composer = view.getByRole('textbox', { name: '给 Agent 的指令' }) as HTMLTextAreaElement;
    expect(composer.disabled).toBe(true);
    const describedBy = composer.getAttribute('aria-describedby');
    expect(describedBy).toBeTruthy();
    expect(document.getElementById(describedBy!)?.textContent).toContain('Agent 正在编辑，完成后才能继续对话');
  });

  it('renders the folded preview of a long reply as Markdown, not raw markers', () => {
    const body = `**clip 15 修正**：\`end_tick\` 98270→**98307**。${'补充说明。'.repeat(120)}`;
    const panel = props();
    const session = panel.session!;
    const view = renderInteractive(<TestPanel {...panel} session={{ ...session, entries: session.entries.map((entry) => entry.kind === 'assistant'
      ? { ...entry, content: body }
      : entry) }} />);
    const preview = view.container.querySelector('[data-agent-reply-preview]')!;
    expect(preview).toBeTruthy();
    expect(preview.querySelector('strong')?.textContent).toBe('clip 15 修正');
    expect(preview.querySelector('code')?.textContent).toBe('end_tick');
    expect(preview.textContent).not.toContain('**');
    expect(preview.textContent).not.toContain('`');
    expect(view.getByRole('button', { name: '查看完整回复' })).toBeTruthy();
  });
});
