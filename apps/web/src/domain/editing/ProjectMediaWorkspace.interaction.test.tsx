import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import { useCallback, useState } from 'react';
import { expect, it, vi } from 'vitest';
import { renderInteractive } from '../../test/render';
import { ProjectMediaWorkspace, type ProjectMediaWorkspaceProps } from './ProjectMediaWorkspace';
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
  renderInteractive(<WorkspaceHarness {...props} />);
  fireEvent.click(screen.getByRole('option', {name: '选择素材 Reusable source'}));
  openSourcePreview();
  expect((screen.getByRole('button', {name: '在播放头插入 Reusable source'}) as HTMLButtonElement).disabled).toBe(false);
  fireEvent.keyDown(window, {key: ','});
  expect(onInsert).toHaveBeenCalledTimes(1);
  cleanup();
  onInsert.mockClear();
  const track: TimelineTrack = {id: 'story', name: 'Story', kind: 'video', order: 0,
    muted: false, solo: false, volume: 1, pan: 0, keyframes: [], locked: false, hidden: false,
    clips: [timelineClipFromMediaAsset(asset, 'placed-a')]};
  renderInteractive(<WorkspaceHarness {...props} timelineTracks={[track]} />);
  fireEvent.click(screen.getByRole('option', {name: '选择素材 Reusable source'}));
  openSourcePreview();
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
  renderInteractive(<WorkspaceHarness {...props} timelineTracks={[track]} readOnly />);
  fireEvent.click(screen.getByRole('option', {name: '选择素材 Reusable source'}));
  openSourcePreview();
  expect((screen.getByRole('button', {name: '在播放头插入 Reusable source'}) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.keyDown(window, {key: ','});
  expect(onInsert).not.toHaveBeenCalled();
});

