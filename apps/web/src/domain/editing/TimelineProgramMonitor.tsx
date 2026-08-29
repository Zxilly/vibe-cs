import { t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight, LoaderCircle, Pause, Play } from 'lucide-react';
import { memo, useEffect, useMemo, useRef, useState } from 'react';

import { mediaAssetStreamPath } from '../../data/mediaAssets';
import { useNativeShell } from '../../data/nativeShell';
import { formatMillisecondTimecode } from '../../design/timeline/timeScale';
import type { Project, TimelineClip } from '../../shared/desktop/dto';
import { evaluateClipKeyframeProperty, setClipTransformAtTime } from './keyframeEditing';
import { clipFadeDuration } from './timelineInteraction';
import { EDITOR_EFFECT_SCHEMAS, editorEffectParameter, isSupportedEditorEffectKind } from './effectEditing';
import { resolveTimelineMaterial } from './timelineMaterial';

interface PreviewMedia {
  readonly clip: TimelineClip;
  readonly src: string;
}

export interface TimelineProgramMonitorProps {
  readonly project: Project;
  readonly timelineTimeSeconds: number;
  readonly selectedClipId: string | null;
  readonly readOnly: boolean;
  readonly playing: boolean;
  readonly playbackRate: number;
  readonly onTogglePlayback: () => void;
  readonly onShuttle: (direction: -1 | 0 | 1) => void;
  readonly onStepFrame: (direction: -1 | 1) => void;
  readonly onTimelineTimeChange: (seconds: number) => void;
  readonly onPlaybackEnd: () => void;
  readonly onReplaceClip: (clip: TimelineClip) => void;
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
  selectedClipId,
  readOnly,
  playing,
  playbackRate,
  onTogglePlayback,
  onShuttle,
  onStepFrame,
  onTimelineTimeChange,
  onPlaybackEnd,
  onReplaceClip,
}: TimelineProgramMonitorProps) {
  const shell = useNativeShell();
  const story = project.document.tracks.find((track) => track.id === project.document.story_track_id) ?? null;
  const clips = story?.clips ?? [];
  const targetTimelineTime = Math.min(
    project.document.duration_seconds,
    Math.max(0, timelineTimeSeconds),
  );
  const selectedIndex = targetTimelineTime >= project.document.duration_seconds - 0.5 / project.document.fps
    ? clips.length - 1
    : clips.findIndex((clip) => targetTimelineTime >= clip.placement.start
      && targetTimelineTime < clip.placement.start + clip.placement.duration);
  const selected = selectedIndex < 0 ? null : clips[selectedIndex] ?? null;
  const selectedMaterial = selected === null ? null : resolveTimelineMaterial(selected.material);
  const targetId = selectedMaterial?.streamAssetId === null ? null : selected?.id ?? null;
  const previewOffsetSeconds = selected === null
    ? 0
    : targetTimelineTime - selected.placement.start;
  const [presentedId, setPresentedId] = useState<string | null>(targetId);
  const timelineTimeRef = useRef(targetTimelineTime);
  const onTimelineTimeChangeRef = useRef(onTimelineTimeChange);
  const onPlaybackEndRef = useRef(onPlaybackEnd);
  timelineTimeRef.current = targetTimelineTime;
  onTimelineTimeChangeRef.current = onTimelineTimeChange;
  onPlaybackEndRef.current = onPlaybackEnd;

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

  useEffect(() => {
    if (!playing || playbackRate >= 0) return undefined;
    let frame = 0;
    let previous = performance.now();
    const tick = (now: number) => {
      const elapsed = Math.max(0, now - previous) / 1_000;
      previous = now;
      const next = Math.max(0, timelineTimeRef.current + elapsed * playbackRate);
      timelineTimeRef.current = next;
      onTimelineTimeChangeRef.current(next);
      if (next <= 0) {
        onPlaybackEndRef.current();
        return;
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playbackRate, playing]);

  return (
    <section
      className="flex min-h-0 min-w-0 flex-col overflow-hidden border-r border-divider bg-bg"
      aria-label={t`视频预览`}
      data-monitor-selected-clip-id={selectedClipId ?? ''}
      data-monitor-target-clip-id={targetId ?? ''}
      data-monitor-read-only={readOnly}
      data-monitor-playing={playing}
    >
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
        <div className="flex min-h-0 flex-1 flex-col bg-neutral-900">
          <div className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden" style={{ containerType: 'size' }}>
            <div
              className="relative max-h-full max-w-full overflow-hidden bg-neutral-900"
              style={{
                aspectRatio: `${project.document.width} / ${project.document.height}`,
                width: `min(100cqw, ${project.document.width / project.document.height * 100}cqh)`,
                height: `min(100cqh, ${project.document.height / project.document.width * 100}cqw)`,
              }}
              aria-label={t`节目画布`}
            >
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
                    projectWidth={project.document.width}
                    projectHeight={project.document.height}
                    offsetSeconds={offset}
                    target={isTarget}
                    presented={isPresented}
                    playing={playing && isTarget && isPresented}
                    editable={!playing && !readOnly && isTarget && isPresented && selectedClipId === clip.id}
                    transportRate={playbackRate}
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
                    onReplaceClip={onReplaceClip}
                  />
                );
              })}
            </div>
            {presentedId === targetId ? null : (
              <span className="pointer-events-none absolute right-3 top-3 flex items-center gap-1.5 rounded-sm bg-neutral-900/75 px-2 py-1 text-2xs text-neutral-100">
                <LoaderCircle className="size-3 animate-spin" aria-hidden="true" />
                <Trans>正在定位帧</Trans>
              </span>
            )}
          </div>
          <div className="flex h-[var(--h-panel-head)] flex-none items-center gap-3 border-t border-divider bg-bg px-3 text-xs text-text">
            <button
              type="button"
              className="grid size-[var(--h-ctl-sm)] flex-none place-items-center rounded-sm text-accent-text hover:bg-neutral-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-400"
              aria-label={t`上一帧`}
              onClick={() => onStepFrame(-1)}
            >
              <ChevronLeft className="size-4" aria-hidden="true" />
            </button>
            <button type="button" className="grid size-[var(--h-ctl-sm)] place-items-center rounded-sm text-accent-text hover:bg-neutral-100" aria-label={t`J 反向播放`} onClick={() => onShuttle(-1)}><ChevronsLeft className="size-4" aria-hidden="true" /></button>
            <button
              type="button"
              className="grid size-[var(--h-ctl-sm)] flex-none place-items-center rounded-sm text-accent-text hover:bg-neutral-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-400"
              aria-label={playing ? t`K 暂停时间轴` : t`播放时间轴`}
              onClick={playing ? () => onShuttle(0) : onTogglePlayback}
            >
              {playing ? <Pause className="size-4" aria-hidden="true" /> : <Play className="size-4" aria-hidden="true" />}
            </button>
            <button type="button" className="grid size-[var(--h-ctl-sm)] place-items-center rounded-sm text-accent-text hover:bg-neutral-100" aria-label={t`L 正向播放`} onClick={() => onShuttle(1)}><ChevronsRight className="size-4" aria-hidden="true" /></button>
            <button type="button" className="grid size-[var(--h-ctl-sm)] place-items-center rounded-sm text-accent-text hover:bg-neutral-100" aria-label={t`下一帧`} onClick={() => onStepFrame(1)}><ChevronRight className="size-4" aria-hidden="true" /></button>
            <span className="min-w-0 truncate font-medium">{selected?.name}</span>
            <span className="font-mono text-neutral-500">{playing ? `${playbackRate.toFixed(1)}x` : '0.0x'}</span>
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
  projectWidth,
  projectHeight,
  offsetSeconds,
  target,
  presented,
  playing,
  editable,
  transportRate,
  onTimelineTimeChange,
  onEnded,
  onReady,
  onReplaceClip,
}: {
  readonly clip: TimelineClip;
  readonly src: string;
  readonly fps: number;
  readonly projectWidth: number;
  readonly projectHeight: number;
  readonly offsetSeconds: number;
  readonly target: boolean;
  readonly presented: boolean;
  readonly playing: boolean;
  readonly editable: boolean;
  readonly transportRate: number;
  readonly onTimelineTimeChange: (sourceSeconds: number) => void;
  readonly onEnded: () => void;
  readonly onReady: () => void;
  readonly onReplaceClip: (clip: TimelineClip) => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const desiredTimeRef = useRef(sourceTime(clip, offsetSeconds));
  desiredTimeRef.current = sourceTime(clip, offsetSeconds);
  const evaluatedTransform = evaluatePreviewTransform(clip, offsetSeconds);
  const [draftTransform, setDraftTransform] = useState<typeof evaluatedTransform | null>(null);
  const draftTransformRef = useRef(draftTransform);
  draftTransformRef.current = draftTransform;
  const moveGesture = useRef<{
    readonly pointerId: number;
    readonly clientX: number;
    readonly clientY: number;
    readonly transform: typeof evaluatedTransform;
    readonly stageWidth: number;
    readonly stageHeight: number;
  } | null>(null);
  const scaleGesture = useRef<{
    readonly pointerId: number;
    readonly transform: typeof evaluatedTransform;
    readonly centerX: number;
    readonly centerY: number;
    readonly distance: number;
  } | null>(null);
  const rotationGesture = useRef<{
    readonly pointerId: number;
    readonly transform: typeof evaluatedTransform;
    readonly centerX: number;
    readonly centerY: number;
    readonly angle: number;
  } | null>(null);
  const windowMouseUpRef = useRef<(() => void) | null>(null);
  const transform = draftTransform ?? evaluatedTransform;
  const audio = evaluatePreviewAudio(clip, offsetSeconds);
  const previewFilter = evaluatePreviewFilter(clip, projectWidth);
  const hasScaleKeyframes = clip.keyframes.some((keyframe) => keyframe.property === 'scale_x' || keyframe.property === 'scale_y');
  const hasRotationKeyframes = clip.keyframes.some((keyframe) => keyframe.property === 'rotation');
  const canScaleDirectly = !hasScaleKeyframes || (Math.abs(clip.transform.rotation) <= 1e-6 && !hasRotationKeyframes);
  const canRotateDirectly = !hasScaleKeyframes;

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
    video.playbackRate = Math.min(16, clip.placement.speed * Math.max(1, transportRate));
    if (!playing || transportRate < 0) {
      if (!video.paused) video.pause();
      return;
    }
    void video.play().catch(() => {
      // The next explicit transport action can retry if WebView2 rejected play.
    });
    return () => {
      if (!video.paused) video.pause();
    };
  }, [clip.placement.speed, playing, transportRate]);

  useEffect(() => {
    const video = videoRef.current;
    if (video !== null) video.volume = Math.min(1, Math.max(0, audio.outputVolume));
  }, [audio.outputVolume]);

  useEffect(() => () => {
    if (windowMouseUpRef.current !== null) window.removeEventListener('mouseup', windowMouseUpRef.current);
  }, []);

  const clearWindowMouseUp = () => {
    if (windowMouseUpRef.current === null) return;
    window.removeEventListener('mouseup', windowMouseUpRef.current);
    windowMouseUpRef.current = null;
  };

  const commitTransformMove = () => {
    const gesture = moveGesture.current;
    const draft = draftTransformRef.current;
    if (gesture === null || draft === null) return;
    moveGesture.current = null;
    clearWindowMouseUp();
    setDraftTransform(null);
    if (Math.abs(draft.x - gesture.transform.x) <= 1e-6 && Math.abs(draft.y - gesture.transform.y) <= 1e-6) return;
    onReplaceClip(setClipTransformAtTime(
      clip,
      offsetSeconds,
      { x: draft.x, y: draft.y },
      fps,
      () => globalThis.crypto.randomUUID(),
    ));
  };

  const commitTransformScale = () => {
    const gesture = scaleGesture.current;
    const draft = draftTransformRef.current;
    if (gesture === null || draft === null) return;
    scaleGesture.current = null;
    clearWindowMouseUp();
    setDraftTransform(null);
    if (Math.abs(draft.scaleX - gesture.transform.scaleX) <= 1e-6
      && Math.abs(draft.scaleY - gesture.transform.scaleY) <= 1e-6) return;
    onReplaceClip(setClipTransformAtTime(
      clip,
      offsetSeconds,
      { scale_x: draft.scaleX, scale_y: draft.scaleY },
      fps,
      () => globalThis.crypto.randomUUID(),
    ));
  };

  const commitTransformRotation = () => {
    const gesture = rotationGesture.current;
    const draft = draftTransformRef.current;
    if (gesture === null || draft === null) return;
    rotationGesture.current = null;
    clearWindowMouseUp();
    setDraftTransform(null);
    if (Math.abs(draft.rotation - gesture.transform.rotation) <= 1e-6) return;
    onReplaceClip(setClipTransformAtTime(
      clip,
      offsetSeconds,
      { rotation: draft.rotation },
      fps,
      () => globalThis.crypto.randomUUID(),
    ));
  };

  return (
    <>
    <video
      ref={videoRef}
      className="absolute inset-0 size-full bg-neutral-900 object-contain transition-opacity duration-75"
      src={src}
      preload={target || presented ? 'auto' : 'metadata'}
      playsInline
      muted={!presented}
      controls={false}
      data-preview-target={target}
      data-preview-active={presented}
      data-preview-editable={editable}
      aria-label={target ? t`${clip.name} 视频预览` : undefined}
      aria-hidden={!target}
      style={{
        opacity: presented ? 1 : 0,
        visibility: presented ? 'visible' : 'hidden',
        pointerEvents: 'none',
        transform: `translate3d(${transform.x / Math.max(1, projectWidth) * 100}%, ${transform.y / Math.max(1, projectHeight) * 100}%, 0) rotate(${transform.rotation}deg) scale(${transform.scaleX}, ${transform.scaleY})`,
        transformOrigin: 'center',
        filter: previewFilter.filter,
        ...(presented ? { opacity: transform.opacity } : {}),
      }}
      data-preview-transform-x={transform.x}
      data-preview-transform-y={transform.y}
      data-preview-scale-x={transform.scaleX}
      data-preview-scale-y={transform.scaleY}
      data-preview-rotation={transform.rotation}
      data-preview-opacity={transform.opacity}
      data-preview-canonical-volume={audio.canonicalVolume}
      data-preview-fade-factor={audio.fadeFactor}
      data-preview-output-volume={audio.outputVolume}
      data-preview-source-time={desiredTimeRef.current}
      data-preview-effects={previewFilter.kinds.join(',')}
      data-preview-filter={previewFilter.filter}
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
    {editable ? (
      <div
        role="button"
        tabIndex={0}
        className="absolute inset-0 z-30 touch-none cursor-move border border-accent-400 bg-transparent outline-none focus-visible:ring-2 focus-visible:ring-accent-500"
        style={{
          transform: `translate3d(${transform.x / Math.max(1, projectWidth) * 100}%, ${transform.y / Math.max(1, projectHeight) * 100}%, 0) rotate(${transform.rotation}deg) scale(${transform.scaleX}, ${transform.scaleY})`,
          transformOrigin: 'center',
        }}
        aria-label={t`在节目画布中移动 ${clip.name}`}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          event.preventDefault();
          event.stopPropagation();
          const stage = event.currentTarget.parentElement?.getBoundingClientRect();
          if (stage === undefined) return;
          event.currentTarget.setPointerCapture?.(event.pointerId);
          moveGesture.current = {
            pointerId: event.pointerId,
            clientX: event.clientX,
            clientY: event.clientY,
            transform,
            stageWidth: Math.max(1, stage.width),
            stageHeight: Math.max(1, stage.height),
          };
          setDraftTransform(transform);
          draftTransformRef.current = transform;
          const finishFromWindow = () => commitTransformMove();
          windowMouseUpRef.current = finishFromWindow;
          window.addEventListener('mouseup', finishFromWindow, { once: true });
        }}
        onPointerMove={(event) => {
          const gesture = moveGesture.current;
          if (gesture === null || gesture.pointerId !== event.pointerId) return;
          event.preventDefault();
          event.stopPropagation();
          const next = {
            ...gesture.transform,
            x: gesture.transform.x + (event.clientX - gesture.clientX) * projectWidth / gesture.stageWidth,
            y: gesture.transform.y + (event.clientY - gesture.clientY) * projectHeight / gesture.stageHeight,
          };
          draftTransformRef.current = next;
          setDraftTransform(next);
        }}
        onPointerUp={(event) => {
          if (moveGesture.current?.pointerId !== event.pointerId) return;
          event.preventDefault();
          event.stopPropagation();
          commitTransformMove();
          event.currentTarget.releasePointerCapture?.(event.pointerId);
        }}
        onPointerCancel={() => {
          moveGesture.current = null;
          clearWindowMouseUp();
          draftTransformRef.current = null;
          setDraftTransform(null);
        }}
        onKeyDown={(event) => {
          if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
          event.preventDefault();
          const step = event.shiftKey ? 10 : 1;
          const x = transform.x + (event.key === 'ArrowRight' ? step : event.key === 'ArrowLeft' ? -step : 0);
          const y = transform.y + (event.key === 'ArrowDown' ? step : event.key === 'ArrowUp' ? -step : 0);
          onReplaceClip(setClipTransformAtTime(
            clip,
            offsetSeconds,
            { x, y },
            fps,
            () => globalThis.crypto.randomUUID(),
          ));
        }}
      >
        {canRotateDirectly ? (
          <span
            role="slider"
            tabIndex={0}
            aria-label={t`旋转节目画面 ${clip.name}`}
            aria-valuemin={-360}
            aria-valuemax={360}
            aria-valuenow={transform.rotation}
            aria-valuetext={`${transform.rotation.toFixed(1)}°`}
            className="absolute left-1/2 top-2 z-40 size-4 -translate-x-1/2 rounded-full border border-accent-600 bg-bg cursor-crosshair outline-none focus-visible:ring-2 focus-visible:ring-accent-500 before:absolute before:left-1/2 before:top-full before:h-4 before:border-l before:border-accent-500"
            onPointerDown={(event) => {
              if (event.button !== 0) return;
              event.preventDefault();
              event.stopPropagation();
              const stage = event.currentTarget.parentElement?.parentElement?.getBoundingClientRect();
              if (stage === undefined) return;
              const centerX = stage.left + stage.width / 2 + transform.x / projectWidth * stage.width;
              const centerY = stage.top + stage.height / 2 + transform.y / projectHeight * stage.height;
              event.currentTarget.setPointerCapture?.(event.pointerId);
              rotationGesture.current = {
                pointerId: event.pointerId,
                transform,
                centerX,
                centerY,
                angle: Math.atan2(event.clientY - centerY, event.clientX - centerX),
              };
              draftTransformRef.current = transform;
              setDraftTransform(transform);
              const finishFromWindow = () => commitTransformRotation();
              windowMouseUpRef.current = finishFromWindow;
              window.addEventListener('mouseup', finishFromWindow, { once: true });
            }}
            onPointerMove={(event) => {
              const gesture = rotationGesture.current;
              if (gesture === null || gesture.pointerId !== event.pointerId) return;
              event.preventDefault();
              event.stopPropagation();
              const angle = Math.atan2(event.clientY - gesture.centerY, event.clientX - gesture.centerX);
              const next = { ...gesture.transform, rotation: gesture.transform.rotation + (angle - gesture.angle) * 180 / Math.PI };
              draftTransformRef.current = next;
              setDraftTransform(next);
            }}
            onPointerUp={(event) => {
              if (rotationGesture.current?.pointerId !== event.pointerId) return;
              event.preventDefault();
              event.stopPropagation();
              commitTransformRotation();
              event.currentTarget.releasePointerCapture?.(event.pointerId);
            }}
            onPointerCancel={() => {
              rotationGesture.current = null;
              clearWindowMouseUp();
              draftTransformRef.current = null;
              setDraftTransform(null);
            }}
            onKeyDown={(event) => {
              if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
              event.preventDefault();
              event.stopPropagation();
              const rotation = transform.rotation + (event.key === 'ArrowRight' ? 1 : -1) * (event.shiftKey ? 15 : 1);
              onReplaceClip(setClipTransformAtTime(clip, offsetSeconds, { rotation }, fps, () => globalThis.crypto.randomUUID()));
            }}
          />
        ) : null}
        {canScaleDirectly ? (
          <span
            role="slider"
            tabIndex={0}
            aria-label={t`缩放节目画面 ${clip.name}`}
            aria-valuemin={0.01}
            aria-valuemax={10}
            aria-valuenow={Math.max(transform.scaleX, transform.scaleY)}
            aria-valuetext={`${Math.max(transform.scaleX, transform.scaleY).toFixed(2)}×`}
            className="absolute bottom-1 right-1 z-40 size-4 rounded-sm border border-accent-600 bg-bg cursor-nwse-resize outline-none focus-visible:ring-2 focus-visible:ring-accent-500"
            onPointerDown={(event) => {
              if (event.button !== 0) return;
              event.preventDefault();
              event.stopPropagation();
              const stage = event.currentTarget.parentElement?.parentElement?.getBoundingClientRect();
              if (stage === undefined) return;
              const centerX = stage.left + stage.width / 2 + transform.x / projectWidth * stage.width;
              const centerY = stage.top + stage.height / 2 + transform.y / projectHeight * stage.height;
              event.currentTarget.setPointerCapture?.(event.pointerId);
              scaleGesture.current = {
                pointerId: event.pointerId,
                transform,
                centerX,
                centerY,
                distance: Math.max(1, Math.hypot(event.clientX - centerX, event.clientY - centerY)),
              };
              draftTransformRef.current = transform;
              setDraftTransform(transform);
              const finishFromWindow = () => commitTransformScale();
              windowMouseUpRef.current = finishFromWindow;
              window.addEventListener('mouseup', finishFromWindow, { once: true });
            }}
            onPointerMove={(event) => {
              const gesture = scaleGesture.current;
              if (gesture === null || gesture.pointerId !== event.pointerId) return;
              event.preventDefault();
              event.stopPropagation();
              const distance = Math.hypot(event.clientX - gesture.centerX, event.clientY - gesture.centerY);
              const factor = distance / gesture.distance;
              const next = {
                ...gesture.transform,
                scaleX: Math.min(10, Math.max(0.01, gesture.transform.scaleX * factor)),
                scaleY: Math.min(10, Math.max(0.01, gesture.transform.scaleY * factor)),
              };
              draftTransformRef.current = next;
              setDraftTransform(next);
            }}
            onPointerUp={(event) => {
              if (scaleGesture.current?.pointerId !== event.pointerId) return;
              event.preventDefault();
              event.stopPropagation();
              commitTransformScale();
              event.currentTarget.releasePointerCapture?.(event.pointerId);
            }}
            onPointerCancel={() => {
              scaleGesture.current = null;
              clearWindowMouseUp();
              draftTransformRef.current = null;
              setDraftTransform(null);
            }}
            onKeyDown={(event) => {
              if (!['ArrowUp', 'ArrowRight', 'ArrowDown', 'ArrowLeft'].includes(event.key)) return;
              event.preventDefault();
              event.stopPropagation();
              const direction = event.key === 'ArrowUp' || event.key === 'ArrowRight' ? 1 : -1;
              const delta = direction * (event.shiftKey ? 0.1 : 0.01);
              onReplaceClip(setClipTransformAtTime(
                clip,
                offsetSeconds,
                { scale_x: Math.min(10, Math.max(0.01, transform.scaleX + delta)), scale_y: Math.min(10, Math.max(0.01, transform.scaleY + delta)) },
                fps,
                () => globalThis.crypto.randomUUID(),
              ));
            }}
          />
        ) : null}
      </div>
    ) : null}
    </>
  );
}, (previous, next) => previous.clip === next.clip
  && previous.src === next.src
  && previous.fps === next.fps
  && previous.projectWidth === next.projectWidth
  && previous.projectHeight === next.projectHeight
  && previous.offsetSeconds === next.offsetSeconds
  && previous.target === next.target
  && previous.presented === next.presented
  && previous.playing === next.playing
  && previous.editable === next.editable
  && previous.transportRate === next.transportRate
  && previous.onReplaceClip === next.onReplaceClip);

