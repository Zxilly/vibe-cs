import { cleanup, fireEvent, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import fixture from '../../dev/fixtures/camera-preview';
import { renderInteractive } from '../../test/render';
import { CameraPreviewViewport } from './CameraPreviewViewport';
import type { Scene3DView } from './Scene3DView';

const seam = vi.hoisted(() => ({ replay: vi.fn(), scene: vi.fn() }));
vi.mock('../../data/match', () => ({ useCameraReplay: seam.replay }));
vi.mock('./Scene3DView', () => ({ Scene3DView: (props: Parameters<typeof Scene3DView>[0]) => {
  seam.scene(props);
  return <div data-testid="scene" />;
} }));

beforeEach(() => {
  vi.clearAllMocks();
  seam.replay.mockReturnValue({ data: { frames: [] }, isError: false, refetch: vi.fn() });
});
afterEach(cleanup);

it('uses the exact native plan and samples the owner clock without advancing it', () => {
  let time = 0.25;
  const presented = vi.fn();
  renderInteractive(<CameraPreviewViewport preview={fixture.preview} sourceTimeSeconds={time}
    readSourceTime={() => time} onFramePresented={presented} />);
  expect(seam.replay).toHaveBeenCalledWith(fixture.preview.replay);
  const scene = seam.scene.mock.lastCall![0] as Parameters<typeof Scene3DView>[0];
  expect(scene.cameraSamples).toBe(fixture.preview.plan.samples);
  expect(scene.cameraDiagnostics).toBe(fixture.preview.plan.diagnostics);
  expect(scene.cameraAspectRatio).toBe(fixture.preview.aspectRatio);
  expect(scene.tick).toBe(116);
  expect(scene.readTick!()).toBe(116);
  time = 0.5;
  expect(scene.readTick!()).toBe(132);
  expect(presented).not.toHaveBeenCalled();
  scene.onFramePresented!(132);
  expect(presented).toHaveBeenCalledWith(0.5);
  time = 100;
  expect(scene.readTick!()).toBe(fixture.preview.endTick);
});

it('keeps POV attached to observed player poses with no generated path', () => {
  renderInteractive(<CameraPreviewViewport preview={{ ...fixture.preview, plan: null }} sourceTimeSeconds={0} />);
  expect(seam.scene.mock.lastCall![0]).toMatchObject({ initialMode: 'camera', selectedPlayerId: 'target', cameraSamples: null, cameraDiagnostics: null });
});

it('routes scrubbing to its owner instead of keeping a second playback position', () => {
  const seek = vi.fn();
  renderInteractive(<CameraPreviewViewport preview={fixture.preview} sourceTimeSeconds={0.25} onSourceTimeChange={seek} />);
  const slider = screen.getByRole('slider', { name: '预演位置' }) as HTMLInputElement;
  fireEvent.change(slider, { target: { value: '0.5' } });
  expect(seek).toHaveBeenCalledWith(0.5);
  expect(slider.value).toBe('0.25');
});

it('limits an inspector preview to the clip source trim rather than offering unreachable capture handles', () => {
  renderInteractive(<CameraPreviewViewport preview={fixture.preview} sourceTimeSeconds={0.25}
    readSourceTime={() => 1} sourceRange={{ start: 0.125, end: 0.5 }} onSourceTimeChange={() => {}} />);
  const slider = screen.getByRole('slider', { name: '预演位置' }) as HTMLInputElement;
  expect(slider.min).toBe('0.125');
  expect(slider.max).toBe('0.5');
  const scene = seam.scene.mock.lastCall![0] as Parameters<typeof Scene3DView>[0];
  expect(scene.readTick!()).toBe(132);
});

it('does not present stale scene data after the source request fails', () => {
  const retry = vi.fn();
  seam.replay.mockReturnValue({ data: { frames: [] }, isError: true, error: new Error('Source unavailable'), refetch: retry });
  renderInteractive(<CameraPreviewViewport preview={fixture.preview} sourceTimeSeconds={0} />);
  expect(screen.getByRole('alert').textContent).toContain('Source unavailable');
  expect(screen.queryByTestId('scene')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '重试' }));
  expect(retry).toHaveBeenCalledTimes(1);
});
