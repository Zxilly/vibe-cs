/*
 * pages/ — 10 多轨编辑器 (spec §7 `/editor/:projectId?`, phase 3f-2).
 *
 * Two addresses, one page:
 *
 *   `/editor`              every project, plus 新建工程
 *   `/editor/<projectId>`  the artboard: 素材库 · 节目监看 · 时间轴 · 属性
 *
 * Replaces the pre-redesign `/studio/editor`; the old address redirects here.
 *
 * ══════════════════════════════════════════════════════════════════════════
 *  The three decisions this shell exists to make
 * ══════════════════════════════════════════════════════════════════════════
 *
 * ## 1. The document is local while it is being edited
 *
 * `useEditorProject` fetches once and then stops (`staleTime: Infinity`,
 * `refetchOnWindowFocus: false`). `EditorWorkspace` turns that response into an
 * `EditorDocument` and a `useTimelineEditor`, and from then on **the local
 * timeline is the truth** until a save replaces it.
 *
 * That is not laziness about freshness. A background refetch here does not
 * refresh a list — it throws away an in-progress edit. The artboard's
 * 「已保存 · 版本 24」 is a claim about a document the user is holding, and a
 * page that silently swapped it while they dragged would make that claim false
 * at the worst possible moment.
 *
 * ## 2. There *is* a save button, and the artboard does not draw one
 *
 * This is a deliberate departure, recorded rather than smuggled in. 「09 快速
 * 合辑」 writes through on every control because its export renders from the
 * *stored* document and a montage project has no revision to conflict on. An
 * editor project has both a revision and a 409, and a timeline edit is a
 * gesture — a drag writes through at 60 saves per second or it does not write
 * through at all.
 *
 * So: an explicit 保存, a header that says which of 已保存 / 未保存 / 保存中 it
 * is in, and 「有未保存的改动」 on the actions that would lose them (restore,
 * apply preset — both of which replace the document server-side).
 *
 * ## 3. A conflict is surfaced, never merged
 *
 * `data/editor.ts` explains why at length: merging a timeline that moved
 * underneath you is a guess, and an invisible one. The page offers 重新载入,
 * which is destructive to local edits and says so.
 *
 * ── the reload token ──────────────────────────────────────────────────────
 *
 * `EditorWorkspace` is keyed on `${projectId}:${reloadToken}`. The token moves
 * only when the *document structure* is replaced from outside — a snapshot
 * restore, a preset application, an audio separation, an explicit reload. A
 * plain save does **not** move it: the local timeline is already what was
 * saved, and remounting would throw away the undo stack and the selection for
 * nothing.
 */

