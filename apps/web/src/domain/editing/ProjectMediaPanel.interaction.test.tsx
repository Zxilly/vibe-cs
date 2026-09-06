import { cleanup, fireEvent, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { renderInteractive } from '../../test/render';
import { ProjectMediaPanel, type ProjectMediaPanelProps } from './ProjectMediaPanel';
import { timelineClipFromMediaAsset } from './timelineEditing';
import type { MediaAsset, TimelineTrack } from '../../shared/desktop/dto';

it('keeps a used source reusable for a second In/Out edit without duplicating its library item', () => {
  const asset: MediaAsset = {
    id: 'asset-a', project_id: 'project-a', path: 'C:/fake/media.mp4', name: 'Reusable source',
    kind: 'video', duration_seconds: 10, width: 1920, height: 1080, file_size: 100,
    has_audio: true, proxy_path: null, proxy_status: {status: 'not_requested'}, waveform: null,
    metadata_status: {status: 'ready'}, markers: [], created_at: '2026-09-05T00:00:00Z',
  };
  const onInsert = vi.fn();
  const onOverwrite = vi.fn();
  const props: ProjectMediaPanelProps = {
    assets: [asset], timelineTracks: [], projectFps: 60, selectedTimelineClipId: null,
    matchedSourceFrame: null, pending: false, readOnly: false, busy: false,
    canEditAsset: () => true, sourcePatchTargets: () => ({video: 'Story', audio: 'Story'}),
    importAvailable: true, relinkAvailable: true, importing: false,
    onCreateFromDemo: vi.fn(), onSelectTimelineClip: vi.fn(), onRequestRecording: vi.fn(),
    onImport: vi.fn(), onInsert, onOverwrite, canReplace: () => true,
    onReplace: vi.fn(), onRelink: vi.fn(), onDelete: vi.fn(), onReplaceAssetMarkers: vi.fn(),
    proxiesEnabled: false, generatingProxyAssetId: null, proxyCleanupBusy: false,
    sequenceMarkerCount: 0, onGenerateProxy: vi.fn(), onToggleProxies: vi.fn(),
    onCleanupProxies: vi.fn(), onAutomateToSequence: vi.fn(), onCreateMulticam: vi.fn(),
  };
  renderInteractive(<ProjectMediaPanel {...props} />);
  openSourcePreview();
  fireEvent.click(screen.getByRole('option', {name: '选择素材 Reusable source'}));
  expect((screen.getByRole('button', {name: '在播放头插入 Reusable source'}) as HTMLButtonElement).disabled).toBe(false);
  fireEvent.keyDown(window, {key: ','});
  expect(onInsert).toHaveBeenCalledTimes(1);
  cleanup();
  onInsert.mockClear();
  const track: TimelineTrack = {id: 'story', name: 'Story', kind: 'video', order: 0,
    muted: false, solo: false, volume: 1, pan: 0, keyframes: [], locked: false, hidden: false,
    clips: [timelineClipFromMediaAsset(asset, 'placed-a')]};
  renderInteractive(<ProjectMediaPanel {...props} timelineTracks={[track]} />);
  openSourcePreview();
  fireEvent.click(screen.getByRole('option', {name: '选择素材 Reusable source'}));
  expect(screen.getAllByRole('option', {name: '选择素材 Reusable source'})).toHaveLength(1);
  expect(screen.queryByRole('button', {name: '从项目移除素材 Reusable source'})).toBeNull();
  expect((screen.getByRole('button', {name: '在播放头插入 Reusable source'}) as HTMLButtonElement).disabled).toBe(false);
  expect(screen.getByRole('option', {name: '选择素材 Reusable source'}).draggable).toBe(true);
  fireEvent.change(screen.getByRole('slider', {name: '源素材播放头'}), {target: {value: 6}});
  fireEvent.click(screen.getByRole('button', {name: '标记源入点'}));
  fireEvent.change(screen.getByRole('slider', {name: '源素材播放头'}), {target: {value: 9 - 1 / 60}});
  fireEvent.click(screen.getByRole('button', {name: '标记源出点'}));
  fireEvent.keyDown(window, {key: ','});
  fireEvent.keyDown(window, {key: '.'});
  expect(onInsert).toHaveBeenCalledExactlyOnceWith(asset, {sourceIn: 6, sourceOut: 9}, {video: true, audio: true});
  expect(onOverwrite).toHaveBeenCalledExactlyOnceWith(asset, {sourceIn: 6, sourceOut: 9}, {video: true, audio: true});
  cleanup();
  onInsert.mockClear();
  renderInteractive(<ProjectMediaPanel {...props} timelineTracks={[track]} readOnly />);
  openSourcePreview();
  fireEvent.click(screen.getByRole('option', {name: '选择素材 Reusable source'}));
  expect((screen.getByRole('button', {name: '在播放头插入 Reusable source'}) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.keyDown(window, {key: ','});
  expect(onInsert).not.toHaveBeenCalled();
});

function openSourcePreview() {
  const toggle = screen.getByRole('button', { name: /源预览与片段信息/u });
  if (toggle.getAttribute('aria-expanded') === 'false') fireEvent.click(toggle);
}
