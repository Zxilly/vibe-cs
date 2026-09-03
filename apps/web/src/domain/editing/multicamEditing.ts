import type { Project, TimelineClip, TimelineTrack } from '../../shared/desktop/dto';

export interface MulticamAngleView {
  readonly groupId: string;
  readonly angle: number;
  readonly name: string;
  readonly switchAudio: boolean;
  readonly active: boolean;
  readonly clip: TimelineClip;
  readonly track: TimelineTrack;
}

export function multicamAnglesAtTime(project: Project, timelineTime: number): MulticamAngleView[] {
  const candidates: MulticamAngleView[] = [];
  for (const track of project.document.tracks) {
    if (track.kind !== 'video' && track.kind !== 'overlay') continue;
    for (const clip of track.clips) {
      if (timelineTime < clip.placement.start || timelineTime >= clip.placement.start + clip.placement.duration) continue;
      const metadata = multicamClipMetadata(clip);
      if (metadata === null) continue;
      candidates.push({ ...metadata, active: clip.placement.enabled, clip, track });
    }
  }
  if (candidates.length < 2) return [];
  const groupId = candidates.find((candidate) => candidate.active)?.groupId ?? candidates[0]!.groupId;
  return candidates
    .filter((candidate) => candidate.groupId === groupId)
    .sort((left, right) => left.angle - right.angle);
}

function multicamClipMetadata(clip: TimelineClip): Omit<MulticamAngleView, 'active' | 'clip' | 'track'> | null {
  if (typeof clip.metadata !== 'object' || clip.metadata === null || Array.isArray(clip.metadata)) return null;
  const value = clip.metadata.multicam;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const groupId = value.group_id;
  const angle = value.angle;
  const name = value.angle_name;
  const switchAudio = value.switch_audio;
  if (typeof groupId !== 'string'
    || typeof angle !== 'number'
    || !Number.isInteger(angle)
    || angle < 1
    || typeof name !== 'string'
    || typeof switchAudio !== 'boolean') return null;
  return { groupId, angle, name, switchAudio };
}
