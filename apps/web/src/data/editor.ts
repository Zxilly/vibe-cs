/**
 * data layer — 「10 多轨编辑器」 (spec §7 `/editor/:projectId?`, phase 3f-2).
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  The one contract fact that shapes every write here
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * **An editor project has a revision, and the service enforces it.**
 *
 * `PATCH /api/editor/projects/{id}` reads `expected_revision` out of the body
 * it was given — the `revision` field of the project you send — compares it,
 * and answers **409** with the current revision when they differ
 * (`save_editor_project` in `crates/application/src/routes/media.rs`).
 *
 * That is a materially better contract than `data/montage.ts` has, and it is
 * used as such. Montage saves are read-modify-write because a montage project
 * has no version and two panels would otherwise clobber each other silently.
 * Here the service refuses the second write, so this file does **not**
 * re-read-and-merge. It surfaces the conflict.
 *
 * The reason to surface rather than merge is the shape of the document. A
 * montage project's panels touch disjoint fields (clip order / packaging
 * settings) and merging them is meaningful. An editor project is a timeline:
 * if it moved underneath you, the clip you just dragged may not exist any
 * more. Merging that is not a merge, it is a guess, and the guess is invisible
 * — so 「另一处改动了这个工程」 with a reload is the honest answer.
 *
 * ── the local document is the source of truth while editing ────────────────
 *
 * `useEditorProject` fetches; `EditorPage` turns it into an `EditorDocument`
 * once and edits *that*. The query is **not** re-read into the editor while
 * there are unsaved changes — `refetchOnWindowFocus` would otherwise throw
 * away a drag because the user alt-tabbed. `staleTime: Infinity` states it: a
 * project only changes through this page's own saves, and those write the
 * response straight into the cache.
 *
 * ── what invalidates what ─────────────────────────────────────────────────
 *
 *   save / restore / apply preset / separate audio
 *                            → `editor.detail(id)` **and** `editor.list()`.
 *                              The switcher prints a name and a modified time
 *                              that a detail-only refresh leaves stale.
 *                              `editor.snapshots(id)` is a *child* of the
 *                              detail key, so it refreshes with it — a save
 *                              takes a snapshot server-side.
 *   separate audio           → also `qk.media.assetsAll`: it mints a new audio
 *                              asset, and the 素材库 panel lists assets.
 *   export / export package  → `qk.tasks.all` and `qk.outputs.all`, and
 *                              *nothing* under `editor`. An export reads the
 *                              project and writes an output; the document did
 *                              not change.
 *   preset writes            → `editor.presets()` alone. A preset library is
 *                              not a property of any project.
 */

