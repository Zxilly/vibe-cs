import { msg, msgf } from '../../shared/i18n';
import { create } from 'zustand';

import type { EditorMarker } from '../../shared/api/dto';
import { MAX_EDITOR_TIMELINE_SECONDS, boundedTimelineValue, trimMarkersToDuration } from './projectState';

export type TimelineKeyframeProperty =
  | 'x' | 'y' | 'scale_x' | 'scale_y' | 'rotation' | 'opacity' | 'volume';

export type TimelineKeyframe = {
  id: string;
  time: number;
  property: TimelineKeyframeProperty;
  value: number;
};

export type TimelineSpeedSegment = {
  id: string;
  start: number;
  end: number;
  speed: number;
};

export type TimelineClip = {
  id: string;
  assetId: string | null;
  name: string;
  start: number;
  duration: number;
  sourceIn: number;
  sourceOut: number;
  speed: number;
  volume: number;
  color: string;
  transform?: {
    x: number;
    y: number;
    scale_x: number;
    scale_y: number;
    rotation: number;
    opacity: number;
  } | undefined;
  effects?: Array<{ id: string; kind: string; enabled: boolean; parameters: unknown }> | undefined;
  transitionIn?: string | null | undefined;
  transitionOut?: string | null | undefined;
  text?: {
    content: string;
    font_family: string;
    font_asset_id?: string | null;
    font_size: number;
    color: string;
    background: string | null;
    align: string;
  } | null | undefined;
  metadata?: unknown;
  groupId?: string | null | undefined;
  linkGroupId?: string | null | undefined;
  keyframes?: TimelineKeyframe[] | undefined;
  speedSegments?: TimelineSpeedSegment[] | undefined;
};

export type TimelineTrack = {
  id: string;
  name: string;
  kind: 'video' | 'audio' | 'text' | 'overlay';
  muted: boolean;
  locked: boolean;
  hidden?: boolean | undefined;
  clips: TimelineClip[];
};

export type TimelineOperationResult =
  | { ok: true }
  | { ok: false; reason: string };

type TimelineSnapshot = Pick<TimelineState, 'tracks' | 'markers' | 'selectedClipId' | 'selectedClipIds' | 'playhead' | 'durationFloor'>;

type TimelineState = {
  tracks: TimelineTrack[];
  markers: EditorMarker[];
  selectedClipId: string | null;
  selectedClipIds: string[];
  playhead: number;
  duration: number;
  durationFloor: number;
  zoom: number;
  snapping: boolean;
  ripple: boolean;
  past: TimelineSnapshot[];
  future: TimelineSnapshot[];
  selectClip: (id: string | null, additive?: boolean) => void;
  setPlayhead: (seconds: number) => void;
  setProjectDuration: (seconds: number) => TimelineOperationResult;
  addMarker: (marker: EditorMarker) => TimelineOperationResult;
  removeMarker: (id: string) => TimelineOperationResult;
  setZoom: (zoom: number) => void;
  toggleSnapping: () => void;
  toggleRipple: () => void;
  toggleTrackLock: (trackId: string) => void;
  addClip: (trackId: string, clip: TimelineClip, ripple?: boolean) => TimelineOperationResult;
  moveClip: (clipId: string, trackId: string, start: number, ripple?: boolean) => TimelineOperationResult;
  updateClip: (clipId: string, patch: Partial<Omit<TimelineClip, 'id'>>) => TimelineOperationResult;
  trimClip: (clipId: string, sourceIn: number, duration: number) => TimelineOperationResult;
  slipClip: (clipId: string, delta: number, sourceDurations: Record<string, number>) => TimelineOperationResult;
  splitClip: (clipId: string, at: number) => TimelineOperationResult;
  removeClip: (clipId: string, ripple?: boolean) => TimelineOperationResult;
  groupSelected: () => TimelineOperationResult;
  ungroupSelected: () => TimelineOperationResult;
  linkSelected: () => TimelineOperationResult;
  unlinkSelected: () => TimelineOperationResult;
  upsertKeyframe: (
    clipId: string,
    property: TimelineKeyframeProperty,
    time: number,
    value: number,
  ) => TimelineOperationResult;
  removeKeyframe: (clipId: string, keyframeId: string) => TimelineOperationResult;
  setSpeedSegments: (
    clipId: string,
    segments: Array<Omit<TimelineSpeedSegment, 'id'> & { id?: string }>,
    sourceDuration?: number,
  ) => TimelineOperationResult;
  undo: () => void;
  redo: () => void;
  reset: (tracks?: TimelineTrack[], authoritativeDuration?: number, markers?: EditorMarker[]) => void;
};

