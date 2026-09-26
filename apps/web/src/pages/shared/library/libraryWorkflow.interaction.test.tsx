import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { qk } from '../../../data/keys';
import type { DemoPlaybackLaunch, Project } from '../../../shared/desktop/dto';
import { libraryDemoQuery, readLibraryAddress } from './libraryQuery';
import {
  CONFIG_FIXTURE,
  DEMO_FIXTURE,
  TAG_FIXTURE,
  WATCH_FIXTURE,
  demoPage,
  makeDemo,
  renderLibrary,
} from './test/renderLibrary';

const ONLINE = {
  demos: demoPage([DEMO_FIXTURE]),
  detail: DEMO_FIXTURE,
  watch: WATCH_FIXTURE,
  tags: [TAG_FIXTURE],
  config: CONFIG_FIXTURE,
};

const PROJECT: Project = {
  id: 'project-created', name: 'Aurora vs Meridian', revision: 0,
  created_at: '2026-09-22T00:00:00Z', updated_at: '2026-09-22T00:00:00Z',
  document: {
    width: 1920, height: 1080, fps: 60, duration_seconds: 0,
    story_track_id: 'story', tracks: [{
      id: 'story', name: 'Story', kind: 'video', order: 0, clips: [],
      muted: false, solo: false, volume: 1, pan: 0, keyframes: [], locked: false, hidden: false,
    }], markers: [],
    settings: { source_demo_ids: [DEMO_FIXTURE.id], ripple_sequence_markers: false, use_media_proxies: false },
  },
};

const location = () => document.querySelector('[data-library-location]')?.textContent ?? '';
const search = () => screen.getByRole('textbox', { name: '搜索比赛、选手或文件名' });

describe('library batch action scope', () => {
  it('clears hidden selections after filtering and deletes only the records shown in confirmation', async () => {
    const first = makeDemo(0);
    const second = makeDemo(1);
    const deleteDemo = vi.fn(() => Promise.resolve());
    renderLibrary({
      seed: { ...ONLINE, demos: demoPage([first, second]) },
      client: {
        listDemos: () => Promise.resolve(demoPage([second])),
        deleteDemo,
      },
    });

    fireEvent.click(screen.getByRole('checkbox', { name: `选择 ${first.display_name}` }));
    fireEvent.change(search(), { target: { value: '第 2 场' } });
    await waitFor(() => expect(screen.queryByRole('checkbox', { name: `选择 ${first.display_name}` })).toBeNull());
    expect(document.querySelector('[data-selection-bar]')).toBeNull();
    expect(screen.getByRole('navigation', { name: '分页' })).toBeTruthy();

    fireEvent.click(await screen.findByRole('checkbox', { name: `选择 ${second.display_name}` }));
    fireEvent.click(screen.getByRole('button', { name: '删除记录' }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByRole('heading', { name: '删除 1 条记录？' })).toBeTruthy();
    expect(within(dialog).queryByText(first.display_name)).toBeNull();
    expect(within(dialog).getByText(second.display_name)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: '删除' }));
    await waitFor(() => expect(deleteDemo).toHaveBeenCalledExactlyOnceWith(second.id));
  });

  it('lets the user cancel a batch selection and restores the pager', () => {
    renderLibrary({ seed: ONLINE });
    fireEvent.click(screen.getByRole('checkbox', { name: `选择 ${DEMO_FIXTURE.display_name}` }));
    const cancel = screen.getByRole('button', { name: '取消选择' });
    cancel.focus();
    fireEvent.click(cancel);
    expect(screen.getByRole('checkbox', { name: `选择 ${DEMO_FIXTURE.display_name}` }).getAttribute('aria-checked')).toBe('false');
    expect(document.querySelector('[data-selection-bar]')).toBeNull();
    expect(screen.getByRole('navigation', { name: '分页' })).toBeTruthy();
    expect(document.activeElement?.getAttribute('data-row-id')).toBe(DEMO_FIXTURE.id);
  });

  it('keeps a visible selection through a refresh but excludes a record removed by that refresh', async () => {
    const first = makeDemo(0);
    const second = makeDemo(1);
    const { queryClient } = renderLibrary({ seed: { ...ONLINE, demos: demoPage([first, second]) } });
    fireEvent.click(screen.getByRole('checkbox', { name: `选择 ${first.display_name}` }));
    fireEvent.click(screen.getByRole('checkbox', { name: `选择 ${second.display_name}` }));
    await act(async () => {
      queryClient.setQueryData(qk.demos.list(libraryDemoQuery(readLibraryAddress(new URLSearchParams()))), demoPage([second]));
    });
    await waitFor(() => expect(document.querySelector('[data-selection-summary]')?.textContent).toContain('已选 1 场'));
    fireEvent.click(screen.getByRole('button', { name: '删除记录' }));
    expect(within(screen.getByRole('dialog')).getByRole('heading', { name: '删除 1 条记录？' })).toBeTruthy();
    expect(within(screen.getByRole('dialog')).queryByText(first.display_name)).toBeNull();
  });
});

