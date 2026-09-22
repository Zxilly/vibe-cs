import { t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { Actions, type Action, type Model } from 'flexlayout-react';
import { Check, LayoutTemplate, PanelsTopLeft } from 'lucide-react';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import { Dialog, Drawer } from '../../design/feedback';
import { OverflowMenu } from '../../design/layout';
import { Button, Input } from '../../design/primitives';
import {
  PROJECT_WORKSPACE_PANELS, browserWorkspaceStorage, createProjectWorkspaceLayout,
  createProjectWorkspaceModel, hideProjectWorkspacePanel, loadProjectWorkspaceChoice,
  loadProjectWorkspaceLayout, loadSavedProjectWorkspaceLayouts, openProjectWorkspacePanels,
  projectWorkspaceSnapshot, saveProjectWorkspaceChoice, saveProjectWorkspaceLayout,
  saveSavedProjectWorkspaceLayouts, showProjectWorkspacePanel, visibleProjectWorkspacePanels,
  type ProjectWorkspacePanel, type ProjectWorkspacePreset, type SavedProjectWorkspaceLayout,
  type WorkspaceLayoutStorage,
} from './projectWorkspaceLayout';

interface WorkspaceLayoutContextValue {
  readonly model: Model;
  readonly revision: number;
  readonly choice: string;
  readonly saved: readonly SavedProjectWorkspaceLayout[];
  readonly openPanels: ReadonlySet<ProjectWorkspacePanel>;
  readonly visiblePanels: ReadonlySet<ProjectWorkspacePanel>;
  readonly persistenceFailed: boolean;
  showPanel(panel: ProjectWorkspacePanel): void;
  hidePanel(panel: ProjectWorkspacePanel): void;
  chooseLayout(id: string): void;
  restoreLayout(): void;
  saveAs(name: string): boolean;
  saveCurrent(): boolean;
  renameCurrent(name: string): boolean;
  deleteCurrent(): boolean;
}

const WorkspaceLayoutContext = createContext<WorkspaceLayoutContextValue | null>(null);

export function useProjectWorkspaceLayout(): WorkspaceLayoutContextValue {
  const context = useContext(WorkspaceLayoutContext);
  if (context === null) throw new Error('Project workspace requires its layout provider');
  return context;
}

export function ProjectWorkspaceLayoutProvider({
  projectId, children, storage = browserWorkspaceStorage(),
}: {
  readonly projectId: string;
  readonly children: ReactNode;
  readonly storage?: WorkspaceLayoutStorage | null;
}) {
  const [saved, setSaved] = useState(() => loadSavedProjectWorkspaceLayouts(storage));
  const [choice, setChoice] = useState(() => {
    const selected = loadProjectWorkspaceChoice(projectId, storage);
    return isPreset(selected) || saved.some((entry) => entry.id === selected) ? selected : 'editing';
  });
  const [model, setModel] = useState(() => createProjectWorkspaceModel(loadProjectWorkspaceLayout(projectId, storage)));
  const modelRef = useRef(model);
  const [revision, setRevision] = useState(0);
  const [persistenceFailed, setPersistenceFailed] = useState(false);

  const persistModel = useCallback((next: Model) => {
    const success = saveProjectWorkspaceLayout(projectId, storage, projectWorkspaceSnapshot(next));
    if (!success) setPersistenceFailed(true);
    return success;
  }, [projectId, storage]);

  useEffect(() => {
    const changed = (action: Action) => {
      // Pointer-move resize actions are rendered by FlexLayout itself. Only the
      // completed gesture updates the saved workspace and the menu projection.
      if (action.isAdjusting()) return;
      setRevision((value) => value + 1);
      if (action.type !== Actions.MAXIMIZE_TOGGLE && action.type !== Actions.RENAME_TAB) persistModel(model);
    };
    model.addChangeListener(changed);
    return () => model.removeChangeListener(changed);
  }, [model, persistModel]);

  const changeChoice = (id: string) => {
    setChoice(id);
    if (!saveProjectWorkspaceChoice(projectId, storage, id)) setPersistenceFailed(true);
  };
  const chooseLayout = (id: string) => {
    const layout = isPreset(id) ? createProjectWorkspaceLayout(id) : saved.find((entry) => entry.id === id)?.layout;
    if (layout === undefined) return;
    const next = createProjectWorkspaceModel(layout, modelRef.current);
    modelRef.current = next;
    setModel(next);
    persistModel(next);
    changeChoice(id);
  };
  const updateSaved = (next: SavedProjectWorkspaceLayout[]) => {
    const success = saveSavedProjectWorkspaceLayouts(storage, next);
    if (!success) {
      setPersistenceFailed(true);
      return false;
    }
    setSaved(next);
    return true;
  };
  const value = {
    model, revision, choice, saved, persistenceFailed,
    openPanels: useMemo(() => openProjectWorkspacePanels(model), [model, revision]),
    visiblePanels: useMemo(() => visibleProjectWorkspacePanels(model), [model, revision]),
    showPanel: (panel: ProjectWorkspacePanel) => showProjectWorkspacePanel(modelRef.current, panel),
    hidePanel: (panel: ProjectWorkspacePanel) => hideProjectWorkspacePanel(modelRef.current, panel),
    chooseLayout,
    restoreLayout: () => chooseLayout(choice),
    saveAs: (name: string) => {
      setPersistenceFailed(false);
      const id = `saved:${crypto.randomUUID()}`;
      if (!updateSaved([...saved, { id, name: name.trim(), layout: projectWorkspaceSnapshot(modelRef.current) }])) return false;
      persistModel(modelRef.current);
      changeChoice(id);
      return true;
    },
    saveCurrent: () => {
      setPersistenceFailed(false);
      return updateSaved(saved.map((entry) => entry.id === choice
        ? { ...entry, layout: projectWorkspaceSnapshot(modelRef.current) } : entry));
    },
    renameCurrent: (name: string) => {
      setPersistenceFailed(false);
      return updateSaved(saved.map((entry) => entry.id === choice ? { ...entry, name: name.trim() } : entry));
    },
    deleteCurrent: () => {
      setPersistenceFailed(false);
      if (!updateSaved(saved.filter((entry) => entry.id !== choice))) return false;
      chooseLayout('editing');
      return true;
    },
  } satisfies WorkspaceLayoutContextValue;

  return <WorkspaceLayoutContext.Provider value={value}>{children}</WorkspaceLayoutContext.Provider>;
}

function isPreset(value: string): value is ProjectWorkspacePreset {
  return value === 'editing' || value === 'compare' || value === 'agent';
}

export function ProjectWorkspaceLayoutMenu({ labels }: {
  readonly labels: Readonly<Record<ProjectWorkspacePanel, string>>;
}) {
  const workspace = useProjectWorkspaceLayout();
  const current = workspace.saved.find((entry) => entry.id === workspace.choice);
  const [dialog, setDialog] = useState<'save' | 'rename' | 'panels' | 'delete' | null>(null);
  const [name, setName] = useState('');
  const builtins = [
    { id: 'editing', name: t`剪辑` },
    { id: 'compare', name: t`对照预览` },
    { id: 'agent', name: t`Agent 协作` },
  ];
  const choices = [...builtins, ...workspace.saved];
  const selectedName = choices.find((entry) => entry.id === workspace.choice)?.name ?? t`剪辑`;
  const duplicate = choices.some((entry) => entry.name.toLocaleLowerCase() === name.trim().toLocaleLowerCase()
    && (dialog !== 'rename' || entry.id !== current?.id));
  const nameValid = name.trim().length > 0 && name.trim().length <= 60 && !duplicate;
  const startName = (kind: 'save' | 'rename') => {
    setName(kind === 'rename' ? current?.name ?? '' : '');
    setDialog(kind);
  };
  return <>
    <OverflowMenu
      label={t`工作区布局`}
      triggerLabel={<><LayoutTemplate className="size-3.5" aria-hidden="true" /><span className="max-w-24 truncate" title={selectedName}>{selectedName}</span></>}
      triggerClassName="h-[var(--h-ctl-sm)] rounded-md border border-divider"
      items={[
        ...choices.map((entry) => ({ id: entry.id, label: entry.name, current: workspace.choice === entry.id, onSelect: () => workspace.chooseLayout(entry.id) })),
        { id: 'restore', label: t`恢复已保存布局`, onSelect: workspace.restoreLayout },
        { id: 'panels', label: t`显示与隐藏面板…`, onSelect: () => setDialog('panels') },
        { id: 'save-as', label: t`将当前布局另存为…`, onSelect: () => startName('save') },
        ...(current === undefined ? [] : [
          { id: 'save', label: t`保存对此布局的更改`, onSelect: workspace.saveCurrent },
          { id: 'rename', label: t`重命名布局…`, onSelect: () => startName('rename') },
          { id: 'delete', label: t`删除此布局…`, onSelect: () => setDialog('delete') },
        ]),
      ]}
    />
    {workspace.persistenceFailed ? <span role="status" className="text-xs text-fail-text"><Trans>布局未保存</Trans></span> : null}
    <Drawer
      open={dialog === 'panels' || dialog === 'save' || dialog === 'rename'}
      title={dialog === 'panels' ? t`工作区面板` : dialog === 'rename' ? t`重命名布局` : t`保存工作区布局`}
      width="standard"
      onClose={() => setDialog(null)}
    >
      {dialog === 'panels' ? <>
        <p className="mb-4 text-sm text-neutral-600"><Trans>拖动页签可移动或分组面板，拖动分隔线可调整大小。隐藏面板会保留其内容。</Trans></p>
        <div className="divide-y divide-divider">
          {PROJECT_WORKSPACE_PANELS.map((panel) => <div key={panel} className="flex items-center justify-between gap-3 py-2">
            <span className="flex items-center gap-2 text-sm"><PanelsTopLeft className="size-4 text-neutral-600" aria-hidden="true" />{labels[panel]}</span>
            <Button size="sm" variant="ghost" aria-label={workspace.openPanels.has(panel) ? t`隐藏 ${labels[panel]}` : t`显示 ${labels[panel]}`}
              aria-pressed={workspace.openPanels.has(panel)}
              onClick={() => workspace.openPanels.has(panel) ? workspace.hidePanel(panel) : workspace.showPanel(panel)}>
              {workspace.openPanels.has(panel) ? <><Check className="size-3.5" aria-hidden="true" /><Trans>已显示</Trans></> : <Trans>显示</Trans>}
            </Button>
          </div>)}
        </div>
      </> : <form onSubmit={(event) => {
        event.preventDefault();
        if (!nameValid) return;
        const saved = dialog === 'rename' ? workspace.renameCurrent(name) : workspace.saveAs(name);
        if (saved) setDialog(null);
      }}>
        <label className="mb-2 block text-sm" htmlFor="workspace-layout-name"><Trans>布局名称</Trans></label>
        <Input id="workspace-layout-name" value={name} maxLength={60} autoFocus invalid={duplicate}
          aria-describedby={duplicate ? 'workspace-layout-name-error' : undefined}
          onChange={(event) => setName(event.target.value)} />
        {duplicate ? <p id="workspace-layout-name-error" className="mt-2 text-sm text-fail-text"><Trans>已有同名布局，请换一个名称。</Trans></p> : null}
        <p className="mt-3 text-sm text-neutral-600"><Trans>保存面板的位置、大小和分组，可用于其他作品。切换布局会载入已保存的位置；切换前请保存需要保留的调整。</Trans></p>
        <div className="mt-4 flex justify-end gap-2">
          <Button size="sm" variant="ghost" onClick={() => setDialog(null)}><Trans>取消</Trans></Button>
          <Button type="submit" size="sm" variant="primary" disabled={!nameValid}><Trans>保存布局</Trans></Button>
        </div>
      </form>}
      {workspace.persistenceFailed ? <p role="alert" className="mt-4 text-sm text-fail-text"><Trans>此设备暂时无法保存布局，当前调整仍可使用。</Trans></p> : null}
    </Drawer>
    <Dialog open={dialog === 'delete'} title={t`删除这个已保存布局？`} tone="destructive"
      confirmLabel={t`删除布局`} onClose={() => setDialog(null)} onConfirm={() => { if (workspace.deleteCurrent()) setDialog(null); }}>
      <Trans>将删除「{current?.name}」并回到剪辑布局，作品内容不会改变。</Trans>
    </Dialog>
  </>;
}
