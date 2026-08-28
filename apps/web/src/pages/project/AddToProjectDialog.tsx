import { Trans } from '@lingui/react/macro';
import { useEffect, useState } from 'react';

import { dataErrorMessage } from '../../data/errors';
import { useApplyProjectPatch, useCreateProject, useProjects } from '../../data/projects';
import { Alert, Dialog } from '../../design/feedback';
import { NativeSelect } from '../../design/primitives';
import { collectedClipsPatch, type ProjectCollectedClip } from '../../domain/project/collectedClip';

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
  const create = useCreateProject();
  const apply = useApplyProjectPatch();
  const [selected, setSelected] = useState(NEW_PROJECT);
  const clip = clips[0] ?? null;
  const rows = projects.data ?? [];

  useEffect(() => {
    if (!open) return;
    setSelected(rows[0]?.id ?? NEW_PROJECT);
    create.reset();
    apply.reset();
  }, [open, rows]);

  const confirm = () => {
    if (clip === null) return;
    void (async () => {
      const project = selected === NEW_PROJECT
        ? await create.mutateAsync({
          name: `${clip.matchLabel} · 新作品`,
          width: 1920,
          height: 1080,
          fps: 60,
        })
        : rows.find((entry) => entry.id === selected);
      if (project === undefined) return;
      const result = await apply.mutateAsync(collectedClipsPatch(project, clips));
      onAdded({ id: result.project.id, name: result.project.name });
      onClose();
    })().catch(() => undefined);
  };

  const failure = dataErrorMessage(create.error) ?? dataErrorMessage(apply.error);
  return (
    <Dialog
      open={open}
      title={<Trans>加入作品</Trans>}
      confirmLabel={selected === NEW_PROJECT ? <Trans>新建并加入</Trans> : <Trans>加入</Trans>}
      confirmDisabled={clips.length === 0 || projects.isPending || create.isPending || apply.isPending}
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
          {rows.map((project) => (
            <option key={project.id} value={project.id}>{project.name}</option>
          ))}
          <option value={NEW_PROJECT}><Trans>＋ 新建作品</Trans></option>
        </NativeSelect>
      </label>
      {failure === null ? null : (
        <Alert className="mt-3" variant="danger" action={{ label: <Trans>重试</Trans>, onAction: confirm }}>
          <Trans>没有把素材加入作品：{failure}</Trans>
        </Alert>
      )}
    </Dialog>
  );
}
