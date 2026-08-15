/*
 * Design system, layer 1 of 3 — multi-track timeline prototype (spec §0.5).
 *
 * One helper, so every component writes its geometry through the same door.
 *
 * The timeline positions everything by arithmetic on CSS custom properties
 * (see the header of `./timeline.css`): React writes numbers, the stylesheet
 * multiplies them by `--tl-pps` and appends the unit. That means a `style`
 * object whose keys are `--tl-*` and whose values are bare numbers, which
 * `CSSProperties` does not describe — hence the one cast, kept in a single
 * place rather than repeated at every call site.
 *
 * React does not append `px` to custom properties, so `{'--tl-t0': 42}` reaches
 * CSS as the unitless `42` the `calc()` needs.
 */

import type { CSSProperties } from 'react';

export type TimelineVars = Record<`--tl-${string}`, number | string>;

export function timelineStyle(vars: TimelineVars, base?: CSSProperties): CSSProperties {
  return { ...base, ...vars } as CSSProperties;
}
