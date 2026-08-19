/*
 * pages/ — 09 快速合辑 (spec §7 `/montage/:projectId?`, phase 3f).
 *
 * Two addresses, one page:
 *
 *   `/montage`              the project list plus 「新建合辑」
 *   `/montage/<projectId>`  the artboard proper — 片段顺序, 配乐与节拍, 包装,
 *                           导出, and the header that carries 「生成视频」
 *
 * ── What this file owns, and why it is this file ──────────────────────────
 *
 * `pages/montage/montageContract.ts` states the four invariants; this is the
 * shell they are enforced by, so they are worth restating as *properties of
 * this component*:
 *
 *   **One `useMontageProject`.** Four blocks each reading the document would
 *   deduplicate the fetch and multiply the writes — and the writes are the
 *   problem, because `PUT /api/montage/projects/{id}` replaces the whole
 *   document and has no revision (gap 1).
 *
 *   **One `save`, and it is read-modify-write.** Blocks hand up an edit
 *   *function*; `saveMontageProject` re-reads the document from the service,
 *   applies the function to that, and PUTs the result. 包装 changing a theme
 *   and 顺序 moving a clip therefore compose instead of clobbering. The shell
 *   supplies `baseUpdatedAt` from what it last read, so a block cannot forget
 *   it, and a save that lost the race comes back as a
 *   `MontageWriteConflictError` carrying the fresh document — rendered as
 *   「这份工程在别处被改过」 with 重新载入, never as a silent overwrite.
 *
 *   **One 「生成视频」.** The artboard draws it twice, in the top bar and at the
 *   foot of 导出. They are the same `MontageExportDesk`: one guard, one
 *   `run()`, one navigation. 3e's lesson was that an action implemented once
 *   per column ends up with one live copy and one that only looks pressed.
 *
 *   **One selection.** The strip, the beat table and the trim drawer highlight
 *   the same clip. Two `useState`s would be two selections on one screen.
 *
 * ── Why every control writes through immediately ──────────────────────────
 *
 * There is no 保存 button and no dirty buffer. Contract gap 8: the export route
 * takes no options and renders from the *stored* settings, so an unsaved 画质
 * 策略 would silently not be in the video. Writing through on every change
 * means 「生成视频」 never has to reconcile a buffer — it only has to wait for
 * an in-flight save, which is what `saving` disables it for.
 */

