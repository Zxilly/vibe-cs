/*
 * pages/match/views — 回放与热力图 (`?view=replay`), artboard 「04 2D 回放与热力图」.
 *
 * The one view of the nine that owns a clock. `domain/media/Transport` is
 * controlled and forbidden a `requestAnimationFrame` of its own, so the engine
 * lives here (`usePlaybackClock`), the arithmetic lives in `replayModel.ts`,
 * and the drawing lives in `ReplayCanvas.tsx`.
 *
 * ── The playhead, and why it is not simply the URL ────────────────────────
 *
 * §4.4 makes `tick` part of the address, and it has to stay that way: a link to
 * 「第 21 回合，tick 149 380」 is the whole reason the parameter exists. But a
 * playing replay moves the playhead about fifteen times a second, and writing
 * the address that often would push fifteen entries a second through
 * `setSearchParams` — even with `replace`, that is a router state update and a
 * re-render of the entire workspace per step, and every one of them lands in
 * the session history object.
 *
 * So the playhead is *local while it moves* and *published on a throttle*:
 *
 *   · the effective tick is `local ?? ?tick= ?? the start of the slice`;
 *   · playback writes the address at most once every `TICK_URL_THROTTLE_MS`;
 *   · anything the user did on purpose — a seek, a step, a pause, clicking
 *     「定位」 in the panel — writes immediately, because that is the moment a
 *     copied link is expected to be exact;
 *   · a `?tick=` that this view did not write (a deep link, the Inspector's
 *     「定位」, the Agent's 「定位」) takes over the local playhead. The ref that
 *     remembers what we last wrote is what tells the two apart.
 *
 * Every write is `{ replace: true }`. Scrubbing is not navigation — §4.4's own
 * note on `MatchContextUpdateOptions` says so: 「Pass `{ replace: true }` for a
 * change that should not add a history entry — a playhead scrub, not a click on
 * a round.」
 *
 * ── What the artboard asks for and the backend cannot answer ──────────────
 *
 *   · 投掷物与火 / C4 生命周期 are two of its six layer switches. The frames do
 *     carry projectiles and a bomb record, but `domain/map` has no layer for
 *     either and this phase may not add one. Neither switch is drawn — an inert
 *     checkbox is worse than an absent one.
 *   · 跨比赛 (the third option of its top segment) is a cross-match heat map.
 *     `data/match.ts` is scoped to one demo; the cross-match view already
 *     exists at `/players/:id`.
 *   · the timecode 「01:12.4」 needs the tenths form §10.3 deviation 5 records as
 *     missing from `timeScale.ts`; `Transport`'s 「clock」 gives 01:12.
 *   · 全屏 is not drawn: the canvas is one element of a docked layout and there
 *     is no product decision about what the rest of the shell does behind it.
 */