describe('library action recovery', () => {
  it('reports a failed remark and retries the original Demo after selection changes', async () => {
    const first = makeDemo(0);
    const second = makeDemo(1);
    const updateDemo = vi.fn().mockRejectedValueOnce(new Error('remark storage unavailable'))
      .mockResolvedValue({ ...first, remark: 'Keep this round' });
    renderLibrary({ seed: { ...ONLINE, demos: demoPage([first, second]), detail: first }, client: {
      updateDemo, getDemo: (id) => Promise.resolve(id === first.id ? first : second),
      listDemos: () => Promise.resolve(demoPage([first, second])),
    } });
    fireEvent.change(await screen.findByRole('textbox', { name: '备注' }), { target: { value: 'Keep this round' } });
    fireEvent.click(screen.getByRole('button', { name: '保存备注' }));
    expect(await screen.findByText('remark storage unavailable')).toBeTruthy();
    expect((screen.getByRole('textbox', { name: '备注' }) as HTMLInputElement).value).toBe('Keep this round');
    fireEvent.click(document.querySelector(`[data-row-id="${second.id}"]`) as HTMLElement);
    await waitFor(() => expect((screen.getByRole('textbox', { name: '备注' }) as HTMLInputElement).value).toBe(''));
    fireEvent.click(screen.getByRole('button', { name: '重试保存备注' }));
    await waitFor(() => expect(updateDemo).toHaveBeenCalledTimes(2));
    expect(updateDemo.mock.calls).toEqual([[first.id, { remark: 'Keep this round' }], [first.id, { remark: 'Keep this round' }]]);
  });

  it('reports a failed tag batch and retries its original selection', async () => {
    const first = makeDemo(0);
    const second = makeDemo(1);
    const updateDemoMetadataBatch = vi.fn().mockRejectedValueOnce(new Error('tag storage unavailable')).mockResolvedValue([]);
    renderLibrary({ seed: { ...ONLINE, demos: demoPage([first, second]) }, client: { updateDemoMetadataBatch } });
    fireEvent.click(screen.getByRole('checkbox', { name: `选择 ${first.display_name}` }));
    fireEvent.pointerDown(screen.getByRole('button', { name: '添加标签' }), { button: 0, ctrlKey: false });
    fireEvent.click(await screen.findByRole('menuitem', { name: TAG_FIXTURE.name }));
    expect(await screen.findByText('tag storage unavailable')).toBeTruthy();
    fireEvent.click(screen.getByRole('checkbox', { name: `选择 ${first.display_name}` }));
    fireEvent.click(screen.getByRole('checkbox', { name: `选择 ${second.display_name}` }));
    fireEvent.click(screen.getByRole('button', { name: '重试添加标签' }));
    await waitFor(() => expect(updateDemoMetadataBatch).toHaveBeenCalledTimes(2));
    expect(updateDemoMetadataBatch.mock.calls[1]?.[0]).toEqual(updateDemoMetadataBatch.mock.calls[0]?.[0]);
    expect(updateDemoMetadataBatch.mock.calls[1]?.[0].demo_ids).toEqual([first.id]);
  });

  it('retries the failed playback for its original Demo and never starts an analysis', async () => {
    const playDemo = vi.fn<() => Promise<DemoPlaybackLaunch>>()
      .mockRejectedValueOnce(new Error('CS2 未启动'))
      .mockImplementationOnce(() => new Promise(() => undefined));
    const startAnalysisRun = vi.fn();
    renderLibrary({ seed: ONLINE, client: { playDemo, startAnalysisRun } });
    fireEvent.click(await screen.findByRole('button', { name: '游戏内回放' }));
    const retry = await screen.findByRole('button', { name: '重试回放' });
    expect(screen.getByText('CS2 未启动')).toBeTruthy();
    fireEvent.click(retry);
    await waitFor(() => expect(playDemo).toHaveBeenCalledTimes(2));
    expect(playDemo.mock.calls).toEqual([[DEMO_FIXTURE.id], [DEMO_FIXTURE.id]]);
    await waitFor(() => expect(!retry.isConnected || (retry as HTMLButtonElement).disabled).toBe(true));
    expect(startAnalysisRun).not.toHaveBeenCalled();
  });

  it.each(['create', 'patch'] as const)('shows the %s failure and opens existing projects without repeating creation', async (failedStep) => {
    const createProject = vi.fn(() => failedStep === 'create'
      ? Promise.reject(new Error('作品创建失败'))
      : Promise.resolve(PROJECT));
    const applyProjectPatch = vi.fn(() => Promise.reject(new Error('素材加入失败')));
    renderLibrary({ seed: ONLINE, client: { createProject, applyProjectPatch } });
    fireEvent.pointerDown(screen.getByRole('button', { name: `更多操作：${DEMO_FIXTURE.display_name}` }), { button: 0, ctrlKey: false });
    fireEvent.click(await screen.findByRole('menuitem', { name: '用 Agent 制作' }));
    expect(await screen.findByText(failedStep === 'create' ? '作品创建失败' : '素材加入失败')).toBeTruthy();
    const alert = screen.getByRole('alert');
    expect(within(alert).queryByRole('button', { name: /重试/u })).toBeNull();
    fireEvent.click(within(alert).getByRole('button', { name: '查看作品' }));
    await waitFor(() => expect(document.querySelector('[data-projects]')).not.toBeNull());
    expect(createProject).toHaveBeenCalledTimes(1);
    expect(applyProjectPatch).toHaveBeenCalledTimes(failedStep === 'patch' ? 1 : 0);
  });
});

