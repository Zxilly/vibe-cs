import { msgf } from '../../shared/i18n';
import type { EditorProject } from '../../shared/desktop/dto';
import type { TimelineClip, TimelineTrack } from './timelineStore';

export const EDITOR_TRANSITIONS = [
  'none', 'fade', 'flash', 'dip', 'zoom', 'wipe', 'slide', 'blur', 'glitch', 'spin',
] as const;

export type EditorTransition = typeof EDITOR_TRANSITIONS[number];

export type KillAxisSourceEvent = {
  id: string;
  source_time: number;
  attacker: string;
  victim: string;
  weapon?: string;
};

export type KillAxisEvent = KillAxisSourceEvent & {
  timeline_time: number;
  clip_id: string;
};

export type ActiveTimelineClip = {
  clip: TimelineClip;
  localTime: number;
  trackId: string;
  trackKind: TimelineTrack['kind'];
};

const randomId = (): string => crypto.randomUUID();

export function duplicateTimelineClip(clip: TimelineClip, start: number): TimelineClip {
  return {
    ...clip,
    id: randomId(),
    start,
    name: msgf("m0103", [clip.name]),
    groupId: null,
    linkGroupId: null,
    keyframes: clip.keyframes?.map((keyframe) => ({ ...keyframe, id: randomId() })),
    speedSegments: clip.speedSegments?.map((segment) => ({ ...segment, id: randomId() })),
  };
}

function sourceTimeToLocalTime(clip: TimelineClip, sourceTime: number): number | null {
  const sourceOffset = sourceTime - clip.sourceIn;
  if (!Number.isFinite(sourceOffset) || sourceOffset < 0) return null;
  const segments = clip.speedSegments ?? [];
  if (segments.length === 0) {
    const localTime = sourceOffset / clip.speed;
    return localTime <= clip.duration + 0.000_001 ? localTime : null;
  }
  let consumedSource = 0;
  for (const segment of segments) {
    const sourceDuration = (segment.end - segment.start) * segment.speed;
    if (sourceOffset <= consumedSource + sourceDuration + 0.000_001) {
      return segment.start + (sourceOffset - consumedSource) / segment.speed;
    }
    consumedSource += sourceDuration;
  }
  return null;
}

export function mapKillAxisEvents(clip: TimelineClip): KillAxisEvent[] {
  const metadata = clip.metadata;
  if (!metadata || typeof metadata !== 'object') return [];
  const events = (metadata as { kill_events?: unknown }).kill_events;
  if (!Array.isArray(events)) return [];
  return events.flatMap((candidate): KillAxisEvent[] => {
    if (!candidate || typeof candidate !== 'object') return [];
    const event = candidate as Partial<KillAxisSourceEvent>;
    if (typeof event.id !== 'string'
      || typeof event.source_time !== 'number'
      || typeof event.attacker !== 'string'
      || typeof event.victim !== 'string') return [];
    const localTime = sourceTimeToLocalTime(clip, event.source_time);
    if (localTime === null || localTime < -0.000_001 || localTime > clip.duration + 0.000_001) {
      return [];
    }
    return [{
      id: event.id,
      source_time: event.source_time,
      attacker: event.attacker,
      victim: event.victim,
      ...(typeof event.weapon === 'string' ? { weapon: event.weapon } : {}),
      timeline_time: clip.start + localTime,
      clip_id: clip.id,
    }];
  }).sort((left, right) => left.timeline_time - right.timeline_time);
}

export function activeTimelineClips(
  tracks: TimelineTrack[],
  playhead: number,
): ActiveTimelineClip[] {
  if (!Number.isFinite(playhead) || playhead < 0) return [];
  return tracks.flatMap((track) => {
    if (track.hidden || track.muted) return [];
    return track.clips.flatMap((clip): ActiveTimelineClip[] => {
      const localTime = playhead - clip.start;
      if (!Number.isFinite(clip.start)
        || !Number.isFinite(clip.duration)
        || clip.duration <= 0
        || localTime < 0
        || localTime >= clip.duration) return [];
      return [{ clip, localTime, trackId: track.id, trackKind: track.kind }];
    });
  });
}

function separatedAudioOrigin(metadata: unknown): string | null {
  if (!metadata || typeof metadata !== 'object') return null;
  const value = metadata as {
    audio_origin?: { kind?: unknown; source_clip_id?: unknown };
  };
  if (value.audio_origin?.kind === 'separated_from_video'
    && typeof value.audio_origin.source_clip_id === 'string') {
    return value.audio_origin.source_clip_id;
  }
  return null;
}

export function hasSeparatedAudioChild(
  tracks: TimelineTrack[],
  sourceClipId: string,
): boolean {
  const source = tracks
    .flatMap((track) => track.clips)
    .find((clip) => clip.id === sourceClipId);
  if (!source?.linkGroupId) return false;
  return tracks
    .filter((track) => track.kind === 'audio')
    .flatMap((track) => track.clips)
    .some((clip) => clip.linkGroupId === source.linkGroupId
      && separatedAudioOrigin(clip.metadata) === sourceClipId);
}

export function isEditorTemplate(project: EditorProject): boolean {
  return Boolean(project.settings
    && typeof project.settings === 'object'
    && (project.settings as { is_template?: unknown }).is_template === true);
}

export function editorTransitionPreviewStyle(
  transition: string | null | undefined,
  entering: boolean,
  progress: number,
): React.CSSProperties {
  const clamped = Math.max(0, Math.min(1, progress));
  const phase = entering ? clamped : 1 - clamped;
  switch (transition) {
    case 'fade': return { opacity: phase };
    case 'flash': return { opacity: phase, filter: `brightness(${1 + (1 - phase) * 3})` };
    case 'dip': return { opacity: phase, filter: `brightness(${phase})` };
    case 'zoom': return { transform: `scale(${1 + (1 - phase) * 0.18})` };
    case 'wipe': return { clipPath: `inset(0 ${(1 - phase) * 100}% 0 0)` };
    case 'slide': return { transform: `translateX(${(phase - 1) * 100}%)` };
    case 'blur': return { filter: `blur(${(1 - phase) * 12}px)`, opacity: phase };
    case 'glitch': return { transform: `translateX(${(1 - phase) * 8}px)`, filter: `hue-rotate(${(1 - phase) * 90}deg)` };
    case 'spin': return { transform: `rotate(${(1 - phase) * 20}deg) scale(${0.9 + phase * 0.1})` };
    default: return {};
  }
}
