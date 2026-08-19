import { Trans } from '@lingui/react/macro';
import { useEffect, useState } from 'react';

import { dataErrorMessage } from '../../data/errors';
import { useCreateAgentPlan } from '../../data/plans';
import { useProjectCollections, type ProjectCollectedClip } from '../../data/projectCollections';
import { useProjects } from '../../data/projects';
import { Alert, Dialog } from '../../design/feedback';
import { NativeSelect } from '../../design/primitives';

const NEW_PROJECT = '__new__';

export interface AddedProjectTarget {
  readonly id: string;
  readonly name: string;
}

export function AddToProjectDialog({
  open,
  clips,
  onClose,
  onAdded,
}: {
  readonly open: boolean;
  readonly clips: readonly ProjectCollectedClip[];
  readonly onClose: () => void;
  readonly onAdded: (project: AddedProjectTarget) => void;
}) {
  const projects = useProjects();
  const collections = useProjectCollections();
  const createPlan = useCreateAgentPlan();
  const [selected, setSelected] = useState(NEW_PROJECT);
  const clip = clips[0] ?? null;

  useEffect(() => {
    if (!open) return;
    setSelected(projects.data.projects[0]?.id ?? NEW_PROJECT);
    createPlan.reset();
  }, [open, projects.data.projects]);

  const confirm = () => {
    if (clip === null) return;
    void (async () => {
      if (selected === NEW_PROJECT) {
        const plan = await createPlan.mutateAsync({
          title: `${clip.matchLabel} · 新作品`,
          status: 'draft',
          shots: [],
          origin: null,
        });
        const target = { id: `plan:${plan.id}`, name: plan.title };
        for (const collected of clips) collections.add(target.id, collected);
        onAdded(target);
        onClose();
        return;
      }

      const project = projects.data.projects.find((entry) => entry.id === selected);
      if (project === undefined) return;
      for (const collected of clips) collections.add(project.id, collected);
      onAdded({ id: project.id, name: project.name });
      onClose();
    })().catch(() => undefined);
  };

  const failure = dataErrorMessage(createPlan.error);
  return (
    <Dialog
      open={open}
      title={<Trans>加入作品</Trans>}
      confirmLabel={selected === NEW_PROJECT ? <Trans>新建并加入</Trans> : <Trans>加入</Trans>}
      confirmDisabled={clips.length === 0 || projects.isPending || createPlan.isPending}
      onConfirm={confirm}
      onClose={onClose}
    >
      <p className="mb-2 text-neutral-700">
        {clip === null
          ? <Trans>选择一条片段后再加入作品。</Trans>
          : clips.length === 1 ? clip.label : <Trans>已选择 {clips.length} 个片段</Trans>}
      </p>
      <label className="flex flex-col gap-1">
        <span className="text-xs text-neutral-600"><Trans>目标作品</Trans></span>
        <NativeSelect value={selected} onChange={(event) => setSelected(event.currentTarget.value)}>
          {projects.data.projects.map((project) => (
            <option key={project.id} value={project.id}>{project.name}</option>
          ))}
          <option value={NEW_PROJECT}><Trans>＋ 新建作品</Trans></option>
        </NativeSelect>
      </label>
      {failure === null ? null : (
        <Alert className="mt-3" variant="danger" action={{ label: <Trans>重试</Trans>, onAction: confirm }}>
          <Trans>新作品没能创建：{failure}</Trans>
        </Alert>
      )}
    </Dialog>
  );
}
