/**
 * data layer — evidence search and annotations (spec §2 `data/evidence.ts`).
 *
 * Feeds `/evidence` with its two views (`?view=evidence|annotations`, §7) and
 * the evidence rail inside the match workspace.
 *
 * Reads only, still. The annotation writes (create / update / delete) cannot be
 * added yet: `DesktopClient` in `desktopClient.tsx` is a `Pick<typeof commands,
 * …>` that lists `searchEvidence` and `listEvidenceAnnotations` and nothing
 * else, and widening it means editing a file phase 3d does not own. See the
 * phase report — `invalidateEvidenceAnnotations` below is already the single
 * target those writes will point at, so adding them is a hook plus one line in
 * that Pick, not a new key literal.
 *
 * ## Why the availability reasoning lives here
 *
 * `EvidenceSearchResponse.availability` is a *contract* statement, not copy: it
 * says how much of the corpus is indexed, whether the scan finished, and which
 * two filters (`match_date`, `source`) the current index can actually serve.
 * Deciding what that block means is the same kind of knowledge as knowing which
 * key to invalidate, so `evidenceIndexState` and `unsupportedEvidenceFilters`
 * are here and are pure — the page turns the answer into sentences, this layer
 * never spells one.
 */

import { useQuery, type QueryClient } from '@tanstack/react-query';

import type {
  EvidenceAnnotationQuery,
  EvidenceSearchQuery,
  EvidenceSearchResponse,
} from '../shared/desktop/dto';
import { useDesktopClient } from './desktopClient';
import { qk } from './keys';
import { resolveQueryTuning, type DataQueryTuning } from './queryTuning';

/**
 * One page of search results plus the `availability` block the page needs to
 * explain a thin result set (「命中 47 条」 vs 「索引尚未建立」). The block
 * rides on the same response, so it is not a second query.
 *
 * Invalidated by: an analysis run completing — it is what puts events into the
 * index. That invalidates `qk.evidence.all`, since both the results and the
 * availability counters move.
 */
export function useEvidenceSearch(query: EvidenceSearchQuery, tuning: DataQueryTuning = {}) {
  const client = useDesktopClient();
  return useQuery({
    queryKey: qk.evidence.search(query),
    queryFn: ({ signal }) => client.searchEvidence(query, signal),
    ...resolveQueryTuning(tuning),
  });
}

/**
 * One page of annotations.
 *
 * Invalidated by: `createEvidenceAnnotation`, `updateEvidenceAnnotation`,
 * `deleteEvidenceAnnotation` → `invalidateEvidenceAnnotations`. Those do not
 * touch the search index, so they must *not* invalidate `qk.evidence.all` —
 * re-running a search after every note would be a visible cost on a page whose
 * two views sit side by side.
 */
export function useEvidenceAnnotations(
  query: EvidenceAnnotationQuery,
  tuning: DataQueryTuning = {},
) {
  const client = useDesktopClient();
  return useQuery({
    queryKey: qk.evidence.annotations(query),
    queryFn: ({ signal }) => client.listEvidenceAnnotations(query, signal),
    ...resolveQueryTuning(tuning),
  });
}

/* ── what the index can answer ───────────────────────────────────────────── */

export type EvidenceAvailability = EvidenceSearchResponse['availability'];

/**
 * How far the normalised-evidence index has got.
 *
 *   `empty`     nothing indexed at all — an empty result is the index's fault,
 *               not the query's, and the page must say so rather than suggest
 *               loosening filters that would change nothing.
 *   `partial`   some demos are indexed but the scan has not finished, so a
 *               genuine hit may simply not be in yet.
 *   `complete`  every analysed demo is in. An empty result really is an empty
 *               result, and the recovery is to widen the query.
 *
 * The three are kept apart because 「为什么搜不到」 has three different true
 * answers and only one of them is 「换个条件」.
 */
export type EvidenceIndexState = 'empty' | 'partial' | 'complete';

export function evidenceIndexState(availability: EvidenceAvailability): EvidenceIndexState {
  if (availability.indexed_items <= 0) return 'empty';
  return availability.scan_complete ? 'complete' : 'partial';
}

/** A filter the response says this index cannot serve, with the service's own
 *  reason attached. */
export interface EvidenceFilterGap {
  /** The `EvidenceSearchQuery` field that is unusable. */
  readonly field: 'match_date' | 'source';
  /** The service's explanation, when it sent one. */
  readonly reason: string | null;
  /** How many rows carry the column at all. `0` means the column is empty. */
  readonly indexedItems: number;
}

/**
 * The capability blocks the response marks unavailable — today `match_date`
 * (the 「近 30 天」 chip) and `source` (the platform chip). A page that silently
 * kept offering a filter the index cannot apply would return zero rows and
 * blame the user, which is the failure this list exists to prevent.
 *
 * Only the two blocks the DTO declares are inspected; a third would have to be
 * added to `EvidenceSearchCapability` first, and this function would fail to
 * compile until it was listed.
 */
export function unsupportedEvidenceFilters(
  availability: EvidenceAvailability,
): readonly EvidenceFilterGap[] {
  const gaps: EvidenceFilterGap[] = [];
  for (const field of ['match_date', 'source'] as const) {
    const capability = availability[field];
    if (capability.available) continue;
    gaps.push({
      field,
      reason: capability.reason,
      indexedItems: capability.indexed_items,
    });
  }
  return gaps;
}

/* ── invalidation ────────────────────────────────────────────────────────── */

/** Search results and annotations both. Use after an analysis completes. */
export function invalidateEvidence(client: QueryClient): Promise<void> {
  return client.invalidateQueries({ queryKey: qk.evidence.all });
}

/** Annotations only; the search index is untouched by an annotation write. */
export function invalidateEvidenceAnnotations(client: QueryClient): Promise<void> {
  return client.invalidateQueries({ queryKey: qk.evidence.annotationsAll });
}
