import { t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { LoaderCircle, Pause, Play } from 'lucide-react';
import { memo, useEffect, useMemo, useRef, useState } from 'react';

import { mediaAssetStreamPath } from '../../data/mediaAssets';
import { useNativeShell } from '../../data/nativeShell';
import { formatMillisecondTimecode } from '../../design/timeline/timeScale';
import type { Project, TimelineClip } from '../../shared/desktop/dto';
import { resolveTimelineMaterial } from './timelineMaterial';

interface PreviewMedia {
  readonly clip: TimelineClip;
  readonly src: string;
}

export interface TimelineProgramMonitorProps {
  readonly project: Project;
  readonly timelineTimeSeconds: number;
  readonly playing: boolean;
  readonly onTogglePlayback: () => void;
  readonly onTimelineTimeChange: (seconds: number) => void;
  readonly onPlaybackEnd: () => void;
}

/**
 * Timeline-owned Program Monitor.
 *
 * The timeline is the only transport. This Module keeps the previous/current/
 * next media elements mounted by Timeline Clip identity, seeks the selected
 * source imperatively, and swaps the presented element only after the target
 * has decoded a frame. Clip changes therefore do not blank the visible monitor.
 */
export function TimelineProgramMonitor({
  project,
  timelineTimeSeconds,
  playing,
  onTogglePlayback,
  onTimelineTimeChange,
  onPlaybackEnd,
}: TimelineProgramMonitorProps) {
  const shell = useNativeShell();
  const story = project.document.tracks.find((track) => track.id === project.document.story_track_id) ?? null;
  const clips = story?.clips ?? [];
  const targetTimelineTime = Math.min(
    project.document.duration_seconds,
    Math.max(0, timelineTimeSeconds),
  );
  const selectedIndex = clips.findIndex((clip) => targetTimelineTime >= clip.placement.start
    && targetTimelineTime < clip.placement.start + clip.placement.duration);
  const selected = selectedIndex < 0 ? null : clips[selectedIndex] ?? null;
  const selectedMaterial = selected === null ? null : resolveTimelineMaterial(selected.material);
  const targetId = selectedMaterial?.streamAssetId === null ? null : selected?.id ?? null;
  const previewOffsetSeconds = selected === null
    ? 0
    : targetTimelineTime - selected.placement.start;
  const [presentedId, setPresentedId] = useState<string | null>(targetId);

  const media = useMemo(() => {
    const result: PreviewMedia[] = [];
    for (const clip of clips) {
      const assetId = resolveTimelineMaterial(clip.material).streamAssetId;
      if (assetId === null) continue;
      const src = shell.mediaSrc(mediaAssetStreamPath(assetId));
      if (src !== null) result.push({ clip, src });
    }
    return result;
  }, [clips, shell]);

  useEffect(() => {
    if (targetId === null) setPresentedId(null);
  }, [targetId]);

  return (
    <section className="flex min-h-0 min-w-0 flex-col overflow-hidden border-r border-divider bg-bg" aria-label={t`视频预览`}>
      <header className="flex h-[var(--h-ctl-md)] flex-none items-center border-b border-divider bg-bg px-4 text-xs font-semibold text-text">
        <Trans>视频预览</Trans>
      </header>
      {targetId === null ? (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center bg-neutral-900 p-5 text-center text-neutral-100">
          <h2 className="font-heading text-2xl">{selected?.name ?? project.name}</h2>
          <p className="mt-2 text-sm text-neutral-400">
            {selected === null ? <Trans>从时间轴选择一个片段</Trans> : materialLabel(selected)}
          </p>
        </div>
      ) : (
        <div className="relative min-h-0 flex-1 overflow-hidden bg-neutral-900">
          {media.map(({ clip, src }) => {
            const isTarget = clip.id === targetId;
            const isPresented = clip.id === presentedId;
            const offset = isTarget ? previewOffsetSeconds : 0;
            return (
              <PooledPreviewVideo
                key={clip.id}
                clip={clip}
                src={src}
                fps={project.document.fps}
                offsetSeconds={offset}
                target={isTarget}
                presented={isPresented}
                playing={playing && isTarget && isPresented}
                onTimelineTimeChange={(sourceSeconds) => {
                  const timelineSeconds = clip.placement.start
                    + (sourceSeconds - clip.placement.source_in) / clip.placement.speed;
                  onTimelineTimeChange(Math.min(
                    clip.placement.start + clip.placement.duration,
                    Math.max(clip.placement.start, timelineSeconds),
                  ));
                }}
                onEnded={() => {
                  const end = clip.placement.start + clip.placement.duration;
                  onTimelineTimeChange(end);
                  if (end >= project.document.duration_seconds - 1 / project.document.fps) onPlaybackEnd();
                }}
                onReady={() => {
                  if (clip.id === targetId) setPresentedId(clip.id);
                }}
              />
            );
          })}
          {presentedId === targetId ? null : (
            <span className="pointer-events-none absolute right-3 top-3 flex items-center gap-1.5 rounded-sm bg-neutral-900/75 px-2 py-1 text-2xs text-neutral-100">
              <LoaderCircle className="size-3 animate-spin" aria-hidden="true" />
              <Trans>正在定位帧</Trans>
            </span>
          )}
          <div className="absolute inset-x-0 bottom-0 flex h-[var(--h-panel-head)] items-center gap-3 border-t border-divider bg-bg/95 px-3 text-xs text-text backdrop-blur-sm">
            <button
              type="button"
              className="grid size-[var(--h-ctl-sm)] flex-none place-items-center rounded-sm text-accent-text hover:bg-neutral-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-400"
              aria-label={playing ? t`暂停时间轴` : t`播放时间轴`}
              onClick={onTogglePlayback}
            >
              {playing ? <Pause className="size-4" aria-hidden="true" /> : <Play className="size-4" aria-hidden="true" />}
            </button>
            <span className="min-w-0 truncate font-medium">{selected?.name}</span>
            <span className="ml-auto font-mono">{formatMillisecondTimecode(targetTimelineTime)}</span>
          </div>
        </div>
      )}
    </section>
  );
}

const PooledPreviewVideo = memo(function PooledPreviewVideo({
  clip,
  src,
  fps,
  offsetSeconds,
  target,
  presented,
  playing,
  onTimelineTimeChange,
  onEnded,
  onReady,
}: {
  readonly clip: TimelineClip;
  readonly src: string;
  readonly fps: number;
  readonly offsetSeconds: number;
  readonly target: boolean;
  readonly presented: boolean;
  readonly playing: boolean;
  readonly onTimelineTimeChange: (sourceSeconds: number) => void;
  readonly onEnded: () => void;
  readonly onReady: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const desiredTimeRef = useRef(sourceTime(clip, offsetSeconds));
  desiredTimeRef.current = sourceTime(clip, offsetSeconds);

  const seekLatest = () => {
    const video = videoRef.current;
    if (video === null || video.seeking) return;
    const targetTime = desiredTimeRef.current;
    if (Math.abs(video.currentTime - targetTime) <= 0.5 / Math.max(1, fps)) return;
    try {
      video.currentTime = targetTime;
    } catch {
      // Metadata has not arrived yet. loadedmetadata/loadeddata retries below.
    }
  };

  useEffect(() => {
    seekLatest();
  }, [clip, fps, offsetSeconds]);

  useEffect(() => {
    const video = videoRef.current;
    if (video !== null && target && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) onReady();
  }, [onReady, target]);

  useEffect(() => {
    const video = videoRef.current;
    if (video === null) return;
    video.playbackRate = clip.placement.speed;
    if (!playing) {
      if (!video.paused) video.pause();
      return;
    }
    void video.play().catch(() => {
      // The next explicit transport action can retry if WebView2 rejected play.
    });
    return () => {
      if (!video.paused) video.pause();
    };
  }, [clip.placement.speed, playing]);

  return (
    <video
      ref={videoRef}
      className="absolute inset-0 size-full bg-neutral-900 object-cover transition-opacity duration-75"
      src={src}
      preload={target || presented ? 'auto' : 'metadata'}
      playsInline
      muted={!presented}
      controls={false}
      data-preview-target={target}
      data-preview-active={presented}
      aria-label={target ? t`${clip.name} 视频预览` : undefined}
      aria-hidden={!target}
      style={{
        opacity: presented ? 1 : 0,
        visibility: presented ? 'visible' : 'hidden',
        pointerEvents: 'none',
      }}
      onLoadedMetadata={seekLatest}
      onLoadedData={() => {
        seekLatest();
        if (target) onReady();
      }}
      onCanPlay={() => {
        seekLatest();
        if (target) onReady();
      }}
      onSeeked={seekLatest}
      onTimeUpdate={(event) => {
        if (target && presented) onTimelineTimeChange(event.currentTarget.currentTime);
      }}
      onEnded={onEnded}
    />
  );
}, (previous, next) => previous.clip === next.clip
  && previous.src === next.src
  && previous.fps === next.fps
  && previous.offsetSeconds === next.offsetSeconds
  && previous.target === next.target
  && previous.presented === next.presented
  && previous.playing === next.playing);

function sourceTime(clip: TimelineClip, offsetSeconds: number): number {
  const placement = clip.placement;
  const requested = placement.source_in + Math.max(0, offsetSeconds) * placement.speed;
  return Math.min(placement.source_out, Math.max(placement.source_in, requested));
}

function materialLabel(clip: TimelineClip) {
  return resolveTimelineMaterial(clip.material).state === 'planned' ? <Trans>未录制</Trans> : <Trans>已录制</Trans>;
}
