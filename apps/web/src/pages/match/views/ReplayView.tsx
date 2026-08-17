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
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import { useMatchAnalysis, useMatchHeatPoints, useMatchReplay, useMapRadarOverview, analysisIsMissing } from '../../../data/match';
import { dataErrorMessage } from '../../../data/errors';
import { EmptyState, Skeleton } from '../../../design/data';
import { Notice } from '../../../design/feedback';
import { Button, Checkbox, Seg, cn } from '../../../design/primitives';
import {
  DEFAULT_HEAT_GRID_SIZE,
  DEFAULT_HEAT_STEPS,
  HeatLegend,
  binWorldSamples,
  describeEngagement,
  resolveMapCalibration,
  type HeatDistribution,
} from '../../../domain/map';
import { EvidenceRow, formatTickCount, type EvidenceItem } from '../../../domain/match';
import { DEFAULT_PLAYBACK_RATES, Transport } from '../../../domain/media';
import { MatchInspectorPanel } from '../MatchInspectorPanel';
import { NotAnalysedState } from './viewChrome';
import { mapDisplayName } from '../matchModel';
import type { MatchViewModule, MatchViewProps } from '../viewContract';
import { ReplayCanvas, type ReplayLayerVisibility } from './ReplayCanvas';
import { RouteLink } from '../../RouteLink';
import {
  buildEngagements,
  buildPlayerTracks,
  clampTick,
  currentEventId,
  frameIndexAtTick,
  heatFloors,
  heatSamplesOf,
  playerMarkers,
  replayEventRows,
  roundBounds,
  roundEvents,
  sliceReplay,
  type ReplayEventRow,
} from './replayModel';
import { usePlaybackClock } from './usePlaybackClock';

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
  /* Artboard 04's own defaults: the first three switches are filled, 热力叠加 is
     not — the map is a replay first and a density plot on demand. */
  players: true,
  paths: true,
  kills: true,
  heat: false,
};

/* ── the body ────────────────────────────────────────────────────────────── */

