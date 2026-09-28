import { fireEvent, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { toast } from '../../design/feedback';
import type { TimelineClip } from '../../shared/desktop/dto';
import { renderPage } from '../../test/renderPage';
import { ProjectTimeline, type ProjectTimelineProps } from './ProjectTimeline';

const CLIP: TimelineClip = {
  id: 'clip-a',
  name: 'Mirage R1 · selected moment',
  capture_intent: null,
  material: { kind: 'planned' },
  placement: { start: 0, duration: 6, source_in: 12, source_out: 18, speed: 1, reverse: false, frame_hold_source_time: null, volume: 1, pan: 0, enabled: true },
  transform: { x: 0, y: 0, scale_x: 1, scale_y: 1, rotation: 0, opacity: 1 },
  effects: [],
  transitions: { video_in: null, video_out: null, audio_in: null, audio_out: null },
  text: null,
  metadata: {},
  group_id: null,
  link_group_id: null,
  keyframes: [],
  speed_segments: [],
};

function timelineProps(readOnly = false): ProjectTimelineProps {
  return {
    docked: true,
    project: {
      id: 'project-a',
      revision: 1,
      readOnly,
      document: {
        width: 1920,
        height: 1080,
        fps: 60,
        duration_seconds: 180,
        story_track_id: 'story',
        tracks: [{
          id: 'story', name: 'Story', kind: 'video', order: 0,
          muted: false, solo: false, volume: 1, pan: 0, keyframes: [],
          locked: false, hidden: false, clips: [CLIP],
        }],
        markers: [],
        settings: { source_demo_ids: [], ripple_sequence_markers: true, use_media_proxies: false },
      },
    },
    evidence: { reviewGroup: null },
    selection: {
      selectedClipId: CLIP.id,
      selectedClipIds: [CLIP.id],
      targetTrackId: 'story',
      targetTrackIds: ['story'],
      syncLockedTrackIds: ['story'],
      linkedSelectionEnabled: true,
      onSelectClip: vi.fn(),
      onSelectClips: vi.fn(),
      onPromoteClip: vi.fn(),
      onTargetTrack: vi.fn(),
      onToggleSyncLock: vi.fn(),
      onToggleLinkedSelection: vi.fn(),
      onInspectClip: vi.fn(),
      onMatchFrame: vi.fn(),
    },
    transport: {
      timelineTimeSeconds: 2,
      timeDisplayMode: 'timecode',
      onTimeDisplayModeChange: vi.fn(),
      rangeInSeconds: null,
      rangeOutSeconds: null,
      playing: false,
      loopPlaybackEnabled: false,
      onSeek: vi.fn(),
      onRangeChange: vi.fn(),
      onTogglePlayback: vi.fn(),
      onToggleLoopPlayback: vi.fn(),
      onShuttle: vi.fn(),
    },
    editing: {
      onReplaceClip: vi.fn(),
      onReplaceTrack: vi.fn(),
      onReplaceTrackClips: vi.fn(),
      onReplaceTrackClipGroups: vi.fn(),
      onApplyCrossTrackMove: vi.fn(),
      onReplaceClips: vi.fn(),
      onPreviewClips: vi.fn(),
      onPreviewRollingEdit: vi.fn(),
      onPreviewSlideEdit: vi.fn(),
      onTrimPlaybackRangeChange: vi.fn(),
      onInsertTrack: vi.fn(),
      onRemoveTrack: vi.fn(),
      onReorderTracks: vi.fn(),
      onReplaceMarkers: vi.fn(),
      onReplaceSettings: vi.fn(),
      onDropMediaAsset: vi.fn(),
    },
    services: {},
    history: {
      canRevertReview: false,
      onRevertReview: vi.fn(),
      canUndo: true,
      onUndo: vi.fn(),
      canRedo: false,
      onRedo: vi.fn(),
    },
  };
}

const LATER_CLIP: TimelineClip = {
  ...CLIP,
  id: 'clip-b',
  name: 'Mirage R2 · later moment',
  placement: { ...CLIP.placement, start: 6, source_in: 30, source_out: 36 },
};

/** Two Story clips with only the first selected, and the playhead inside it. */
function twoClipProps(): ProjectTimelineProps {
  const props = timelineProps();
  const [story] = props.project.document.tracks;
  return {
    ...props,
    project: {
      ...props.project,
      document: { ...props.project.document, tracks: [{ ...story!, clips: [CLIP, LATER_CLIP] }] },
    },
  };
}

function clipButton(clip: TimelineClip): HTMLElement {
  return document.querySelector<HTMLElement>(`[data-timeline-clip-id="${clip.id}"]`)!;
}

function openMenu(name: string): void {
  fireEvent.pointerDown(screen.getByRole('button', { name }), { button: 0, ctrlKey: false });
}

afterEach(() => vi.restoreAllMocks());

describe('Project Timeline command hierarchy', () => {
  it('runs common controls and their keyboard equivalents through the same editing and transport interfaces', () => {
    const props = timelineProps();
    renderPage({ element: <ProjectTimeline {...props} />, client: {} });
    const timeline = screen.getByRole('region', { name: '时间轴' });

    expect(screen.queryByRole('button', { name: '剪辑操作' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '播放序列' }));
    fireEvent.keyDown(timeline, { key: ' ' });
    expect(props.transport.onTogglePlayback).toHaveBeenCalledTimes(2);

    fireEvent.click(screen.getByRole('button', { name: '在播放头分割 (Ctrl/Cmd+K)' }));
    expect(props.editing.onReplaceTrackClipGroups).toHaveBeenCalledWith([
      expect.objectContaining({
        trackId: 'story',
        clips: [
          expect.objectContaining({ placement: expect.objectContaining({ start: 0, duration: 2 }) }),
          expect.objectContaining({ placement: expect.objectContaining({ start: 2, duration: 4 }) }),
        ],
      }),
    ]);
    fireEvent.keyDown(timeline, { key: 'k', ctrlKey: true });
    expect(props.editing.onReplaceTrackClipGroups).toHaveBeenCalledTimes(2);

    fireEvent.click(screen.getByRole('button', { name: '撤销上一次剪辑' }));
    fireEvent.keyDown(timeline, { key: 'z', ctrlKey: true });
    expect(props.history.onUndo).toHaveBeenCalledTimes(2);

    const snap = screen.getByRole('button', { name: '切换时间轴吸附' });
    fireEvent.click(snap);
    expect(snap.getAttribute('aria-pressed')).toBe('false');
    fireEvent.keyDown(timeline, { key: 's' });
    expect(snap.getAttribute('aria-pressed')).toBe('true');
  });

  it('discloses advanced command groups without losing marker, linked-selection, track or detail actions', () => {
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(600);
    const props = timelineProps();
    renderPage({ element: <ProjectTimeline {...props} />, client: {} });
    const disclosure = screen.getByRole('button', { name: '高级时间轴操作' });
    fireEvent.click(disclosure);
    expect(disclosure.getAttribute('aria-expanded')).toBe('true');

    openMenu('标记操作');
    fireEvent.click(screen.getByRole('menuitem', { name: '在播放头标记入点' }));
    expect(props.transport.onRangeChange).toHaveBeenCalledWith(2, null);
    openMenu('标记操作');
    fireEvent.click(screen.getByRole('menuitem', { name: '切换循环播放' }));
    expect(props.transport.onToggleLoopPlayback).toHaveBeenCalledTimes(1);

    openMenu('剪辑操作');
    fireEvent.click(screen.getByRole('menuitem', { name: '切换链接选择' }));
    expect(props.selection.onToggleLinkedSelection).toHaveBeenCalledTimes(1);
    openMenu('添加到时间轴');
    fireEvent.click(screen.getByRole('menuitem', { name: '添加音频轨道' }));
    expect(props.editing.onInsertTrack).toHaveBeenCalledWith(expect.objectContaining({ kind: 'audio' }), expect.any(Number));

    fireEvent.click(disclosure);
    expect(screen.queryByRole('button', { name: '标记操作' })).toBeNull();
    const context = screen.getByRole('status', { name: '所选片段信息' });
    expect(within(context).getByText(CLIP.name)).toBeTruthy();
    fireEvent.click(within(context).getByRole('button', { name: `查看片段详情 ${CLIP.name}` }));
    expect(props.selection.onInspectClip).toHaveBeenCalledWith(CLIP.id);

    fireEvent.click(within(context).getByRole('button', { name: '缩放至所选片段' }));
    const zoom = screen.getByRole('slider', { name: '时间轴缩放' }) as HTMLInputElement;
    expect(Number(zoom.value)).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('button', { name: '适应' }));
    expect(Number(zoom.value)).toBe(0);
    expect(props.transport.onSeek).not.toHaveBeenCalled();
    expect(props.editing.onReplaceTrackClipGroups).not.toHaveBeenCalled();
  });

  it('explains the read-only edit boundary while keeping playback and inspection available', async () => {
    const props = timelineProps(true);
    renderPage({ element: <ProjectTimeline {...props} />, client: {} });
    const split = screen.getByRole('button', { name: '在播放头分割 (Ctrl/Cmd+K)' }) as HTMLButtonElement;
    expect(split.disabled).toBe(true);
    fireEvent.focus(split.parentElement as HTMLElement);
    expect((await screen.findByRole('tooltip')).textContent).toBe('时间轴当前只读');
    fireEvent.blur(split.parentElement as HTMLElement);
    fireEvent.keyDown(screen.getByRole('region', { name: '时间轴' }), { key: 'k', ctrlKey: true });
    expect(props.editing.onReplaceTrackClipGroups).not.toHaveBeenCalled();
    expect((screen.getByRole('button', { name: '撤销上一次剪辑' }) as HTMLButtonElement).disabled).toBe(true);

    openMenu('高级工具');
    const razor = screen.getByRole('menuitem', { name: /剃刀工具 \(C\)/u });
    expect(razor.getAttribute('aria-disabled')).toBe('true');
    expect(razor.textContent).toContain('没有可分割的未锁定片段');
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });

    fireEvent.click(screen.getByRole('button', { name: '高级时间轴操作' }));
    openMenu('添加到时间轴');
    expect(screen.getByRole('menuitem', { name: '添加音频轨道' }).getAttribute('aria-disabled')).toBe('true');
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
    fireEvent.click(screen.getByRole('button', { name: '播放序列' }));
    expect(props.transport.onTogglePlayback).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: `查看片段详情 ${CLIP.name}` }));
    expect(props.selection.onInspectClip).toHaveBeenCalledWith(CLIP.id);
  });

  it('moves the playhead into a plainly clicked clip through the transport seek, but not on a drag or modified click', () => {
    const props = twoClipProps();
    renderPage({ element: <ProjectTimeline {...props} />, client: {} });

    fireEvent.pointerDown(clipButton(CLIP), { clientX: 20, pointerId: 1, button: 0 });
    fireEvent.pointerUp(clipButton(CLIP), { clientX: 20, pointerId: 1 });
    // The playhead (2s) is already inside the first clip, so it stays.
    expect(props.transport.onSeek).not.toHaveBeenCalled();

    fireEvent.pointerDown(clipButton(LATER_CLIP), { clientX: 200, pointerId: 2, button: 0 });
    fireEvent.pointerUp(clipButton(LATER_CLIP), { clientX: 200, pointerId: 2 });
    expect(props.selection.onSelectClip).toHaveBeenLastCalledWith(LATER_CLIP.id, false, false);
    expect(props.transport.onSeek).toHaveBeenCalledTimes(1);
    expect(props.transport.onSeek).toHaveBeenCalledWith(6);

    fireEvent.pointerDown(clipButton(LATER_CLIP), { clientX: 200, pointerId: 3, button: 0, ctrlKey: true });
    fireEvent.pointerUp(clipButton(LATER_CLIP), { clientX: 200, pointerId: 3, ctrlKey: true });
    fireEvent.pointerDown(clipButton(LATER_CLIP), { clientX: 200, pointerId: 4, button: 0, shiftKey: true });
    fireEvent.pointerUp(clipButton(LATER_CLIP), { clientX: 200, pointerId: 4, shiftKey: true });
    expect(props.transport.onSeek).toHaveBeenCalledTimes(1);

    fireEvent.pointerDown(clipButton(LATER_CLIP), { clientX: 200, pointerId: 5, button: 0 });
    fireEvent.pointerMove(clipButton(LATER_CLIP), { clientX: 320, pointerId: 5 });
    fireEvent.pointerUp(clipButton(LATER_CLIP), { clientX: 320, pointerId: 5 });
    expect(props.transport.onSeek).toHaveBeenCalledTimes(1);
  });

  it('draws the selected clip with a solid accent outline', () => {
    renderPage({ element: <ProjectTimeline {...twoClipProps()} />, client: {} });
    expect(clipButton(CLIP).className).toContain('after:border-accent');
    expect(clipButton(CLIP).className).not.toContain('border-dashed');
    expect(clipButton(LATER_CLIP).className).not.toContain('after:border-accent');
  });

  it('explains an unavailable split or delete instead of ignoring the shortcut', async () => {
    const info = vi.spyOn(toast, 'info');
    const base = timelineProps();
    const props: ProjectTimelineProps = {
      ...base,
      selection: { ...base.selection, selectedClipId: null, selectedClipIds: [] },
      transport: { ...base.transport, timelineTimeSeconds: 120 },
    };
    renderPage({ element: <ProjectTimeline {...props} />, client: {} });
    const timeline = screen.getByRole('region', { name: '时间轴' });

    fireEvent.keyDown(timeline, { key: 'k', ctrlKey: true });
    expect(info).toHaveBeenLastCalledWith('把播放头移到未锁定的目标轨片段内再分割');
    fireEvent.keyDown(timeline, { key: 'k', ctrlKey: true, shiftKey: true });
    expect(info).toHaveBeenLastCalledWith('把播放头移到未锁定的片段内再分割');
    expect(props.editing.onReplaceTrackClipGroups).not.toHaveBeenCalled();

    const split = screen.getByRole('button', { name: '在播放头分割 (Ctrl/Cmd+K)' }) as HTMLButtonElement;
    expect(split.disabled).toBe(true);
    fireEvent.focus(split.parentElement as HTMLElement);
    expect((await screen.findByRole('tooltip')).textContent).toBe('把播放头移到未锁定的目标轨片段内再分割');
    fireEvent.blur(split.parentElement as HTMLElement);

    fireEvent.keyDown(timeline, { key: 'Delete' });
    expect(info).toHaveBeenLastCalledWith('先选中要删除的片段');
    expect(info).toHaveBeenCalledTimes(3);
  });

  it('does not toast shortcuts typed into a field', () => {
    const info = vi.spyOn(toast, 'info');
    const base = timelineProps();
    const props: ProjectTimelineProps = { ...base, selection: { ...base.selection, selectedClipId: null, selectedClipIds: [] } };
    renderPage({ element: <ProjectTimeline {...props} />, client: {} });
    const field = document.createElement('input');
    screen.getByRole('region', { name: '时间轴' }).appendChild(field);
    fireEvent.keyDown(field, { key: 'Delete' });
    fireEvent.keyDown(field, { key: 'k', ctrlKey: true });
    expect(info).not.toHaveBeenCalled();
  });
});
