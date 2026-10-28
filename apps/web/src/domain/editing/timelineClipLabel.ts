import type { TimelineClip } from '../../shared/desktop/dto';

/** The name strip's type, inline padding and enclosing clip borders. */
const CLIP_STRIP_FONT_PX = 12;
const CLIP_STRIP_INLINE_PX = 10;

export interface TimelineClipCompactLabel {
  readonly text: string;
  readonly ordinal: number;
}

function clipRoundToken(clip: TimelineClip): string | null {
  const metadata = clip.metadata;
  const round = typeof metadata === 'object' && metadata !== null && !Array.isArray(metadata) ? metadata.round : undefined;
  if (typeof round === 'number') return `R${String(round)}`;
  return /(?:^|[\s·])(R\d+)(?=$|[\s·])/u.exec(clip.name)?.[1] ?? null;
}

/** 0 → a, 25 → z, 26 → aa: enough letters for any number of takes of one round. */
function takeSuffix(index: number): string {
  let suffix = '';
  for (let rest = index + 1; rest > 0; rest = Math.floor((rest - 1) / 26)) {
    suffix = String.fromCharCode(97 + (rest - 1) % 26) + suffix;
  }
  return suffix;
}

/**
 * The compact token each clip of one track collapses to when its name does not
 * fit: the source round (「R1」) when the clip carries one, else its ordinal on
 * the track. Several clips cut from the same round take a letter in timeline
 * order (「R1a」「R1b」) so the strips still tell them apart; a round that
 * appears once keeps the bare token.
 */
export function timelineClipCompactLabels(clips: readonly TimelineClip[]): ReadonlyMap<string, TimelineClipCompactLabel> {
  const ordered = [...clips].sort((left, right) => left.placement.start - right.placement.start);
  const tokens = ordered.map(clipRoundToken);
  const counts = new Map<string, number>();
  for (const token of tokens) if (token !== null) counts.set(token, (counts.get(token) ?? 0) + 1);
  const taken = new Map<string, number>();
  const labels = new Map<string, TimelineClipCompactLabel>();
  ordered.forEach((clip, index) => {
    const token = tokens[index] ?? null;
    if (token === null) {
      labels.set(clip.id, { text: String(index + 1), ordinal: index + 1 });
      return;
    }
    if (counts.get(token) === 1) {
      labels.set(clip.id, { text: token, ordinal: index + 1 });
      return;
    }
    const take = taken.get(token) ?? 0;
    taken.set(token, take + 1);
    labels.set(clip.id, { text: `${token}${takeSuffix(take)}`, ordinal: index + 1 });
  });
  return labels;
}

/**
 * Choose the full name, round token or track ordinal according to the available
 * width. Hide the strip only when even the ordinal cannot fit. The full name
 * remains on the clip's accessible name and tooltip at every zoom level.
 */
export function timelineClipStripLabel(clip: TimelineClip, compactLabel: TimelineClipCompactLabel, widthPx: number): string | null {
  return [clip.name, compactLabel.text, String(compactLabel.ordinal)]
    .find((label) => estimatedTextWidth(label) + CLIP_STRIP_INLINE_PX <= widthPx) ?? null;
}

function estimatedTextWidth(label: string): number {
  let textPx = 0;
  for (const char of label) {
    textPx += CLIP_STRIP_FONT_PX * (/[\p{Script=Han}\p{Script=Hangul}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(char) ? 1 : 0.6);
  }
  return textPx;
}
