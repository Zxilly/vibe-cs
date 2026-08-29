import type {
  ProjectChangeGroup,
  TimelineClip,
} from '../../shared/desktop/dto';

const TIME_EPSILON = 1e-6;

export type TimelineClipChangeKind = 'added' | 'modified' | 'removed';

export interface TimelineClipChange {
  readonly number: number;
  readonly kind: TimelineClipChangeKind;
  readonly clipId: string;
  readonly current: TimelineClip | null;
  readonly previous: TimelineClip | null;
  readonly startDelta: number;
  readonly durationDelta: number;
  readonly originalOut: number | null;
  readonly rippleOnly: boolean;
}

export interface TimelineChangeProjection {
  readonly changes: readonly TimelineClipChange[];
  readonly operationCount: number;
  readonly previousDuration: number | null;
  readonly currentDuration: number;
}

/**
 * Read-only review projection over the canonical Story Track.
 *
 * The Project Head remains the only editable timeline. Inverse operations are
 * replayed only far enough to recover the previous Story clips used for inline
 * diff decoration; they are never persisted or exposed as a second timeline.
 */
export function projectStoryTimelineChanges(
  currentClips: readonly TimelineClip[],
  storyTrackId: string,
  group: ProjectChangeGroup | null,
): TimelineChangeProjection {
  const previousClips = previousStoryClips(currentClips, storyTrackId, group);
  const currentDuration = sequenceDuration(currentClips);
  if (group === null || previousClips === null) {
    return {
      changes: [],
      operationCount: group?.operations.length ?? 0,
      previousDuration: null,
      currentDuration,
    };
  }

  const previousById = new Map(previousClips.map((clip) => [clip.id, clip] as const));
  const currentById = new Map(currentClips.map((clip) => [clip.id, clip] as const));
  const pending: Omit<TimelineClipChange, 'number'>[] = [];

  for (const current of currentClips) {
    const previous = previousById.get(current.id) ?? null;
    if (previous === null) {
      if (current.placement.duration <= TIME_EPSILON) continue;
      pending.push({
        kind: 'added',
        clipId: current.id,
        current,
        previous: null,
        startDelta: 0,
        durationDelta: current.placement.duration,
        originalOut: null,
        rippleOnly: false,
      });
      continue;
    }
    if (!clipEquals(previous, current)) {
      pending.push({
        kind: 'modified',
        clipId: current.id,
        current,
        previous,
        startDelta: current.placement.start - previous.placement.start,
        durationDelta: current.placement.duration - previous.placement.duration,
        originalOut: previous.placement.start + previous.placement.duration,
        rippleOnly: differsOnlyByStart(previous, current),
      });
    }
  }

  for (const previous of previousClips) {
    if (currentById.has(previous.id)) continue;
    if (previous.placement.duration <= TIME_EPSILON) continue;
    pending.push({
      kind: 'removed',
      clipId: previous.id,
      current: null,
      previous,
      startDelta: 0,
      durationDelta: -previous.placement.duration,
      originalOut: previous.placement.start + previous.placement.duration,
      rippleOnly: false,
    });
  }

  pending.sort((left, right) => changeStart(left) - changeStart(right));
  return {
    changes: pending.map((change, index) => ({ ...change, number: index + 1 })),
    operationCount: group.operations.length,
    previousDuration: sequenceDuration(previousClips),
    currentDuration,
  };
}

function previousStoryClips(
  currentClips: readonly TimelineClip[],
  storyTrackId: string,
  group: ProjectChangeGroup | null,
): readonly TimelineClip[] | null {
  if (group === null) return null;
  let previous = [...currentClips];
  let touched = false;
  for (const operation of group.inverse_operations) {
    switch (operation.op) {
      case 'replace_track_clips':
        if (operation.track_id === storyTrackId) {
          previous = [...operation.clips];
          touched = true;
        }
        break;
      case 'replace_track':
        if (operation.track_id === storyTrackId) {
          previous = [...operation.track.clips];
          touched = true;
        }
        break;
      case 'insert_clip':
        if (operation.track_id === storyTrackId) {
          previous.splice(operation.index, 0, operation.clip);
          touched = true;
        }
        break;
      case 'remove_clip': {
        const index = previous.findIndex((clip) => clip.id === operation.clip_id);
        if (index >= 0) {
          previous.splice(index, 1);
          touched = true;
        }
        break;
      }
      case 'replace_clip': {
        const index = previous.findIndex((clip) => clip.id === operation.clip_id);
        if (index >= 0) {
          previous[index] = operation.clip;
          touched = true;
        }
        break;
      }
      default:
        break;
    }
  }
  return touched ? previous : null;
}

function clipEquals(left: TimelineClip, right: TimelineClip): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function differsOnlyByStart(left: TimelineClip, right: TimelineClip): boolean {
  return JSON.stringify({ ...left, placement: { ...left.placement, start: 0 } })
    === JSON.stringify({ ...right, placement: { ...right.placement, start: 0 } });
}

function sequenceDuration(clips: readonly TimelineClip[]): number {
  return clips.reduce(
    (duration, clip) => Math.max(duration, clip.placement.start + clip.placement.duration),
    0,
  );
}

function changeStart(change: Omit<TimelineClipChange, 'number'>): number {
  return change.current?.placement.start ?? change.previous?.placement.start ?? 0;
}

export function hasTimelineDelta(value: number): boolean {
  return Math.abs(value) > TIME_EPSILON;
}
