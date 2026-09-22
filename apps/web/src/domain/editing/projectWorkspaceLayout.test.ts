import { describe, expect, it } from 'vitest';
import { Actions, type IJsonModel, type IJsonRowNode } from 'flexlayout-react';

import {
  createProjectWorkspaceLayout, createProjectWorkspaceModel, loadProjectWorkspaceLayout,
  projectWorkspaceLayoutKey, projectWorkspaceSnapshot,
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

describe('Project workspace layout storage', () => {
  it('starts with one full-width Timeline below the monitor row', () => {
    const model = createProjectWorkspaceLayout();
    expect(model.global?.rootOrientationVertical).toBe(true);
    expect(model.layout.children?.map((node) => node.id)).toEqual(['workspace-upper', 'timeline-group']);
    const upper = model.layout.children?.[0] as IJsonRowNode;
    expect(upper.children?.map((node) => node.id)).toEqual(['project-group', 'program-group']);
  });

  it('loads a legal saved panel geometry without requiring every optional panel to have been opened', () => {
    const target = storage();
    const layout: IJsonModel = {
      layout: { type: 'row', id: 'custom-root', children: [
        { type: 'tabset', id: 'custom-left', weight: 27, children: [
          { type: 'tab', id: 'project-panel', component: 'project' },
          { type: 'tab', id: 'agent-panel', component: 'agent' },
        ] },
        { type: 'row', id: 'custom-right', weight: 73, children: [
          { type: 'tabset', id: 'custom-monitors', weight: 35, children: [
            { type: 'tab', id: 'program-panel', component: 'program' },
            { type: 'tab', id: 'tactical-panel', component: 'tactical' },
            { type: 'tab', id: 'mixer-panel', component: 'mixer' },
          ] },
          { type: 'tabset', id: 'custom-timeline', weight: 65, children: [
            { type: 'tab', id: 'timeline-panel', component: 'timeline' },
          ] },
        ] },
      ] },
    };
    saveProjectWorkspaceLayout('p', target, layout);
    expect(loadProjectWorkspaceLayout('p', target)).toEqual(layout);
    const mounted = createProjectWorkspaceModel(loadProjectWorkspaceLayout('p', target));
    expect(mounted.getNodeById('custom-left')?.toJson()).toMatchObject({ weight: 27 });
    expect(mounted.getNodeById('source-panel')?.getParent()?.getId()).toBe('border_bottom');
    expect(mounted.getNodeById('inspector-panel')?.getParent()?.getId()).toBe('border_bottom');
  });

  it('persists geometry without temporary maximize and rejects malformed external layouts', () => {
    const target = storage();
    const model = createProjectWorkspaceModel(createProjectWorkspaceLayout());
    model.doAction(Actions.maximizeToggle('program-group'));
    saveProjectWorkspaceLayout('p', target, projectWorkspaceSnapshot(model));
    const restored = createProjectWorkspaceModel(loadProjectWorkspaceLayout('p', target));
    expect(restored.getMaximizedTabset()).toBeUndefined();
    expect(restored.getNodeById('timeline-panel')).toBeDefined();

    target.setItem(projectWorkspaceLayoutKey('p'), JSON.stringify({ layout: { type: 'row', children: [] } }));
    expect(loadProjectWorkspaceLayout('p', target)).toEqual(createProjectWorkspaceLayout());
    target.setItem(projectWorkspaceLayoutKey('p'), JSON.stringify({ layout: { type: 'not-a-row', children: [] } }));
    expect(loadProjectWorkspaceLayout('p', target)).toEqual(createProjectWorkspaceLayout());
  });
});
