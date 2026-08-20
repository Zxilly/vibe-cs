/*
 * 1100 × 700 density review — `domain/media/` (spec §9 risk 6).
 *
 * Both strips in this directory are rows of fixed-width, `flex-none` cells, and
 * that is the shape that fails first at the fold: nothing shrinks, nothing
 * wraps, so the row simply gets wider than the window and the *page* scrolls
 * sideways. Phase 1's `AppShell` ruled that out, so the scroll has to live
 * inside the strip. Both cases below state the arithmetic — how wide the row
 * really is at a real montage length — and then assert the container that
 * absorbs it.
 *
 * The waveform is the opposite problem and is checked for the opposite thing:
 * its node count must *not* grow with the length of the audio.
 */

import { describe, expect, it } from 'vitest';

import { renderMarkup } from '../../test/render';
import {
  FILM_FRAME_COUNT,
  FOLD_CONTENT_WIDTH_PX,
  MONTAGE_CLIP_COUNT,
  MONTAGE_CLIP_COUNT_MAX,
  MONTAGE_DURATION_SECONDS,
  makeClips,
  makeFilmFrames,
  makePeaks,
} from '../densityFixtures';
import { ClipStrip } from './ClipStrip';
import { FilmStrip } from './FilmStrip';
import { Transport } from './Transport';
import { Waveform } from './Waveform';
import { DEFAULT_PEAK_COLUMNS, PEAK_VIEW_WIDTH } from './waveformPeaks';

/** The artboard's tile and its gap: `w-[210px]`, `gap-3` = 12px. */
const CLIP_TILE_PX = 210;
const CLIP_GAP_PX = 12;

/** `--w-track-head` and `gap-1`. */
const FILM_CELL_PX = 132;
const FILM_GAP_PX = 4;

function occurrences(html: string, needle: string): number {
  return html.split(needle).length - 1;
}

function classOf(html: string, marker: string): string {
  const tail = html.slice(html.indexOf(marker));
  return /class="([^"]*)"/u.exec(tail)?.[1] ?? '';
}

describe('density · ClipStrip with a match-length montage', () => {
  const clips = makeClips(MONTAGE_CLIP_COUNT_MAX);

  it('is five times wider than the fold, so the strip scrolls and the page does not', () => {
    // 24 tiles plus the 「＋ 添加片段」 cell.
    const rowWidth = (MONTAGE_CLIP_COUNT_MAX + 1) * CLIP_TILE_PX + MONTAGE_CLIP_COUNT_MAX * CLIP_GAP_PX;
    expect(rowWidth).toBe(5538);
    expect(rowWidth).toBeGreaterThan(FOLD_CONTENT_WIDTH_PX * 5);
    // Four tiles fit in the 996px content column; the artboard's own five do not.
    expect(Math.floor((FOLD_CONTENT_WIDTH_PX + CLIP_GAP_PX) / (CLIP_TILE_PX + CLIP_GAP_PX))).toBe(4);
    expect(MONTAGE_CLIP_COUNT).toBe(5);

    const html = renderMarkup(<ClipStrip clips={clips} onAdd={() => {}} onReorder={() => {}} />);
    const listClass = classOf(html, '<ul');

    expect(listClass).toContain('overflow-x-auto');
    expect(listClass).toContain('overscroll-x-contain');
    // Every clip is still in the DOM — the strip scrolls, it does not window.
    expect(occurrences(html, 'data-clip=')).toBe(MONTAGE_CLIP_COUNT_MAX);
  });

  it('truncates the two text lines of every tile', () => {
    const html = renderMarkup(<ClipStrip clips={clips} />);
    const tiles = html.split('<li').slice(1);
    expect(tiles).toHaveLength(MONTAGE_CLIP_COUNT_MAX);
    // Title and subtitle are page-composed sentences of unbounded length inside
    // a 210px box.
    for (const tile of tiles) expect(occurrences(tile, 'truncate')).toBeGreaterThanOrEqual(2);
  });

  it('scrolls its loading form too — four skeleton tiles are 852px', () => {
    const html = renderMarkup(<ClipStrip clips={[]} loading />);
    expect(html).toContain('aria-busy');
    expect(classOf(html, '<div')).toContain('overflow-x-auto');
  });
});

