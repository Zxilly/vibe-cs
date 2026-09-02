/*
 * Domain layer, 2 of 3 — `domain/map/`: the camera trajectory of a planned shot.
 *
 * Reference: 「08 录制计划与镜头预览」, the 导播预览 canvas. It draws the camera
 * as `stroke="var(--color-accent-800)" stroke-width="2" stroke-dasharray="7 5"`,
 * an `r="5"` filled dot labelled 「相机起点」, and a hollow 36×36 square labelled
 * 「相机终点 · 朝向交战轴 132°」. The caption under it is the honesty rule for
 * this layer: 「导播预览为相机路径示意，不是最终画质」.
 *
 * ── Why this is not `PathLayer` with a different colour ─────────────────────
 * They look similar and mean opposite things, and the difference is what the
 * props have to encode:
 *
 *   PathLayer        *evidence*. Every vertex is a position sample the demo
 *                    recorded; the number of vertices is a fact about the
 *                    capture rate, and nothing about it is editable.
 *   CameraPathLayer  a *proposal*. Its vertices are keyframes of a shot that
 *                    has not been recorded yet (spec §4.5.3 rule ①: recording
 *                    starts only from one explicit confirmation, so this is
 *                    always a preview). Keyframes carry an intent — hold,
 *                    track, arrive — and each is individually addressable,
 *                    because 3f's plan editor selects them one at a time.
 *
 * So the keyframes are the selectable objects here, while in `PathLayer` the
 * whole track is one object; and the trajectory is dashed, because a dashed
 * line in this system already means "not measured" — it is what 「04」 uses for
 * a derived engagement axis rather than a recorded position.
 *
 * The camera path also has no start/end ambiguity to solve with an arrow head:
 * the artboard labels both ends in words, and this layer keeps those labels.
 */

import { t } from '@lingui/core/macro';

import { LayerEmpty } from './LayerEmpty';
import type { MapProjection } from './mapProjection';
import { polylineCommand } from './pathGeometry';
import type { CanvasPoint, WorldPoint } from './types';
import { useRovingSelection } from './useRovingSelection';

/**
 * What the camera is doing at a keyframe. The five shot kinds of spec §4.5.2
 * (`Static | Tracking | POV | Crane | Flyby`) describe a whole shot; a keyframe
 * is finer than that, so it gets its own small vocabulary.
 */
export type CameraKeyframeKind = 'start' | 'hold' | 'track' | 'end';

export interface CameraKeyframe extends WorldPoint {
  readonly id: string;
  readonly kind: CameraKeyframeKind;
  /** Demo tick this keyframe is pinned to; the plan is written in ticks. */
  readonly tick: number;
  /** 「朝向交战轴 132°」 — world bearing the camera looks along, if it is pinned. */
  readonly bearing?: number | undefined;
  /** Short label from the plan, e.g. 「相机起点」 or 「跟随突破」. */
  readonly label?: string | undefined;
}

/** One shot's camera trajectory. */
export interface CameraPath {
  /** `Shot.id` of spec §4.5.2. */
  readonly shotId: string;
  /** 「02 跟随突破 · Tracking」 — the shot card's own title. */
  readonly shotLabel: string;
  /** Ordered along the shot's timeline. */
  readonly keyframes: readonly CameraKeyframe[];
}

export interface CameraPathLayerProps {
  readonly projection: MapProjection;
  readonly paths: readonly CameraPath[];
  readonly visible?: boolean | undefined;
  readonly selectedKeyframeId?: string | null | undefined;
  /** Omit to render a read-only preview. */
  readonly onSelectKeyframe?: ((keyframeId: string) => void) | undefined;
  /** Draw the artboard's 「相机起点」/「相机终点」 captions. Off by default: with
   *  several shots on one map the captions collide. */
  readonly showEndLabels?: boolean | undefined;
  readonly className?: string | undefined;
}

const START_RADIUS = 5;
/** The artboard's end marker is a hollow square. 36 canvas units at 940 wide
 *  is ~28 at this canvas's 720, rounded to an even number so it centres cleanly. */
const END_SQUARE = 28;
const KEYFRAME_SIZE = 9;
const SELECTION_RING = 13;

function squareProps(centre: CanvasPoint, size: number) {
  return { x: centre.x - size / 2, y: centre.y - size / 2, width: size, height: size };
}