import { t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import { useMatchAnalysis, useMatchHeatPoints, useMatchReplay, useMapRadarOverview, analysisIsMissing } from '../../../../data/match';
import { dataErrorMessage } from '../../../../data/errors';
import { useNativeShell } from '../../../../data/nativeShell';
import { Empty, Skeleton } from '../../../../design/data';
import { StatusDot } from '../../../../design/feedback';
import { Button, Checkbox, NativeSelect, Seg } from '../../../../design/primitives';
import {
  DEFAULT_HEAT_GRID_SIZE,
  DEFAULT_HEAT_STEPS,
  HeatLegend,
  binWorldSamples,
  describeEngagement,
  resolveMapCalibration,
  type HeatDistribution,
} from '../../../../domain/map';
import { EvidenceRow, formatWeaponName, type EvidenceItem } from '../../../../domain/match';
import { DEFAULT_PLAYBACK_RATES, Transport } from '../../../../domain/media';
import { MatchInspectorPanel } from '../MatchInspectorPanel';
import { NotAnalysedState } from './viewChrome';
import { mapDisplayName } from '../matchModel';
import type { MatchViewModule, MatchViewProps } from '../viewContract';
import { ReplayCanvas, type ReplayLayerVisibility } from '../../../../domain/map/ReplayCanvas';
import { Scene3DView } from '../../../../domain/scene3d/Scene3DView';
import { RouteLink } from '../../../shared/navigation/RouteLink';
import {
  buildEngagements,
  buildPlayerTracks,
  clampTick,
  currentEventId,
  defaultFocusPlayerId,
  frameIndexAtTick,
  interpolateReplayFrame,
  projectileTrails,
  heatFloors,
  heatSamplesOf,
  playerMarkers,
  replayEventRows,
  roundBounds,
  roundEvents,
  sliceReplay,
  type ReplayEventRow,
} from '../../../../domain/map/replayModel';
import { usePlaybackClock } from './usePlaybackClock';
import { highlightSelection, matchHighlights, playerNameIndex } from './highlightModel';
import { formatMillisecondTimecode } from '../../../../design/timeline';

/**
 * One address write a second while playing.
 *
 * The lower bound is what a person notices: a link copied mid-playback is
 * within one second of what they are looking at, which is under the length of
 * the shortest thing anyone clips. The upper bound is the router: each write is
 * a full workspace re-render, and at the 15 Hz step rate anything under ~500 ms
 * would put the address on the critical path of the animation.
 */
export const TICK_URL_THROTTLE_MS = 1_000;

const EMPTY_DISTRIBUTION: HeatDistribution = {
  bins: [],
  gridSize: DEFAULT_HEAT_GRID_SIZE,
  steps: DEFAULT_HEAT_STEPS,
  sampleCount: 0,
  skippedCount: 0,
  minWeight: 0,
  maxWeight: 0,
};

const DEFAULT_LAYERS: ReplayLayerVisibility = {
  // Replay starts with the current action; historical overlays are opt-in.
  players: true,
  paths: false,
  kills: false,
  heat: false,
  utilities: true,
};

/* ── the body ────────────────────────────────────────────────────────────── */

function ReplayBody({ demoId, context, updateContext, addToVideo }: MatchViewProps) {
  const id = demoId === '' ? null : demoId;
  const analysis = useMatchAnalysis(id);
  const replay = useMatchReplay(id, { enabled: true });
  const heat = useMatchHeatPoints(id);
  const mapName = analysis.data?.map_name ?? null;
  const radar = useMapRadarOverview(mapName);
  const shell = useNativeShell();
  const radarSrc = radar.data?.browser_displayable === true && radar.data.image_url !== null
    ? shell.mediaSrc(radar.data.image_url)
    : null;

  const [layers, setLayers] = useState<ReplayLayerVisibility>(DEFAULT_LAYERS);
  const [floor, setFloor] = useState<number | null>(null);
  const [playing, setPlaying] = useState(false);
  const [rate, setRate] = useState(1);
  const [show3D, setShow3D] = useState(false);
  const [showLayers, setShowLayers] = useState(false);
  const [playhead, setPlayhead] = useState<number | null>(null);
  const [clipInTick, setClipInTick] = useState<number | null>(null);
  const [clipOutTick, setClipOutTick] = useState<number | null>(null);

  /* What this view last wrote into `?tick=`. Anything else arriving there came
     from somewhere the local playhead has to yield to. */
  const written = useRef<number | null>(null);
  const wroteAt = useRef(0);

  const bounds = useMemo(() => roundBounds(analysis.data, context.round), [analysis.data, context.round]);
  const slice = useMemo(() => sliceReplay(replay.data, bounds), [replay.data, bounds]);
  const events = useMemo(() => roundEvents(analysis.data, context.round), [analysis.data, context.round]);

  const effectiveTick = slice === null ? null : clampTick(playhead ?? context.tick ?? slice.startTick, slice);
  const liveTick = useRef<number | null>(effectiveTick);
  const readLiveTick = useCallback(() => liveTick.current ?? 0, []);
  // Reset only for a changed data slice or an explicit seek. The 30 Hz React
  // publication must not overwrite a newer animation-frame sample of this clock.
  useLayoutEffect(() => { liveTick.current = effectiveTick; }, [slice]);
  const frameIndex = slice === null || effectiveTick === null ? -1 : frameIndexAtTick(slice.frames, effectiveTick);

  const tracks = useMemo(
    () => (slice === null ? { paths: [], stride: 1, frameCount: 0 } : buildPlayerTracks(slice.frames, frameIndex)),
    [slice, frameIndex],
  );
  const presentation = useMemo(() => slice === null || effectiveTick === null ? null : interpolateReplayFrame(slice.frames, effectiveTick, slice.tickRate), [slice, effectiveTick]);
  const markers = useMemo(() => playerMarkers(presentation), [presentation]);
  const utilityTrails = useMemo(() => slice === null || frameIndex < 0 ? [] : projectileTrails(slice.frames, slice.frames[frameIndex]!.tick, slice.tickRate), [slice, frameIndex]);
  const duels = useMemo(
    () => buildEngagements(events, slice?.frames ?? []),
    [events, slice],
  );
  /* The same default the Inspector resolves — see `defaultFocusPlayerId`. */
  const effectivePlayerId = context.player ?? defaultFocusPlayerId(slice, analysis.data?.players ?? []);
  const focusedEngagements = useMemo(
    () => effectivePlayerId === null
      ? duels.engagements
      : duels.engagements.filter(
          (engagement) =>
            engagement.attacker.playerId === effectivePlayerId
            || engagement.victim.playerId === effectivePlayerId,
        ),
    [duels.engagements, effectivePlayerId],
  );

  const calibration = useMemo(
    () => (mapName === null ? null : resolveMapCalibration(mapName, radar.data?.transform)),
    [mapName, radar.data],
  );
  const samples = useMemo(() => heatSamplesOf(heat.data, context.round), [heat.data, context.round]);
  const distribution = useMemo(() => {
    if (calibration === null) return EMPTY_DISTRIBUTION;
    return binWorldSamples(samples, calibration, floor === null ? {} : { floor });
  }, [calibration, samples, floor]);
  const floors = useMemo(() => heatFloors(heat.data), [heat.data]);

  /* A `?tick=` this view did not write wins over the local playhead — that is
     「定位」 from the panel, a deep link, or the Agent. */
  useEffect(() => {
    if (context.tick !== null && context.tick !== written.current) {
      liveTick.current = slice === null ? context.tick : clampTick(context.tick, slice);
      setPlayhead(context.tick);
    }
  }, [context.tick]);

  /* A different round is a different slice; the playhead from the old one is
     meaningless in it. The shell already dropped `?tick=` (workspaceContext), so
     this only has to drop the local copy. */
  useEffect(() => {
    setPlayhead(null);
    liveTick.current = context.tick ?? slice?.startTick ?? null;
    setPlaying(false);
    setClipInTick(null);
    setClipOutTick(null);
    written.current = null;
  }, [context.round, demoId]);

  const publishTick = (tick: number, immediate: boolean) => {
    const now = Date.now();
    if (!immediate && now - wroteAt.current < TICK_URL_THROTTLE_MS) return;
    wroteAt.current = now;
    written.current = Math.round(tick);
    updateContext({ tick: Math.round(tick) }, { replace: true });
  };

  const seekTo = (tick: number) => {
    if (slice === null) return;
    const next = clampTick(tick, slice);
    liveTick.current = next;
    setPlayhead(next);
    publishTick(next, true);
  };

  usePlaybackClock({
    playing: playing && slice !== null,
    onFrame: (elapsedSeconds) => {
      if (slice !== null && liveTick.current !== null) liveTick.current = clampTick(liveTick.current + elapsedSeconds * rate * slice.tickRate, slice);
    },
    onAdvance: () => {
      if (slice === null || effectiveTick === null) return;
      const next = liveTick.current ?? effectiveTick;
      if (next >= slice.endTick) {
        setPlayhead(slice.endTick);
        setPlaying(false);
        publishTick(slice.endTick, true);
        return;
      }
      setPlayhead(next);
      publishTick(next, false);
    },
  });

  /* ── the three states ──────────────────────────────────────────────────── */

  if (analysisIsMissing(analysis.error)) {
    return (
      <ViewFrame state="empty">
        <NotAnalysedState demoId={demoId} />
      </ViewFrame>
    );
  }

  const replayError = dataErrorMessage(replay.error);
  const status = replay.isPending || analysis.isPending ? 'loading' : slice === null ? 'empty' : 'ready';
  const durationSeconds = slice === null ? 0 : (slice.endTick - slice.startTick) / slice.tickRate;
  const currentSeconds =
    slice === null || effectiveTick === null ? 0 : (effectiveTick - slice.startTick) / slice.tickRate;
  const clipRange = clipInTick === null || clipOutTick === null || clipInTick === clipOutTick
    ? null
    : {
        startTick: Math.min(clipInTick, clipOutTick),
        endTick: Math.max(clipInTick, clipOutTick),
      };
  const clipInSeconds = slice === null || clipInTick === null
    ? undefined
    : (clipInTick - slice.startTick) / slice.tickRate;
  const clipOutSeconds = slice === null || clipOutTick === null
    ? undefined
    : (clipOutTick - slice.startTick) / slice.tickRate;
  const effectivePlayer = analysis.data?.players.find((player) => player.id === effectivePlayerId) ?? null;
  const highlight = matchHighlights(analysis.data).find((entry) => entry.id === context.highlight) ?? null;
  const createClipDisabledReason = addToVideo.disabled
    ? addToVideo.disabledReason
    : effectivePlayerId === null
      ? t`先选择这个镜头跟随的选手`
      : clipRange === null
        ? t`先在回放中设置不同的入点和出点`
        : undefined;
  const selectedDuel = duels.engagements.find((duel) => duel.id === context.evidence) ?? null;

  const label =
    context.round === null
      ? t`${mapDisplayName(mapName) ?? demoId} 全场回放`
      : t`${mapDisplayName(mapName) ?? demoId} 第 ${context.round} 回合`;

  return (
    <ViewFrame state={status === 'loading' ? 'loading' : status === 'empty' ? 'empty' : 'ready'}>
      <div className="flex flex-wrap items-center gap-3 border-b border-divider bg-surface-chrome px-4 py-2">
        <Seg name="replay-view" aria-label={t`回放视图`} value={show3D ? '3d' : '2d'}
          options={[{ value: '2d', label: t`2D 地图` }, { value: '3d', label: t`3D 视图` }]}
          onChange={(value) => setShow3D(value === '3d')} />
        <NativeSelect size="sm" className="w-auto max-w-48" aria-label={t`选手`} value={effectivePlayerId ?? ''}
          onChange={(event) => updateContext({ player: event.currentTarget.value || null })}>
          <option value=""><Trans>选择选手</Trans></option>
          {(analysis.data?.players ?? []).map((player) => <option key={player.id} value={player.id}>{player.name}</option>)}
        </NativeSelect>
        <Button size="sm" variant="ghost" aria-expanded={showLayers} onClick={() => setShowLayers((value) => !value)}><Trans>图层</Trans></Button>
      </div>
      <div className="flex min-h-0 min-w-0 flex-1">
        {/* ── the layer rail ─────────────────────────────────────────────── */}
        {showLayers && <aside
          data-replay-rail=""
          aria-label={t`回放图层与选手`}
          className="flex w-[var(--w-subnav)] flex-none flex-col gap-4 overflow-y-auto overscroll-y-contain border-r border-divider p-3.5"
        >
          <section>
            <RailHeading>
              <Trans>图层</Trans>
            </RailHeading>
            <div className="flex flex-col gap-2.5">
              <Checkbox
                size="sm"
                checked={layers.players}
                onChange={(next) => setLayers((current) => ({ ...current, players: next }))}
              >
                <Trans>选手位置</Trans>
              </Checkbox>
              {!show3D && <>
              <Checkbox
                size="sm"
                checked={layers.paths}
                onChange={(next) => setLayers((current) => ({ ...current, paths: next }))}
              >
                <Trans>移动路线</Trans>
              </Checkbox>
              <Checkbox
                size="sm"
                checked={layers.kills}
                onChange={(next) => setLayers((current) => ({ ...current, kills: next }))}
              >
                <Trans>击杀事件</Trans>
              </Checkbox>
              <Checkbox
                size="sm"
                checked={layers.heat}
                onChange={(next) => setLayers((current) => ({ ...current, heat: next }))}
              >
                <Trans>热力叠加</Trans>
              </Checkbox>
              </>}
              <Checkbox size="sm" checked={layers.utilities} onChange={(next) => setLayers((current) => ({ ...current, utilities: next }))}>
                <Trans>投掷物与范围示意</Trans>
              </Checkbox>
            </div>
          </section>

          {!show3D && layers.heat && distribution.bins.length > 0 ? (
            <section className="border-t border-divider pt-3.5">
              <RailHeading>
                <Trans>热力图图例</Trans>
              </RailHeading>
              <HeatLegend
                distribution={distribution}
                caption={
                  context.round === null ? (
                    <Trans>当前统计：这场比赛的全部位置事件。</Trans>
                  ) : (
                    <Trans>当前统计：第 {context.round} 回合的位置事件。</Trans>
                  )
                }
              />
            </section>
          ) : null}

          {/* 楼层 only exists where there is more than one. §10.3 gap 6 left the
              decision here; a two-option segment on a single-storey map would be
              a control that cannot change anything. */}
          {!show3D && layers.heat && floors.length > 1 ? (
            <section className="border-t border-divider pt-3.5">
              <RailHeading>
                <Trans>楼层</Trans>
              </RailHeading>
              <NativeSelect
                name="replay-floor"
                size="sm"
                aria-label={t`楼层`}
                value={floor === null ? 'all' : String(floor)}
                onChange={(event) => setFloor(event.currentTarget.value === 'all' ? null : Number(event.currentTarget.value))}
              >
                <option value="all"><Trans>全部</Trans></option>
                {floors.map((value) => (
                  <option key={value} value={String(value)}><FloorLabel floor={value} /></option>
                ))}
              </NativeSelect>

            </section>
          ) : null}

        </aside>}

        {/* ── canvas + transport ─────────────────────────────────────────── */}
        <div className="@container flex min-h-0 min-w-0 flex-1 flex-col">
          {!show3D && !radar.isPending && radar.data?.transform === undefined ? (
            <div
              role="status"
              className="m-3.5 mb-0 flex items-start gap-2.5 border border-warn-border bg-warn-surface px-3 py-2.5 text-sm text-warn-text"
            >
              <StatusDot status="warn" className="mt-1" />
              <Trans>
                地图底图不可用，当前仅显示选手之间的相对位置。
              </Trans>
            </div>
          ) : null}
          <div className="flex min-h-0 min-w-0 flex-1 overflow-auto overscroll-contain">
            {!show3D && <ReplayCanvas
              className="flex-1"
              mapName={mapName ?? ''}
              overviewTransform={radar.data?.transform}
              basemap={radarSrc === null ? undefined : (
                <img src={radarSrc} alt="" className="size-full object-fill opacity-35" data-replay-basemap />
              )}
              label={label}
              status={status}
              layers={layers}
              markers={markers}
              projectiles={presentation?.projectiles ?? []}
              projectileTrails={utilityTrails}
              paths={tracks.paths}
              engagements={focusedEngagements}
              distribution={distribution}
              selectedPlayerId={effectivePlayerId}
              onSelectPlayer={(playerId) =>
                updateContext({ player: playerId === context.player ? null : playerId })
              }
              selectedEngagementId={context.evidence}
              onSelectEngagement={(engagementId) => {
                const duel = duels.engagements.find((entry) => entry.id === engagementId);
                updateContext(
                  { evidence: engagementId, ...(duel === undefined ? {} : { tick: duel.tick }) },
                  { replace: true },
                );
                if (duel !== undefined) {
                  setPlayhead(duel.tick);
                  liveTick.current = duel.tick;
                  written.current = duel.tick;
                  wroteAt.current = Date.now();
                }
              }}
              {...(context.round === null
                ? {}
                : { heatSubject: t`第 ${context.round} 回合的位置事件` })}
              {...(replayError === null
                ? {}
                : { error: { message: <Trans>读不到这场比赛的回放：{replayError}</Trans>, onRetry: () => void replay.refetch() } })}
              emptyDescription={
                context.round === null ? (
                  <Trans>这场比赛还没有可用的回放帧。</Trans>
                ) : (
                  <Trans>第 {context.round} 回合落在回放流的范围之外。</Trans>
                )
              }
              emptyActions={
                context.round === null ? null : (
                  <Button variant="secondary" onClick={() => updateContext({ round: null })}>
                    <Trans>看整场</Trans>
                  </Button>
                )
              }
              {...(selectedDuel === null ? {} : { selectionSummary: describeEngagement(selectedDuel) })}
            />}
            {show3D && (
              <Scene3DView
                className="min-h-0 flex-1"
                mapName={mapName}
                frames={slice?.frames ?? []}
                tick={effectiveTick ?? 0}
                readTick={readLiveTick}
                tickRate={slice?.tickRate ?? 64}
                selectedPlayerId={effectivePlayerId}
                onSelectPlayer={(playerId) => updateContext({ player: playerId })}
                showPlayers={layers.players}
                showUtilities={layers.utilities}
              />
            )}
          </div>

          <div
            data-replay-transport=""
            className="flex flex-none flex-col gap-2.5 border-t border-divider px-5 py-3"
          >
            <Transport
              currentTime={currentSeconds}
              durationSeconds={durationSeconds}
              playing={playing}
              {...(clipInSeconds === undefined ? {} : { inPoint: clipInSeconds })}
              {...(clipOutSeconds === undefined ? {} : { outPoint: clipOutSeconds })}
              timecode="clock"
              fps={slice?.tickRate ?? 64}
              rate={rate}
              rates={DEFAULT_PLAYBACK_RATES}
              onTogglePlay={() => {
                if (playing && liveTick.current !== null) seekTo(liveTick.current);
                setPlaying((current) => !current);
              }}
              onSeek={(seconds) => {
                setPlaying(false);
                if (slice !== null) seekTo(slice.startTick + Math.round(seconds * slice.tickRate));
              }}
              onRateChange={setRate}
            />
            <div className="flex min-w-0 flex-wrap items-center gap-2 border-t border-divider pt-2" data-replay-clip-range="">
              <p className="min-w-0 flex-1 text-xs text-neutral-600" data-replay-tick={effectiveTick ?? ''}>
                <Trans>选段</Trans>{' '}
                {clipInTick === null ? '—' : formatMillisecondTimecode(clipInTick / (slice?.tickRate ?? 64))}
                {' – '}
                {clipOutTick === null ? '—' : formatMillisecondTimecode(clipOutTick / (slice?.tickRate ?? 64))}
              </p>
              <Button
                size="sm"
                variant="secondary"
                disabled={effectiveTick === null}
                onClick={() => setClipInTick(effectiveTick === null ? null : Math.round(effectiveTick))}
              >
                <Trans>设入点</Trans>
              </Button>
              <Button
                size="sm"
                variant="secondary"
                disabled={effectiveTick === null}
                onClick={() => setClipOutTick(effectiveTick === null ? null : Math.round(effectiveTick))}
              >
                <Trans>设出点</Trans>
              </Button>
              <Button
                size="sm"
                variant="primary"
                disabled={createClipDisabledReason !== undefined}
                {...(createClipDisabledReason === undefined ? {} : { disabledReason: createClipDisabledReason })}
                onClick={() => {
                  if (clipRange === null || effectivePlayerId === null || slice === null) return;
                  addToVideo.onAdd?.({
                    ...(context.round === null ? {} : { round: context.round }),
                    playerId: effectivePlayerId,
                    label: `${effectivePlayer?.name ?? effectivePlayerId} · ${formatMillisecondTimecode(clipRange.startTick / slice.tickRate)}–${formatMillisecondTimecode(clipRange.endTick / slice.tickRate)}`,
                    startTick: clipRange.startTick,
                    endTick: clipRange.endTick,
                    tickRate: slice.tickRate,
                  });
                }}
              >
                <Trans>创建剪辑</Trans>
              </Button>
              {highlight === null ? null : <Button size="sm" variant="secondary" disabled={addToVideo.disabled} onClick={() => addToVideo.onAdd?.(highlightSelection(highlight))}><Trans>加入当前高光</Trans></Button>}
            </div>
          </div>
        </div>
      </div>
    </ViewFrame>
  );
}

/* ── the Inspector: artboard 04's 「事件（列表视图）」 ─────────────────────── */

function ReplayInspector({ demoId, context, updateContext, addToVideo, collapsed }: MatchViewProps) {
  const id = demoId === '' ? null : demoId;
  const analysis = useMatchAnalysis(id);
  /* The same read the body holds — TanStack dedupes it by key — so the panel
     can resolve the same default focus the rail paints as selected. */
  const replay = useMatchReplay(id, { enabled: true });
  const bounds = useMemo(() => roundBounds(analysis.data, context.round), [analysis.data, context.round]);
  const slice = useMemo(() => sliceReplay(replay.data, bounds), [replay.data, bounds]);
  const focusedPlayerId = context.player ?? defaultFocusPlayerId(slice, analysis.data?.players ?? []);
  const events = useMemo(() => roundEvents(analysis.data, context.round), [analysis.data, context.round]);
  const rows = useMemo(() => replayEventRows(events), [events]);
  const current = currentEventId(rows, context.tick);
  const tickRate = analysis.data?.tick_rate;
  const names = playerNameIndex(analysis.data);
  const highlight = matchHighlights(analysis.data).find((entry) => entry.id === context.highlight) ?? null;

  const title =
    context.round === null ? <Trans>整场 · 事件</Trans> : <Trans>第 {context.round} 回合 · 事件</Trans>;

  return (
    <MatchInspectorPanel
      title={title}
      summary={<Trans>事件 {rows.length} 条</Trans>}
      addToVideo={addToVideo}
      addLabel={highlight !== null ? <Trans>加入当前高光</Trans> : context.round === null ? <Trans>加入作品</Trans> : <Trans>把这个回合加入作品</Trans>}
      selection={highlight !== null ? highlightSelection(highlight) : {
        ...(context.round === null ? {} : { round: context.round }),
        ...(focusedPlayerId === null ? {} : { playerId: focusedPlayerId }),
        ...(context.tick === null ? {} : { startTick: context.tick }),
      }}
      collapsed={collapsed}
    >
      <div className="flex min-h-0 flex-col">
        {analysis.isPending ? (
          <div className="flex flex-col gap-2 p-1">
            <Skeleton width="90%" />
            <Skeleton width="76%" />
            <Skeleton width="84%" />
          </div>
        ) : rows.length === 0 ? (
          <Empty
            title={<Trans>这一段没有可列出的事件</Trans>}
            description={<Trans>列表只收击杀与目标事件；伤害、购买与投掷物在证据检索里。</Trans>}
            actions={
              context.round === null ? (
                <RouteLink to="/evidence">
                  <Trans>去证据检索</Trans>
                </RouteLink>
              ) : (
                <Button variant="secondary" onClick={() => updateContext({ round: null })}>
                  <Trans>看整场</Trans>
                </Button>
              )
            }
          />
        ) : (
          <>
            <ul
              data-replay-events=""
              className="min-h-0 list-none overflow-y-auto overscroll-y-contain"
            >
              {rows.map((row) => (
                <li key={row.id}>
                  <EvidenceRow
                    evidence={toEvidenceItem(row, names)}
                    density="default"
                    {...(tickRate === undefined ? {} : { tickRate })}
                    selected={row.id === current}
                    onLocate={() =>
                      updateContext({ evidence: row.id, tick: row.tick }, { replace: true })
                    }
                  />
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </MatchInspectorPanel>
  );
}

/**
 * A row of the panel list, in the shape `EvidenceRow` takes.
 *
 * The qualifier line is authored here rather than in `replayModel.ts` because
 * every visible sentence goes through a Lingui macro (§5.1) and a macro yields
 * an element, which a `unit`-project module cannot hold.
 */
function toEvidenceItem(row: ReplayEventRow, names: ReadonlyMap<string, string>): EvidenceItem {
  const qualifiers: string[] = [];
  if (row.penetrated) qualifiers.push(t`穿墙`);
  if (row.headshot) qualifiers.push(t`爆头`);

  return {
    id: row.id,
    tick: row.tick,
    kind: row.kind,
    round: row.round,
    ...(row.actor === null ? {} : { actor: <span>{names.get(row.actor) ?? row.actor}</span> }),
    ...(row.target === null ? {} : { target: <span>{names.get(row.target) ?? row.target}</span> }),
    ...(row.weapon === null || row.weapon === '' ? {} : { weapon: formatWeaponName(row.weapon) }),
    ...(qualifiers.length === 0 ? {} : { description: qualifiers.join(' · ') }),
  };
}

/* ── small pieces ────────────────────────────────────────────────────────── */

/**
 * 回放 does not use `viewChrome`'s `ViewFrame`.
 *
 * That frame is a padded stack of bordered panels, which is what the supplement
 * artboard draws for the other eight views. Artboard 04 draws this one
 * full-bleed — a 190px layer rail, a canvas that takes the rest, and a transport
 * bar pinned to the bottom — so a `p-6` gutter and a panel border would be a
 * second box around a page that is already the box. The two probe attributes
 * are the same, so a test or a bug report can read the state of any of the nine
 * the same way; see the report for the consolidation this leaves open.
 */
function ViewFrame({ state, children }: { readonly state: string; readonly children: ReactNode }) {
  return (
    <section
      data-match-view="replay"
      data-match-view-state={state}
      className="flex min-h-0 min-w-0 flex-1 flex-col"
    >
      {children}
    </section>
  );
}

function RailHeading({ children }: { readonly children: ReactNode }) {
  return <h3 className="mb-2.5 font-heading text-xs tracking-caps text-neutral-600">{children}</h3>;
}

function FloorLabel({ floor }: { readonly floor: number }) {
  if (floor === 0) return <Trans>地面</Trans>;
  if (floor === 1) return <Trans>高层</Trans>;
  return <Trans>第 {floor} 层</Trans>;
}

export const ReplayView: MatchViewModule = {
  inspectorMode: 'persistent',
  id: 'replay',
  Body: ReplayBody,
  Inspector: ReplayInspector,
};
