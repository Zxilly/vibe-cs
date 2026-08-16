/*
 * pages/montage — the 包装 and 导出 vocabulary, and the arithmetic behind
 * 「预计 2 分 04 秒」.
 *
 * Pure, so `montageSettings.test.ts` exhausts it in the `unit` project with no
 * DOM. Everything here is either a *closed set the wire has* or a *computation
 * the renderer already performs*; nothing is invented.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  画质策略 → `MontageSettingsRecord.quality`, and where the three numbers
 *  come from
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The artboard draws three radio buttons (速度优先 / 均衡 / 画质优先) and the
 * wire has one number, `quality: u8`, validated as `<= 100`
 * (`crates/application/src/routes/media.rs`, `validate_montage_project`). The
 * mapping is **not** invented here — it is read off the encoder:
 *
 *   `crates/media/src/plan.rs`, `quality_to_crf`:
 *       crf = 35 - quality / 4        (integer division, quality clamped to 100)
 *
 * So `quality` is a CRF dial in disguise, running from CRF 35 (worst) at 0 to
 * CRF 10 (best) at 100, in steps of one CRF per four points of `quality`. That
 * gives every tier below an exact, checkable CRF, and each is a multiple of
 * four so the integer division lands on the step rather than between two:
 *
 *   speed     quality 60  → CRF 20   visibly compressed, encodes fastest
 *   balanced  quality 80  → CRF 15   **the domain default** —
 *                                    `MontageSettings::default()` in
 *                                    `crates/domain/src/recording.rs` is 80,
 *                                    so 「均衡」 is literally what a project
 *                                    gets when nobody chooses
 *   quality   quality 92  → CRF 12   near the point where more bits stop
 *                                    showing; 100 (CRF 10) was not taken
 *                                    because the last two steps cost size
 *                                    without a visible return
 *
 * `encoder` is the literal `'auto'` on the wire, so there is no encoder choice
 * to make and `quality` is the whole of 画质策略 (contract gap 7).
 */

import { msg } from '@lingui/core/macro';
import type { MessageDescriptor } from '@lingui/core';

import type { MontageEditFn } from '../../data/montage';
import type {
  MontageClipRecord,
  MontageProjectRecord,
  MontageSettingsRecord,
} from '../../shared/desktop/dto';
import { clipDurationSeconds, type ClipDurationLookup } from './montageContract';

/* ── 画质策略 ────────────────────────────────────────────────────────────── */

export const MONTAGE_QUALITY_TIERS = ['speed', 'balanced', 'quality'] as const;
export type MontageQualityTier = (typeof MONTAGE_QUALITY_TIERS)[number];

/** The three dial positions. See the header for the derivation. */
export const MONTAGE_QUALITY_VALUE: Readonly<Record<MontageQualityTier, number>> = {
  speed: 60,
  balanced: 80,
  quality: 92,
};

export const MONTAGE_QUALITY_LABEL: Readonly<Record<MontageQualityTier, MessageDescriptor>> = {
  speed: msg`速度优先`,
  balanced: msg`均衡`,
  quality: msg`画质优先`,
};

/**
 * `crates/media/src/plan.rs`'s `quality_to_crf`, reproduced so the panel can
 * print the CRF it is actually asking for instead of a marketing word. If that
 * function changes, this one is wrong and its test says so loudly.
 */
export function qualityToCrf(quality: number): number {
  const clamped = Math.max(0, Math.min(100, Math.trunc(quality)));
  return 35 - Math.trunc(clamped / 4);
}

/**
 * Which of the three a stored `quality` reads as.
 *
 * A project may hold any value in 0..=100 — the wire allows it, and a project
 * created by something other than this page will. Rather than silently
 * rewriting it on the first save, the nearest tier is *shown as selected* and
 * the exact stored number is printed beside it, so a project at 74 does not
 * look like it is at 80.
 *
 * Ties go to the lower tier: at the midpoint the cheaper encode is the smaller
 * surprise.
 */
