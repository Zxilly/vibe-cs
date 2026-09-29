import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { PREVIEW_PROJECT } from '../../dev/projectFixtures';
import cameraFixture from '../../dev/fixtures/camera-preview';
import { DesktopClientProvider, type DesktopClient } from '../../data/desktopClient';
import type { ExportJobRecord, Project } from '../../shared/desktop/dto';
import type { CameraPreviewViewport } from '../scene3d/CameraPreviewViewport';
import { renderInteractive } from '../../test/render';
import { TimelineProgramMonitor } from './TimelineProgramMonitor';

vi.mock('../../data/nativeShell', () => ({ useNativeShell: () => ({ mediaSrc: (path: string) => `https://media.test${path}` }) }));
vi.mock('./TimelineAudioMonitor', () => ({ TimelineAudioMonitor: () => null }));
vi.mock('./mediaAudioOutput', () => ({ useMediaAudioOutput() {}, resumeMediaAudioOutput() {} }));
const sceneSeam = vi.hoisted(() => ({ slots: new Map<string, Parameters<typeof CameraPreviewViewport>[0]>(), preview: vi.fn() }));
vi.mock('../scene3d/CameraPreviewViewport', () => ({ CameraPreviewViewport: (props: Parameters<typeof CameraPreviewViewport>[0]) => {
  sceneSeam.slots.set(props.preview.mapName, props);
  return <div data-testid={props.preview.mapName} data-presented={props.presented} />;
} }));

