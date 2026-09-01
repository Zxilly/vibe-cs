import { t } from '@lingui/core/macro';
import {
  type Action,
  I18nLabel,
  Layout as FlexLayout,
  Model,
  type ITabRenderValues,
  type TabNode,
} from 'flexlayout-react';
import 'flexlayout-react/style/light.css';
import { useCallback, useState, type ReactNode } from 'react';

import {
  loadProjectWorkspaceLayout,
  saveProjectWorkspaceLayout,
  type ProjectWorkspacePanel,
} from './projectWorkspaceLayout';

export interface ProjectWorkspaceDockProps {
  readonly projectId: string;
  readonly panels: Readonly<Record<ProjectWorkspacePanel, ReactNode>>;
  readonly labels: Readonly<Record<ProjectWorkspacePanel, string>>;
}

export function ProjectWorkspaceDock({ projectId, panels, labels }: ProjectWorkspaceDockProps) {
  const storage = browserStorage();
  const [model] = useState(() => Model.fromJson(loadProjectWorkspaceLayout(projectId, storage)));
  const factory = useCallback((node: TabNode) => {
    const component = node.getComponent();
    if (!isProjectWorkspacePanel(component)) return null;
    return (
      <div className="size-full min-h-0 min-w-0 overflow-hidden" data-dock-panel={component}>
        {panels[component]}
      </div>
    );
  }, [panels]);
  const renderTab = useCallback((node: TabNode, values: ITabRenderValues) => {
    const component = node.getComponent();
    if (isProjectWorkspacePanel(component)) values.content = labels[component];
  }, [labels]);
  return (
    <div
      className="project-workspace-dock flexlayout__theme_light relative size-full min-h-0 min-w-0 flex-1 overflow-hidden"
      aria-label={t`作品工作区面板`}
    >
      <FlexLayout
        model={model}
        factory={factory}
        i18nMapper={projectWorkspaceLabel}
        onRenderTab={renderTab}
        onModelChange={(next, action: Action) => {
          // FlexLayout emits transient adjusting actions during realtime splitter
          // motion. Persist only the final gesture so pointer movement stays free
          // of synchronous localStorage writes.
          if (!action.isAdjusting()) saveProjectWorkspaceLayout(projectId, storage, next.toJson());
        }}
        realtimeResize
        supportsPopout={false}
      />
    </div>
  );
}

function projectWorkspaceLabel(label: I18nLabel): string | undefined {
  switch (label) {
    case I18nLabel.Maximize: return t`最大化面板`;
    case I18nLabel.Restore: return t`恢复面板`;
    case I18nLabel.Move_Tabset: return t`移动面板组`;
    case I18nLabel.Move_Tabs: return t`移动多个面板`;
    case I18nLabel.Overflow_Menu_Tooltip: return t`隐藏的面板`;
    case I18nLabel.Splitter: return t`调整面板尺寸`;
    case I18nLabel.Error_rendering_component: return t`面板渲染失败`;
    case I18nLabel.Error_rendering_component_retry: return t`重试`;
    default: return undefined;
  }
}

function browserStorage(): Storage | null {
  try {
    return typeof globalThis.localStorage === 'undefined' ? null : globalThis.localStorage;
  } catch {
    return null;
  }
}

function isProjectWorkspacePanel(value: string | undefined): value is ProjectWorkspacePanel {
  return value === 'project'
    || value === 'program'
    || value === 'tactical'
    || value === 'timeline'
    || value === 'agent'
    || value === 'mixer';
}
