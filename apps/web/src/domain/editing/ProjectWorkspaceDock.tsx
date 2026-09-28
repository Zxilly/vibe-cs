import { t } from '@lingui/core/macro';
import {
  type Action,
  Actions,
  ContextMenuBuilder,
  I18nLabel,
  Layout as FlexLayout,
  type ITabRenderValues,
  type TabNode,
  PopupMenu,
  type PopupMenuEntry,
} from 'flexlayout-react';
import 'flexlayout-react/style/light.css';
import { useCallback, useEffect, useImperativeHandle, useState, type ReactNode, type Ref } from 'react';

import {
  isProjectWorkspacePanel,
  projectWorkspaceDockAction,
  type ProjectWorkspacePanel,
} from './projectWorkspaceLayout';
import { useProjectWorkspaceLayout } from './ProjectWorkspaceManager';

export interface ProjectWorkspaceDockProps {
  readonly ref?: Ref<ProjectWorkspaceDockHandle>;
  readonly projectId: string;
  readonly panels: Readonly<Record<ProjectWorkspacePanel, ReactNode>>;
  readonly labels: Readonly<Record<ProjectWorkspacePanel, string>>;
  readonly onPanelVisibilityChange?: (visible: ReadonlySet<ProjectWorkspacePanel>) => void;
}

export interface ProjectWorkspaceDockHandle {
  showPanel(panel: ProjectWorkspacePanel): void;
  hidePanel(panel: ProjectWorkspacePanel): void;
}

export function ProjectWorkspaceDock({ panels, labels, ref, onPanelVisibilityChange }: ProjectWorkspaceDockProps) {
  const workspace = useProjectWorkspaceLayout();
  const { model, visiblePanels } = workspace;
  const [contextMenu, setContextMenu] = useState<{
    anchor: { x: number; y: number };
    items: PopupMenuEntry[];
    target: HTMLElement;
  } | null>(null);
  useImperativeHandle(ref, () => ({
    showPanel: workspace.showPanel,
    hidePanel: workspace.hidePanel,
  }), [workspace.showPanel, workspace.hidePanel]);
  useEffect(() => { onPanelVisibilityChange?.(visiblePanels); }, [onPanelVisibilityChange, visiblePanels]);
  useEffect(() => {
    model.visitNodes((node) => {
      if (node.getType() !== 'tab') return;
      const tab = node as TabNode;
      const panel = tab.getComponent();
      if (isProjectWorkspacePanel(panel) && tab.getName() !== labels[panel]) model.doAction(Actions.renameTab(tab.getId(), labels[panel]));
    });
  }, [model, labels]);
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
        onAction={(action: Action) => projectWorkspaceDockAction(model, action)}
        onContextMenu={(node, event) => {
          event.preventDefault();
          event.stopPropagation();
          const items = new ContextMenuBuilder(node, {
            onAction: (action) => { model.doAction(projectWorkspaceDockAction(model, action)); },
          }).addStandard().addDivider().add('closeAll').add('closeOthers').build();
          setContextMenu({
            anchor: { x: event.clientX, y: event.clientY },
            items,
            target: event.currentTarget as HTMLElement,
          });
        }}
        realtimeResize
        supportsPopout={false}
      />
      {contextMenu === null ? null : <PopupMenu
        anchor={contextMenu.anchor} items={contextMenu.items}
        title={t`面板操作`} returnFocusTo={contextMenu.target}
        onClose={() => setContextMenu(null)}
      />}
    </div>
  );
}

function projectWorkspaceLabel(label: I18nLabel): string | undefined {
  switch (label) {
    case I18nLabel.Maximize: return t`最大化面板`;
    case I18nLabel.Restore: return t`恢复面板`;
    case I18nLabel.Move_Tabset: return t`移动面板组`;
    case I18nLabel.Move_Tabs: return t`移动多个面板`;
    case I18nLabel.Overflow_Menu_Tooltip: return t`更多面板`;
    case I18nLabel.Close_Tab: return t`隐藏面板`;
    case I18nLabel.Menu_Close_All: return t`隐藏此组所有面板`;
    case I18nLabel.Menu_Close_Right: return t`隐藏右侧面板`;
    case I18nLabel.Menu_Close_Others: return t`隐藏其他面板`;
    case I18nLabel.Menu_Maximize: return t`最大化面板`;
    case I18nLabel.Menu_Restore: return t`恢复面板`;
    case I18nLabel.Menu_Add_To_New_Group: return t`新建面板分组`;
    case I18nLabel.Menu_Add_To_Group: return t`加入面板分组`;
    case I18nLabel.Menu_Remove_From_Group: return t`移出面板分组`;
    case I18nLabel.Menu_Ungroup: return t`取消面板分组`;
    case I18nLabel.Menu_Expand: return t`展开面板分组`;
    case I18nLabel.Menu_Collapse: return t`折叠面板分组`;
    case I18nLabel.Rename_Group: return t`重命名面板分组`;
    case I18nLabel.Group_Name_Label: return t`分组名称`;
    case I18nLabel.Group_Name_Placeholder: return t`分组名称`;
    case I18nLabel.Group_Color: return t`分组颜色`;
    case I18nLabel.Group_Pill_Tooltip: return t`展开或折叠面板分组`;
    case I18nLabel.Splitter: return t`调整面板尺寸`;
    case I18nLabel.Error_rendering_component: return t`面板渲染失败`;
    case I18nLabel.Error_rendering_component_retry: return t`重试`;
    default: return undefined;
  }
}
