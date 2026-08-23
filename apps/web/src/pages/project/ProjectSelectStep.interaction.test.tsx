import { fireEvent, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';

import {
  addProjectCollectedClip,
  resetProjectCollectionsForTesting,
  type ProjectCollectedClip,
} from '../../data/projectCollections';
import type { ProjectViewModel } from '../../domain/project/projectViewModel';
import { renderInteractive } from '../../test/render';
import { ProjectSelectStep } from './ProjectSelectStep';

const PROJECT: ProjectViewModel = {
  id: 'plan:p-1', source: { kind: 'plan', id: 'p-1' }, name: '残局集锦', editingMode: 'agent',
  shotList: { planId: 'p-1', status: 'draft', shotCount: 1 }, clipCount: 1,
  recordingTasks: [], outputFiles: [], demoIds: [], currentStep: 'select', status: 'active',
  updatedAt: '2026-08-20T00:00:00Z',
};

function clip(id: string, demoId: string, matchLabel: string, round: number): ProjectCollectedClip {
  return {
    id, demoId, matchLabel, kind: 'round', label: `第 ${String(round)} 回合`, round,
    playerId: null, highlightId: null, evidenceId: null, startTick: round * 100,
    endTick: round * 100 + 64, addedAt: '2026-08-20T00:00:00Z',
  };
}

afterEach(() => resetProjectCollectionsForTesting());

describe('project selection step', () => {
  it('uses a focused empty workspace with one way into match selection', () => {
    renderInteractive(<MemoryRouter><ProjectSelectStep project={PROJECT} /></MemoryRouter>);

    expect(screen.getByRole('region', { name: '这份作品还没有收集片段' })).toBeTruthy();
    expect(screen.getAllByRole('link', { name: '选择一场比赛' })).toHaveLength(1);
    expect(document.querySelector('[data-empty]')).toBeNull();
  });

  it('groups collected clips by match and removes one without touching the others', () => {
    addProjectCollectedClip(PROJECT.id, clip('a', 'demo-a', 'Aurora vs Meridian', 21));
    addProjectCollectedClip(PROJECT.id, clip('b', 'demo-a', 'Aurora vs Meridian', 22));
    addProjectCollectedClip(PROJECT.id, clip('c', 'demo-b', 'NAVI vs FaZe', 19));

    renderInteractive(<MemoryRouter><ProjectSelectStep project={PROJECT} /></MemoryRouter>);

    expect(document.querySelectorAll('[data-collected-match]')).toHaveLength(2);
    expect(document.querySelectorAll('[data-collected-clip]')).toHaveLength(3);
    expect(screen.getByText('Aurora vs Meridian')).toBeTruthy();
    expect(screen.getByText('NAVI vs FaZe')).toBeTruthy();

    const first = document.querySelector('[data-collected-clip="a"]') as HTMLElement;
    fireEvent.click(first.querySelector('button') as HTMLButtonElement);
    expect(document.querySelector('[data-collected-clip="a"]')).toBeNull();
    expect(document.querySelectorAll('[data-collected-clip]')).toHaveLength(2);
  });
});
