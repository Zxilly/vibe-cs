/*
 * pages/match/views — the drawing half of 回放与热力图.
 *
 * Presentational: every piece of state is a prop and every action leaves as a
 * callback, so `ReplayView.tsx` owns the playhead, the layer switches and the
 * selection, and this file owns nothing. Split out because the view is already
 * a rail, a transport and a clock; the map is the part worth rendering on its
 * own in a markup test.
 *
 * Three of the four layers are `domain/map`'s — `HeatLayer`, `PathLayer`,
 * `EngagementLayer`. The fourth, 「选手位置」, is drawn here.
 *
 * ── Why 选手位置 is drawn in `pages/` ───────────────────────────────────────
 *
 * Artboard 04 lists it first: 24×24 squares carrying the player's initial, the
 * focused one filled and the rest hollow. `domain/map` has no component for it
 * and this phase may not add one, so it is drawn through `MapCanvas`'s
 * projection callback — the seam that directory documents for exactly this
 * ("Layers arrive as children and receive the projection through a render
 * callback"). It reuses the directory's own selection behaviour
 * (`useRovingSelection`) rather than inventing a second one, so the markers are
 * one tab stop with arrow-key movement like every other layer. Promoting it to
 * `domain/map/PlayerLayer` is a move, not a rewrite, and it is in the report.
 */

import { t } from '@lingui/core/macro';
import { Trans } from '@lingui/react/macro';
import type { ReactNode } from 'react';

import {
  EngagementLayer,
  HeatLayer,
  MapCanvas,
  PathLayer,
  useRovingSelection,
  type Engagement,
  type HeatDistribution,
  type MapCanvasStatus,
  type MapLegendItem,
  type MapProjection,
  type OverviewTransform,
  type PlayerPath,
} from '../../../domain/map';
import type { PlayerMarker } from './replayModel';

/* ── the player layer ────────────────────────────────────────────────────── */

/** Canvas units. Artboard 04 draws the marker as a 24×24 square. */
const MARKER_SIZE = 24;

export interface PlayerLayerProps {
  readonly projection: MapProjection;
  readonly markers: readonly PlayerMarker[];
  readonly visible?: boolean | undefined;
  readonly selectedPlayerId?: string | null | undefined;
  readonly onSelectPlayer?: ((playerId: string) => void) | undefined;
}

export function PlayerLayer({
  projection,
  markers,
  visible = true,
  selectedPlayerId,
  onSelectPlayer,
}: PlayerLayerProps) {
  const items = markers.map((marker) => ({ id: marker.playerId }));
  const selection = useRovingSelection(items, {
    selectedId: selectedPlayerId,
    ...(onSelectPlayer ? { onSelect: onSelectPlayer } : {}),
  });

  if (!visible || markers.length === 0) return null;

  return (
    <g
      data-layer="players"
      data-markers={markers.length}
      {...(selection.interactive ? { role: 'listbox' as const, 'aria-label': t`选手位置` } : {})}
    >
      {markers.map((marker, index) => {
        const point = projection.toCanvas(marker);
        const focused = marker.playerId === selectedPlayerId || marker.playerId === selection.hoveredId;
        const half = MARKER_SIZE / 2;
        return (
          <g
            key={marker.playerId}
            data-player-marker={marker.playerId}
            data-side={marker.side ?? 'unknown'}
            data-selected={marker.playerId === selectedPlayerId}
            aria-label={t`${marker.playerName}，剩余 ${marker.health} 点生命，手持 ${marker.weapon}`}
            className="focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            {...selection.itemProps(marker.playerId, index)}
          >
            <rect
              x={point.x - half}
              y={point.y - half}
              width={MARKER_SIZE}
              height={MARKER_SIZE}
              strokeWidth={1.5}
              className={focused ? 'fill-accent-800 stroke-accent-800' : 'fill-none stroke-team-b'}
            />
            <text
              x={point.x}
              y={point.y}
              textAnchor="middle"
              dominantBaseline="central"
              fontSize={13}
              className={focused ? 'fill-bg' : 'fill-team-b'}
            >
              {marker.initial}
            </text>
          </g>
        );
      })}
    </g>
  );
}

/* ── the canvas ──────────────────────────────────────────────────────────── */

