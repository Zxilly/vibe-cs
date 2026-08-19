/*
 * pages/montage — the contract the four blocks of 「09 快速合辑」 are built
 * against (spec §7 `/montage/:projectId?`, phase 3f).
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  READ THIS FIRST if you are filling in one of the four blocks
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `MontagePage` is the shell. It owns the address, the project document, the
 * one selected clip and the one 「生成视频」, and it renders four blocks that
 * each get the same `MontageBlockProps`:
 *
 *   A  片段顺序（左列）    the ordered strip, 拖拽排序 · 双击裁切, 「从录制结果
 *                          添加」
 *   B  配乐与节拍（中列）  the music binding, the suggestion cards with their
 *                          per-card 预览 / 应用, and the 片段 / 名称 / 入点 /
 *                          时长 / 最近拍点 / 偏移 table
 *   C  包装（右列上）      主题 / 片头 / 选手名牌 / 情景标签 / 片尾 / 片段转场
 *   D  导出（右列下）      分辨率 / 帧率 / 画质策略 / 将生成 / 生成视频
 *
 * Replace the placeholder in `MontagePage.tsx` with your block's component and
 * put the component under `pages/montage/`. **Keep `MontagePage`'s named
 * export** — `src/routes.tsx` imports it and that seam is frozen.
 *
 * `/montage` with no id is the project list plus 「新建合辑」; the blocks above
 * only exist under `/montage/<projectId>`.
 *
 * ── hook → block ──────────────────────────────────────────────────────────
 *
 *   data/montage.ts
 *     useMontageProjects        shell  the bare `/montage` list and the switcher
 *     useMontageProject         shell  the document — **one caller.** See
 *                                      invariant 2: a block never fetches it.
 *     useCreateMontageProject   shell  「新建合辑」
 *     useSaveMontageProject     —      **only through `props.project.save`**
 *     useDeleteMontageProject   shell  「删除工程」 (confirm first)
 *     useExportMontageProject   D      「生成视频」 (invariant 1)
 *     useMontageExportJobs      D      the render history / running job row
 *     useBeatAlignmentPreview   B      「预览」 — writes nothing, by construction
 *     useApplyBeatAlignment     B      「应用」 — an ordinary project save
 *     isMontageWriteConflict    shell  「这份工程在别处被改过」 → 重新载入
 *
 *   data/mediaAssets.ts
 *     useMediaAssets / useImportMediaAsset      B  「更换音乐」
 *     useAudioAnalysis                          B  「128 BPM · 置信度 0.92」
 *     useAssetWaveform                          B  the music waveform
 *     useRecordedClipWaveform                   A  a take's own peaks
 *     mediaAssetStreamPath / recordedClipStreamPath  A/B  with `mediaSrc`
 *
 *   data/outputs.ts   useRecordedClips   A  「从录制结果添加」's picker
 *   data/nativeShell  useNativeShell     B  「更换音乐」's file picker, D  the
 *                                        output directory; `mediaSrc` is the
 *                                        **only** way to build a media URL
 *   data/serviceAction                   all  `props.service`
 *
 *   domain/media  ClipStrip + clipOrder (`moveItem`, `dropIndex`,
 *                 `totalDurationSeconds`), Waveform + waveformPeaks, Transport,
 *                 FilmStrip. **Read `domain/media/index.ts` before writing a
 *                 line of block A** — the reorderable strip already exists.
 *
 * ── the invariants ────────────────────────────────────────────────────────
 *
 * **1. There is exactly one 「生成视频」.** The board draws it twice — once in
 * the top bar, once at the foot of 导出 — and they are the *same* action: the
 * shell holds `props.export` and both renderings read it. 3e's lesson applies
 * unchanged: an action implemented once per column ends up with one live copy
 * and one that only looks pressed.
 *
 * **2. The selected clip is page state, and so is the project document.** The
 * order list, the beat table and (on a double-click) the trim editor are one
 * selection; the board highlights one row in the strip and the matching row in
 * the table. Two `useState`s make two selections on one screen. And the
 * document itself is fetched **once**, by the shell: four blocks each calling
 * `useMontageProject` would deduplicate the read but not the *writes*, and the
 * writes are the problem — see invariant 3.
 *
 * **3. Every write goes through `props.project.save`, and a save is
 * read-modify-write.** `PUT /api/montage/projects/{id}` replaces the whole
 * document and **there is no revision** (gap 1). 「09」 has three writers —
 * 顺序, 包装, 导出 — plus 「应用」 on a beat suggestion, and if each PUT the copy
 * it rendered from, the second would silently undo the first.
 * `data/montage.ts`'s `saveMontageProject` re-reads before it writes and
 * applies the caller's edit function to the *fresh* document, so two panels
 * touching different fields compose. Pass `baseUpdatedAt` and a save that lost
 * the race is refused with a `MontageWriteConflictError` carrying the fresh
 * document, rather than overwriting. A block **must not** call
 * `useSaveMontageProject` itself.
 *
 * **4. A beat suggestion never modifies the project.** 「节拍建议不会直接修改工
 * 程，应用前可逐条预览」, straight off the board. `useBeatAlignmentPreview` calls
 * `POST /media/audio/align-clips`, which takes beats and clip durations and
 * **has no project id at all** — it could not write if it wanted to. Applying is
 * a separate, explicit save through invariant 3, one suggestion at a time.
 *
 * ── backend gaps found while writing this contract ────────────────────────
 *
 *  1. **`MontageProjectRecord` has no `revision`.** No `If-Match`, no
 *     `expected_revision`, no 409. `updated_at` is the only concurrency handle
 *     and it is second-resolution, so two saves inside one second are
 *     indistinguishable. `baseUpdatedAt` narrows the window; it does not close
 *     it. Not worked around — reported.
 *  2. **The beat-alignment *proposal* routes are for editor projects, not
 *     montage projects.** `previewBeatAlignmentProposal` /
 *     `applyBeatAlignmentProposal` call `get_editor_project`, compare
 *     `project.revision` and answer with `audio_track_id` / `audio_clip_id`
 *     (`crates/application/src/routes/proposals.rs`). A montage project has no
 *     tracks and no revision; handing them a montage id 404s. So 「09」 uses the
 *     advisory `alignClipsToBeats` and applies the result itself, and the
 *     proposal pair is deliberately absent from `DesktopClient`'s `Pick`.
 *  3. **A montage project cannot express a gap or an overlap.** Clips are
 *     strictly sequential — `MontageClipRecord` carries `order`, `trim_start`
 *     and `trim_end` and no timeline position — so a clip's timeline start *is*
 *     the sum of the durations before it. A beat draft that wants clip 02 to
 *     begin at a given moment can therefore only be applied by changing the
 *     duration of what precedes it; `applyBeatDraftToProject` does exactly that
 *     and nothing more. Suggestions that need a gap are not applicable, and the
 *     page says so rather than silently approximating.
 *  4. **`MontageClipRecord` has no source duration.** The project stores
 *     `trim_start` / `trim_end` and the clip id; the real length lives on
 *     `RecordedClip.duration_seconds`, a different read. So a clip whose
 *     `trim_end` is `null` has an unknown length until the recorded-clip list
 *     has loaded, and 「2 分 04 秒」 is *unavailable* until then rather than
 *     zero. `montageTimeline` takes the durations as a lookup for this reason
 *     and returns `null` for what it cannot know.
 *  5. **`MontageSettingsRecord` has no field for 情景标签（回合 / 类型）.** It
 *     carries `include_name_cards` (选手名牌), `intro_title`, `outro_title`,
 *     `branding_theme`, `transition_seconds` and the encode settings. The
 *     board's context-tag toggle has nowhere to be stored, so it is omitted —
 *     not rendered as an always-off switch.
 *  6. **`branding_theme` has four members, the board draws three.** The wire
 *     set is `vibe | broadcast | minimal | neon`; the board shows 线框 / 极简 /
 *     转播. `MONTAGE_THEME` below labels all four, because a project already
 *     stored as `neon` must render as something.
 *  7. **`encoder` is the literal `'auto'`.** There is no encoder choice on the
 *     wire; 画质策略 maps onto `quality` alone.
 *  8. **`exportMontageProject` takes no options.** Resolution, fps and quality
 *     come from the project's stored `settings`, so 「生成视频」 must save before
 *     it exports — an unsaved 画质策略 change would not be in the render.
 *
 * ── house rules ───────────────────────────────────────────────────────────
 *
 * Three states always: Skeleton (**no invented percentage**), Empty with a
 * real recovery action, in-place Notice with a retry. Omit a field the backend
 * does not have; never render it as `0`. Destructive actions (删除工程, 清空片
 * 段) confirm in a Dialog and reuse the `dialog-confirm` catalogue. §8 folding
 * uses `props.collapsed`, and **「生成视频」 stays visible at every width**. Run
 * `node scripts/check-web-layers.mjs`.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Pure below this line, so `montageContract.test.ts` covers it in the `unit`
 * project with no DOM and no router.
 */

