import {
  Actions, BorderNode, DockLocation, GroupAction, Model, TabNode, TabSetNode, type Action,
  type IJsonBorderNode, type IJsonModel, type IJsonRowNode, type IJsonTabNode,
} from 'flexlayout-react';

export const PROJECT_WORKSPACE_PANELS = [
  'project', 'program', 'source', 'tactical', 'timeline', 'inspector', 'agent', 'mixer',
] as const;
export type ProjectWorkspacePanel = typeof PROJECT_WORKSPACE_PANELS[number];
export type ProjectWorkspacePreset = 'editing' | 'compare' | 'agent';

export interface WorkspaceLayoutStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface SavedProjectWorkspaceLayout {
  readonly id: string;
  readonly name: string;
  readonly layout: IJsonModel;
}

const PANEL_NAMES: Record<ProjectWorkspacePanel, string> = {
  project: 'Project', program: 'Program', source: 'Source', tactical: 'Tactical',
  timeline: 'Timeline', inspector: 'Inspector', agent: 'Agent', mixer: 'Audio Track Mixer',
};
const SAVED_LAYOUTS_KEY = 'vibe-cs:project-workspace-saved-layouts';

export function isProjectWorkspacePanel(value: unknown): value is ProjectWorkspacePanel {
  return typeof value === 'string' && PROJECT_WORKSPACE_PANELS.some((panel) => panel === value);
}

function panelTab(panel: ProjectWorkspacePanel): IJsonTabNode {
  return {
    type: 'tab', id: `${panel}-panel`, name: PANEL_NAMES[panel], component: panel,
    enableClose: true, enablePopout: false, enableRename: false,
    // Once rendered, FlexLayout keeps inactive tab contents mounted.
    enableRenderOnDemand: true,
  };
}

export function createProjectWorkspaceLayout(preset: ProjectWorkspacePreset = 'editing'): IJsonModel {
  const monitors: IJsonRowNode['children'] = [
    { type: 'tabset', id: 'project-group', weight: 304, children: [panelTab('project')] },
    ...(preset === 'compare'
      ? [{ type: 'tabset' as const, id: 'source-group', weight: 440, children: [panelTab('source')] }]
      : []),
    {
      type: 'tabset', id: 'program-group', weight: preset === 'compare' ? 600 : 1024,
      children: preset === 'compare'
        ? [panelTab('program'), panelTab('tactical')]
        : [panelTab('program'), panelTab('source'), panelTab('tactical')],
    },
    ...(preset === 'agent'
      ? [{ type: 'tabset' as const, id: 'support-group', weight: 360, children: [panelTab('agent')] }]
      : []),
  ];
  return {
    global: {
      rootOrientationVertical: true,
      enableEdgeDock: true, enableEdgeDockIndicators: true,
      tabEnableClose: true, tabEnableDrag: true, tabEnablePin: false,
      tabEnablePopout: false, tabEnablePopoutIcon: false, tabEnableRename: false,
      tabSetEnableClose: false, tabSetEnableCloseButton: false,
      tabSetEnableDeleteWhenEmpty: true, tabSetEnableDivide: true,
      tabSetEnableDrag: true, tabSetEnableDrop: true, tabSetEnableMaximize: true,
      tabSetEnableTabStrip: true, tabSetMinHeight: 140, tabSetMinWidth: 220,
    },
    borders: [parkingBorder('bottom', [panelTab('inspector'), panelTab('mixer'), ...(preset === 'agent' ? [] : [panelTab('agent')])])],
    layout: {
      type: 'row', id: 'workspace-root', children: [
        { type: 'row', id: 'workspace-upper', weight: 55, children: monitors },
        { type: 'tabset', id: 'timeline-group', weight: 45, children: [panelTab('timeline')] },
      ],
    },
  };
}

function parkingBorder(location: IJsonBorderNode['location'], children: IJsonTabNode[]): IJsonBorderNode {
  return { type: 'border', location, show: false, selected: -1, enableDrop: false, children };
}

