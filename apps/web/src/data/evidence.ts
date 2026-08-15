/**
 * data layer — evidence search and annotations (spec §2 `data/evidence.ts`).
 *
 * Feeds `/evidence` with its two views (`?view=evidence|annotations`, §7) and
 * the evidence rail inside the match workspace.
 *
 * Reads only. The annotation writes (create / update / delete) are built in
 * phase 3d with the annotation editor; `invalidateEvidenceAnnotations` is
 * already here so that when they arrive there is one target to point at rather
 * than a new key literal.
 */

import { useQuery, type QueryClient } from '@tanstack/react-query';

import type { EvidenceAnnotationQuery, EvidenceSearchQuery } from '../shared/desktop/dto';
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

/* ── invalidation ────────────────────────────────────────────────────────── */

/** Search results and annotations both. Use after an analysis completes. */
export function invalidateEvidence(client: QueryClient): Promise<void> {
  return client.invalidateQueries({ queryKey: qk.evidence.all });
}

/** Annotations only; the search index is untouched by an annotation write. */
export function invalidateEvidenceAnnotations(client: QueryClient): Promise<void> {
  return client.invalidateQueries({ queryKey: qk.evidence.annotationsAll });
}
