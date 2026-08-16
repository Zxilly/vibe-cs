/*
 * pages/editor — the contract every panel of 「10 多轨编辑器」 is written
 * against (spec §7 `/editor/:projectId?`, phase 3f-2).
 *
 * `EditorPage` owns four things and hands them down as one object, for the
 * same reason `montageContract.ts` exists: a panel that fetched, saved or
 * selected on its own would be a second copy of a decision the page has
 * already made.
 *
 *   **One document.** `useEditorProject` is called once. Four panels each
 *   reading it would deduplicate the fetch and multiply the *writes*, and a
 *   write here carries a revision — two panels saving the same project would
 *   have the second one 409 against the first.
 *
 *   **One timeline editor.** `useTimelineEditor` holds the undo stack, the
 *   selection and the drag. The Inspector reads the selected clip from it and
 *   the timeline draws it; two editors would be two undo stacks over one
 *   document.
 *
 *   **One save.** The artboard has no 保存 button — it prints 「已保存 · 版本
 *   24」 — but this page is not montage: an editor project *does* have a
 *   revision, and a save that raced would be refused rather than silently
 *   applied. So the save is explicit and the header says which of the three
 *   states it is in. See `EditorPage`.
 *
 *   **One selection.** The clip highlighted on the timeline is the clip the
 *   Inspector is describing and the clip 「存为预设」 would apply to.
 *
 * ── the two-layer document ────────────────────────────────────────────────
 *
 * `desk.document` carries the *shadow* — every wire field the timeline model
 * does not describe — and `desk.editor.timeline` carries what is being edited.
 * They are separate because the undo stack lives inside the hook: putting the
 * shadow in there too would mean an undo restored a colour grade that was
 * never part of the edit.
 *
 * A save recombines them (`toEditorProject`), which is why `desk.save` is on
 * the page and not on any panel.
 */

import type { TimelineEditor } from '../../design/timeline';
import type { ServiceActionState } from '../../data/serviceAction';
import type { EditorPreset, EditorProject, MediaAsset } from '../../shared/desktop/dto';
import type { EditorDocument } from './editorDocument';

/** Where a project's editor lives. */
export function editorHref(projectId: string): string {
  return `/editor/${encodeURIComponent(projectId)}`;
}

/** Which of the three the header prints. */
export type SaveState = 'saved' | 'unsaved' | 'saving';

export interface EditorDesk {
  projectId: string;
  /**
   * The wire envelope as the service last answered it — identity, canvas,
   * settings and, critically, `revision`. A save sends the revision from
   * *here*, not from the document the page was built from, so a save that
   * follows another save does not send the older number.
   */
  project: EditorProject | null;
  /** The shadow: wire fields the timeline does not describe. */
  document: EditorDocument | null;
  /** The timeline, its undo stack, its selection and its commands. */
  editor: TimelineEditor;
  /** The project's media, for source lengths and the 素材库 panel. */
  assets: readonly MediaAsset[];
  /** The clip preset library. */
  presets: readonly EditorPreset[];

  saveState: SaveState;
  /** True while any read the panels need is still in flight. */
  loading: boolean;
  /**
   * Set when the service refused a write because the project moved. The page
   * offers 重新载入; nothing is merged — see `data/editor.ts`.
   */
  conflict: boolean;

  save: () => void;
  /** Throws away local edits and rebuilds from the service. */
  reload: () => void;
  /**
   * Puts an asset on the timeline at the playhead — the 素材库's own action,
   * and the only way content enters a new project. A refusal (no measured
   * duration, the playhead is inside a clip, the lane is locked) surfaces as
   * a Notice rather than as nothing happening.
   */
  addAssetToTimeline: (assetId: string) => void;
  /** Registers files already on disk as managed assets. */
  importAssets: () => void;
  /** True while an import is in flight. */
  importing: boolean;
  /**
   * Points an asset at the file it moved to, keeping its identity — so every
   * clip that references it follows without being touched.
   *
   * The service refuses a replacement shorter than the original, because those
   * clips would then be cut from footage that no longer reaches that far. That
   * refusal is a message with both lengths in it and is shown as-is.
   */
  relinkAsset: (assetId: string) => void;
  /** True while a relink is in flight. */
  relinking: boolean;
  /** Applies a preset to the selected clip. */
  applyPreset: (presetId: string) => void;
  /** Splits the selected video clip's audio onto its own lane. */
  separateAudio: () => void;
}

export interface EditorPanelProps {
  readonly desk: EditorDesk;
  readonly service: ServiceActionState;
}

/* ── formatting the panels share ─────────────────────────────────────────── */

/** `1920×1080 · 60fps`, the canvas line under the project name. */
export function canvasSummary(project: EditorProject): string {
  return `${project.width}×${project.height} · ${project.fps}fps`;
}

/** `12.4 MB` / `1.2 GB` — asset sizes in the 素材库 list. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 100 ? 0 : 1)} ${units[unit]}`;
}

/** `3:12`, the 素材库's own duration format — minutes, not timecode. */
export function formatClockDuration(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds)) return '—';
  const whole = Math.max(0, Math.round(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
}