import { msg } from '@lingui/core/macro';
import type { MessageDescriptor } from '@lingui/core';
import type { ComponentType } from 'react';

import type { ServiceActionState } from '../../data/serviceAction';
import type { MontageEditFn } from '../../data/montage';
import type {
  AudioBeat,
  BeatAlignmentDraft,
  MontageBrandingTheme,
  MontageClipRecord,
  MontageProjectRecord,
} from '../../shared/desktop/dto';

/* ── the address ─────────────────────────────────────────────────────────── */

export function montageHref(projectId: string | null): string {
  return projectId === null
    ? '/projects'
    : `/projects/${encodeURIComponent(`montage:${projectId}`)}?step=shotlist`;
}

/** 「在多轨编辑器中打开」. The editor is the next round's page; the address is
 *  fixed by §7 today, so the link can be built now. */
export function editorHref(projectId: string): string {
  return `/editor/${encodeURIComponent(projectId)}`;
}

/** Where 「生成视频」 lands once the job is accepted. */
export function montageExportTaskHref(jobId: string): string {
  return `/delivery/task/${encodeURIComponent(jobId)}`;
}

/* ── timecode ────────────────────────────────────────────────────────────── */

/**
 * `mm:ss.d` — 「00:42.0」, 「01:12.5」, the form every time on this board takes.
 *
 * `design/timeline`'s `formatTimecode` is deliberately *not* reused: it drops
 * sub-second precision because a ruler label is a landmark, and here the tenth
 * is the whole point — 「+0.18s」 offsets are what the beat table is about.
 * Hours are folded into minutes: a montage is minutes long, and `62:30.0` reads
 * better than `1:02:30.0` next to `04:12.7`.
 */
