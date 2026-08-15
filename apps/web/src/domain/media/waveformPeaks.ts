/*
 * Domain layer, layer 2 of 3 — media: peak downsampling and the envelope path.
 *
 * No React, no DOM, no audio. `Waveform` draws whatever comes out of here; the
 * decoding that produces the samples belongs to the Rust `media` crate
 * (spec §1.2) and could not run in either test environment anyway — jsdom has
 * no `AudioContext` and node has no Web Audio at all.
 *
 * The one interesting decision is what a column means when there are fewer
 * samples than columns. Two ways to be wrong:
 *
 *   · leave the extra columns empty → the waveform grows holes as the view
 *     widens, which reads as "this audio has silence in it" and is a lie;
 *   · interpolate → invents amplitudes that were never measured.
 *
 * So a column with no samples of its own repeats its nearest neighbour: the
 * envelope becomes visibly stepped at high zoom, which is honest — the steps
 * *are* the sample rate — and no value is invented.
 */

import type { PeakColumn, PeakData } from './types';

/** How many columns `Waveform` asks for when the caller does not say. */
export const DEFAULT_PEAK_COLUMNS = 320;

/**
 * Squash `samples` into `columns` columns of min/max.
 *
 * Returns `[]` for an empty input or a non-positive column count — the callers
 * treat an empty result as "there is no waveform to draw" and render the empty
 * state, which is exactly right for a track with no audio.
 *
 * Non-finite samples are skipped rather than poisoning their column; a column
 * made entirely of them collapses to silence (0/0) instead of NaN.
 */
export function downsamplePeaks(samples: PeakData, columns: number): PeakColumn[] {
  const total = samples.length;
  const width = Math.floor(columns);
  if (total === 0 || !Number.isFinite(width) || width <= 0) return [];

  const out: PeakColumn[] = [];
  for (let index = 0; index < width; index += 1) {
    // `start` is clamped to the last sample so that the final column of a
    // short input still points at a real one; `end` is at least `start + 1`
    // so no column is ever empty by construction.
    const start = Math.min(total - 1, Math.floor((index * total) / width));
    const end = Math.max(start + 1, Math.min(total, Math.ceil(((index + 1) * total) / width)));

    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;
    for (let cursor = start; cursor < end; cursor += 1) {
      const value = samples[cursor] as number;
      if (!Number.isFinite(value)) continue;
      if (value < min) min = value;
      if (value > max) max = value;
    }

    out.push(
      min === Number.POSITIVE_INFINITY ? { min: 0, max: 0 } : { min, max },
    );
  }
  return out;
}

/** The SVG user space the envelope is drawn in; stretched by the viewBox. */
export const PEAK_VIEW_WIDTH = 1000;
export const PEAK_VIEW_HEIGHT = 100;

export interface EnvelopeOptions {
  readonly width?: number;
  readonly height?: number;
}

/**
 * A closed path tracing the maxima left to right and the minima back again —
 * the shape the 「09 快速合辑」artboard draws, and the reason it is one filled
 * path rather than a rectangle per column: at 320 columns that would be 320
 * nodes to lay out instead of one.
 *
 * Amplitudes are clamped to [-1, 1] before mapping, so a decoder that hands
 * back an over-driven 1.4 draws a flat-topped envelope instead of a shape that
 * escapes the box.
 *
 * Coordinates are rounded to two decimals: below a hundredth of a user unit
 * nothing is visible at any zoom, and an unrounded float would make the path
 * string differ between machines.
 */
export function peakEnvelopePath(columns: readonly PeakColumn[], options: EnvelopeOptions = {}): string {
  const { width = PEAK_VIEW_WIDTH, height = PEAK_VIEW_HEIGHT } = options;
  if (columns.length === 0) return '';

  const middle = height / 2;
  const xAt = (index: number) => (columns.length === 1 ? 0 : (index * width) / (columns.length - 1));
  const yAt = (value: number) => middle - clampAmplitude(value) * middle;

  const top: string[] = [];
  const bottom: string[] = [];
  for (let index = 0; index < columns.length; index += 1) {
    const column = columns[index] as PeakColumn;
    const x = round(xAt(index));
    top.push(`${x},${round(yAt(column.max))}`);
    bottom.push(`${x},${round(yAt(column.min))}`);
  }
  bottom.reverse();

  // A single column has no width to trace, so it is drawn as one vertical
  // stroke: `M x,top L x,bottom` with no `Z`, which still paints under a
  // stroke and collapses to nothing under a fill — correct either way.
  if (columns.length === 1) return `M${top[0]} L${bottom[0]}`;
  return `M${top.join(' L')} L${bottom.join(' L')} Z`;
}

function clampAmplitude(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(-1, value));
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
