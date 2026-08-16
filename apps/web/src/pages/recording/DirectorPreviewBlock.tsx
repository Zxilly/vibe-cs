/*
 * pages/recording — block B, 导播预览.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  The camera path is real. The picture is not.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The artboard's caption — 「导播预览为相机路径示意，不是最终画质」 — is exactly
 * true after phase 3f, and it is worth being precise about which half is which:
 *
 *   real       every keyframe drawn here is a `CameraKeyframe` out of
 *              `HlaeProposalPreview.typed_plan`, sampled from replay evidence
 *              by `sample_four_frames` and compiled by the same code that will
 *              write the HLAE script. The positions, the headings and the
 *              fields of view are the ones the game will fly.
 *   not real    the *frame*. Nothing renders a shot to an image (contract gap
 *              3); the only way to see the picture is 「在游戏里预览」, which is
 *              block D's door.
 *   not real    the marker's motion **between** keyframes. The compiled path
 *              interpolates `Cubic` / `SphericalCubic`; the marker reads
 *              straight lines between known-true samples, because a second,
 *              subtly different curve would be a more convincing lie than a
 *              visibly simplified one. `cameraPlanShotFootnote` says so on
 *              screen rather than only here.
 *
 * ── Three dimensions, two of which fit on a radar ─────────────────────────
 *
 * `domain/map`'s `WorldPoint` has no `z` on purpose — height in the analysis
 * product is a *floor*, a two-way switch. A camera is not a floor. Projected
 * onto the radar alone, 「从高处降下来」 and 「贴地平移」 are the same line, and
 * telling those two apart is most of what a director preview is for. So the
 * plan view gets x/y and a separate strip under it gets z against time, and the
 * camera marker prints its own height beside itself.
 *
 * ── What is drawn, and by whom ────────────────────────────────────────────
 *
 * `domain/map/CameraPathLayer` already draws the dashed track, the filled start
 * dot, the hollow end square and the per-keyframe markers — it was built for
 * this artboard. What it does not draw is the heading arrow and the field-of-
 * view wedge, so those are a page-level layer through `MapCanvas`'s projection
 * callback, which is the seam that directory documents for exactly this
 * (`ReplayCanvas`'s `PlayerLayer` is the precedent). Both are built in **world**
 * space and then projected: canvas y grows downward, so rotating a world bearing
 * in canvas space gives the mirrored angle.
 *
 * The radar bitmap is a real image. Tauri's CSP allows the `vibe-cs-media:`
 * protocol and `bridge.rs` whitelists `/maps/{map}/radar`, so
 * `useNativeShell().mediaSrc` produces a `src` the shipped app can load; `null`
 * outside the desktop shell, where `MapCanvas` falls back to its blueprint grid.
 */

import { t } from '@lingui/core/macro';
import { useLingui } from '@lingui/react';
import { Trans } from '@lingui/react/macro';
import { useEffect, useMemo, useState } from 'react';

import { useDemo } from '../../data/demos';
import { dataErrorMessage } from '../../data/errors';
import { useMapRadarOverview } from '../../data/match';
import { useNativeShell } from '../../data/nativeShell';
import { EmptyState } from '../../design/data';
import { Notice } from '../../design/feedback';
import { Button, Tag, cx } from '../../design/primitives';
import { formatTickRange } from '../../domain/agent';
import {
  CameraPathLayer,
  MapCanvas,
  arrowHeadCommand,
  polylineCommand,
  type CameraPath,
  type MapProjection,
  type OverviewTransform,
} from '../../domain/map';
import { Transport } from '../../domain/media';
import type { DirectorShot } from '../../shared/desktop/dto';
import type { CameraDesk } from './cameraDesk';
import {
  cameraHeightProfile,
  cameraHeightRange,
  cameraPlanDurationSeconds,
  cameraPlanKeyframes,
  cameraPlanTickRange,
  cameraSampleAtSeconds,
  normaliseBearing,
  worldPointAlong,
  type CameraPlan,
  type CameraPlanKeyframe,
} from './cameraPlan';
import { directorShotForItem, mergedItemCount, type RecordingBlockProps } from './recordingContract';
import { CAMERA_STYLE, SHOT_VIEW, shotViewOf } from './shotModel';

export interface DirectorPreviewBlockProps extends RecordingBlockProps {
  /** The one compiled path, owned by the shell so block D writes what block B
   *  drew. */
  readonly camera: CameraDesk;
}

