/*
 * pages/recording — the shot inspector's arithmetic, with no React in it.
 *
 * `recordingContract.ts` owns the *contract* (what a block receives, what a
 * check row means, how flash alpha converts). This file owns the *edits*: what
 * changing 视角 does to two wire fields at once, what 「存为预设」 puts in a
 * draft, what 「应用到全部」 copies, and how a keyboard reorder resolves. All of
 * it is pure and runs in the `unit` project, because every one of these is a
 * rule that is easy to get subtly wrong and impossible to see wrong on screen.
 *
 * ── 视角 is one control over two wire fields ──────────────────────────────
 *
 * The artboard draws 观察者 / 选手 POV / 受害者 as one three-way segment. The
 * wire has no such field: it has `camera_style` (seven members) and
 * `victim_pov` (a boolean), and `crates/domain/src/recording.rs` rejects
 * `victim_pov` on any style but `pov`. So the segment is derived, and — this is
 * the part worth writing down — **moving it edits both fields together**:
 *
 *   观察者    a non-POV style, `victim_pov: false`
 *   选手 POV  `camera_style: 'pov'`, `victim_pov: false`
 *   受害者    `camera_style: 'pov'`, `victim_pov: true`
 *
 * Leaving 受害者 for 观察者 therefore has to clear `victim_pov` in the same
 * patch, or the request is a 400 the interface produced itself.
 *
 * ── and the field of view goes with it ────────────────────────────────────
 *
 * Leaving POV also has to neutralise `camera_fov` / `viewmodel_fov`
 * (`presentationForStyle`), because an observer shot carrying a non-neutral
 * field of view is rejected outright rather than ignored. The two are done in
 * one function here so a call site cannot do one and forget the other.
 */

import { msg } from '@lingui/core/macro';
import type { MessageDescriptor } from '@lingui/core';

import { moveItem } from '../../domain/media';
import type {
  RecordingPresentation,
  RecordingRequest,
  RecordingShotPreset,
  RecordingShotPresetDraft,
  RecordingVoicePolicy,
} from '../../shared/desktop/dto';
import {
  isPovStyle,
  presentationForStyle,
  resolveShotPresentation,
  type CameraStyle,
  type RecordingDefaults,
} from './recordingContract';

/* ── the seven camera styles ─────────────────────────────────────────────── */

/**
 * `RecordingRequest['camera_style']`, labelled once and exhaustively.
 *
 * A total `Record` over the union, so a style added to the wire fails to
 * compile here instead of rendering as a raw `flyby`. The precedent is
 * `domain/match/matchEnums.ts`; the `hint` is the artboard's own second line
 * (「沿真实移动轴跟随，适合交代路线」), which is what makes the control readable
 * by someone who does not already know what a dolly is.
 *
 * No `context` tag. None of these words collides with an existing catalogue
 * entry, and opening a group for a table that does not fork only splits
 * translations that should move together.
 */
export interface CameraStyleMeta {
  readonly label: MessageDescriptor;
  readonly hint: MessageDescriptor;
}

export const CAMERA_STYLE: Readonly<Record<CameraStyle, CameraStyleMeta>> = {
  pov: {
    label: msg`选手 POV`,
    hint: msg`用选手自己的视线，最接近他当时看到的画面`,
  },
  static: {
    label: msg`固定机位`,
    hint: msg`机位不动，适合交代地点与站位`,
  },
  tracking: {
    label: msg`跟随`,
    hint: msg`沿真实移动轴跟随，适合交代路线`,
  },
  orbit: {
    label: msg`环绕`,
    hint: msg`绕着目标转，适合停在一次交火上`,
  },
  dolly: {
    label: msg`推轨`,
    hint: msg`沿一条直线平移，适合进场与收尾`,
  },
  crane: {
    label: msg`升降`,
    hint: msg`从低处升起或从高处落下，适合高潮之后`,
  },
  flyby: {
    label: msg`掠过`,
    hint: msg`快速掠过一段空间，适合两个地点之间的过渡`,
  },
};

/** Draw order of the dropdown: POV first, then the six observer styles in the
 *  order the artboard's own shot list uses them. */
export const CAMERA_STYLES: readonly CameraStyle[] = [
  'pov',
  'static',
  'tracking',
  'orbit',
  'dolly',
  'crane',
  'flyby',
];

/* ── 视角 ────────────────────────────────────────────────────────────────── */

export type ShotView = 'observer' | 'player_pov' | 'victim_pov';

export const SHOT_VIEW: Readonly<Record<ShotView, MessageDescriptor>> = {
  observer: msg`观察者`,
  player_pov: msg`选手 POV`,
  victim_pov: msg`受害者`,
};

export const SHOT_VIEWS: readonly ShotView[] = ['observer', 'player_pov', 'victim_pov'];

