import { fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { MontageProjectRecord } from '../shared/desktop/dto';
import { HealthyServiceGate } from '../test/ServiceGate.testing';
import { reasonOf } from '../test/reason';
import { ProjectWorkspacePage } from './ProjectWorkspacePage';
import { HEALTHY, montageClient, montageClip, montageProject, recordedClip, renderMontage } from './montage/test/renderMontage';

function harness() {
  let current = montageProject({ clips: [montageClip({ clip_id: 'clip-1', trim_end: 42 })] });
  const puts: MontageProjectRecord[] = [];
  const exportMontageProject = vi.fn(async () => ({ job_id: 'job-9', status: 'queued' as const }));
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
  });
  return { client, puts, exportMontageProject };
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
    expect(screen.getByRole('button', { name: '快速剪辑' }).hasAttribute('disabled')).toBe(false);
    expect(reasonOf(screen.getByRole('button', { name: 'Agent 辅助' }))).toContain('修改会保留在当前制作方式');
    fireEvent.click(screen.getByRole('radio', { name: '霓虹' }));
    await waitFor(() => expect(bench.puts).toHaveLength(1));

    fireEvent.click(screen.getByRole('button', { name: '选材' }));
    await screen.findByText('这份作品还没有收集片段');
    fireEvent.click(screen.getByRole('button', { name: '剪辑单' }));
    await screen.findByRole('radiogroup', { name: '合辑主题' });
    expect(screen.getByRole('radio', { name: '霓虹' }).getAttribute('aria-checked')).toBe('true');
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
