import type { EditorTransition, TimelineClip, TimelineTrack } from '../../shared/desktop/dto';
import { snapTimeToFrame } from './timelineInteraction';

export interface TimelineTransitionUpdate {
  readonly trackId: string;
  readonly clips: readonly TimelineClip[];
}

export type TimelineTransitionAlignment = 'center_at_cut' | 'start_at_cut' | 'end_at_cut' | 'custom_start';

export interface TimelineCutTransition {
  readonly channel: 'video' | 'audio';
  readonly kind: EditorTransition['kind'];
  readonly alignment: TimelineTransitionAlignment;
  readonly durationSeconds: number;
  readonly leftDurationSeconds: number;
  readonly rightDurationSeconds: number;
}

function compatibleTrack(
  track: TimelineTrack,
  channel: 'video' | 'audio',
  storyTrackId: string,
): boolean {
  return channel === 'video'
    ? track.kind === 'video' || track.kind === 'overlay'
    : track.kind === 'audio' || track.id === storyTrackId;
}

function transitionFor(channel: 'video' | 'audio', durationSeconds: number): EditorTransition {
  return {
    kind: channel === 'video' ? 'fade' : 'constant_power',
    duration_seconds: durationSeconds,
  };
}

export function timelineTransition(
  clip: TimelineClip,
  channel: 'video' | 'audio',
  edge: 'in' | 'out',
): EditorTransition | null {
  return clip.transitions[`${channel}_${edge}` as keyof TimelineClip['transitions']];
}

export function maximumTimelineTransitionDuration(
  clip: TimelineClip,
  channel: 'video' | 'audio',
  edge: 'in' | 'out',
  fps: number,
): number {
  const other = timelineTransition(clip, channel, edge === 'in' ? 'out' : 'in');
  return Math.max(0, Math.min(5, clip.placement.duration - (other?.duration_seconds ?? 0) - 1 / fps));
}

export function setTimelineTransitionDuration(
  clip: TimelineClip,
  channel: 'video' | 'audio',
  edge: 'in' | 'out',
  requestedDuration: number,
  fps: number,
): TimelineClip {
  const field = `${channel}_${edge}` as keyof TimelineClip['transitions'];
  if (requestedDuration < 0.05) {
    return { ...clip, transitions: { ...clip.transitions, [field]: null } };
  }
  const maximum = maximumTimelineTransitionDuration(clip, channel, edge, fps);
  if (maximum < 0.05) return clip;
  const duration = snapTimeToFrame(Math.min(maximum, Math.max(0.05, requestedDuration)), fps);
  const existing = timelineTransition(clip, channel, edge);
  return {
    ...clip,
    transitions: {
      ...clip.transitions,
      [field]: existing === null ? transitionFor(channel, duration) : { ...existing, duration_seconds: duration },
    },
  };
}

export function timelineCutTransition(
  track: TimelineTrack,
  clipId: string,
  channel: 'video' | 'audio',
  edge: 'in' | 'out',
  fps: number,
): TimelineCutTransition | null {
  const context = cutContext(track, clipId, edge, fps);
  if (context === null) return null;
  const leftTransition = context.left === null ? null : timelineTransition(context.left, channel, 'out');
  const rightTransition = context.right === null ? null : timelineTransition(context.right, channel, 'in');
  const selected = edge === 'out' ? leftTransition : rightTransition;
  const counterpart = edge === 'out' ? rightTransition : leftTransition;
  const kind = selected?.kind ?? counterpart?.kind;
  if (kind === undefined) return null;
  const leftDurationSeconds = leftTransition?.kind === kind ? leftTransition.duration_seconds : 0;
  const rightDurationSeconds = rightTransition?.kind === kind ? rightTransition.duration_seconds : 0;
  const tolerance = 0.5 / Math.max(1, fps);
  const alignment: TimelineTransitionAlignment = leftDurationSeconds <= tolerance
    ? 'start_at_cut'
    : rightDurationSeconds <= tolerance
      ? 'end_at_cut'
      : Math.abs(leftDurationSeconds - rightDurationSeconds) <= tolerance
        ? 'center_at_cut'
        : 'custom_start';
  return {
    channel,
    kind,
    alignment,
    durationSeconds: leftDurationSeconds + rightDurationSeconds,
    leftDurationSeconds,
    rightDurationSeconds,
  };
}

export function applyTimelineCutTransition(
  track: TimelineTrack,
  clipId: string,
  channel: 'video' | 'audio',
  edge: 'in' | 'out',
  transition: TimelineCutTransition | null,
  fps: number,
): TimelineClip[] {
  const context = cutContext(track, clipId, edge, fps);
  if (context === null) return track.clips;
  if (transition !== null && transition.channel !== channel) return track.clips;
  const leftMaximum = context.left === null ? 0 : maximumTimelineTransitionDuration(context.left, channel, 'out', fps);
  const rightMaximum = context.right === null ? 0 : maximumTimelineTransitionDuration(context.right, channel, 'in', fps);
  let leftDuration = 0;
  let rightDuration = 0;
  if (transition !== null) {
    if (transition.alignment === 'center_at_cut') {
      if (context.left === null || context.right === null) return track.clips;
      const half = Math.min(transition.durationSeconds / 2, leftMaximum, rightMaximum);
      leftDuration = half;
      rightDuration = half;
    } else if (transition.alignment === 'start_at_cut') {
      if (context.right === null) return track.clips;
      rightDuration = Math.min(transition.durationSeconds, rightMaximum);
    } else if (transition.alignment === 'end_at_cut') {
      if (context.left === null) return track.clips;
      leftDuration = Math.min(transition.durationSeconds, leftMaximum);
    } else {
      leftDuration = Math.min(transition.leftDurationSeconds, leftMaximum);
      rightDuration = Math.min(transition.rightDurationSeconds, rightMaximum);
    }
  }
  const replacements = new Map<string, TimelineClip>();
  if (context.left !== null) replacements.set(context.left.id, setTransition(
    context.left,
    channel,
    'out',
    leftDuration,
    transition?.kind ?? null,
    fps,
  ));
  if (context.right !== null) replacements.set(context.right.id, setTransition(
    context.right,
    channel,
    'in',
    rightDuration,
    transition?.kind ?? null,
    fps,
  ));
  return track.clips.map((clip) => replacements.get(clip.id) ?? clip);
}

