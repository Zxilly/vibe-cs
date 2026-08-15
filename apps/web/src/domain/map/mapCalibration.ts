/*
 * Domain layer, 2 of 3 — `domain/map/`: the world-to-overview calibration table.
 *
 * Every CS2 map ships an overview description alongside its radar artwork
 * (`resource/overviews/<map>.txt`), three numbers of which decide where a world
 * coordinate lands on the image:
 *
 *   pos_x / pos_y   the world coordinate of the image's top-left corner
 *   scale           world units per overview pixel
 *
 * The artwork itself is 1024×1024, so those three numbers plus that constant
 * are a complete affine map from world space to the image's unit square.
 *
 * ── Where the numbers come from at runtime ───────────────────────────────────
 * The authority is the backend, not this file. `GET /api/source-assets/radar`
 * (crates/application/src/routes/source_assets.rs) reads the transform out of
 * the installed game's VPK and returns it as `RadarOverviewRecord.transform`
 * — the shape mirrored below as `OverviewTransform`. A page hands that record
 * to `MapCanvas` and this table is never consulted.
 *
 * The table is the fallback for the case the artboard's own caption admits is
 * possible — 「坐标来自本地 overview 与 VPK 雷达」 presumes a local CS2 install.
 * Without one there is no transform, and a table entry is the difference
 * between a roughly-right map and no map at all. Because a wrong calibration
 * is indistinguishable from a right one by eye, every entry carries its
 * provenance and a `confidence`, and `MapCanvas` says so on screen when it is
 * rendering with a `provisional` entry. Nothing here is allowed to look
 * authoritative just because it is checked in.
 *
 * ── What is deliberately ignored ─────────────────────────────────────────────
 * `rotate` and `zoom` are carried in the DTO and dropped here, on the same
 * reasoning `apps/web/src/shared/radar.ts` records for the existing analysis
 * page: Valve's published pos_x / pos_y / scale already describe the *final*
 * orientation of the shipped artwork, so applying a second rotation moves
 * otherwise-correct coordinates off the map. `zoom` is an authoring aid for the
 * in-game minimap, not part of the world→image transform.
 */

/**
 * The transform as the desktop bridge sends it, i.e.
 * `NonNullable<RadarOverviewRecord['transform']>`.
 *
 * Snake case on purpose: this one type is a wire shape, not a display model,
 * and re-spelling the keys would put a mapping step between the query layer and
 * this module for no gain. Everything downstream of `calibrationFromOverview`
 * is camel case again.
 */
export interface OverviewTransform {
  readonly pos_x: number;
  readonly pos_y: number;
  readonly scale: number;
  readonly rotate?: boolean;
  readonly zoom?: number | null;
}

/**
 * `verified`    the numbers are reproduced from a copy inside this repository.
 * `provisional` the numbers are the ones the community publishes for this map
 *               and there is nothing in the repository to check them against.
 *               Treat the result as approximate and say so in the UI.
 */
export type CalibrationConfidence = 'verified' | 'provisional';

/** A map's world→overview transform in the vocabulary the rest of the layer uses. */
export interface MapCalibration {
  /** `de_mirage`. Matches `AnalysisWorkspace.map_name` / `RadarOverviewRecord.map_name`. */
  readonly mapName: string;
  /** World x at the left edge of the overview image. Valve `pos_x`. */
  readonly originX: number;
  /** World y at the top edge of the overview image. Valve `pos_y`. */
  readonly originY: number;
  /** World units per overview pixel. Valve `scale`. */
  readonly unitsPerPixel: number;
  /** Edge length of the overview artwork in pixels. */
  readonly overviewSize: number;
  readonly confidence: CalibrationConfidence;
  /** Developer-facing note; never rendered. UI copy lives in the components. */
  readonly provenance: string;
}

/**
 * Valve has shipped 1024×1024 overviews since CS:GO and CS2 kept the size.
 * It is a property of the artwork, not of a map, so it is a constant rather
 * than nine copies of the same number in the table.
 */
export const OVERVIEW_IMAGE_SIZE = 1024;

/**
 * The built-in fallback table.
 *
 * Two entries, both required by the task, and no more: an entry nobody has
 * checked is worse than a missing one, because a missing one produces the
 * 「缺少这张地图的雷达标定」 state instead of a plausible wrong picture.
 */
