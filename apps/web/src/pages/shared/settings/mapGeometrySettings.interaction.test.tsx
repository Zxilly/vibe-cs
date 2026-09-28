import { fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { MapGeometryStatus } from '../../../shared/desktop/dto';
import { renderPage } from '../../../test/renderPage';
import { MapGeometrySettings } from './MapGeometrySettings';

describe('map geometry settings', () => {
  it('rebuilds a stale map, waits for completion and refreshes its authoritative state', async () => {
    let status: MapGeometryStatus = { map_name: 'de_inferno', state: 'stale', bytes: null, reason: null };
    let finish!: (value: MapGeometryStatus) => void;
    const rebuild = vi.fn(() => new Promise<MapGeometryStatus>((resolve) => { finish = resolve; }));
    renderPage({ element: <MapGeometrySettings />, client: {
      mapGeometryStatus: async () => [status], rebuildMapGeometry: rebuild,
    } });
    const button = await screen.findByRole('button', { name: '重新生成 Inferno 地图' });
    expect(screen.getByText('地图已更新')).toBeTruthy();
    fireEvent.click(button);
    await waitFor(() => expect(rebuild).toHaveBeenCalledWith('de_inferno'));
    await waitFor(() => expect((screen.getByRole('button', { name: '重新生成 Inferno 地图' }) as HTMLButtonElement).disabled).toBe(true));
    expect(screen.getByRole('button', { name: '重新生成 Inferno 地图' }).textContent).toContain('正在生成');
    status = { ...status, state: 'ready', bytes: 8_660_835 };
    finish(status);
    await screen.findByText('已准备');
    await waitFor(() => expect((screen.getByRole('button', { name: '重新生成 Inferno 地图' }) as HTMLButtonElement).disabled).toBe(false));
  });

  it('explains a missing installation and can refresh after it is configured', async () => {
    let configured = false;
    const read = vi.fn(async () => {
      if (!configured) throw new Error('CS2 executable was not found');
      return [{ map_name: 'de_mirage', state: 'missing', bytes: null, reason: null } satisfies MapGeometryStatus];
    });
    renderPage({ element: <MapGeometrySettings />, client: { mapGeometryStatus: read } });
    await screen.findByText(/暂时读不到地图/);
    configured = true;
    fireEvent.click(screen.getByRole('button', { name: '刷新状态' }));
    await screen.findByRole('button', { name: '生成 Mirage 地图' });
    expect(screen.queryByText(/暂时读不到地图/)).toBeNull();
  });

  it('keeps failed rebuilds actionable instead of claiming success', async () => {
    const rebuild = vi.fn(async () => { throw new Error('Unsupported physics version'); });
    renderPage({ element: <MapGeometrySettings />, client: {
      mapGeometryStatus: async () => [{ map_name: 'de_nuke', state: 'missing', bytes: null, reason: null } satisfies MapGeometryStatus],
      rebuildMapGeometry: rebuild,
    } });
    fireEvent.click(await screen.findByRole('button', { name: '生成 Nuke 地图' }));
    await screen.findByText(/地图没有生成成功/);
    expect(screen.getByText(/Unsupported physics version/)).toBeTruthy();
    expect(screen.queryByText('已准备')).toBeNull();
    expect((screen.getByRole('button', { name: '生成 Nuke 地图' }) as HTMLButtonElement).disabled).toBe(false);
  });
});
