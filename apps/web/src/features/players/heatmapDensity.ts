import type { PlayerHeatmapKind } from '../../shared/desktop/dto';

export type HeatmapDensityPoint = {
  evidenceId: string;
  kind: PlayerHeatmapKind;
  xPercent: number;
  yPercent: number;
};

export type HeatmapDensityCell = {
  key: string;
  column: number;
  row: number;
  kills: number;
  deaths: number;
  count: number;
  evidenceIds: string[];
};

export const heatmapDensityDivisions = 12;

export function aggregateHeatmapDensity(
  points: readonly HeatmapDensityPoint[],
  divisions = heatmapDensityDivisions,
): { cells: HeatmapDensityCell[]; maximum: number } {
  if (!Number.isInteger(divisions) || divisions < 2 || divisions > 32) {
    throw new Error('Heatmap density divisions are outside the supported range');
  }
  const cells = new Map<string, HeatmapDensityCell>();
  for (const point of points) {
    if (
      !Number.isFinite(point.xPercent)
      || !Number.isFinite(point.yPercent)
      || point.xPercent < 0
      || point.xPercent > 100
      || point.yPercent < 0
      || point.yPercent > 100
    ) throw new Error('Heatmap density coordinate is outside the verified plane');
    const column = Math.min(divisions - 1, Math.floor((point.xPercent / 100) * divisions));
    const row = Math.min(divisions - 1, Math.floor((point.yPercent / 100) * divisions));
    const key = `${column}:${row}`;
    const cell = cells.get(key) ?? {
      key,
      column,
      row,
      kills: 0,
      deaths: 0,
      count: 0,
      evidenceIds: [],
    };
    cell.count += 1;
    cell[point.kind] += 1;
    cell.evidenceIds.push(point.evidenceId);
    cells.set(key, cell);
  }
  const ordered = [...cells.values()].sort((left, right) => left.row - right.row || left.column - right.column);
  return {
    cells: ordered,
    maximum: ordered.reduce((maximum, cell) => Math.max(maximum, cell.count), 0),
  };
}
