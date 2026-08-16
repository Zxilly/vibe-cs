/**
 * data layer — 「09 快速合辑」 (spec §7 `/montage/:projectId?`, phase 3f).
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  Two contract facts shape every write in this file
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ## 1. A montage project is saved by whole-document PUT, and it has no
 *    revision
 *
 * `PUT /api/montage/projects/{id}` replaces the document. There is **no**
 * `expected_revision`, no `If-Match`, and no partial patch — unlike
 * `EditorProject` (which has `revision`) and `AgentPlan` (which has one too,
 * and a 409 to go with it). `MontageProjectRecord` carries `created_at` and
 * `updated_at` and nothing else that could serve as a version.
 *
 * The consequence is concrete and it is the reason `useSaveMontageProject`
 * looks the way it does. 「09」 has two panels that write the same document —
 * 片段顺序 (order, trim) and 包装 / 导出 (settings) — plus 「应用」 on a beat
 * suggestion. If each panel PUT the copy of the project it was rendered from,
 * the second save would silently undo the first. So a save here is
 * **read-modify-write**:
 *
 *   1. re-read the project from the service (not from the cache);
 *   2. apply the caller's `edit` function *to that fresh document*;
 *   3. PUT the result.
 *
 * That makes two panels touching different fields compose instead of clobber,
 * which is the same shape `data/plans.ts` gets for free from
 * `applyAgentPlanEdit`'s conditional write — except that here the composition
 * is done by us, because the server will not do it.
 *
 * It is not as good, and pretending otherwise would be the mistake. Two saves
 * that both rewrite `clips` still resolve last-writer-wins, and the window
 * between the re-read and the PUT is unguarded. `baseUpdatedAt` narrows it:
 * pass the `updated_at` your UI was built from and the write is refused when
 * the document moved underneath you, so the page can offer 「重新载入」 rather
 * than overwrite. It is advisory — a second-resolution timestamp cannot
 * separate two writes inside the same second — and it is **recorded as a
 * backend gap**, not worked around.
 *
 * ## 2. A beat suggestion is a suggestion
 *
 * The artboard fixes this: 「节拍建议不会直接修改工程，应用前可逐条预览」. So
 * preview and apply are two mutations and the preview one **cannot write**:
 *
 *   `useBeatAlignmentPreview`  → `POST /media/audio/align-clips`. Takes beats
 *                                and clip durations. It has no project id, so
 *                                it *could not* write a project if it wanted
 *                                to — the guarantee is structural, not a
 *                                promise. Answers `BeatAlignmentDraft`, whose
 *                                `advisory_only: true` says the same thing on
 *                                the wire.
 *   `useApplyBeatAlignment`    → a `useSaveMontageProject` write carrying the
 *                                pure `applyBeatDraftToProject` transform, for
 *                                the clip ids the user ticked. One suggestion
 *                                or all of them; the page decides.
 *
 * ### Why the *proposal* routes are not used here
 *
 * `previewBeatAlignmentProposal` / `applyBeatAlignmentProposal`
 * (`/api/agent/proposals/beat-alignment/*`) look like the right pair and are
 * not. Read `crates/application/src/routes/proposals.rs`: both call
 * `get_editor_project`, both compare `project.revision`, and the apply answers
 * `BeatAlignmentApplyResult { audio_track_id, audio_clip_id, revision }`. They
 * operate on **`EditorProject`**, the multi-track document of 「10」 — a
 * different table, with tracks, clips and a revision that a montage project
 * does not have. Handing them a montage id would 404. They belong to the next
 * round, and they are deliberately absent from `DesktopClient`'s `Pick` so that
 * nobody reaches for them by name-matching.
 *
 * ── what invalidates what ─────────────────────────────────────────────────
 *
 *   create / save / delete   → `montage.detail(id)` **and** `montage.list()`.
 *                              Both, every time: the list prints 「5 段素材 ·
 *                              2 分 04 秒 · 上次保存 3 分钟前」, so a save that
 *                              refreshed only the open project leaves the
 *                              switcher lying about the clip count.
 *   export                   → `montage.exports(id)`, `qk.tasks.all` and
 *                              `qk.outputs.all`. An export is an activity that
 *                              ends in an output; the project itself did not
 *                              change, so its detail is left alone.
 *   beat preview             → nothing. It wrote nothing.
 */