/** Which of the three the two wire fields add up to. */
export function shotViewOf(item: Pick<RecordingRequest, 'camera_style' | 'victim_pov'>): ShotView {
  if (!isPovStyle(item.camera_style)) return 'observer';
  return item.victim_pov ? 'victim_pov' : 'player_pov';
}

/**
 * The style an observer shot falls back to when the user leaves POV.
 *
 * 「跟随」 rather than 「固定机位」 because it is the one observer style that
 * works on any tick window: a static camera with no chosen position is a camera
 * pointed at nothing, whereas a tracking shot always has a subject — the player
 * the request already names.
 */
export const DEFAULT_OBSERVER_STYLE: CameraStyle = 'tracking';

/**
 * Moving the 视角 segment, as a patch over the whole request.
 *
 * Returns every field the move touches — `camera_style`, `victim_pov` and, when
 * the move leaves POV, the neutralised `presentation`. A caller that applied
 * only the first of those would be building a request the backend refuses.
 */
export function patchShotView(
  item: RecordingRequest,
  view: ShotView,
  defaults: RecordingDefaults,
): Partial<RecordingRequest> {
  if (view === 'observer') {
    const style = isPovStyle(item.camera_style) ? DEFAULT_OBSERVER_STYLE : item.camera_style;
    return patchCameraStyle(item, style, defaults);
  }

  const victim = view === 'victim_pov';
  if (isPovStyle(item.camera_style) && item.victim_pov === victim) return {};
  return { camera_style: 'pov', victim_pov: victim };
}

/**
 * Choosing a style from the dropdown, as a patch.
 *
 * Leaving POV drags two other fields with it: `victim_pov` cannot survive
 * (the backend rejects it on a non-POV style) and the two fields of view have
 * to go back to neutral. The presentation is only written when the shot already
 * carried one — a shot following the global defaults keeps following them,
 * because `presentation: null` and 「等于今天的默认值」 are different states and
 * this edit is not the user asking to detach.
 */
export function patchCameraStyle(
  item: RecordingRequest,
  style: CameraStyle,
  defaults: RecordingDefaults,
): Partial<RecordingRequest> {
  if (style === item.camera_style) return {};
  if (isPovStyle(style)) return { camera_style: style };

  const patch: Partial<RecordingRequest> = { camera_style: style, victim_pov: false };
  const presentation = item.presentation;
  if (presentation !== null && presentation !== undefined) {
    patch.presentation = presentationForStyle(presentation, style);
  } else {
    /* A shot that never had one still needs the neutral pair sent, because the
       global defaults may carry a POV field of view and the queue is validated
       per item. Expanding the defaults here is the one place `null` is turned
       into a concrete presentation without the user asking. */
    patch.presentation = presentationForStyle(
      resolveShotPresentation(null, defaults).value,
      style,
    );
  }
  return patch;
}

/**
 * Editing one presentation control, as a patch.
 *
 * The whole presentation is written every time, expanded from the global
 * defaults when the shot had none: the wire field is an object, not a set of
 * independent columns, so a partial write is not expressible. That expansion is
 * exactly 「detach from the global default」, and it happens the moment the user
 * moves any one of the six — which is the behaviour the two states exist to
 * make possible.
 */
export function patchPresentation(
  item: RecordingRequest,
  change: Partial<RecordingPresentation>,
  defaults: RecordingDefaults,
): Partial<RecordingRequest> {
  const current = resolveShotPresentation(item.presentation, defaults).value;
  return {
    presentation: presentationForStyle({ ...current, ...change }, item.camera_style),
  };
}

/** 「跟随全局默认」 again — the way back from an override. */
export function detachedPresentationPatch(): Partial<RecordingRequest> {
  return { presentation: null };
}

/* ── presets ─────────────────────────────────────────────────────────────── */

/**
 * 「存为预设」's payload.
 *
 * A preset holds only shot-scoped settings — no Demo, no player, no tick window,
 * no title — which is what makes 「应用到全部」 safe: applying one can never
 * retarget a shot at different footage. The presentation is always concrete
 * here (`RecordingShotPreset.presentation` is not nullable), so a shot that was
 * following the defaults has them expanded at save time: a preset that meant
 * 「whatever the global default is that day」 would change under its own name.
 */
export function presetDraftFromShot(
  item: RecordingRequest,
  name: string,
  defaults: RecordingDefaults,
): RecordingShotPresetDraft {
  const presentation = resolveShotPresentation(item.presentation, defaults).value;
  return {
    name,
    camera_style: item.camera_style,
    victim_pov: item.victim_pov,
    pre_roll_seconds: item.pre_roll_seconds,
    post_roll_seconds: item.post_roll_seconds,
    presentation: presentationForStyle(presentation, item.camera_style),
  };
}

