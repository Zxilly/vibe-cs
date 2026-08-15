/*
 * Design system, layer 1 of 3 — multi-track timeline prototype (spec §0.5).
 *
 * The playhead and the marker guides — the two things the artboard draws
 * through *every* lane rather than inside one:
 *
 *   <div style="position:absolute;left:374px;top:0;bottom:0;width:2px;background:var(--color-text)"></div>
 *   <div style="position:absolute;left:368px;top:0;width:14px;height:12px;background:var(--color-text)"></div>
 *   <div style="position:absolute;left:240px;top:0;width:1px;bottom:0;background:#a8792f"></div>   ← --color-warn
 *
 * They live in the canvas, above the lanes, and are positioned by the same
 * `--tl-pps` arithmetic as a clip. Both are `pointer-events: none`: the ruler
 * scrubs the playhead, and a guide must never eat a click meant for the clip
 * under it.
 *
 * This is also the answer to 「标记」 as a lane. The artboard has no marker row —
 * it draws full-height guides with their labels at the top, which is what these
 * are. See README.md.
 */

import { timelineStyle } from './style';
import type { Marker } from './timelineModel';

import './timeline.css';

export interface PlayheadProps {
  timeSeconds: number;
  /** Accessible name, e.g. 「播放头 00:31」. Omitted: the bar is decorative. */
  label?: string;
  className?: string;
}

export function Playhead({ timeSeconds, label, className = '' }: PlayheadProps) {
  return (
    <div
      className={`tl-playhead ${className}`.trimEnd()}
      data-testid="playhead"
      data-time={timeSeconds}
      style={timelineStyle({ '--tl-t': timeSeconds })}
      role={label === undefined ? 'presentation' : 'img'}
      aria-label={label}
    >
      <span className="tl-playhead-flag" />
    </div>
  );
}

export interface MarkerLayerProps {
  markers: readonly Marker[];
  className?: string;
}

/** The amber guides, one per marker, each carrying its own label. */
export function MarkerLayer({ markers, className = '' }: MarkerLayerProps) {
  return (
    <>
      {markers.map((marker) => (
        <div
          key={marker.id}
          className={`tl-marker ${className}`.trimEnd()}
          data-marker={marker.id}
          data-time={marker.time}
          style={timelineStyle({ '--tl-t': marker.time })}
        >
          <span className="tl-marker-flag">{marker.label}</span>
        </div>
      ))}
    </>
  );
}
