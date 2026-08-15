/*
 * Domain layer, 2 of 3 — agent/, the stamp a session row carries.
 *
 * The 会话抽屉 artboard stamps its five rows three different ways:
 *
 *   「09:02」   today
 *   「昨天」    the day before
 *   「08-13」   anything older — the date alone, no time
 *
 * `domain/task/taskClock.ts` already owns the first form and the long
 * 「08-15 09:12」 one, and its header states why it holds no copy: it is
 * exhaustible in the `unit` project precisely because it never reaches the i18n
 * runtime. 「昨天」 is a word, so it cannot live there.
 *
 * The split this file makes keeps that property: **this module decides which of
 * the three buckets a timestamp falls in and returns the digits; the component
 * says 「昨天」** through a Lingui macro. No copy here, no `Date.now()` here —
 * `now` and `timeZone` are parameters for the reasons `taskClock.ts` gives, and
 * the time text itself is `formatTaskTime`'s so there is exactly one spelling
 * of 「09:02」 in the product.
 */

import { formatTaskTime } from '../task/taskClock';

export interface AgentClockOptions {
  /** The reader's 「今天」. Omit and every stamp takes the dated form. */
  readonly now?: Date | undefined;
  /** IANA zone. Omit for the host's. Tests pin it so they do not pass locally only. */
  readonly timeZone?: string | undefined;
}

/**
 * Which bucket, and what to print. `text` is always something a row can render:
 * for `yesterday` it is the time of day, which the component puts in a `title`
 * so the word 「昨天」 is not the only thing a reader can get at.
 */
export type SessionStamp =
  | { readonly kind: 'time'; readonly text: string }
  | { readonly kind: 'yesterday'; readonly text: string }
  | { readonly kind: 'date'; readonly text: string };

interface DayFields {
  readonly key: string;
  readonly monthDay: string;
  /** Days since the epoch in the given zone — the only safe way to say 「昨天」. */
  readonly dayNumber: number;
}

const MS_PER_DAY = 86_400_000;

/**
 * `en-US` is a formatting fixture, not a locale choice: the parts are pulled out
 * and reassembled below, so all the locale decides is that the digits are ASCII
 * and two-digit. Same reasoning, and same comment, as `taskClock.ts`.
 */
function dayFields(date: Date, timeZone: string | undefined): DayFields {
  const formatter = new Intl.DateTimeFormat('en-US', {
    ...(timeZone === undefined ? {} : { timeZone }),
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });

  const found: Record<string, string> = {};
  for (const part of formatter.formatToParts(date)) found[part.type] = part.value;

  const year = found['year'] ?? '';
  const month = found['month'] ?? '';
  const day = found['day'] ?? '';

  /* Difference in *calendar days*, computed by re-reading the zone-local date as
     a UTC instant. Subtracting the two `Date`s directly would answer in elapsed
     hours, which says 「昨天」 for 23:00 → 01:00 and 「今天」 across a 25-hour DST
     day — both wrong for a row that only wants to know which page of the
     calendar it is on. */
  const dayNumber = Math.floor(Date.UTC(Number(year), Number(month) - 1, Number(day)) / MS_PER_DAY);

  return { key: `${year}-${month}-${day}`, monthDay: `${month}-${day}`, dayNumber };
}

function parse(iso: string): Date | null {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** 「09:47」 — the stamp on an edit-notice line, where the day is already known. */
export function formatAgentTime(iso: string, options: AgentClockOptions = {}): string {
  return formatTaskTime(iso, options.timeZone === undefined ? {} : { timeZone: options.timeZone });
}

/**
 * Which of the drawer's three stamps this session gets.
 *
 * An unparseable timestamp comes back as itself under `date`, following
 * `taskClock.ts`: a reader who sees the raw ISO string can still act on it,
 * while a blank cell hides a backend bug instead of reporting it.
 */
export function readSessionStamp(iso: string, options: AgentClockOptions = {}): SessionStamp {
  const date = parse(iso);
  if (date === null) return { kind: 'date', text: iso };

  const time = formatAgentTime(iso, options);
  if (options.now === undefined) {
    return { kind: 'date', text: dayFields(date, options.timeZone).monthDay };
  }

  const stamp = dayFields(date, options.timeZone);
  const today = dayFields(options.now, options.timeZone);

  if (stamp.key === today.key) return { kind: 'time', text: time };
  if (today.dayNumber - stamp.dayNumber === 1) return { kind: 'yesterday', text: time };
  return { kind: 'date', text: stamp.monthDay };
}
