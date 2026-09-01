import type { Project, TimelineClip, TimelineTrack } from '../../shared/desktop/dto';
import { evaluateClipKeyframeProperty } from './keyframeEditing';
import { clipAudioFadeFactor } from './timelineInteraction';
import { evaluateTrackAudioProperty } from './trackAudioEditing';

export function timelineHasSoloTrack(project: Project): boolean {
  return project.document.tracks.some((track) => !track.hidden && !track.muted && track.solo);
}

export function timelineTrackAudible(project: Project, track: TimelineTrack): boolean {
  return !track.hidden
    && !track.muted
    && (!timelineHasSoloTrack(project) || track.solo);
}

export function evaluateTimelineAudioMix(
  track: TimelineTrack,
  clip: TimelineClip,
  timelineTime: number,
) {
  const localTime = Math.min(clip.placement.duration, Math.max(0, timelineTime - clip.placement.start));
  const clipVolume = evaluateClipKeyframeProperty(clip, 'volume', localTime, clip.placement.volume);
  const trackVolume = evaluateTrackAudioProperty(track, 'volume', timelineTime);
  const clipPan = evaluateClipKeyframeProperty(clip, 'pan', localTime, clip.placement.pan);
  const trackPan = evaluateTrackAudioProperty(track, 'pan', timelineTime);
  const fadeFactor = clipAudioFadeFactor(clip, localTime);
  return {
    clipVolume,
    trackVolume,
    clipPan,
    trackPan,
    fadeFactor,
    outputVolume: clipVolume * trackVolume * fadeFactor,
  };
}
