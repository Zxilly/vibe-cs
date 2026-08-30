/*
 * Design system, layer 1 of 3 — multi-track timeline prototype (spec §0.5).
 *
 * The horizontal axis: seconds ⇄ pixels, the zoom ladder, and the ruler.
 *
 * The 「10 多轨编辑器」artboard states the contract in the timeline header:
 *
 *   <span style="font-family:ui-monospace">缩放 1 秒 = 12 px</span>
 *
 * and draws it — the ruler labels sit 120px apart and read 00:00 / 00:10 /
 * 00:20, and the V1 clips are 504 / 336 / 196 px wide for 42.0 / 28.0 / 16.4 s
 * of source. So `BASE_PIXELS_PER_SECOND = 12` is the 100% zoom, and every
 * other zoom is a multiple of it.
 *
 * No React here, and no DOM: spec §0.5's architecture requirement is that the
 * arithmetic be exhaustively testable in the node project. The rendering layer
 * consumes `pixelsPerSecond` as one CSS custom property (`--tl-pps`) so that a
 * zoom change repaints without React touching a single clip node.
 */

/** 100% zoom, from the artboard's 「缩放 1 秒 = 12 px」. */
export const BASE_PIXELS_PER_SECOND = 12;

/**
 * Interactive zoom bounds. A fitted sequence may go below 0.125×; this is the
 * lowest manual detail stop once the user starts zooming. 64× is 768 px/s,
 * about 13 px per 60fps frame, so an individual frame remains a usable direct-
 * manipulation target rather than only a mathematical snap point.
 */
export const MIN_ZOOM = 0.125;
export const MAX_ZOOM = 64;

/** The zoom stops the toolbar steps through. 1 is the artboard's 100%. */
export const ZOOM_STEPS = [0.125, 0.25, 0.5, 1, 2, 4, 8, 16, 32, 64] as const;

/** Float slack for comparing two times. One microsecond is far below a frame. */
export const TIME_EPSILON = 1e-6;

export interface TimeScale {
  /** 1 = the artboard's 100%. */
  readonly zoom: number;
  /** Derived: `zoom * BASE_PIXELS_PER_SECOND`. */
  readonly pixelsPerSecond: number;
}

export function clampZoom(zoom: number): number {
  // NaN has no side to be clamped to and would poison every position derived
  // from it; the infinities do have one, and `Math.min` / `Math.max` find it.
  if (Number.isNaN(zoom)) return 1;
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
}

export function createTimeScale(zoom = 1): TimeScale {
  const clamped = clampZoom(zoom);
  return { zoom: clamped, pixelsPerSecond: clamped * BASE_PIXELS_PER_SECOND };
}

/**
 * Scale used by a sequence viewport.
 *
 * `createTimeScale` owns the ordinary interactive ladder, but "fit sequence"
 * must be able to go below that ladder for a long recording. Professional NLEs
 * do not make a multi-hour sequence horizontally scroll while their zoom bar is
 * at its fitted end stop. The returned scale therefore keeps the normal maximum
 * while allowing the fitted baseline to be as small as the viewport requires.
 */
export function createFittedTimeScale(
  viewportPixels: number,
  durationSeconds: number,
  multiplier = 1,
): TimeScale {
  const safeViewport = Math.max(1, viewportPixels);
  const safeDuration = Math.max(1, durationSeconds);
  const fittedZoom = Math.min(MAX_ZOOM, safeViewport / safeDuration / BASE_PIXELS_PER_SECOND);
  const zoom = Math.min(MAX_ZOOM, fittedZoom * Math.max(1, multiplier));
  return { zoom, pixelsPerSecond: zoom * BASE_PIXELS_PER_SECOND };
}

export interface TimelineFollowScrollInput {
  /** Current content-space horizontal scroll. */
  readonly scrollPx: number;
  /** Playhead position in content-space pixels. */
  readonly playheadPx: number;
  /** Width of the content viewport, excluding track headers. */
  readonly viewportPx: number;
  /** Page mode is Premiere's playback auto-scroll; reveal mode is paused navigation. */
  readonly mode: 'page' | 'reveal';
  readonly edgePaddingPx?: number;
}

/**
 * Requested horizontal scroll that keeps a moved playhead usable.
 *
 * Playback uses a whole-page jump only after the playhead leaves the visible
 * range. Paused seeking reveals just enough context. Manual scrollbar panning
 * does not call this function, so it remains possible to inspect a region away
 * from the playhead without the viewport snapping back.
 */
