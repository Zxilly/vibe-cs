import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type { ActivityItem } from '../../shared/desktop/viewModels';
import { renderPage } from '../../test/renderPage';
import { TaskActivityList } from './TaskActivityList';
import { useTaskActions } from './useTaskActions';

const CANCELLED: ActivityItem = {
  id: 'download:job-1', kind: 'download', subtype: null, job_id: 'job-1',
  context_id: 'match-1', subject: 'Mirage', status: 'cancelled', stage: null,
  progress_percent: null, completed_units: null, total_units: null, unit: null,
  error: null, failure: null, available_actions: [],
  created_at: '2026-10-28T04:00:00Z', updated_at: '2026-10-28T04:01:00Z',
};

function List({ item = CANCELLED, headingLevel = 2 }: { item?: ActivityItem; headingLevel?: 2 | 3 }) {
  const bind = useTaskActions();
  return <TaskActivityList items={[item]} total={1} isLoading={false} error={null}
    onReload={() => undefined} bind={bind} onSelect={() => undefined} headingLevel={headingLevel} />;
}

describe('task list semantics', () => {
  it('keeps the page and drawer outlines separate when both lists are mounted', () => {
    const { container } = renderPage({ client: {}, element: <>
      <h1>任务中心</h1><List />
      <h2>后台任务</h2><List headingLevel={3} />
    </> });

    expect(screen.getByRole('heading', { name: '已取消 · 1', level: 2 })).toBeTruthy();
    expect(screen.getByRole('heading', { name: '已取消 · 1', level: 3 })).toBeTruthy();
    expect(screen.getByRole('heading', { name: '下载 · Mirage', level: 3 })).toBeTruthy();
    expect(screen.getByRole('heading', { name: '下载 · Mirage', level: 4 })).toBeTruthy();
    const groups = [...container.querySelectorAll('section[aria-labelledby]')];
    const ids = groups.map((group) => group.getAttribute('aria-labelledby'));
    expect(new Set(ids).size).toBe(groups.length);
    for (const group of groups) {
      expect(group.querySelector('[id]')?.id).toBe(group.getAttribute('aria-labelledby'));
    }
  });

  it.each([false, true])('describes restart availability from the returned actions: %s', (restartable) => {
    const item: ActivityItem = { ...CANCELLED, available_actions: restartable ? ['retry_download'] : [] };
    renderPage({ client: {}, element: <List item={item} /> });
    expect(screen.queryByText(/可重新发起/u) !== null).toBe(restartable);
  });
});