const succeeded: TimelineOperationResult = { ok: true };
const failed = (reason: string): TimelineOperationResult => ({ ok: false, reason });

const makeId = (): string =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `clip-${Date.now()}-${Math.random().toString(16).slice(2)}`;

const contentDuration = (tracks: TimelineTrack[]): number => boundedTimelineValue(
  Math.max(0, ...tracks.flatMap((track) => track.clips.map((clip) => clip.start + clip.duration))),
  0,
);

const timelineDuration = (tracks: TimelineTrack[], durationFloor = 0): number =>
  Math.max(contentDuration(tracks), boundedTimelineValue(durationFloor, 0));

const snapshot = (state: TimelineState): TimelineSnapshot => ({
  tracks: state.tracks,
  markers: state.markers,
  selectedClipId: state.selectedClipId,
  selectedClipIds: state.selectedClipIds,
  playhead: state.playhead,
  durationFloor: state.durationFloor,
});

const history = (state: TimelineState) => ({
  past: [...state.past.slice(-49), snapshot(state)],
  future: [] as TimelineSnapshot[],
});

const timelineMutation = (state: TimelineState, tracks: TimelineTrack[]) => {
  const duration = timelineDuration(tracks, state.durationFloor);
  return {
    tracks,
    duration,
    markers: trimMarkersToDuration(state.markers, duration).markers,
    ...history(state),
  };
};

const normalizedClip = (clip: TimelineClip): TimelineClip => {
  const duration = boundedTimelineValue(clip.duration, 0.1, 0.01);
  const start = boundedTimelineValue(
    clip.start,
    0,
    0,
    MAX_EDITOR_TIMELINE_SECONDS - duration,
  );
  const speed = boundedTimelineValue(clip.speed, 1, 0.05, 16);
  const sourceIn = Math.max(0, Number.isFinite(clip.sourceIn) ? clip.sourceIn : 0);
  const sourceOut = Number.isFinite(clip.sourceOut) && clip.sourceOut > sourceIn
    ? clip.sourceOut
    : sourceIn + duration * speed;
  return {
    ...clip,
    start,
    duration,
    sourceIn,
    sourceOut,
    speed,
    groupId: clip.groupId ?? null,
    linkGroupId: clip.linkGroupId ?? null,
    keyframes: [...(clip.keyframes ?? [])].sort((left, right) =>
      left.time - right.time || left.property.localeCompare(right.property)),
    speedSegments: [...(clip.speedSegments ?? [])].sort((left, right) => left.start - right.start),
  };
};

const sortedTracks = (tracks: TimelineTrack[]): TimelineTrack[] => tracks.map((track) => ({
  ...track,
  clips: [...track.clips].map(normalizedClip).sort((left, right) => left.start - right.start),
}));

const clipLocation = (tracks: TimelineTrack[], clipId: string) => {
  for (const track of tracks) {
    const clip = track.clips.find((candidate) => candidate.id === clipId);
    if (clip) return { track, clip };
  }
  return null;
};

const relatedClipIds = (tracks: TimelineTrack[], seedId: string): Set<string> => {
  const related = new Set([seedId]);
  let changed = true;
  while (changed) {
    changed = false;
    const memberships = tracks.flatMap((track) => track.clips)
      .filter((clip) => related.has(clip.id))
      .flatMap((clip) => [clip.groupId, clip.linkGroupId])
      .filter((value): value is string => Boolean(value));
    for (const clip of tracks.flatMap((track) => track.clips)) {
      if (related.has(clip.id)) continue;
      if ((clip.groupId && memberships.includes(clip.groupId))
        || (clip.linkGroupId && memberships.includes(clip.linkGroupId))) {
        related.add(clip.id);
        changed = true;
      }
    }
  }
  return related;
};

const normalizeMembership = (tracks: TimelineTrack[]): TimelineTrack[] => {
  const groupCounts = new Map<string, number>();
  const linkCounts = new Map<string, number>();
  for (const clip of tracks.flatMap((track) => track.clips)) {
    if (clip.groupId) groupCounts.set(clip.groupId, (groupCounts.get(clip.groupId) ?? 0) + 1);
    if (clip.linkGroupId) linkCounts.set(clip.linkGroupId, (linkCounts.get(clip.linkGroupId) ?? 0) + 1);
  }
  return sortedTracks(tracks.map((track) => ({
    ...track,
    clips: track.clips.map((clip) => ({
      ...clip,
      groupId: clip.groupId && (groupCounts.get(clip.groupId) ?? 0) >= 2 ? clip.groupId : null,
      linkGroupId: clip.linkGroupId && (linkCounts.get(clip.linkGroupId) ?? 0) >= 2 ? clip.linkGroupId : null,
    })),
  })));
};

