/*
 * Domain layer, 2 of 3 — agent/, the numbers a shot prints.
 *
 * Every Agent artboard writes the same three figures in the mono face and it
 * writes them the same way each time:
 *
 *   「3.0s」        a shot's own length, one decimal, always — 「3s」 next to
 *                   「8.5s」 makes two columns that do not line up
 *   「−5.5s」       a change's delta, signed, with U+2212 rather than a hyphen,
 *                   which is what the 2a board draws and what keeps 「−5.5s」
 *                   from wrapping like a hyphenated word
 *   「tick 148 620–148 812」 the interval the shot is cut from
 *
 * ── What this file deliberately does not re-implement ─────────────────────
 *
 * The tick reading is `domain/match/matchTime.ts`'s, imported rather than
 * copied. A tick number is one product-wide convention — the same 148 620 is
 * printed by the evidence row, the highlight list and this shot card, and two
 * spellings of the grouping is how 「148 620」 and 「148,620」 end up on the same
 * screen. This is the first import across two `domain/` directories; it is
 * here because the alternative is a second copy of a formatter that already
 * has exhaustive tests, not because the directories are coupled.
 */

export { formatTickCount, formatTickRange } from '../match/matchTime';

/** U+2212. The artboard's delta glyph, and the one that aligns with digits. */
const MINUS_SIGN = '−';

/**
 * 「3.0s」/「24.0s」. One decimal, no thousands grouping (no shot is 1000s), and
 * the unit suffix is part of the reading rather than copy: `s` is what the
 * artboard prints in both locales, beside a mono figure, the same way `tick` is.
 *
 * A non-finite duration prints as 「0.0s」 rather than 「NaNs」 — a card with a
 * broken number still has to keep its row height.
 */
export function formatShotDuration(seconds: number): string {
  const value = Number.isFinite(seconds) ? seconds : 0;
  return `${value.toFixed(1)}s`;
}

/**
 * 「−5.5s」/「+9.0s」/「±0s」 — the change card's delta and the take card's
 * comparison column.
 *
 * Zero is written 「±0s」, which is what the 2c board draws for 穿墙风险镜头, and
 * is the reading that says "compared, and the same" rather than "nothing here".
 */
export function formatSignedSeconds(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds === 0) return '±0s';
  const magnitude = Math.abs(seconds).toFixed(1);
  return seconds < 0 ? `${MINUS_SIGN}${magnitude}s` : `+${magnitude}s`;
}

/**
 * 「00:42」 — the strip ruler's marks and a plan's total. Minutes and seconds
 * only: nothing in this product is an hour long, and `01:02:03` in a 30px ruler
 * cell is three numbers where two fit.
 */
export function formatStripTimecode(seconds: number): string {
  const total = Number.isFinite(seconds) ? Math.max(0, Math.round(seconds)) : 0;
  const minutes = Math.floor(total / 60);
  const remainder = total % 60;
  return `${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`;
}
