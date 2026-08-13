import type { AnalysisWorkspace, Highlight } from '../../shared/desktop/dto';
import { EvidenceAnnotationPanel } from '../evidence-search/EvidenceAnnotationPanel';
import { HighlightAnnotationReviewButton } from './HighlightAnnotationReviewButton';
import {
  canonicalHighlightAnnotationItem,
  type HighlightAnnotationSummary,
} from './highlightAnnotationReview';
import './HighlightAnnotationReviewControl.css';

export function HighlightAnnotationReviewControl({
  workspace,
  highlight,
  open,
  summary,
  loading = false,
  unavailable = false,
  onOpen,
  onClose,
  onChanged,
}: {
  workspace: AnalysisWorkspace;
  highlight: Highlight;
  open: boolean;
  summary: HighlightAnnotationSummary;
  loading?: boolean;
  unavailable?: boolean;
  onOpen: () => void;
  onClose: () => void;
  onChanged: () => void;
}) {
  const item = canonicalHighlightAnnotationItem(workspace, highlight);
  return (
    <>
      <HighlightAnnotationReviewButton
        workspace={workspace}
        highlight={highlight}
        summary={summary}
        loading={loading}
        unavailable={unavailable}
        onOpen={onOpen}
      />
      {open && item ? <EvidenceAnnotationPanel item={item} onClose={onClose} onChanged={onChanged} /> : null}
    </>
  );
}
