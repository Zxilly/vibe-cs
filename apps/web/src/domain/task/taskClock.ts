/*
 * Domain layer, layer 2 of 3 — the clock a task record is stamped with.
 *
 * The reference stamps two shapes and nothing else:
 *
 *   「09:12」        inside the 任务记录 rail and every 阶段日志 line, where the
 *                   surrounding page has already said which day it is
 *   「08-15 08:40」  on a task from another day
 *
 * Both are digits in the mono face, so there is no text to translate and this
 * module stays free of the i18n runtime — which is what lets it be exhausted in
 * the `unit` project.
 *
 * Two decisions worth stating:
 *
 *   · **`now` is a parameter, never a read of the system clock.** Whether a
 *     stamp may drop its date depends on today, and a function that decides
 *     that by looking at `Date.now()` cannot be tested and re-renders
 *     differently at midnight. Callers that have no opinion pass nothing and
 *     always get the long form.
 *   · **`timeZone` is a parameter too.** The backend's `created_at` is an
 *     instant; which calendar day it lands on is the reader's zone. Tests pin
 *     it to UTC so they do not pass only on the machine that wrote them.
 *
 * Field alignment: the input is `ActivityItem.created_at` / `updated_at`, ISO
 * 8601 as the desktop layer already returns it.
 */

export interface TaskClockOptions {
  /**
   * The reader's "today". When the stamp falls on this calendar day the date is
   * dropped, exactly as the artboard drops it. Omit for the long form always.
   */
  readonly now?: Date | undefined;
  /** IANA zone. Omit for the host's zone. */
  readonly timeZone?: string | undefined;
}

interface CalendarFields {
  readonly year: string;
  readonly month: string;
  readonly day: string;
  readonly hour: string;
  readonly minute: string;
}

/**
 * `en-US` is a formatting *fixture*, not a user-facing locale choice: the parts
 * are pulled out individually and reassembled below, so the only thing the
 * locale decides is that the numbers come back as ASCII digits, 2-digit and
 * 24-hour. Rendering order is ours.
 */
function calendarFields(date: Date, timeZone: string | undefined): CalendarFields {
  const formatter = new Intl.DateTimeFormat('en-US', {
    ...(timeZone === undefined ? {} : { timeZone }),
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });

  const found: Record<string, string> = {};
  for (const part of formatter.formatToParts(date)) found[part.type] = part.value;

  return {
    year: found['year'] ?? '',
    month: found['month'] ?? '',
    day: found['day'] ?? '',
    // `hour12: false` still yields 「24」 for midnight in some ICU versions.
    hour: found['hour'] === '24' ? '00' : found['hour'] ?? '',
    minute: found['minute'] ?? '',
  };
}

function parse(iso: string): Date | null {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** 「09:12」 — the stamp on a 阶段日志 line. */
export function formatTaskTime(iso: string, options: TaskClockOptions = {}): string {
  const date = parse(iso);
  // An unparseable timestamp is shown as it arrived rather than blanked: a
  // reader who can see 「2026-08-15T09:12」 can still act on it, and a blank
  // cell hides a backend bug instead of reporting it.
  if (date === null) return iso;

  const fields = calendarFields(date, options.timeZone);
  return `${fields.hour}:${fields.minute}`;
}

/**
 * 「08-15 09:12」, or 「09:12」 when `now` falls on the same calendar day in the
 * same zone.
 */
export function formatTaskClock(iso: string, options: TaskClockOptions = {}): string {
  const date = parse(iso);
  if (date === null) return iso;

  const fields = calendarFields(date, options.timeZone);
  const time = `${fields.hour}:${fields.minute}`;

  if (options.now !== undefined) {
    const today = calendarFields(options.now, options.timeZone);
    const sameDay = today.year === fields.year && today.month === fields.month && today.day === fields.day;
    if (sameDay) return time;
  }

  return `${fields.month}-${fields.day} ${time}`;
}