function evaluatePreviewTransform(clip: TimelineClip, localTime: number) {
  return {
    x: evaluateClipKeyframeProperty(clip, 'x', localTime, clip.transform.x),
    y: evaluateClipKeyframeProperty(clip, 'y', localTime, clip.transform.y),
    scaleX: evaluateClipKeyframeProperty(clip, 'scale_x', localTime, clip.transform.scale_x),
    scaleY: evaluateClipKeyframeProperty(clip, 'scale_y', localTime, clip.transform.scale_y),
    rotation: evaluateClipKeyframeProperty(clip, 'rotation', localTime, clip.transform.rotation),
    opacity: evaluateClipKeyframeProperty(clip, 'opacity', localTime, clip.transform.opacity),
  };
}

function evaluatePreviewAudio(clip: TimelineClip, localTime: number) {
  const canonicalVolume = evaluateClipKeyframeProperty(clip, 'volume', localTime, clip.placement.volume);
  const fadeIn = clipFadeDuration(clip, 'in');
  const fadeOut = clipFadeDuration(clip, 'out');
  const fadeInFactor = fadeIn > 0 ? Math.min(1, Math.max(0, localTime / fadeIn)) : 1;
  const remaining = clip.placement.duration - localTime;
  const fadeOutFactor = fadeOut > 0 ? Math.min(1, Math.max(0, remaining / fadeOut)) : 1;
  const fadeFactor = Math.min(fadeInFactor, fadeOutFactor);
  return { canonicalVolume, fadeFactor, outputVolume: canonicalVolume * fadeFactor };
}

