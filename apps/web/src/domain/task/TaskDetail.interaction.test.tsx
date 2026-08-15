import { fireEvent } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { renderInteractive } from '../../test/render';
import { TaskDetail } from './TaskDetail';
import { recordingTaskStages } from './StageTimeline';
import type { TaskSummary } from './types';

const RUNNING: TaskSummary = {
  id: '#A-2481',
  kind: 'recording',
  status: 'running',
  subject: 'Kael_Mirage_1v3',
  startedAt: '2026-08-15T09:05:00Z',
};

const FAILED: TaskSummary = {
  id: '#E-131',
  kind: 'export',
  status: 'failed',
  subject: 'Aurora 赛点集锦',
  startedAt: '2026-08-15T08:40:00Z',
  failure: {
    reason: 'disk-space',
    recovery: { label: '重试导出', onAction: () => undefined },
  },
};

const CANCELLED: TaskSummary = { ...RUNNING, status: 'cancelled' };

const STAGES = recordingTaskStages([{ state: 'done' }, { state: 'active' }]);

describe('TaskDetail interaction · actions', () => {
  it('offers 取消 while the task can still be stopped', () => {
    const onCancel = vi.fn();
    const { getByRole } = renderInteractive(
      <TaskDetail task={RUNNING} stages={STAGES} onCancel={onCancel} timeZone="UTC" />,
    );

    fireEvent.click(getByRole('button', { name: '取消' }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('does not offer to stop a task that already stopped', () => {
    const { queryByRole } = renderInteractive(
      <TaskDetail task={FAILED} onCancel={() => undefined} timeZone="UTC" />,
    );

    expect(queryByRole('button', { name: '取消' })).toBeNull();
  });

  it('offers 重试 on a failed task', () => {
    const onRetry = vi.fn();
    const { getByRole } = renderInteractive(<TaskDetail task={FAILED} onRetry={onRetry} timeZone="UTC" />);

    fireEvent.click(getByRole('button', { name: '重试' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('calls a cancelled task’s re-run 重新发起, not 重试', () => {
    // 「已取消 · 可重新发起」 — a restart is a start, not a retry, and
    // `taskMachine` spends no retry budget on it.
    const { getByRole, queryByRole } = renderInteractive(
      <TaskDetail task={CANCELLED} onRetry={() => undefined} timeZone="UTC" />,
    );

    expect(getByRole('button', { name: '重新发起' })).toBeDefined();
    expect(queryByRole('button', { name: '重试' })).toBeNull();
  });

  it('offers neither on a task that is still running fine', () => {
    const { queryByRole } = renderInteractive(
      <TaskDetail task={RUNNING} stages={STAGES} onRetry={() => undefined} timeZone="UTC" />,
    );

    expect(queryByRole('button', { name: '重试' })).toBeNull();
    expect(queryByRole('button', { name: '重新发起' })).toBeNull();
  });

  it('runs the failure’s own recovery from the Notice', () => {
    const onAction = vi.fn();
    const task: TaskSummary = { ...FAILED, failure: { reason: 'disk-space', recovery: { label: '释放空间', onAction } } };
    const { getByRole } = renderInteractive(<TaskDetail task={task} timeZone="UTC" />);

    fireEvent.click(getByRole('button', { name: '释放空间' }));
    expect(onAction).toHaveBeenCalledTimes(1);
  });

  it('reloads a stage log that failed to arrive', () => {
    const onRetry = vi.fn();
    const { getByRole } = renderInteractive(
      <TaskDetail
        task={RUNNING}
        stages={STAGES}
        log={{ status: 'error', message: '读取阶段记录失败', onRetry }}
        timeZone="UTC"
      />,
    );

    fireEvent.click(getByRole('button', { name: '重新加载' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});

describe('TaskDetail interaction · technical details', () => {
  const DETAILS = [
    { id: 'pid', label: '进程', value: '18422' },
    { id: 'tick', label: 'tick', value: '128' },
  ];

  it('starts closed and opens on demand', () => {
    const { getByText, container } = renderInteractive(
      <TaskDetail task={RUNNING} stages={STAGES} technicalDetails={DETAILS} timeZone="UTC" />,
    );

    const details = container.querySelector('details');
    expect(details).not.toBeNull();
    expect((details as HTMLDetailsElement).open).toBe(false);

    fireEvent.click(getByText('技术细节'));
    expect((details as HTMLDetailsElement).open).toBe(true);
  });

  it('is reachable from the keyboard — the summary is a focusable control', () => {
    const { getByText } = renderInteractive(
      <TaskDetail task={RUNNING} stages={STAGES} technicalDetails={DETAILS} timeZone="UTC" />,
    );

    const summary = getByText('技术细节').closest('summary');
    expect(summary).not.toBeNull();
    (summary as HTMLElement).focus();
    expect(document.activeElement).toBe(summary);
  });

  it('renders no disclosure when there is nothing technical to disclose', () => {
    const { container } = renderInteractive(<TaskDetail task={RUNNING} stages={STAGES} timeZone="UTC" />);

    expect(container.querySelector('details')).toBeNull();
  });
});
