import { Trans } from '@lingui/react/macro';
import { useEffect, useState } from 'react';

import { dataErrorMessage } from '../../data/errors';
import { useApplyProjectPatch, useCreateProject, useProjects } from '../../data/projects';
import { Alert, Dialog } from '../../design/feedback';
import { NativeSelect } from '../../design/primitives';
import { formatMillisecondTimecode } from '../../design/timeline';
import { CAPTURE_POST_ROLL_SECONDS, CAPTURE_PRE_ROLL_SECONDS, collectedClipRange, collectedClipsPatch, collectedClipsStart, type ProjectCollectedClip } from '../../domain/project/collectedClip';

const NEW_PROJECT = '__new__';

export interface AddedProjectTarget {
  readonly id: string;
  readonly name: string;
}

export function AddToProjectDialog({
  open,
  clips,
  preferredProjectId,
  onClose,
  onAdded,
}: {
  readonly open: boolean;
  readonly clips: readonly ProjectCollectedClip[];
  readonly preferredProjectId?: string | null | undefined;
  readonly onClose: () => void;
  readonly onAdded: (project: AddedProjectTarget) => void;
}) {
  const projects = useProjects();
  const create = useCreateProject();
  const apply = useApplyProjectPatch();
  const [selected, setSelected] = useState<string | null>(null);
  const clip = clips[0] ?? null;
  const rows = projects.data ?? [];

  useEffect(() => {
    if (!open) return;
    setSelected(null);
    create.reset();
    apply.reset();
  }, [open]);

  useEffect(() => {
    if (!open || selected !== null || projects.isPending) return;
    setSelected(rows.some((project) => project.id === preferredProjectId)
      ? preferredProjectId ?? NEW_PROJECT : rows[0]?.id ?? NEW_PROJECT);
  }, [open, selected, preferredProjectId, projects.isPending, rows]);

  const busy = create.isPending || apply.isPending;
  const invalidRange = clips.some((entry) => entry.startTick !== null && entry.endTick !== null && entry.endTick <= entry.startTick);
  const target = rows.find((entry) => entry.id === selected);
  const start = target === undefined ? 0 : collectedClipsStart(target);
  const knownDuration = clips.every((entry) => entry.durationSeconds !== null);
  const duration = clips.reduce((total, entry) => total + (entry.durationSeconds ?? 0), 0);
  const range = clip === null ? null : collectedClipRange(clip);

  const confirm = () => {
    if (clip === null || selected === null || invalidRange || busy) return;
    void (async () => {
      const project = selected === NEW_PROJECT
        ? create.data ?? await create.mutateAsync({
          name: `${clip.matchLabel} · 新作品`,
          width: 1920,
          height: 1080,
          fps: 60,
          source_demo_ids: [...new Set(clips.map((entry) => entry.demoId))],
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
      className="w-[var(--w-overlay)]"
      confirmLabel={selected === NEW_PROJECT ? <Trans>新建并加入</Trans> : <Trans>加入 Story 末尾</Trans>}
      confirmDisabled={clips.length === 0 || selected === null || projects.isPending || projects.isError || invalidRange || busy}
      onConfirm={confirm}
      onClose={() => { if (!busy) onClose(); }}
    >
      <p className="mb-3 break-words text-neutral-700">
        {clip === null
          ? <Trans>选择一条片段后再加入作品。</Trans>
          : clips.length === 1 ? clip.label : <Trans>已选择 {clips.length} 个片段</Trans>}
      </p>
      {clip === null ? null : (
        <dl className="mb-3 grid grid-cols-[7rem_minmax(0,1fr)] border border-divider bg-surface-chrome [&>dt]:border-b [&>dt]:border-divider [&>dt]:px-2 [&>dt]:py-2 [&>dt]:text-xs [&>dt]:text-neutral-600 [&>dd]:min-w-0 [&>dd]:break-words [&>dd]:border-b [&>dd]:border-divider [&>dd]:px-2 [&>dd]:py-2">
          <dt><Trans>来源</Trans></dt><dd>{clip.matchLabel}{clip.round === null ? null : <> · <Trans>第 {clip.round} 回合</Trans></>}{clip.playerName === null ? null : <> · {clip.playerName} (POV)</>}</dd>
          <dt><Trans>事件范围</Trans></dt><dd>{range === null ? <Trans>待解析</Trans> : <>{formatMillisecondTimecode(range.start)}–{formatMillisecondTimecode(range.end)} · {(range.end - range.start).toFixed(2)}s</>}</dd>
          <dt><Trans>录制范围</Trans></dt><dd>{range === null ? <Trans>待范围有效后计算</Trans> : <>{formatMillisecondTimecode(range.recordingStart)}–{formatMillisecondTimecode(range.recordingEnd)} · {(range.recordingEnd - range.recordingStart).toFixed(2)}s</>}</dd>
        </dl>
      )}
      {range === null ? null : <p className="mb-4 text-xs text-neutral-600"><Trans>保留事件前 {CAPTURE_PRE_ROLL_SECONDS} 秒、后 {CAPTURE_POST_ROLL_SECONDS} 秒；录制范围会按 Demo 边界裁剪。</Trans></p>}
      {clips.length < 2 ? null : <ul className="mb-4 max-h-40 overflow-y-auto text-sm">{clips.map((entry) => <li key={entry.id} className="border-b border-divider py-2">{entry.label} · {entry.durationSeconds === null ? <Trans>时长待解析</Trans> : `${entry.durationSeconds.toFixed(2)}s`}</li>)}</ul>}
      {invalidRange ? <Alert className="mb-4" variant="danger" action={{ label: <Trans>调整范围</Trans>, onAction: onClose }}><Trans>出点必须晚于入点。请取消并调整选材范围，作品尚未修改。</Trans></Alert> : null}
      <label className="flex flex-col gap-2">
        <span className="text-xs text-neutral-600"><Trans>目标作品</Trans></span>
        <NativeSelect value={selected ?? ''} disabled={busy || projects.isPending} onChange={(event) => setSelected(event.currentTarget.value)}>
          {rows.map((project) => (
            <option key={project.id} value={project.id}>{project.name}</option>
          ))}
          <option value={NEW_PROJECT}><Trans>＋ 新建作品</Trans></option>
        </NativeSelect>
      </label>
      {target === undefined ? null : <p className="mt-2 break-words text-sm text-neutral-700">{target.name}</p>}
      <dl className="my-4 grid grid-cols-[7rem_minmax(0,1fr)] gap-y-3 text-sm">
        <dt className="text-neutral-600"><Trans>加入位置</Trans></dt><dd>Story · {formatMillisecondTimecode(start)}</dd>
        <dt className="text-neutral-600"><Trans>加入后时长</Trans></dt><dd>{!knownDuration || invalidRange ? <Trans>待范围有效后计算</Trans> : formatMillisecondTimecode(Math.max(target?.document.duration_seconds ?? 0, start + duration))}</dd>
      </dl>
      <p className="text-xs text-warn-text"><Trans>加入后为待录制片段；录制完成后才能导出。</Trans></p>
      {projects.isError ? <Alert className="mt-3" variant="danger" action={{ label: <Trans>重新加载</Trans>, onAction: () => void projects.refetch() }}><Trans>无法读取目标作品。</Trans></Alert> : null}
      {failure === null ? null : (
        <Alert className="mt-3" variant="danger" action={{ label: <Trans>重试</Trans>, onAction: confirm }}>
          <Trans>没有把素材加入作品：{failure}</Trans>
        </Alert>
      )}
    </Dialog>
  );
}