import {
  skipToken,
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from '@tanstack/react-query';

import type {
  BeatAlignmentDraft,
  BeatAlignmentRequest,
  CreateMontageProject,
  MontageProjectRecord,
} from '../shared/desktop/dto';
import { useDesktopClient, type DesktopClient } from './desktopClient';
import { qk } from './keys';
import { invalidateOutputs } from './outputs';
import { resolveQueryTuning, type DataQueryTuning } from './queryTuning';
import { invalidateTasks } from './tasks';

/* ── reads ───────────────────────────────────────────────────────────────── */

/**
 * Every montage project — the bare `/montage`'s list and the project switcher.
 *
 * The route takes no filter, so the key carries no query object. If one is ever
 * added, `qk.montage.list()` gains a parameter and every caller is forced to
 * say what it is asking for, which is the point of the key factory.
 */
export function useMontageProjects(tuning: DataQueryTuning = {}) {
  const client = useDesktopClient();
  return useQuery({
    queryKey: qk.montage.list(),
    queryFn: ({ signal }) => client.listMontageProjects(signal),
    ...resolveQueryTuning(tuning),
  });
}

/**
 * One project: its clips in order and its settings.
 *
 * `null` disables the read — `/montage` with no id is a real state (the list),
 * not a loading one.
 */
export function useMontageProject(projectId: string | null, tuning: DataQueryTuning = {}) {
  const client = useDesktopClient();
  return useQuery({
    queryKey: qk.montage.detail(projectId ?? ''),
    queryFn:
      projectId === null
        ? skipToken
        : ({ signal }) => client.getMontageProject(projectId, signal),
    ...resolveQueryTuning(tuning, { enabled: projectId !== null }),
  });
}

/**
 * This project's export jobs — 「生成视频」's history and the row a running
 * export is watched through.
 *
 * A sibling key rather than a child of the project, so an autosave does not
 * re-fetch it; see `keys.ts`. Poll it with `pollMs` while a job is running.
 */
export function useMontageExportJobs(projectId: string | null, tuning: DataQueryTuning = {}) {
  const client = useDesktopClient();
  return useQuery({
    queryKey: qk.montage.exports(projectId ?? ''),
    queryFn:
      projectId === null
        ? skipToken
        : ({ signal }) => client.listExportJobs(projectId, signal),
    ...resolveQueryTuning(tuning, { enabled: projectId !== null }),
  });
}

/* ── the read-modify-write ───────────────────────────────────────────────── */

/**
 * A save was refused because the document moved between the caller's render and
 * the write.
 *
 * Carries the fresh document, so the page can offer 「重新载入」 with the new
 * state already in hand instead of a second round trip. A `class` rather than a
 * `DataError`-shaped object because this failure is produced *here*, not by the
 * service — there is no status and no code to report, and pretending there were
 * would make it indistinguishable from a real 409.
 */
export class MontageWriteConflictError extends Error {
  readonly current: MontageProjectRecord;

  constructor(current: MontageProjectRecord) {
    super('The montage project changed since it was read.');
    this.name = 'MontageWriteConflictError';
    this.current = current;
  }
}

export function isMontageWriteConflict(error: unknown): error is MontageWriteConflictError {
  return error instanceof MontageWriteConflictError;
}

/**
 * What a save does to the document. Pure — it is applied to a document this
 * layer just re-read, so it must not close over the copy the caller rendered
 * from unless it means to overwrite it.
 */
export type MontageEditFn = (current: MontageProjectRecord) => MontageProjectRecord;

export interface SaveMontageProjectInput {
  readonly projectId: string;
  readonly edit: MontageEditFn;
  /**
   * `updated_at` of the document the caller's UI was built from. When it has
   * moved, the write is refused with a `MontageWriteConflictError` instead of
   * overwriting someone else's save.
   *
   * Optional because a save that rewrites a field nobody else touches does not
   * need the guard, and demanding it everywhere would train callers to pass a
   * value they did not check. Omitting it is a decision, not a shortcut — say
   * so at the call site.
   */
  readonly baseUpdatedAt?: string | undefined;
}

/**
 * The one way 「09」 writes a project.
 *
 * Re-reads, applies, PUTs. The re-read goes to the **service**, not to the
 * query cache: a cached document is exactly as stale as the copy the caller is
 * holding, so composing onto it would compose onto the same lost update.
 *
 * On success the answer is written into the cache before the invalidation, so
 * the panel that just saved sees its own `updated_at` immediately and its next
 * `baseUpdatedAt` is not already wrong.
 */
export function useSaveMontageProject() {
  const client = useDesktopClient();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: SaveMontageProjectInput): Promise<MontageProjectRecord> =>
      saveMontageProject(client, input),
    onSuccess: (saved) => {
      queryClient.setQueryData(qk.montage.detail(saved.id), saved);
      return invalidateMontageProject(queryClient, saved.id);
    },
  });
}

/**
 * The transaction itself, without React. Exported so the beat-apply mutation
 * below and any future composite write share one implementation of the
 * three steps rather than two that drift.
 */
export async function saveMontageProject(
  client: DesktopClient,
  { projectId, edit, baseUpdatedAt }: SaveMontageProjectInput,
): Promise<MontageProjectRecord> {
  const current = await client.getMontageProject(projectId);
  if (baseUpdatedAt !== undefined && current.updated_at !== baseUpdatedAt) {
    throw new MontageWriteConflictError(current);
  }
  const next = edit(current);
  /* The route rejects a body whose `id` disagrees with the path. Forcing it
     here turns a server 400 into something an edit function cannot cause. */
  return client.putMontageProject(projectId, { ...next, id: projectId });
}

/* ── the rest of the writes ──────────────────────────────────────────────── */

/**
 * 「新建合辑」. Takes the name, the clips and the settings; identity and
 * timestamps are the server's.
 */
