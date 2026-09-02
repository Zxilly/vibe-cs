import type { TimelineClip } from '../../shared/desktop/dto';
import { clipSourceTimeAtLocalTime } from './timelineInteraction';

const MIN_FILMSTRIP_TRACK_HEIGHT = 48;
const CLIP_LABEL_HEIGHT = 18;
const MIN_TILE_WIDTH = 56;
const MAX_TILE_WIDTH = 128;
const TILE_ASPECT_RATIO = 16 / 9;

export interface TimelineFilmstripTile {
  readonly index: number;
  readonly leftPx: number;
  readonly widthPx: number;
  readonly sourceTime: number;
}

export type TimelineThumbnailMode = 'none' | 'head' | 'head_tail' | 'frames';

interface TimelineFilmstripInput {
  readonly clip: TimelineClip;
  readonly clipLeftPx: number;
  readonly clipWidthPx: number;
  readonly trackHeightPx: number;
  readonly viewportStartPx: number;
  readonly viewportEndPx: number;
  readonly fps: number;
  readonly mode: TimelineThumbnailMode;
}

/**
 * Premiere-style thumbnail geometry for one video clip. The caller supplies a
 * padded visible window, so long clips create only the image nodes that can be
 * seen while stable URLs let the browser cache decoded thumbnails by frame.
 */
export function timelineFilmstripTiles({
  clip,
  clipLeftPx,
  clipWidthPx,
  trackHeightPx,
  viewportStartPx,
  viewportEndPx,
  fps,
  mode,
}: TimelineFilmstripInput): TimelineFilmstripTile[] {
  if (mode === 'none' || trackHeightPx < MIN_FILMSTRIP_TRACK_HEIGHT || clipWidthPx <= 0) return [];

  const imageHeight = Math.max(1, trackHeightPx - CLIP_LABEL_HEIGHT - 4);
  const tileWidth = Math.min(MAX_TILE_WIDTH, Math.max(MIN_TILE_WIDTH, imageHeight * TILE_ASPECT_RATIO));
  const tileCount = mode === 'frames' ? Math.max(1, Math.ceil(clipWidthPx / tileWidth)) : 1;
  const visibleStart = Math.max(0, viewportStartPx - clipLeftPx);
  const visibleEnd = Math.min(clipWidthPx, viewportEndPx - clipLeftPx);
  if (visibleEnd <= 0 || visibleStart >= clipWidthPx || visibleEnd <= visibleStart) return [];

  const frame = 1 / Math.max(1, fps);
  if (mode === 'head' || mode === 'head_tail') {
    const candidates = [{
      index: 0,
      leftPx: 0,
      widthPx: Math.min(tileWidth, clipWidthPx),
      sourceTime: Math.round(clipSourceTimeAtLocalTime(clip, 0) * fps) / fps,
    }];
    if (mode === 'head_tail' && clipWidthPx >= tileWidth * 1.5) {
      candidates.push({
        index: 1,
        leftPx: Math.max(0, clipWidthPx - tileWidth),
        widthPx: Math.min(tileWidth, clipWidthPx),
        sourceTime: Math.round(clipSourceTimeAtLocalTime(clip, Math.max(0, clip.placement.duration - frame)) * fps) / fps,
      });
    }
    return candidates.filter((tile) => tile.leftPx + tile.widthPx > visibleStart && tile.leftPx < visibleEnd);
  }

  const firstIndex = Math.max(0, Math.floor(visibleStart / tileWidth) - 1);
  const lastIndex = Math.min(tileCount - 1, Math.ceil(visibleEnd / tileWidth));
  const tiles: TimelineFilmstripTile[] = [];
  for (let index = firstIndex; index <= lastIndex; index += 1) {
    const leftPx = index * tileWidth;
    const localTime = Math.min(
      Math.max(0, clip.placement.duration - frame),
      index / tileCount * clip.placement.duration,
    );
    const sourceTime = Math.round(clipSourceTimeAtLocalTime(clip, localTime) * fps) / fps;
    tiles.push({
      index,
      leftPx,
      widthPx: Math.min(tileWidth, clipWidthPx - leftPx),
      sourceTime,
    });
  }
  return tiles;
}