import {
  skipToken,
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from '@tanstack/react-query';

import type {
  EditorExportOptions,
  EditorPackageExport,
  EditorPreset,
  EditorProject,
  EditorProjectSnapshot,
  JobAccepted,
} from '../shared/desktop/dto';
import { useDesktopClient } from './desktopClient';
import { qk } from './keys';
import { invalidateMediaAssets } from './mediaAssets';
import { invalidateOutputs } from './outputs';
import { resolveQueryTuning, type DataQueryTuning } from './queryTuning';
import { invalidateTasks } from './tasks';

/* ── reads ───────────────────────────────────────────────────────────────── */

/** Every editor project — the bare `/editor`'s list and the project switcher. */
export function useEditorProjects(tuning: DataQueryTuning = {}) {
  const client = useDesktopClient();
  return useQuery({
    queryKey: qk.editor.list(),
    queryFn: ({ signal }) => client.listEditorProjects(signal),
    select: (response) => response.items,
    ...resolveQueryTuning(tuning),
  });
}

/**
 * One project.
 *
 * `staleTime: Infinity` is deliberate and is the point of the whole file: the
 * page holds a local document derived from this response, and a background
 * refetch that replaced it would discard unsaved edits without saying so. The
 * document changes through this page's saves, and those write the response
 * into the cache directly (`setQueryData` below), so the cache stays correct
 * without ever refetching underneath an editor.
 */
export function useEditorProject(projectId: string | undefined, tuning: DataQueryTuning = {}) {
  const client = useDesktopClient();
  return useQuery({
    queryKey: qk.editor.detail(projectId ?? ''),
    queryFn: projectId === undefined ? skipToken : ({ signal }) => client.getEditorProject(projectId, signal),
    staleTime: Number.POSITIVE_INFINITY,
    refetchOnWindowFocus: false,
    ...resolveQueryTuning(tuning),
  });
}

/** 「版本历史」. A child key of the project, so a save refreshes it. */
export function useEditorSnapshots(projectId: string | undefined, tuning: DataQueryTuning = {}) {
  const client = useDesktopClient();
  return useQuery({
    queryKey: qk.editor.snapshots(projectId ?? ''),
    queryFn:
      projectId === undefined ? skipToken : ({ signal }) => client.listEditorSnapshots(projectId, signal),
    select: (response) => response.items,
    ...resolveQueryTuning(tuning),
  });
}

/** The clip preset library the Inspector's 「存为预设」 row reads. */
export function useEditorPresets(tuning: DataQueryTuning = {}) {
  const client = useDesktopClient();
  return useQuery({
    queryKey: qk.editor.presets(),
    queryFn: ({ signal }) => client.listEditorPresets(signal),
    select: (response) => response.items,
    ...resolveQueryTuning(tuning),
  });
}

/* ── invalidation ────────────────────────────────────────────────────────── */

/**
 * What every project write refreshes. Both keys, every time — see the header.
 * `snapshots(id)` needs no separate call: it hangs below `detail(id)`.
 */
export async function invalidateEditorProject(client: QueryClient, projectId: string): Promise<void> {
  await Promise.all([
    client.invalidateQueries({ queryKey: qk.editor.detail(projectId) }),
    client.invalidateQueries({ queryKey: qk.editor.list() }),
  ]);
}

/* ── the save ────────────────────────────────────────────────────────────── */

/** A 409 from the service, in the form the page can act on. */
export class EditorRevisionConflict extends Error {
  constructor(readonly projectId: string, cause: unknown) {
    super('editor project was modified elsewhere');
    this.name = 'EditorRevisionConflict';
    this.cause = cause;
  }
}

/** Whether a thrown error is the service refusing a stale write. */
export function isRevisionConflict(error: unknown): error is EditorRevisionConflict {
  return error instanceof EditorRevisionConflict;
}

function conflictOf(error: unknown): boolean {
  // `ApiError` carries the HTTP status; the code is what the route sets.
  const record = error as { status?: number; code?: string } | null;
  return record?.status === 409 || record?.code === 'revision_conflict';
}

/**
 * Saves the whole document.
 *
 * The project you pass carries the revision you read it at, which *is* the
 * `expected_revision` — there is no separate argument, because there is no
 * separate field on the wire. Sending a project whose revision you invented
 * would be indistinguishable from sending a stale one, so the page always
 * saves the project it built its document from.
 *
 * The response replaces the cache entry directly rather than triggering a
 * refetch: it is the authoritative new document, revision included, and the
 * editor needs that revision for its *next* save. A refetch would leave a
 * window in which the page holds the old revision and every save 409s.
 */
export function useSaveEditorProject() {
  const client = useDesktopClient();
  const queryClient = useQueryClient();
  return useMutation<EditorProject, unknown, EditorProject>({
    mutationFn: async (project) => {
      try {
        return await client.saveEditorProject(project);
      } catch (error) {
        if (conflictOf(error)) throw new EditorRevisionConflict(project.id, error);
        throw error;
      }
    },
    onSuccess: async (saved) => {
      queryClient.setQueryData(qk.editor.detail(saved.id), saved);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: qk.editor.list() }),
        queryClient.invalidateQueries({ queryKey: qk.editor.snapshots(saved.id) }),
      ]);
    },
  });
}

/* ── the other project writes ────────────────────────────────────────────── */

export interface CreateEditorProjectInput {
  name: string;
  width?: number;
  height?: number;
  fps?: number;
}

/**
 * A new, empty project.
 *
 * The defaults are 1080p60 — the artboard's 素材库 lists every source as
 * 「1080p60」, and a project whose canvas does not match its footage scales
 * every clip on export.
 */
export function useCreateEditorProject() {
  const client = useDesktopClient();
  const queryClient = useQueryClient();
  return useMutation<EditorProject, unknown, CreateEditorProjectInput>({
    mutationFn: ({ name, width = 1920, height = 1080, fps = 60 }) =>
      client.createEditorProject({ name, width, height, fps }),
    onSuccess: async (created) => {
      queryClient.setQueryData(qk.editor.detail(created.id), created);
      await queryClient.invalidateQueries({ queryKey: qk.editor.list() });
    },
  });
}

export function useDuplicateEditorProject() {
  const client = useDesktopClient();
  const queryClient = useQueryClient();
  return useMutation<EditorProject, unknown, { projectId: string; name: string; asTemplate?: boolean }>({
    mutationFn: ({ projectId, name, asTemplate = false }) =>
      client.duplicateEditorProject(projectId, name, asTemplate),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: qk.editor.list() });
    },
  });
}

/**
 * Deletes projects.
 *
 * The batch route takes each id *with the revision it was read at*, so a
 * project someone else has since edited is refused rather than deleted from
 * under them — the same guarantee the save has, and the reason there is no
 * single-project delete hook here.
 */
export function useDeleteEditorProjects() {
  const client = useDesktopClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (projects: ReadonlyArray<Pick<EditorProject, 'id' | 'revision'>>) =>
      client.deleteEditorProjects(projects.map((project) => ({ id: project.id, expected_revision: project.revision }))),
    onSuccess: async (_result, projects) => {
      for (const project of projects) queryClient.removeQueries({ queryKey: qk.editor.detail(project.id) });
      await queryClient.invalidateQueries({ queryKey: qk.editor.list() });
    },
  });
}

