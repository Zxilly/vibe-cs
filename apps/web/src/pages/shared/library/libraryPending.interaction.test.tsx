import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AppConfig, ScanResult } from '../../../shared/desktop/dto';
import { CONFIG_FIXTURE, DEMO_FIXTURE, WATCH_FIXTURE, demoPage, renderLibrary } from './test/renderLibrary';

const nativeFiles = vi.hoisted(() => ({ choose: vi.fn(), subscribe: vi.fn() }));
vi.mock('../../../shared/desktop/dialog', async (original) => ({
  ...await original<typeof import('../../../shared/desktop/dialog')>(),
  chooseLocalFiles: nativeFiles.choose,
  subscribeLocalFileDrop: nativeFiles.subscribe,
}));

beforeEach(() => {
  nativeFiles.choose.mockReset().mockResolvedValue(['C:\\matches\\aurora.dem']);
  nativeFiles.subscribe.mockReset().mockResolvedValue(() => {});
});

const ONLINE = { demos: demoPage([DEMO_FIXTURE]), watch: WATCH_FIXTURE, config: CONFIG_FIXTURE };
const IMPORTED: ScanResult = { discovered: 1, imported: 1, updated: 0, skipped: 0, errors: [] };

async function tryToDismiss(panel: HTMLElement) {
  expect(within(panel).getByRole('status').textContent).toBe('正在处理');
  expect(panel.querySelector('[data-dialog-action="confirm"]')?.getAttribute('aria-busy')).toBe('true');
  const cancel = within(panel).getByRole('button', { name: '取消' });
  expect(cancel).toHaveProperty('disabled', true);
  fireEvent.click(cancel);
  fireEvent.keyDown(panel, { key: 'Escape' });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  const backdrop = document.querySelector('[data-overlay="dialog-backdrop"]')!;
  fireEvent.pointerDown(backdrop);
  fireEvent.click(backdrop);
  expect(panel.isConnected).toBe(true);
}

describe('library operations keep their confirmation until the service settles', () => {
  it('keeps staged files during a pending import, then exposes failure and retries those paths', async () => {
    let rejectImport!: (error: Error) => void;
    const pending = new Promise<ScanResult>((_, reject) => { rejectImport = reject; });
    const importer = vi.fn().mockReturnValueOnce(pending).mockResolvedValueOnce(IMPORTED);
    renderLibrary({ seed: ONLINE, client: { importDemoPaths: importer, listDemos: async () => ONLINE.demos } });
    fireEvent.click(screen.getByRole('button', { name: '导入 Demo' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '选择文件' }));
    fireEvent.click(await screen.findByRole('button', { name: '导入 1 个文件' }));
    await waitFor(() => expect(importer).toHaveBeenCalledOnce());
    const panel = screen.getByRole('dialog', { name: '导入 Demo' });
    await waitFor(() => expect(within(panel).getByRole('button', { name: '导入 1 个文件' })).toHaveProperty('disabled', true));
    await tryToDismiss(panel);

    await act(async () => rejectImport(new Error('磁盘空间不足')));
    expect(await within(panel).findByText('磁盘空间不足')).toBeTruthy();
    expect(panel.textContent).toContain('aurora.dem');
    expect(within(panel).getByRole('button', { name: '取消' })).toHaveProperty('disabled', false);
    fireEvent.click(within(panel).getByRole('button', { name: '重试' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(importer.mock.calls.map((call) => call[0])).toEqual([['C:\\matches\\aurora.dem'], ['C:\\matches\\aurora.dem']]);
  });

  it('keeps selected Demo identities and recovery visible when deletion fails', async () => {
    let rejectDelete!: (error: Error) => void;
    const pending = new Promise<void>((_, reject) => { rejectDelete = reject; });
    const remove = vi.fn().mockReturnValueOnce(pending).mockResolvedValueOnce(undefined);
    renderLibrary({ seed: ONLINE, client: { deleteDemo: remove, listDemos: async () => ONLINE.demos } });
    fireEvent.click(screen.getByRole('checkbox', { name: '选择 Aurora vs Meridian' }));
    fireEvent.click(screen.getByRole('button', { name: '删除记录' }));
    const panel = screen.getByRole('dialog', { name: '删除 1 条记录？' });
    fireEvent.click(within(panel).getByRole('button', { name: '删除' }));
    await waitFor(() => expect(within(panel).getByRole('button', { name: '删除' })).toHaveProperty('disabled', true));
    await tryToDismiss(panel);

    await act(async () => rejectDelete(new Error('文件仍在使用')));
    expect(await within(panel).findByText('文件仍在使用')).toBeTruthy();
    expect(panel.textContent).toContain(DEMO_FIXTURE.display_name);
    fireEvent.click(within(panel).getByRole('button', { name: '重试' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(remove.mock.calls.map((call) => call[0])).toEqual([DEMO_FIXTURE.id, DEMO_FIXTURE.id]);
  });

  it('locks the watched path during a pending save and restores editing after failure', async () => {
    let rejectSave!: (error: Error) => void;
    const pending = new Promise<AppConfig>((_, reject) => { rejectSave = reject; });
    renderLibrary({ seed: ONLINE, client: { updateConfig: () => pending } });
    fireEvent.click(screen.getByRole('button', { name: '监听目录' }));
    fireEvent.click(await screen.findByRole('button', { name: '添加目录' }));
    const panel = screen.getByRole('dialog', { name: '添加监听目录' });
    const path = within(panel).getByLabelText('目录');
    fireEvent.change(path, { target: { value: 'G:\\new\\demos' } });
    fireEvent.click(within(panel).getByRole('button', { name: '开始监听' }));
    await waitFor(() => expect(within(panel).getByRole('button', { name: '开始监听' })).toHaveProperty('disabled', true));
    await tryToDismiss(panel);
    expect(path).toHaveProperty('disabled', true);

    await act(async () => rejectSave(new Error('无法写入配置')));
    expect(await within(panel).findByText('无法写入配置')).toBeTruthy();
    expect(path).toHaveProperty('disabled', false);
    expect(path).toHaveProperty('value', 'G:\\new\\demos');
    fireEvent.keyDown(panel, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '添加监听目录' })).toBeNull());
  });
});