beforeEach(() => {
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
  sceneSeam.slots.clear();
  sceneSeam.preview.mockReset().mockImplementation(async (projectId: string, clipId: string, revision: number) => ({
    ...cameraFixture, projectId, clipId, revision,
    preview: { ...cameraFixture.preview, mapName: `${clipId}:${revision}`, playerId: clipId, startTick: revision * 1000, endTick: revision * 1000 + 384, plan: null },
  }));
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

function project(): Project {
  const result = structuredClone(PREVIEW_PROJECT);
  result.document.duration_seconds = 12;
  result.document.tracks[0]!.clips = result.document.tracks[0]!.clips.slice(0, 2).map((clip, index) => ({
    ...clip, capture_intent: null,
    material: { kind: 'asset', asset_id: `asset-${index}`, media_duration_seconds: 6 },
  }));
  return result;
}

function tree(value: Project, time: number, renderPreviews: readonly ExportJobRecord[] = []) {
  return <DesktopClientProvider client={{ getProjectCameraPreview: sceneSeam.preview } as unknown as DesktopClient}><TimelineProgramMonitor project={value} timelineTimeSeconds={time} renderPreviews={renderPreviews} selectedClipId={null}
    timeDisplayMode="timecode" readOnly={false} playing={false} playbackRate={1} rollingPreview={null}
    slidePreview={null} playbackRange={null} onTogglePlayback={() => {}} onShuttle={() => {}}
    onStepFrame={() => {}} onTimelineTimeChange={() => {}} onPlaybackEnd={() => {}} onReplaceClip={() => {}} /></DesktopClientProvider>;
}

function renderPreview(value: Project): ExportJobRecord {
  return {
    kind: 'project_preview',
    job: {
      id: 'preview-range', project_id: value.id, project_revision: value.revision,
      range_start_seconds: 0, range_end_seconds: 6, status: 'completed', progress: 1,
      output_path: 'C:/preview.mp4', error: null, error_code: null,
      created_at: '2026-09-30T00:00:00Z', updated_at: '2026-09-30T00:00:00Z',
    },
  };
}

function planned(): Project {
  const value = project();
  value.document.tracks[0]!.clips.forEach((clip, index) => {
    clip.material = { kind: 'planned' };
    clip.capture_intent = PREVIEW_PROJECT.document.tracks[0]!.clips[index]!.capture_intent;
  });
  return value;
}

function key(value: Project, index: number) { return `${value.document.tracks[0]!.clips[index]!.id}:${value.revision}`; }
function presented(value: Project, index: number) { return screen.getByTestId(key(value, index)).dataset.presented === 'true'; }
function frame(value: Project, index: number, seconds: number) {
  act(() => sceneSeam.slots.get(key(value, index))!.onFramePresented!(seconds));
}

it('freezes the last presented video frame while the next clip is seeking', () => {
  const value = project();
  value.document.tracks[0]!.clips[0]!.transitions.video_in = { kind: 'fade', duration_seconds: 1 };
  const view = renderInteractive(tree(value, 3));
  const monitor = screen.getByRole('region', { name: '视频预览' });
  const first = monitor.querySelector<HTMLVideoElement>('video[data-preview-pool-role="program"]')!;
  Object.defineProperty(first, 'readyState', { configurable: true, value: HTMLMediaElement.HAVE_CURRENT_DATA });
  fireEvent.loadedData(first);
  expect(first.currentTime).toBe(3);
  expect(first.style.opacity).toBe('1');
  expect(first.dataset.previewActive).toBe('true');
  view.rerender(tree(value, 7));
  fireEvent.seeked(first);
  fireEvent.canPlay(first);
  expect(first.dataset.previewActive).toBe('true');
  expect(first.currentTime).toBe(3);
  expect(first.style.opacity).toBe('1');
});

it.each(['program', 'multicam', 'render'] as const)('%s retries only the newest Timeline seek after an in-flight seek finishes', (kind) => {
  const value = project();
  const story = value.document.tracks[0]!;
  story.clips = story.clips.slice(0, 1);
  const first = story.clips[0]!;
  first.metadata = { multicam: { group_id: 'group', angle: 1, angle_name: 'First', switch_audio: true } };
  value.document.tracks.push({ ...story, id: 'second-angle', order: 1, clips: [{
    ...first, id: 'second-clip',
    material: { kind: 'asset', asset_id: 'second-asset', media_duration_seconds: 6 },
    placement: { ...first.placement, enabled: false },
    metadata: { multicam: { group_id: 'group', angle: 2, angle_name: 'Second', switch_audio: true } },
  }] });
  const previews = kind === 'render' ? [renderPreview(value)] : [];
  const view = renderInteractive(tree(value, 1, previews));
  const video = kind === 'program'
    ? document.querySelector<HTMLVideoElement>('video[data-preview-pool-role="program"]')!
    : kind === 'multicam'
      ? screen.getByRole('button', { name: '切换到摄像机 2 Second' }).querySelector('video')!
      : screen.getByLabelText<HTMLVideoElement>('已渲染时间轴预览');
  expect(video.currentTime).toBe(1);
  Object.defineProperty(video, 'seeking', { configurable: true, value: true });
  view.rerender(tree(value, 2, previews));
  view.rerender(tree(value, 3, previews));
  expect(video.currentTime).toBe(1);
  Object.defineProperty(video, 'seeking', { configurable: true, value: false });
  fireEvent.seeked(video);
  expect(video.currentTime).toBe(3);
});

it('waits for a newly mounted render preview when returning to a previously ready range', () => {
  const value = project();
  const record = renderPreview(value);
  const view = renderInteractive(tree(value, 1, [record]));
  const first = screen.getByLabelText<HTMLVideoElement>('已渲染时间轴预览');
  Object.defineProperty(first, 'readyState', { configurable: true, value: HTMLMediaElement.HAVE_CURRENT_DATA });
  fireEvent.loadedData(first);
  expect(first.style.opacity).toBe('1');
  view.rerender(tree(value, 7, [record]));
  expect(first.isConnected).toBe(false);
  view.rerender(tree(value, 2, [record]));
  const replacement = screen.getByLabelText<HTMLVideoElement>('已渲染时间轴预览');
  expect(replacement).not.toBe(first);
  expect(replacement.currentTime).toBe(2);
  expect(replacement.style.opacity).toBe('0');
  fireEvent.loadedData(first);
  expect(replacement.style.opacity).toBe('0');
  Object.defineProperty(replacement, 'readyState', { configurable: true, value: HTMLMediaElement.HAVE_CURRENT_DATA });
  fireEvent.loadedData(replacement);
  expect(replacement.style.opacity).toBe('1');
});

it('keeps clip-keyed scene instances and presents only the newest transport target', async () => {
  const value = planned();
  const view = renderInteractive(tree(value, 3));
  const first = await screen.findByTestId(key(value, 0));
  await screen.findByTestId(key(value, 1));
  frame(value, 0, 3);
  expect(presented(value, 0)).toBe(true);
  view.rerender(tree(value, 7));
  expect(screen.getByTestId(key(value, 0))).toBe(first);
  expect(sceneSeam.slots.get(key(value, 0))!.readSourceTime!()).toBe(3);
  expect(presented(value, 0)).toBe(true);
  view.rerender(tree(value, 8));
  frame(value, 1, 1);
  expect(presented(value, 0)).toBe(true);
  expect(presented(value, 1)).toBe(false);
  frame(value, 1, 2);
  expect(presented(value, 0)).toBe(false);
  expect(presented(value, 1)).toBe(true);
  expect(sceneSeam.preview).toHaveBeenCalledTimes(2);
});

it('retains the old Head frame while the new Head is loading and rejects its late readiness', async () => {
  const value = planned();
  const view = renderInteractive(tree(value, 3));
  const first = await screen.findByTestId(key(value, 0));
  frame(value, 0, 3);
  const next = { ...value, revision: value.revision + 1 };
  view.rerender(tree(next, 4));
  expect(first.isConnected).toBe(true);
  expect(presented(value, 0)).toBe(true);
  await screen.findByTestId(key(next, 0));
  frame(value, 0, 4);
  expect(presented(next, 0)).toBe(false);
  frame(next, 0, 4);
  expect(presented(next, 0)).toBe(true);
  expect(first.isConnected).toBe(false);
});

it('retains a video after its clip becomes planned until the 3D replacement is ready', async () => {
  const value = project();
  const view = renderInteractive(tree(value, 3));
  const video = document.querySelector<HTMLVideoElement>('video[data-preview-pool-role="program"]')!;
  Object.defineProperty(video, 'readyState', { configurable: true, value: HTMLMediaElement.HAVE_CURRENT_DATA });
  fireEvent.loadedData(video);
  const next = planned();
  next.revision += 1;
  view.rerender(tree(next, 3));
  expect(video.isConnected).toBe(true);
  expect(video.dataset.previewActive).toBe('true');
  expect(video.currentTime).toBe(3);
  await screen.findByTestId(key(next, 0));
  frame(next, 0, 3);
  expect(video.isConnected).toBe(false);
  expect(presented(next, 0)).toBe(true);
});

it('keeps the previous scene on a failed replacement and allows retry', async () => {
  const value = planned();
  const view = renderInteractive(tree(value, 3));
  await screen.findByTestId(key(value, 0));
  frame(value, 0, 3);
  sceneSeam.preview.mockRejectedValue(new Error('New Head unavailable'));
  const next = { ...value, revision: value.revision + 1 };
  view.rerender(tree(next, 3));
  expect((await screen.findByRole('alert')).textContent).toContain('New Head unavailable');
  expect(presented(value, 0)).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: '重试' }));
  await waitFor(() => expect(sceneSeam.preview).toHaveBeenCalledTimes(5));
});