export interface ReplayLayerVisibility {
  readonly players: boolean;
  readonly paths: boolean;
  readonly kills: boolean;
  readonly heat: boolean;
}

export interface ReplayCanvasProps {
  readonly mapName: string;
  readonly overviewTransform?: OverviewTransform | null | undefined;
  readonly label: string;
  readonly status?: MapCanvasStatus | undefined;
  readonly error?: { readonly message: ReactNode; readonly onRetry: () => void } | undefined;
  readonly emptyDescription?: ReactNode | undefined;
  readonly emptyActions?: ReactNode | undefined;
  readonly layers: ReplayLayerVisibility;
  readonly markers: readonly PlayerMarker[];
  readonly paths: readonly PlayerPath[];
  readonly engagements: readonly Engagement[];
  readonly distribution: HeatDistribution;
  /** 「Kael 在这一回合的位置」 — what the heat numbers count. */
  readonly heatSubject?: string | undefined;
  readonly selectedPlayerId: string | null;
  readonly onSelectPlayer: (playerId: string) => void;
  readonly selectedEngagementId: string | null;
  readonly onSelectEngagement: (engagementId: string) => void;
  readonly selectionSummary?: ReactNode | undefined;
  readonly footnote?: ReactNode | undefined;
  readonly className?: string | undefined;
}

export function ReplayCanvas({
  mapName,
  overviewTransform,
  label,
  status = 'ready',
  error,
  emptyDescription,
  emptyActions,
  layers,
  markers,
  paths,
  engagements,
  distribution,
  heatSubject,
  selectedPlayerId,
  onSelectPlayer,
  selectedEngagementId,
  onSelectEngagement,
  selectionSummary,
  footnote,
  className,
}: ReplayCanvasProps) {
  /* Only the layers that are switched on get a legend row: a key for something
     that is not on screen is a key for nothing. */
  const legend: MapLegendItem[] = [];
  if (layers.players) {
    legend.push({ id: 'players', label: <Trans>选手位置</Trans>, glyph: 'outline', tone: 'team-b' });
  }
  if (layers.paths) {
    legend.push({ id: 'paths', label: <Trans>移动路线</Trans>, glyph: 'line', tone: 'accent' });
  }
  if (layers.kills) {
    legend.push({ id: 'kills', label: <Trans>经击杀验证的交战轴</Trans>, glyph: 'dashed', tone: 'fail' });
  }
  if (layers.heat) {
    legend.push({ id: 'heat', label: <Trans>热力叠加</Trans>, glyph: 'swatch', tone: 'accent' });
  }

  return (
    <MapCanvas
      mapName={mapName}
      overviewTransform={overviewTransform}
      label={label}
      status={status}
      className={className}
      {...(error === undefined
        ? {}
        : {
            error: {
              message: error.message,
              action: { label: <Trans>重新读取回放</Trans>, onAction: error.onRetry },
            },
          })}
      {...(emptyDescription === undefined ? {} : { emptyDescription })}
      {...(emptyActions === undefined ? {} : { emptyActions })}
      {...(selectionSummary === undefined ? {} : { selectionSummary })}
      {...(footnote === undefined ? {} : { footnote })}
      legend={legend}
    >
      {(projection: MapProjection) => (
        <>
          {/* Heat first: it is a field, and the objects on top of it have to
              stay readable. `HeatLayer` renders nothing when hidden. */}
          <HeatLayer
            projection={projection}
            distribution={distribution}
            visible={layers.heat}
            {...(heatSubject === undefined ? {} : { subject: heatSubject })}
          />
          <PathLayer
            projection={projection}
            paths={paths}
            visible={layers.paths}
            selectedPlayerId={selectedPlayerId}
            onSelectPlayer={onSelectPlayer}
          />
          <EngagementLayer
            projection={projection}
            engagements={engagements}
            visible={layers.kills}
            selectedEngagementId={selectedEngagementId}
            onSelectEngagement={onSelectEngagement}
          />
          <PlayerLayer
            projection={projection}
            markers={markers}
            visible={layers.players}
            selectedPlayerId={selectedPlayerId}
            onSelectPlayer={onSelectPlayer}
          />
        </>
      )}
    </MapCanvas>
  );
}
