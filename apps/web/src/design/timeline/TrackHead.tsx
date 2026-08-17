/*
 * Design system, layer 1 of 3 — multi-track timeline prototype (spec §0.5).
 *
 * The head column, 132px wide (`--w-track-head`, spec §3.5):
 *
 *   <div style="height:62px;…;font-size:12px">V1 <span style="color:…600">主画面</span></div>
 *
 * with the current lane picked out by `background:var(--color-accent-100)`.
 * Each head declares its own height from `TRACK_HEIGHT_PX`, the same record the
 * drag code hit-tests against, so a head and its lane cannot fall out of step.
 *
 * `name` and `role` come from the document, not from this component: in the
 * real editor they are the project's own lane labels. That also keeps the
 * strings out of the Lingui catalog, where a per-project label does not belong.
 */

import { TRACK_HEIGHT_PX } from './geometry';
import { timelineStyle } from './style';
import type { Track } from './timelineModel';

import './timeline.css';
import { cn } from '../cn';

export interface TrackHeadProps {
  track: Track;
  /** The lane holding the selection: the artboard's accent-100 row. */
  current?: boolean;
  className?: string;
}

export function TrackHead({ track, current = false, className }: TrackHeadProps) {
  return (
    <div
      className={cn('tl-head', className)}
      data-track={track.id}
      data-kind={track.kind}
      data-current={String(current)}
      data-locked={String(track.locked === true)}
      style={timelineStyle({ '--tl-lane-h': TRACK_HEIGHT_PX[track.kind] })}
    >
      <span>{track.name}</span>
      <span className="tl-head-role">{track.role}</span>
    </div>
  );
}
