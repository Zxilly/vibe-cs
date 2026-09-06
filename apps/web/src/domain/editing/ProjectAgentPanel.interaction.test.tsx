import { fireEvent, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { renderInteractive, renderMarkup } from '../../test/render';
import { AgentPanel, type AgentPanelProps } from './ProjectAgentPanel';

const AT = '2026-09-05T00:00:00Z';
const noop = async () => {};
function props(overrides: Partial<AgentPanelProps> = {}): AgentPanelProps {
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
    const view = renderInteractive(<AgentPanel {...props({ externalExecutions: [{
      id: 'recording:cancelled', kind: 'recording', subtype: null, job_id: 'cancelled',
      context_id: 'project', subject: 'Cancelled shots', status: 'cancelled', stage: null,
      progress_percent: null, completed_units: null, total_units: null, unit: null,
      error: null, failure: null, created_at: AT, updated_at: AT, available_actions: [],
    }] })} />);
    const task = view.getByRole('region', { name: '录制已取消' });
    expect(task.querySelector('.animate-spin')).toBeNull();
    expect(task.textContent).toContain('已有素材和旧成品仍保留');
  });
  it('does not turn an absent completed recording percentage into zero', () => {
    const view = renderInteractive(<AgentPanel {...props({ externalExecutions: [{
      id: 'recording:job', kind: 'recording', subtype: null, job_id: 'job',
      context_id: 'project', subject: 'Recorded shots', status: 'completed', stage: null,
      progress_percent: null, completed_units: null, total_units: null, unit: null,
      error: null, failure: null, created_at: AT, updated_at: AT, available_actions: ['open_outputs'],
    }] })} />);
    expect(view.getByText('录制结果已就绪。导出前会重新检查当前作品的素材状态。')).toBeTruthy();
    expect(view.queryByText('0%')).toBeNull();
  });

  it.each([
    [{}, '读取作品摘要'],
    [{ detail: 'coverage' }, '检查镜头范围'],
  ])('expands a completed workspace tool %j with the correct title', (input, label) => {
    const panel = props();
    const session = panel.session!;
    const view = renderInteractive(<AgentPanel {...panel} session={{ ...session, entries: session.entries.map((entry) => entry.kind === 'assistant'
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
    const markup = renderMarkup(<AgentPanel {...props()} />);
    expect(markup).toContain('接受修改');
    expect(markup).not.toContain('成片可以交付');
    expect(markup).not.toContain('接受交付');
  });

  it('restores the instruction and shows an error if sending fails', async () => {
    const view = renderInteractive(<AgentPanel {...props({ onSend: async () => { throw new Error('会话保存失败'); } })} />);
    fireEvent.change(view.getByRole('textbox'), { target: { value: '保留结尾' } });
    fireEvent.click(view.getByRole('button', { name: '发送给 Agent' }));
    await waitFor(() => expect((view.getByRole('textbox') as HTMLInputElement).value).toBe('保留结尾'));
    expect(view.getByText(/会话保存失败/)).toBeTruthy();
  });
});
