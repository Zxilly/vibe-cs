const SEQUENCE_TABS_KEY = 'vibe-cs:sequence-tabs:v1';
const MAXIMUM_SEQUENCE_TABS = 20;

export function readSequenceTabs(storage: Pick<Storage, 'getItem'>): string[] {
  const raw = storage.getItem(SEQUENCE_TABS_KEY);
  if (raw === null) return [];
  try {
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value)
      || value.length > MAXIMUM_SEQUENCE_TABS
      || value.some((id) => typeof id !== 'string' || id.trim() === '')) return [];
    return [...new Set(value)];
  } catch { return []; }
}

export function openSequenceTab(current: readonly string[], projectId: string): string[] {
  if (current.includes(projectId)) return [...current];
  return [...current.slice(-(MAXIMUM_SEQUENCE_TABS - 1)), projectId];
}

export function retainAvailableSequenceTabs(
  current: readonly string[],
  availableProjectIds: ReadonlySet<string>,
): string[] {
  return current.filter((projectId) => availableProjectIds.has(projectId));
}

export function closeSequenceTab(
  current: readonly string[],
  projectId: string,
): { readonly tabs: string[]; readonly nextActiveId: string | null } {
  const index = current.indexOf(projectId);
  if (index < 0) return { tabs: [...current], nextActiveId: current.at(-1) ?? null };
  const tabs = current.filter((id) => id !== projectId);
  return { tabs, nextActiveId: tabs[Math.min(index, tabs.length - 1)] ?? null };
}

export function writeSequenceTabs(storage: Pick<Storage, 'setItem' | 'removeItem'>, tabs: readonly string[]): void {
  if (tabs.length === 0) storage.removeItem(SEQUENCE_TABS_KEY);
  else storage.setItem(SEQUENCE_TABS_KEY, JSON.stringify(tabs.slice(-MAXIMUM_SEQUENCE_TABS)));
}
