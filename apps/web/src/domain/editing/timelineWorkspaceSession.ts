import type { TimelineClipboard } from './timelinePaste';

export interface TimelineWorkspaceSession {
  readonly selectedClipIds: readonly string[];
  readonly targetTrackIds: readonly string[];
  readonly syncLockedTrackIds: readonly string[];
  readonly linkedSelectionEnabled: boolean;
  readonly timelineTimeSeconds: number;
  readonly rangeInSeconds: number | null;
  readonly rangeOutSeconds: number | null;
  readonly loopPlaybackEnabled: boolean;
}

export interface TimelineSessionStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export function readTimelineWorkspaceSession(
  projectId: string,
  storage: TimelineSessionStorage | null,
): TimelineWorkspaceSession | null {
  return readStored(storage, timelineWorkspaceSessionKey(projectId), isTimelineWorkspaceSession);
}

export function writeTimelineWorkspaceSession(
  projectId: string,
  storage: TimelineSessionStorage | null,
  session: TimelineWorkspaceSession,
): void {
  writeStored(storage, timelineWorkspaceSessionKey(projectId), session);
}

export function readTimelineClipboard(
  projectId: string,
  storage: TimelineSessionStorage | null,
): TimelineClipboard | null {
  return readStored(storage, timelineClipboardKey(projectId), isTimelineClipboard);
}

export function writeTimelineClipboard(
  projectId: string,
  storage: TimelineSessionStorage | null,
  clipboard: TimelineClipboard | null,
): void {
  try {
    if (clipboard === null) storage?.removeItem(timelineClipboardKey(projectId));
    else storage?.setItem(timelineClipboardKey(projectId), JSON.stringify(clipboard));
  } catch {
    // Clipboard recovery is optional local view state; editing stays authoritative.
  }
}

export function timelineWorkspaceSessionKey(projectId: string): string {
  return `vibe-cs:timeline-session:${projectId}`;
}

export function timelineClipboardKey(projectId: string): string {
  return `vibe-cs:timeline-clipboard:${projectId}`;
}

function readStored<T>(
  storage: TimelineSessionStorage | null,
  key: string,
  validate: (value: unknown) => value is T,
): T | null {
  try {
    const serialized = storage?.getItem(key);
    if (serialized === null || serialized === undefined) return null;
    const parsed: unknown = JSON.parse(serialized);
    return validate(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function writeStored(storage: TimelineSessionStorage | null, key: string, value: unknown): void {
  try {
    storage?.setItem(key, JSON.stringify(value));
  } catch {
    // Local recovery failure cannot interrupt a canonical Project edit.
  }
}

function isTimelineWorkspaceSession(value: unknown): value is TimelineWorkspaceSession {
  if (!isRecord(value)) return false;
  return isStringArray(value.selectedClipIds)
    && isStringArray(value.targetTrackIds)
    && isStringArray(value.syncLockedTrackIds)
    && typeof value.linkedSelectionEnabled === 'boolean'
    && isFiniteNonNegative(value.timelineTimeSeconds)
    && isNullableFiniteNonNegative(value.rangeInSeconds)
    && isNullableFiniteNonNegative(value.rangeOutSeconds)
    && typeof value.loopPlaybackEnabled === 'boolean';
}

function isTimelineClipboard(value: unknown): value is TimelineClipboard {
  if (!isRecord(value)
    || !isFiniteNonNegative(value.originTime)
    || !isFiniteNonNegative(value.duration)
    || !Array.isArray(value.groups)) return false;
  return value.groups.every((group) => isRecord(group)
    && typeof group.trackId === 'string'
    && ['video', 'audio', 'text', 'overlay'].includes(String(group.trackKind))
    && Array.isArray(group.clips)
    && group.clips.every((clip) => isRecord(clip)
      && typeof clip.id === 'string'
      && isRecord(clip.placement)
      && isFiniteNonNegative(clip.placement.start)
      && isFiniteNonNegative(clip.placement.duration)));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isFiniteNonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isNullableFiniteNonNegative(value: unknown): value is number | null {
  return value === null || isFiniteNonNegative(value);
}
