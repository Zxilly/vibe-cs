import { fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { MontageProjectRecord } from '../shared/desktop/dto';
import { HealthyServiceGate } from '../test/ServiceGate.testing';
import { ProjectWorkspacePage } from './ProjectWorkspacePage';
import { HEALTHY, montageClient, montageClip, montageProject, recordedClip, renderMontage } from './montage/test/renderMontage';

function harness() {
  let current = montageProject({ clips: [montageClip({ clip_id: 'clip-1', trim_end: 42 })] });
  const puts: MontageProjectRecord[] = [];
  const exportMontageProject = vi.fn(async () => ({ job_id: 'job-9', status: 'queued' as const }));
  const convertMontageToEditor = vi.fn(async () => ({ id: 'editor-copy-1' }));
  const client = montageClient({
    listMontageProjects: async () => ({ items: [current] }),
    getMontageProject: async () => current,
    putMontageProject: async (_id: string, next: MontageProjectRecord) => {
      puts.push(next);
      current = next;
      return current;
    },
    listRecordedClips: async () => ({ items: [recordedClip({ id: 'clip-1', duration_seconds: 42 })], total: 1, page: 1, page_size: 50 }),
    exportMontageProject,
    convertMontageToEditor,
  });
  return { client, puts, exportMontageProject, convertMontageToEditor };
}

describe('quick mode inside a project shot list', () => {
  it('opens an existing montage with every editing block and keeps write-through edits after leaving the step', async () => {
    const bench = harness();
    const { container } = renderMontage({
      client: bench.client,
      route: '/projects/montage%3Aproject-1?step=shotlist',
      element: <HealthyServiceGate><ProjectWorkspacePage /></HealthyServiceGate>,
      health: HEALTHY,
    });

    await waitFor(() => expect(container.querySelector('[data-montage-mode]')).not.toBeNull());
    for (const block of ['clips', 'music', 'packaging', 'export']) {
      expect(container.querySelector(`[data-montage-block="${block}"]`)).not.toBeNull();
    }

    await screen.findByRole('radiogroup', { name: '合辑主题' });
    expect(screen.getByRole('radio', { name: '快速剪辑' }).hasAttribute('disabled')).toBe(false);
    fireEvent.click(screen.getByRole('radio', { name: 'Agent 辅助' }));
    expect(screen.getByText(/Agent 剪辑单需从 Demo、选手与证据重新建立/u)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '知道了' }));
    fireEvent.click(screen.getByRole('radio', { name: '霓虹' }));
    await waitFor(() => expect(bench.puts).toHaveLength(1));

    fireEvent.click(screen.getByRole('button', { name: '选材' }));
    await screen.findByText('这份作品还没有收集片段');
    fireEvent.click(screen.getByRole('button', { name: '剪辑单' }));
    await screen.findByRole('radiogroup', { name: '合辑主题' });
    expect(screen.getByRole('radio', { name: '霓虹' }).getAttribute('aria-checked')).toBe('true');
  });

  it('copies Quick to Multitrack and explains every omitted capability before doing it', async () => {
    const bench = harness();
    renderMontage({
      client: bench.client,
      route: '/projects/montage%3Aproject-1?step=shotlist',
      element: <HealthyServiceGate><ProjectWorkspacePage /></HealthyServiceGate>,
      health: HEALTHY,
    });

    await screen.findByRole('radio', { name: '多轨精剪' });
    fireEvent.click(screen.getByRole('radio', { name: '多轨精剪' }));

    expect(screen.getByText(/复制当前片段顺序和裁切/u)).toBeTruthy();
    expect(screen.getByText(/包装、背景音乐与转场不会复制/u)).toBeTruthy();
    expect(bench.convertMontageToEditor).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: '创建并打开副本' }));
    await waitFor(() => expect(bench.convertMontageToEditor).toHaveBeenCalledWith('project-1'));
  });

  it('runs the existing montage export mutation unchanged', async () => {
    const bench = harness();
    renderMontage({
      client: bench.client,
      route: '/projects/montage%3Aproject-1?step=shotlist',
      element: <HealthyServiceGate><ProjectWorkspacePage /></HealthyServiceGate>,
      health: HEALTHY,
    });

    const buttons = await screen.findAllByRole('button', { name: /生成视频/u });
    await waitFor(() => expect(buttons[0]?.hasAttribute('disabled')).toBe(false));
    fireEvent.click(buttons[0] as HTMLElement);
    await waitFor(() => expect(bench.exportMontageProject).toHaveBeenCalledWith('project-1'));
  });
});
