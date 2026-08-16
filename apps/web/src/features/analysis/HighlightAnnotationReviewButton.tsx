import { MessageSquareText } from 'lucide-react';

import type { AnalysisWorkspace, Highlight } from '../../shared/desktop/viewModels';
import { useI18n } from '../../shared/i18n';
import { Badge, Button } from '../../shared/ui';
import {
  canonicalHighlightAnnotationItem,
  type HighlightAnnotationSummary,
} from './highlightAnnotationReview';

export type HighlightAnnotationReviewButtonProps = {
  workspace: AnalysisWorkspace;
  highlight: Highlight;
  summary?: HighlightAnnotationSummary;
  loading?: boolean;
  unavailable?: boolean;
  onOpen: () => void;
};

export function HighlightAnnotationReviewButton({
  workspace,
  highlight,
  summary = { total: 0, open: 0, resolved: 0 },
  loading = false,
  unavailable = false,
  onOpen,
}: HighlightAnnotationReviewButtonProps) {
  const { t } = useI18n();
  const item = canonicalHighlightAnnotationItem(workspace, highlight);
  const state = unavailable ? 'unavailable' : summary.open > 0 ? 'open' : summary.total > 0 ? 'resolved' : 'none';
  const annotationCount = `${summary.total} ${t('evidenceSearch.annotations')}`;
  const label = unavailable
    ? t('evidenceSearch.annotationsUnavailable')
    : loading
    ? t('evidenceSearch.annotationsLoading')
    : summary.open > 0
      ? `${summary.open} ${t('evidenceSearch.reviewOpen')}`
      : summary.total > 0
        ? t('evidenceSearch.reviewResolved')
        : t('evidenceSearch.saveAnnotation');

  return (
    <Button
      size="sm"
      variant="ghost"
      data-action="review-annotations"
      data-evidence-id={item?.evidence_id}
      data-review-state={state}
      disabled={!item}
      title={item
        ? loading || unavailable ? label : `${annotationCount} · ${label}`
        : t('analysis.roundContext.unavailable')}
      onClick={onOpen}
    >
      <MessageSquareText size={13} />
      <span>{label}</span>
      {!loading && !unavailable && summary.total > 0 ? <Badge tone={summary.open > 0 ? 'warning' : 'success'}>{annotationCount}</Badge> : null}
    </Button>
  );
}