/**
 * Applying a preset to one shot, as a patch.
 *
 * 「应用时作为一次原子变更」 (「补齐 · 规范与状态」): every field moves or none
 * does, which is what a single patch object gives. The presentation is
 * re-neutralised against the preset's own style rather than the shot's, because
 * the style is part of what is being applied.
 */
export function presetPatch(preset: RecordingShotPreset): Partial<RecordingRequest> {
  return {
    camera_style: preset.camera_style,
    victim_pov: preset.victim_pov,
    pre_roll_seconds: preset.pre_roll_seconds,
    post_roll_seconds: preset.post_roll_seconds,
    presentation: presentationForStyle(preset.presentation, preset.camera_style),
  };
}

/**
 * 「应用到全部」's patch, derived from the shot the inspector is open on.
 *
 * Deliberately **not** the whole request: copying `demo_id`, `player_id`, the
 * tick window or the title onto every other shot would silently retarget four
 * clips at one moment of one Demo. What travels is what a preset would travel —
 * the same set, for the same reason.
 */
export function applyToAllPatch(
  item: RecordingRequest,
  defaults: RecordingDefaults,
): Partial<RecordingRequest> {
  const presentation = resolveShotPresentation(item.presentation, defaults).value;
  return {
    camera_style: item.camera_style,
    victim_pov: item.victim_pov,
    pre_roll_seconds: item.pre_roll_seconds,
    post_roll_seconds: item.post_roll_seconds,
    presentation: presentationForStyle(presentation, item.camera_style),
  };
}

/* ── ordering ────────────────────────────────────────────────────────────── */

/**
 * Where a shot lands when the keyboard moves it.
 *
 * `domain/media/clipOrder`'s `moveItem` already does the array work and is
 * reused rather than re-derived; what is added here is the *bound*: at either
 * end the answer is the index the shot already has, so `Alt+↑` on the first row
 * is a no-op rather than a wrap to the bottom. A list that wrapped would move a
 * shot four places on a keystroke meant to move it one.
 */
export function nextShotIndex(from: number, delta: number, length: number): number {
  if (length <= 0) return -1;
  if (!Number.isInteger(from) || from < 0 || from >= length) return -1;
  return Math.min(length - 1, Math.max(0, from + delta));
}

/** The reorder itself, so a page never calls `moveItem` with an unbounded
 *  index and so both the pointer and the keyboard path go through one door. */
export function reorderShots<T extends RecordingRequest>(
  items: readonly T[],
  from: number,
  to: number,
): T[] {
  return moveItem(items, from, to);
}

/* ── shot facts the list prints ──────────────────────────────────────────── */

/**
 * 「3.0s」 — the shot's own length.
 *
 * **Ticks alone cannot answer this.** `RecordingRequest` carries a tick window
 * and nothing carries the Demo's tick rate onto this page, so a duration is
 * only available when the caller has one from elsewhere (the Agent plan's
 * `AgentPlanShot.duration_seconds`, which the server computed against the real
 * rate). `null` means 「不知道」 and the list omits the column rather than
 * printing a 64-tick guess — 「后端没有的字段一律省略」.
 */
export function shotDurationSeconds(
  item: Pick<RecordingRequest, 'start_tick' | 'end_tick'>,
  tickRate: number | null,
): number | null {
  if (tickRate === null || !Number.isFinite(tickRate) || tickRate <= 0) return null;
  const ticks = item.end_tick - item.start_tick;
  if (!Number.isFinite(ticks) || ticks < 0) return null;
  return ticks / tickRate;
}

/** Total of the shots whose length is known, plus how many are not. */
export interface ShotDurationTotal {
  readonly seconds: number;
  readonly unknownCount: number;
}

export function totalShotSeconds(
  items: readonly RecordingRequest[],
  durationOf: (item: RecordingRequest) => number | null,
): ShotDurationTotal {
  let seconds = 0;
  let unknownCount = 0;
  for (const item of items) {
    const value = durationOf(item);
    if (value === null) unknownCount += 1;
    else seconds += value;
  }
  return { seconds, unknownCount };
}

/* ── voice ───────────────────────────────────────────────────────────────── */

/**
 * 「队内语音」, which the artboard draws as a switch and the wire spells as a
 * three-member enum.
 *
 * Kept as three options rather than folded into a toggle: `target_only` —
 * 「只留这名选手的语音」 — is the setting a single-player highlight usually
 * wants, and a two-state control would either hide it or silently pick it. The
 * deviation from the artboard is deliberate and is the same reason the wire
 * chose an enum over two booleans.
 */
export const VOICE_POLICY: Readonly<Record<RecordingVoicePolicy, MessageDescriptor>> = {
  all_players: msg`全部选手`,
  target_only: msg`只留目标选手`,
  muted: msg`静音`,
};

export const VOICE_POLICIES: readonly RecordingVoicePolicy[] = [
  'all_players',
  'target_only',
  'muted',
];