export function timelineFollowScroll({
  scrollPx,
  playheadPx,
  viewportPx,
  mode,
  edgePaddingPx = 20,
}: TimelineFollowScrollInput): number {
  const width = Math.max(1, viewportPx);
  const padding = Math.min(Math.max(0, edgePaddingPx), width / 2);
  const visibleStart = scrollPx + padding;
  const visibleEnd = scrollPx + width - padding;
  if (playheadPx >= visibleStart && playheadPx <= visibleEnd) return scrollPx;

  if (mode === 'page') {
    const pageCount = playheadPx > visibleEnd
      ? Math.max(1, Math.ceil((playheadPx - visibleEnd) / width))
      : Math.max(1, Math.ceil((visibleStart - playheadPx) / width));
    return Math.max(0, scrollPx + (playheadPx > visibleEnd ? pageCount : -pageCount) * width);
  }
  return Math.max(0, playheadPx < visibleStart
    ? playheadPx - padding
    : playheadPx - width + padding);
}

/** Content-space pixel offset of a time, measured from t = 0. */
export function timeToPx(scale: TimeScale, seconds: number): number {
  return seconds * scale.pixelsPerSecond;
}

/** The inverse. Also the conversion used for a drag delta and a snap radius. */
export function pxToTime(scale: TimeScale, px: number): number {
  return px / scale.pixelsPerSecond;
}

/**
 * The next stop up (`direction` 1) or down (−1) the ladder. A zoom that sits
 * between two stops moves to the neighbouring stop rather than to the one
 * after it, so a pinch followed by a click never skips a level.
 */
export function nextZoom(zoom: number, direction: 1 | -1): number {
  const current = clampZoom(zoom);
  if (direction === 1) {
    const up = ZOOM_STEPS.find((step) => step > current + TIME_EPSILON);
    return up ?? MAX_ZOOM;
  }
  const down = [...ZOOM_STEPS].reverse().find((step) => step < current - TIME_EPSILON);
  return down ?? MIN_ZOOM;
}

export interface ZoomAnchorInput {
  /** The scale being left. */
  from: TimeScale;
  /** The scale being entered. */
  to: TimeScale;
  /** Content pixels currently hidden to the left of the viewport. */
  scrollPx: number;
  /** Where in the viewport the time that must not move sits, in pixels. */
  anchorPx: number;
}

/**
 * The scroll offset that keeps the time under `anchorPx` under `anchorPx`.
 *
 * This is the whole of "缩放后片段位置、播放头、标尺刻度同步正确": clip, playhead
 * and tick all derive their position from `pixelsPerSecond`, so they cannot
 * drift apart. The only thing that *can* go wrong on a zoom is the viewport
 * jumping, which is this function.
 */
export function zoomAtAnchor({ from, to, scrollPx, anchorPx }: ZoomAnchorInput): number {
  const anchorTime = pxToTime(from, scrollPx + anchorPx);
  return Math.max(0, timeToPx(to, anchorTime) - anchorPx);
}

/** Time under a viewport-relative pixel, given the current scroll. */
export function timeAtViewportPx(scale: TimeScale, scrollPx: number, viewportPx: number): number {
  return Math.max(0, pxToTime(scale, scrollPx + viewportPx));
}

/* ── the ruler ───────────────────────────────────────────────────────────── */

/**
 * Tick spacings, in seconds. Ordinary broadcast subdivisions — nothing here is
 * a 7-second step — so a label always reads as a round number.
 */
const STEP_LADDER = [
  0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30,
  60, 120, 300, 600, 900, 1800, 3600, 7200, 14400, 21600, 43200, 86400,
] as const;

export interface RulerTick {
  /** Seconds from the start of the timeline. */
  time: number;
  /** Content-space pixels, the same space clips are positioned in. */
  px: number;
  /** Labelled ticks are major; the rest are subdivisions. */
  major: boolean;
  /** `mm:ss`, present on major ticks only. */
  label?: string;
}

export interface RulerTickOptions {
  fromSeconds?: number;
  toSeconds: number;
  /**
   * The narrowest gap two labels may sit at. 90px at 12 px/s selects the 10s
   * step the artboard draws; a `00:00` label in 11px mono is about 34px, so
   * 90px keeps roughly a label of air between them.
   */
  minMajorGapPx?: number;
  /** Below this a subdivision is not drawn at all. */
  minMinorGapPx?: number;
  /** Hard stop, so a bad `toSeconds` cannot lock the tab up. */
  maxTicks?: number;
}

