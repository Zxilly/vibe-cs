/*
 * Domain layer, 2 of 3 — `domain/map/` geometry primitives.
 *
 * Three coordinate spaces meet in this directory and mixing them up is the
 * single most likely bug, so each one has its own named type even though all
 * three are `{ x, y }`:
 *
 *   WorldPoint       CS2 world space, Hammer units. What the demo parser and
 *                    every backend record speak. x grows east, y grows north.
 *   NormalizedPoint  The overview image's unit square, [0,1]². y grows *down*,
 *                    because that is how the radar artwork is authored. This
 *                    is the only space that is independent of both the map and
 *                    the widget size, so it is where binning happens.
 *   CanvasPoint      SVG user units inside `MapCanvas`'s viewBox. At natural
 *                    size one unit is one CSS pixel; the viewBox lets the same
 *                    numbers survive any rendered width.
 *
 * A `WorldPoint` deliberately has no `z`. Height is a *floor* in this product
 * — the artboard's 楼层 control is a two-way segment (地面 / 高层), not a
 * continuous axis — so it travels as the integer `floor` on the records that
 * have one, matching `HeatPointRecord.floor` in the desktop DTO.
 */

/** A point in CS2 world space, in Hammer units. */
export interface WorldPoint {
  readonly x: number;
  readonly y: number;
}

/** A point in the overview image's unit square. `y` grows downward. */
export interface NormalizedPoint {
  readonly x: number;
  readonly y: number;
}

/** A point in `MapCanvas`'s SVG user space. */
export interface CanvasPoint {
  readonly x: number;
  readonly y: number;
}

/**
 * Which side a player was on. Mirrors `HeatPointRecord.side` in the desktop
 * DTO (`'T' | 'CT' | null`) so a page can forward the field without mapping;
 * the null case is spelled by the property being optional at each use site.
 */
export type MapSide = 'T' | 'CT';
