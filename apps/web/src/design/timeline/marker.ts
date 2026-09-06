import { timeToPx, type TimeScale } from './timeScale';

/** Persisted default used by the timeline marker colour control. */
export const DEFAULT_TIMELINE_MARKER_COLOR = '#2F6FED';

/** Keep dense review pins selectable without overlapping their hit targets. */
export function clusterTimelinePins<T>(
  items: readonly T[],
  timeOf: (item: T) => number,
  scale: TimeScale,
  spacing = 32,
): { left: number; items: T[] }[] {
  const groups: { left: number; items: T[] }[] = [];
  for (const item of [...items].sort((a, b) => timeOf(a) - timeOf(b))) {
    const left = timeToPx(scale, timeOf(item));
    const previous = groups.at(-1);
    if (previous && left - previous.left < spacing) previous.items.push(item);
    else groups.push({ left, items: [item] });
  }
  return groups;
}
