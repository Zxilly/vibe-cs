/**
 * The browser-mode editing authority behind `PATCH /projects/:id`.
 *
 * Without it every edit in `pnpm dev` echoed its own request body back as the
 * "project", so a design review could not add a clip, delete one or press
 * 撤销 without the page tripping over a missing `id`. It applies the closed
 * `ProjectEditOperation` vocabulary literally (the frontend already sends the
 * rippled track contents it wants), keeps a snapshot per change group for
 * revert, and never leaves `src/dev`.
 */

import type {
  EditingDocument,
  Project,
  ProjectChangeGroup,
  ProjectEditOperation,
  ProjectPatch,
  ProjectPatchResult,
} from '../shared/desktop/dto';
import { PREVIEW_PROJECT } from './projectFixtures';

let current: Project = structuredClone(PREVIEW_PROJECT);
const before = new Map<string, { readonly document: EditingDocument; readonly name: string }>();
let sequence = 0;

export function mockProject(): Project {
  return current;
}

export function applyMockPatch(patch: ProjectPatch): ProjectPatchResult {
  if (patch.base_revision !== current.revision) {
    throw { status: 409, code: 'REVISION_CONFLICT', message: '作品已被修改，请刷新后重试。' };
  }
  return commit(patch.summary, patch.operations, patch.reverts_change_group_id, patch.author);
}

export function revertMockChangeGroup(changeGroupId: string, expectedRevision: number): ProjectPatchResult {
  const snapshot = before.get(changeGroupId);
  if (snapshot === undefined) throw { status: 404, code: 'CHANGE_GROUP_NOT_FOUND', message: '找不到这次修改。' };
  if (expectedRevision !== current.revision) {
    throw { status: 409, code: 'REVISION_CONFLICT', message: '之后又有修改，无法直接撤销这一步。' };
  }
  const restoredName = snapshot.name;
  const restored = structuredClone(snapshot.document);
  return commit('撤销', [], changeGroupId, { kind: 'human' }, () => {
    current = { ...current, name: restoredName, document: restored };
  });
}

function commit(
  summary: string,
  operations: readonly ProjectEditOperation[],
  revertsId: string | null,
  author: ProjectPatch['author'],
  mutate: () => void = () => {
    let next: Project = structuredClone(current);
    for (const operation of operations) next = applyOperation(next, operation);
    current = next;
  },
): ProjectPatchResult {
  const id = `mock-change-${String((sequence += 1))}`;
  before.set(id, { document: structuredClone(current.document), name: current.name });
  const fromRevision = current.revision;
  mutate();
  const now = new Date().toISOString();
  current = {
    ...current,
    revision: fromRevision + 1,
    updated_at: now,
    document: { ...current.document, duration_seconds: storyDuration(current.document) },
  };
  const group: ProjectChangeGroup = {
    id,
    project_id: current.id,
    from_revision: fromRevision,
    to_revision: current.revision,
    author,
    status: 'completed',
    summary,
    reverts_change_group_id: revertsId,
    operations: [...operations],
    inverse_operations: [],
    created_at: now,
    completed_at: now,
  };
  return { project: current, change_group: group };
}

function applyOperation(project: Project, operation: ProjectEditOperation): Project {
  const document = project.document;
  const tracks = document.tracks;
  const withClips = (trackId: string, edit: (clips: EditingDocument['tracks'][number]['clips']) => typeof clips) =>
    tracks.map((track) => (track.id === trackId ? { ...track, clips: edit(track.clips) } : track));
  const withoutClip = (clipId: string) =>
    tracks.map((track) => ({ ...track, clips: track.clips.filter((clip) => clip.id !== clipId) }));
  switch (operation.op) {
    case 'rename_project':
      return { ...project, name: operation.name };
    case 'replace_settings':
      return { ...project, document: { ...document, settings: operation.settings } };
    case 'replace_markers':
      return { ...project, document: { ...document, markers: operation.markers } };
    case 'insert_track': {
      const next = [...tracks];
      next.splice(operation.index, 0, operation.track);
      return { ...project, document: { ...document, tracks: next } };
    }
    case 'remove_track':
      return { ...project, document: { ...document, tracks: tracks.filter((track) => track.id !== operation.track_id) } };
    case 'replace_track':
      return { ...project, document: { ...document, tracks: tracks.map((track) => (track.id === operation.track_id ? operation.track : track)) } };
    case 'reorder_tracks': {
      const byId = new Map(tracks.map((track) => [track.id, track]));
      return { ...project, document: { ...document, tracks: operation.track_ids.flatMap((id) => byId.get(id) ?? []) } };
    }
    case 'insert_clip':
      return { ...project, document: { ...document, tracks: withClips(operation.track_id, (clips) => {
        const next = [...clips];
        next.splice(operation.index, 0, operation.clip);
        return next;
      }) } };
    case 'remove_clip':
      return { ...project, document: { ...document, tracks: withoutClip(operation.clip_id) } };
    case 'replace_clip':
      return { ...project, document: { ...document, tracks: tracks.map((track) => ({
        ...track,
        clips: track.clips.map((clip) => (clip.id === operation.clip_id ? operation.clip : clip)),
      })) } };
    case 'move_clip': {
      const moving = tracks.flatMap((track) => track.clips).find((clip) => clip.id === operation.clip_id);
      if (moving === undefined) return project;
      const removed = withoutClip(operation.clip_id).map((track) => (track.id === operation.to_track_id
        ? { ...track, clips: [...track.clips.slice(0, operation.index), moving, ...track.clips.slice(operation.index)] }
        : track));
      return { ...project, document: { ...document, tracks: removed } };
    }
    case 'replace_track_clips':
      return { ...project, document: { ...document, tracks: withClips(operation.track_id, () => operation.clips) } };
  }
}

function storyDuration(document: EditingDocument): number {
  return document.tracks.reduce(
    (end, track) => track.clips.reduce((clipEnd, clip) => Math.max(clipEnd, clip.placement.start + clip.placement.duration), end),
    0,
  );
}
