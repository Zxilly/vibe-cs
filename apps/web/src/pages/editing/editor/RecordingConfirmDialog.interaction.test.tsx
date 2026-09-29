import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { PREVIEW_PROJECT } from '../../../dev/projectFixtures';
import type { TimelineClip } from '../../../shared/desktop/dto';
import { renderInteractive } from '../../../test/render';
import { RecordingConfirmDialog, type RecordingConfirmDialogProps } from './RecordingConfirmDialog';

vi.mock('../../../domain/editing/ClipCameraInspection', () => ({
  ClipCameraInspection: ({ projectId, revision, clipId }: { projectId: string; revision: number; clipId: string }) =>
    <div data-testid="camera-inspection" data-project={projectId} data-revision={revision} data-clip={clipId} />,
}));

/* Three 384-tick clips (6 s each) with no pre or post roll. */
const CLIPS: readonly TimelineClip[] = PREVIEW_PROJECT.document.tracks[0]!.clips.slice(0, 3);
const IDS = CLIPS.map((clip) => clip.id);

function open(props: Partial<RecordingConfirmDialogProps> = {}) {
  const onConfirm = vi.fn();
  renderInteractive(
    <RecordingConfirmDialog
      open
      projectId="project"
      revision={7}
      clips={CLIPS}
      selectedClipIds={[]}
      confirmDisabled={false}
      onConfirm={onConfirm}
      onClose={() => undefined}
      {...props}
    />,
  );
  return { onConfirm, dialog: screen.getByRole('dialog', { name: '录制缺失片段' }) };
}

describe('RecordingConfirmDialog', () => {
  it('states the recorded length, an estimated wall time and that the machine is occupied', () => {
    const { dialog } = open();

    expect(dialog.textContent).toContain('录制 3 个还没有素材的片段');
    expect(dialog.querySelector('[data-recording-seconds]')?.textContent).toBe('18 秒');
    // 60 s launch + 18 s footage + 3 × 20 s per clip = 138 s.
    expect(dialog.querySelector('[data-recording-wall-minutes]')?.textContent).toBe('约 3 分钟');
    expect(dialog.textContent).toContain('实际时间会有出入');
    expect(dialog.textContent).toContain('请不要操作电脑');
  });

  it('records every requested clip when the selection holds none of them', () => {
    const { onConfirm } = open({ selectedClipIds: ['not-requested'] });

    expect(screen.queryByRole('radiogroup', { name: '录制范围' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '开始录制' }));
    expect(onConfirm).toHaveBeenCalledWith(IDS);
  });

  it('narrows the recording to the selected unrecorded clips on request', () => {
    const { onConfirm, dialog } = open({ selectedClipIds: [IDS[1]!, 'not-requested'] });

    expect(screen.getByRole('radio', { name: '全部 3 个未录制片段' }).getAttribute('aria-checked')).toBe('true');
    fireEvent.click(screen.getByRole('radio', { name: '只录选中的 1 个' }));

    expect(dialog.textContent).toContain('录制 1 个还没有素材的片段');
    expect(dialog.querySelector('[data-recording-seconds]')?.textContent).toBe('6 秒');
    fireEvent.click(screen.getByRole('button', { name: '开始录制' }));
    expect(onConfirm).toHaveBeenCalledWith([IDS[1]]);
  });

  it('offers no choice when the selection already covers every requested clip', () => {
    open({ selectedClipIds: IDS });

    expect(screen.queryByRole('radiogroup', { name: '录制范围' })).toBeNull();
  });

  it('keeps the caller’s disabled state', () => {
    open({ confirmDisabled: true });

    expect((screen.getByRole('button', { name: '开始录制' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('previews only the current recording scope under the current Project Head', () => {
    open({ selectedClipIds: [IDS[1]!] });
    const preview = () => screen.getByTestId('camera-inspection');
    expect(preview().getAttribute('data-project')).toBe('project');
    expect(preview().getAttribute('data-revision')).toBe('7');
    fireEvent.change(screen.getByRole('combobox', { name: '预演片段' }), { target: { value: IDS[2] } });
    expect(preview().getAttribute('data-clip')).toBe(IDS[2]);
    fireEvent.click(screen.getByRole('radio', { name: '只录选中的 1 个' }));
    expect(preview().getAttribute('data-clip')).toBe(IDS[1]);
  });
});
