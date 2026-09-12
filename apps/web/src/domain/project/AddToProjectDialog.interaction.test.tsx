import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { Project, ProjectPatch } from '../../shared/desktop/dto';
import { timelineClipFromCollected, type ProjectCollectedClip } from './collectedClip';
import { renderPage } from '../../test/renderPage';
import { AddToProjectDialog } from './AddToProjectDialog';

const SOURCE: ProjectCollectedClip = {
  id: 'niko-r21', demoId: 'demo-a', matchLabel: 'Mirage', kind: 'highlight', label: 'NiKo · 连续2杀',
  round: 21, playerId: '76561198041683378', playerName: 'NiKo', tickRate: 64,
  highlightId: 'highlight-a', evidenceId: null, startTick: 173422, endTick: 174142,
  durationSeconds: 13.75, addedAt: '2026-09-07T00:00:00Z',
};
const PROJECT: Project = {
  id: 'project-a', name: '现有作品', revision: 12,
  created_at: SOURCE.addedAt, updated_at: SOURCE.addedAt,
  document: {
    width: 1920, height: 1080, fps: 60, duration_seconds: 180, story_track_id: 'story',
    tracks: [{ id: 'story', name: 'Story', kind: 'video', order: 0, muted: false, solo: false,
      volume: 1, pan: 0, keyframes: [], locked: false, hidden: false,
      clips: [timelineClipFromCollected({ ...SOURCE, id: 'previous', durationSeconds: 180 })] }],
    markers: [], settings: { source_demo_ids: [], ripple_sequence_markers: false, use_media_proxies: false },
  },
};

describe('source confirmation', () => {
  it('shows the source and buffered range and commits the same Story endpoint', async () => {
    const apply = vi.fn((patch: ProjectPatch) => Promise.resolve({ project: { ...PROJECT, revision: patch.base_revision + 1 } }));
    const onAdded = vi.fn();
    renderPage({ element: <AddToProjectDialog open clips={[SOURCE]} onClose={vi.fn()} onAdded={onAdded} />, client: {
      listProjects: () => Promise.resolve([PROJECT]), applyProjectPatch: apply,
    } });
    await waitFor(() => expect(screen.getByRole('button', { name: '加入 Story 末尾' })).toHaveProperty('disabled', false));
    const dialog = screen.getByRole('dialog', { name: '加入作品' });
    expect(dialog.textContent).toContain('NiKo (POV)');
    expect(dialog.textContent).toContain('45:09.719–45:20.969');
    expect(dialog.textContent).toContain('45:08.219–45:21.969');
    expect(dialog.textContent).toContain('03:13.750');
    fireEvent.click(within(dialog).getByRole('button', { name: '加入 Story 末尾' }));
    await waitFor(() => expect(onAdded).toHaveBeenCalledWith({ id: PROJECT.id, name: PROJECT.name }));
    expect(apply).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ base_revision: 12, operations: expect.arrayContaining([
      expect.objectContaining({ op: 'insert_clip', track_id: 'story', clip: expect.objectContaining({
        placement: expect.objectContaining({ start: 180, duration: 13.75 }),
        capture_intent: expect.objectContaining({ player_id: SOURCE.playerId, start_tick: 173422, end_tick: 174142 }),
      }) }),
    ]) }));
  });

  it('blocks reversed bounds without displaying a fabricated resulting duration', async () => {
    const apply = vi.fn();
    renderPage({ element: <AddToProjectDialog open clips={[{ ...SOURCE, endTick: SOURCE.startTick }]} onClose={vi.fn()} onAdded={vi.fn()} />, client: {
      listProjects: () => Promise.resolve([PROJECT]), applyProjectPatch: apply,
    } });
    await screen.findByRole('option', { name: PROJECT.name });
    expect(screen.getByRole('button', { name: '加入 Story 末尾' })).toHaveProperty('disabled', true);
    expect(screen.getByText(/出点必须晚于入点/u)).toBeTruthy();
    expect(screen.queryByText('03:13.750')).toBeNull();
    expect(apply).not.toHaveBeenCalled();
  });

  it('retries a failed append on the already created project, never an older target or another new project', async () => {
    const created = { ...PROJECT, id: 'created-project', name: 'Mirage · 新作品', revision: 1 };
    let projects = [PROJECT];
    const create = vi.fn(() => { projects = [PROJECT, created]; return Promise.resolve(created); });
    const apply = vi.fn().mockRejectedValueOnce(new Error('temporary write failure')).mockResolvedValueOnce({ project: created });
    const onAdded = vi.fn();
    renderPage({ element: <AddToProjectDialog open clips={[SOURCE]} onClose={vi.fn()} onAdded={onAdded} />, client: {
      listProjects: () => Promise.resolve([...projects]), createProject: create, applyProjectPatch: apply,
    } });
    await screen.findByRole('option', { name: PROJECT.name });
    fireEvent.change(screen.getByRole('combobox', { name: '目标作品' }), { target: { value: '__new__' } });
    fireEvent.click(screen.getByRole('button', { name: '新建并加入' }));
    await screen.findByText(/没有把素材加入作品/u);
    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    await waitFor(() => expect(onAdded).toHaveBeenCalledWith({ id: created.id, name: created.name }));
    expect(create).toHaveBeenCalledTimes(1);
    expect(apply).toHaveBeenCalledTimes(2);
    expect(apply.mock.calls.map((call) => call[0].project_id)).toEqual([created.id, created.id]);
  });
});
