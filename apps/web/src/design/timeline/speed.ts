/*
 * Design system, layer 1 of 3 — multi-track timeline (spec §0.5, phase 3f-2).
 *
 * 变速 — the Inspector's 「速度 100%」 row. README gap 9: the prototype pinned
 * every clip at 100% and wrote that assumption into the arithmetic of both
 * `slip` and the razor.
 *
 * ## What a speed change keeps
 *
 * The **source window**. A clip showing seconds 4.13 → 32.03 of its media at
 * 200% still shows seconds 4.13 → 32.03; it takes half as long to do it, so
 * `duration` halves. That is what Premiere, Resolve and Final Cut all do with
 * a plain speed change, and it is the only choice that does not silently throw
 * frames away: the alternative — keeping `duration` and moving `sourceOut` —
 * would drop 14 seconds of the shot on the floor for a 200% change.
 *
 * The consequence is that a speed change moves the clip's right edge, so it
 * can collide with its neighbour. That is refused, like every other overlap in
 * this editor, rather than overwriting: the user asked to change a speed, not
 * to delete the next shot.
 *
 * ## What the document does with it
 *
 * `EditorClip.speed` is bounded 0.05…16 by `EditorProject::validate`, so those
 * are the bounds here — a speed the editor accepts must be a speed the save
 * accepts, or the refusal arrives as a 400 from the service several seconds
 * later with no way to point at the field that caused it.
 *
 * `EditorClip.speed_segments` — per-interval ramps — are **not** modelled
 * here. The document forbids combining them with a base speed other than 1
 * (`validate_clip_automation`), the 「10」 artboard draws a single 速度 field
 * and no ramp editor, and a ramp is a curve UI, not a number. The adapter
 * refuses a base-speed change on a clip that carries segments and says why.
 */

import {
  clipSourceSpan,
  findOverlapping,
  getClip,
  getTrack,
  linkGroup,
  patchClips,
  refuse,
  MAX_CLIP_SPEED,
  MIN_CLIP_SPEED,
  type Clip,
  type EditResult,
  type Timeline,
} from './timelineModel';
import { frameDuration } from './frameGrid';
import { TIME_EPSILON } from './timeScale';

export interface SpeedOptions {
  /** Change the A/V partners to the same speed. Default true. */
  linked?: boolean;
  /** Shortest a clip may become, in frames. */
  minFrames?: number;
}

export interface SpeedResult extends EditResult {
  /** The speed actually set, after the clamp to 0.05…16. */
  appliedSpeed: number;
}

function speedRefusal(timeline: Timeline, reason: EditResult['reason']): SpeedResult {
  return { ...refuse(timeline, reason ?? 'no-change'), appliedSpeed: 1 };
}

/** Timeline seconds a clip would occupy at `speed`, source window unchanged. */
export function durationAtSpeed(clip: Clip, speed: number): number {
  return clipSourceSpan(clip) / speed;
}

/**
 * Sets a clip's playback rate. The source window is preserved; `duration`
 * changes to suit.
 */
export function setClipSpeed(
  timeline: Timeline,
  clipId: string,
  speed: number,
  options: SpeedOptions = {},
): SpeedResult {
  const { linked = true, minFrames = 1 } = options;

  const clip = getClip(timeline, clipId);
  if (clip === undefined) return speedRefusal(timeline, 'unknown-clip');
  if (!Number.isFinite(speed) || speed < MIN_CLIP_SPEED || speed > MAX_CLIP_SPEED) {
    return speedRefusal(timeline, 'speed-out-of-range');
  }

  const group = linked ? linkGroup(timeline, clipId) : [clip];
  if (group.some((member) => getTrack(timeline, member.trackId)?.locked === true)) {
    return speedRefusal(timeline, 'track-locked');
  }
  if (group.every((member) => Math.abs(member.speed - speed) < TIME_EPSILON)) {
    return speedRefusal(timeline, 'no-change');
  }

  const minDuration = minFrames * frameDuration(timeline.fps);
  const moved = new Set(group.map((member) => member.id));
  const patches = new Map<string, Partial<Clip>>();

  for (const member of group) {
    const duration = durationAtSpeed(member, speed);
    if (duration < minDuration - TIME_EPSILON) return speedRefusal(timeline, 'too-short');
    // The left edge does not move, so only the tail can newly collide.
    if (findOverlapping(timeline, member.trackId, member.start, member.start + duration, moved).length > 0) {
      return speedRefusal(timeline, 'overlap');
    }
    patches.set(member.id, { speed, duration });
  }

  return { timeline: patchClips(timeline, patches), applied: true, appliedSpeed: speed };
}

/**
 * The speed at which a clip would exactly fill `seconds` — what a 「拉长片段到
 * 这个时长」 gesture would need. Answers null when that speed is out of range,
 * so the caller refuses before it builds a document the save would reject.
 */
export function speedToFit(clip: Clip, seconds: number): number | null {
  if (!(seconds > 0)) return null;
  const speed = clipSourceSpan(clip) / seconds;
  return speed >= MIN_CLIP_SPEED && speed <= MAX_CLIP_SPEED ? speed : null;
}
