import type { TimelineClip } from '../../shared/desktop/dto';

/** The name strip's type (`text-xs`) and inline padding (`px-1` each side). */
const CLIP_STRIP_FONT_PX = 12;
const CLIP_STRIP_INLINE_PX = 8;

/**
 * What a clip's name strip shows at its drawn width. A name that fits is shown
 * whole; one that does not collapses to a token that still tells clips apart —
 * the source round (「R1」) when the clip carries one, else its ordinal on the
 * track — rather than to 「Mir…」, which is the same prefix on every clip of a
 * match. The full name stays on the clip's accessible name and tooltip.
 *
 * The width is estimated from character classes (CJK a full em, everything
 * else about 0.6em), which is enough to choose between two labels; the strip
 * still truncates if the estimate is short.
 */
export function timelineClipStripLabel(clip: TimelineClip, ordinal: number, widthPx: number): string {
  let textPx = 0;
  for (const char of clip.name) {
    textPx += CLIP_STRIP_FONT_PX * (/[\p{Script=Han}\p{Script=Hangul}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(char) ? 1 : 0.6);
  }
  if (textPx + CLIP_STRIP_INLINE_PX <= widthPx) return clip.name;
  const metadata = clip.metadata;
  const round = typeof metadata === 'object' && metadata !== null && !Array.isArray(metadata) ? metadata.round : undefined;
  if (typeof round === 'number') return `R${String(round)}`;
  return /(?:^|[\s·])(R\d+)(?=$|[\s·])/u.exec(clip.name)?.[1] ?? String(ordinal);
}
