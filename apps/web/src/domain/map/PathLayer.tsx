/*
 * Domain layer, 2 of 3 — `domain/map/`: player movement tracks.
 *
 * Reference: 「04 2D 回放与热力图」 draws the focused player's route as
 * `stroke="var(--color-accent-800)" stroke-width="2"`, solid, with a filled
 * `r="4"` circle at its first sample, and labels it in the legend as
 * 「Kael 移动路线」. Everyone else on that artboard is drawn in
 * `--color-team-b`, hollow.
 *
 * ── Time direction ─────────────────────────────────────────────────────────
 * A route is useless if you cannot tell which way it was walked. The artboard
 * only marks the start, which is ambiguous the moment two routes cross, so this
 * layer marks both ends: the artboard's filled circle at the first sample and a
 * triangular head at the last, pointing along the final segment. Direction is
 * carried by shape, not by a colour ramp or a dash phase — a ramp would collide
 * with the selection colour, and at the stroke widths a 720-unit canvas gives a
 * 600-sample track a dash phase is not readable.
 *
 * The head is only drawn when the track is long enough to hold one
 * (`MIN_TRACK_LENGTH_FOR_HEAD`); on a short track it would be most of the mark
 * and would read as an object rather than as a direction.
 *
 * ── Colour ─────────────────────────────────────────────────────────────────
 * Selection, not team, decides the colour, because that is what the artboard
 * does: one player is the subject and the others are context. `side` still
 * travels on the record and reaches the DOM as `data-side`, so a page can key a
 * roster list off the same objects, but it does not paint anything — with ten
 * tracks on one map, five in each of two colours, nothing would stand out.
 */

import { t } from '@lingui/core/macro';

import { LayerEmpty } from './LayerEmpty';
import type { MapProjection } from './mapProjection';
import { arrowHeadCommand, polylineCommand, polylineLength } from './pathGeometry';
import type { CanvasPoint, MapSide, WorldPoint } from './types';
import { useRovingSelection } from './useRovingSelection';

/**
 * One position sample. `tick` is the ordering key and the deep link back into
 * the workspace (spec §4.4 makes tick part of the URL), matching
 * `ReplayFrameRecord.tick`.
 */
export interface PathSample extends WorldPoint {
  readonly tick: number;
  readonly floor?: number | undefined;
}

/**
 * One player's track. Field names follow `ReplayPlayerRecord` (`id`, `name`,
 * `team`) closely enough that a page can build this without a lookup table, but
 * `samples` is this layer's own word: the DTO stores one position per frame, and
 * what a track needs is the sequence.
 */
export interface PlayerPath {
  /** `ReplayPlayerRecord.id`. */
  readonly playerId: string;
  /** `ReplayPlayerRecord.name`. */
  readonly playerName: string;
  readonly side?: MapSide | undefined;
  /** Ascending by tick. Not sorted here — order is evidence, not presentation. */
  readonly samples: readonly PathSample[];
}

export interface PathLayerProps {
  readonly projection: MapProjection;
  readonly paths: readonly PlayerPath[];
  /** Shown / hidden is the page's state. */
  readonly visible?: boolean | undefined;
  readonly selectedPlayerId?: string | null | undefined;
  /** Emphasised without being selected — e.g. the row the pointer is on elsewhere. */
  readonly highlightedPlayerId?: string | null | undefined;
  /** Omit to render a read-only layer. */
  readonly onSelectPlayer?: ((playerId: string) => void) | undefined;
  readonly className?: string | undefined;
}

/** Canvas units. Below this a direction head is bigger than the track. */
const MIN_TRACK_LENGTH_FOR_HEAD = 24;
const HEAD_SIZE = 11;
const START_RADIUS = 4;

export function PathLayer({
  projection,
  paths,
  visible = true,
  selectedPlayerId,
  highlightedPlayerId,
  onSelectPlayer,
  className,
}: PathLayerProps) {
  const items = paths.map((path) => ({ id: path.playerId }));
  const selection = useRovingSelection(items, {
    selectedId: selectedPlayerId,
    ...(onSelectPlayer ? { onSelect: onSelectPlayer } : {}),
  });

  if (!visible) return null;

  const drawable = paths.filter((path) => path.samples.length > 0);
  if (drawable.length === 0) {
    return <LayerEmpty layer="paths" label={t`移动路线：这一段没有位置样本`} />;
  }

  return (
    <g
      className={className}
      data-layer="paths"
      {...(selection.interactive ? { role: 'listbox' as const, 'aria-label': t`移动路线` } : {})}
    >
      {drawable.map((path) => {
        const index = paths.indexOf(path);
        const points: CanvasPoint[] = path.samples.map((sample) => projection.toCanvas(sample));
        const command = polylineCommand(points);
        const first = points[0];
        const last = points[points.length - 1];
        const previous = points[points.length - 2];
        const emphasised =
          path.playerId === selectedPlayerId ||
          path.playerId === highlightedPlayerId ||
          path.playerId === selection.hoveredId;
        const stroke = emphasised ? 'stroke-accent-800' : 'stroke-team-b';
        const fill = emphasised ? 'fill-accent-800' : 'fill-team-b';
        const head =
          previous && last && polylineLength(points) >= MIN_TRACK_LENGTH_FOR_HEAD
            ? arrowHeadCommand(previous, last, HEAD_SIZE)
            : '';
        const firstSample = path.samples[0];
        const lastSample = path.samples[path.samples.length - 1];

        return (
          <g
            key={path.playerId}
            data-path={path.playerId}
            data-side={path.side ?? 'unknown'}
            data-selected={path.playerId === selectedPlayerId}
            aria-label={t`${path.playerName} 的移动路线，${path.samples.length} 个位置样本，tick ${firstSample?.tick ?? 0} 到 ${lastSample?.tick ?? 0}`}
            className="focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            {...selection.itemProps(path.playerId, index)}
          >
            {command === '' ? null : (
              <path
                d={command}
                fill="none"
                className={stroke}
                strokeWidth={emphasised ? 2 : 1.5}
                strokeLinejoin="round"
                strokeLinecap="round"
                data-role="track"
              />
            )}
            {first ? (
              <circle cx={first.x} cy={first.y} r={START_RADIUS} className={fill} data-role="track-start" />
            ) : null}
            {head === '' ? null : <path d={head} className={fill} data-role="track-end" />}
          </g>
        );
      })}
    </g>
  );
}