export function formatMontageTimecode(seconds: number): string {
  if (!Number.isFinite(seconds)) return '--:--.-';
  const sign = seconds < 0 ? '-' : '';
  const total = Math.abs(seconds);
  /* Rounded to tenths *first*, so 59.98 prints 01:00.0 rather than 00:60.0. */
  const tenths = Math.round(total * 10);
  const minutes = Math.floor(tenths / 600);
  const secs = Math.floor((tenths % 600) / 10);
  return `${sign}${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}.${tenths % 10}`;
}

/** 「+0.18s」 / 「−0.06s」 / 「对齐」. The dash is U+2212, matching the board. */
export function formatBeatOffset(offsetSeconds: number, toleranceSeconds = 0.01): string | null {
  if (!Number.isFinite(offsetSeconds)) return null;
  if (Math.abs(offsetSeconds) < toleranceSeconds) return null;
  const rounded = Math.round(Math.abs(offsetSeconds) * 100) / 100;
  return `${offsetSeconds < 0 ? '−' : '+'}${rounded.toFixed(2)}s`;
}

/* ── the timeline a montage project implies ──────────────────────────────── */

/**
 * How long a source take is, by clip id. Built from `useRecordedClips` —
 * `MontageClipRecord` does not carry it (gap 4).
 */
