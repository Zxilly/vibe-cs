import { useEffect, useMemo, useRef } from 'react';

import { mediaAssetStreamPath } from '../../data/mediaAssets';
import { useNativeShell } from '../../data/nativeShell';
import type { Project, TimelineClip, TimelineTrack } from '../../shared/desktop/dto';
import { evaluateClipKeyframeProperty } from './keyframeEditing';
import { clipFadeDuration, MAX_TIMELINE_CLIP_SPEED, MIN_TIMELINE_CLIP_SPEED } from './timelineInteraction';
import { resolveTimelineMaterial } from './timelineMaterial';

const MAX_POOLED_AUDIO_CLIPS = 32;

export interface TimelineAudioMonitorProps {
  readonly project: Project;
  readonly timelineTimeSeconds: number;
  readonly playing: boolean;
  readonly playbackRate: number;
}

interface AudioPoolCandidate {
  readonly track: TimelineTrack;
  readonly clip: TimelineClip;
  readonly active: boolean;
}

/**
 * Downstream audio renderer for the shared Timeline Transport.
 *
 * Audio elements never publish transport time. The Program video or the
 * Timeline fallback clock remains authoritative; this bounded pool only seeks,
 * plays, pauses, mutes and evaluates gain against that clock.
 */
export function TimelineAudioMonitor({
  project,
  timelineTimeSeconds,
  playing,
  playbackRate,
}: TimelineAudioMonitorProps) {
  const shell = useNativeShell();
  const timelineTime = Math.min(project.document.duration_seconds, Math.max(0, timelineTimeSeconds));
  const candidates = useMemo(
    () => timelineAudioPool(project, timelineTime),
    [project, timelineTime],
  );
  const media = candidates.flatMap((candidate) => {
    const assetId = resolveTimelineMaterial(candidate.clip.material).streamAssetId;
    if (assetId === null) return [];
    const src = shell.mediaSrc(mediaAssetStreamPath(assetId));
    return src === null ? [] : [{ ...candidate, src }];
  });

  return (
    <div className="hidden" aria-hidden="true" data-audio-pool-size={media.length}>
      {media.map(({ track, clip, active, src }) => (
        <PooledTimelineAudio
          key={`${track.id}:${clip.id}`}
          track={track}
          clip={clip}
          src={src}
          timelineTimeSeconds={timelineTime}
          active={active}
          playing={playing}
          transportRate={playbackRate}
          fps={project.document.fps}
        />
      ))}
    </div>
  );
}

export function timelineAudioPool(project: Project, timelineTimeSeconds: number): AudioPoolCandidate[] {
  const active: AudioPoolCandidate[] = [];
  const warm: AudioPoolCandidate[] = [];
  const seen = new Set<string>();
  const add = (target: AudioPoolCandidate[], track: TimelineTrack, clip: TimelineClip, isActive: boolean) => {
    const key = `${track.id}:${clip.id}`;
    if (seen.has(key)) return;
    seen.add(key);
    target.push({ track, clip, active: isActive });
  };

  for (const track of project.document.tracks.filter((candidate) => candidate.kind === 'audio')) {
    const clips = [...track.clips]
      .filter((clip) => clip.placement.enabled && resolveTimelineMaterial(clip.material).streamAssetId !== null)
      .sort((left, right) => left.placement.start - right.placement.start);
    const activeClips = clips.filter((clip) => isClipActive(clip, timelineTimeSeconds));
    for (const clip of activeClips) add(active, track, clip, true);
    const previous = [...clips].reverse().find((clip) => (
      clip.placement.start + clip.placement.duration <= timelineTimeSeconds
    ));
    const next = clips.find((clip) => clip.placement.start > timelineTimeSeconds);
    if (previous !== undefined) add(warm, track, previous, false);
    if (next !== undefined) add(warm, track, next, false);
  }
  return [...active, ...warm].slice(0, MAX_POOLED_AUDIO_CLIPS);
}