const lockedRelatedTrack = (tracks: TimelineTrack[], ids: Set<string>): TimelineTrack | undefined =>
  tracks.find((track) => track.locked && track.clips.some((clip) => ids.has(clip.id)));

const sourceOffsetAt = (clip: TimelineClip, time: number): number => {
  const segments = clip.speedSegments ?? [];
  if (segments.length === 0) return time * clip.speed;
  return segments.reduce((offset, segment) =>
    time <= segment.start
      ? offset
      : offset + Math.max(0, Math.min(time, segment.end) - segment.start) * segment.speed, 0);
};

const splitSpeedSegments = (segments: TimelineSpeedSegment[], at: number) => {
  const left: TimelineSpeedSegment[] = [];
  const right: TimelineSpeedSegment[] = [];
  for (const segment of segments) {
    if (segment.start < at) {
      left.push({ ...segment, end: Math.min(segment.end, at) });
    }
    if (segment.end > at) {
      right.push({
        ...segment,
        id: makeId(),
        start: Math.max(segment.start, at) - at,
        end: segment.end - at,
      });
    }
  }
  return { left, right };
};

const propertyBaseValue = (clip: TimelineClip, property: TimelineKeyframeProperty): number => {
  const transform = clip.transform ?? { x: 0, y: 0, scale_x: 1, scale_y: 1, rotation: 0, opacity: 1 };
  if (property === 'volume') return clip.volume;
  return transform[property];
};

const validKeyframeValue = (property: TimelineKeyframeProperty, value: number): boolean => {
  if (!Number.isFinite(value)) return false;
  if (property === 'x' || property === 'y') return value >= -100_000 && value <= 100_000;
  if (property === 'scale_x' || property === 'scale_y') return value >= 0.01 && value <= 10;
  if (property === 'rotation') return value >= -3_600 && value <= 3_600;
  if (property === 'opacity') return value >= 0 && value <= 1;
  return value >= 0 && value <= 4;
};

const trackSupportsKeyframe = (track: TimelineTrack, clip: TimelineClip, property: TimelineKeyframeProperty): boolean => {
  if (track.kind === 'audio') return property === 'volume';
  if (track.kind === 'text' || clip.text) return property === 'x' || property === 'y' || property === 'opacity';
  return true;
};

export const interpolateTimelineProperty = (
  clip: TimelineClip,
  property: TimelineKeyframeProperty,
  localTime: number,
): number => {
  const points = (clip.keyframes ?? []).filter((keyframe) => keyframe.property === property);
  if (points.length === 0) return propertyBaseValue(clip, property);
  if (localTime <= (points[0]?.time ?? 0)) return points[0]?.value ?? propertyBaseValue(clip, property);
  for (let index = 1; index < points.length; index += 1) {
    const left = points[index - 1];
    const right = points[index];
    if (!left || !right || localTime > right.time) continue;
    const progress = (localTime - left.time) / (right.time - left.time);
    return left.value + (right.value - left.value) * progress;
  }
  return points.at(-1)?.value ?? propertyBaseValue(clip, property);
};