export const MAP_CALIBRATIONS: readonly MapCalibration[] = [
  {
    mapName: 'de_mirage',
    originX: -3230,
    originY: 1713,
    unitsPerPixel: 5,
    overviewSize: OVERVIEW_IMAGE_SIZE,
    confidence: 'verified',
    provenance:
      'de_mirage.txt, reproduced twice inside this repository: the overview parser fixture ' +
      'crates/source-assets/src/overview.rs (`"de_mirage" { "pos_x" "-3230" "pos_y" "1713" ' +
      '"scale" "5" "zoom" "0" }`) and the existing player heatmap test ' +
      'apps/web/src/features/players/PlayerHeatmapWorkspace.test.tsx.',
  },
  {
    mapName: 'de_inferno',
    originX: -2087,
    originY: 3870,
    unitsPerPixel: 4.9,
    overviewSize: OVERVIEW_IMAGE_SIZE,
    confidence: 'provisional',
    provenance:
      'PLACEHOLDER — the values the community publishes for de_inferno.txt (pos_x -2087, ' +
      'pos_y 3870, scale 4.9). Nothing in this repository carries a copy of that file, so ' +
      'they are unverified here. Replace this entry the moment a checked-in fixture or a ' +
      'live `RadarOverviewRecord` disagrees; do not treat the picture it produces as evidence.',
  },
];

/**
 * Map names arrive from several places — a workspace record, a URL, a filter
 * chip — with inconsistent casing and sometimes without the `de_` prefix.
 * Normalisation is one lower-cased trim plus a single prefix guess, so
 * `Mirage`, `de_mirage` and ` DE_MIRAGE ` all find the same row and nothing
 * else does.
 */
export function normaliseMapName(mapName: string): string {
  const trimmed = mapName.trim().toLowerCase();
  if (trimmed === '') return '';
  return /^(?:de|cs|ar|dz|gd)_/u.test(trimmed) ? trimmed : `de_${trimmed}`;
}

/** The table row for a map, or `null` when the map is not in the table. */
export function findMapCalibration(mapName: string): MapCalibration | null {
  const wanted = normaliseMapName(mapName);
  if (wanted === '') return null;
  return MAP_CALIBRATIONS.find((entry) => entry.mapName === wanted) ?? null;
}

/**
 * A calibration is usable when it can be inverted: a zero or negative scale
 * collapses the whole map onto one point, and a non-finite number poisons every
 * coordinate downstream. Callers check this *before* building a projection so
 * the failure renders as a state rather than as NaN geometry.
 */
export function isUsableCalibration(calibration: MapCalibration | null | undefined): calibration is MapCalibration {
  if (!calibration) return false;
  const { originX, originY, unitsPerPixel, overviewSize } = calibration;
  if (![originX, originY, unitsPerPixel, overviewSize].every(Number.isFinite)) return false;
  return unitsPerPixel > 0 && overviewSize > 0;
}

/** Turn a live `RadarOverviewRecord.transform` into a calibration. */
export function calibrationFromOverview(
  mapName: string,
  transform: OverviewTransform | null | undefined,
): MapCalibration | null {
  if (!transform) return null;
  const candidate: MapCalibration = {
    mapName: normaliseMapName(mapName),
    originX: transform.pos_x,
    originY: transform.pos_y,
    unitsPerPixel: transform.scale,
    overviewSize: OVERVIEW_IMAGE_SIZE,
    confidence: 'verified',
    provenance: 'RadarOverviewRecord.transform, read from the installed game by the desktop bridge.',
  };
  return isUsableCalibration(candidate) ? candidate : null;
}

/**
 * The resolution order the components use: a live transform beats the built-in
 * table, the table beats nothing, and an unusable value at either level falls
 * through instead of being repaired. Returning `null` is a real answer — it is
 * what puts `MapCanvas` into its 「缺少这张地图的雷达标定」 state.
 */
export function resolveMapCalibration(
  mapName: string,
  transform?: OverviewTransform | null,
): MapCalibration | null {
  const live = calibrationFromOverview(mapName, transform);
  if (live) return live;
  const table = findMapCalibration(mapName);
  return isUsableCalibration(table) ? table : null;
}