function PooledTimelineAudio({
  track,
  clip,
  src,
  timelineTimeSeconds,
  active,
  playing,
  transportRate,
  fps,
}: {
  readonly track: TimelineTrack;
  readonly clip: TimelineClip;
  readonly src: string;
  readonly timelineTimeSeconds: number;
  readonly active: boolean;
  readonly playing: boolean;
  readonly transportRate: number;
  readonly fps: number;
}) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const localTime = Math.min(
    clip.placement.duration,
    Math.max(0, timelineTimeSeconds - clip.placement.start),
  );
  const desiredSourceTime = clip.placement.source_in + localTime * clip.placement.speed;
  const desiredTimeRef = useRef(desiredSourceTime);
  desiredTimeRef.current = desiredSourceTime;
  const output = evaluateTimelineAudio(clip, localTime);

  const seekLatest = () => {
    const audio = audioRef.current;
    if (audio === null || audio.seeking) return;
    const tolerance = playing ? 0.2 : 0.5 / Math.max(1, fps);
    if (Math.abs(audio.currentTime - desiredTimeRef.current) <= tolerance) return;
    try {
      audio.currentTime = desiredTimeRef.current;
    } catch {
      // Metadata has not arrived. loadedmetadata/loadeddata retries below.
    }
  };

  useEffect(seekLatest, [active, clip, desiredSourceTime, fps, playing]);

  useEffect(() => {
    const audio = audioRef.current;
    if (audio === null) return;
    audio.playbackRate = Math.min(
      MAX_TIMELINE_CLIP_SPEED,
      Math.max(MIN_TIMELINE_CLIP_SPEED, clip.placement.speed * Math.max(1, transportRate)),
    );
    audio.muted = !active || track.muted;
    if (!active || !playing || transportRate <= 0) {
      if (!audio.paused) audio.pause();
      return;
    }
    void audio.play().catch(() => {
      // A later explicit transport action can retry a WebView2 media refusal.
    });
    return () => {
      if (!audio.paused) audio.pause();
    };
  }, [active, clip.placement.speed, playing, track.muted, transportRate]);

  useEffect(() => {
    const audio = audioRef.current;
    if (audio === null) return;
    audio.volume = Math.min(1, Math.max(0, output.outputVolume));
  }, [output.outputVolume]);

  return (
    <audio
      ref={audioRef}
      src={src}
      preload={active ? 'auto' : 'metadata'}
      muted={!active || track.muted}
      controls={false}
      data-timeline-audio-clip-id={clip.id}
      data-timeline-audio-track-id={track.id}
      data-timeline-audio-active={active}
      data-timeline-audio-muted={!active || track.muted}
      data-timeline-audio-source-time={desiredSourceTime}
      data-timeline-audio-canonical-volume={output.canonicalVolume}
      data-timeline-audio-fade-factor={output.fadeFactor}
      data-timeline-audio-output-volume={output.outputVolume}
      onLoadedMetadata={seekLatest}
      onLoadedData={seekLatest}
      onSeeked={seekLatest}
    />
  );
}

function isClipActive(clip: TimelineClip, timelineTimeSeconds: number): boolean {
  const epsilon = 1e-6;
  return timelineTimeSeconds + epsilon >= clip.placement.start
    && timelineTimeSeconds < clip.placement.start + clip.placement.duration - epsilon;
}

export function evaluateTimelineAudio(clip: TimelineClip, localTime: number) {
  const canonicalVolume = evaluateClipKeyframeProperty(clip, 'volume', localTime, clip.placement.volume);
  const fadeIn = clipFadeDuration(clip, 'in');
  const fadeOut = clipFadeDuration(clip, 'out');
  const fadeInFactor = fadeIn > 0 ? Math.min(1, Math.max(0, localTime / fadeIn)) : 1;
  const remaining = clip.placement.duration - localTime;
  const fadeOutFactor = fadeOut > 0 ? Math.min(1, Math.max(0, remaining / fadeOut)) : 1;
  const fadeFactor = Math.min(fadeInFactor, fadeOutFactor);
  return { canonicalVolume, fadeFactor, outputVolume: canonicalVolume * fadeFactor };
}