export function qualityTierOf(quality: number): MontageQualityTier {
  let best: MontageQualityTier = MONTAGE_QUALITY_TIERS[0];
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const tier of MONTAGE_QUALITY_TIERS) {
    const distance = Math.abs(quality - MONTAGE_QUALITY_VALUE[tier]);
    if (distance < bestDistance) {
      best = tier;
      bestDistance = distance;
    }
  }
  return best;
}

/** `true` when the stored number is one of the three this page can express. */
export function qualityIsExactTier(quality: number): boolean {
  return MONTAGE_QUALITY_TIERS.some((tier) => MONTAGE_QUALITY_VALUE[tier] === quality);
}

/* ── 片段转场 ────────────────────────────────────────────────────────────── */

/**
 * `MontageClipRecord.transition` is a free `String` on the wire, but the
 * renderer's `parse_transition` (`crates/media/src/plan.rs`) accepts a closed
 * set and **400s on anything else** — so the page offers exactly that set. The
 * ten canonical spellings, in the order the parser lists them:
 */
export const MONTAGE_TRANSITIONS = [
  'cut',
  'fade',
  'flash',
  'dip',
  'zoom',
  'wipe',
  'slide',
  'blur',
  'glitch',
  'spin',
] as const;
export type MontageTransition = (typeof MONTAGE_TRANSITIONS)[number];

/*
 * `slide` is contextualised because 「滑移」 is already the *slip edit tool* in
 * `design/timeline/TimelinePrototype.tsx`, and English forks the two: a slip
 * edit is "Slip", a slide transition is "Slide". One msgid cannot be both.
 */
export const MONTAGE_TRANSITION_LABEL: Readonly<Record<MontageTransition, MessageDescriptor>> = {
  cut: msg`硬切`,
  fade: msg`交叉淡化`,
  flash: msg`闪白`,
  dip: msg`过黑`,
  zoom: msg`推近`,
  wipe: msg`划像`,
  slide: msg({ message: '滑移', context: 'video-transition' }),
  blur: msg`模糊`,
  glitch: msg`故障`,
  spin: msg`旋转`,
};

/**
 * The parser's aliases, so a project stored as `dissolve` selects 交叉淡化
 * rather than falling off the end of the list. `null` for a value the renderer
 * would reject: the page shows it verbatim and says the export will refuse it,
 * which is better than silently rewriting a field the user did not touch.
 */
export function normaliseTransition(value: string): MontageTransition | null {
  const key = value.trim().toLowerCase();
  if (key === '' || key === 'none') return 'cut';
  if (key === 'dissolve') return 'fade';
  if (key === 'whip' || key === 'slideleft') return 'slide';
  return (MONTAGE_TRANSITIONS as readonly string[]).includes(key) ? (key as MontageTransition) : null;
}

/** The one transition every clip shares, or `null` when they differ. */
export function sharedTransition(project: MontageProjectRecord): MontageTransition | null {
  const kinds = new Set(project.clips.map((clip) => normaliseTransition(clip.transition)));
  if (kinds.size !== 1) return null;
  const [only] = [...kinds];
  return only ?? null;
}

/* ── 分辨率 ──────────────────────────────────────────────────────────────── */

/** 「1920×1080」. The multiplication sign is U+00D7, as the artboard draws it. */
export function formatResolution(width: number, height: number): string {
  return `${width}×${height}`;
}

/**
 * The resolutions the panel offers. Not a wire enum — `width` / `height` are
 * free integers bounded at 16384 — so this is a *convenience list*, and a
 * project outside it keeps its own numbers and gets them printed.
 */
export const MONTAGE_RESOLUTIONS: readonly (readonly [number, number])[] = [
  [1920, 1080],
  [2560, 1440],
  [3840, 2160],
  [1280, 720],
];

/** Likewise for 帧率. `validate_montage_project` accepts 1..=240. */
export const MONTAGE_FRAME_RATES: readonly number[] = [30, 60, 120];

/* ── 预计时长 ────────────────────────────────────────────────────────────── */

