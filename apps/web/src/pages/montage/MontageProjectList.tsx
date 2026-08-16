/*
 * pages/montage — bare `/montage`: every montage project, and the two things
 * you can do to the set of them.
 *
 * §7 makes `:projectId` optional, and the artboard only draws the loaded
 * workspace, so this half is derived from the rule the other pages follow
 * (「02 Demo 资料库」, 「11 输出与任务记录」): a table of the things, an empty
 * state whose primary action creates one, and destruction behind a Dialog.
 *
 * The 时长 column is the same computation the header uses — `montageTimeline`
 * over the recorded-take lengths — and it prints 「时长待定」 rather than a
 * total that is missing a clip, for the reason contract gap 4 gives. One read
 * of `useRecordedClips` serves every row.
 */

import { t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { DataTable, EmptyState, TableSkeleton, type DataTableColumn } from '../../design/data';
import { Dialog, Notice } from '../../design/feedback';
import { Page, Toolbar } from '../../design/layout';
import { Button, Field, TextInput } from '../../design/primitives';
import { dataErrorMessage } from '../../data/errors';
import {
  useCreateMontageProject,
  useDeleteMontageProject,
  useMontageProjects,
} from '../../data/montage';
import { useRecordedClips } from '../../data/outputs';
import { useServiceAction } from '../../data/serviceAction';
import { formatTaskClock } from '../../domain/task';
import type { MontageProjectRecord } from '../../shared/desktop/dto';
import { RouteLink } from '../RouteLink';
import { splitMinutesSeconds } from './montageClock';
import { montageHref, montageTimeline, type ClipDurationLookup } from './montageContract';
import { defaultMontageSettings } from './montageSettings';

export function MontageProjectList() {
  const navigate = useNavigate();
  const service = useServiceAction();
  const projects = useMontageProjects();
  const takes = useRecordedClips();
  const create = useCreateMontageProject();
  const remove = useDeleteMontageProject();

  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [deleting, setDeleting] = useState<MontageProjectRecord | null>(null);

  const durations: ClipDurationLookup = Object.fromEntries(
    (takes.data?.items ?? []).map((take) => [take.id, take.duration_seconds]),
  );

  const rows = projects.data?.items ?? [];

  const submitCreate = () => {
    const trimmed = name.trim();
    if (trimmed === '') return;
    create.mutate(
      { name: trimmed, clips: [], settings: defaultMontageSettings() },
      {
        onSuccess: (project) => {
          setCreating(false);
          setName('');
          void navigate(montageHref(project.id));
        },
      },
    );
  };

  const newProjectButton = (
    <Button
      variant="primary"
      size="md"
      data-montage-action="create"
      {...service.buttonProps}
      onClick={() => setCreating(true)}
    >
      <Trans>新建合辑</Trans>
      {service.suffix}
    </Button>
  );

  const columns: readonly DataTableColumn<MontageProjectRecord>[] = [
    {
      id: 'name',
      header: <Trans>名称</Trans>,
      headerLabel: t`名称`,
      hideable: false,
      truncate: true,
      cell: (project) => <RouteLink to={montageHref(project.id)}>{project.name}</RouteLink>,
    },
    {
      id: 'clips',
      header: <Trans>片段</Trans>,
      headerLabel: t`片段`,
      align: 'end',
      width: '88px',
      variant: 'numeric',
      cell: (project) => project.clips.length,
    },
    {
      id: 'duration',
      header: <Trans>时长</Trans>,
      headerLabel: t`时长`,
      align: 'end',
      width: '120px',
      variant: 'numeric',
      cell: (project) => <ProjectDuration project={project} durations={durations} />,
    },
    {
      id: 'updated',
      header: <Trans>更新时间</Trans>,
      headerLabel: t`更新时间`,
      width: '160px',
      variant: 'numeric-meta',
      cell: (project) => formatTaskClock(project.updated_at, { now: new Date() }),
    },
    {
      id: 'actions',
      headerLabel: t`操作`,
      align: 'end',
      width: '96px',
      hideable: false,
      cell: (project) => (
        <Button
          size="sm"
          variant="ghost"
          data-montage-action="delete"
          {...service.buttonProps}
          onClick={() => setDeleting(project)}
        >
          <Trans>删除</Trans>
        </Button>
      ),
    },
  ];

  const loadError = dataErrorMessage(projects.error);
  const writeError = dataErrorMessage(create.error) ?? dataErrorMessage(remove.error);

  return (
    <Page
      toolbar={
        <Toolbar
          title={<Trans>快速合辑</Trans>}
          meta={
            projects.data === undefined ? (
              <Trans>全部合辑</Trans>
            ) : (
              <Trans>全部合辑 · {rows.length} 份工程</Trans>
            )
          }
          primary={newProjectButton}
        />
      }
    >
      <div className="flex flex-col gap-4 p-5">
        {loadError === null ? null : (
          <Notice
            tone="danger"
            action={{ label: <Trans>重试</Trans>, onAction: () => void projects.refetch() }}
          >
            <Trans>合辑列表没能打开：{loadError}</Trans>
          </Notice>
        )}
        {writeError === null ? null : (
          <Notice
            tone="danger"
            action={{ label: <Trans>重试</Trans>, onAction: () => void projects.refetch() }}
          >
            <Trans>这次操作没有完成：{writeError}</Trans>
          </Notice>
        )}

        <DataTable
          caption={<Trans>合辑工程</Trans>}
          columns={columns}
          rows={rows}
          rowId={(project) => project.id}
          rowLabel={(project) => project.name}
          loading={projects.isPending}
          skeleton={<TableSkeleton rows={4} stage={<Trans>正在读取合辑工程</Trans>} />}
          empty={
            <EmptyState
              title={<Trans>还没有合辑</Trans>}
              description={
                <Trans>把录制结果串成一条视频，不进多轨编辑器也能直接导出。</Trans>
              }
              actions={newProjectButton}
            />
          }
        />
      </div>

      <Dialog
        open={creating}
        title={<Trans>新建合辑</Trans>}
        confirmLabel={<Trans>创建</Trans>}
        confirmDisabled={name.trim() === '' || create.isPending || service.blocked}
        onConfirm={submitCreate}
        onClose={() => setCreating(false)}
      >
        <Field label={<Trans>工程名称</Trans>} hint={<Trans>之后可以在工程里改。</Trans>}>
          {(control) => (
            <TextInput
              {...control}
              value={name}
              autoFocus
              maxLength={200}
              onChange={(event) => setName(event.target.value)}
            />
          )}
        </Field>
      </Dialog>

      <Dialog
        open={deleting !== null}
        tone="destructive"
        title={<Trans>删除这份合辑？</Trans>}
        confirmLabel={<Trans>删除</Trans>}
        confirmDisabled={remove.isPending || service.blocked}
        onConfirm={() => {
          const target = deleting;
          if (target === null) return;
          remove.mutate(target.id, { onSuccess: () => setDeleting(null) });
        }}
        onClose={() => setDeleting(null)}
      >
        <p className="leading-normal">
          <Trans>
            工程与它的片段顺序会被删除。录制结果本身留在输出里，磁盘上的文件不会被删除。
          </Trans>
        </p>
        {deleting === null ? null : (
          <p className="mt-2 text-xs text-neutral-700">{deleting.name}</p>
        )}
      </Dialog>
    </Page>
  );
}

function ProjectDuration({
  project,
  durations,
}: {
  readonly project: MontageProjectRecord;
  readonly durations: ClipDurationLookup;
}) {
  const total = montageTimeline(project, durations).totalSeconds;
  const spans = total === null ? null : splitMinutesSeconds(total);
  if (spans === null) {
    return (
      <span className="text-neutral-600">
        <Trans>待定</Trans>
      </span>
    );
  }
  return (
    <Trans>
      {spans.minutes} 分 {spans.seconds} 秒
    </Trans>
  );
}
