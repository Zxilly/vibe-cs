import { fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { DemoQuery } from '../../../shared/desktop/dto';
import { CONFIG_FIXTURE, DEMO_FIXTURE, WATCH_FIXTURE, demoPage, renderLibrary } from './test/renderLibrary';

const seed = {
  demos: demoPage([DEMO_FIXTURE]),
  config: CONFIG_FIXTURE,
  watch: WATCH_FIXTURE,
  tags: [],
  maps: ['Mirage'],
};

describe('library filter recovery', () => {
  it('clears only the search and returns focus to the input', async () => {
    const listDemos = vi.fn((_query: DemoQuery) => Promise.resolve(demoPage([DEMO_FIXTURE])));
    renderLibrary({ at: '/library?q=Aurora&map=Mirage', seed, client: { listDemos } });

    fireEvent.click(screen.getByRole('button', { name: '清空搜索' }));

    const search = screen.getByRole('textbox', { name: '搜索比赛、选手或文件名' });
    expect((search as HTMLInputElement).value).toBe('');
    expect(document.activeElement).toBe(search);
    expect(screen.queryByRole('button', { name: '清空搜索' })).toBeNull();
    await waitFor(() => expect(listDemos).toHaveBeenCalled());
    expect(listDemos.mock.calls.at(-1)?.[0]).toMatchObject({ map_name: 'Mirage', page: 1 });
    expect(listDemos.mock.calls.at(-1)?.[0]).not.toHaveProperty('search');
  });

  it('resets all filters together while keeping the current view and sort', async () => {
    const listDemos = vi.fn((_query: DemoQuery) => Promise.resolve(demoPage([DEMO_FIXTURE])));
    renderLibrary({
      at: '/library?view=card&q=Aurora&map=Mirage&status=ready&source=valve&tag=tag-1&sort=map_asc&page=3',
      seed,
      client: { listDemos },
    });

    const reset = screen.getByRole('button', { name: '重置筛选' });
    reset.focus();
    fireEvent.click(reset);

    await waitFor(() => expect(listDemos).toHaveBeenCalled());
    expect(listDemos.mock.calls.at(-1)?.[0]).toEqual({ sort: 'map_asc', page: 1, page_size: 20 });
    expect(screen.getByRole('radio', { name: '卡片' }).getAttribute('aria-checked')).toBe('true');
    expect(screen.queryByRole('button', { name: '重置筛选' })).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: '搜索比赛、选手或文件名' }));
  });
});