/** Closed panels keep their stable tab identity in every chosen layout. */
export function createProjectWorkspaceModel(layout: IJsonModel, previousModel?: Model): Model {
  const next = structuredClone(layout);
  const present = new Set<ProjectWorkspacePanel>();
  visitJsonTabs(next, (tab) => {
    if (!isProjectWorkspacePanel(tab.component)) return;
    present.add(tab.component);
    tab.enableClose = true;
    tab.enableRenderOnDemand = true;
  });
  next.borders ??= [];
  let parking = next.borders.find((border) => border.show === false);
  if (parking === undefined) {
    const location = (['bottom', 'left', 'right', 'top'] as const)
      .find((candidate) => !next.borders!.some((border) => border.location === candidate));
    if (location === undefined) throw new Error('Workspace requires a border for closed panels');
    parking = parkingBorder(location, []);
    next.borders.push(parking);
  }
  parking.selected = -1;
  parking.enableDrop = false;
  parking.children ??= [];
  for (const panel of PROJECT_WORKSPACE_PANELS) {
    if (!present.has(panel)) parking.children.push(panelTab(panel));
  }
  // Stable ids alone do not preserve React state: adopt the existing tab DOM
  // and rendered flags with FlexLayout's native previousModel argument.
  return Model.fromJson(next, previousModel);
}

export function workspacePanelNode(model: Model, panel: ProjectWorkspacePanel): TabNode {
  return model.getNodeById(`${panel}-panel`) as TabNode;
}

function panelContainer(node: TabNode): TabSetNode | BorderNode {
  let parent = node.getParent();
  while (!(parent instanceof TabSetNode) && !(parent instanceof BorderNode)) parent = parent!.getParent();
  return parent;
}

export function openProjectWorkspacePanels(model: Model): ReadonlySet<ProjectWorkspacePanel> {
  return new Set(PROJECT_WORKSPACE_PANELS.filter((panel) => {
    const container = panelContainer(workspacePanelNode(model, panel));
    return container instanceof TabSetNode || container.isShowing();
  }));
}

export function visibleProjectWorkspacePanels(model: Model): ReadonlySet<ProjectWorkspacePanel> {
  const maximized = model.getMaximizedTabset();
  return new Set(PROJECT_WORKSPACE_PANELS.filter((panel) => {
    const node = workspacePanelNode(model, panel);
    const container = panelContainer(node);
    if (container instanceof BorderNode && !container.isShowing()) return false;
    return node.isSelected() && (maximized === undefined || container === maximized);
  }));
}

export function showProjectWorkspacePanel(model: Model, panel: ProjectWorkspacePanel): void {
  const node = workspacePanelNode(model, panel);
  const container = panelContainer(node);
  const maximized = model.getMaximizedTabset();
  const actions = maximized !== undefined && maximized !== container
    ? [Actions.maximizeToggle(maximized.getId())] : [];
  let initialSupport: { target: TabSetNode; weight: number; share: number } | undefined;
  if (container instanceof BorderNode && !container.isShowing()) {
    const open = openProjectWorkspacePanels(model);
    const support = panel === 'agent' || panel === 'mixer' || panel === 'inspector';
    const peer = (support ? ['agent', 'inspector', 'mixer'] : ['program', 'source', 'tactical'])
      .find((candidate) => candidate !== panel && open.has(candidate as ProjectWorkspacePanel));
    const peerContainer = peer === undefined ? undefined : panelContainer(workspacePanelNode(model, peer as ProjectWorkspacePanel));
    if (panel === 'timeline') {
      actions.push(Actions.moveNode(node.getId(), model.getRootRow()!.getId(), DockLocation.BOTTOM, -1, true));
    } else if (peerContainer !== undefined) {
      actions.push(Actions.moveNode(node.getId(), peerContainer.getId(), panel === 'project' ? DockLocation.LEFT : DockLocation.CENTER, -1, true));
    } else {
      const monitor = ['program', 'source', 'tactical'].find((candidate) => open.has(candidate as ProjectWorkspacePanel));
      const target = monitor === undefined ? model.getFirstTabSet() : panelContainer(workspacePanelNode(model, monitor as ProjectWorkspacePanel));
      if (support && target instanceof TabSetNode) {
        const document = target.getDocument();
        const preferredWidth = Number.parseFloat(document?.defaultView?.getComputedStyle(document.documentElement).getPropertyValue('--w-panel') ?? '');
        const availableWidth = target.getRect().width - (model.getSplitterSize() ?? 0);
        initialSupport = {
          target,
          weight: target.getWeight(),
          share: availableWidth > 0 && preferredWidth > 0 ? Math.min(1 / 3, preferredWidth / availableWidth) : 1 / 3,
        };
      }
      actions.push(Actions.moveNode(node.getId(), (target ?? model.getRootRow()!).getId(),
        target === undefined ? DockLocation.CENTER : support ? DockLocation.RIGHT : DockLocation.CENTER, -1, true));
    }
  } else {
    actions.push(Actions.selectTab(node.getId()));
  }
  const opening = projectWorkspaceDockAction(model, Actions.group(actions));
  // A newly split tabset receives a generated id. Finish that same opening
  // operation with its initial width before persisting the completed layout.
  model.doAction(initialSupport === undefined ? opening : opening.setAdjusting(true));
  if (initialSupport !== undefined) {
    const support = panelContainer(node);
    model.doAction(Actions.group([
      Actions.updateNodeAttributes(initialSupport.target.getId(), { weight: initialSupport.weight * (1 - initialSupport.share) }),
      Actions.updateNodeAttributes(support.getId(), { weight: initialSupport.weight * initialSupport.share }),
    ]));
  }
}