export function CameraPathLayer({
  projection,
  paths,
  visible = true,
  selectedKeyframeId,
  onSelectKeyframe,
  showEndLabels = false,
  className,
}: CameraPathLayerProps) {
  const items = paths.flatMap((path) => path.keyframes.map((keyframe) => ({ id: keyframe.id })));
  const selection = useRovingSelection(items, {
    selectedId: selectedKeyframeId,
    ...(onSelectKeyframe ? { onSelect: onSelectKeyframe } : {}),
  });

  if (!visible) return null;

  const drawable = paths.filter((path) => path.keyframes.length > 0);
  if (drawable.length === 0) {
    return <LayerEmpty layer="camera" label={t`镜头路径：还没有关键点`} />;
  }

  /*
   * Roving focus walks one flat list, but the drawing is nested per shot. The
   * flat position of a keyframe is therefore its shot's offset plus its own
   * index — computed from positions rather than looked up by id, so a plan that
   * repeats a keyframe id still hands out exactly one tab stop.
   */
  const offsets: number[] = [];
  let running = 0;
  for (const path of drawable) {
    offsets.push(running);
    running += path.keyframes.length;
  }

  return (
    <g
      className={className}
      data-layer="camera"
      {...(selection.interactive ? { role: 'listbox' as const, 'aria-label': t`镜头关键点` } : {})}
    >
      {drawable.map((path, pathIndex) => {
        const points: CanvasPoint[] = path.keyframes.map((keyframe) => projection.toCanvas(keyframe));
        const command = polylineCommand(points);
        const first = points[0];
        const last = points[points.length - 1];
        const single = path.keyframes.length === 1;

        return (
          <g key={path.shotId} data-camera-path={path.shotId}>
            {command === '' ? null : (
              <path
                d={command}
                fill="none"
                className="stroke-accent-800"
                strokeWidth={2}
                strokeDasharray="7 5"
                strokeLinejoin="round"
                data-role="camera-track"
              />
            )}
            {first ? (
              <circle cx={first.x} cy={first.y} r={START_RADIUS} className="fill-accent-800" data-role="camera-start" />
            ) : null}
            {last && !single ? (
              <rect
                {...squareProps(last, END_SQUARE)}
                fill="none"
                className="stroke-accent-800"
                strokeWidth={2}
                data-role="camera-end"
              />
            ) : null}
            {showEndLabels && first ? (
              <text
                x={first.x + START_RADIUS + 6}
                y={first.y + 5}
                className="fill-accent-800 font-heading text-md"
                data-role="camera-start-label"
              >
                {t`相机起点`}
              </text>
            ) : null}
            {showEndLabels && last && !single ? (
              <text
                x={last.x + END_SQUARE / 2 + 6}
                y={last.y + 5}
                className="fill-accent-800 font-heading text-md"
                data-role="camera-end-label"
              >
                {t`相机终点`}
              </text>
            ) : null}
            {path.keyframes.map((keyframe, keyframeIndex) => {
              const centre = points[keyframeIndex];
              if (!centre) return null;
              const index = (offsets[pathIndex] ?? 0) + keyframeIndex;
              const selected = keyframe.id === selectedKeyframeId;
              const hovered = keyframe.id === selection.hoveredId;
              const bearing = keyframe.bearing;
              const label = keyframe.label;

              return (
                <g
                  key={keyframe.id}
                  data-keyframe={keyframe.id}
                  data-kind={keyframe.kind}
                  data-tick={keyframe.tick}
                  data-selected={selected}
                  aria-label={
                    bearing === undefined
                      ? t`${path.shotLabel} 关键点 ${label ?? keyframe.kind}，tick ${keyframe.tick}`
                      : t`${path.shotLabel} 关键点 ${label ?? keyframe.kind}，tick ${keyframe.tick}，朝向 ${Math.round(bearing)}°`
                  }
                  className="focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                  {...selection.itemProps(keyframe.id, index)}
                >
                  <rect
                    {...squareProps(centre, KEYFRAME_SIZE)}
                    className={hovered || selected ? 'fill-accent-800' : 'fill-bg stroke-accent-800'}
                    strokeWidth={1.5}
                    data-role="keyframe"
                  />
                  {selected ? (
                    <circle
                      cx={centre.x}
                      cy={centre.y}
                      r={SELECTION_RING}
                      fill="none"
                      className="stroke-accent-800"
                      strokeWidth={1.5}
                      data-role="selection-ring"
                    />
                  ) : null}
                </g>
              );
            })}
          </g>
        );
      })}
    </g>
  );
}
