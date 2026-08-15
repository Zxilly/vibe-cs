import { fireEvent } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { renderInteractive } from '../../test/render';
import { TaskCard } from './TaskCard';
import type { TaskSummary } from './types';

const RUNNING: TaskSummary = {
  id: '#N-908',
  kind: 'analysis',
  status: 'running',
  subject: 'Kestrel vs Halcyon',
  startedAt: '2026-08-15T08:50:00Z',
  progress: { completed: 62, total: 100, unit: 'percent' },
};

const DONE: TaskSummary = {
  id: '#A-2481',
  kind: 'recording',
  status: 'succeeded',
  subject: 'Kael_Mirage_1v3',
  startedAt: '2026-08-15T09:12:00Z',
};

function failedTask(recovery: { label: string; onAction: () => void; disabled?: boolean }): TaskSummary {
  return {
    id: '#E-131',
    kind: 'export',
    status: 'failed',
    subject: 'Aurora 赛点集锦',
    startedAt: '2026-08-15T08:40:00Z',
    failure: { reason: 'disk-space', recovery },
  };
}

describe('TaskCard interaction', () => {
  it('offers 取消 while the task can still be stopped', () => {
    const onCancel = vi.fn();
    const { getByRole } = renderInteractive(<TaskCard task={RUNNING} onCancel={onCancel} timeZone="UTC" />);

    fireEvent.click(getByRole('button', { name: '取消' }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('does not offer to stop a task that already stopped', () => {
    const { queryByRole } = renderInteractive(
      <TaskCard task={DONE} onCancel={() => undefined} timeZone="UTC" />,
    );

    expect(queryByRole('button', { name: '取消' })).toBeNull();
  });

  it('runs the failure’s recovery action — the one thing every failure must have', () => {
    const onAction = vi.fn();
    const { getByRole } = renderInteractive(
      <TaskCard task={failedTask({ label: '重试导出', onAction })} timeZone="UTC" />,
    );

    fireEvent.click(getByRole('button', { name: '重试导出' }));
    expect(onAction).toHaveBeenCalledTimes(1);
  });

  it('disables the recovery instead of hiding it when the service cannot carry it out', () => {
    const onAction = vi.fn();
    const { getByRole } = renderInteractive(
      <TaskCard task={failedTask({ label: '重试导出', onAction, disabled: true })} timeZone="UTC" />,
    );

    // 「不隐藏、不静默失败」 — the action stays on screen, unavailable.
    const button = getByRole('button', { name: '重试导出' });
    expect((button as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(button);
    expect(onAction).not.toHaveBeenCalled();
  });

  it('exposes the progress bar with its real bounds, not a fabricated ratio', () => {
    const { getByRole } = renderInteractive(<TaskCard task={RUNNING} timeZone="UTC" />);

    const bar = getByRole('progressbar');
    expect(bar.getAttribute('aria-valuenow')).toBe('62');
    expect(bar.getAttribute('aria-valuemax')).toBe('100');
  });

  it('has no progress bar to expose when no denominator arrived', () => {
    const { queryByRole } = renderInteractive(<TaskCard task={DONE} timeZone="UTC" />);

    expect(queryByRole('progressbar')).toBeNull();
  });
});
