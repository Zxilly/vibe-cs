import { Model, type IJsonModel } from 'flexlayout-react';

export type ProjectWorkspacePanel = 'project' | 'program' | 'tactical' | 'timeline' | 'agent' | 'mixer';

export const PROJECT_WORKSPACE_PANELS: readonly ProjectWorkspacePanel[] = [
  'project',
  'program',
  'tactical',
  'timeline',
  'agent',
  'mixer',
];

interface WorkspaceLayoutStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export function createProjectWorkspaceLayout(): IJsonModel {
  const tab = (id: string, name: string, component: ProjectWorkspacePanel) => ({
    type: 'tab',
    id,
    name,
    component,
    enableClose: false,
    enablePopout: false,
    enableRename: false,
  });
  return {
    global: {
      enableEdgeDock: true,
      enableEdgeDockIndicators: true,
      tabEnableClose: false,
      tabEnableDrag: true,
      tabEnablePin: false,
      tabEnablePopout: false,
      tabEnablePopoutIcon: false,
      tabEnableRename: false,
      tabSetEnableClose: false,
      tabSetEnableCloseButton: false,
      tabSetEnableDeleteWhenEmpty: true,
      tabSetEnableDivide: true,
      tabSetEnableDrag: true,
      tabSetEnableDrop: true,
      tabSetEnableMaximize: true,
      tabSetEnableTabStrip: true,
      tabSetMinHeight: 160,
      tabSetMinWidth: 220,
    },
    layout: {
      type: 'row',
      id: 'workspace-root',
      children: [
        {
          type: 'tabset',
          id: 'project-group',
          name: 'Project panel',
          weight: 22,
          children: [tab('project-panel', 'Project', 'project')],
        },
        {
          type: 'row',
          id: 'editing-column',
          weight: 58,
          children: [
            {
              type: 'row',
              id: 'monitor-row',
              weight: 46,
              children: [
                {
                  type: 'tabset',
                  id: 'program-group',
                  name: 'Program monitor',
                  weight: 50,
                  children: [tab('program-panel', 'Program', 'program')],
                },
                {
                  type: 'tabset',
                  id: 'tactical-group',
                  name: 'Tactical monitor',
                  weight: 50,
                  children: [tab('tactical-panel', 'Tactical', 'tactical')],
                },
              ],
            },
            {
              type: 'tabset',
              id: 'timeline-group',
              name: 'Timeline panel',
              weight: 54,
              children: [tab('timeline-panel', 'Timeline', 'timeline')],
            },
          ],
        },
        {
          type: 'tabset',
          id: 'agent-group',
          name: 'Agent panel',
          weight: 20,
          children: [
            tab('agent-panel', 'Agent', 'agent'),
            tab('mixer-panel', 'Audio Track Mixer', 'mixer'),
          ],
        },
      ],
    },
  };
}

export function loadProjectWorkspaceLayout(
  projectId: string,
  storage: WorkspaceLayoutStorage | null,
): IJsonModel {
  if (storage === null) return createProjectWorkspaceLayout();
  try {
    const serialized = storage.getItem(projectWorkspaceLayoutKey(projectId));
    if (serialized === null || serialized.length > 100_000) return createProjectWorkspaceLayout();
    const parsed: unknown = JSON.parse(serialized);
    if (!isCurrentProjectWorkspaceLayout(parsed)) return createProjectWorkspaceLayout();
    Model.fromJson(parsed);
    return parsed;
  } catch {
    return createProjectWorkspaceLayout();
  }
}

export function saveProjectWorkspaceLayout(
  projectId: string,
  storage: WorkspaceLayoutStorage | null,
  layout: IJsonModel,
): void {
  if (storage === null || !isCurrentProjectWorkspaceLayout(layout)) return;
  try {
    storage.setItem(projectWorkspaceLayoutKey(projectId), JSON.stringify(layout));
  } catch {
    // Workspace geometry is recoverable view state; storage failure must not
    // interrupt editing or mutate the Project Head.
  }
}

export function resetProjectWorkspaceLayout(
  projectId: string,
  storage: WorkspaceLayoutStorage | null,
): void {
  try {
    storage?.removeItem(projectWorkspaceLayoutKey(projectId));
  } catch {
    // The default layout still mounts even when browser storage is unavailable.
  }
}

export function projectWorkspaceLayoutKey(projectId: string): string {
  return `vibe-cs:project-workspace-layout:${projectId}`;
}

function isCurrentProjectWorkspaceLayout(value: unknown): value is IJsonModel {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const root = (value as { layout?: unknown }).layout;
  const components: string[] = [];
  collectPanelComponents(root, components);
  return components.length === PROJECT_WORKSPACE_PANELS.length
    && PROJECT_WORKSPACE_PANELS.every((component) => components.filter((value) => value === component).length === 1);
}

function collectPanelComponents(value: unknown, components: string[]): void {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return;
  const node = value as { component?: unknown; children?: unknown };
  if (typeof node.component === 'string') components.push(node.component);
  if (Array.isArray(node.children)) {
    for (const child of node.children) collectPanelComponents(child, components);
  }
}
