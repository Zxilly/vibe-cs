/*
 * Domain layer, 2 of 3 — match/, the tick ⇄ second ⇄ timecode boundary.
 *
 * ── Why this module exists at all ────────────────────────────────────────
 *
 * `design/timeline/timeScale.ts` already formats a timecode, and it is reused
 * here rather than reimplemented (`formatTimecode`, `formatFrameTimecode` are
 * imported below). What it does **not** have is the tick: the editor's axis is
 * float seconds because a clip's in-point is a position on a media file, while
 * a match's axis is an integer demo tick because every fact the analyser emits
 * — a kill, a plant, a round boundary — is stamped with one. Seconds are a
 * derived, lossy view of that; ticks are the identity that a deep link, an
 * evidence row and a recording request all agree on (spec §4.4, 「URL 是唯一
 * 真值」, carries `tick=` verbatim).
 *
 * So the split is: timeScale owns seconds → text, this module owns ticks →
 * seconds and nothing else duplicates either half. Every function here is pure
 * and free of React and of the DOM, so `matchTime.test.ts` can exhaust the
 * boundaries in the node project (0, negative, past an hour, a non-integer
 * rate).
 *
 * ── The tick rate ────────────────────────────────────────────────────────
 *
 * CS2 records at 64 ticks per second, so `CS2_TICK_RATE` is the default rather
 * than a required argument. It is still only a default: `AnalysisWorkspace`
 * carries a per-demo `tick_rate`, third-party and legacy demos exist at 128,
 * and a corrupt header can hand us 0 or NaN. Every entry point therefore takes
 * an optional rate and falls back rather than dividing by zero.
 */

import { formatFrameTimecode, formatTimecode } from '../../design/timeline/timeScale';

/**
 * CS2's recording rate: 64 ticks per second. Named rather than inlined because
 * it appears in the workspace header as 「64 tick」 product copy as well as in
 * this arithmetic, and the two must never drift.
 */
export const CS2_TICK_RATE = 64;

/**
 * Digit grouping for a tick number. The reference writes 「148 920」 and
 * 「149 340–149 420」 with a space, in mono. A thin space (U+2009) rather than
 * an ordinary one: the group must not become a line-break opportunity in the
 * middle of a number.
 */
export const TICK_GROUP_SEPARATOR = '\u2009';

/** The reference's range dash: an en dash, 「148 920–150 440」. */
export const TICK_RANGE_DASH = '\u2013';

/**
 * A usable rate, or the CS2 default. Zero, negative, NaN and Infinity all mean
 * "the header did not tell us", and a fabricated timecode is worse than the
 * platform default — the design system's rule is 「不静默失败」, and a caller
 * that needs to *say* the rate is unknown reads it off the workspace itself
 * rather than off a division result.
 *
 * Non-integer rates are accepted as they come. They are legal (a rate is a
 * ratio, not a count of anything), and rounding one here would put a silent
 * drift into every derived second.
 */
export function resolveTickRate(tickRate: number = CS2_TICK_RATE): number {
  return Number.isFinite(tickRate) && tickRate > 0 ? tickRate : CS2_TICK_RATE;
}

/** Seconds elapsed since tick 0. Negative ticks stay negative. */
export function tickToSeconds(tick: number, tickRate: number = CS2_TICK_RATE): number {
  if (!Number.isFinite(tick)) return 0;
  return tick / resolveTickRate(tickRate);
}

/**
 * The inverse, rounded to the nearest whole tick — there is no such thing as
 * half a tick in a demo, so a seek target has to land on one. `Math.round`
 * rather than `trunc`, so a seek is never systematically early.
 */
export function secondsToTick(seconds: number, tickRate: number = CS2_TICK_RATE): number {
  if (!Number.isFinite(seconds)) return 0;
  return Math.round(seconds * resolveTickRate(tickRate));
}

/** Seconds spanned by a tick range. Negative when the range runs backwards. */
export function tickRangeSeconds(
  startTick: number,
  endTick: number,
  tickRate: number = CS2_TICK_RATE,
): number {
  return tickToSeconds(endTick, tickRate) - tickToSeconds(startTick, tickRate);
}

/**
 * `mm:ss`, or `h:mm:ss` past the hour — `timeScale.formatTimecode`, fed
 * seconds. This is the form the reference uses for a position inside a round
 * (「00:19」, 「拆包 00:43」).
 */
export function formatTickClock(tick: number, tickRate: number = CS2_TICK_RATE): string {
  return formatTimecode(tickToSeconds(tick, tickRate));
}

/**
 * `hh:mm:ss:ff`, the four-field form of the monitor and the Inspector.
 *
 * The last field is the tick within its second, which is exactly what
 * `formatFrameTimecode`'s frame field computes when it is handed the tick rate
 * as its rate — so the reuse is literal, not approximate. A non-integer rate is
 * rounded for that field only (a field counts whole ticks); the seconds it is
 * derived from keep the exact rate.
 */
export function formatTickTimecode(tick: number, tickRate: number = CS2_TICK_RATE): string {
  const rate = resolveTickRate(tickRate);
  return formatFrameTimecode(tickToSeconds(tick, rate), Math.max(1, Math.round(rate)));
}

/** 「148 920」 — the grouped tick number itself, for the mono tick column. */
export function formatTickCount(tick: number): string {
  if (!Number.isFinite(tick)) return '0';
  const whole = Math.trunc(tick);
  const sign = whole < 0 ? '-' : '';
  const digits = String(Math.abs(whole));

  let grouped = '';
  for (let index = 0; index < digits.length; index += 1) {
    // Separators fall before every third digit counted from the right.
    const fromRight = digits.length - index;
    if (index > 0 && fromRight % 3 === 0) grouped += TICK_GROUP_SEPARATOR;
    grouped += digits[index];
  }
  return `${sign}${grouped}`;
}

/** 「148 920–150 440」, the tick-interval column of the highlight list. */
export function formatTickRange(startTick: number, endTick: number): string {
  return `${formatTickCount(startTick)}${TICK_RANGE_DASH}${formatTickCount(endTick)}`;
}

/**
 * A seconds figure with a fixed number of decimals — 「剩余 1.8 秒」, 「42 秒」.
 * The unit is not appended: it is copy and belongs in a Lingui macro at the
 * call site, where a translator can move it.
 */
export function formatSeconds(seconds: number, fractionDigits = 1): number {
  if (!Number.isFinite(seconds)) return 0;
  const digits = Math.max(0, Math.min(6, Math.trunc(fractionDigits)));
  const factor = 10 ** digits;
  return Math.round(seconds * factor) / factor;
}

/** Duration of a tick range in seconds, rounded for display. */
export function formatTickRangeSeconds(
  startTick: number,
  endTick: number,
  tickRate: number = CS2_TICK_RATE,
  fractionDigits = 1,
): number {
  return formatSeconds(tickRangeSeconds(startTick, endTick, tickRate), fractionDigits);
}
