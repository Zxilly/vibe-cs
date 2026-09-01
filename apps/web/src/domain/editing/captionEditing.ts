import type { TimelineClip, TimelineTrack } from '../../shared/desktop/dto';

const CAPTION_TIME_EPSILON_SECONDS = 1e-6;

export function timelineCaptionClips(tracks: readonly TimelineTrack[]): TimelineClip[] {
  return tracks
    .filter((track) => track.kind === 'caption' && !track.hidden)
    .flatMap((track) => track.clips)
    .filter((clip) => clip.placement.enabled && clip.text !== null)
    .sort((left, right) => (
      left.placement.start - right.placement.start || left.id.localeCompare(right.id)
    ));
}

export function adjacentCaptionClip(
  clips: readonly TimelineClip[],
  timelineTime: number,
  direction: -1 | 1,
): TimelineClip | null {
  const sorted = [...clips].sort((left, right) => (
    left.placement.start - right.placement.start || left.id.localeCompare(right.id)
  ));
  if (direction > 0) {
    return sorted.find((clip) => clip.placement.start > timelineTime + CAPTION_TIME_EPSILON_SECONDS) ?? null;
  }
  for (let index = sorted.length - 1; index >= 0; index -= 1) {
    const clip = sorted[index]!;
    if (clip.placement.start < timelineTime - CAPTION_TIME_EPSILON_SECONDS) return clip;
  }
  return null;
}

export function serializeCaptionSrt(tracks: readonly TimelineTrack[]): string {
  return timelineCaptionClips(tracks)
    .map((clip, index) => {
      const start = clip.placement.start;
      const end = start + clip.placement.duration;
      const content = clip.text?.content.trim() ?? '';
      return `${index + 1}\r\n${formatSrtTime(start)} --> ${formatSrtTime(end)}\r\n${content}\r\n`;
    })
    .join('\r\n');
}

function formatSrtTime(seconds: number): string {
  const milliseconds = Math.max(0, Math.round(seconds * 1_000));
  const hours = Math.floor(milliseconds / 3_600_000);
  const minutes = Math.floor((milliseconds % 3_600_000) / 60_000);
  const secs = Math.floor((milliseconds % 60_000) / 1_000);
  const millis = milliseconds % 1_000;
  return `${pad(hours, 2)}:${pad(minutes, 2)}:${pad(secs, 2)},${pad(millis, 3)}`;
}

function pad(value: number, length: number): string {
  return String(value).padStart(length, '0');
}
