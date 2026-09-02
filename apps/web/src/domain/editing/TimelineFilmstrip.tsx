import { memo, useMemo } from 'react';

import { mediaAssetThumbnailPath } from '../../data/mediaAssets';
import type { NativeShell } from '../../data/nativeShell';
import type { TimelineClip } from '../../shared/desktop/dto';
import { timelineFilmstripTiles } from './timelineFilmstripGeometry';
import type { TimelineThumbnailMode } from './timelineFilmstripGeometry';

interface TimelineFilmstripProps {
  readonly clip: TimelineClip;
  readonly assetId: string;
  readonly clipLeftPx: number;
  readonly clipWidthPx: number;
  readonly trackHeightPx: number;
  readonly viewportStartPx: number;
  readonly viewportEndPx: number;
  readonly fps: number;
  readonly mediaSrc: NativeShell['mediaSrc'];
  readonly mode: TimelineThumbnailMode;
}

/** Static, viewport-bounded frames. Program playback remains the only video
 * transport; the browser caches these stable per-frame image URLs. */
export const TimelineFilmstrip = memo(function TimelineFilmstrip({
  clip,
  assetId,
  clipLeftPx,
  clipWidthPx,
  trackHeightPx,
  viewportStartPx,
  viewportEndPx,
  fps,
  mediaSrc,
  mode,
}: TimelineFilmstripProps) {
  const tiles = useMemo(() => timelineFilmstripTiles({
    clip,
    clipLeftPx,
    clipWidthPx,
    trackHeightPx,
    viewportStartPx,
    viewportEndPx,
    fps,
    mode,
  }), [clip, clipLeftPx, clipWidthPx, fps, mode, trackHeightPx, viewportEndPx, viewportStartPx]);

  if (tiles.length === 0) return null;
  return (
    <span
      className="pointer-events-none absolute inset-x-0 bottom-[18px] top-0 overflow-hidden bg-accent-100"
      data-timeline-filmstrip
    >
      {tiles.map((tile) => (
        <img
          key={`${tile.index}:${tile.sourceTime}`}
          className="absolute inset-y-0 h-full border-r border-accent-300 object-cover"
          style={{ left: tile.leftPx, width: tile.widthPx }}
          src={mediaSrc(mediaAssetThumbnailPath(assetId, tile.sourceTime, 192, 108)) ?? undefined}
          alt=""
          loading="lazy"
          decoding="async"
          draggable={false}
        />
      ))}
    </span>
  );
});
