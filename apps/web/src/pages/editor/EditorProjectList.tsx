/*
 * pages/editor — bare `/editor`: every editor project.
 *
 * The same shape as `MontageProjectList`, with one difference that is not
 * cosmetic: **delete carries a revision.**
 *
 * `POST /editor/projects/delete-batch` takes `{ id, expected_revision }` per
 * project and refuses the ones that moved, so a project someone edited between
 * the list loading and the button being pressed is not deleted out from under
 * them. Montage has no revision and therefore no such protection; here it
 * exists and is used, which is why the delete goes through
 * `useDeleteEditorProjects` with the row's own revision rather than through a
 * single-project route.
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
  summarizeEditorProject,
  useCreateEditorProject,
  useDeleteEditorProjects,
  useEditorProjects,
  type EditorProjectSummary,
} from '../../data/editor';
import { useServiceAction } from '../../data/serviceAction';
import { formatTaskClock } from '../../domain/task';
import { RouteLink } from '../RouteLink';
import { editorHref, formatClockDuration } from './editorContract';

export function EditorProjectList() {
  const navigate = useNavigate();
  const service = useServiceAction();
  const projects = useEditorProjects();
  const create = useCreateEditorProject();
  const remove = useDeleteEditorProjects();

  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [deleting, setDeleting] = useState<EditorProjectSummary | null>(null);

  const rows = (projects.data ?? []).map(summarizeEditorProject);

  const submitCreate = () => {
    const trimmed = name.trim();
    if (trimmed === '') return;
    create.mutate(
      { name: trimmed },
      {
        onSuccess: (project) => {
          setCreating(false);
          setName('');
          void navigate(editorHref(project.id));
        },
      },
    );
  };

  const newProjectButton = (
    <Button
      variant="primary"
      size="md"
      data-editor-action="create"
      {...service.buttonProps}
      onClick={() => setCreating(true)}
    >
      <Trans>新建工程</Trans>
      {service.suffix}
    </Button>
  );

  const columns: readonly DataTableColumn<EditorProjectSummary>[] = [
    {
      id: 'name',
      header: <Trans>名称</Trans>,
      headerLabel: t`名称`,
      hideable: false,
      truncate: true,
      cell: (project) => <RouteLink to={editorHref(project.id)}>{project.name}</RouteLink>,
    },
    {
      id: 'tracks',
      header: <Trans>轨道</Trans>,
      headerLabel: t`轨道`,
      align: 'end',
      width: '80px',
      variant: 'numeric',
      cell: (project) => project.trackCount,
    },
    {
      id: 'clips',
      header: <Trans>片段</Trans>,
      headerLabel: t`片段`,
      align: 'end',
      width: '80px',
      variant: 'numeric',
      cell: (project) => project.clipCount,
    },
    {
      id: 'duration',
      header: <Trans>时长</Trans>,
      headerLabel: t`时长`,
      align: 'end',
      width: '100px',
      variant: 'numeric',
      cell: (project) => formatClockDuration(project.durationSeconds),
    },
    {
      id: 'revision',
      header: <Trans>版本</Trans>,
      headerLabel: t`版本`,
      align: 'end',
      width: '80px',
      variant: 'numeric',
      cell: (project) => project.revision,
    },
    {
      id: 'updated',
      header: <Trans>更新时间</Trans>,
      headerLabel: t`更新时间`,
      width: '160px',
      variant: 'numeric-meta',
      cell: (project) => formatTaskClock(project.updatedAt, { now: new Date() }),
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
          data-editor-action="delete"
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
          title={<Trans>多轨编辑器</Trans>}
          meta={
            projects.data === undefined ? (
              <Trans>全部工程</Trans>
            ) : (
              <Trans>全部工程 · {rows.length} 份</Trans>
            )
          }
          primary={newProjectButton}
        />
      }
    >
      <div className="flex flex-col gap-4 p-5">
        {loadError === null ? null : (
          <Notice tone="danger" action={{ label: <Trans>重试</Trans>, onAction: () => void projects.refetch() }}>
            <Trans>工程列表没能打开：{loadError}</Trans>
          </Notice>
        )}
        {writeError === null ? null : (
          <Notice tone="danger" action={{ label: <Trans>重试</Trans>, onAction: () => void projects.refetch() }}>
            <Trans>这次操作没有完成：{writeError}</Trans>
          </Notice>
        )}

        <DataTable
          caption={<Trans>编辑器工程</Trans>}
          columns={columns}
          rows={rows}
          rowId={(project) => project.id}
          rowLabel={(project) => project.name}
          loading={projects.isPending}
          skeleton={<TableSkeleton rows={4} stage={<Trans>正在读取编辑器工程</Trans>} />}
          empty={
            <EmptyState
              title={<Trans>还没有工程</Trans>}
              description={<Trans>多轨编辑器是给需要叠加、字幕与逐帧修剪的片子用的。</Trans>}
              actions={newProjectButton}
            />
          }
        />
      </div>

      <Dialog
        open={creating}
        title={<Trans>新建工程</Trans>}
        confirmLabel={<Trans>创建</Trans>}
        confirmDisabled={name.trim() === '' || create.isPending || service.blocked}
        onConfirm={submitCreate}
        onClose={() => setCreating(false)}
      >
        <Field
          label={<Trans>工程名称</Trans>}
          hint={<Trans>画布固定为 1920×1080 · 60fps，与录制输出一致。</Trans>}
        >
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
        title={<Trans>删除这份工程？</Trans>}
        confirmLabel={<Trans>删除</Trans>}
        confirmDisabled={remove.isPending}
        onConfirm={() => {
          if (deleting === null) return;
          remove.mutate([{ id: deleting.id, revision: deleting.revision }], {
            onSettled: () => setDeleting(null),
          });
        }}
        onClose={() => setDeleting(null)}
      >
        <Trans>
          「{deleting?.name}」及其 {deleting?.clipCount ?? 0} 个片段会被删除。素材本身不受影响。
        </Trans>
      </Dialog>
    </Page>
  );
}