export type ClipDurationLookup = Readonly<Record<string, number>>;

export interface MontageTimelineRow {
  readonly clip: MontageClipRecord;
  /** Position in the finished video. `null` when any clip before this one has
   *  an unknown length — a start built on a guess is worse than no start. */
  readonly startSeconds: number | null;
  /** `trim_end ?? source` minus `trim_start`. `null` when unknown. */
  readonly durationSeconds: number | null;
}

export interface MontageTimeline {
  readonly rows: readonly MontageTimelineRow[];
  /** 「2 分 04 秒」. `null` when any clip's length is unknown, so the header can
   *  say 「时长待定」 instead of printing a total that is missing a clip. */
  readonly totalSeconds: number | null;
}

/**
 * One clip's rendered length.
 *
 * `trim_end: null` means 「到素材末尾」, which needs the source length — hence
 * the lookup. A clip whose source is not known yet answers `null` rather than
 * zero: a zero-length clip is a real (and different) thing.
 */
export function clipDurationSeconds(
  clip: MontageClipRecord,
  durations: ClipDurationLookup,
): number | null {
  const end = clip.trim_end ?? durations[clip.clip_id];
  if (end === undefined || !Number.isFinite(end)) return null;
  const length = end - clip.trim_start;
  return length > 0 ? length : 0;
}

/**
 * The clips in `order`, with the timeline positions the sequence implies.
 *
 * Sorted by `order` here rather than trusting the array: the wire is an array
 * *and* carries an explicit `order`, and the two can disagree after an edit
 * that renumbered without re-sorting. `order` wins — it is the field the server
 * renders from.
 */
export function montageTimeline(
  project: MontageProjectRecord,
  durations: ClipDurationLookup,
): MontageTimeline {
  const ordered = [...project.clips].sort((left, right) => left.order - right.order);

  let cursor: number | null = 0;
  const rows = ordered.map((clip) => {
    const durationSeconds = clipDurationSeconds(clip, durations);
    const startSeconds = cursor;
    cursor = cursor === null || durationSeconds === null ? null : cursor + durationSeconds;
    return { clip, startSeconds, durationSeconds };
  });

  return { rows, totalSeconds: cursor };
}

/* ── beats ───────────────────────────────────────────────────────────────── */

/**
 * The ordinal the board prints. `AudioBeat.index` is zero-based
 * (`crates/media/src/audio_intelligence.rs` pushes with `beats.len()`), so the
 * first beat is 「第 1 拍」 and the conversion is spelled once here rather than
 * `+ 1` scattered through a table.
 *
 * Note that `phrase_position` is already one-based on the wire — it counts
 * inside a four-beat phrase and is a different number entirely.
 */
export function beatOrdinal(beat: AudioBeat): number {
  return beat.index + 1;
}

export interface NearestBeat {
  readonly beat: AudioBeat;
  /**
   * `time - beat.time_seconds`. Positive means the clip starts *after* the
   * beat, which is the sign convention the board's 「+0.18s」 uses.
   */
  readonly offsetSeconds: number;
}

/**
 * The beat closest to a moment, and how far off it is — 「最近拍点 第 33 拍 ·
 * 偏移 +0.18s」.
 *
 * A linear scan. `AudioAnalysis.beats` is capped at 4096 by
 * `AudioAnalysisOptions.maximum_beats` and the table has a handful of rows, so
 * a binary search would buy nothing and cost a boundary condition.
 *
 * `null` for an empty beat list — a track with no detected beats is a real
 * answer (`AudioAnalysis.limitations` says why), and the column is then omitted
 * rather than filled with a fiction.
 */
