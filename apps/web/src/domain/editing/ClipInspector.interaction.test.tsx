import { fireEvent, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';

import type { TimelineClip, TimelineTrack } from '../../shared/desktop/dto';
import { renderInteractive } from '../../test/render';
import { ClipInspector } from './ClipInspector';

const FPS = 30;

const CLIP: TimelineClip = {
  id: '00000000-0000-4000-8000-000000000301',
  name: 'Entry',
  capture_intent: null,
  material: { kind: 'asset', asset_id: 'asset-entry', media_duration_seconds: 8 },
  placement: { start: 0, duration: 4, source_in: 1, source_out: 5, speed: 1, reverse: false, frame_hold_source_time: null, volume: 1, pan: 0, enabled: true },
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

const TRACK: TimelineTrack = {
  id: '00000000-0000-4000-8000-000000000302',
  name: 'Story',
  kind: 'video',
  order: 0,
  muted: false,
  solo: false,
  volume: 1,
  pan: 0,
  keyframes: [],
  locked: false,
  hidden: false,
  clips: [CLIP],
};

/** Stands in for the Editing Document: each Human Edit becomes the canonical clip. */
function Harness({
  initial = CLIP,
  readOnly = false,
  time = 0,
  onReplace,
}: {
  readonly initial?: TimelineClip;
  readonly readOnly?: boolean;
  readonly time?: number;
  readonly onReplace: (clip: TimelineClip) => void;
}) {
  const [clip, setClip] = useState(initial);
  return (
    <ClipInspector
      cameraPreview={null}
      selected={{ track: { ...TRACK, clips: [clip] }, clip }}
      readOnly={readOnly}
      timelineTimeSeconds={time}
      fps={FPS}
      onSeek={() => undefined}
      onReplace={(next) => {
        onReplace(next);
        setClip(next);
      }}
    />
  );
}

function renderInspector(props: Omit<Parameters<typeof Harness>[0], 'onReplace'> = {}) {
  const onReplace = vi.fn<(clip: TimelineClip) => void>();
  const view = renderInteractive(<Harness {...props} onReplace={onReplace} />);
  return { onReplace, view };
}

function field(name: string): HTMLInputElement {
  return screen.getByRole(name === '播放速度（倍）' ? 'spinbutton' : 'textbox', { name }) as HTMLInputElement;
}

describe('ClipInspector direct edits', () => {
  it('keeps typing local and commits the name once on blur', () => {
    const { onReplace } = renderInspector();

    fireEvent.change(field('名称'), { target: { value: 'E' } });
    fireEvent.change(field('名称'), { target: { value: 'Entry frag ' } });
    expect(onReplace).not.toHaveBeenCalled();
    fireEvent.blur(field('名称'));

    expect(onReplace).toHaveBeenCalledTimes(1);
    expect(onReplace).toHaveBeenCalledWith(expect.objectContaining({ name: 'Entry frag' }));
    expect(field('名称').value).toBe('Entry frag');
    expect(screen.queryByRole('button', { name: '保存修改' })).toBeNull();
    expect(screen.queryByRole('button', { name: '放弃修改' })).toBeNull();
  });

  it('commits on Enter, restores on Escape, and skips an unchanged value', () => {
    const { onReplace } = renderInspector();

    fireEvent.change(field('名称'), { target: { value: 'Discarded' } });
    fireEvent.keyDown(field('名称'), { key: 'Escape' });
    expect(field('名称').value).toBe('Entry');
    fireEvent.blur(field('名称'));
    expect(onReplace).not.toHaveBeenCalled();

    fireEvent.change(field('名称'), { target: { value: 'Entry' } });
    fireEvent.keyDown(field('名称'), { key: 'Enter' });
    expect(onReplace).not.toHaveBeenCalled();

    fireEvent.change(field('名称'), { target: { value: 'Opening' } });
    fireEvent.keyDown(field('名称'), { key: 'Enter' });
    fireEvent.blur(field('名称'));
    expect(onReplace).toHaveBeenCalledTimes(1);
    expect(onReplace).toHaveBeenCalledWith(expect.objectContaining({ name: 'Opening' }));
  });

  it('edits source In and Out as project-rate timecode through the Timeline trim', () => {
    const { onReplace } = renderInspector({ initial: { ...CLIP, placement: { ...CLIP.placement, start: 2 } } });

    expect(field('源入点').value).toBe('00:00:01:00');
    expect(field('源出点').value).toBe('00:00:05:00');
    expect(screen.queryByRole('spinbutton', { name: '时长（秒）' })).toBeNull();
    expect(screen.getByText('00:00:04:00')).toBeTruthy();

    fireEvent.change(field('源入点'), { target: { value: '00:00:00:15' } });
    fireEvent.keyDown(field('源入点'), { key: 'Enter' });
    expect(onReplace).toHaveBeenLastCalledWith(expect.objectContaining({
      placement: expect.objectContaining({ start: 1.5, duration: 4.5, source_in: 0.5, source_out: 5 }),
    }));

    fireEvent.change(field('源出点'), { target: { value: '00:00:06:00' } });
    fireEvent.blur(field('源出点'));
    expect(onReplace).toHaveBeenLastCalledWith(expect.objectContaining({
      placement: expect.objectContaining({ start: 1.5, duration: 5.5, source_in: 0.5, source_out: 6 }),
    }));
    expect(onReplace).toHaveBeenCalledTimes(2);
    expect(field('源入点').value).toBe('00:00:00:15');
    expect(screen.getByText('00:00:05:15')).toBeTruthy();
  });

  it('keeps the last good value and explains input that cannot be committed', () => {
    const { onReplace } = renderInspector();
    const cases: ReadonlyArray<readonly [string, string, string]> = [
      ['源入点', '1.5', '请输入 时:分:秒:帧 时间码'],
      ['源入点', '00:00:00:30', '请输入 时:分:秒:帧 时间码'],
      ['源入点', '00:00:05:00', '入点须早于出点'],
      ['源出点', '00:00:00:20', '出点须晚于入点'],
      ['源出点', '00:00:09:00', '超出源素材时长'],
      ['播放速度（倍）', '0', '速度须在 0.0625–16 倍之间'],
      ['播放速度（倍）', '', '请输入数字'],
      ['名称', '  ', '名称不能为空'],
    ];
    for (const [name, value, reason] of cases) {
      fireEvent.change(field(name), { target: { value } });
      fireEvent.blur(field(name));
      expect(field(name).getAttribute('aria-invalid')).toBe('true');
      expect(screen.getByRole('alert').textContent).toBe(reason);
      fireEvent.keyDown(field(name), { key: 'Escape' });
      expect(field(name).getAttribute('aria-invalid')).toBeNull();
      expect(screen.queryByRole('alert')).toBeNull();
    }
    expect(onReplace).not.toHaveBeenCalled();
    expect(field('源入点').value).toBe('00:00:01:00');
  });

  it('authors signed speed as one Rate Stretch and shows the resulting duration', () => {
    const { onReplace } = renderInspector();

    fireEvent.change(field('播放速度（倍）'), { target: { value: '-2' } });
    fireEvent.keyDown(field('播放速度（倍）'), { key: 'Enter' });

    expect(onReplace).toHaveBeenCalledTimes(1);
    expect(onReplace).toHaveBeenCalledWith(expect.objectContaining({
      placement: expect.objectContaining({ duration: 2, speed: 2, reverse: true, source_in: 1, source_out: 5 }),
    }));
    expect(field('播放速度（倍）').value).toBe('-2');
    expect(screen.getByText('00:00:02:00')).toBeTruthy();
  });

  it('disables every field with the read-only reason under an Edit Lease', () => {
    const { onReplace } = renderInspector({ readOnly: true });

    expect(screen.getByText('当前片段只读，请先结束 Agent 编辑或解锁轨道。')).toBeTruthy();
    for (const name of ['名称', '源入点', '源出点', '播放速度（倍）']) expect(field(name).disabled).toBe(true);
    expect(onReplace).not.toHaveBeenCalled();
  });

  it('locks source timing while Time Remapping owns the speed', () => {
    renderInspector({
      initial: { ...CLIP, speed_segments: [{ id: 'segment', start: 0, end: 4, speed: 1 }] },
    });

    expect(field('源入点').disabled).toBe(true);
    expect(field('源出点').disabled).toBe(true);
    expect(field('播放速度（倍）').disabled).toBe(true);
  });

  it('writes each effect action as its own Human Edit', () => {
    const { onReplace } = renderInspector();

    fireEvent.change(screen.getByRole('combobox', { name: '添加效果类型' }), { target: { value: 'color_adjust' } });
    fireEvent.click(screen.getByRole('button', { name: '添加效果' }));
    fireEvent.change(screen.getByRole('spinbutton', { name: '颜色调整 亮度' }), { target: { value: '0.25' } });
    fireEvent.blur(screen.getByRole('spinbutton', { name: '颜色调整 亮度' }));
    fireEvent.change(screen.getByRole('combobox', { name: '添加效果类型' }), { target: { value: 'blur' } });
    fireEvent.click(screen.getByRole('button', { name: '添加效果' }));
    fireEvent.change(screen.getByRole('spinbutton', { name: '模糊 半径' }), { target: { value: '5' } });
    fireEvent.keyDown(screen.getByRole('spinbutton', { name: '模糊 半径' }), { key: 'Enter' });
    fireEvent.click(screen.getByRole('button', { name: '上移效果 模糊' }));

    expect(onReplace).toHaveBeenCalledTimes(5);
    expect(onReplace).toHaveBeenLastCalledWith(expect.objectContaining({
      effects: [
        expect.objectContaining({ kind: 'blur', enabled: true, parameters: { radius: 5 } }),
        expect.objectContaining({ kind: 'color_adjust', enabled: true, parameters: { brightness: 0.25, contrast: 1, saturation: 1 } }),
      ],
    }));
  });

  it('authors transform and Volume keyframes at the shared playhead', () => {
    const onReplace = vi.fn<(clip: TimelineClip) => void>();
    const { rerender } = renderInteractive(<Harness onReplace={onReplace} time={0} />);

    fireEvent.change(screen.getByRole('spinbutton', { name: '位置 X' }), { target: { value: '100' } });
    fireEvent.blur(screen.getByRole('spinbutton', { name: '位置 X' }));
    fireEvent.click(screen.getByRole('button', { name: '在播放头添加 位置 X 关键帧' }));
    fireEvent.click(screen.getByRole('button', { name: '在播放头添加 音量 关键帧' }));
    rerender(<Harness onReplace={onReplace} time={1} />);
    expect((screen.getByRole('spinbutton', { name: '位置 X' }) as HTMLInputElement).value).toBe('100');
    fireEvent.change(screen.getByRole('spinbutton', { name: '位置 X' }), { target: { value: '200' } });
    fireEvent.blur(screen.getByRole('spinbutton', { name: '位置 X' }));
    fireEvent.change(screen.getByRole('spinbutton', { name: '音量' }), { target: { value: '2' } });
    fireEvent.blur(screen.getByRole('spinbutton', { name: '音量' }));

    expect(onReplace).toHaveBeenCalledTimes(5);
    expect(onReplace).toHaveBeenLastCalledWith(expect.objectContaining({
      transform: expect.objectContaining({ x: 100 }),
      placement: expect.objectContaining({ volume: 1 }),
      keyframes: expect.arrayContaining([
        expect.objectContaining({ time: 0, property: 'x', value: 100 }),
        expect.objectContaining({ time: 1, property: 'x', value: 200 }),
        expect.objectContaining({ time: 0, property: 'volume', value: 1 }),
        expect.objectContaining({ time: 1, property: 'volume', value: 2 }),
      ]),
    }));
  });

  it('authors Bezier interpolation and tangents on the canonical keyframe', () => {
    const { onReplace } = renderInspector({
      initial: {
        ...CLIP,
        keyframes: [
          { id: 'x-0', time: 0, property: 'x', value: 0, interpolation: 'linear', in_tangent: 0, out_tangent: 0 },
          { id: 'x-1', time: 1, property: 'x', value: 100, interpolation: 'linear', in_tangent: 0, out_tangent: 0 },
        ],
      },
    });

    fireEvent.change(screen.getByRole('combobox', { name: 'x 插值' }), { target: { value: 'bezier' } });
    fireEvent.change(screen.getByRole('spinbutton', { name: 'x 出切线' }), { target: { value: '2' } });
    fireEvent.blur(screen.getByRole('spinbutton', { name: 'x 出切线' }));

    expect(onReplace).toHaveBeenCalledTimes(2);
    expect(onReplace).toHaveBeenLastCalledWith(expect.objectContaining({
      keyframes: expect.arrayContaining([expect.objectContaining({ id: 'x-0', interpolation: 'bezier', out_tangent: 2 })]),
    }));
  });

  it('authors Time Remapping sections one action at a time', () => {
    const { onReplace } = renderInspector({ initial: { ...CLIP, placement: { ...CLIP.placement, source_in: 0, source_out: 4 } }, time: 2 });

    fireEvent.click(screen.getByRole('button', { name: '启用' }));
    fireEvent.click(screen.getByRole('button', { name: '在播放头添加速度关键帧' }));
    fireEvent.change(screen.getByRole('spinbutton', { name: '区间 2 速度百分比' }), { target: { value: '200' } });
    fireEvent.blur(screen.getByRole('spinbutton', { name: '区间 2 速度百分比' }));

    expect(onReplace).toHaveBeenCalledTimes(3);
    expect(onReplace).toHaveBeenLastCalledWith(expect.objectContaining({
      placement: expect.objectContaining({ duration: 3, source_in: 0, source_out: 4 }),
      speed_segments: [
        expect.objectContaining({ start: 0, end: 2, speed: 1 }),
        expect.objectContaining({ start: 2, end: 3, speed: 2 }),
      ],
    }));
  });

  it('holds the source frame under the playhead and locks the timing fields', () => {
    const { onReplace } = renderInspector({ time: 2 });

    fireEvent.click(screen.getByRole('button', { name: '定格当前帧' }));

    expect(onReplace).toHaveBeenCalledWith(expect.objectContaining({
      placement: expect.objectContaining({ duration: 4, reverse: false, frame_hold_source_time: 3 }),
    }));
    expect(field('源入点').disabled).toBe(true);
    expect((screen.getByRole('button', { name: '启用' }) as HTMLButtonElement).disabled).toBe(true);
  });
});
