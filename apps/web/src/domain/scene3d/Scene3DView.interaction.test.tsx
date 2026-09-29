import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { DesktopClientProvider, type DesktopClient } from '../../data/desktopClient';
import { qk } from '../../data/keys';
import { createTestQueryClient } from '../../data/test/renderDataHook';
import type { ReplayFrameRecord } from '../../shared/desktop/dto';
import { renderInteractive } from '../../test/render';
import { Scene3DView } from './Scene3DView';

const renderer = vi.hoisted(() => ({ create: vi.fn(), setState: vi.fn(), setGeometry: vi.fn(), resetView: vi.fn(), dispose: vi.fn() }));
vi.mock('./Scene3DRenderer', () => ({ Scene3DRenderer: class {
  constructor(_canvas: HTMLCanvasElement, _select: unknown, _lost: unknown, presented: (tick: number) => void) { renderer.create(presented); }
  setState = renderer.setState;
  setPresentationHeld() {}
  setGeometry = renderer.setGeometry;
  resetView = renderer.resetView;
  dispose = renderer.dispose;
} }));

const FRAMES: ReplayFrameRecord[] = [{ tick: 100, projectiles: [], bomb: null, players: [{
  id: 'player', name: 'Player', team: 'A', position: [0, 0, 0], yaw: 0, pitch: 0,
  health: 100, armor: 100, alive: true, weapon: 'ak47', input: null,
}] }];

beforeEach(() => vi.resetAllMocks());
afterEach(cleanup);

function tree(tick = 100, cameraAspectRatio: number | null = null) {
  return <DesktopClientProvider client={{ getMapGeometryBinary: vi.fn().mockRejectedValue(new Error('CS2 unavailable')) } as unknown as DesktopClient}>
    <Scene3DView mapName="de_mirage" frames={FRAMES} tick={tick} tickRate={64} selectedPlayerId="player" cameraAspectRatio={cameraAspectRatio} />
  </DesktopClientProvider>;
}

it('keeps the same renderer when time changes and releases it on unmount', async () => {
  const view = renderInteractive(tree());
  await waitFor(() => expect(renderer.create).toHaveBeenCalledTimes(1));
  view.rerender(tree(101));
  await waitFor(() => expect(renderer.setState).toHaveBeenLastCalledWith(expect.objectContaining({ tick: 101 })));
  expect(renderer.create).toHaveBeenCalledTimes(1);
  view.unmount();
  expect(renderer.dispose).toHaveBeenCalledTimes(1);
});

it('updates the recording aperture without replacing the renderer or resetting its transport', async () => {
  const view = renderInteractive(tree(101, 16 / 9));
  await waitFor(() => expect(renderer.setState).toHaveBeenLastCalledWith(expect.objectContaining({ tick: 101, cameraAspectRatio: 16 / 9 })));
  view.rerender(tree(102, 4 / 3));
  await waitFor(() => expect(renderer.setState).toHaveBeenLastCalledWith(expect.objectContaining({ tick: 102, cameraAspectRatio: 4 / 3 })));
  expect(renderer.create).toHaveBeenCalledTimes(1);
});

it('reports a presented frame only from the renderer and ignores callbacks after disposal', async () => {
  const presented = vi.fn();
  const view = renderInteractive(<DesktopClientProvider client={{ getMapGeometryBinary: vi.fn().mockRejectedValue(new Error('no map')) } as unknown as DesktopClient}>
    <Scene3DView mapName="de_mirage" frames={FRAMES} tick={100} tickRate={64} selectedPlayerId="player" onFramePresented={presented} />
  </DesktopClientProvider>);
  await screen.findByText('地图几何不可用，当前仅显示选手与机位。');
  await waitFor(() => expect(renderer.create).toHaveBeenCalledTimes(1));
  expect(presented).not.toHaveBeenCalled();
  const rendered = renderer.create.mock.calls[0]![0] as (tick: number) => void;
  rendered(100);
  expect(presented).toHaveBeenCalledWith(100);
  view.unmount();
  rendered(101);
  expect(presented).toHaveBeenCalledTimes(1);
});

it('retains the 3D player scene when map geometry is unavailable', async () => {
  renderInteractive(tree());
  expect(await screen.findByText('地图几何不可用，当前仅显示选手与机位。')).toBeTruthy();
  expect(screen.getByRole('application')).toBeTruthy();
  expect(renderer.setGeometry).toHaveBeenCalledWith(null);
  expect(renderer.setState).toHaveBeenCalledWith(expect.objectContaining({ frames: FRAMES }));
});

it('retries a failed graphics context with a new canvas rather than reusing the lost context', async () => {
  renderer.create.mockImplementationOnce(() => { throw new Error('WebGL2 unavailable'); });
  renderInteractive(tree());
  expect(await screen.findByRole('alert')).toBeTruthy();
  const failedCanvas = screen.getByRole('application');
  fireEvent.click(screen.getByRole('button', { name: '重新加载 3D' }));
  await waitFor(() => expect(renderer.create).toHaveBeenCalledTimes(2));
  expect(screen.getByRole('application')).not.toBe(failedCanvas);
  expect(screen.queryByRole('alert')).toBeNull();
});

it('removes an old cached mesh when refreshing that map fails', async () => {
  const client = createTestQueryClient();
  const map = { positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), indices: new Uint32Array([0, 1, 2]), includedShapes: 1, excludedShapes: 0 };
  client.setQueryData(qk.config.mapGeometry('de_mirage'), map);
  renderInteractive(<QueryClientProvider client={client}>{tree()}</QueryClientProvider>);
  await waitFor(() => expect(renderer.setGeometry).toHaveBeenLastCalledWith(map));
  await act(() => client.invalidateQueries({ queryKey: qk.config.mapGeometry('de_mirage') }));
  expect(await screen.findByText('地图几何不可用，当前仅显示选手与机位。')).toBeTruthy();
  expect(renderer.setGeometry).toHaveBeenLastCalledWith(null);
  expect(screen.getByRole('application')).toBeTruthy();
});