/** Smallest ladder step at least `minSeconds` long. */
export function chooseTickStep(minSeconds: number): number {
  return STEP_LADDER.find((step) => step >= minSeconds - TIME_EPSILON) ?? COARSEST_STEP;
}

/** One day, the top of the ladder for fitted multi-day capture timelines. */
const COARSEST_STEP = 86400;

function stepBelow(step: number): number | null {
  const index = STEP_LADDER.indexOf(step as (typeof STEP_LADDER)[number]);
  return index > 0 ? (STEP_LADDER[index - 1] ?? null) : null;
}

/** Kills the drift of repeated `+= step` on a float. */
function roundTime(seconds: number): number {
  return Math.round(seconds * 1e6) / 1e6;
}

export function rulerTicks(scale: TimeScale, options: RulerTickOptions): RulerTick[] {
  const { fromSeconds = 0, toSeconds, minMajorGapPx = 90, minMinorGapPx = 8, maxTicks = 2000 } = options;
  if (!(toSeconds > fromSeconds)) return [];

  const pps = scale.pixelsPerSecond;
  const major = chooseTickStep(minMajorGapPx / pps);
  const candidate = stepBelow(major);
  const minor = candidate !== null && candidate * pps >= minMinorGapPx ? candidate : null;
  const step = minor ?? major;

  const ticks: RulerTick[] = [];
  const first = Math.ceil((fromSeconds - TIME_EPSILON) / step) * step;
  for (let index = 0; index < maxTicks; index += 1) {
    const time = roundTime(first + index * step);
    if (time > toSeconds + TIME_EPSILON) break;
    const isMajor = Math.abs(time / major - Math.round(time / major)) < 1e-6;
    ticks.push({
      time,
      px: time * pps,
      major: isMajor,
      ...(isMajor ? { label: formatTimecode(time) } : {}),
    });
  }
  return ticks;
}

/* ── timecode ────────────────────────────────────────────────────────────── */

function pad(value: number, width = 2): string {
  return String(Math.trunc(value)).padStart(width, '0');
}

/**
 * `mm:ss` under an hour, `h:mm:ss` above it — the ruler labels of the artboard.
 * Sub-second precision is dropped: a ruler label is a landmark, not a readout.
 */
export function formatTimecode(seconds: number): string {
  const sign = seconds < 0 ? '-' : '';
  const total = Math.abs(seconds);
  const whole = Math.floor(total + TIME_EPSILON);
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const secs = whole % 60;
  return hours > 0 ? `${sign}${hours}:${pad(minutes)}:${pad(secs)}` : `${sign}${pad(minutes)}:${pad(secs)}`;
}

/** `mm:ss.mmm` review readout used by timeline playheads and proposal duration. */
export function formatMillisecondTimecode(seconds: number): string {
  const sign = seconds < 0 ? '-' : '';
  const totalMilliseconds = Math.round(Math.abs(seconds) * 1_000);
  const whole = Math.floor(totalMilliseconds / 1_000);
  const milliseconds = totalMilliseconds % 1_000;
  const hours = Math.floor(whole / 3_600);
  const minutes = Math.floor((whole % 3_600) / 60);
  const secs = whole % 60;
  const clock = hours > 0
    ? `${hours}:${pad(minutes)}:${pad(secs)}`
    : `${pad(minutes)}:${pad(secs)}`;
  return `${sign}${clock}.${pad(milliseconds, 3)}`;
}

/**
 * `hh:mm:ss:ff`, the form the artboard's monitor and Inspector use
 * (`00:00:31:12`, `00:00:04:08`). The prototype carries no frame grid — see the
 * README — so this is a display conversion only; nothing rounds a stored time
 * to a frame.
 */
export function formatFrameTimecode(seconds: number, fps = 60): string {
  const sign = seconds < 0 ? '-' : '';
  // Counted in frames throughout: deriving the seconds field separately lets a
  // float land on 59.999… frames and print a frame number equal to the rate.
  const totalFrames = Math.floor(Math.abs(seconds) * fps + TIME_EPSILON);
  const whole = Math.floor(totalFrames / fps);
  const frames = totalFrames % fps;
  return `${sign}${pad(Math.floor(whole / 3600))}:${pad(Math.floor((whole % 3600) / 60))}:${pad(whole % 60)}:${pad(frames)}`;
}