export const useTimelineStore = create<TimelineState>((set) => ({
  tracks: [],
  markers: [],
  selectedClipId: null,
  selectedClipIds: [],
  playhead: 0,
  duration: 0,
  durationFloor: 0,
  zoom: 1,
  snapping: true,
  ripple: false,
  past: [],
  future: [],
  selectClip: (selectedClipId, additive = false) => set((state) => {
    if (!selectedClipId) return { selectedClipId: null, selectedClipIds: [] };
    if (!additive) return { selectedClipId, selectedClipIds: [selectedClipId] };
    const selectedClipIds = state.selectedClipIds.includes(selectedClipId)
      ? state.selectedClipIds.filter((id) => id !== selectedClipId)
      : [...state.selectedClipIds, selectedClipId];
    return {
      selectedClipId: selectedClipIds.includes(selectedClipId)
        ? selectedClipId
        : selectedClipIds.at(-1) ?? null,
      selectedClipIds,
    };
  }),
  setPlayhead: (playhead) => set((state) => ({
    playhead: boundedTimelineValue(playhead, state.playhead, 0, state.duration),
  })),
  setProjectDuration: (seconds) => {
    let outcome = failed(msg("m0482"));
    set((state) => {
      const minimum = contentDuration(state.tracks);
      if (!Number.isFinite(seconds)
        || seconds < minimum
        || seconds > MAX_EDITOR_TIMELINE_SECONDS) return state;
      const durationFloor = seconds;
      outcome = succeeded;
      return {
        durationFloor,
        duration: timelineDuration(state.tracks, durationFloor),
        playhead: Math.min(state.playhead, durationFloor),
        markers: trimMarkersToDuration(state.markers, durationFloor).markers,
        ...history(state),
      };
    });
    return outcome;
  },
  addMarker: (marker) => {
    let outcome = failed(msg("m0819"));
    set((state) => {
      if (!Number.isFinite(marker.time)
        || marker.time < 0
        || marker.time > state.duration
        || state.markers.some((item) => item.id === marker.id)) return state;
      outcome = succeeded;
      return {
        markers: [...state.markers, marker].sort((left, right) => left.time - right.time),
        ...history(state),
      };
    });
    return outcome;
  },
  removeMarker: (id) => {
    let outcome = failed(msg("m0756"));
    set((state) => {
      if (!state.markers.some((marker) => marker.id === id)) return state;
      outcome = succeeded;
      return {
        markers: state.markers.filter((marker) => marker.id !== id),
        ...history(state),
      };
    });
    return outcome;
  },
  setZoom: (zoom) => set((state) => ({
    zoom: boundedTimelineValue(zoom, state.zoom, 0.5, 3),
  })),
  toggleSnapping: () => set((state) => ({ snapping: !state.snapping })),
  toggleRipple: () => set((state) => ({ ripple: !state.ripple })),
  toggleTrackLock: (trackId) => set((state) => {
    if (!state.tracks.some((track) => track.id === trackId)) return state;
    return {
      tracks: state.tracks.map((track) =>
        track.id === trackId ? { ...track, locked: !track.locked } : track),
      ...history(state),
    };
  }),
  addClip: (trackId, clip, ripple = false) => {
    let outcome = failed(msg("m0758"));
    set((state) => {
      const destination = state.tracks.find((track) => track.id === trackId);
      if (!destination) return state;
      if (destination.locked) {
        outcome = failed(msg("m1018"));
        return state;
      }
      const inserted = normalizedClip(clip);
      if (ripple && destination.clips.some((item) =>
        item.start < inserted.start && item.start + item.duration > inserted.start)) {
        outcome = failed(msg("m0906"));
        return state;
      }
      const tracks = sortedTracks(state.tracks.map((track) => {
        if (track.id !== trackId) return track;
        const clips = ripple
          ? track.clips.map((item) => item.start >= inserted.start
            ? { ...item, start: item.start + inserted.duration }
            : item)
          : track.clips;
        return { ...track, clips: [...clips, inserted] };
      }));
      outcome = succeeded;
      return {
        ...timelineMutation(state, tracks),
        selectedClipId: inserted.id,
        selectedClipIds: [inserted.id],
      };
    });
    return outcome;
  },
  moveClip: (clipId, trackId, start, ripple = false) => {
    let outcome = failed(msg("m0757"));
    set((state) => {
      const location = clipLocation(state.tracks, clipId);
      const destination = state.tracks.find((track) => track.id === trackId);
      if (!location || !destination) return state;
      const related = relatedClipIds(state.tracks, clipId);
      const locked = lockedRelatedTrack(state.tracks, related);
      if (locked || destination.locked) {
        outcome = failed(msgf("m1173", [locked?.name ?? destination.name]));
        return state;
      }
      if (related.size > 1 && destination.id !== location.track.id) {
        outcome = failed(msg("m1074"));
        return state;
      }
      if (related.size === 1 && destination.kind !== location.track.kind) {
        outcome = failed(msg("m0956"));
        return state;
      }
      const members = state.tracks.flatMap((track) => track.clips)
        .filter((clip) => related.has(clip.id));
      const unitStart = Math.min(...members.map((clip) => clip.start));
      const requestedStart = Math.max(0, start);
      const delta = requestedStart - location.clip.start;
      if (members.some((clip) => clip.start + delta < 0)) {
        outcome = failed(msg("m1046"));
        return state;
      }
      let tracks = state.tracks;
      if (!ripple) {
        tracks = tracks.map((track) => ({
          ...track,
          clips: track.clips
            .filter((clip) => !(related.size === 1 && clip.id === clipId && track.id !== destination.id))
            .map((clip) => related.has(clip.id) ? { ...clip, start: clip.start + delta } : clip),
        }));
        if (related.size === 1 && destination.id !== location.track.id) {
          tracks = tracks.map((track) => track.id === destination.id
            ? { ...track, clips: [...track.clips, { ...location.clip, start: requestedStart }] }
            : track);
        }
      } else if (related.size === 1 && destination.id !== location.track.id) {
        tracks = tracks.map((track) => {
          if (track.id === location.track.id) {
            return {
              ...track,
              clips: track.clips.filter((clip) => clip.id !== clipId).map((clip) =>
                clip.start >= location.clip.start + location.clip.duration
                  ? { ...clip, start: clip.start - location.clip.duration }
                  : clip),
            };
          }
          if (track.id === destination.id) {
            return {
              ...track,
              clips: [
                ...track.clips.map((clip) => clip.start >= requestedStart
                  ? { ...clip, start: clip.start + location.clip.duration }
                  : clip),
                { ...location.clip, start: requestedStart },
              ],
            };
          }
          return track;
        });
      } else {
        const envelopes = new Map<string, { start: number; end: number }>();
        for (const track of tracks) {
          const clips = track.clips.filter((clip) => related.has(clip.id));
          if (clips.length > 0) {
            envelopes.set(track.id, {
              start: Math.min(...clips.map((clip) => clip.start)),
              end: Math.max(...clips.map((clip) => clip.start + clip.duration)),
            });
          }
        }
        const targetUnitStart = Math.max(0, unitStart + delta);
        tracks = tracks.map((track) => {
          const envelope = envelopes.get(track.id);
          if (!envelope) return track;
          const span = envelope.end - envelope.start;
          const insertion = targetUnitStart + (envelope.start - unitStart);
          const membersOnTrack = track.clips.filter((clip) => related.has(clip.id));
          let others = track.clips.filter((clip) => !related.has(clip.id)).map((clip) =>
            clip.start >= envelope.end ? { ...clip, start: clip.start - span } : clip);
          others = others.map((clip) => clip.start >= insertion
            ? { ...clip, start: clip.start + span }
            : clip);
          return {
            ...track,
            clips: [...others, ...membersOnTrack.map((clip) => ({ ...clip, start: clip.start + delta }))],
          };
        });
      }
      tracks = sortedTracks(tracks);
      outcome = succeeded;
      return timelineMutation(state, tracks);
    });
    return outcome;
  },
  updateClip: (clipId, patch) => {
    let outcome = failed(msg("m0757"));
    set((state) => {
      const location = clipLocation(state.tracks, clipId);
      if (!location) return state;
      if (location.track.locked) {
        outcome = failed(msg("m0963"));
        return state;
      }
      const tracks = sortedTracks(state.tracks.map((track) => ({
        ...track,
        clips: track.clips.map((clip) => clip.id === clipId ? normalizedClip({ ...clip, ...patch }) : clip),
      })));
      outcome = succeeded;
      return timelineMutation(state, tracks);
    });
    return outcome;
  },
  trimClip: (clipId, sourceIn, duration) => {
    let outcome = failed(msg("m0757"));
    set((state) => {
      const location = clipLocation(state.tracks, clipId);
      if (!location) return state;
      if (location.track.locked) {
        outcome = failed(msg("m0963"));
        return state;
      }
      if ((location.clip.speedSegments?.length ?? 0) > 0) {
        outcome = failed(msg("m1249"));
        return state;
      }
      const nextSourceIn = Math.max(0, sourceIn);
      const nextDuration = Math.max(0.1, duration);
      const tracks = sortedTracks(state.tracks.map((track) => ({
        ...track,
        clips: track.clips.map((clip) => clip.id === clipId ? {
          ...clip,
          sourceIn: nextSourceIn,
          duration: nextDuration,
          sourceOut: nextSourceIn + nextDuration * clip.speed,
          keyframes: (clip.keyframes ?? []).filter((keyframe) => keyframe.time <= nextDuration),
        } : clip),
      })));
      outcome = succeeded;
      return timelineMutation(state, tracks);
    });
    return outcome;
  },
  slipClip: (clipId, delta, sourceDurations) => {
    let outcome = failed(msg("m0757"));
    set((state) => {
      const location = clipLocation(state.tracks, clipId);
      if (!location || !Number.isFinite(delta)) return state;
      const linked = location.clip.linkGroupId
        ? new Set(state.tracks.flatMap((track) => track.clips)
          .filter((clip) => clip.linkGroupId === location.clip.linkGroupId)
          .map((clip) => clip.id))
        : new Set([clipId]);
      const locked = lockedRelatedTrack(state.tracks, linked);
      if (locked) {
        outcome = failed(msgf("m1173", [locked.name]));
        return state;
      }
      const members = state.tracks.flatMap((track) => track.clips).filter((clip) => linked.has(clip.id));
      for (const clip of members) {
        const sourceDuration = clip.assetId ? sourceDurations[clip.assetId] : undefined;
        if (!sourceDuration) {
          outcome = failed(msgf("m0127", [clip.name]));
          return state;
        }
        if (clip.sourceIn + delta < 0 || clip.sourceOut + delta > sourceDuration + 0.000_001) {
          outcome = failed(msgf("m0125", [clip.name]));
          return state;
        }
      }
      const tracks = state.tracks.map((track) => ({
        ...track,
        clips: track.clips.map((clip) => linked.has(clip.id) ? {
          ...clip,
          sourceIn: clip.sourceIn + delta,
          sourceOut: clip.sourceOut + delta,
        } : clip),
      }));
      outcome = succeeded;
      return { tracks, ...history(state) };
    });
    return outcome;
  },
  splitClip: (clipId, at) => {
    let outcome = failed(msg("m0675"));
    set((state) => {
      const location = clipLocation(state.tracks, clipId);
      if (!location) return state;
      if (location.track.locked) {
        outcome = failed(msg("m0963"));
        return state;
      }
      if (location.clip.groupId || location.clip.linkGroupId) {
        outcome = failed(msg("m1134"));
        return state;
      }
      const localAt = at - location.clip.start;
      if (localAt <= 0.1 || localAt >= location.clip.duration - 0.1) return state;
      const sourceAt = location.clip.sourceIn + sourceOffsetAt(location.clip, localAt);
      const { left, right } = splitSpeedSegments(location.clip.speedSegments ?? [], localAt);
      const leftKeyframes = (location.clip.keyframes ?? []).filter((keyframe) => keyframe.time <= localAt);
      const rightKeyframes = (location.clip.keyframes ?? []).flatMap((keyframe) => {
        if (keyframe.time < localAt) return [];
        return [{ ...keyframe, id: makeId(), time: keyframe.time - localAt }];
      });
      const rightId = makeId();
      const tracks = sortedTracks(state.tracks.map((track) => ({
        ...track,
        clips: track.clips.flatMap((clip) => clip.id !== clipId ? [clip] : [
          {
            ...clip,
            duration: localAt,
            sourceOut: sourceAt,
            keyframes: leftKeyframes,
            speedSegments: left,
          },
          {
            ...clip,
            id: rightId,
            name: msgf("m0094", [clip.name]),
            start: at,
            duration: clip.duration - localAt,
            sourceIn: sourceAt,
            keyframes: rightKeyframes,
            speedSegments: right,
          },
        ]),
      })));
      outcome = succeeded;
      return {
        ...timelineMutation(state, tracks),
        selectedClipId: rightId,
        selectedClipIds: [rightId],
      };
    });
    return outcome;
  },
  removeClip: (clipId, ripple = false) => {
    let outcome = failed(msg("m0757"));
    set((state) => {
      if (!clipLocation(state.tracks, clipId)) return state;
      const related = relatedClipIds(state.tracks, clipId);
      const locked = lockedRelatedTrack(state.tracks, related);
      if (locked) {
        outcome = failed(msgf("m1173", [locked.name]));
        return state;
      }
      const tracks = normalizeMembership(state.tracks.map((track) => {
        const removed = track.clips.filter((clip) => related.has(clip.id));
        if (removed.length === 0) return track;
        const start = Math.min(...removed.map((clip) => clip.start));
        const end = Math.max(...removed.map((clip) => clip.start + clip.duration));
        const remaining = track.clips.filter((clip) => !related.has(clip.id)).map((clip) =>
          ripple && clip.start >= end ? { ...clip, start: clip.start - (end - start) } : clip);
        return { ...track, clips: remaining };
      }));
      outcome = succeeded;
      return {
        ...timelineMutation(state, tracks),
        selectedClipId: related.has(state.selectedClipId ?? '') ? null : state.selectedClipId,
        selectedClipIds: state.selectedClipIds.filter((id) => !related.has(id)),
      };
    });
    return outcome;
  },
  groupSelected: () => {
    let outcome = failed(msg("m1101"));
    set((state) => {
      const ids = new Set(state.selectedClipIds);
      if (ids.size < 2) return state;
      const locked = lockedRelatedTrack(state.tracks, ids);
      if (locked) {
        outcome = failed(msgf("m1173", [locked.name]));
        return state;
      }
      const groupId = makeId();
      const tracks = normalizeMembership(state.tracks.map((track) => ({
        ...track,
        clips: track.clips.map((clip) => ids.has(clip.id) ? { ...clip, groupId } : clip),
      })));
      outcome = succeeded;
      return { tracks, ...history(state) };
    });
    return outcome;
  },
  ungroupSelected: () => {
    let outcome = failed(msg("m0632"));
    set((state) => {
      const selectedGroups = new Set(state.tracks.flatMap((track) => track.clips)
        .filter((clip) => state.selectedClipIds.includes(clip.id))
        .map((clip) => clip.groupId)
        .filter((value): value is string => Boolean(value)));
      if (selectedGroups.size === 0) return state;
      const affected = new Set(state.tracks.flatMap((track) => track.clips)
        .filter((clip) => clip.groupId && selectedGroups.has(clip.groupId))
        .map((clip) => clip.id));
      const locked = lockedRelatedTrack(state.tracks, affected);
      if (locked) {
        outcome = failed(msgf("m1173", [locked.name]));
        return state;
      }
      const tracks = state.tracks.map((track) => ({
        ...track,
        clips: track.clips.map((clip) => affected.has(clip.id) ? { ...clip, groupId: null } : clip),
      }));
      outcome = succeeded;
      return { tracks, ...history(state) };
    });
    return outcome;
  },
  linkSelected: () => {
    let outcome = failed(msg("m1100"));
    set((state) => {
      const ids = new Set(state.selectedClipIds);
      const selectedTracks = state.tracks.filter((track) => track.clips.some((clip) => ids.has(clip.id)));
      if (ids.size < 2 || selectedTracks.length < 2) return state;
      const locked = lockedRelatedTrack(state.tracks, ids);
      if (locked) {
        outcome = failed(msgf("m1173", [locked.name]));
        return state;
      }
      const linkGroupId = makeId();
      const tracks = normalizeMembership(state.tracks.map((track) => ({
        ...track,
        clips: track.clips.map((clip) => ids.has(clip.id) ? { ...clip, linkGroupId } : clip),
      })));
      outcome = succeeded;
      return { tracks, ...history(state) };
    });
    return outcome;
  },
  unlinkSelected: () => {
    let outcome = failed(msg("m0633"));
    set((state) => {
      const selectedLinks = new Set(state.tracks.flatMap((track) => track.clips)
        .filter((clip) => state.selectedClipIds.includes(clip.id))
        .map((clip) => clip.linkGroupId)
        .filter((value): value is string => Boolean(value)));
      if (selectedLinks.size === 0) return state;
      const affected = new Set(state.tracks.flatMap((track) => track.clips)
        .filter((clip) => clip.linkGroupId && selectedLinks.has(clip.linkGroupId))
        .map((clip) => clip.id));
      const locked = lockedRelatedTrack(state.tracks, affected);
      if (locked) {
        outcome = failed(msgf("m1173", [locked.name]));
        return state;
      }
      const tracks = state.tracks.map((track) => ({
        ...track,
        clips: track.clips.map((clip) => affected.has(clip.id) ? { ...clip, linkGroupId: null } : clip),
      }));
      outcome = succeeded;
      return { tracks, ...history(state) };
    });
    return outcome;
  },
  upsertKeyframe: (clipId, property, time, value) => {
    let outcome = failed(msg("m0242"));
    set((state) => {
      const location = clipLocation(state.tracks, clipId);
      if (!location || location.track.locked || !Number.isFinite(time)
        || time < 0 || time > location.clip.duration) return state;
      if (!trackSupportsKeyframe(location.track, location.clip, property)) {
        outcome = failed(msg("m1125"));
        return state;
      }
      if (!validKeyframeValue(property, value)) {
        outcome = failed(msg("m0241"));
        return state;
      }
      const keyframes = [...(location.clip.keyframes ?? [])];
      const existing = keyframes.findIndex((keyframe) =>
        keyframe.property === property && Math.abs(keyframe.time - time) < 0.000_001);
      if (existing >= 0) {
        const current = keyframes[existing];
        if (current) keyframes[existing] = { ...current, value };
      } else {
        if (keyframes.length >= 128) {
          outcome = failed(msg("m0882"));
          return state;
        }
        keyframes.push({ id: makeId(), property, time, value });
      }
      keyframes.sort((left, right) => left.time - right.time || left.property.localeCompare(right.property));
      const tracks = state.tracks.map((track) => ({
        ...track,
        clips: track.clips.map((clip) => clip.id === clipId ? { ...clip, keyframes } : clip),
      }));
      outcome = succeeded;
      return { tracks, ...history(state) };
    });
    return outcome;
  },
  removeKeyframe: (clipId, keyframeId) => {
    let outcome = failed(msg("m0755"));
    set((state) => {
      const location = clipLocation(state.tracks, clipId);
      if (!location || location.track.locked
        || !(location.clip.keyframes ?? []).some((keyframe) => keyframe.id === keyframeId)) return state;
      const tracks = state.tracks.map((track) => ({
        ...track,
        clips: track.clips.map((clip) => clip.id === clipId ? {
          ...clip,
          keyframes: (clip.keyframes ?? []).filter((keyframe) => keyframe.id !== keyframeId),
        } : clip),
      }));
      outcome = succeeded;
      return { tracks, ...history(state) };
    });
    return outcome;
  },
  setSpeedSegments: (clipId, rawSegments, sourceDuration) => {
    let outcome = failed(msg("m1248"));
    set((state) => {
      const location = clipLocation(state.tracks, clipId);
      if (!location || location.track.locked || !location.clip.assetId || rawSegments.length > 16) return state;
      const speedSegments = rawSegments
        .map((segment) => ({ ...segment, id: segment.id ?? makeId() }))
        .sort((left, right) => left.start - right.start);
      let cursor = 0;
      let sourceSpan = 0;
      for (const segment of speedSegments) {
        if (!Number.isFinite(segment.start) || !Number.isFinite(segment.end)
          || !Number.isFinite(segment.speed) || Math.abs(segment.start - cursor) > 0.000_001
          || segment.end <= segment.start || segment.speed < 0.05 || segment.speed > 16) return state;
        cursor = segment.end;
        sourceSpan += (segment.end - segment.start) * segment.speed;
      }
      if (speedSegments.length > 0 && Math.abs(cursor - location.clip.duration) > 0.000_001) return state;
      const sourceOut = speedSegments.length > 0
        ? location.clip.sourceIn + sourceSpan
        : location.clip.sourceIn + location.clip.duration * location.clip.speed;
      if (sourceDuration !== undefined && sourceOut > sourceDuration + 0.000_001) {
        outcome = failed(msg("m1247"));
        return state;
      }
      const tracks = state.tracks.map((track) => ({
        ...track,
        clips: track.clips.map((clip) => clip.id === clipId ? {
          ...clip,
          speed: speedSegments.length > 0 ? 1 : clip.speed,
          sourceOut,
          speedSegments,
        } : clip),
      }));
      outcome = succeeded;
      return { tracks, ...history(state) };
    });
    return outcome;
  },
  undo: () => set((state) => {
    const previous = state.past.at(-1);
    if (!previous) return state;
    return {
      ...previous,
      duration: timelineDuration(previous.tracks, previous.durationFloor),
      past: state.past.slice(0, -1),
      future: [snapshot(state), ...state.future.slice(0, 49)],
    };
  }),
  redo: () => set((state) => {
    const next = state.future[0];
    if (!next) return state;
    return {
      ...next,
      duration: timelineDuration(next.tracks, next.durationFloor),
      past: [...state.past.slice(-49), snapshot(state)],
      future: state.future.slice(1),
    };
  }),
  reset: (tracks = [], authoritativeDuration = 0, markers = []) => {
    const normalized = sortedTracks(tracks);
    const durationFloor = boundedTimelineValue(authoritativeDuration, 0);
    const duration = timelineDuration(normalized, durationFloor);
    set({
      tracks: normalized,
      markers: trimMarkersToDuration(markers, duration).markers,
      selectedClipId: null,
      selectedClipIds: [],
      playhead: 0,
      duration,
      durationFloor,
      past: [],
      future: [],
    });
  },
}));