function evaluatePreviewFilter(clip: TimelineClip, projectWidth: number) {
  const kinds: string[] = [];
  const filters: string[] = [];
  for (const effect of clip.effects) {
    if (!effect.enabled || !isSupportedEditorEffectKind(effect.kind)) continue;
    kinds.push(effect.kind);
    if (effect.kind === 'color_adjust') {
      const [brightnessSchema, contrastSchema, saturationSchema] = EDITOR_EFFECT_SCHEMAS.color_adjust;
      const brightness = editorEffectParameter(effect, brightnessSchema!);
      const contrast = editorEffectParameter(effect, contrastSchema!);
      const saturation = editorEffectParameter(effect, saturationSchema!);
      filters.push(`brightness(${Math.max(0, 1 + brightness)}) contrast(${contrast}) saturate(${saturation})`);
    } else if (effect.kind === 'grayscale') {
      filters.push('grayscale(1)');
    } else {
      const radius = editorEffectParameter(effect, EDITOR_EFFECT_SCHEMAS.blur[0]!);
      filters.push(`blur(${radius / Math.max(1, projectWidth) * 100}cqw)`);
    }
  }
  return { kinds, filter: filters.join(' ') || 'none' };
}

function sourceTime(clip: TimelineClip, offsetSeconds: number): number {
  const placement = clip.placement;
  const requested = placement.source_in + Math.max(0, offsetSeconds) * placement.speed;
  return Math.min(placement.source_out, Math.max(placement.source_in, requested));
}

function materialLabel(clip: TimelineClip) {
  return resolveTimelineMaterial(clip.material).state === 'planned' ? <Trans>未录制</Trans> : <Trans>已录制</Trans>;
}