import { t } from '@lingui/core/macro';
import { useLingui } from '@lingui/react';
import { Trans } from '@lingui/react/macro';
import { useCallback, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';

import { Skeleton } from '../design/data';
import { Alert } from '../design/feedback';
import { Inspector, Page, Toolbar, useShellCollapsed } from '../design/layout';
import { Button } from '../design/primitives';
import { dataErrorMessage } from '../data/errors';
import {
  isMontageWriteConflict,
  useExportMontageProject,
  useMontageProject,
  useSaveMontageProject,
  type MontageEditFn,
} from '../data/montage';
import { useRecordedClips } from '../data/outputs';
import { useServiceAction } from '../data/serviceAction';
import type { MontageProjectRecord } from '../shared/desktop/dto';
import { ClipOrderBlock } from './montage/ClipOrderBlock';
import { ExportBlock } from './montage/ExportBlock';
import { MontageProjectList } from './montage/MontageProjectList';
import { MusicBeatBlock } from './montage/MusicBeatBlock';
import { PackagingBlock } from './montage/PackagingBlock';
import { readSaveStamp, splitMinutesSeconds } from './montage/montageClock';
import {
  montageExportTaskHref,
  montageHref,
  montageTimeline,
  type ClipDurationLookup,
  type MontageBlockProps,
  type MontageExportDesk,
  type MontageProjectDesk,
} from './montage/montageContract';
import { montageRenderPlan, MONTAGE_EXPORT_BLOCKER_REASON } from './montage/montageSettings';
import { RouteLink } from './RouteLink';

export function MontagePage() {
  const { projectId } = useParams<{ projectId?: string }>();
  /* A key, so switching projects rebuilds the workspace rather than carrying
     the previous project's selection and preview into the next one. */
  return projectId === undefined ? (
    <MontageProjectList />
  ) : (
    <MontageWorkspace key={projectId} projectId={projectId} />
  );
}

/* ── the workspace ───────────────────────────────────────────────────────── */

function MontageWorkspace({ projectId }: { readonly projectId: string }) {
  const navigate = useNavigate();
  const { i18n } = useLingui();
  const service = useServiceAction();
  const collapsed = useShellCollapsed();

  const query = useMontageProject(projectId);
  const takes = useRecordedClips();
  const save = useSaveMontageProject();
  const exportProject = useExportMontageProject();

  const [selectedClipId, setSelectedClipId] = useState<string | null>(null);
  const [conflict, setConflict] = useState<MontageProjectRecord | null>(null);

  const project = query.data ?? null;
  const baseUpdatedAt = project?.updated_at;

  /* Source lengths by clip id (contract gap 4: a montage clip carries trim
     points and no length of its own). Empty until the take list lands, which is
     why the timeline answers `null` rather than zero in the meantime. */
  const clipDurations = useMemo<ClipDurationLookup>(() => {
    const lookup: Record<string, number> = {};
    for (const take of takes.data?.items ?? []) lookup[take.id] = take.duration_seconds;
    return lookup;
  }, [takes.data]);

  const runSave = useCallback(
    (edit: MontageEditFn) => {
      setConflict(null);
      save.mutate(
        { projectId, edit, ...(baseUpdatedAt === undefined ? {} : { baseUpdatedAt }) },
        {
          onError: (error) => {
            if (isMontageWriteConflict(error)) setConflict(error.current);
          },
        },
      );
    },
    [baseUpdatedAt, projectId, save],
  );

  const desk: MontageProjectDesk = {
    project,
    loading: query.isPending,
    error: query.error,
    saving: save.isPending,
    conflict,
    save: runSave,
    clipDurations,
  };

  const plan = project === null ? null : montageRenderPlan(project, clipDurations);
  const blocker = plan?.blockers[0];
  const exportDisabledReason =
    service.buttonProps.disabledReason ??
    (blocker === undefined ? undefined : i18n._(MONTAGE_EXPORT_BLOCKER_REASON[blocker]));

  const exportDesk: MontageExportDesk = {
    action: {
      disabled:
        service.blocked ||
        project === null ||
        save.isPending ||
        exportProject.isPending ||
        (plan?.blockers.length ?? 0) > 0,
      ...(exportDisabledReason === undefined ? {} : { disabledReason: exportDisabledReason }),
    },
    running: exportProject.isPending,
    error: exportProject.error,
    /* The service names the file itself — `montage-{project}-{job}.mp4` under
       `<data_dir>/exports` (`crates/runtime/src/export.rs`) — and the job half
       does not exist until the job is accepted. So there is no name to print
       before the fact, and 導出 prints the rule instead of a placeholder. */
    outputName: null,
    run: () => {
      exportProject.mutate(projectId, {
        onSuccess: (job) => {
          void navigate(montageExportTaskHref(job.job_id));
        },
      });
    },
  };

  const blockProps: Omit<MontageBlockProps, never> = {
    projectId,
    project: desk,
    selection: { clipId: selectedClipId, select: setSelectedClipId },
    export: exportDesk,
    service,
    collapsed,
  };

  const timeline = project === null ? null : montageTimeline(project, clipDurations);
  const total = timeline?.totalSeconds ?? null;
  const spans = total === null ? null : splitMinutesSeconds(total);
  const stamp = project === null ? null : readSaveStamp(project.updated_at, new Date());

  const exportButton = (
    <Button
      variant="primary"
      size="md"
      data-montage-export="toolbar"
      disabled={exportDesk.action.disabled}
      {...(exportDesk.action.disabledReason === undefined
        ? {}
        : { disabledReason: exportDesk.action.disabledReason })}
      onClick={exportDesk.run}
    >
      <Trans>生成视频</Trans>
      {service.suffix}
    </Button>
  );

  return (
    <Page
      scroll={false}
      toolbar={
        <Toolbar
          leading={
            <RouteLink to={montageHref(null)} size="sm">
              <Trans>全部作品</Trans>
            </RouteLink>
          }
          title={project?.name ?? <Skeleton width="180px" />}
          meta={
            /* Until the document lands the id is all the page knows, and it is
               worth printing: a deep link that fails to open should say which
               project it was trying to open. */
            project === null ? (
              <span className="font-mono text-xs">{projectId}</span>
            ) : (
              <span className="flex flex-wrap items-center gap-x-1.5">
                <Trans>{project.clips.length} 段素材</Trans>
                {spans === null ? (
                  <Trans>· 时长待定</Trans>
                ) : (
                  <Trans>
                    · {spans.minutes} 分 {spans.seconds} 秒
                  </Trans>
                )}
                {stamp === null ? null : stamp.kind === 'now' ? (
                  <Trans>· 刚刚保存</Trans>
                ) : stamp.kind === 'minutes' ? (
                  <Trans>· 上次保存 {stamp.value} 分钟前</Trans>
                ) : stamp.kind === 'hours' ? (
                  <Trans>· 上次保存 {stamp.value} 小时前</Trans>
                ) : (
                  <Trans>· 上次保存 {stamp.text}</Trans>
                )}
              </span>
            )
          }
          actions={[
            {
              id: 'editor',
              label: <Trans>在多轨编辑器中打开</Trans>,
              disabled: true,
              control: (
                <Button
                  size="md"
                  disabled
                  data-montage-action="editor"
                  /*
                   * Verified against the routes, not assumed: `/api/montage/…`
                   * and `/api/editor/…` are two tables with two shapes
                   * (`MontageProjectRecord` has clips and no revision;
                   * `EditorProject` has tracks and a revision), and
                   * `crates/application/src/routes/media.rs` registers **no**
                   * route that turns one into the other. Navigating to
                   * `/editor/<montage id>` would 404 on an id that belongs to a
                   * different table. Disabled with the reason written on it,
                   * and recorded as a backend gap.
                   */
                  disabledReason={t`快速合辑和多轨工程是两种工程，暂时不能互相转换`}
                >
                  <Trans>在多轨编辑器中打开</Trans>
                </Button>
              ),
            },
          ]}
          primary={exportButton}
        />
      }
    >
      <div data-montage-workspace="" className="flex min-h-0 flex-1 flex-col lg:flex-row">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-4 overflow-y-auto p-5">
          <WorkspaceNotices
            desk={desk}
            onReload={() => {
              setConflict(null);
              void query.refetch();
            }}
            saveError={save.error}
            exportError={exportProject.error}
          />
          <ClipOrderBlock {...blockProps} />
          <MusicBeatBlock {...blockProps} />
        </div>

        <Inspector title={<Trans>包装与导出</Trans>} label={t`包装与导出`} footer={<ExportFooter {...blockProps} />}>
          <div className="flex flex-col">
            <PackagingBlock {...blockProps} />
            <ExportBlock {...blockProps} />
          </div>
        </Inspector>
      </div>
    </Page>
  );
}

/**
 * The second rendering of the one 「生成视频」 — the artboard's full-width
 * button at the foot of 导出. Same desk, same guard, same `run`.
 */
function ExportFooter({ export: desk, service }: MontageBlockProps) {
  return (
    <Button
      variant="primary"
      size="lg"
      block
      data-montage-export="panel"
      disabled={desk.action.disabled}
      {...(desk.action.disabledReason === undefined
        ? {}
        : { disabledReason: desk.action.disabledReason })}
      onClick={desk.run}
    >
      <Trans>生成视频</Trans>
      {service.suffix}
    </Button>
  );
}

/**
 * The three things that can go wrong around the document itself, in place and
 * each with a way out. A block never renders these: a save is the shell's, so
 * its failure is too.
 */
function WorkspaceNotices({
  desk,
  onReload,
  saveError,
  exportError,
}: {
  readonly desk: MontageProjectDesk;
  readonly onReload: () => void;
  readonly saveError: unknown;
  readonly exportError: unknown;
}) {
  const conflictOpen = desk.conflict !== null;
  const saveMessage = conflictOpen ? null : dataErrorMessage(saveError);
  const exportMessage = dataErrorMessage(exportError);
  const loadMessage = dataErrorMessage(desk.error);

  return (
    <>
      {desk.error === null || desk.error === undefined ? null : (
        <Alert
          variant="danger"
          action={{ label: <Trans>重试</Trans>, onAction: onReload }}
          detail={<Trans>工程没有被改动，重试是安全的。</Trans>}
        >
          <Trans>这份合辑没能打开：{loadMessage ?? ''}</Trans>
        </Alert>
      )}

      {conflictOpen ? (
        <Alert
          variant="warning"
          action={{ label: <Trans>重新载入</Trans>, onAction: onReload }}
          detail={
            <Trans>
              这份合辑在别处被改过了。为避免覆盖那次改动，这次没有保存——请刷新后重做。
            </Trans>
          }
        >
          <Trans>这份工程在别处被改过，刚才的改动没有保存。</Trans>
        </Alert>
      ) : null}

      {saveMessage === null ? null : (
        <Alert variant="danger" action={{ label: <Trans>重新载入</Trans>, onAction: onReload }}>
          <Trans>改动没有保存：{saveMessage}</Trans>
        </Alert>
      )}

      {exportMessage === null ? null : (
        <Alert variant="danger" action={{ label: <Trans>重新载入</Trans>, onAction: onReload }}>
          <Trans>没能开始生成视频：{exportMessage}</Trans>
        </Alert>
      )}
    </>
  );
}
