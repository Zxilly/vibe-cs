import { useCallback, useEffect, useRef, type RefObject } from 'react';

/** Native video readiness follows the newest request, including requests made during a seek. */
export function usePreviewVideoSeek({
  videoRef,
  sourceTime,
  fps,
  seekEnabled,
  readinessKey,
  onReady,
}: {
  readonly videoRef: RefObject<HTMLVideoElement | null>;
  readonly sourceTime: number;
  readonly fps: number;
  readonly seekEnabled: boolean;
  readonly readinessKey?: string;
  readonly onReady?: (() => void) | undefined;
}): void {
  const latest = useRef({ sourceTime, fps, seekEnabled, onReady });
  latest.current = { sourceTime, fps, seekEnabled, onReady };
  const synchronize = useCallback(() => {
    const video = videoRef.current;
    if (video === null || video.seeking) return;
    const target = latest.current;
    const tolerance = 0.5 / Math.max(1, target.fps);
    if (target.seekEnabled && Math.abs(video.currentTime - target.sourceTime) > tolerance) {
      try {
        video.currentTime = target.sourceTime;
      } catch {
        // Metadata and seek-completion events retry the current request.
        return;
      }
    }
    if (!video.seeking
      && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA
      && Math.abs(video.currentTime - target.sourceTime) <= tolerance) target.onReady?.();
  }, [videoRef]);

  useEffect(() => {
    const video = videoRef.current;
    if (video === null) return;
    const events = ['loadedmetadata', 'loadeddata', 'canplay', 'seeked'] as const;
    for (const event of events) video.addEventListener(event, synchronize);
    return () => {
      for (const event of events) video.removeEventListener(event, synchronize);
    };
  }, [synchronize, videoRef]);

  const reportReadiness = onReady !== undefined;
  useEffect(synchronize, [synchronize, sourceTime, fps, seekEnabled, readinessKey, reportReadiness]);
}