function ReplayBody({ demoId, context, updateContext }: MatchViewProps) {
  const id = demoId === '' ? null : demoId;
  const analysis = useMatchAnalysis(id);
  const replay = useMatchReplay(id, { enabled: true });
  const heat = useMatchHeatPoints(id);
  const mapName = analysis.data?.map_name ?? null;
  const radar = useMapRadarOverview(mapName);

  const [layers, setLayers] = useState<ReplayLayerVisibility>(DEFAULT_LAYERS);
  const [floor, setFloor] = useState<number | null>(null);
  const [playing, setPlaying] = useState(false);
  const [rate, setRate] = useState(1);
  const [playhead, setPlayhead] = useState<number | null>(null);

  /* What this view last wrote into `?tick=`. Anything else arriving there came
     from somewhere the local playhead has to yield to. */
  const written = useRef<number | null>(null);
  const wroteAt = useRef(0);

  const bounds = useMemo(() => roundBounds(analysis.data, context.round), [analysis.data, context.round]);
  const slice = useMemo(() => sliceReplay(replay.data, bounds), [replay.data, bounds]);
  const events = useMemo(() => roundEvents(analysis.data, context.round), [analysis.data, context.round]);

  const effectiveTick = slice === null ? null : clampTick(playhead ?? context.tick ?? slice.startTick, slice);
  const frameIndex = slice === null || effectiveTick === null ? -1 : frameIndexAtTick(slice.frames, effectiveTick);

  const tracks = useMemo(
    () => (slice === null ? { paths: [], stride: 1, frameCount: 0 } : buildPlayerTracks(slice.frames, frameIndex)),
    [slice, frameIndex],
  );
  const markers = useMemo(
    () => (slice === null || frameIndex < 0 ? [] : playerMarkers(slice.frames[frameIndex] ?? null)),
    [slice, frameIndex],
  );
  const duels = useMemo(
    () => buildEngagements(events, slice?.frames ?? []),
    [events, slice],
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
    if (context.tick !== null && context.tick !== written.current) setPlayhead(context.tick);
  }, [context.tick]);

  /* A different round is a different slice; the playhead from the old one is
     meaningless in it. The shell already dropped `?tick=` (workspaceContext), so
     this only has to drop the local copy. */
  useEffect(() => {
    setPlayhead(null);
    setPlaying(false);
    written.current = null;
  }, [context.round, demoId]);

  const publishTick = (tick: number, immediate: boolean) => {
    const now = Date.now();
    if (!immediate && now - wroteAt.current < TICK_URL_THROTTLE_MS) return;
    wroteAt.current = now;
    written.current = tick;
    updateContext({ tick }, { replace: true });
  };

  const seekTo = (tick: number) => {
    if (slice === null) return;
    const next = clampTick(tick, slice);
    setPlayhead(next);
    publishTick(next, true);
  };

  usePlaybackClock({
    playing: playing && slice !== null,
    onAdvance: (elapsedSeconds) => {
      if (slice === null || effectiveTick === null) return;
      const next = effectiveTick + elapsedSeconds * rate * slice.tickRate;
      if (next >= slice.endTick) {
        setPlayhead(slice.endTick);
        setPlaying(false);
        publishTick(slice.endTick, true);
        return;
      }
      const rounded = Math.round(next);
      setPlayhead(rounded);
      publishTick(rounded, false);
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

  const analysisError = dataErrorMessage(analysis.error);
  if (analysisError !== null) {
    return (
      <ViewFrame state="error">
        <div className="p-3.5">
          <Notice
            tone="danger"
            action={{ label: <Trans>重试</Trans>, onAction: () => void analysis.refetch() }}
            detail={<Trans>没有任何数据被改动，重试是安全的。</Trans>}
          >
            <Trans>打不开这场比赛的分析结果：{analysisError}</Trans>
          </Notice>
        </div>
      </ViewFrame>
    );
  }

  const replayError = dataErrorMessage(replay.error);
  const status = replay.isPending || analysis.isPending ? 'loading' : slice === null ? 'empty' : 'ready';
  const durationSeconds = slice === null ? 0 : (slice.endTick - slice.startTick) / slice.tickRate;
  const currentSeconds =
    slice === null || effectiveTick === null ? 0 : (effectiveTick - slice.startTick) / slice.tickRate;
  const selectedDuel = duels.engagements.find((duel) => duel.id === context.evidence) ?? null;

  const label =
    context.round === null
      ? t`${mapDisplayName(mapName) ?? demoId} 全场回放`
      : t`${mapDisplayName(mapName) ?? demoId} 第 ${context.round} 回合`;

  return (
    <ViewFrame state={status === 'loading' ? 'loading' : status === 'empty' ? 'empty' : 'ready'}>
      <div className="flex min-h-0 min-w-0 flex-1">
        {/* ── the layer rail ─────────────────────────────────────────────── */}
        <aside
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
            </div>
          </section>

          {layers.heat && distribution.bins.length > 0 ? (
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
          {floors.length > 1 ? (
            <section className="border-t border-divider pt-3.5">
              <RailHeading>
                <Trans>楼层</Trans>
              </RailHeading>
              <Seg
                name="replay-floor"
                fill
                size="sm"
                aria-label={t`楼层`}
                value={floor === null ? 'all' : String(floor)}
                options={[
                  { value: 'all', label: <Trans>全部</Trans> },
                  ...floors.map((value) => ({
                    value: String(value),
                    label: <FloorLabel floor={value} />,
                  })),
                ]}
                onChange={(value) => setFloor(value === 'all' ? null : Number(value))}
              />
              <p className="mt-2 text-2xs leading-normal text-neutral-600">
                <Trans>楼层只筛热力叠加：回放数据不记录楼层。</Trans>
              </p>
            </section>
          ) : null}

          <section className="border-t border-divider pt-3.5">
            <RailHeading>
              <Trans>选手</Trans>
            </RailHeading>
            {analysis.isPending ? (
              <div className="flex flex-col gap-2">
                <Skeleton width="80%" />
                <Skeleton width="70%" />
                <Skeleton width="76%" />
              </div>
            ) : (
              <ul className="flex list-none flex-col gap-1">
                {(analysis.data?.players ?? []).map((player) => {
                  const focused = player.id === context.player;
                  return (
                    <li key={player.id}>
                      <button
                        type="button"
                        data-replay-player={player.id}
                        aria-pressed={focused}
                        onClick={() => updateContext({ player: focused ? null : player.id })}
                        className={cn(
                          'flex w-full items-center gap-2 px-1 py-1 text-left text-sm',
                          'hover:bg-surface',
                          'focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent',
                          focused ? 'text-accent-800' : null,
                        )}
                      >
                        <span
                          aria-hidden="true"
                          className={cn(
                            'grid size-4 flex-none place-items-center text-2xs',
                            focused ? 'bg-accent text-bg' : 'border border-neutral-400',
                          )}
                        >
                          {player.name.trim().charAt(0).toUpperCase()}
                        </span>
                        <span className="min-w-0 truncate">{player.name}</span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        </aside>

        {/* ── canvas + transport ─────────────────────────────────────────── */}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <div className="flex min-h-0 min-w-0 flex-1 overflow-auto overscroll-contain">
            <ReplayCanvas
              className="flex-1"
              mapName={mapName ?? ''}
              overviewTransform={radar.data?.transform}
              label={label}
              status={status}
              layers={layers}
              markers={markers}
              paths={tracks.paths}
              engagements={duels.engagements}
              distribution={distribution}
              selectedPlayerId={context.player}
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
              /* No provenance line until there is something to be provenant
                 about: 「这一段有 0 帧」 under a loading canvas is a claim. */
              {...(slice === null
                ? {}
                : {
                    footnote: (
                      <ReplayProvenance
                        frameCount={slice.frames.length}
                        totalFrames={slice.totalFrames}
                        tickRate={slice.tickRate}
                        stride={tracks.stride}
                        heatSamples={distribution.sampleCount}
                        heatSkipped={distribution.skippedCount}
                        duelsSkipped={duels.skipped}
                      />
                    ),
                  })}
            />
          </div>

          <div
            data-replay-transport=""
            className="flex flex-none flex-col gap-2.5 border-t border-divider px-5 py-3"
          >
            <Transport
              currentTime={currentSeconds}
              durationSeconds={durationSeconds}
              playing={playing}
              timecode="clock"
              fps={slice?.tickRate ?? 64}
              rate={rate}
              rates={DEFAULT_PLAYBACK_RATES}
              onTogglePlay={() => setPlaying((current) => !current)}
              onSeek={(seconds) => {
                setPlaying(false);
                if (slice !== null) seekTo(slice.startTick + Math.round(seconds * slice.tickRate));
              }}
              onRateChange={setRate}
            >
              <p className="font-mono text-xs text-neutral-600" data-replay-tick={effectiveTick ?? ''}>
                {effectiveTick === null ? (
                  <Trans>tick 未定位</Trans>
                ) : (
                  <Trans>tick {formatTickCount(effectiveTick)}</Trans>
                )}
              </p>
            </Transport>
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
  const events = useMemo(() => roundEvents(analysis.data, context.round), [analysis.data, context.round]);
  const rows = useMemo(() => replayEventRows(events), [events]);
  const current = currentEventId(rows, context.tick);
  const tickRate = analysis.data?.tick_rate;

  const title =
    context.round === null ? <Trans>整场 · 事件</Trans> : <Trans>第 {context.round} 回合 · 事件</Trans>;

  return (
    <MatchInspectorPanel
      title={title}
      summary={<Trans>事件 {rows.length} 条</Trans>}
      addToVideo={addToVideo}
      addLabel={context.round === null ? <Trans>加入视频</Trans> : <Trans>把这个回合加入视频</Trans>}
      selection={{
        ...(context.round === null ? {} : { round: context.round }),
        ...(context.player === null ? {} : { playerId: context.player }),
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
          <EmptyState
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
                    evidence={toEvidenceItem(row)}
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
            <p className="px-1 pt-2.5 text-2xs leading-normal text-neutral-600">
              <Trans>只列击杀与目标事件，共 {rows.length} 条。</Trans>
            </p>
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
function toEvidenceItem(row: ReplayEventRow): EvidenceItem {
  const qualifiers: string[] = [];
  if (row.penetrated) qualifiers.push(t`穿墙`);
  if (row.headshot) qualifiers.push(t`爆头`);

  return {
    id: row.id,
    tick: row.tick,
    kind: row.kind,
    round: row.round,
    ...(row.actor === null ? {} : { actor: row.actor }),
    ...(row.target === null ? {} : { target: row.target }),
    ...(row.weapon === null || row.weapon === '' ? {} : { weapon: row.weapon }),
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
  return <h3 className="mb-2.5 font-heading text-2xs tracking-caps text-neutral-600">{children}</h3>;
}

function FloorLabel({ floor }: { readonly floor: number }) {
  if (floor === 0) return <Trans>地面</Trans>;
  if (floor === 1) return <Trans>高层</Trans>;
  return <Trans>第 {floor} 层</Trans>;
}

/**
 * The artboard's 「坐标来自本地 overview 与 VPK 雷达，采样 64 tick。」, with the
 * numbers this build actually has. Every count is measured — the thinning
 * factor, the samples that were binned, the samples that fell outside the
 * artwork, and the kills that had no position to draw an axis from.
 */
function ReplayProvenance({
  frameCount,
  totalFrames,
  tickRate,
  stride,
  heatSamples,
  heatSkipped,
  duelsSkipped,
}: {
  readonly frameCount: number;
  readonly totalFrames: number;
  readonly tickRate: number;
  readonly stride: number;
  readonly heatSamples: number;
  readonly heatSkipped: number;
  readonly duelsSkipped: number;
}) {
  return (
    <>
      <Trans>
        坐标来自本地 overview 雷达标定；这一段有 {frameCount} 帧，整场 {totalFrames} 帧，{tickRate} tick。
      </Trans>
      {stride > 1 ? (
        <>
          {' '}
          <Trans>移动路线每 {stride} 帧取一个采样点。</Trans>
        </>
      ) : null}
      {heatSamples > 0 ? (
        <>
          {' '}
          <Trans>热力叠加统计了 {heatSamples} 个位置事件。</Trans>
        </>
      ) : null}
      {heatSkipped > 0 ? (
        <>
          {' '}
          <Trans>{heatSkipped} 个样本落在图幅或所选楼层之外，没有画。</Trans>
        </>
      ) : null}
      {duelsSkipped > 0 ? (
        <>
          {' '}
          <Trans>{duelsSkipped} 次击杀在这一段没有位置样本，交战轴画不出来。</Trans>
        </>
      ) : null}
    </>
  );
}

export const ReplayView: MatchViewModule = {
  id: 'replay',
  Body: ReplayBody,
  Inspector: ReplayInspector,
};
