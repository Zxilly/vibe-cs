import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { renderInteractive } from '../../test/render';
import { ProjectMediaPanel, type ProjectMediaPanelProps } from './ProjectMediaPanel';
import { timelineClipFromMediaAsset } from './timelineEditing';
import type { MediaAsset, TimelineClip, TimelineTrack } from '../../shared/desktop/dto';

const ASSET: MediaAsset = {
  id: 'asset-a', project_id: 'project-a', path: 'C:/fake/media.mp4', name: 'Reusable source',
  kind: 'video', duration_seconds: 10, width: 1920, height: 1080, file_size: 100,
  has_audio: true, proxy_path: null, proxy_status: {status: 'not_requested'}, waveform: null,
  metadata_status: {status: 'ready'}, markers: [], created_at: '2026-09-05T00:00:00Z',
};

it('keeps a used source reusable for a second In/Out edit without duplicating its library item', () => {
  const asset = ASSET;
  const onInsert = vi.fn();
  const onOverwrite = vi.fn();
  const props = panelProps({assets: [asset], onInsert, onOverwrite});
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

it('distinguishes same-round footage by Demo ticks in both views and keeps the evidence while filtering', () => {
  const first: TimelineClip = {
    ...timelineClipFromMediaAsset(ASSET, 'moment-a', {sourceIn: 0, sourceOut: 6}),
    name: 'Mirage R1 · s1mple',
    material: {kind: 'planned'},
    capture_intent: {
      demo_id: 'demo-a', highlight_id: null, player_id: 'player-a',
      start_tick: 10_000, end_tick: 10_384, pre_roll_seconds: 0, post_roll_seconds: 0,
      victim_pov: false, camera_style: 'pov', presentation: null,
    },
  };
  const second: TimelineClip = {
    ...first, id: 'moment-b',
    placement: {...first.placement, start: 6},
    capture_intent: {...first.capture_intent!, start_tick: 10_512, end_tick: 10_896},
  };
  const track = storyTrack([first, second]);
  const props = panelProps({timelineTracks: [track]});
  const {rerender} = renderInteractive(<ProjectMediaPanel {...props} />);
  const firstOption = screen.getByRole('option', {name: '选择素材 Mirage R1 · s1mple', description: /Demo tick 10000–10384$/u});
  expect(firstOption.textContent).toContain('Demo tick 10000–10384');
  expect(firstOption.getAttribute('aria-description')).toBe('Demo tick 10000–10384 · 未录制');
  const secondOption = screen.getByRole('option', {name: '选择素材 Mirage R1 · s1mple', description: /Demo tick 10512–10896$/u});
  expect(secondOption.textContent).toContain('Demo tick 10512–10896');
  expect(secondOption.getAttribute('aria-description')).toBe('Demo tick 10512–10896 · 未录制');
  fireEvent.click(secondOption);
  expect(props.onSelectTimelineClip).toHaveBeenCalledExactlyOnceWith('moment-b', 6);
  openSourcePreview();
  fireEvent.click(screen.getByRole('button', {name: '录制片段 Mirage R1 · s1mple'}));
  expect(props.onRequestRecording).toHaveBeenCalledExactlyOnceWith('moment-b');

  fireEvent.click(screen.getByRole('radio', {name: '图标视图'}));
  expect(screen.getByRole('option', {name: '选择素材 Mirage R1 · s1mple', description: /Demo tick 10512–10896$/u}).textContent).toContain('Demo tick 10512–10896');
  const recorded = {...second, material: {kind: 'asset' as const, asset_id: ASSET.id, media_duration_seconds: 10}};
  rerender(<ProjectMediaPanel {...props} assets={[ASSET]} timelineTracks={[storyTrack([first, recorded])]} />);
  fireEvent.change(screen.getByRole('combobox', {name: '筛选素材状态'}), {target: {value: 'recorded'}});
  expect(screen.getAllByRole('option', {name: '选择素材 Mirage R1 · s1mple'})).toHaveLength(1);
  expect(screen.getByRole('option', {name: '选择素材 Mirage R1 · s1mple', description: /Demo tick 10512–10896$/u}).getAttribute('aria-description')).toBe('Demo tick 10512–10896 · 已录制');
});

it('shows real source In/Out for repeated imported footage and inserts the chosen range', () => {
  const first = timelineClipFromMediaAsset(ASSET, 'opening', {sourceIn: 1.25, sourceOut: 3.75});
  const second = timelineClipFromMediaAsset(ASSET, 'ending', {sourceIn: 7, sourceOut: 9.5});
  const props = panelProps({assets: [ASSET], timelineTracks: [storyTrack([first, second])]});
  renderInteractive(<ProjectMediaPanel {...props} />);
  const selected = screen.getByRole('option', {name: '选择素材 Reusable source', description: /源 00:07.000–00:09.500$/u});
  expect(selected.textContent).toContain('源 00:07.000–00:09.500');
  expect(selected.getAttribute('aria-description')).toBe('源 00:07.000–00:09.500 · 已录制');
  expect(screen.getByRole('option', {name: '选择素材 Reusable source', description: /源 00:01.250–00:03.750$/u}).textContent).toContain('源 00:01.250–00:03.750');
  fireEvent.click(selected);
  openSourcePreview();
  fireEvent.keyDown(window, {key: ','});
  expect(props.onInsert).toHaveBeenCalledExactlyOnceWith(ASSET, {sourceIn: 7, sourceOut: 9.5}, {video: true, audio: true});
});

it('uses actual file paths to distinguish imports with the same basename', () => {
  const first = {...ASSET, name: 'clip.mp4', path: 'C:/match-a/clip.mp4'};
  const second = {...first, id: 'asset-b', path: 'C:/match-b/clip.mp4'};
  const props = panelProps({assets: [first, second]});
  renderInteractive(<ProjectMediaPanel {...props} />);
  const option = screen.getByRole('option', {name: '选择素材 clip.mp4', description: /C:\/match-b\/clip.mp4$/u});
  expect(within(option).getByText('C:/match-b/clip.mp4')).toBeTruthy();
  expect(option.getAttribute('aria-description')).toBe('C:/match-b/clip.mp4 · 导入');
  fireEvent.click(option);
  openSourcePreview();
  fireEvent.keyDown(window, {key: ','});
  expect(props.onInsert).toHaveBeenCalledExactlyOnceWith(second, {sourceIn: 0, sourceOut: 10}, {video: true, audio: true});
});

function storyTrack(clips: TimelineClip[]): TimelineTrack {
  return {
    id: 'story', name: 'Story', kind: 'video', order: 0,
    muted: false, solo: false, volume: 1, pan: 0, keyframes: [], locked: false, hidden: false, clips,
  };
}

function panelProps(overrides: Partial<ProjectMediaPanelProps>): ProjectMediaPanelProps {
  return {
    assets: [], timelineTracks: [], projectFps: 60, selectedTimelineClipId: null,
    matchedSourceFrame: null, pending: false, readOnly: false, busy: false,
    canEditAsset: () => true, sourcePatchTargets: () => ({video: 'Story', audio: 'Story'}),
    importAvailable: true, relinkAvailable: true, importing: false,
    onCreateFromDemo: vi.fn(), onSelectTimelineClip: vi.fn(), onRequestRecording: vi.fn(),
    onImport: vi.fn(), onInsert: vi.fn(), onOverwrite: vi.fn(), canReplace: () => true,
    onReplace: vi.fn(), onRelink: vi.fn(), onDelete: vi.fn(), onReplaceAssetMarkers: vi.fn(),
    proxiesEnabled: false, generatingProxyAssetId: null, proxyCleanupBusy: false,
    sequenceMarkerCount: 0, onGenerateProxy: vi.fn(), onToggleProxies: vi.fn(),
    onCleanupProxies: vi.fn(), onAutomateToSequence: vi.fn(), onCreateMulticam: vi.fn(),
    ...overrides,
  };
}

function openSourcePreview() {
  const toggle = screen.getByRole('button', { name: /源预览与片段信息/u });
  if (toggle.getAttribute('aria-expanded') === 'false') fireEvent.click(toggle);
}
