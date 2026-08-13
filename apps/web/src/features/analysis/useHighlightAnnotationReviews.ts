import { useEffect, useMemo, useRef, useState } from 'react';

import { commands, readableError } from '../../shared/desktop/client';
import type { AnalysisWorkspace, EvidenceAnnotation } from '../../shared/desktop/dto';
import {
  canonicalHighlightAnnotationItem,
  createHighlightAnnotationReviewState,
  highlightAnnotationSummary,
  loadHighlightAnnotationReviews,
  type HighlightAnnotationSummary,
} from './highlightAnnotationReview';

type HighlightAnnotationReviewLoadState =
  | { status: 'loading'; annotations: EvidenceAnnotation[]; error: null }
  | { status: 'ready'; annotations: EvidenceAnnotation[]; error: null }
  | { status: 'error'; annotations: EvidenceAnnotation[]; error: string };

export function useHighlightAnnotationReviews(
  workspace: AnalysisWorkspace,
  refreshVersion: number,
): {
  status: HighlightAnnotationReviewLoadState['status'];
  summaries: Map<string, HighlightAnnotationSummary>;
  error: string | null;
} {
  const [state, setState] = useState<HighlightAnnotationReviewLoadState>({
    status: 'loading', annotations: [], error: null,
  });
  const requests = useRef(createHighlightAnnotationReviewState()).current;
  const requestKey = `${workspace.demo_id}:${refreshVersion}`;

  useEffect(() => {
    requests.select(requestKey);
    if (!workspace.demo_id || workspace.highlights.length === 0) {
      setState({ status: 'ready', annotations: [], error: null });
      return undefined;
    }
    const controller = new AbortController();
    setState({ status: 'loading', annotations: [], error: null });
    void requests
      .acceptCurrent(
        requestKey,
        loadHighlightAnnotationReviews(commands, workspace.demo_id, controller.signal),
      )
      .then((annotations) => {
        if (annotations !== null) {
          setState({ status: 'ready', annotations, error: null });
        }
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) {
          setState({ status: 'error', annotations: [], error: readableError(cause) });
        }
      });
    return () => {
      controller.abort();
      requests.select(null);
    };
  }, [refreshVersion, requestKey, requests, workspace.demo_id, workspace.highlights]);

  const summaries = useMemo(() => {
    const next = new Map<string, HighlightAnnotationSummary>();
    for (const highlight of workspace.highlights) {
      const item = canonicalHighlightAnnotationItem(workspace, highlight);
      if (item) next.set(item.evidence_id, highlightAnnotationSummary(item, state.annotations));
    }
    return next;
  }, [state.annotations, workspace]);

  return { status: state.status, summaries, error: state.error };
}
