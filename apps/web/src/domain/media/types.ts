/*
 * Domain layer, layer 2 of 3 — media: the display models this directory shares.
 *
 * These are *presentation* models, not the wire DTOs. Field names are kept
 * aligned with `shared/desktop/dto.ts` (camelCased) so a page can hand a
 * mapped record straight through without inventing a second vocabulary:
 *
 *   MediaClip.id            ← RecordedClip.id / RecordedClipRecord.id
 *   MediaClip.title         ← RecordedClip.title
 *   MediaClip.durationSeconds ← RecordedClip.duration_seconds
 *   MediaClip.posterSrc     ← derived from RecordedClip.stream_url by the page
 *
 * What is deliberately *not* copied from the DTO: `path`, `metadata`, `tags`,
 * `demo_id`. A strip of clips does not render them, and a display model that
 * carries fields nothing draws is a transport model wearing a costume.
 */

/**
 * Whether the file behind a clip is still where the project says it is. The
 * 「10 多轨编辑器」artboard draws a fifth media-library row in fail colours
 * with 「缺失 · 需要重新定位」, so this is a rendered state, not a hypothetical.
 */
export type MediaAssetStatus = 'ready' | 'missing';

/** One piece of recorded footage, as 「09 快速合辑」's 片段顺序 strip draws it. */
export interface MediaClip {
  readonly id: string;
  /** 「Mirage 1v3 残局」 — the first line of the tile. */
  readonly title: string;
  /** Seconds. Rendered as the 「42.0s」 badge. */
  readonly durationSeconds: number;
  /**
   * The second line: 「Kael · R21 · 拆包」. Already composed by the caller —
   * which player, round and category belong in a tile is a page decision, and
   * the artboard shows two clips with two different amounts of it.
   */
  readonly subtitle?: string;
  /**
   * Poster frame. Absent while thumbnails are still being generated, in which
   * case the tile falls back to the artboard's hatched placeholder.
   */
  readonly posterSrc?: string;
  readonly status?: MediaAssetStatus;
}

/**
 * Audio peaks, already computed. A `Float32Array` is what a decoder hands back
 * and a `number[]` is what a fixture writes, so both are accepted; nothing in
 * this directory decodes audio (spec §1.2 puts that in the Rust `media` crate,
 * and Web Audio does not exist in the test environments anyway).
 *
 * Values are amplitudes in [-1, 1]. Anything outside that still renders — the
 * envelope is clamped at draw time — but the scale is the contract.
 */
export type PeakData = Float32Array | readonly number[];

/** One rendered column of a waveform: the extremes of the samples behind it. */
export interface PeakColumn {
  readonly min: number;
  readonly max: number;
}

/** One cell of a film strip. `src` absent means "not generated yet". */
export interface FilmFrame {
  /** Seconds from the start of the media. */
  readonly time: number;
  readonly src?: string;
  /** Overrides the generated 「00:12 的画面」 alternative text. */
  readonly alt?: string;
}

/**
 * How a transport spells a time out.
 *
 *   frames  `hh:mm:ss:ff` — 「10 多轨编辑器」's monitor (`00:00:31:12`)
 *   clock   `mm:ss`       — the ruler labels of the same board
 *
 * Both come from `design/timeline/timeScale.ts`; see the note in `Transport`.
 */
export type TimecodeFormat = 'frames' | 'clock';