export function nearestBeat(
  beats: readonly AudioBeat[],
  timeSeconds: number,
): NearestBeat | null {
  if (beats.length === 0 || !Number.isFinite(timeSeconds)) return null;

  let best = beats[0] as AudioBeat;
  let bestDistance = Math.abs(timeSeconds - best.time_seconds);
  for (const beat of beats) {
    const distance = Math.abs(timeSeconds - beat.time_seconds);
    if (distance < bestDistance) {
      best = beat;
      bestDistance = distance;
    }
  }
  return { beat: best, offsetSeconds: timeSeconds - best.time_seconds };
}

/* ── applying a beat suggestion ──────────────────────────────────────────── */

/**
 * The clip ids a draft has something to say about — the rows that get a
 * 「预览 / 应用」 pair. `unplaced_clip_ids` are the ones it could not fit, and
 * they are excluded here so a suggestion card is never drawn for a clip the
 * aligner gave up on.
 */
export function suggestedClipIds(draft: BeatAlignmentDraft): string[] {
  const unplaced = new Set(draft.unplaced_clip_ids);
  return draft.clips.map((clip) => clip.clip_id).filter((id) => !unplaced.has(id));
}

/**
 * Applies the selected suggestions to a project.
 *
 * **What it changes: `trim_end`, and only `trim_end`.** A montage project has
 * no timeline positions (gap 3) — clip N starts where clip N−1 ended — so the
 * only thing that can move a downstream cut onto a beat is the length of what
 * comes before it. The draft's `planned_duration_seconds` is exactly that
 * length, so the transform is `trim_end = trim_start + planned`, clamped to the
 * source length the draft itself reports.
 *
 * **What it does not change:** order, transitions, titles, settings, or any
 * clip the caller did not tick. 「应用前可逐条预览」 means one at a time is the
 * normal case, so an unticked clip is left exactly as it was.
 *
 * Pure, and returns a new document — it is handed to
 * `saveMontageProject`'s `edit`, which applies it to a freshly re-read
 * document, so it must never close over the copy the page rendered from.
 */
export function applyBeatDraftToProject(
  project: MontageProjectRecord,
  draft: BeatAlignmentDraft,
  clipIds: readonly string[],
): MontageProjectRecord {
  const wanted = new Set(clipIds);
  const unplaced = new Set(draft.unplaced_clip_ids);
  const byClip = new Map(
    draft.clips
      .filter((clip) => wanted.has(clip.clip_id) && !unplaced.has(clip.clip_id))
      .map((clip) => [clip.clip_id, clip] as const),
  );
  if (byClip.size === 0) return project;

  return {
    ...project,
    clips: project.clips.map((clip) => {
      const suggestion = byClip.get(clip.clip_id);
      if (suggestion === undefined) return clip;
      const planned = suggestion.planned_duration_seconds;
      if (!Number.isFinite(planned) || planned <= 0) return clip;
      const limit = clip.trim_start + suggestion.source_duration_seconds;
      return { ...clip, trim_end: Math.min(clip.trim_start + planned, limit) };
    }),
  };
}

/* ── reordering ──────────────────────────────────────────────────────────── */

/**
 * Moves a clip and renumbers `order` so the array and the field agree.
 *
 * `domain/media`'s `moveItem` does the array half; the renumbering is this
 * layer's, because `order` is a wire field and `moveItem` knows nothing about
 * the shape it is moving. Returns an edit function rather than a document so it
 * can be handed straight to `props.project.save` — see invariant 3.
 */
export function reorderMontageClips(from: number, to: number): MontageEditFn {
  return (project) => {
    const ordered = [...project.clips].sort((left, right) => left.order - right.order);
    if (!Number.isInteger(from) || from < 0 || from >= ordered.length) return project;
    const target = Math.min(ordered.length - 1, Math.max(0, Math.trunc(to)));
    if (target === from) return project;

    const [moved] = ordered.splice(from, 1);
    ordered.splice(target, 0, moved as MontageClipRecord);
    return {
      ...project,
      clips: ordered.map((clip, index) => ({ ...clip, order: index })),
    };
  };
}

