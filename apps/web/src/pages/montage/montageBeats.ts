/*
 * pages/montage — 配乐与节拍's model: what to ask the aligner, and what its
 * answer means to this project.
 *
 * Pure. The mutation lives in `data/montage.ts` (`useBeatAlignmentPreview`);
 * everything that decides *what a suggestion is* is here so it can be exhausted
 * in the `unit` project.
 *
 * ── The invariant this file exists to keep ────────────────────────────────
 *
 * 「节拍建议不会直接修改工程，应用前可逐条预览」 — straight off the artboard.
 * `POST /media/audio/align-clips` carries beats and clip durations and **no
 * project id**, so the request could not write a project if it wanted to; and
 * 「预览」 on a card is a *page-local* document produced by
 * `previewBeatDraft`, which is `applyBeatDraftToProject` under a name that says
 * it is not saved. Leaving preview drops the object. Nothing on this path
 * touches `props.project.save`.
 *
 * ── The one thing the aligner cannot be told directly ─────────────────────
 *
 * `BeatAlignmentRequest.clips[].source_duration_seconds` is *how much material
 * there is*, and the aligner both (a) scores candidate cuts by how far they sit
 * from it and (b) has it used as the clamp in `applyBeatDraftToProject`. Those
 * two want different numbers: the clamp wants 「到素材末尾还剩多少」 (otherwise
 * a suggestion could never lengthen a clip), while the score wants 「现在多长」
 * (otherwise every suggestion drifts toward using the whole take).
 *
 * The API already separates them, so this file uses it rather than picking a
 * loser: `source_duration_seconds` is the material available from the in-point,
 * `minimum` / `maximum` bound the change to ±15% of the *current* length, and
 * `preferred_beats` — the number of beats the current length spans — makes the
 * aligner's `target_duration` the current cut. The result is 「snap this cut to
 * the nearest beat」 rather than 「re-cut everything to fill the take」.
 */

import type {
  AudioAnalysis,
  AudioBeat,
  BeatAlignmentDraft,
  BeatAlignmentRequest,
  MontageProjectRecord,
} from '../../shared/desktop/dto';
import {
  applyBeatDraftToProject,
  clipDurationSeconds,
  type ClipDurationLookup,
} from './montageContract';

/**
 * The options every request from this page carries.
 *
 *   `maximum_duration_change_ratio` 0.15  — a montage clip is a highlight with
 *       a beginning the viewer needs; ±15% moves the cut without eating the
 *       kill. The route accepts up to 0.9, which would re-cut the material.
 *   `beats_per_phrase` 4 — `AudioBeat.phrase_position` is counted inside a
 *       four-beat phrase by `crates/media/src/audio_intelligence.rs`, so any
 *       other number here would score against a grid the analysis does not use.
 *   `prefer_strong_boundaries` — the artboard's second card is 「能量曲线在此
 *       处跃升」, i.e. exactly this preference, made visible.
 */
export const BEAT_ALIGNMENT_OPTIONS: BeatAlignmentRequest['options'] = {
  timeline_start_seconds: 0,
  maximum_duration_change_ratio: 0.15,
  beats_per_phrase: 4,
  prefer_strong_boundaries: true,
};

/** Below this, a suggestion is 「对齐」 and gets no card. Same tolerance the
 *  offset column uses, so the table and the cards cannot disagree. */
export const BEAT_SUGGESTION_TOLERANCE_SECONDS = 0.02;

/** `validate_alignment_request` rejects a grid of fewer than two beats. */
const MINIMUM_BEATS = 2;
/** `preferred_beats` is a `u16` bounded at 256 by the same validator. */
const MAXIMUM_PREFERRED_BEATS = 256;

/**
 * How long one beat is.
 *
 * `bpm` first, because it is the analysis's own committed answer; the median
 * gap between beats when it declined to commit (`bpm: null` with a low
 * `tempo_confidence` is a real answer, not an error). `null` when there is not
 * enough of a grid to say — the page then omits `preferred_beats` rather than
 * inventing a span.
 */
export function beatPeriodSeconds(analysis: AudioAnalysis): number | null {
  if (analysis.bpm !== null && Number.isFinite(analysis.bpm) && analysis.bpm > 0) {
    return 60 / analysis.bpm;
  }
  const gaps: number[] = [];
  for (let index = 1; index < analysis.beats.length; index += 1) {
    const previous = analysis.beats[index - 1] as AudioBeat;
    const beat = analysis.beats[index] as AudioBeat;
    const gap = beat.time_seconds - previous.time_seconds;
    if (gap > 0) gaps.push(gap);
  }
  if (gaps.length === 0) return null;
  gaps.sort((left, right) => left - right);
  return gaps[Math.floor(gaps.length / 2)] ?? null;
}

/**
 * Why the page cannot ask for suggestions yet. `null` means it can.
 *
 * A closed set so the button's written reason is a lookup rather than a
 * sentence assembled at three call sites.
 */
export type BeatRequestObstacle = 'no-clips' | 'no-beats' | 'unknown-durations';

export interface BeatAlignmentPlan {
  readonly request: BeatAlignmentRequest;
}