/** 「版本历史」's restore. Answers the restored document, revision and all. */
export function useRestoreEditorSnapshot() {
  const client = useDesktopClient();
  const queryClient = useQueryClient();
  return useMutation<EditorProject, unknown, { projectId: string; snapshotId: string }>({
    mutationFn: ({ projectId, snapshotId }) => client.restoreEditorSnapshot(projectId, snapshotId),
    onSuccess: async (restored) => {
      queryClient.setQueryData(qk.editor.detail(restored.id), restored);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: qk.editor.list() }),
        queryClient.invalidateQueries({ queryKey: qk.editor.snapshots(restored.id) }),
      ]);
    },
  });
}

/**
 * Applies a clip preset — the Inspector's 调色 row.
 *
 * Two revisions are checked, not one: the project's *and* the preset's. A
 * preset edited in another window would otherwise apply a grade the user is no
 * longer looking at, and the route takes both expectations for that reason.
 */
export function useApplyEditorPreset() {
  const client = useDesktopClient();
  const queryClient = useQueryClient();
  return useMutation<
    EditorProject,
    unknown,
    { project: Pick<EditorProject, 'id' | 'revision'>; clipId: string; preset: Pick<EditorPreset, 'id' | 'revision'> }
  >({
    mutationFn: async ({ project, clipId, preset }) => {
      try {
        return await client.applyEditorPreset(project.id, clipId, preset.id, project.revision, preset.revision);
      } catch (error) {
        if (conflictOf(error)) throw new EditorRevisionConflict(project.id, error);
        throw error;
      }
    },
    onSuccess: async (updated) => {
      queryClient.setQueryData(qk.editor.detail(updated.id), updated);
      await queryClient.invalidateQueries({ queryKey: qk.editor.list() });
    },
  });
}

/**
 * Splits a video clip's audio onto its own lane, linked to the original.
 *
 * The route answers `EditorAudioSeparation` — the ids it minted — and not the
 * project, so the document is invalidated rather than written into the cache.
 * It also creates a media asset, which the 素材库 panel lists.
 */
export function useSeparateEditorAudio() {
  const client = useDesktopClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: { project: Pick<EditorProject, 'id' | 'revision'>; clipId: string; muteSource?: boolean }) => {
      try {
        return await client.separateEditorAudio(
          input.project.id,
          input.clipId,
          input.project.revision,
          input.muteSource ?? true,
        );
      } catch (error) {
        if (conflictOf(error)) throw new EditorRevisionConflict(input.project.id, error);
        throw error;
      }
    },
    onSuccess: async (_result, input) => {
      await Promise.all([
        invalidateEditorProject(queryClient, input.project.id),
        invalidateMediaAssets(queryClient),
      ]);
    },
  });
}

/* ── exports ─────────────────────────────────────────────────────────────── */

/**
 * 「导出视频」. An activity that ends in an output, so it refreshes the task and
 * output lists and leaves the project alone — the document did not change.
 */
export function useExportEditorProject() {
  const client = useDesktopClient();
  const queryClient = useQueryClient();
  return useMutation<JobAccepted, unknown, { projectId: string; options: EditorExportOptions }>({
    mutationFn: ({ projectId, options }) => client.exportEditorProject(projectId, options),
    onSuccess: async () => {
      await Promise.all([invalidateTasks(queryClient), invalidateOutputs(queryClient)]);
    },
  });
}

/** 「导出工程包」 — the project plus its media, as a portable archive. */
export function useExportEditorPackage() {
  const client = useDesktopClient();
  const queryClient = useQueryClient();
  return useMutation<EditorPackageExport, unknown, { projectId: string; outputPath?: string }>({
    mutationFn: ({ projectId, outputPath }) => client.exportEditorPackage(projectId, outputPath),
    onSuccess: async () => {
      await Promise.all([invalidateTasks(queryClient), invalidateOutputs(queryClient)]);
    },
  });
}

/* ── list projections ────────────────────────────────────────────────────── */

/** What the project switcher prints for one row. */
export interface EditorProjectSummary {
  id: string;
  name: string;
  /** Clips across every track — the row's 「12 个片段」. */
  clipCount: number;
  trackCount: number;
  durationSeconds: number;
  revision: number;
  updatedAt: string;
}

export function summarizeEditorProject(project: EditorProject): EditorProjectSummary {
  return {
    id: project.id,
    name: project.name,
    clipCount: project.tracks.reduce((total, track) => total + track.clips.length, 0),
    trackCount: project.tracks.length,
    durationSeconds: project.duration_seconds,
    revision: project.revision,
    updatedAt: project.updated_at,
  };
}

/** The type the 版本历史 panel renders, named where its hook lives. */
export type EditorSnapshotRow = EditorProjectSnapshot;
