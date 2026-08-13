import type { HeatPointRecord } from '../../shared/desktop/dto';
import { worldPointsToRadarPercent, type RadarTransform } from '../../shared/radar';
import type { AnalysisNavigationPatch } from './analysisNavigation';
import { worldPointsBounds, worldPointsToRelativePercent } from './replayCoordinates';

export type HeatmapMode = 'all' | 'kills' | 'deaths' | 'movement' | 'utility';
export type HeatmapSide = 'all' | 'T' | 'CT';

export type HeatmapFilter = Readonly<{
  mode: HeatmapMode;
  floor: number | null;
  side: HeatmapSide;
  playerId: string | null;
  round: number | null;
}>;

export type HeatmapEvidenceIntent = Readonly<{
  evidenceId: string | null;
  watch: { start_tick: number };
  round: AnalysisNavigationPatch | null;
  replay: AnalysisNavigationPatch | null;
}>;

const utilityKinds = new Set(['grenade', 'bombplant', 'bombdefuse', 'bombexplode']);

export function filterHeatmapPoints(
  points: readonly HeatPointRecord[],
  filter: HeatmapFilter,
): HeatPointRecord[] {
  return points.filter((point) => {
    const evidenceKind = (point.event_kind ?? point.kind).trim().toLocaleLowerCase();
    const matchesMode = filter.mode === 'all'
      || (filter.mode === 'kills' && evidenceKind === 'kill')
      || (filter.mode === 'deaths' && evidenceKind === 'death')
      || (filter.mode === 'movement' && evidenceKind === 'movement')
      || (filter.mode === 'utility' && utilityKinds.has(evidenceKind));
    return matchesMode
      && (filter.floor === null || point.floor === filter.floor)
      && (filter.side === 'all' || point.side === filter.side)
      && (filter.playerId === null || point.player_id === filter.playerId)
      && (filter.round === null || point.round === filter.round);
  });
}

function eventEvidenceId(demoId: string, pointId: string): string | null {
  const sourceEventId = /^round:[^/]+\/event:([^/]+)\//u.exec(pointId)?.[1];
  return sourceEventId ? `demo:${demoId}/event:${sourceEventId}` : null;
}

/**
 * Builds only actions supported by the point's persisted round/tick/player
 * evidence. Frame-only movement points deliberately do not claim an event ID.
 */
export function heatmapEvidenceIntent(
  demoId: string,
  point: HeatPointRecord,
): HeatmapEvidenceIntent {
  const evidenceId = eventEvidenceId(demoId, point.id);
  const hasRound = Number.isSafeInteger(point.round) && (point.round ?? 0) > 0;
  const scopedNavigation = hasRound
    ? {
        round: point.round as number,
        tick: point.tick,
        playerId: point.player_id ?? null,
        evidenceId,
      }
    : null;
  return {
    evidenceId,
    watch: { start_tick: point.tick },
    round: scopedNavigation ? { tab: 'rounds', ...scopedNavigation } : null,
    replay: scopedNavigation ? { tab: 'replay', ...scopedNavigation } : null,
  };
}

export function nextHeatmapPointIndex(
  pointCount: number,
  currentIndex: number,
  direction: -1 | 1,
): number {
  if (pointCount <= 0) return 0;
  const boundedCurrent = Math.max(0, Math.min(pointCount - 1, currentIndex));
  return (boundedCurrent + direction + pointCount) % pointCount;
}

export function summarizeHeatmapPoints(points: readonly HeatPointRecord[]): {
  floorCount: number;
  kinds: Array<{ kind: string; count: number }>;
} {
  const counts = new Map<string, number>();
  points.forEach((point) => {
    const kind = (point.event_kind ?? point.kind).trim().toLocaleLowerCase();
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
  });
  return {
    floorCount: new Set(points.map((point) => point.floor)).size,
    kinds: [...counts.entries()]
      .map(([kind, count]) => ({ kind, count }))
      .sort((left, right) => right.count - left.count || left.kind.localeCompare(right.kind)),
  };
}

export function projectHeatmapPoints(
  allPoints: readonly HeatPointRecord[],
  visiblePoints: readonly HeatPointRecord[],
  radarTransform: RadarTransform | null,
): Map<string, [number, number]> {
  const allWorldPoints = allPoints.map((point) => [point.x, point.y] as const);
  const visibleWorldPoints = visiblePoints.map((point) => [point.x, point.y] as const);
  const coordinates = worldPointsToRadarPercent(visibleWorldPoints, radarTransform)
    ?? worldPointsToRelativePercent(visibleWorldPoints, worldPointsBounds(allWorldPoints));
  return new Map(visiblePoints.map((point, index) => [point.id, coordinates[index] ?? [50, 50]]));
}
