import { formatFrameTimecode } from './timeScale';

export type TimelineTimeDisplayMode = 'timecode' | 'frames';

export function formatTimelinePosition(seconds: number, fps: number, mode: TimelineTimeDisplayMode): string {
  const frames = Math.max(0, Math.round(seconds * fps));
  return mode === 'frames' ? String(frames) : formatFrameTimecode(frames / fps, fps);
}

export function parseTimelinePosition(value: string, fps: number, mode: TimelineTimeDisplayMode): number | null {
  const input = value.trim();
  if (mode === 'frames') {
    if (!/^\d+$/u.test(input)) return null;
    return Number(input) / fps;
  }
  const parts = input.split(':');
  if (parts.length !== 4 || parts.some((part) => !/^\d+$/u.test(part))) return null;
  const [hours, minutes, seconds, frames] = parts.map(Number) as [number, number, number, number];
  if (minutes >= 60 || seconds >= 60 || frames >= fps) return null;
  return hours * 3_600 + minutes * 60 + seconds + frames / fps;
}