/**
 * Why a *size* estimate is not here.
 *
 * The artboard prints 「预计 2 分 04 秒 · 约 540 MB」. The duration is real —
 * it is computed below exactly as the renderer computes it — and the size is
 * **not available and not estimable**. `quality` selects a CRF, and CRF is
 * constant-*quality*: the bitrate is whatever the content needs, and a static
 * scoreboard and a smoke-filled 1v3 at the same CRF differ by several times.
 * A bitrate × duration guess would therefore be wrong in the direction users
 * act on — 「约 540 MB」 is what somebody reads before deciding whether to free
 * disk space. So the field is omitted, and the omission is recorded as a
 * backend gap rather than papered over with a number.
 */

export const MONTAGE_EXPORT_BLOCKERS = [
  'no-clips',
  'intro-title-missing',
  'outro-title-missing',
  'transition-too-long',
  'unsupported-transition',
] as const;
export type MontageExportBlocker = (typeof MONTAGE_EXPORT_BLOCKERS)[number];

/**
 * Why 「生成视频」 would fail, in the renderer's own words.
 *
 * Every one of these is a check `crates/media/src/plan.rs` performs while
 * building the filter graph — that is, *after* the job has been accepted, so
 * the failure would otherwise arrive as a red task row minutes later. Running
 * them here turns a late failure into a disabled button with a reason, which
 * is the 「禁用并写明原因」 rule applied to something the page can actually know.
 */
export const MONTAGE_EXPORT_BLOCKER_REASON: Readonly<
  Record<MontageExportBlocker, MessageDescriptor>
> = {
  'no-clips': msg`这份合辑还没有片段`,
  'intro-title-missing': msg`片头已开启但没有标题，渲染会拒绝`,
  'outro-title-missing': msg`片尾已开启但没有标题，渲染会拒绝`,
  'transition-too-long': msg`转场时长超过了相邻片段，渲染会拒绝`,
  'unsupported-transition': msg`有片段的转场名称渲染器不认识`,
};

export interface MontageRenderPlan {
  /**
   * What the finished file will run to. `null` when a clip's source length is
   * still unknown (contract gap 4) — 「时长待定」, never a total missing a clip.
   */
  readonly durationSeconds: number | null;
  readonly blockers: readonly MontageExportBlocker[];
}

/**
 * `montage_duration` from `crates/media/src/plan.rs`, plus the validations
 * around it.
 *
 * The rule that makes this worth reproducing: **a non-cut transition overlaps
 * the two clips it joins**, so it is *subtracted* from the running total. A
 * page that added up clip lengths would over-report every fading montage.
 */
export function montageRenderPlan(
  project: MontageProjectRecord,
  durations: ClipDurationLookup,
): MontageRenderPlan {
  const { settings } = project;
  const blockers = new Set<MontageExportBlocker>();

  if (project.clips.length === 0) blockers.add('no-clips');
  if (settings.intro_duration_seconds > 0 && (settings.intro_title ?? '').trim() === '') {
    blockers.add('intro-title-missing');
  }
  if (settings.outro_duration_seconds > 0 && (settings.outro_title ?? '').trim() === '') {
    blockers.add('outro-title-missing');
  }

  const ordered = [...project.clips].sort((left, right) => left.order - right.order);
  let total: number | null = settings.intro_duration_seconds;

  ordered.forEach((clip, index) => {
    const kind = normaliseTransition(clip.transition);
    if (kind === null) blockers.add('unsupported-transition');

    const length = clipDurationSeconds(clip, durations);
    if (index > 0 && kind !== null && kind !== 'cut') {
      const transition = settings.transition_seconds;
      /* The renderer's own condition, both halves of it. Only checkable once
         the lengths are known; an unknown length is not a blocker, because the
         service resolves it from the file and may well be fine. */
      if ((total !== null && transition >= total) || (length !== null && transition >= length)) {
        blockers.add('transition-too-long');
      }
      if (total !== null) total -= transition;
    }
    total = total === null || length === null ? null : total + length;
  });

  return {
    durationSeconds: total === null ? null : total + settings.outro_duration_seconds,
    blockers: [...blockers],
  };
}

/* ── a new project ───────────────────────────────────────────────────────── */