export function hideProjectWorkspacePanel(model: Model, panel: ProjectWorkspacePanel): void {
  const node = workspacePanelNode(model, panel);
  model.doAction(projectWorkspaceDockAction(model, Actions.deleteTab(node.getId())));
}

/** Native Close/Close All actions mean hide, including grouped context actions. */
export function projectWorkspaceDockAction(model: Model, action: Action): Action {
  const parking = (['bottom', 'left', 'right', 'top'] as const)
    .map((location) => model.getNodeById(`border_${location}`))
    .find((border): border is BorderNode => border instanceof BorderNode && !border.isShowing())!;
  let hiding = false;
  const replaceClose = (next: Action): Action => {
    if (next instanceof GroupAction) return Actions.group(next.actions.map(replaceClose));
    if (next.type !== Actions.DELETE_TAB) return next;
    hiding = true;
    return Actions.moveNode(next.data.node as string, parking.getId(), DockLocation.CENTER, -1, false);
  };
  const next = replaceClose(action);
  const departures = new Map<TabSetNode, Set<string>>();
  const collectMoves = (move: Action): void => {
    if (move instanceof GroupAction) {
      move.actions.forEach(collectMoves);
      return;
    }
    if (move.type !== Actions.MOVE_NODE) return;
    const from = model.getNodeById(move.data.fromNode as string);
    if (from === undefined || (from.getType() !== 'tab' && from.getType() !== 'tabgroup')) return;
    const tabs: TabNode[] = [];
    const collectTabs = (node: typeof from): void => {
      if (node instanceof TabNode) tabs.push(node);
      else node.getChildren().forEach(collectTabs);
    };
    collectTabs(from);
    for (const tab of tabs) {
      const source = panelContainer(tab);
      if (!(source instanceof TabSetNode) || !source.isEnableDeleteWhenEmpty() || source.isEnableClose()) continue;
      let destination = model.getNodeById(move.data.toNode as string);
      while (destination !== undefined && !(destination instanceof TabSetNode)) destination = destination.getParent();
      if (destination === source && move.data.location === DockLocation.CENTER.getName()) continue;
      const moved = departures.get(source) ?? new Set<string>();
      moved.add(tab.getId());
      departures.set(source, moved);
    }
  };
  collectMoves(next);
  const cleanup: Action[] = [];
  for (const [source, moved] of departures) {
    const allTabs: string[] = [];
    const collect = (nodes: ReturnType<TabSetNode['getChildren']>): void => {
      for (const node of nodes) {
        if (node instanceof TabNode) allTabs.push(node.getId());
        else collect(node.getChildren());
      }
    };
    collect(source.getChildren());
    if (allTabs.every((id) => moved.has(id))) {
      // FlexLayout's tidy requires both flags. Allow deletion only for a group
      // drained by this action; deliberately retained empty groups stay intact.
      cleanup.push(Actions.updateNodeAttributes(source.getId(), { enableClose: true }));
    }
  }
  const maximized = model.getMaximizedTabset();
  if (hiding && maximized !== undefined) cleanup.unshift(Actions.maximizeToggle(maximized.getId()));
  return cleanup.length > 0 ? Actions.group([...cleanup, next]) : next;
}

/** Maximize is temporary viewing state, not saved geometry. */
export function projectWorkspaceSnapshot(model: Model): IJsonModel {
  const snapshot = model.toJson();
  const clearMaximize = (node: IJsonRowNode): void => {
    for (const child of node.children ?? []) {
      if (child.type === 'row') clearMaximize(child as IJsonRowNode);
      else delete (child as { maximized?: boolean }).maximized;
    }
  };
  clearMaximize(snapshot.layout);
  return snapshot;
}

