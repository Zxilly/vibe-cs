/*
 * Domain layer, layer 2 of 3 — media barrel (spec §2 `domain/media/`).
 *
 * Four components and the pure modules behind them:
 *
 *   Transport   controlled playback bar — 「08」 and 「10」
 *   Waveform    pre-computed audio peaks — 「09 快速合辑」
 *   ClipStrip   a reorderable row of clips — 「09 快速合辑」
 *   FilmStrip   evenly spaced thumbnails — the 132×74 cell of §3.5
 *
 * Every one of them is presentational: data arrives as props, actions leave as
 * callbacks, and nothing in this directory imports `data/**` or a store. That
 * is §2.1 rule 6's purpose — a component that fetched for itself could not have
 * its cache invalidated by the page that owns the query.
 *
 * ── the fifth entry, Timeline(自研) ──────────────────────────────────────────
 *
 * §2's directory map lists `Timeline(自研)` under `media/`, but the code lives
 * in `design/timeline/` — stage 0.5 built it there and stage 1 shipped it there
 * (see §10.2 and `design/timeline/README.md`). It is re-exported from here
 * rather than wrapped, on purpose:
 *
 *   · a wrapper would have to be a component with no decision in it. Every
 *     prop would pass straight through, and the next person would have to read
 *     two files to find out that the second one does nothing;
 *   · the timeline's own layering (pure model / React view) is the thing worth
 *     keeping. A domain wrapper around the view would tempt a caller to reach
 *     for the wrapper and get the model second-hand;
 *   · the layer lint allows `domain → design`, so a page importing the timeline
 *     through this barrel breaks nothing.
 *
 * If stage 3f gives the timeline domain knowledge it does not have today —
 * evidence-aware clips, revision numbers, session references — that is when it
 * earns a wrapper here, and the wrapper will have something to say.
 */

/* ── the four components ───────────────────────────────────────────────────── */

export { Transport, type TransportProps } from './Transport';
export { Waveform, WAVEFORM_MIN_HEIGHT_CLASS, type WaveformFailure, type WaveformProps } from './Waveform';
export { ClipStrip, CLIP_TILE_WIDTH_CLASS, type ClipReorder, type ClipStripProps } from './ClipStrip';
export {
  FilmStrip,
  DEFAULT_PLACEHOLDER_CELLS,
  FILM_CELL_WIDTH_CLASS,
  type FilmStripProps,
} from './FilmStrip';

/* ── the pure modules ──────────────────────────────────────────────────────── */

export {
  DEFAULT_FPS,
  DEFAULT_PLAYBACK_RATES,
  clampTime,
  formatRate,
  frameDuration,
  frameIndexAt,
  progressPercent,
  progressRatio,
  stepFrames,
  type FrameStepOptions,
} from './transportModel';

export {
  DEFAULT_PEAK_COLUMNS,
  PEAK_VIEW_HEIGHT,
  PEAK_VIEW_WIDTH,
  downsamplePeaks,
  peakEnvelopePath,
  type EnvelopeOptions,
} from './waveformPeaks';

export { clampIndex, dropIndex, moveItem, totalDurationSeconds, type TileSpan } from './clipOrder';

export { evenFrameTimes, frameIndexAtTime, placeholderFrames } from './filmFrames';

export type { FilmFrame, MediaAssetStatus, MediaClip, PeakColumn, PeakData, TimecodeFormat } from './types';

/* ── Timeline(自研) ────────────────────────────────────────────────────────── */

export * from '../../design/timeline';
