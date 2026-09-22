import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { Actions, DockLocation, type IJsonModel, type TabSetNode } from 'flexlayout-react';
import { createRef, useEffect, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DesktopClientProvider, type DesktopClient } from '../../data/desktopClient';
import { renderInteractive } from '../../test/render';
import { ProjectWorkspaceDock, type ProjectWorkspaceDockHandle } from './ProjectWorkspaceDock';
import { ProjectWorkspaceLayoutMenu, ProjectWorkspaceLayoutProvider, useProjectWorkspaceLayout } from './ProjectWorkspaceManager';
import {
  PROJECT_WORKSPACE_PANELS, createProjectWorkspaceLayout, loadSavedProjectWorkspaceLayouts,
  projectWorkspaceDockAction, projectWorkspaceLayoutKey, saveSavedProjectWorkspaceLayouts,
  type ProjectWorkspacePanel, type WorkspaceLayoutStorage,
} from './projectWorkspaceLayout';

const LABELS: Record<ProjectWorkspacePanel, string> = {
  project: '项目素材', program: '成片预览', source: '源预览', tactical: '战术示意',
  timeline: '时间轴', inspector: '片段属性', agent: 'Agent', mixer: '音轨混音器',
};
let workspace: ReturnType<typeof useProjectWorkspaceLayout>;
let mounts: Map<string, number>;
const dock = createRef<ProjectWorkspaceDockHandle>();

function createStorage() {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: vi.fn((key: string, value: string) => { values.set(key, value); }),
    removeItem: (key: string) => { values.delete(key); },
  };
}

function StatefulPanel({ panel }: { panel: ProjectWorkspacePanel }) {
  const [value, setValue] = useState('');
  useEffect(() => { mounts.set(panel, (mounts.get(panel) ?? 0) + 1); }, [panel]);
  return <div>
    <input aria-label={`${panel} local state`} value={value} onChange={(event) => setValue(event.target.value)} />
    {panel === 'source' ? <video data-testid="source-media" /> : null}
  </div>;
}

function WorkspaceContents() {
  workspace = useProjectWorkspaceLayout();
  const panels = Object.fromEntries(PROJECT_WORKSPACE_PANELS.map((panel) => [panel, <StatefulPanel key={panel} panel={panel} />])) as Record<ProjectWorkspacePanel, React.ReactNode>;
  return <>
    <ProjectWorkspaceLayoutMenu labels={LABELS} />
    <ProjectWorkspaceDock ref={dock} projectId="project-one" panels={panels} labels={LABELS} />
  </>;
}

function mountWorkspace(storage: WorkspaceLayoutStorage, applyProjectPatch = vi.fn()) {
  const view = renderInteractive(
    <DesktopClientProvider client={{ applyProjectPatch } as unknown as DesktopClient}>
      <ProjectWorkspaceLayoutProvider projectId="project-one" storage={storage}><WorkspaceContents /></ProjectWorkspaceLayoutProvider>
    </DesktopClientProvider>,
  );
  // jsdom has no layout engine. Feed only measured DOM rectangles to the real
  // FlexLayout; its model, tab DOM, portals, menus and actions are not mocked.
  fireEvent(window, new Event('resize'));
  return view;
}

async function menuAction(name: string) {
  fireEvent.pointerDown(screen.getByRole('button', { name: '工作区布局' }), { button: 0, ctrlKey: false });
  fireEvent.click(await screen.findByRole('menuitem', { name }));
}

async function nameLayout(name: string) {
  await menuAction('将当前布局另存为…');
  fireEvent.change(screen.getByRole('textbox', { name: '布局名称' }), { target: { value: name } });
  fireEvent.click(screen.getByRole('button', { name: '保存布局' }));
}

beforeEach(() => {
  mounts = new Map();
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    if (this.classList.contains('flexlayout__layout')) return new DOMRect(0, 0, 1440, 800);
    if (this.className.includes('splitter')) return new DOMRect(0, 0, 8, 8);
    if (this.className.includes('tabset_content')) return new DOMRect(0, 0, 700, 360);
    if (this.className.includes('tabset') && !this.className.includes('tabbar')) return new DOMRect(0, 0, 700, 400);
    return new DOMRect(0, 0, 160, 32);
  });
});