export function loadProjectWorkspaceLayout(projectId: string, storage: WorkspaceLayoutStorage | null): IJsonModel {
  try {
    const serialized = storage?.getItem(projectWorkspaceLayoutKey(projectId));
    if (!serialized || serialized.length > 100_000) return createProjectWorkspaceLayout();
    const parsed: unknown = JSON.parse(serialized);
    return isCurrentProjectWorkspaceLayout(parsed) ? parsed : createProjectWorkspaceLayout();
  } catch {
    return createProjectWorkspaceLayout();
  }
}

export function saveProjectWorkspaceLayout(projectId: string, storage: WorkspaceLayoutStorage | null, layout: IJsonModel): boolean {
  return writeStorage(storage, projectWorkspaceLayoutKey(projectId), layout);
}

export function projectWorkspaceLayoutKey(projectId: string): string {
  return `vibe-cs:project-workspace-layout:${projectId}`;
}

export function loadSavedProjectWorkspaceLayouts(storage: WorkspaceLayoutStorage | null): SavedProjectWorkspaceLayout[] {
  try {
    const serialized = storage?.getItem(SAVED_LAYOUTS_KEY);
    if (!serialized || serialized.length > 2_000_000) return [];
    const value: unknown = JSON.parse(serialized);
    if (!Array.isArray(value)) return [];
    const ids = new Set<string>();
    return value.filter((entry): entry is SavedProjectWorkspaceLayout => {
      if (entry === null || typeof entry !== 'object'
        || typeof entry.id !== 'string' || !entry.id.startsWith('saved:') || ids.has(entry.id)
        || typeof entry.name !== 'string' || entry.name.trim().length === 0 || entry.name.length > 60
        || !isCurrentProjectWorkspaceLayout(entry.layout)) return false;
      ids.add(entry.id);
      return true;
    });
  } catch { return []; }
}

export function saveSavedProjectWorkspaceLayouts(storage: WorkspaceLayoutStorage | null, layouts: readonly SavedProjectWorkspaceLayout[]): boolean {
  return writeStorage(storage, SAVED_LAYOUTS_KEY, layouts);
}

export function loadProjectWorkspaceChoice(projectId: string, storage: WorkspaceLayoutStorage | null): string {
  try { return storage?.getItem(`vibe-cs:project-workspace-choice:${projectId}`) ?? 'editing'; } catch { return 'editing'; }
}

export function saveProjectWorkspaceChoice(projectId: string, storage: WorkspaceLayoutStorage | null, choice: string): boolean {
  try { storage?.setItem(`vibe-cs:project-workspace-choice:${projectId}`, choice); return storage !== null; } catch { return false; }
}

function writeStorage(storage: WorkspaceLayoutStorage | null, key: string, value: unknown): boolean {
  try { storage?.setItem(key, JSON.stringify(value)); return storage !== null; } catch { return false; }
}

export function browserWorkspaceStorage(): Storage | null {
  try { return typeof globalThis.localStorage === 'undefined' ? null : globalThis.localStorage; } catch { return null; }
}

function isCurrentProjectWorkspaceLayout(value: unknown): value is IJsonModel {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const layout = value as IJsonModel;
  if (layout.layout?.type !== 'row'
    || (layout.subLayouts !== undefined && Object.keys(layout.subLayouts).length > 0)
    || (layout.popouts !== undefined && Object.keys(layout.popouts).length > 0)) return false;
  try {
    const panels = new Set<string>();
    let valid = true;
    visitJsonTabs(layout, (tab) => {
      if (!isProjectWorkspacePanel(tab.component) || panels.has(tab.component) || tab.id !== `${tab.component}-panel`) valid = false;
      else panels.add(tab.component);
    });
    if (!valid || panels.size === 0) return false;
    const model = Model.fromJson(layout);
    const borders = model.getBorderSet().toJson();
    return borders.some((border) => border.show === false) || borders.length < 4;
  } catch { return false; }
}

function visitJsonTabs(layout: IJsonModel, visit: (tab: IJsonTabNode) => void): void {
  const walk = (value: unknown): void => {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return;
    const node = value as { type?: unknown; children?: unknown };
    if (node.type === 'tab') visit(value as IJsonTabNode);
    else if (Array.isArray(node.children)) node.children.forEach(walk);
  };
  walk(layout.layout);
  layout.borders?.forEach(walk);
}