/**
 * The request, or why there is not one.
 *
 * **Every clip or none.** The aligner walks its clip list with a cursor, so a
 * request missing the third clip would place the fourth where the third should
 * have been. A project whose recorded-clip list has not loaded therefore waits
 * rather than asking a question it would misread the answer to.
 */
export function buildBeatAlignmentRequest(
  project: MontageProjectRecord,
  durations: ClipDurationLookup,
  analysis: AudioAnalysis,
): BeatAlignmentPlan | BeatRequestObstacle {
  const ordered = [...project.clips].sort((left, right) => left.order - right.order);
  if (ordered.length === 0) return 'no-clips';
  if (analysis.beats.length < MINIMUM_BEATS) return 'no-beats';

  const period = beatPeriodSeconds(analysis);
  const clips: BeatAlignmentRequest['clips'] = [];

  for (const clip of ordered) {
    const current = clipDurationSeconds(clip, durations);
    const source = durations[clip.clip_id];
    if (current === null || current <= 0 || source === undefined) return 'unknown-durations';

    /* What is left of the take from the in-point — the clamp
       `applyBeatDraftToProject` applies, expressed as the aligner's idea of
       「how much material there is」. */
    const available = Math.max(current, source - clip.trim_start);
    const ratio = BEAT_ALIGNMENT_OPTIONS.maximum_duration_change_ratio;
    const minimum = Math.max(Number.EPSILON, current * (1 - ratio));
    const maximum = Math.min(available, current * (1 + ratio));
    const span = period === null ? null : Math.round(current / period);

    clips.push({
      clip_id: clip.clip_id,
      source_duration_seconds: available,
      minimum_duration_seconds: minimum,
      maximum_duration_seconds: Math.max(minimum, maximum),
      ...(span !== null && span >= 1 && span <= MAXIMUM_PREFERRED_BEATS
        ? { preferred_beats: span }
        : {}),
    });
  }

  return { request: { beats: analysis.beats, clips, options: BEAT_ALIGNMENT_OPTIONS } };
}

/* ── what a draft says about this project ────────────────────────────────── */

export interface BeatSuggestion {
  readonly clipId: string;
  /** 「片段 02」 — one-based, in `order`. */
  readonly position: number;
  /** Where the clip currently ends up on the finished timeline. */
  readonly currentDurationSeconds: number;
  readonly plannedDurationSeconds: number;
  /** `planned - current`. Signed; the card prints it with `formatBeatOffset`. */
  readonly deltaSeconds: number;
  /** One-based, matching `beatOrdinal`. */
  readonly startBeat: number;
  readonly endBeat: number;
  /** The service's English sentences, printed verbatim under a Chinese label. */
  readonly rationale: readonly string[];
}

/**
 * One card per clip the draft would actually change.
 *
 * A clip already on a beat produces no card — the artboard's table prints
 * 「对齐」 for it and a card offering to change nothing is noise. Clips in
 * `unplaced_clip_ids` produce no card either: the aligner could not fit them,
 * `applyBeatDraftToProject` skips them, and a card would promise an edit that
 * would not happen. The page reports their count separately instead.
 */
export function readBeatSuggestions(
  project: MontageProjectRecord,
  durations: ClipDurationLookup,
  draft: BeatAlignmentDraft,
): BeatSuggestion[] {
  const unplaced = new Set(draft.unplaced_clip_ids);
  const ordered = [...project.clips].sort((left, right) => left.order - right.order);
  const positions = new Map(ordered.map((clip, index) => [clip.clip_id, index + 1] as const));
  const byClip = new Map(ordered.map((clip) => [clip.clip_id, clip] as const));

  const suggestions: BeatSuggestion[] = [];
  for (const planned of draft.clips) {
    if (unplaced.has(planned.clip_id)) continue;
    const clip = byClip.get(planned.clip_id);
    const position = positions.get(planned.clip_id);
    if (clip === undefined || position === undefined) continue;

    const current = clipDurationSeconds(clip, durations);
    if (current === null) continue;

    const limit = clip.trim_start + planned.source_duration_seconds;
    const applied = Math.min(clip.trim_start + planned.planned_duration_seconds, limit) - clip.trim_start;
    const delta = applied - current;
    if (Math.abs(delta) < BEAT_SUGGESTION_TOLERANCE_SECONDS) continue;

    suggestions.push({
      clipId: planned.clip_id,
      position,
      currentDurationSeconds: current,
      plannedDurationSeconds: applied,
      deltaSeconds: delta,
      startBeat: planned.start_beat_index + 1,
      endBeat: planned.end_beat_index + 1,
      rationale: planned.rationale,
    });
  }
  return suggestions;
}

/**
 * The document a suggestion *would* produce — for rendering, never for saving.
 *
 * Deliberately the same transform 「应用」 sends to the server, so what the
 * preview shows and what the save writes cannot drift. The difference between
 * the two is entirely in where the result goes: here, into a `useState`;
 * there, into `saveMontageProject`'s `edit`, applied to a freshly re-read
 * document.
 */
export function previewBeatDraft(
  project: MontageProjectRecord,
  draft: BeatAlignmentDraft,
  clipIds: readonly string[],
): MontageProjectRecord {
  return applyBeatDraftToProject(project, draft, clipIds);
}
