export function selectedRoundGroupId(
  groupIds: readonly string[],
  requestedGroupId: string | null,
  focusedGroupId: string | null,
): string | null {
  if (requestedGroupId && groupIds.includes(requestedGroupId)) return requestedGroupId;
  if (focusedGroupId && groupIds.includes(focusedGroupId)) return focusedGroupId;
  return groupIds[0] ?? null;
}

export function evidenceRangeGroupId(
  groups: readonly {
    id: string;
    startTick: number;
    endTick: number;
    actorIds: readonly string[];
  }[],
  startTick: number,
  endTick: number,
  actorId: string | null,
): string | null {
  const overlapping = groups.filter((group) => (
    group.endTick >= startTick && group.startTick <= endTick
  ));
  if (actorId) {
    const actorGroup = overlapping.find((group) => group.actorIds.includes(actorId));
    if (actorGroup) return actorGroup.id;
  }
  return overlapping[0]?.id ?? null;
}

export function selectedGroupScrollTop(
  scrollTop: number,
  viewportHeight: number,
  groupTop: number,
  groupHeight: number,
  margin = 8,
): number {
  const visibleTop = scrollTop + margin;
  const visibleBottom = scrollTop + viewportHeight - margin;
  if (groupTop < visibleTop || groupTop >= visibleBottom) return Math.max(0, groupTop - margin);
  if (groupHeight > viewportHeight - (margin * 2)) return scrollTop;
  const groupBottom = groupTop + groupHeight;
  return groupBottom > visibleBottom
    ? Math.max(0, groupBottom - viewportHeight + margin)
    : scrollTop;
}

export function roundNumberFromNavigationKey(
  roundNumbers: readonly number[],
  currentRound: number,
  key: string,
): number | null {
  if (roundNumbers.length === 0) return null;
  if (key === 'Home') return roundNumbers[0] ?? null;
  if (key === 'End') return roundNumbers.at(-1) ?? null;
  if (key !== 'ArrowLeft' && key !== 'ArrowRight') return null;
  const currentIndex = Math.max(0, roundNumbers.indexOf(currentRound));
  const nextIndex = key === 'ArrowLeft'
    ? Math.max(0, currentIndex - 1)
    : Math.min(roundNumbers.length - 1, currentIndex + 1);
  return roundNumbers[nextIndex] ?? null;
}

export function roundSectionIsVisible(
  sectionKind: 'encounters' | 'objective' | 'utility' | 'economy' | 'other',
  groupCount: number,
  filter: 'all' | 'combat' | 'objectives' | 'utility' | 'economy',
): boolean {
  if (groupCount <= 0) return false;
  if (filter === 'all') return true;
  if (filter === 'combat') return sectionKind === 'encounters';
  if (filter === 'objectives') return sectionKind === 'objective';
  return sectionKind === filter;
}

export function roundTickPercent(tick: number, startTick: number, endTick: number): number {
  const span = endTick - startTick;
  if (!Number.isFinite(tick) || !Number.isFinite(span) || span <= 0) return 0;
  return Math.min(100, Math.max(0, ((tick - startTick) / span) * 100));
}

export function tickDurationLabel(startTick: number, endTick: number, tickRate: number): string {
  if (!Number.isFinite(tickRate) || tickRate <= 0) return '—';
  const seconds = Math.max(0, endTick - startTick) / tickRate;
  return seconds < 10 ? `${seconds.toFixed(1)}s` : `${Math.round(seconds)}s`;
}