it('keeps the scene until a recorded replacement has decoded its requested frame', async () => {
  const value = planned();
  const view = renderInteractive(tree(value, 3));
  const scene = await screen.findByTestId(key(value, 0));
  frame(value, 0, 3);
  const next = project();
  next.revision += 1;
  view.rerender(tree(next, 3));
  expect(scene.isConnected).toBe(true);
  expect(presented(value, 0)).toBe(true);
  const video = document.querySelector<HTMLVideoElement>('video[data-preview-target="true"]')!;
  Object.defineProperty(video, 'readyState', { configurable: true, value: HTMLMediaElement.HAVE_CURRENT_DATA });
  fireEvent.loadedData(video);
  expect(video.dataset.previewActive).toBe('true');
  expect(scene.isConnected).toBe(false);
});

it('bounds the scene pool to the active neighbors and the last presented clip', async () => {
  const value = structuredClone(PREVIEW_PROJECT);
  value.document.tracks[0]!.clips = value.document.tracks[0]!.clips.slice(0, 6);
  value.document.duration_seconds = 36;
  const view = renderInteractive(tree(value, 1));
  const first = await screen.findByTestId(key(value, 0));
  const second = await screen.findByTestId(key(value, 1));
  frame(value, 0, 1);
  view.rerender(tree(value, 19));
  await screen.findByTestId(key(value, 3));
  expect(first.isConnected).toBe(true);
  expect(second.isConnected).toBe(false);
  expect(document.querySelectorAll('[data-camera-pool-key]')).toHaveLength(4);
  frame(value, 3, 1);
  expect(first.isConnected).toBe(false);
  expect(document.querySelectorAll('[data-camera-pool-key]')).toHaveLength(3);
});

it('uses the clip speed and the same visual transform, effects and transition while holding a scene', async () => {
  const value = planned();
  const clip = value.document.tracks[0]!.clips[0]!;
  clip.placement.speed = 2;
  clip.transform.x = 192;
  clip.transform.opacity = 0.5;
  clip.transitions.video_in = { kind: 'fade', duration_seconds: 1 };
  clip.effects = [{ id: 'gray', kind: 'grayscale', enabled: true, parameters: {} }];
  const view = renderInteractive(tree(value, 0.25));
  await screen.findByTestId(key(value, 0));
  const props = () => sceneSeam.slots.get(key(value, 0))!;
  expect(props().readSourceTime!()).toBe(0.5);
  expect(props().frameStyle).toMatchObject({ opacity: 0.125, filter: 'grayscale(1)' });
  expect(props().frameStyle?.transform).toContain('translate3d(10%, 0%, 0)');
  frame(value, 0, 0.5);
  view.rerender(tree(value, 7));
  expect(props().readSourceTime!()).toBe(0.5);
  expect(props().frameStyle?.opacity).toBe(0.125);
});
