import type { EditorTransition, TimelineClip, TimelineTrack } from '../../shared/desktop/dto';
import { snapTimeToFrame } from './timelineInteraction';

export interface TimelineTransitionUpdate {
  readonly trackId: string;
  readonly clips: readonly TimelineClip[];
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

function withTransition(
  clip: TimelineClip,
  channel: 'video' | 'audio',
  edge: 'in' | 'out',
  requestedDuration: number,
  fps: number,
): TimelineClip {
  const field = `${channel}_${edge}` as keyof TimelineClip['transitions'];
  const otherField = `${channel}_${edge === 'in' ? 'out' : 'in'}` as keyof TimelineClip['transitions'];
  const maximum = Math.max(0, Math.min(5, clip.placement.duration - (clip.transitions[otherField]?.duration_seconds ?? 0) - 1 / fps));
  if (maximum < 0.05) return clip;
  const duration = snapTimeToFrame(Math.min(maximum, Math.max(0.05, requestedDuration)), fps);
  return {
    ...clip,
    transitions: { ...clip.transitions, [field]: transitionFor(channel, duration) },
  };
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
        replacements.set(left.id, withTransition(left, channel, 'out', defaultDurationSeconds / 2, fps));
        replacements.set(right.id, withTransition(right, channel, 'in', defaultDurationSeconds / 2, fps));
      }
    } else {
      const left = [...ordered].reverse().find((clip) => (
        Math.abs(clip.placement.start + clip.placement.duration - timelineTime) <= tolerance
      ));
      const right = ordered.find((clip) => Math.abs(clip.placement.start - timelineTime) <= tolerance);
      if (left !== undefined && right !== undefined && left.id !== right.id) {
        replacements.set(left.id, withTransition(left, channel, 'out', defaultDurationSeconds / 2, fps));
        replacements.set(right.id, withTransition(right, channel, 'in', defaultDurationSeconds / 2, fps));
      } else if (left !== undefined) {
        replacements.set(left.id, withTransition(left, channel, 'out', defaultDurationSeconds, fps));
      } else if (right !== undefined) {
        replacements.set(right.id, withTransition(right, channel, 'in', defaultDurationSeconds, fps));
      }
    }
    if (replacements.size === 0) return [];
    return [{
      trackId: track.id,
      clips: track.clips.map((clip) => replacements.get(clip.id) ?? clip),
    }];
  });
}