export function useCreateMontageProject() {
  const client = useDesktopClient();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (draft: CreateMontageProject): Promise<MontageProjectRecord> =>
      client.createMontageProject(draft),
    onSuccess: (created) => {
      queryClient.setQueryData(qk.montage.detail(created.id), created);
      return invalidateMontageProject(queryClient, created.id);
    },
  });
}

/**
 * 「删除工程」 — destructive, so the page confirms first (「补齐 · 规范与状态」's
 * Dialog rules: 「Dialog 只承载不可逆动作与正式确认」). This layer does not
 * confirm; it deletes.
 *
 * Removes the detail rather than invalidating it: a deleted project refetched
 * on the next mount is a 404 dressed up as an error banner.
 */
export function useDeleteMontageProject() {
  const client = useDesktopClient();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (projectId: string) => client.deleteMontageProject(projectId),
    onSuccess: async (_result, projectId) => {
      queryClient.removeQueries({ queryKey: qk.montage.detail(projectId) });
      queryClient.removeQueries({ queryKey: qk.montage.exports(projectId) });
      await invalidateMontageProjects(queryClient);
    },
  });
}

/**
 * 「生成视频」 — queues the render.
 *
 * Answers `JobAccepted { job_id, status }`; the page links to
 * `/delivery/task/<job_id>`, which is where a running job already lives (§7).
 * The project is unchanged, so its detail is not invalidated — only the job
 * list, the activity feed and the outputs the render will land in.
 */
export function useExportMontageProject() {
  const client = useDesktopClient();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (projectId: string) => client.exportMontageProject(projectId),
    onSuccess: (_job, projectId) =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: qk.montage.exports(projectId) }),
        invalidateTasks(queryClient),
        invalidateOutputs(queryClient),
      ]).then(() => undefined),
  });
}

/* ── beat suggestions ────────────────────────────────────────────────────── */

/**
 * 「预览」 — computes where the cuts would land, and **writes nothing**.
 *
 * Structurally incapable of writing: `BeatAlignmentRequest` carries beats, clip
 * durations and options, and no project id at all. The answer's
 * `advisory_only: true` and its per-clip `rationale` are what the two suggestion
 * cards on the artboard are rendered from (「对齐第 33 拍的段落起点，位移 0.18
 * 秒」).
 *
 * `unplaced_clip_ids` is a first-class outcome, not a failure: a clip the
 * aligner could not place inside the tolerances stays where it is, and the page
 * says so rather than dropping it.
 */
export function useBeatAlignmentPreview() {
  const client = useDesktopClient();
  return useMutation({
    mutationFn: (request: BeatAlignmentRequest): Promise<BeatAlignmentDraft> =>
      client.alignClipsToBeats(request),
  });
}

export interface ApplyBeatAlignmentInput {
  readonly projectId: string;
  readonly draft: BeatAlignmentDraft;
  /**
   * Which suggestions the user ticked. 「应用前可逐条预览」 means one at a time
   * is the normal case, so this is a list rather than an all-or-nothing flag;
   * pass every id for 「全部应用」.
   */
  readonly clipIds: readonly string[];
  readonly baseUpdatedAt?: string | undefined;
  /**
   * The transform. Supplied by the caller — `applyBeatDraftToProject` in
   * `pages/montage/montageContract.ts` — because *what a suggestion means to a
   * document* is a page-level model (montage clips are sequential and have no
   * timeline start of their own), and it is pure, so it belongs where it can be
   * exhausted in the `unit` project.
   */
  readonly apply: (
    project: MontageProjectRecord,
    draft: BeatAlignmentDraft,
    clipIds: readonly string[],
  ) => MontageProjectRecord;
}

/**
 * 「应用」 — the second, separate mutation.
 *
 * It is an ordinary project save. Nothing about it is special-cased on the
 * server, which is the honest shape: a beat suggestion applied is just clips
 * with different trim points, and undoing it is editing them back.
 */
export function useApplyBeatAlignment() {
  const client = useDesktopClient();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({
      projectId,
      draft,
      clipIds,
      baseUpdatedAt,
      apply,
    }: ApplyBeatAlignmentInput): Promise<MontageProjectRecord> =>
      saveMontageProject(client, {
        projectId,
        edit: (current) => apply(current, draft, clipIds),
        ...(baseUpdatedAt === undefined ? {} : { baseUpdatedAt }),
      }),
    onSuccess: (saved) => {
      queryClient.setQueryData(qk.montage.detail(saved.id), saved);
      return invalidateMontageProject(queryClient, saved.id);
    },
  });
}

/* ── invalidation ────────────────────────────────────────────────────────── */

/** The project switcher and the bare-`/montage` list. */
export function invalidateMontageProjects(client: QueryClient): Promise<void> {
  return client.invalidateQueries({ queryKey: qk.montage.list() });
}

/**
 * The pair every project write owes: the document **and** the list. Written
 * once so no mutation can remember only half of it.
 */
export function invalidateMontageProject(client: QueryClient, projectId: string): Promise<void> {
  return Promise.all([
    client.invalidateQueries({ queryKey: qk.montage.detail(projectId) }),
    invalidateMontageProjects(client),
  ]).then(() => undefined);
}
