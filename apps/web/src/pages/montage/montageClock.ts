/*
 * pages/montage — 「上次保存 3 分钟前」.
 *
 * The 09 artboard stamps the header with a *relative* time, which nothing in
 * `domain/` produces: `domain/task/taskClock.ts` owns 「09:12」 and
 * 「08-15 09:12」, and `domain/agent/agentClock.ts` owns the three-bucket
 * 「09:02 / 昨天 / 08-13」 form. Neither of them counts elapsed minutes, and
 * neither of them wants to — a task row is stamped with *when* something
 * happened, while this header is about *how stale what you are looking at is*.
 *
 * The split follows `agentClock.ts` exactly, and for the same reason: **this
 * module decides which bucket a timestamp falls in and returns the number; the
 * component says 「分钟前」** through a Lingui macro. That keeps the module in
 * the `unit` project with no i18n runtime, and it keeps the copy where
 * `lingui extract` can see it.
 *
 * `now` is a parameter, never `Date.now()`. A function that read the clock
 * itself could not be tested and would render differently on every tick.
 */

import { formatTaskClock } from '../../domain/task';

/**
 * Which bucket, and the number to print.
 *
 *   now      inside a minute — 「刚刚」, no number at all
 *   minutes  1–59
 *   hours    1–23
 *   clock    older than a day: the absolute stamp, because 「30 小时前」 is
 *            arithmetic the reader has to undo, and a date is not
 */
export type SaveStamp =
  | { readonly kind: 'now' }
  | { readonly kind: 'minutes'; readonly value: number }
  | { readonly kind: 'hours'; readonly value: number }
  | { readonly kind: 'clock'; readonly text: string };

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

export interface SaveStampOptions {
  /** IANA zone for the `clock` bucket. Tests pin it; the app omits it. */
  readonly timeZone?: string | undefined;
}

/**
 * `null` for a timestamp that will not parse — the header then omits the
 * segment rather than printing 「上次保存 Invalid Date」. A montage project
 * always has an `updated_at`, so `null` here means the wire lied, and hiding
 * one clause is the smallest honest response.
 *
 * A stamp in the future (clock skew between the service and the shell, which
 * is one machine here but need not stay that way) reads as 「刚刚」 rather than
 * as a negative count.
 */
export function readSaveStamp(iso: string, now: Date, options: SaveStampOptions = {}): SaveStamp | null {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;

  const elapsed = now.getTime() - date.getTime();
  if (elapsed < MINUTE_MS) return { kind: 'now' };
  if (elapsed < HOUR_MS) return { kind: 'minutes', value: Math.floor(elapsed / MINUTE_MS) };
  if (elapsed < DAY_MS) return { kind: 'hours', value: Math.floor(elapsed / HOUR_MS) };

  return {
    kind: 'clock',
    text: formatTaskClock(iso, { now, ...(options.timeZone === undefined ? {} : { timeZone: options.timeZone }) }),
  };
}

/**
 * 「2 分 04 秒」, split into the two numbers the header's `Trans` interpolates.
 *
 * Not a formatted string: 「分」 and 「秒」 are words, and a helper that returned
 * the whole sentence would put them outside a macro where `lingui extract`
 * cannot see them. Seconds are zero-padded here because that is a *formatting*
 * decision, not a translatable one.
 */
export interface MinutesSeconds {
  readonly minutes: number;
  /** Zero-padded to two digits, matching the artboard's 「04 秒」. */
  readonly seconds: string;
}

export function splitMinutesSeconds(totalSeconds: number): MinutesSeconds | null {
  if (!Number.isFinite(totalSeconds) || totalSeconds < 0) return null;
  const whole = Math.round(totalSeconds);
  return { minutes: Math.floor(whole / 60), seconds: String(whole % 60).padStart(2, '0') };
}