afterEach(() => { vi.restoreAllMocks(); });

describe('Workspace layout editing through the real Dock', () => {
  it('saves, remounts, switches, renames and restores a named layout without Project edits', async () => {
    const storage = createStorage();
    const applyPatch = vi.fn();
    let view = mountWorkspace(storage, applyPatch);
    await screen.findByRole('textbox', { name: 'project local state' });
    await menuAction('显示与隐藏面板…');
    fireEvent.click(screen.getByRole('button', { name: '隐藏 战术示意' }));
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    await nameLayout('我的剪辑布局');
    expect(loadSavedProjectWorkspaceLayouts(storage).map((entry) => entry.name)).toEqual(['我的剪辑布局']);
    expect(workspace.openPanels.has('tactical')).toBe(false);

    view.unmount();
    view = mountWorkspace(storage, applyPatch);
    await screen.findByRole('textbox', { name: 'project local state' });
    expect(screen.getByRole('button', { name: '工作区布局' }).textContent).toContain('我的剪辑布局');
    expect(workspace.openPanels.has('tactical')).toBe(false);
    await menuAction('Agent 协作');
    await screen.findByRole('textbox', { name: 'agent local state' });
    expect(workspace.openPanels.has('agent')).toBe(true);
    await menuAction('我的剪辑布局');
    expect(workspace.openPanels.has('agent')).toBe(false);
    act(() => dock.current!.showPanel('tactical'));
    expect(workspace.openPanels.has('tactical')).toBe(true);
    await menuAction('恢复已保存布局');
    expect(workspace.openPanels.has('tactical')).toBe(false);

    await menuAction('重命名布局…');
    fireEvent.change(screen.getByRole('textbox', { name: '布局名称' }), { target: { value: '剪辑与对白' } });
    fireEvent.click(screen.getByRole('button', { name: '保存布局' }));
    expect(loadSavedProjectWorkspaceLayouts(storage)[0]?.name).toBe('剪辑与对白');
    await menuAction('删除此布局…');
    fireEvent.click(screen.getByRole('button', { name: '删除布局' }));
    expect(loadSavedProjectWorkspaceLayouts(storage)).toEqual([]);
    expect(workspace.choice).toBe('editing');
    expect(applyPatch).not.toHaveBeenCalled();
    view.unmount();
  });

  it('preserves source DOM and local state when hidden, moved and switched to a layout without a source tab', async () => {
    const storage = createStorage();
    const sourceClosed = createProjectWorkspaceLayout();
    const removeSource = (value: { children?: unknown[] }) => {
      if (value.children === undefined) return;
      value.children = value.children.filter((child) => (child as { component?: string }).component !== 'source');
      value.children.forEach((child) => removeSource(child as { children?: unknown[] }));
    };
    removeSource(sourceClosed.layout);
    saveSavedProjectWorkspaceLayouts(storage, [{ id: 'saved:no-source', name: '不含源面板', layout: sourceClosed }]);
    mountWorkspace(storage);
    fireEvent.click(await screen.findByRole('tab', { name: '源预览' }));
    const input = await screen.findByRole('textbox', { name: 'source local state' });
    const media = screen.getByTestId('source-media');
    fireEvent.change(input, { target: { value: 'keep this source range' } });
    const sourceTab = screen.getByRole('tab', { name: '源预览' });
    sourceTab.focus();
    fireEvent.keyDown(sourceTab, { key: 'Delete', ctrlKey: true });
    expect(workspace.openPanels.has('source')).toBe(false);
    act(() => dock.current!.showPanel('source'));
    expect(await screen.findByRole('textbox', { name: 'source local state' })).toBe(input);

    act(() => workspace.model.doAction(Actions.moveNode('source-panel', 'program-group', DockLocation.LEFT, -1, true)));
    expect(screen.getByRole('textbox', { name: 'source local state' })).toBe(input);
    await menuAction('不含源面板');
    expect(workspace.openPanels.has('source')).toBe(false);
    act(() => dock.current!.showPanel('source'));
    expect(await screen.findByRole('textbox', { name: 'source local state' })).toBe(input);
    expect((input as HTMLInputElement).value).toBe('keep this source range');
    expect(screen.getByTestId('source-media')).toBe(media);
    expect(mounts.get('source')).toBe(1);
  });

  it('reopens panels after closing the entire Dock and explicitly restores the preset', async () => {
    mountWorkspace(createStorage());
    await screen.findByRole('textbox', { name: 'project local state' });
    for (const panel of PROJECT_WORKSPACE_PANELS) act(() => dock.current!.hidePanel(panel));
    expect(workspace.openPanels.size).toBe(0);
    for (const panel of ['project', 'program', 'agent'] as const) {
      act(() => dock.current!.showPanel(panel));
      await screen.findByRole('textbox', { name: `${panel} local state` });
      act(() => dock.current!.hidePanel(panel));
    }
    await menuAction('恢复已保存布局');
    expect(workspace.openPanels).toEqual(new Set(['project', 'program', 'source', 'tactical', 'timeline']));
  });

  it('parks every panel from the native Close All context action without unmounting source content', async () => {
    mountWorkspace(createStorage());
    fireEvent.click(await screen.findByRole('tab', { name: '源预览' }));
    const input = await screen.findByRole('textbox', { name: 'source local state' });
    fireEvent.change(input, { target: { value: 'source state before closing group' } });
    fireEvent.contextMenu(screen.getByRole('tab', { name: '源预览' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: '隐藏此组所有面板' }));
    expect(workspace.openPanels.has('program')).toBe(false);
    expect(workspace.openPanels.has('source')).toBe(false);
    expect(workspace.openPanels.has('tactical')).toBe(false);
    act(() => dock.current!.showPanel('source'));
    expect(await screen.findByRole('textbox', { name: 'source local state' })).toBe(input);
    expect((input as HTMLInputElement).value).toBe('source state before closing group');
    expect(mounts.get('source')).toBe(1);
  });

  it('opens a new support group at no more than one third of the monitor and preserves subsequent user resizing', async () => {
    const storage = createStorage();
    mountWorkspace(storage);
    const programInput = await screen.findByRole('textbox', { name: 'program local state' });
    await menuAction('显示与隐藏面板…');
    storage.setItem.mockClear();
    fireEvent.click(screen.getByRole('button', { name: '显示 Agent' }));
    await screen.findByRole('textbox', { name: 'agent local state' });
    const support = workspace.model.getNodeById('agent-panel')!.getParent() as TabSetNode;
    const program = workspace.model.getNodeById('program-group') as TabSetNode;
    expect(support.getWeight() / (support.getWeight() + program.getWeight())).toBeLessThanOrEqual(1 / 3);
    expect(screen.getByRole('textbox', { name: 'program local state' })).toBe(programInput);
    expect(storage.setItem).toHaveBeenCalledTimes(1);

    act(() => workspace.model.doAction(Actions.updateNodeAttributes(support.getId(), { weight: 280 })));
    const programWeight = program.getWeight();
    fireEvent.click(screen.getByRole('button', { name: '显示 片段属性' }));
    await screen.findByRole('textbox', { name: 'inspector local state' });
    expect(workspace.model.getNodeById('inspector-panel')!.getParent()).toBe(support);
    expect(support.getWeight()).toBe(280);
    expect(program.getWeight()).toBe(programWeight);
  });

  it('reclaims the source tabset after its last tab moves, keeps media mounted and respects an explicitly retained empty group', async () => {
    const storage = createStorage();
    const layout = createProjectWorkspaceLayout('compare');
    // A legal user layout may disable close controls while still asking empty
    // groups to disappear. Exercise that combination at the real Dock seam.
    layout.global = { ...layout.global, tabSetEnableClose: false };
    storage.setItem(projectWorkspaceLayoutKey('project-one'), JSON.stringify(layout));
    mountWorkspace(storage);
    const sourceInput = await screen.findByRole('textbox', { name: 'source local state' });
    const media = screen.getByTestId('source-media');
    const sourceTabset = screen.getByRole('tab', { name: '源预览' }).closest('.flexlayout__tabset');
    act(() => workspace.model.doAction(projectWorkspaceDockAction(workspace.model,
      Actions.moveNode('source-panel', 'program-group', DockLocation.CENTER, -1, true))));
    expect(workspace.model.getNodeById('source-group')).toBeUndefined();
    expect(sourceTabset?.isConnected).toBe(false);
    expect(workspace.model.getNodeById('workspace-upper')!.getChildren()).toHaveLength(2);
    expect(await screen.findByRole('textbox', { name: 'source local state' })).toBe(sourceInput);
    expect(screen.getByTestId('source-media')).toBe(media);
    expect(storage.getItem(projectWorkspaceLayoutKey('project-one'))).not.toContain('source-group');

    await menuAction('对照预览');
    act(() => workspace.model.doAction(Actions.updateNodeAttributes('source-group', { enableDeleteWhenEmpty: false })));
    act(() => workspace.model.doAction(projectWorkspaceDockAction(workspace.model,
      Actions.moveNode('source-panel', 'program-group', DockLocation.CENTER, -1, true))));
    expect(workspace.model.getNodeById('source-group')?.getChildren()).toEqual([]);
    expect(screen.getByTestId('source-media')).toBe(media);
  });

  it('persists only completed geometry actions and treats maximize as temporary', async () => {
    const storage = createStorage();
    mountWorkspace(storage);
    await screen.findByRole('textbox', { name: 'project local state' });
    storage.setItem.mockClear();
    act(() => workspace.model.doAction(Actions.adjustWeights('workspace-root', [61, 39]).setAdjusting(true)));
    expect(storage.setItem).not.toHaveBeenCalled();
    act(() => workspace.model.doAction(Actions.adjustWeights('workspace-root', [61, 39])));
    expect(storage.setItem).toHaveBeenCalledTimes(1);
    const saved = JSON.parse(storage.getItem(projectWorkspaceLayoutKey('project-one'))!) as IJsonModel;
    expect(saved.layout.children?.map((child) => child.weight)).toEqual([61, 39]);
    storage.setItem.mockClear();
    const programGroup = screen.getByRole('tab', { name: '成片预览' }).closest('.flexlayout__tabset')!;
    fireEvent.click(within(programGroup as HTMLElement).getByRole('button', { name: '最大化面板' }));
    expect(storage.setItem).not.toHaveBeenCalled();
    expect(workspace.model.getMaximizedTabset()?.getId()).toBe('program-group');
    await nameLayout('专注布局');
    const layout = loadSavedProjectWorkspaceLayouts(storage)[0]!.layout;
    expect(JSON.stringify(layout)).not.toContain('"maximized":true');
  });

  it('keeps a failed named save visible when that storage key alone exceeds quota', async () => {
    const storage = createStorage();
    const write = storage.setItem.getMockImplementation()!;
    storage.setItem.mockImplementation((key: string, value: string) => {
      if (key === 'vibe-cs:project-workspace-saved-layouts') throw new DOMException('quota', 'QuotaExceededError');
      write(key, value);
    });
    mountWorkspace(storage);
    await nameLayout('保存失败的布局');
    expect(screen.getByRole('textbox', { name: '布局名称' })).toBeDefined();
    expect(screen.getByRole('alert').textContent).toContain('无法保存布局');
    expect(screen.getByRole('status').textContent).toContain('布局未保存');
    expect(workspace.saved).toEqual([]);
    act(() => dock.current!.showPanel('agent'));
    await waitFor(() => expect(storage.getItem(projectWorkspaceLayoutKey('project-one'))).not.toBeNull());
    expect(screen.getByRole('status').textContent).toContain('布局未保存');
    storage.setItem.mockImplementation(write);
    fireEvent.click(screen.getByRole('button', { name: '保存布局' }));
    expect(loadSavedProjectWorkspaceLayouts(storage)[0]?.name).toBe('保存失败的布局');
    expect(screen.queryByRole('textbox', { name: '布局名称' })).toBeNull();
    expect(screen.queryByRole('status')).toBeNull();
  });
});
