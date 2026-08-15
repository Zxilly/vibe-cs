/*
 * Domain layer, 2 of 3 — `domain/map/`: the 2D map surface and its layers.
 *
 * Reference artboards: 「04 2D 回放与热力图」 (the canvas, the legend, the heat
 * scale, the event list's vocabulary) and 「08 录制计划与镜头预览」 (the camera
 * trajectory). Pages import from here; nothing outside this directory should
 * need a deep path into it.
 *
 * Everything here is presentational. No component fetches, imports a store, or
 * reaches `shared/desktop/client` — spec §2.1 rule 6. Data arrives as props and
 * every layer is controlled: visibility, selection and highlight all live on
 * the page, and the only state a component owns is hover.
 *
 * The arithmetic is separated from the drawing on purpose:
 *
 *   mapCalibration  where a map's overview sits in world space, and how sure
 *                   we are of it
 *   mapProjection   world → canvas, and back. The floor of the group.
 *   heatBinning     points → bins, with the "do not colour what was not
 *                   observed" rules
 *   pathGeometry    polylines, direction heads, bearings, distances
 *   rovingIndex     which object an arrow key moves to
 *
 * All five are React-free and run in the `unit` project.
 */

export {
  MapCanvas,
  MAP_CANVAS_EXTENT,
  type MapCanvasError,
  type MapCanvasProps,
  type MapCanvasStatus,
  type MapLegendGlyph,
  type MapLegendItem,
  type MapTone,
} from './MapCanvas';

export { HeatLayer, HeatLegend, HEAT_STEP_BACKGROUND, HEAT_STEP_FILL } from './HeatLayer';
export type { HeatLayerProps, HeatLegendProps } from './HeatLayer';

export { PathLayer } from './PathLayer';
export type { PathLayerProps, PathSample, PlayerPath } from './PathLayer';

export { describeEngagement, EngagementLayer } from './EngagementLayer';
export type { Engagement, EngagementActor, EngagementLayerProps } from './EngagementLayer';

export { CameraPathLayer } from './CameraPathLayer';
export type { CameraKeyframe, CameraKeyframeKind, CameraPath, CameraPathLayerProps } from './CameraPathLayer';

export { LayerEmpty, type LayerEmptyProps } from './LayerEmpty';

export {
  calibrationFromOverview,
  findMapCalibration,
  isUsableCalibration,
  MAP_CALIBRATIONS,
  normaliseMapName,
  OVERVIEW_IMAGE_SIZE,
  resolveMapCalibration,
  type CalibrationConfidence,
  type MapCalibration,
  type OverviewTransform,
} from './mapCalibration';

export {
  coversNormalized,
  createMapProjection,
  fitOverview,
  normalizedToWorld,
  worldSpan,
  worldToNormalized,
  type MapProjection,
  type MapViewport,
  type OverviewFit,
} from './mapProjection';

export {
  binNormalizedSamples,
  binWorldSamples,
  DEFAULT_HEAT_GRID_SIZE,
  DEFAULT_HEAT_STEPS,
  heatStep,
  type HeatBin,
  type HeatBinningOptions,
  type HeatDistribution,
  type HeatSample,
} from './heatBinning';

export {
  arrowHeadCommand,
  COORDINATE_PRECISION,
  crossCommand,
  finitePoints,
  formatCoordinate,
  HAMMER_UNITS_PER_METRE,
  polylineCommand,
  polylineLength,
  worldBearingDegrees,
  worldDistanceMetres,
} from './pathGeometry';

export { isRovingKey, nextRovingIndex, ROVING_KEYS, rovingTabIndex, type RovingKey } from './rovingIndex';

export { useRovingSelection, type RovingItemProps, type RovingSelection } from './useRovingSelection';

export type { CanvasPoint, MapSide, NormalizedPoint, WorldPoint } from './types';
