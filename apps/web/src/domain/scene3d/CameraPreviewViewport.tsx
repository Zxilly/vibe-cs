import { t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { useCallback } from 'react';

import { dataErrorMessage } from '../../data/errors';
import { useCameraReplay } from '../../data/match';
import { Button, cn } from '../../design/primitives';
import type { CameraPreview } from '../../shared/desktop/dto';
import { Scene3DView } from './Scene3DView';

/** The caller owns transport. This viewport only projects its source time. */
export function CameraPreviewViewport({ preview, sourceTimeSeconds, readSourceTime, onSourceTimeChange,
  onFramePresented, showControls = true, className, sourceRange,
}: {
  readonly preview: CameraPreview;
  readonly sourceTimeSeconds: number;
  readonly readSourceTime?: () => number;
  readonly onSourceTimeChange?: (seconds: number) => void;
  readonly onFramePresented?: (seconds: number) => void;
  readonly showControls?: boolean;
  readonly className?: string;
  readonly sourceRange?: { readonly start: number; readonly end: number } | undefined;
}) {
  const replay = useCameraReplay(preview.replay);
  const duration = (preview.endTick - preview.startTick) / preview.tickRate;
  const start = Math.min(duration, Math.max(0, sourceRange?.start ?? 0));
  const end = Math.max(start, Math.min(duration, sourceRange?.end ?? duration));
  const time = Math.max(start, Math.min(end, sourceTimeSeconds));
  const readTick = useCallback(() => preview.startTick + Math.max(start, Math.min(end,
    readSourceTime?.() ?? sourceTimeSeconds)) * preview.tickRate, [preview, readSourceTime, sourceTimeSeconds, start, end]);
  const presented = useCallback((tick: number) => onFramePresented?.((tick - preview.startTick) / preview.tickRate), [onFramePresented, preview]);
  return (
    <div className={cn('relative flex min-h-0 flex-col bg-media text-on-media', className)}>
      <span className="pointer-events-none absolute right-3 top-14 z-10 rounded bg-surface-chrome px-2 py-1 text-xs text-text"><Trans>预演</Trans></span>
      {replay.isError ? (
        <div role="alert" className="flex flex-1 flex-col items-center justify-center gap-3 p-4 text-sm">
          <p>{dataErrorMessage(replay.error)}</p>
          <Button size="sm" variant="secondary" onClick={() => void replay.refetch()}><Trans>重试</Trans></Button>
        </div>
      ) : replay.data === undefined ? <p role="status" className="grid flex-1 place-items-center text-sm"><Trans>正在加载预演…</Trans></p> : (
        <Scene3DView mapName={preview.mapName} frames={replay.data.frames} tick={preview.startTick + time * preview.tickRate}
          readTick={readTick} tickRate={preview.tickRate} selectedPlayerId={preview.playerId}
          cameraSamples={preview.plan?.samples ?? null} cameraAspectRatio={preview.aspectRatio}
          cameraDiagnostics={preview.plan?.diagnostics ?? null}
          initialMode="camera" showControls={showControls} onFramePresented={presented} className="min-h-0 flex-1" />
      )}
      {showControls && onSourceTimeChange !== undefined && (
        <label className="flex items-center gap-3 border-t border-media-divider px-3 py-2 text-xs">
          <span className="shrink-0"><Trans>预演位置</Trans></span>
          <input type="range" className="min-w-0 flex-1 accent-accent" aria-label={t`预演位置`} min={start} max={end}
            step={1 / preview.tickRate} value={time} onChange={(event) => onSourceTimeChange(Number(event.currentTarget.value))} />
          <span className="tabular-nums">{time.toFixed(2)} / {end.toFixed(2)} s</span>
        </label>
      )}
    </div>
  );
}
