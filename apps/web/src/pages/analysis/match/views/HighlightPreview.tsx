/**
 * The 2D replay of one highlight, looping inside the 高光 Inspector.
 *
 * Picking clips means deciding "is this worth it?" many times in a row, and a
 * description alone does not answer that. The preview plays the highlight's
 * own tick range plus the capture pre/post roll the recording will keep, on
 * the same replay slice, markers and paths the 回放 view draws — so what it
 * shows is what a recording of this pick would cover. Play state is owned by
 * the caller so the list's Space shortcut and the button here are one control.
 */

import { t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { Pause, Play } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

import { useMatchAnalysis, useMatchReplay, useMapRadarOverview } from '../../../../data/match';
import { dataErrorMessage } from '../../../../data/errors';
import { useNativeShell } from '../../../../data/nativeShell';
import { ProgressBar } from '../../../../design/feedback';
import { Button } from '../../../../design/primitives';
import { DEFAULT_HEAT_GRID_SIZE, DEFAULT_HEAT_STEPS, type HeatDistribution } from '../../../../domain/map';
import { ReplayCanvas } from '../../../../domain/map/ReplayCanvas';
import {
  buildPlayerTracks,
  clampTick,
  frameIndexAtTick,
  interpolateReplayFrame,
  projectileTrails,
  playerMarkers,
  roundBounds,
  sliceReplay,
} from '../../../../domain/map/replayModel';
import type { HighlightCandidate } from '../../../../domain/match';
import { CAPTURE_POST_ROLL_SECONDS, CAPTURE_PRE_ROLL_SECONDS } from '../../../../domain/project/collectedClip';
import { usePlaybackClock } from './usePlaybackClock';

const NO_HEAT: HeatDistribution = {
  bins: [],
  gridSize: DEFAULT_HEAT_GRID_SIZE,
  steps: DEFAULT_HEAT_STEPS,
  sampleCount: 0,
  skippedCount: 0,
  minWeight: 0,
  maxWeight: 0,
};

const PREVIEW_LAYERS = { players: true, paths: true, kills: false, heat: false, utilities: true } as const;

export function HighlightPreview({
  demoId,
  highlight,
  playing,
  onPlayingChange,
}: {
  readonly demoId: string;
  readonly highlight: HighlightCandidate;
  readonly playing: boolean;
  readonly onPlayingChange: (playing: boolean) => void;
}) {
  const id = demoId === '' ? null : demoId;
  const analysis = useMatchAnalysis(id);
  const replay = useMatchReplay(id, { enabled: true });
  const mapName = analysis.data?.map_name ?? null;
  const radar = useMapRadarOverview(mapName);
  const shell = useNativeShell();
  const radarSrc = radar.data?.browser_displayable === true && radar.data.image_url !== null
    ? shell.mediaSrc(radar.data.image_url)
    : null;

  const tickRate = analysis.data?.tick_rate ?? highlight.tickRate ?? 64;
  const round = useMemo(() => roundBounds(analysis.data, highlight.round), [analysis.data, highlight.round]);
  const bounds = useMemo(() => ({
    startTick: Math.max(round?.startTick ?? 0, Math.round(highlight.startTick - CAPTURE_PRE_ROLL_SECONDS * tickRate)),
    endTick: Math.min(round?.endTick ?? Number.MAX_SAFE_INTEGER, Math.round(highlight.endTick + CAPTURE_POST_ROLL_SECONDS * tickRate)),
  }), [round, highlight.startTick, highlight.endTick, tickRate]);
  const slice = useMemo(() => sliceReplay(replay.data, bounds), [replay.data, bounds]);

  const [tick, setTick] = useState<number | null>(null);
  useEffect(() => setTick(null), [highlight.id]);

  const current = slice === null ? null : clampTick(tick ?? slice.startTick, slice);
  const frameIndex = slice === null || current === null ? -1 : frameIndexAtTick(slice.frames, current);
  const presentation = useMemo(() => slice === null || current === null ? null : interpolateReplayFrame(slice.frames, current, slice.tickRate), [slice, current]);
  const markers = useMemo(() => playerMarkers(presentation), [presentation]);
  const utilityTrails = useMemo(() => slice === null || frameIndex < 0 ? [] : projectileTrails(slice.frames, slice.frames[frameIndex]!.tick, slice.tickRate), [slice, frameIndex]);
  /* Only the highlight's own player leaves a trail: ten overlapping routes in
     a 300 px box hide the one movement the pick is about. */
  const paths = useMemo(() => {
    if (slice === null) return [];
    const all = buildPlayerTracks(slice.frames, frameIndex).paths;
    return highlight.playerId === undefined ? all : all.filter((path) => path.playerId === highlight.playerId);
  }, [slice, frameIndex, highlight.playerId]);

  usePlaybackClock({
    playing: playing && slice !== null,
    onAdvance: (elapsedSeconds) => {
      if (slice === null || current === null) return;
      const next = current + elapsedSeconds * slice.tickRate;
      // A preview loops: the decision is made while it plays, not after.
      setTick(next >= slice.endTick ? slice.startTick : next);
    },
  });

  const replayError = dataErrorMessage(replay.error);
  const status = replay.isPending || analysis.isPending ? 'loading' : slice === null ? 'empty' : 'ready';
  const total = slice === null ? 0 : (slice.endTick - slice.startTick) / slice.tickRate;
  const elapsed = slice === null || current === null ? 0 : (current - slice.startTick) / slice.tickRate;

  return (
    <section data-highlight-preview={highlight.id} aria-label={t`高光预览`} className="flex flex-col gap-2">
      {/* The map keeps a square frame, so its width sets the preview's height;
          the transport stays below it. */}
      <div className="mx-auto w-72 max-w-full flex-none">
      <ReplayCanvas
        className="size-full"
        mapName={mapName ?? ''}
        overviewTransform={radar.data?.transform}
        basemap={radarSrc === null ? undefined : (
          <img src={radarSrc} alt="" className="size-full object-fill opacity-35" />
        )}
        label={t`第 ${highlight.round} 回合高光的 2D 回放`}
        status={status}
        layers={PREVIEW_LAYERS}
        markers={markers}
        projectiles={presentation?.projectiles ?? []}
        projectileTrails={utilityTrails}
        paths={paths}
        engagements={[]}
        distribution={NO_HEAT}
        selectedPlayerId={highlight.playerId ?? null}
        onSelectPlayer={() => undefined}
        selectedEngagementId={null}
        onSelectEngagement={() => undefined}
        emptyDescription={<Trans>这段没有可用的回放帧。</Trans>}
        {...(replayError === null
          ? {}
          : { error: { message: <Trans>读不到回放：{replayError}</Trans>, onRetry: () => void replay.refetch() } })}
      />
      </div>
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          variant="ghost"
          aria-label={playing ? t`暂停预览（空格）` : t`播放预览（空格）`}
          disabled={slice === null}
          onClick={() => onPlayingChange(!playing)}
        >
          {playing ? <Pause className="size-4" aria-hidden="true" /> : <Play className="size-4" aria-hidden="true" />}
        </Button>
        <ProgressBar
          size="sm"
          className="flex-1"
          value={elapsed}
          max={total}
          label={t`预览进度`}
        />
        <span className="flex-none font-mono text-xs text-neutral-700">
          {formatClock(elapsed)} / {formatClock(total)}
        </span>
      </div>
    </section>
  );
}

function formatClock(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  return `${String(Math.floor(whole / 60))}:${String(whole % 60).padStart(2, '0')}`;
}