function setTransition(
  clip: TimelineClip,
  channel: 'video' | 'audio',
  edge: 'in' | 'out',
  duration: number,
  kind: EditorTransition['kind'] | null,
  fps: number,
): TimelineClip {
  const replacement = setTimelineTransitionDuration(clip, channel, edge, duration, fps);
  if (kind === null || duration < 0.05) return replacement;
  const field = `${channel}_${edge}` as keyof TimelineClip['transitions'];
  const existing = replacement.transitions[field];
  return existing === null
    ? replacement
    : { ...replacement, transitions: { ...replacement.transitions, [field]: { ...existing, kind } } };
}

function cutContext(
  track: TimelineTrack,
  clipId: string,
  edge: 'in' | 'out',
  fps: number,
): { readonly left: TimelineClip | null; readonly right: TimelineClip | null } | null {
  const ordered = [...track.clips].sort((left, right) => left.placement.start - right.placement.start);
  const index = ordered.findIndex((clip) => clip.id === clipId);
  if (index < 0) return null;
  const left = edge === 'out' ? ordered[index]! : ordered[index - 1] ?? null;
  const right = edge === 'in' ? ordered[index]! : ordered[index + 1] ?? null;
  if (left !== null && right !== null) {
    const cut = left.placement.start + left.placement.duration;
    if (Math.abs(cut - right.placement.start) > 0.5 / Math.max(1, fps)) {
      return edge === 'out' ? { left, right: null } : { left: null, right };
    }
  }
  return { left, right };
}

export function planDefaultTimelineTransitions({
  tracks,
  storyTrackId,
  targetTrackIds,
  selectedClipIds,
  timelineTime,
  channel,
  mode,
  fps,
  defaultDurationSeconds = 1,
}: {
  readonly tracks: readonly TimelineTrack[];
  readonly storyTrackId: string;
  readonly targetTrackIds: ReadonlySet<string>;
  readonly selectedClipIds: ReadonlySet<string>;
  readonly timelineTime: number;
  readonly channel: 'video' | 'audio';
  readonly mode: 'at_playhead' | 'selection';
  readonly fps: number;
  readonly defaultDurationSeconds?: number;
}): TimelineTransitionUpdate[] {
  const tolerance = 0.5 / Math.max(1, fps);
  return tracks.flatMap((track): TimelineTransitionUpdate[] => {
    if (track.locked
      || !compatibleTrack(track, channel, storyTrackId)
      || (mode === 'at_playhead' && !targetTrackIds.has(track.id))) return [];
    const ordered = [...track.clips].sort((left, right) => left.placement.start - right.placement.start);
    const replacements = new Map<string, TimelineClip>();
    if (mode === 'selection') {
      for (let index = 0; index < ordered.length - 1; index += 1) {
        const left = ordered[index]!;
        const right = ordered[index + 1]!;
        const cut = left.placement.start + left.placement.duration;
        if (!selectedClipIds.has(left.id)
          || !selectedClipIds.has(right.id)
          || Math.abs(cut - right.placement.start) > tolerance) continue;
        replacements.set(left.id, setTimelineTransitionDuration(left, channel, 'out', defaultDurationSeconds / 2, fps));
        replacements.set(right.id, setTimelineTransitionDuration(right, channel, 'in', defaultDurationSeconds / 2, fps));
      }
    } else {
      const left = [...ordered].reverse().find((clip) => (
        Math.abs(clip.placement.start + clip.placement.duration - timelineTime) <= tolerance
      ));
      const right = ordered.find((clip) => Math.abs(clip.placement.start - timelineTime) <= tolerance);
      if (left !== undefined && right !== undefined && left.id !== right.id) {
        replacements.set(left.id, setTimelineTransitionDuration(left, channel, 'out', defaultDurationSeconds / 2, fps));
        replacements.set(right.id, setTimelineTransitionDuration(right, channel, 'in', defaultDurationSeconds / 2, fps));
      } else if (left !== undefined) {
        replacements.set(left.id, setTimelineTransitionDuration(left, channel, 'out', defaultDurationSeconds, fps));
      } else if (right !== undefined) {
        replacements.set(right.id, setTimelineTransitionDuration(right, channel, 'in', defaultDurationSeconds, fps));
      }
    }
    if (replacements.size === 0) return [];
    return [{
      trackId: track.id,
      clips: track.clips.map((clip) => replacements.get(clip.id) ?? clip),
    }];
  });
}