/**
 * What 「新建合辑」 sends.
 *
 * `POST /api/montage/projects` takes the whole settings block — there is no
 * server-side default applied to a create — so this is
 * `MontageSettings::default()` from `crates/domain/src/recording.rs`, field for
 * field. Copied rather than guessed: a create that sent `quality: 100` would
 * silently give every new project a different encode than one made anywhere
 * else in the product.
 */
export function defaultMontageSettings(): MontageSettingsRecord {
  return {
    width: 1920,
    height: 1080,
    fps: 60,
    encoder: 'auto',
    quality: MONTAGE_QUALITY_VALUE.balanced,
    background_music: null,
    music_volume: 0.25,
    transition_seconds: 0.35,
    intro_title: null,
    intro_duration_seconds: 0,
    include_name_cards: false,
    name_card_duration_seconds: 2.5,
    outro_title: null,
    outro_duration_seconds: 0,
    branding_theme: 'vibe',
  };
}

/** 片头 / 片尾 default to three seconds — the artboard's 「片头（3 秒）」. */
export const MONTAGE_TITLE_CARD_SECONDS = 3;

/* ── the edits ───────────────────────────────────────────────────────────── */

/**
 * Every write on this page is an edit function handed to `props.project.save`,
 * which applies it to a **freshly re-read** document (contract invariant 3).
 * That is what lets 包装 and 导出 both write `settings` without the second
 * undoing the first — but only if the edit is expressed as *a change to
 * whatever is current*, never as a whole document captured at render time.
 * Every builder below takes `current` and returns a copy; none of them closes
 * over a project.
 */
export function editMontageSettings(patch: Partial<MontageSettingsRecord>): MontageEditFn {
  return (current) => ({ ...current, settings: { ...current.settings, ...patch } });
}

/** 片段转场 is per clip on the wire and one control on the artboard. */
export function editAllTransitions(transition: MontageTransition): MontageEditFn {
  return (current) => ({
    ...current,
    clips: current.clips.map((clip) => ({ ...clip, transition })),
  });
}

export interface ClipTrim {
  readonly trimStart: number;
  /** `null` is 「到素材末尾」, a real value rather than 「未设置」. */
  readonly trimEnd: number | null;
}

export function editClipTrim(clipId: string, trim: ClipTrim): MontageEditFn {
  return (current) => ({
    ...current,
    clips: current.clips.map((clip) =>
      clip.clip_id === clipId
        ? { ...clip, trim_start: trim.trimStart, trim_end: trim.trimEnd }
        : clip,
    ),
  });
}

/** 清空片段 and 移除这一段 — destructive, so the page confirms first. */
export function editRemoveClips(clipIds: readonly string[]): MontageEditFn {
  const removing = new Set(clipIds);
  return (current) => ({
    ...current,
    clips: current.clips
      .filter((clip) => !removing.has(clip.clip_id))
      .sort((left, right) => left.order - right.order)
      .map((clip, index) => ({ ...clip, order: index })),
  });
}

/**
 * 「从录制结果添加」. Appends at the end, in the order the picker listed them,
 * skipping any take the project already holds — the same recorded clip twice
 * is a legitimate thing to want but not one this dialog can express, and
 * silently creating two rows with the same `clip_id` would make the strip's
 * keys collide.
 */
export function editAppendClips(
  clipIds: readonly string[],
  transition: MontageTransition = 'cut',
): MontageEditFn {
  return (current) => {
    const held = new Set(current.clips.map((clip) => clip.clip_id));
    const ordered = [...current.clips].sort((left, right) => left.order - right.order);
    const added: MontageClipRecord[] = [];
    for (const clipId of clipIds) {
      if (held.has(clipId)) continue;
      held.add(clipId);
      added.push({
        clip_id: clipId,
        order: 0,
        trim_start: 0,
        trim_end: null,
        transition,
        title: null,
        avatar_asset_id: null,
      });
    }
    if (added.length === 0) return current;
    return {
      ...current,
      clips: [...ordered, ...added].map((clip, index) => ({ ...clip, order: index })),
    };
  };
}