/** How far in front of a keyframe the heading arrow reaches, in Hammer units. */
const HEADING_LENGTH = 220;
/** The field-of-view wedge's radius, in Hammer units. Shorter than the heading
 *  arrow so the two are readable on top of each other. */
const FOV_RADIUS = 170;
/** Playhead resolution. 100ms is finer than the eye reads on a 40px strip and
 *  coarse enough that a five-second path costs fifty renders. */
const PLAYHEAD_STEP_MS = 100;

export function DirectorPreviewBlock({ plan, selection, camera }: DirectorPreviewBlockProps) {
  const { i18n } = useLingui();
  const shell = useNativeShell();

  const shot = plan.items.find((item) => item.id === selection.shotId) ?? null;
  const demo = useDemo(shot?.demo_id ?? null);
  const mapName = demo.data?.map_name ?? null;
  const radar = useMapRadarOverview(mapName);

  const cameraPlan = camera.plan;
  const durationSeconds = cameraPlan === null ? 0 : cameraPlanDurationSeconds(cameraPlan);

  const [playhead, setPlayhead] = useState(0);
  const [playing, setPlaying] = useState(false);

  /* A new path resets the head. Deriving it would be wrong — the head is the
     user's position in the shot, not a function of the shot. */
  useEffect(() => {
    setPlayhead(0);
    setPlaying(false);
  }, [camera.shotId, cameraPlan]);

  /* The clock. A plain interval rather than `requestAnimationFrame`: the head
     moves a marker over a schematic, not a video, and rAF is unavailable in the
     node environment the markup tests render in. */
  useEffect(() => {
    if (!playing || durationSeconds <= 0) return;
    const timer = globalThis.setInterval(() => {
      setPlayhead((current) => Math.min(durationSeconds, current + PLAYHEAD_STEP_MS / 1000));
    }, PLAYHEAD_STEP_MS);
    return () => globalThis.clearInterval(timer);
  }, [playing, durationSeconds]);

  /* Stopping is derived from the head rather than done inside the updater — a
     state update that schedules another state update is the one shape React
     will run twice under StrictMode. */
  useEffect(() => {
    if (playing && durationSeconds > 0 && playhead >= durationSeconds) setPlaying(false);
  }, [playing, playhead, durationSeconds]);

  const sample = useMemo(
    () => (cameraPlan === null ? null : cameraSampleAtSeconds(cameraPlan, playhead)),
    [cameraPlan, playhead],
  );

  const director = plan.plan?.director ?? null;
  const directorShot =
    director === null || shot === null ? null : directorShotForItem(director, shot.id);

  return (
    <section
      data-recording-block="preview"
      aria-label={t`导播预览`}
      className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto"
    >
      {shot === null ? (
        <EmptyState
          className="m-6"
          title={<Trans>还没有选中片段</Trans>}
          description={<Trans>在左边选一个片段，这里会画出它的相机路径与朝向。</Trans>}
          actions={null}
        />
      ) : (
        <>
          <header className="flex flex-none flex-wrap items-center gap-2 border-b border-divider px-5 py-2.5">
            <Tag tone="accent">
              {shot.title} · {i18n._(CAMERA_STYLE[shot.camera_style].label)}
            </Tag>
            <Tag tone="neutral">{i18n._(SHOT_VIEW[shotViewOf(shot)])}</Tag>
            <div className="flex-1" aria-hidden="true" />
            <span className="font-mono text-xs text-neutral-700">
              {formatTickRange(shot.start_tick, shot.end_tick)}
            </span>
          </header>

          <div className="min-h-0 flex-1 p-5">
            <CameraPathState
              camera={camera}
              mapName={mapName}
              basemapSrc={mapName === null ? null : shell.mediaSrc(`/api/maps/${mapName}/radar`)}
              overviewTransform={radar.data?.transform ?? null}
              sample={sample}
            />
          </div>

          {cameraPlan === null ? null : (
            <>
              <HeightProfile plan={cameraPlan} at={sample} />
              <div className="flex-none px-5 pb-3">
                <Transport
                  currentTime={playhead}
                  durationSeconds={durationSeconds}
                  playing={playing}
                  timecode="clock"
                  onTogglePlay={() => setPlaying((current) => !current)}
                  onSeek={setPlayhead}
                />
              </div>
            </>
          )}

          <p className="flex-none px-5 pb-2 text-xs text-neutral-700">
            <Trans>导播预览为相机路径示意，不是最终画质。</Trans>
            {cameraPlan === null ? null : (
              <>
                {' '}
                <Trans>关键点之间按直线读取，实际会按三次曲线插值飞行。</Trans>
              </>
            )}
          </p>

          <DirectorExplanation shot={directorShot} />
        </>
      )}
    </section>
  );
}

