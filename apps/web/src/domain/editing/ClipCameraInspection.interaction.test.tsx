import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

import { DesktopClientProvider, type DesktopClient } from '../../data/desktopClient';
import fixture from '../../dev/fixtures/camera-preview';
import type { ProjectCameraPreviewResponse } from '../../shared/desktop/dto';
import { renderInteractive } from '../../test/render';
import { ClipCameraInspection } from './ClipCameraInspection';

afterEach(cleanup);

function response(revision: number): ProjectCameraPreviewResponse {
  return { projectId: 'project', clipId: 'clip', revision,
    ...structuredClone(fixture) };
}

function tree(client: Partial<DesktopClient>, revision = 1) {
  return <DesktopClientProvider client={client as DesktopClient}>
    <ClipCameraInspection projectId="project" clipId="clip" revision={revision} />
  </DesktopClientProvider>;
}

it('shows the returned correction and remaining geometric intervals, and allows retry', async () => {
  const value = response(1);
  value.inspection.effectiveStyle = 'tracking';
  value.inspection.issues = [{ kind: 'target_occluded', startSeconds: 3.2, endSeconds: 4.1, affectedFraction: 0.75 }];
  const getProjectCameraPreview = vi.fn().mockResolvedValue(value);
  renderInteractive(tree({ getProjectCameraPreview }));
  expect(await screen.findByText('为改善画面，录制将改用跟随机位。')).toBeTruthy();
  expect(screen.getByText('3.20–4.10 秒')).toBeTruthy();
  expect(screen.getByText('75% 的头胸视线被遮挡')).toBeTruthy();
  expect(screen.getByText('静态地图检查不包含烟雾，仅作提示，不阻止录制。')).toBeTruthy();
  expect(getProjectCameraPreview).toHaveBeenCalledWith('project', 'clip', 1, expect.any(AbortSignal));
  getProjectCameraPreview.mockRejectedValue(new Error('Analysis unavailable'));
  fireEvent.click(screen.getByRole('button', { name: '重新检查' }));
  expect((await screen.findByRole('alert')).textContent).toContain('Analysis unavailable');
  expect(screen.queryByText('75% 的头胸视线被遮挡')).toBeNull();
});

it('does not present unavailable geometry as a clear shot', async () => {
  const value = response(1);
  value.inspection.geometryUnavailable = 'CS2 installation unavailable';
  renderInteractive(tree({ getProjectCameraPreview: vi.fn().mockResolvedValue(value) }));
  expect(await screen.findByText('未能检查地图遮挡。可在设置中准备地图后重试。')).toBeTruthy();
  expect(screen.queryByText('当前采样未发现镜头问题。')).toBeNull();
});

it('never displays a late reply from an older Project Head', async () => {
  let resolveOld!: (value: ProjectCameraPreviewResponse) => void;
  const pending = new Promise<ProjectCameraPreviewResponse>((resolve) => { resolveOld = resolve; });
  const getProjectCameraPreview = vi.fn().mockImplementation((_projectId, _clipId, revision: number) =>
    revision === 1 ? pending : Promise.resolve(response(revision)));
  const view = renderInteractive(tree({ getProjectCameraPreview }));
  await waitFor(() => expect(getProjectCameraPreview).toHaveBeenCalledTimes(1));
  view.rerender(tree({ getProjectCameraPreview }, 2));
  expect(await screen.findByText('当前采样未发现镜头问题。')).toBeTruthy();
  const old = response(1);
  old.inspection.geometryUnavailable = 'OLD HEAD RESULT';
  await act(async () => { resolveOld(old); await pending; });
  expect(screen.queryByText('OLD HEAD RESULT')).toBeNull();
  expect(getProjectCameraPreview).toHaveBeenLastCalledWith('project', 'clip', 2, expect.any(AbortSignal));
});
