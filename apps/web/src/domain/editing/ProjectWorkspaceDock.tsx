import { t } from '@lingui/core/macro';
import {
  type Action,
  Actions,
  I18nLabel,
  Layout as FlexLayout,
  Model,
  type ITabRenderValues,
  type TabNode,
} from 'flexlayout-react';
import 'flexlayout-react/style/light.css';
import { useCallback, useImperativeHandle, useState, type ReactNode, type Ref } from 'react';
import { useCollapsed } from '../../design/layout';
import { Drawer } from '../../design/feedback';
import { Seg } from '../../design/primitives';

import {
  loadProjectWorkspaceLayout,
  createProjectWorkspaceLayout,
  saveProjectWorkspaceLayout,
  type ProjectWorkspacePanel,
} from './projectWorkspaceLayout';

export interface ProjectWorkspaceDockProps {
  readonly ref?: Ref<ProjectWorkspaceDockHandle>;
  readonly projectId: string;
  readonly panels: Readonly<Record<ProjectWorkspacePanel, ReactNode>>;
  readonly labels: Readonly<Record<ProjectWorkspacePanel, string>>;
}

export interface ProjectWorkspaceDockHandle {
  showPanel(panel: ProjectWorkspacePanel): void;
}

export function ProjectWorkspaceDock({ projectId, panels, labels, ref }: ProjectWorkspaceDockProps) {
  const storage = browserStorage();
  const compact = useCollapsed(undefined);
  const [wideModel] = useState(() => localizedWorkspaceModel(loadProjectWorkspaceLayout(projectId, storage), labels));
  const [compactModel] = useState(() => localizedWorkspaceModel(createProjectWorkspaceLayout('compact'), labels));
  const model = compact ? compactModel : wideModel;
  const [supportPanel, setSupportPanel] = useState<'agent' | 'mixer' | null>(null);
  useImperativeHandle(ref, () => ({
    showPanel(panel) {
      if (compact && (panel === 'agent' || panel === 'mixer')) setSupportPanel(panel);
      else model.doAction(Actions.selectTab(`${panel}-panel`));
    },
  }), [compact, model]);
  const factory = useCallback((node: TabNode) => {
    const component = node.getComponent();
    if (!isProjectWorkspacePanel(component)) return null;
    if (compact && (component === 'agent' || component === 'mixer')) return null;
    return (
      <div className="size-full min-h-0 min-w-0 overflow-hidden" data-dock-panel={component}>
        {panels[component]}
      </div>
    );
  }, [compact, panels]);
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
          // Responsive geometry is a view, not a replacement for the user's
          // saved desktop layout. Both modes render the same panel instances.
          if (!compact && !action.isAdjusting()) saveProjectWorkspaceLayout(projectId, storage, next.toJson());
        }}
        realtimeResize
        supportsPopout={false}
      />
      <Drawer
        open={compact && supportPanel !== null}
        title={labels[supportPanel ?? 'agent']}
        onClose={() => setSupportPanel(null)}
        className="w-[var(--w-agent-drawer)]"
        bodyClassName="flex flex-col overflow-hidden p-0"
      >
        <div className="flex-none border-b border-divider px-3 py-2">
          <Seg<'agent' | 'mixer'> name="workspace-support-panel" value={supportPanel ?? 'agent'}
            aria-label={t`辅助面板`} onChange={setSupportPanel}
            options={[{ value: 'agent', label: labels.agent }, { value: 'mixer', label: labels.mixer }]} />
        </div>
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden [&>*]:h-full [&>*]:min-h-0" data-dock-panel={supportPanel ?? 'agent'}>{panels[supportPanel ?? 'agent']}</div>
      </Drawer>
    </div>
  );
}

function localizedWorkspaceModel(
  layout: Parameters<typeof Model.fromJson>[0],
  labels: ProjectWorkspaceDockProps['labels'],
): Model {
  const model = Model.fromJson(layout);
  model.visitNodes((node) => {
    if (node.getType() !== 'tab') return;
    const tab = node as TabNode;
    const panel = tab.getComponent();
    if (isProjectWorkspacePanel(panel)) model.doAction(Actions.renameTab(tab.getId(), labels[panel]));
  });
  return model;
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