/* ── the five states of the path ─────────────────────────────────────────── */

function CameraPathState({
  camera,
  mapName,
  basemapSrc,
  overviewTransform,
  sample,
}: {
  readonly camera: CameraDesk;
  readonly mapName: string | null;
  readonly basemapSrc: string | null;
  /** The live transform, when the radar read landed. `null` falls back to the
   *  checked-in calibration table, which `MapCanvas` already labels 「占位标定」
   *  — a failed radar read is therefore a degraded drawing, not a blank one. */
  readonly overviewTransform: OverviewTransform | null;
  readonly sample: CameraPlanKeyframe | null;
}) {
  if (camera.status === 'unavailable') {
    return (
      <EmptyState
        title={<Trans>这个片段没有绑定高光</Trans>}
        description={
          <Trans>相机路径是从高光的回放证据里采样出来的，没有高光就没有可以画的路径。</Trans>
        }
        actions={null}
      />
    );
  }

  if (camera.status === 'failed') {
    return (
      <Notice
        tone="danger"
        action={{ label: <Trans>重试</Trans>, onAction: camera.reload }}
        detail={<Trans>没有任何数据被改动，重试是安全的。</Trans>}
      >
        <Trans>算不出相机路径：{dataErrorMessage(camera.error) ?? ''}</Trans>
      </Notice>
    );
  }

  if (camera.status === 'loading' || camera.status === 'idle') {
    return (
      <div
        role="status"
        aria-busy="true"
        data-camera-path="loading"
        className="aspect-square w-full animate-pulse bg-neutral-200"
      >
        <span className="sr-only">
          <Trans>正在编译相机路径</Trans>
        </span>
      </div>
    );
  }

  const drawable = camera.plan;
  if (camera.status === 'blocked' || drawable === null) {
    /*
     * Not ready. `prerequisites` is the list of things that are missing — most
     * often 「这一段回放采样不足四帧」, which is `sample_four_frames` saying it
     * could not find four usable frames. Each one is printed as it came;
     * inventing a path here would be drawing a camera move nobody planned.
     */
    return (
      <div data-camera-path="blocked" className="border border-divider p-5">
        <h3 className="font-heading text-sm tracking-caps">
          <Trans>还画不出这个镜头的相机路径</Trans>
        </h3>
        {camera.prerequisites.length === 0 ? (
          <p className="mt-2 text-sm text-neutral-700">
            <Trans>服务没有说明原因，重新编译一次通常能得到更具体的说明。</Trans>
          </p>
        ) : (
          <ul className="mt-3 flex list-none flex-col gap-2">
            {camera.prerequisites.map((prerequisite) => (
              <li key={prerequisite.code} data-prerequisite={prerequisite.code} className="text-sm">
                {/* The message is the service's own sentence about this Demo;
                    printing it is the point. The code beside it is what a bug
                    report needs and is never translated. */}
                <span className="text-text">{prerequisite.message}</span>{' '}
                <span className="font-mono text-2xs text-neutral-600">{prerequisite.code}</span>
              </li>
            ))}
          </ul>
        )}
        <Button className="mt-4" variant="secondary" onClick={camera.reload}>
          <Trans>重新编译</Trans>
        </Button>
      </div>
    );
  }

  if (mapName === null) {
    return (
      <EmptyState
        title={<Trans>还不知道这个片段属于哪张地图</Trans>}
        description={<Trans>相机路径已经算好了，但缺少这张地图的底图，没法把它画出来。</Trans>}
        actions={null}
      />
    );
  }

  return (
    <MapCanvas
      mapName={mapName}
      overviewTransform={overviewTransform}
      label={t`${mapName} 的相机路径`}
      basemap={
        basemapSrc === null ? undefined : (
          <img src={basemapSrc} alt="" aria-hidden="true" className="size-full object-contain" />
        )
      }
      legend={[
        { id: 'track', label: <Trans>相机路径</Trans>, glyph: 'dashed', tone: 'accent' },
        { id: 'heading', label: <Trans>朝向与视野</Trans>, glyph: 'line', tone: 'accent' },
        { id: 'head', label: <Trans>当前机位</Trans>, glyph: 'swatch', tone: 'fail' },
      ]}
      selectionSummary={<CameraSummary sample={sample} />}
      footnote={
        <Trans>关键点由回放证据采样得到，坐标与朝向来自将要执行的相机计划本身。</Trans>
      }
    >
      {(projection: MapProjection) => (
        <>
          <CameraPathLayer projection={projection} paths={cameraPaths(drawable)} showEndLabels />
          <HeadingLayer projection={projection} plan={drawable} />
          {sample === null ? null : <CameraHeadLayer projection={projection} sample={sample} />}
        </>
      )}
    </MapCanvas>
  );
}