it('keeps same-round source evidence in descriptions and the selected source monitor while filtering', () => {
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
  const {rerender} = renderInteractive(<WorkspaceHarness {...props} />);
  const firstOption = screen.getByRole('option', {name: '选择素材 Mirage R1 · s1mple', description: /Demo tick 10000–10384$/u});
  expect(firstOption.textContent).not.toContain('Demo tick');
  expect(firstOption.textContent).not.toContain('未录制');
  expect(firstOption.getAttribute('aria-description')).toBe('Demo tick 10000–10384 · 未录制');
  const secondOption = screen.getByRole('option', {name: '选择素材 Mirage R1 · s1mple', description: /Demo tick 10512–10896$/u});
  expect(secondOption.textContent).not.toContain('Demo tick');
  expect(secondOption.getAttribute('aria-description')).toBe('Demo tick 10512–10896 · 未录制');
  fireEvent.click(secondOption);
  expect(props.onSelectTimelineClip).toHaveBeenCalledExactlyOnceWith('moment-b', 6);
  openSourcePreview();
  expect(within(screen.getByRole('region', {name: '源预览'})).getByText('Demo tick 10512–10896')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', {name: '录制片段 Mirage R1 · s1mple'}));
  expect(props.onRequestRecording).toHaveBeenCalledExactlyOnceWith('moment-b');

  fireEvent.click(screen.getByRole('radio', {name: '图标视图'}));
  expect(screen.getByRole('option', {name: '选择素材 Mirage R1 · s1mple', description: /Demo tick 10512–10896$/u}).getAttribute('aria-description')).toBe('Demo tick 10512–10896 · 未录制');
  const recorded = {...second, material: {kind: 'asset' as const, asset_id: ASSET.id, media_duration_seconds: 10}};
  rerender(<WorkspaceHarness {...props} assets={[ASSET]} timelineTracks={[storyTrack([first, recorded])]} />);
  fireEvent.change(screen.getByRole('combobox', {name: '筛选素材状态'}), {target: {value: 'recorded'}});
  expect(screen.getAllByRole('option', {name: '选择素材 Mirage R1 · s1mple'})).toHaveLength(1);
  expect(screen.getByRole('option', {name: '选择素材 Mirage R1 · s1mple', description: /Demo tick 10512–10896$/u}).getAttribute('aria-description')).toBe('Demo tick 10512–10896 · 已录制');
});

it('shows real source In/Out for repeated imported footage and inserts the chosen range', () => {
  const first = timelineClipFromMediaAsset(ASSET, 'opening', {sourceIn: 1.25, sourceOut: 3.75});
  const second = timelineClipFromMediaAsset(ASSET, 'ending', {sourceIn: 7, sourceOut: 9.5});
  const props = panelProps({assets: [ASSET], timelineTracks: [storyTrack([first, second])]});
  renderInteractive(<WorkspaceHarness {...props} />);
  const selected = screen.getByRole('option', {name: '选择素材 Reusable source', description: /源 00:07.000–00:09.500$/u});
  expect(selected.textContent).not.toContain('00:07.000');
  expect(selected.getAttribute('aria-description')).toBe('源 00:07.000–00:09.500 · 已录制');
  expect(screen.getByRole('option', {name: '选择素材 Reusable source', description: /源 00:01.250–00:03.750$/u}).getAttribute('aria-description')).toBe('源 00:01.250–00:03.750 · 已录制');
  fireEvent.click(selected);
  openSourcePreview();
  expect(within(screen.getByRole('region', {name: '源预览'})).getByText('入点 00:07.000 · 出点 00:09.500')).toBeTruthy();
  fireEvent.keyDown(window, {key: ','});
  expect(props.onInsert).toHaveBeenCalledExactlyOnceWith(ASSET, {sourceIn: 7, sourceOut: 9.5}, {video: true, audio: true});
});

it('uses actual file paths to distinguish imports with the same basename', () => {
  const first = {...ASSET, name: 'clip.mp4', path: 'C:/match-a/clip.mp4'};
  const second = {...first, id: 'asset-b', path: 'C:/match-b/clip.mp4'};
  const props = panelProps({assets: [first, second]});
  renderInteractive(<WorkspaceHarness {...props} />);
  const option = screen.getByRole('option', {name: '选择素材 clip.mp4', description: /C:\/match-b\/clip.mp4$/u});
  expect(option.textContent).not.toContain('C:/match-b/clip.mp4');
  expect(option.getAttribute('aria-description')).toBe('C:/match-b/clip.mp4 · 导入');
  fireEvent.click(option);
  openSourcePreview();
  expect(within(screen.getByRole('region', {name: '源预览'})).getByText('C:/match-b/clip.mp4')).toBeTruthy();
  fireEvent.keyDown(window, {key: ','});
  expect(props.onInsert).toHaveBeenCalledExactlyOnceWith(second, {sourceIn: 0, sourceOut: 10}, {video: true, audio: true});
});

it('opens the source monitor only on request and preserves the source edit when the project panel disappears', () => {
  const props = panelProps({assets: [ASSET]});
  const {rerender} = renderInteractive(<WorkspaceHarness {...props} />);
  expect((screen.getByRole('button', {name: '检查源片段'}) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole('option', {name: '选择素材 Reusable source'}));
  expect(props.onShowSource).not.toHaveBeenCalled();
  expect(screen.queryByRole('region', {name: '源预览'})).toBeNull();
  openSourcePreview();
  expect(props.onShowSource).toHaveBeenCalledTimes(1);
  const source = screen.getByRole('region', {name: '源预览'});
  const media = source.querySelector('video')!;
  expect(media).not.toBeNull();
  const pause = vi.spyOn(media, 'pause').mockImplementation(() => {});
  fireEvent.change(within(source).getByRole('slider', {name: '源素材播放头'}), {target: {value: 3}});
  fireEvent.click(within(source).getByRole('button', {name: '标记源入点'}));

  rerender(<WorkspaceHarness {...props} projectVisible={false} />);
  expect(screen.queryByRole('region', {name: '项目素材'})).toBeNull();
  expect(screen.getByRole('region', {name: '源预览'}).querySelector('video')).toBe(media);
  fireEvent.click(screen.getByRole('button', {name: '显示成片监视器'}));
  expect(pause).toHaveBeenCalledOnce();
  expect(screen.queryByRole('region', {name: '源预览'})).toBeNull();
  fireEvent.click(screen.getByRole('button', {name: '显示源监视器'}));
  expect(screen.getByRole('region', {name: '源预览'}).querySelector('video')).toBe(media);
  expect(screen.getByText('入点 00:03.000 · 出点 00:10.000')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', {name: '在播放头插入 Reusable source'}));
  expect(props.onInsert).toHaveBeenCalledExactlyOnceWith(ASSET, {sourceIn: 3, sourceOut: 10}, {video: true, audio: true});
});

it('pauses a hidden source monitor and ignores playback completion after its Dock tab is hidden', async () => {
  const props = panelProps({assets: [ASSET]});
  renderInteractive(<WorkspaceHarness {...props} />);
  fireEvent.click(screen.getByRole('option', {name: '选择素材 Reusable source'}));
  openSourcePreview();
  const media = screen.getByRole('region', {name: '源预览'}).querySelector('video')!;
  let paused = true;
  let finishPlay = () => {};
  Object.defineProperty(media, 'paused', {configurable: true, get: () => paused});
  const play = vi.spyOn(media, 'play').mockImplementation(() => {
    paused = false;
    return new Promise<void>((resolve) => { finishPlay = resolve; });
  });
  const pause = vi.spyOn(media, 'pause').mockImplementation(() => { paused = true; });
  fireEvent.click(screen.getByRole('button', {name: '播放源素材'}));
  expect(play).toHaveBeenCalledOnce();
  expect(paused).toBe(false);
  fireEvent.click(screen.getByRole('button', {name: '显示成片监视器'}));
  expect(pause).toHaveBeenCalledOnce();
  expect(paused).toBe(true);
  await act(async () => { finishPlay(); });
  expect(pause).toHaveBeenCalledTimes(2);
  fireEvent.click(screen.getByRole('button', {name: '显示源监视器'}));
  expect(screen.getByRole('button', {name: '播放源素材'})).toBeTruthy();
  expect(screen.getByRole('region', {name: '源预览'}).querySelector('video')).toBe(media);
});

it('opens the selected source frame from the explicit timeline match-frame command', () => {
  const clip = timelineClipFromMediaAsset(ASSET, 'placed-source');
  const props = panelProps({assets: [ASSET], timelineTracks: [storyTrack([clip])], matchedSourceFrame: {clipId: clip.id, sourceTime: 4.5}});
  renderInteractive(<WorkspaceHarness {...props} />);
  expect(props.onShowSource).toHaveBeenCalledOnce();
  expect((within(screen.getByRole('region', {name: '源预览'})).getByRole('slider', {name: '源素材播放头'}) as HTMLInputElement).value).toBe('4.5');
  expect(screen.getByRole('option', {name: '选择素材 Reusable source'}).getAttribute('aria-selected')).toBe('true');
});

function storyTrack(clips: TimelineClip[]): TimelineTrack {
  return {
    id: 'story', name: 'Story', kind: 'video', order: 0,
    muted: false, solo: false, volume: 1, pan: 0, keyframes: [], locked: false, hidden: false, clips,
  };
}

function panelProps(overrides: Partial<HarnessProps>): HarnessProps {
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
    onShowSource: vi.fn(),
    ...overrides,
  };
}

function openSourcePreview() {
  fireEvent.click(screen.getByRole('button', {name: '检查源片段'}));
}

type HarnessProps = Omit<ProjectMediaWorkspaceProps, 'children' | 'sourceActive'> & {readonly projectVisible?: boolean};

function WorkspaceHarness({projectVisible = true, onShowSource, ...props}: HarnessProps) {
  const [sourceActive, setSourceActive] = useState(false);
  const showSource = useCallback(() => {
    onShowSource();
    setSourceActive(true);
  }, [onShowSource]);
  return <ProjectMediaWorkspace {...props} sourceActive={sourceActive} onShowSource={showSource}>
    {({project, source}) => <>
      <button onClick={() => setSourceActive(false)}>显示成片监视器</button>
      <button onClick={showSource}>显示源监视器</button>
      {projectVisible ? project : null}
      <div hidden={!sourceActive}>{source}</div>
    </>}
  </ProjectMediaWorkspace>;
}