import { t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';

import { Skeleton } from '../design/data';
import { Notice } from '../design/feedback';
import { Page, Toolbar } from '../design/layout';
import { Button } from '../design/primitives';
import { useTimelineEditor, createTimeline, type Timeline } from '../design/timeline';
import { dataErrorMessage } from '../data/errors';
import {
  isRevisionConflict,
  useApplyEditorPreset,
  useEditorPresets,
  useEditorProject,
  useEditorSnapshots,
  useExportEditorPackage,
  useExportEditorProject,
  useRestoreEditorSnapshot,
  useSaveEditorProject,
  useSeparateEditorAudio,
} from '../data/editor';
import { useImportMediaAsset, useMediaAssets } from '../data/mediaAssets';
import { useServiceAction } from '../data/serviceAction';
import type { MediaAsset } from '../shared/desktop/dto';
import { EditorProjectList } from './editor/EditorProjectList';
import { EditorTimelinePanel } from './editor/EditorTimelinePanel';
import { InspectorPanel } from './editor/InspectorPanel';
import { MediaLibraryPanel } from './editor/MediaLibraryPanel';
import { ProgramMonitor } from './editor/ProgramMonitor';
import { VersionHistoryPanel } from './editor/VersionHistoryPanel';
import {
  canvasSummary,
  type EditorDesk,
  type SaveState,
} from './editor/editorContract';
import {
  droppedKeyframeCount,
  hasUnsavedChanges,
  insertAssetClip,
  toEditorDocument,
  toEditorProject,
  type EditorDocument,
} from './editor/editorDocument';
import { mintUuid } from './editor/editorIds';

export function EditorPage() {
  const { projectId } = useParams<{ projectId?: string }>();
  return projectId === undefined ? <EditorProjectList /> : <EditorLoader projectId={projectId} />;
}

/* ── loading ─────────────────────────────────────────────────────────────── */

function EditorLoader({ projectId }: { readonly projectId: string }) {
  const project = useEditorProject(projectId);
  const assets = useMediaAssets(projectId);
  /* Read here and not only in the workspace: a project that will not open is
     most often a service that is not up, and 「读取失败」 without that sentence
     sends the user looking for a corrupt file. */
  const service = useServiceAction();
  const [reloadToken, setReloadToken] = useState(0);

  const loadError = dataErrorMessage(project.error);

  if (loadError !== null) {
    return (
      <Page scroll={false} toolbar={<Toolbar title={<Trans>多轨编辑器</Trans>} meta={projectId} />}>
        <div className="p-5">
          <Notice tone="danger" action={{ label: <Trans>重试</Trans>, onAction: () => void project.refetch() }}>
            {service.blocked ? (
              <Trans>本地服务没有连接，这个工程读不出来。服务恢复后无需刷新页面。</Trans>
            ) : (
              <Trans>这个工程没能打开：{loadError}</Trans>
            )}
          </Notice>
        </div>
      </Page>
    );
  }

  if (project.data === undefined) {
    return (
      <Page scroll={false} toolbar={<Toolbar title={<Trans>多轨编辑器</Trans>} meta={projectId} />}>
        <div className="flex flex-col gap-4 p-5">
          <Skeleton className="h-8 w-64" />
          <Skeleton className="h-64" />
        </div>
      </Page>
    );
  }

  return (
    <EditorWorkspace
      key={`${projectId}:${String(reloadToken)}`}
      projectId={projectId}
      assets={assets.data?.items ?? []}
      assetsLoading={assets.isPending}
      onReload={() => setReloadToken((token) => token + 1)}
    />
  );
}

/* ── the workspace ───────────────────────────────────────────────────────── */

const EMPTY_TIMELINE: Timeline = createTimeline({ tracks: [], clips: [] });

interface WorkspaceProps {
  readonly projectId: string;
  readonly assets: readonly MediaAsset[];
  readonly assetsLoading: boolean;
  readonly onReload: () => void;
}

function EditorWorkspace({ projectId, assets, assetsLoading, onReload }: WorkspaceProps) {
  const service = useServiceAction();
  const query = useEditorProject(projectId);
  const snapshots = useEditorSnapshots(projectId);
  const presets = useEditorPresets();
  const save = useSaveEditorProject();
  const applyPreset = useApplyEditorPreset();
  const separateAudio = useSeparateEditorAudio();
  const restore = useRestoreEditorSnapshot();
  const exportVideo = useExportEditorProject();
  const exportPackage = useExportEditorPackage();
  const importAsset = useImportMediaAsset();

  /* The project as it was when this workspace mounted. The remount key means
     this is stable for the life of the component — which is what makes it a
     usable baseline for `hasUnsavedChanges`. The *live* envelope, with the
     revision a save must send, is `query.data`. */
  const [baseline] = useState(() => query.data ?? null);

  const assetsById = useMemo(() => new Map(assets.map((asset) => [asset.id, asset])), [assets]);

  /* The shadow. Rebuilt only when the asset list first arrives — the source
     lengths come from it, and a clip loaded before its asset would report no
     headroom for the rest of the session. */
  const [document, setDocument] = useState<EditorDocument | null>(() =>
    baseline === null ? null : toEditorDocument(baseline, { assets: assetsById }),
  );
  const [assetsJoined, setAssetsJoined] = useState(assets.length > 0);
  useEffect(() => {
    if (assetsJoined || assets.length === 0 || baseline === null) return;
    setAssetsJoined(true);
    setDocument((current) =>
      current === null ? toEditorDocument(baseline, { assets: assetsById }) : current,
    );
  }, [assets.length, assetsById, assetsJoined, baseline]);

  const editor = useTimelineEditor({ initial: document?.timeline ?? EMPTY_TIMELINE });

  const [conflict, setConflict] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  /* The document as it stands: the shadow plus whatever the editor has done to
     the timeline. Rebuilt on every render rather than stored, because the
     timeline lives inside the hook and storing a copy here would be two
     sources of truth for one edit. */
  const live: EditorDocument | null =
    document === null ? null : { ...document, timeline: editor.timeline };

  const dirty = live !== null && baseline !== null && hasUnsavedChanges(live, baseline);
  const saveState: SaveState = save.isPending ? 'saving' : dirty ? 'unsaved' : 'saved';

  const runSave = useCallback(() => {
    if (live === null || query.data === undefined) return;
    setConflict(false);
    // The revision comes from the *live* envelope, not from the baseline: a
    // second save in one session must send the number the first one produced.
    const next = toEditorProject({ ...live, project: query.data }, mintUuid);
    save.mutate(next, {
      onError: (error) => {
        if (isRevisionConflict(error)) setConflict(true);
      },
    });
  }, [live, query.data, save]);

  const desk: EditorDesk = {
    projectId,
    project: query.data ?? null,
    document: live,
    editor,
    assets,
    presets: presets.data ?? [],
    saveState,
    loading: assetsLoading || snapshots.isPending,
    conflict,
    save: runSave,
    reload: onReload,
    importing: importAsset.isPending,
    addAssetToTimeline: (assetId) => {
      const asset = assetsById.get(assetId);
      if (asset === undefined || document === null) return;
      const result = insertAssetClip({ ...document, timeline: editor.timeline }, asset, mintUuid);
      if (result.clipId === null) {
        setNotice(
          result.reason === 'no-duration'
            ? t`还没读到这个素材的时长，读完才能放到时间轴上`
            : result.reason === 'track-locked'
              ? t`目标轨道已锁定`
              : t`播放头这个位置已经有片段了，把播放头挪到空处再试`,
        );
        return;
      }
      setNotice(null);
      // The shadow gains the new wire clip; the timeline gains the model one.
      // Both halves of the document move together or neither does.
      setDocument(result.document);
      editor.replaceTimeline(result.document.timeline);
      editor.select(result.clipId);
    },
    importAssets: () => {
      setNotice(t`导入需要挑选文件，这一版还没有接上文件对话框`);
    },
    applyPreset: (presetId) => {
      const preset = (presets.data ?? []).find((each) => each.id === presetId);
      if (preset === undefined || query.data === undefined || editor.selectedClipId === null) return;
      applyPreset.mutate(
        {
          project: query.data,
          clipId: editor.selectedClipId,
          preset,
        },
        {
          onSuccess: () => onReload(),
          onError: (error) => {
            if (isRevisionConflict(error)) setConflict(true);
          },
        },
      );
    },
    separateAudio: () => {
      if (query.data === undefined || editor.selectedClipId === null) return;
      separateAudio.mutate(
        { project: query.data, clipId: editor.selectedClipId },
        {
          onSuccess: () => onReload(),
          onError: (error) => {
            if (isRevisionConflict(error)) setConflict(true);
          },
        },
      );
    },
  };

  const keyframeLoss = live === null ? { keyframes: 0, clips: 0 } : droppedKeyframeCount(live);
  const writeError =
    dataErrorMessage(save.error) ??
    dataErrorMessage(applyPreset.error) ??
    dataErrorMessage(separateAudio.error) ??
    dataErrorMessage(exportVideo.error) ??
    dataErrorMessage(exportPackage.error) ??
    dataErrorMessage(restore.error);

  const savedMeta =
    query.data === undefined ? null : (
      <span className="flex items-center gap-2">
        <span data-testid="editor-save-state">
          {saveState === 'saving' ? (
            <Trans>保存中…</Trans>
          ) : saveState === 'unsaved' ? (
            <Trans>未保存</Trans>
          ) : (
            <Trans>已保存</Trans>
          )}
        </span>
        <span>·</span>
        <span>
          <Trans>版本 {query.data.revision}</Trans>
        </span>
        <span>·</span>
        <span className="font-mono text-2xs">{canvasSummary(query.data)}</span>
      </span>
    );

  return (
    <Page
      scroll={false}
      toolbar={
        <Toolbar
          title={query.data?.name ?? projectId}
          meta={savedMeta}
          primary={
            <Button
              variant="primary"
              size="md"
              data-editor-action="save"
              disabled={!dirty || save.isPending || service.blocked}
              disabledReason={
                dirty ? (service.buttonProps.disabledReason ?? t`正在保存`) : t`没有需要保存的改动`
              }
              onClick={runSave}
            >
              <Trans>保存</Trans>
              {service.suffix}
            </Button>
          }
          actions={[
            {
              id: 'export-package',
              label: <Trans>导出工程包</Trans>,
              onSelect: () => exportPackage.mutate({ projectId }),
              disabled: dirty || service.blocked,
              control: (
                <Button
                  variant="secondary"
                  size="md"
                  disabled={dirty || service.blocked}
                  disabledReason={dirty ? t`先保存改动，导出用的是服务端存着的工程` : ''}
                  onClick={() => exportPackage.mutate({ projectId })}
                >
                  <Trans>导出工程包</Trans>
                </Button>
              ),
            },
            {
              id: 'export-video',
              label: <Trans>导出视频</Trans>,
              disabled: dirty || service.blocked,
              onSelect: () => exportVideo.mutate({ projectId, options: { encoder: 'auto', quality: 85 } }),
              control: (
                <Button
                  variant="secondary"
                  size="md"
                  disabled={dirty || service.blocked}
                  disabledReason={dirty ? t`先保存改动，导出用的是服务端存着的工程` : ''}
                  onClick={() =>
                  /* `EditorExportRequest` is `{ encoder, quality, range_* }` —
                     `auto` lets the media layer pick the encoder, and the
                     range is omitted so the whole timeline is rendered. There
                     is no export dialog on the artboard, so there is none
                     here; 「11 输出与任务记录」 is where the job appears. */
                    exportVideo.mutate({ projectId, options: { encoder: 'auto', quality: 85 } })
                  }
                >
                  <Trans>导出视频</Trans>
                </Button>
              ),
            },
          ]}
        />
      }
    >
      <div className="flex min-h-0 flex-1 flex-col">
        {conflict ? (
          <Notice
            tone="danger"
            action={{ label: <Trans>重新载入</Trans>, onAction: onReload }}
          >
            <Trans>
              这个工程在别处被改过，刚才那次保存没有生效。重新载入会丢掉这里未保存的改动。
            </Trans>
          </Notice>
        ) : null}
        {writeError === null ? null : (
          <Notice
            tone="danger"
            action={{ label: <Trans>再试一次</Trans>, onAction: runSave }}
            onDismiss={() => save.reset()}
          >
            <Trans>这次操作没有完成：{writeError}</Trans>
          </Notice>
        )}
        {notice === null ? null : (
          <Notice
            tone="warning"
            action={{ label: <Trans>知道了</Trans>, onAction: () => setNotice(null) }}
            onDismiss={() => setNotice(null)}
          >
            {notice}
          </Notice>
        )}
        {keyframeLoss.keyframes === 0 ? null : (
          <Notice
            tone="warning"
            /* The recovery is 「撤销」 — while the edit is still local, undoing
               the trim brings the keyframes back. Once saved it cannot. */
            action={{ label: <Trans>撤销这次修改</Trans>, onAction: editor.undo }}
          >
            {/* Said before the save, because a keyframe dropped by a save is
                not recoverable by undo once the service has the document. */}
            <Trans>
              有 {keyframeLoss.clips} 个片段被改短了，保存时会丢掉落在片段之外的{' '}
              {keyframeLoss.keyframes} 个关键帧。
            </Trans>
          </Notice>
        )}

        <div className="flex min-h-0 flex-1">
          <div className="flex w-64 flex-none flex-col border-e border-divider">
            <MediaLibraryPanel desk={desk} service={service} />
          </div>

          <div className="flex min-h-0 flex-1 flex-col">
            <div className="flex min-h-0 flex-[3] border-b border-divider">
              <ProgramMonitor desk={desk} service={service} />
            </div>
            <div className="flex min-h-0 flex-[4] flex-col">
              <EditorTimelinePanel desk={desk} service={service} />
            </div>
          </div>

          <div className="flex w-72 flex-none flex-col border-s border-divider">
            <div className="min-h-0 flex-1 overflow-y-auto">
              <InspectorPanel desk={desk} service={service} />
            </div>
            <VersionHistoryPanel
              snapshots={snapshots.data ?? []}
              loading={snapshots.isPending}
              currentRevision={query.data?.revision ?? null}
              {...(dirty ? { restoreBlockedReason: t`先保存或放弃当前改动，恢复会覆盖它们` } : {})}
              onRestore={(snapshotId) => {
                setNotice(null);
                restore.mutate({ projectId, snapshotId }, { onSuccess: () => onReload() });
              }}
            />
          </div>
        </div>
      </div>
    </Page>
  );

}