/* ── layers ──────────────────────────────────────────────────────────────── */

/** `CameraPlan` → the shape `domain/map/CameraPathLayer` draws. */
export function cameraPaths(plan: CameraPlan): CameraPath[] {
  return plan.shots.map((shot) => ({
    shotId: shot.id,
    shotLabel: shot.id,
    keyframes: shot.keyframes.map((keyframe, index) => ({
      id: `${shot.id}:${keyframe.tick}:${index}`,
      kind:
        index === 0
          ? ('start' as const)
          : index === shot.keyframes.length - 1
            ? ('end' as const)
            : ('track' as const),
      tick: keyframe.tick,
      x: keyframe.position.x,
      y: keyframe.position.y,
      bearing: normaliseBearing(keyframe.rotation.yaw),
    })),
  }));
}

/**
 * The heading arrow and the field-of-view wedge at every keyframe.
 *
 * Decorative in the accessibility sense: every fact drawn here is also in the
 * keyframe's own `aria-label` inside `CameraPathLayer`, so a second set of tab
 * stops over the same objects would make the drawing worse to navigate rather
 * than better.
 */
function HeadingLayer({
  projection,
  plan,
}: {
  readonly projection: MapProjection;
  readonly plan: CameraPlan;
}) {
  const keyframes = cameraPlanKeyframes(plan);
  if (keyframes.length === 0) return null;

  return (
    <g data-layer="camera-heading" aria-hidden="true">
      {keyframes.map((keyframe, index) => {
        const origin = { x: keyframe.position.x, y: keyframe.position.y };
        const centre = projection.toCanvas(origin);
        const bearing = normaliseBearing(keyframe.rotation.yaw);
        const tip = projection.toCanvas(worldPointAlong(origin, bearing, HEADING_LENGTH));
        const half = Math.min(80, Math.max(5, keyframe.fov / 2));
        const left = projection.toCanvas(worldPointAlong(origin, bearing + half, FOV_RADIUS));
        const right = projection.toCanvas(worldPointAlong(origin, bearing - half, FOV_RADIUS));

        return (
          <g key={`${keyframe.tick}:${index}`} data-heading={keyframe.tick}>
            {/* The wedge: the horizontal field of view this keyframe carries.
                Filled faintly rather than stroked, so several of them overlap
                without turning into a hatch. */}
            <path
              d={`M ${centre.x} ${centre.y} L ${left.x} ${left.y} L ${right.x} ${right.y} Z`}
              className="fill-accent-300/40 stroke-accent-500"
              strokeWidth={0.75}
              data-role="fov-wedge"
            />
            <path
              d={polylineCommand([centre, tip])}
              fill="none"
              className="stroke-accent-800"
              strokeWidth={1.25}
              data-role="heading"
            />
            <path
              d={arrowHeadCommand(centre, tip, 10)}
              className="fill-accent-800"
              data-role="heading-head"
            />
          </g>
        );
      })}
    </g>
  );
}

/** Where the playhead says the camera is. */
function CameraHeadLayer({
  projection,
  sample,
}: {
  readonly projection: MapProjection;
  readonly sample: CameraPlanKeyframe;
}) {
  const centre = projection.toCanvas({ x: sample.position.x, y: sample.position.y });
  return (
    <g data-layer="camera-head" aria-hidden="true">
      <circle cx={centre.x} cy={centre.y} r={7} className="fill-fail" data-role="camera-head" />
      <circle
        cx={centre.x}
        cy={centre.y}
        r={13}
        fill="none"
        className="stroke-fail"
        strokeWidth={1.5}
      />
      {/* z, printed next to the marker. Without it the plan view cannot tell a
          descent from a slide — see the module note. */}
      <text
        x={centre.x + 17}
        y={centre.y + 4}
        className="fill-fail font-heading text-2xs"
        data-role="camera-head-height"
      >
        {Math.round(sample.position.z)}
      </text>
    </g>
  );
}

/* ── the height strip ────────────────────────────────────────────────────── */

