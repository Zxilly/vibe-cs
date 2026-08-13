import type { DemoRecord } from '../../shared/desktop/dto';

export function isDemoAnalyzable(status: DemoRecord['status']): boolean {
  return status === 'discovered' || status === 'failed';
}

export function retainLibraryPageSelection(
  selectedIds: ReadonlySet<string>,
  pageIds: readonly string[],
): Set<string> {
  const available = new Set(pageIds);
  return new Set([...selectedIds].filter((id) => available.has(id)));
}
