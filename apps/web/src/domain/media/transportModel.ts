/*
 * Domain layer, layer 2 of 3 — media: the arithmetic behind `Transport`.
 *
 * No React, no DOM, no clock. Everything a playback control bar has to
 * compute — the next frame, the previous frame, where a time sits along a
 * duration — is here so it can be exhausted in the node project, the same
 * split `design/timeline` uses (see its README §「架构」).
 *
 * Timecode *formatting* is deliberately absent: `formatTimecode` and
 * `formatFrameTimecode` already exist in `design/timeline/timeScale.ts` and
 * `Transport` imports them from there. Two timecode functions in one codebase
 * is how a monitor and a ruler start disagreeing about what 00:31 means.
 */

import { TIME_EPSILON } from '../../design/timeline';

/**
 * The project frame rate the artboards assume. 「10 多轨编辑器」's export panel
 * reads 「60 fps」 and its monitor reads `00:00:31:12`, a frame field that only
 * reaches 12 at a rate above 12.
 */
export const DEFAULT_FPS = 60;

/**
 * Seconds into `[0, duration]`. A NaN time is 0 rather than propagating:
 * every position derived from it would otherwise be NaN, and a transport that
 * renders `NaN:NaN` tells the user nothing about what went wrong.
 */
export function clampTime(seconds: number, durationSeconds: number): number {
  if (!Number.isFinite(seconds)) return 0;
  const end = Number.isFinite(durationSeconds) && durationSeconds > 0 ? durationSeconds : 0;
  return Math.min(end, Math.max(0, seconds));
}

/** Seconds one frame lasts. A non-positive or non-finite rate falls back. */
export function frameDuration(fps: number = DEFAULT_FPS): number {
  return 1 / (Number.isFinite(fps) && fps > 0 ? fps : DEFAULT_FPS);
}

export interface FrameStepOptions {
  readonly fps?: number;
  readonly durationSeconds: number;
}

/**
 * `frames` frames forward (positive) or back (negative) from `seconds`,
 * clamped to the media.
 *
 * The step is taken on the *frame index*, not on the raw seconds: repeatedly
 * adding 1/60 to a float drifts, and after a few hundred steps the readout
 * starts landing a frame away from where the count says it is.
 */
export function stepFrames(seconds: number, frames: number, options: FrameStepOptions): number {
  const { fps = DEFAULT_FPS, durationSeconds } = options;
  if (!Number.isFinite(frames) || frames === 0) return clampTime(seconds, durationSeconds);
  const step = frameDuration(fps);
  const index = frameIndexAt(clampTime(seconds, durationSeconds), fps);
  return clampTime((index + Math.trunc(frames)) * step, durationSeconds);
}

/**
 * Which frame a time is inside. `TIME_EPSILON` — the same slack the timeline
 * compares times with — keeps a stored 0.049999999 from reading as frame 2.
 */
export function frameIndexAt(seconds: number, fps: number = DEFAULT_FPS): number {
  if (!Number.isFinite(seconds) || seconds <= 0) return 0;
  return Math.floor(seconds / frameDuration(fps) + TIME_EPSILON);
}

/**
 * Where a time sits along a duration, in `[0, 1]`. A zero or absent duration
 * gives 0: the alternative is a division that paints a playhead at Infinity%.
 */
export function progressRatio(seconds: number, durationSeconds: number): number {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return 0;
  return clampTime(seconds, durationSeconds) / durationSeconds;
}

/**
 * The same ratio as a CSS percentage string. Rounded to four decimals — a
 * sub-micron of a 1920px monitor — so that markup assertions are stable and a
 * float never reaches the DOM as `33.33333333333333%`.
 */
export function progressPercent(seconds: number, durationSeconds: number): string {
  return `${Number((progressRatio(seconds, durationSeconds) * 100).toFixed(4))}%`;
}

/**
 * The playback rates the transport offers. 1 first among equals: the artboard's
 * 速度 row reads 「100%」 and every other stop is a multiple of it.
 */
export const DEFAULT_PLAYBACK_RATES = [0.25, 0.5, 1, 2] as const;

/** `0.25` → `0.25×`, `1` → `1×`. The rate labels, in one place. */
export function formatRate(rate: number): string {
  if (!Number.isFinite(rate)) return '1×';
  return `${Number(rate.toFixed(2))}×`;
}