describe('collecting clips for the current project', () => {
  it('keeps the destination in the address across filtering and a remount, including both workspace entrances', async () => {
    const first = renderLibrary({
      at: '/library?project=project-destination', seed: ONLINE,
      client: { listDemos: () => Promise.resolve(demoPage([DEMO_FIXTURE])) },
    });
    fireEvent.change(search(), { target: { value: 'Aurora' } });
    await screen.findByRole('link', { name: '工作区' });
    const address = location();
    expect(new URLSearchParams(address.split('?')[1]).get('project')).toBe('project-destination');
    first.unmount();

    renderLibrary({ at: address, seed: ONLINE });
    const rowLink = screen.getByRole('link', { name: '工作区' });
    expect(rowLink.getAttribute('href')).toBe(`/match/${DEMO_FIXTURE.id}?view=replay&project=project-destination`);
    fireEvent.click(await screen.findByRole('button', { name: '从 Demo 创建剪辑' }));
    await waitFor(() => expect(location()).toBe(`/match/${DEMO_FIXTURE.id}?view=replay&project=project-destination`));
  });

  it('preserves the destination through Steam downloads and its explicit return action', async () => {
    renderLibrary({
      at: '/library?project=project-destination', seed: ONLINE,
      client: {
        listDemos: () => Promise.resolve(demoPage([DEMO_FIXTURE])),
        getDemo: () => Promise.resolve(DEMO_FIXTURE),
        listMatchHistory: () => Promise.resolve({ items: [], total: 0, page: 1, page_size: 50 }),
        listActiveMatchDownloadJobs: () => Promise.resolve([]),
      },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Steam 下载' }));
    await waitFor(() => expect(location()).toBe('/library?view=steam&project=project-destination'));
    fireEvent.click(screen.getByRole('button', { name: '返回 Demo 资料库' }));
    await waitFor(() => expect(location()).toBe('/library?project=project-destination'));
    expect(await screen.findByRole('button', { name: '从 Demo 创建剪辑' })).toBeTruthy();
  });
});
