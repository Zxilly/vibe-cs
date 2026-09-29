import { fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { renderPage } from '../../../test/renderPage';
import { MapGeometrySettings } from './MapGeometrySettings';

describe('map geometry cache settings', () => {
  it('clears once, waits for completion and reads remaining usage without generating maps', async () => {
    let summary = { files: 2, bytes: 8_660_835 };
    let finish!: () => void;
    const clear = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    const generate = vi.fn();
    renderPage({ element: <MapGeometrySettings />, client: {
      mapGeometryCache: async () => summary, clearMapGeometryCache: clear, getMapGeometryBinary: generate,
    } });
    await screen.findByText(/已缓存 2 份地图/);
    fireEvent.click(screen.getByRole('button', { name: '清理缓存' }));
    await waitFor(() => expect(clear).toHaveBeenCalledTimes(1));
    expect((screen.getByRole('button', { name: '正在清理…' }) as HTMLButtonElement).disabled).toBe(true);
    summary = { files: 0, bytes: 0 };
    finish();
    await screen.findByText('暂无地图缓存');
    expect((screen.getByRole('button', { name: '清理缓存' }) as HTMLButtonElement).disabled).toBe(true);
    expect(generate).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: /生成/ })).toBeNull();
  });

  it('retries cache inspection without asking for a game installation', async () => {
    const read = vi.fn().mockRejectedValueOnce(new Error('Cache temporarily unavailable')).mockResolvedValue({ files: 0, bytes: 0 });
    renderPage({ element: <MapGeometrySettings />, client: { mapGeometryCache: read } });
    await screen.findByText(/暂时无法读取缓存占用/);
    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    await screen.findByText('暂无地图缓存');
    expect(screen.queryByText(/CS2 位置/)).toBeNull();
  });

  it('keeps partial cleanup failure actionable', async () => {
    const clear = vi.fn().mockRejectedValueOnce(new Error('File in use')).mockResolvedValue(undefined);
    renderPage({ element: <MapGeometrySettings />, client: {
      mapGeometryCache: async () => ({ files: 1, bytes: 2048 }), clearMapGeometryCache: clear,
    } });
    await screen.findByText(/已缓存 1 份地图/);
    fireEvent.click(screen.getByRole('button', { name: '清理缓存' }));
    await screen.findByText(/缓存未能完全清理/);
    await waitFor(() => expect((screen.getByRole('button', { name: '清理缓存' }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: '清理缓存' }));
    await waitFor(() => expect(clear).toHaveBeenCalledTimes(2));
  });
});
