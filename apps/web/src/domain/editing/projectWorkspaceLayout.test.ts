import { describe, expect, it } from 'vitest';
import type { IJsonRowNode } from 'flexlayout-react';

import {
  createProjectWorkspaceLayout,
  loadProjectWorkspaceLayout,
  projectWorkspaceLayoutKey,
  resetProjectWorkspaceLayout,
  saveProjectWorkspaceLayout,
} from './projectWorkspaceLayout';

function storage() {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  };
}

describe('Project workspace dock layout', () => {
  it('starts with full-height Project and Agent docks around a nested editing column', () => {
    const layout = createProjectWorkspaceLayout().layout;
    expect(layout.children?.map((node) => node.id)).toEqual([
      'project-group',
      'editing-column',
      'agent-group',
    ]);
    const editing = layout.children?.[1] as IJsonRowNode | undefined;
    expect(editing?.type).toBe('row');
    expect(editing?.children?.map((node) => node.id)).toEqual(['monitor-row', 'timeline-group']);
    const monitors = editing?.children?.[0] as IJsonRowNode | undefined;
    expect(monitors?.children?.map((node) => node.id)).toEqual([
      'program-group',
      'tactical-group',
    ]);
  });

  it('persists only a complete current panel set and resets without touching Project data', () => {
    const target = storage();
    const projectId = 'project-1';
    const layout = createProjectWorkspaceLayout();
    saveProjectWorkspaceLayout(projectId, target, layout);
    expect(loadProjectWorkspaceLayout(projectId, target)).toEqual(layout);

    target.setItem(projectWorkspaceLayoutKey(projectId), JSON.stringify({ layout: { type: 'row', children: [] } }));
    expect(loadProjectWorkspaceLayout(projectId, target)).toEqual(createProjectWorkspaceLayout());

    target.setItem(projectWorkspaceLayoutKey(projectId), JSON.stringify({
      layout: {
        type: 'not-a-layout-node',
        children: ['project', 'program', 'tactical', 'timeline', 'agent'].map((component) => ({ component })),
      },
    }));
    expect(loadProjectWorkspaceLayout(projectId, target)).toEqual(createProjectWorkspaceLayout());

    resetProjectWorkspaceLayout(projectId, target);
    expect(target.values.has(projectWorkspaceLayoutKey(projectId))).toBe(false);
  });
});
