import { Trans } from '@lingui/react/macro';
import { t } from '@lingui/core/macro';
import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';

import { dataErrorMessage } from '../../data/errors';
import { useProjectCameraPreview } from '../../data/projects';
import { Button } from '../../design/primitives';
import type { TimelineClip } from '../../shared/desktop/dto';
import { CameraPreviewViewport } from '../scene3d/CameraPreviewViewport';
import { clipSourceTimeAtLocalTime } from './timelineInteraction';
import { evaluatePreviewFilter, evaluatePreviewTransform, evaluatePreviewTransition } from './programVisual';

export interface CameraPreviewEntry {
  readonly key: string;
  readonly clip: TimelineClip;
  readonly revision: number;
}

/** One immutable Head/Clip slot. Time comes only from the existing transport. */
export function PooledCameraPreview({ projectId, entry, target, presented, timelineTimeSeconds, readTimelineTime, onReady, projectWidth, projectHeight }: {
  readonly projectId: string;
  readonly entry: CameraPreviewEntry;
  readonly target: boolean;
  readonly presented: boolean;
  readonly timelineTimeSeconds: number;
  readonly readTimelineTime: () => number;
  readonly onReady: () => void;
  readonly projectWidth: number;
  readonly projectHeight: number;
}) {
  const query = useProjectCameraPreview(projectId, entry.clip.id, entry.revision);
  const frozenTime = useRef(entry.clip.placement.source_in);
  const readyTime = useRef<number | null>(null);
  const lastLocalTime = useRef(0);
  const localTime = target ? timelineTimeSeconds - entry.clip.placement.start : lastLocalTime.current;
  useLayoutEffect(() => { if (target) lastLocalTime.current = localTime; }, [target, localTime]);
  const owner = useRef({ target, readTimelineTime, onReady });
  useLayoutEffect(() => { owner.current = { target, readTimelineTime, onReady }; }, [target, readTimelineTime, onReady]);
  const readSourceTime = useCallback(() => {
    if (owner.current.target) return clipSourceTimeAtLocalTime(entry.clip,
      owner.current.readTimelineTime() - entry.clip.placement.start);
    return frozenTime.current;
  }, [entry.clip]);
  const time = target ? clipSourceTimeAtLocalTime(entry.clip, timelineTimeSeconds - entry.clip.placement.start) : frozenTime.current;
  const preview = query.isError && !(presented && !target) ? undefined : query.data?.preview;
  const transform = evaluatePreviewTransform(entry.clip, localTime);
  const transition = evaluatePreviewTransition(entry.clip, localTime, projectWidth);
  const filter = evaluatePreviewFilter(entry.clip, projectWidth);
  const reportReady = useCallback((seconds: number) => {
    frozenTime.current = seconds;
    readyTime.current = seconds;
    if (!owner.current.target || preview === undefined) return;
    const expected = Math.max(0, Math.min((preview.endTick - preview.startTick) / preview.tickRate, readSourceTime()));
    if (Math.abs(expected - seconds) <= 0.5 / preview.tickRate) owner.current.onReady();
  }, [preview, readSourceTime]);
  // A prefetched slot may already hold exactly the requested frame; it need
  // not issue another GPU draw just because it became the transport target.
  useEffect(() => {
    if (target && readyTime.current !== null) reportReady(readyTime.current);
  }, [target, time, reportReady]);

  return (
    <div className="absolute inset-0" style={{ pointerEvents: target ? 'auto' : 'none', zIndex: target ? 1 : 0 }}
      data-camera-pool-key={entry.key} data-camera-clip-id={entry.clip.id} data-camera-target={target}
      data-camera-presented={presented} aria-hidden={!target && !presented}>
      {preview !== undefined ? (
        <CameraPreviewViewport preview={preview} sourceTimeSeconds={time} readSourceTime={readSourceTime}
          frameStyle={{
            opacity: transform.opacity * transition.opacityFactor,
            transform: `translate3d(${transform.x / Math.max(1, projectWidth) * 100}%, ${transform.y / Math.max(1, projectHeight) * 100}%, 0) rotate(${transform.rotation + transition.rotation}deg) scale(${transform.scaleX * transition.scale}, ${transform.scaleY * transition.scale})`,
            transformOrigin: 'center',
            filter: [filter.filter === 'none' ? '' : filter.filter, transition.filter].filter(Boolean).join(' ') || 'none',
            clipPath: transition.clipPath,
          }}
          onFramePresented={reportReady} showControls={false} presented={presented} active={target} className="h-full" />
      ) : target && (query.isError ? (
        <div role="alert" className="absolute inset-x-3 top-1/2 flex -translate-y-1/2 flex-col items-center gap-3 rounded bg-media/90 p-4 text-center text-sm text-on-media">
          <p>{dataErrorMessage(query.error) ?? t`预演暂时不可用，请重试。`}</p>
          <Button size="sm" variant="secondary" onClick={() => void query.refetch()}><Trans>重试</Trans></Button>
        </div>
      ) : <p role="status" className="absolute inset-0 grid place-items-center text-sm text-on-media"><Trans>正在加载预演…</Trans></p>)}
    </div>
  );
}