describe('density · FilmStrip over a whole montage', () => {
  it('is 8428px of thumbnails and scrolls inside itself', () => {
    const rowWidth = FILM_FRAME_COUNT * FILM_CELL_PX + (FILM_FRAME_COUNT - 1) * FILM_GAP_PX;
    expect(rowWidth).toBe(8428);
    // Seven cells fit at the fold; a 2 分 04 秒 montage has 62 of them.
    expect(Math.floor((FOLD_CONTENT_WIDTH_PX + FILM_GAP_PX) / (FILM_CELL_PX + FILM_GAP_PX))).toBe(7);

    const html = renderMarkup(
      <FilmStrip frames={makeFilmFrames(FILM_FRAME_COUNT)} durationSeconds={MONTAGE_DURATION_SECONDS} onSeek={() => {}} />,
    );

    expect(classOf(html, '<ul')).toContain('overflow-x-auto');
    expect(occurrences(html, 'data-time=')).toBe(FILM_FRAME_COUNT);
    // The count is in the accessible name, so a screen reader is told the strip
    // is 62 long rather than discovering it by walking.
    expect(html).toContain(`共 ${String(FILM_FRAME_COUNT)} 帧`);
  });

  it('scrolls the eight placeholder cells of the loading form as well', () => {
    const html = renderMarkup(<FilmStrip loading />);
    expect(html).toContain('aria-busy');
    expect(classOf(html, '<div')).toContain('overflow-x-auto');
  });
});

describe('density · Waveform does not grow with the audio', () => {
  it('downsamples 6200 peaks to a fixed 320-column envelope', () => {
    const peaks = makePeaks(MONTAGE_DURATION_SECONDS);
    expect(peaks.length).toBe(6200);

    const html = renderMarkup(<Waveform peaks={peaks} durationSeconds={MONTAGE_DURATION_SECONDS} currentTime={31} />);

    // One `<path>` for the envelope, one for the zero line, whatever the input.
    expect(occurrences(html, '<path')).toBe(2);
    expect(html).toContain(`viewBox="0 0 ${String(PEAK_VIEW_WIDTH)} 100"`);
    // The envelope traces `columns` maxima out and the same minima back, so the
    // command count is bounded by the column constant and not by the samples.
    const envelope = /d="([^"]*)"/u.exec(html)?.[1] ?? '';
    expect(occurrences(envelope, 'L')).toBeLessThanOrEqual(DEFAULT_PEAK_COLUMNS * 2 + 2);
    /* An inner layer clips, not the framed box: the playhead and the in/out
       rules are absolutely positioned percentages that must not be cut by an
       `overflow-hidden` on the frame. Same shape as `MapCanvas`. */
    expect(classOf(html, 'data-selected=')).toContain('blueprint');
    expect(html).toContain('absolute inset-0 overflow-hidden');
  });
});

describe('density · Transport is the same size at any duration', () => {
  it('draws five buttons and one readout for a 4-second clip and a 2-hour edit', () => {
    const short = renderMarkup(<Transport currentTime={1} durationSeconds={4} playing={false} />);
    const long = renderMarkup(<Transport currentTime={1} durationSeconds={7200} playing={false} />);

    expect(occurrences(short, '<button')).toBe(occurrences(long, '<button'));
    expect(occurrences(long, '<button')).toBe(5);
    // The one variable-width thing is the timecode, and it is `tabular-nums`,
    // so 00:00:04:00 and 02:00:00:00 occupy the same box.
    expect(long).toContain('tabular-nums');
  });
});
