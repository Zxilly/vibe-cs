import type { ProjectEditingMode } from './projectViewModel';

export type ProjectModeTransitionReason =
  | 'current'
  | 'agent_copy_ready'
  | 'agent_needs_composition'
  | 'agent_to_multitrack_via_quick'
  | 'quick_to_multitrack_copy'
  | 'quick_cannot_rebuild_agent_evidence'
  | 'multitrack_has_no_lossless_reverse';

export type ProjectModeTransitionAction = 'none' | 'open_copy' | 'create_copy';

export interface ProjectModeTransition {
  readonly from: ProjectEditingMode;
  readonly to: ProjectEditingMode;
  readonly action: ProjectModeTransitionAction;
  readonly reason: ProjectModeTransitionReason;
  readonly copyProjectId: string | null;
}

/**
 * The conversion graph is deliberately one-way:
 *
 * Agent --copy--> Quick --copy--> Multitrack
 *
 * A conversion always creates or opens another persisted project. It never
 * changes the source document and never syncs later edits back.
 */
export function projectModeTransition(
  from: ProjectEditingMode,
  to: ProjectEditingMode,
  quickCopyProjectId: string | null,
): ProjectModeTransition {
  if (from === to) return { from, to, action: 'none', reason: 'current', copyProjectId: null };
  if (from === 'agent' && to === 'quick') {
    return quickCopyProjectId === null
      ? { from, to, action: 'none', reason: 'agent_needs_composition', copyProjectId: null }
      : { from, to, action: 'open_copy', reason: 'agent_copy_ready', copyProjectId: quickCopyProjectId };
  }
  if (from === 'agent' && to === 'multitrack') {
    return { from, to, action: 'none', reason: 'agent_to_multitrack_via_quick', copyProjectId: null };
  }
  if (from === 'quick' && to === 'multitrack') {
    return { from, to, action: 'create_copy', reason: 'quick_to_multitrack_copy', copyProjectId: null };
  }
  if (from === 'quick' && to === 'agent') {
    return { from, to, action: 'none', reason: 'quick_cannot_rebuild_agent_evidence', copyProjectId: null };
  }
  return { from, to, action: 'none', reason: 'multitrack_has_no_lossless_reverse', copyProjectId: null };
}