/**
 * Time across, world z up. The third dimension the radar cannot carry.
 *
 * A `<figure>` with a written reading beside it, not a bare picture: 「上升 312
 * 单位」 is the sentence, the strip is the illustration, and the sentence is
 * what a screen reader gets.
 */
function HeightProfile({
  plan,
  at,
}: {
  readonly plan: CameraPlan;
  readonly at: CameraPlanKeyframe | null;
}) {
  const profile = useMemo(() => cameraHeightProfile(plan), [plan]);
  if (profile === null) return null;

  const span = cameraHeightRange(profile);
  const width = 100;
  const height = 40;
  const duration = profile.durationSeconds;

  const toX = (seconds: number): number =>
    duration <= 0 ? 0 : (Math.max(0, Math.min(duration, seconds)) / duration) * width;
  const toY = (z: number): number =>
    span <= 0 ? height / 2 : height - ((z - profile.minZ) / span) * height;

  const command = polylineCommand(
    profile.samples.map((sample) => ({ x: toX(sample.seconds), y: toY(sample.z) })),
  );

  const range = cameraPlanTickRange(plan);
  const headSeconds =
    at === null || range === null ? null : (at.tick - range.start) / plan.tickRate;

  return (
    <figure className="flex-none px-5 pb-3" data-camera-height={Math.round(span)}>
      <figcaption className="mb-1 flex items-baseline gap-2 text-2xs text-neutral-600">
        <span className="font-heading tracking-caps">
          <Trans>高度</Trans>
        </span>
        <span>
          {span < 1 ? (
            <Trans>整段几乎贴平，高度变化不到 1 个单位</Trans>
          ) : (
            <Trans>高度在这一段里变化了 {Math.round(span)} 个单位</Trans>
          )}
        </span>
      </figcaption>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
        className="block h-[40px] w-full border border-divider bg-bg"
        role="img"
        aria-label={t`相机高度随时间的变化`}
      >
        <path d={command} fill="none" className="stroke-accent-800" strokeWidth={1} vectorEffect="non-scaling-stroke" />
        {headSeconds === null ? null : (
          <line
            x1={toX(headSeconds)}
            x2={toX(headSeconds)}
            y1={0}
            y2={height}
            className="stroke-fail"
            strokeWidth={1}
            vectorEffect="non-scaling-stroke"
            data-role="height-playhead"
          />
        )}
      </svg>
    </figure>
  );
}

/* ── the written half ────────────────────────────────────────────────────── */

function CameraSummary({ sample }: { readonly sample: CameraPlanKeyframe | null }) {
  if (sample === null) return null;
  return (
    <Trans>
      当前机位 tick {Math.round(sample.tick)} · 朝向 {Math.round(normaliseBearing(sample.rotation.yaw))}
      ° · 高度 {Math.round(sample.position.z)} · 视野 {Math.round(sample.fov)}°
    </Trans>
  );
}

/**
 * 「导播为什么这样编排」 — `DirectorShot.explanation` and `.evidence`, printed
 * as they came.
 *
 * This is the provenance of the arrangement, so it is not paraphrased: the
 * explanation is the director's own sentence and the evidence entries are the
 * identifiers a reader can look up. A shot the director merged into a
 * neighbour says so, because `source_item_ids` is plural and 「这个片段与相邻
 * 镜头合并了」 is a fact about the preview rather than an empty panel.
 */
function DirectorExplanation({ shot }: { readonly shot: DirectorShot | null }) {
  if (shot === null) return null;
  const merged = mergedItemCount(shot);

  return (
    <section
      data-director-shot="true"
      className="flex-none border-t border-divider px-5 py-3 text-xs leading-relaxed"
    >
      <h3 className="font-heading text-2xs tracking-caps text-neutral-600">
        <Trans>导播编排依据</Trans>
      </h3>
      {merged > 1 ? (
        <p className="mt-1 text-warn-text">
          <Trans>这个片段与相邻的镜头合并成了一个导播镜头，共 {merged} 个片段。</Trans>
        </p>
      ) : null}
      {shot.explanation === '' ? null : <p className="mt-1 text-text">{shot.explanation}</p>}
      {shot.evidence.length === 0 ? null : (
        <ul className={cx('mt-1.5 flex list-none flex-wrap gap-2 font-mono text-2xs text-neutral-600')}>
          {shot.evidence.map((entry) => (
            <li key={entry}>{entry}</li>
          ))}
        </ul>
      )}
    </section>
  );
}