/* ── packaging vocabulary ────────────────────────────────────────────────── */

/**
 * `MontageBrandingTheme`'s four members. The board draws three (线框 / 极简 /
 * 转播); `vibe` is the fourth and a stored project may already be it, so it is
 * labelled rather than left to render as a raw identifier.
 *
 * No `context` tag — 「转播」 and 「极简」 appear nowhere else in the catalogue.
 * If one of them later gains a second meaning, tag this whole table then.
 */
export const MONTAGE_THEME: Readonly<Record<MontageBrandingTheme, MessageDescriptor>> = {
  vibe: msg`线框`,
  minimal: msg`极简`,
  broadcast: msg`转播`,
  neon: msg`霓虹`,
};

/* ── what every block receives ───────────────────────────────────────────── */

export interface MontageGuardedAction {
  readonly disabled: boolean;
  readonly disabledReason?: string;
}

/** The one selection. See invariant 2. */
export interface MontageSelection {
  /** `MontageClipRecord.clip_id`. */
  readonly clipId: string | null;
  readonly select: (clipId: string | null) => void;
}

/**
 * The document, and the one way to write it. See invariant 3.
 *
 * `save` takes the same `MontageEditFn` `saveMontageProject` does, and the
 * shell supplies `baseUpdatedAt` from what it last read — a block does not have
 * to remember to, and cannot get it wrong.
 */
export interface MontageProjectDesk {
  readonly project: MontageProjectRecord | null;
  readonly loading: boolean;
  readonly error: unknown;
  /** A write is in flight. Blocks disable their own controls with this rather
   *  than each holding a spinner of their own. */
  readonly saving: boolean;
  /** Set when the last save lost the race (`MontageWriteConflictError`). The
   *  shell renders 「这份工程在别处被改过」 with 「重新载入」; a block only reads
   *  it to stay disabled. */
  readonly conflict: MontageProjectRecord | null;
  /** The only write. Never call `useSaveMontageProject` from a block. */
  readonly save: (edit: MontageEditFn) => void;
  /** Source lengths by clip id, for `montageTimeline` (gap 4). Empty until the
   *  recorded-clip list has loaded, which is why the timeline reports `null`
   *  rather than zero in the meantime. */
  readonly clipDurations: ClipDurationLookup;
}

/**
 * 「生成视频」, held by the shell. See invariant 1.
 *
 * `run()` saves first and exports second (gap 8: the render reads the *stored*
 * settings, so an unsaved 画质策略 change would not be in it). A block renders
 * `action` and calls `run`; it does not call `useExportMontageProject`.
 */
export interface MontageExportDesk {
  readonly action: MontageGuardedAction;
  readonly running: boolean;
  readonly error: unknown;
  /** 「将生成 Kael_highlights_v2.mp4」's name, when the settings and the clips
   *  are enough to know it. `null` otherwise — never a placeholder file name. */
  readonly outputName: string | null;
  readonly run: () => void;
}

/**
 * Handed to every block. What is *not* here matters:
 *
 *   *No project read of your own.* One `useMontageProject`, in the shell.
 *   Four callers would deduplicate the read and multiply the writes.
 *
 *   *No `onSelectClip` / `onReorder` / `onSaveSettings` triple.* One
 *   `props.project.save` taking an edit function, and one `props.selection`.
 */
export interface MontageBlockProps {
  readonly projectId: string;
  readonly project: MontageProjectDesk;
  readonly selection: MontageSelection;
  /** The one 生成视频. See invariant 1. */
  readonly export: MontageExportDesk;
  readonly service: ServiceActionState;
  readonly collapsed: boolean;
}

export type MontageBlock = ComponentType<MontageBlockProps>;
