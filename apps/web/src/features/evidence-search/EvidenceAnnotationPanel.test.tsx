import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import type { EvidenceAnnotation, EvidenceSearchItem } from '../../shared/desktop/dto';
import {
  arbitrateEvidenceAnnotationRequests,
  completeEvidenceAnnotationMutation,
  EvidenceAnnotationPanel,
  EvidenceAnnotationRecord,
  evidenceAnnotationUpdate,
} from './EvidenceAnnotationPanel';

const item: EvidenceSearchItem = {
  evidence_id: 'demo:demo-1/event:kill-7',
  demo_id: 'demo-1',
  demo_display_name: 'Major M1',
  map_name: 'de_mirage',
  match_date: null,
  round: 7,
  tick: 42_000,
  end_tick: 42_000,
  event_type: 'kill',
  actor_id: 'fallen',
  actor_name: 'FalleN',
  target_id: 'target',
  target_name: 'Target',
  weapon: 'awp',
  headshot: false,
  penetrated: false,
  source_kind: 'event',
  source_id: 'kill-7',
  attributes: {},
  analysis_href: '/analysis?demo=demo-1',
  replay_href: '/analysis?demo=demo-1&tab=replay',
};

const annotation: EvidenceAnnotation = {
  id: 'annotation-1',
  demo_id: item.demo_id,
  evidence_id: item.evidence_id,
  round: item.round,
  tick: item.tick,
  body: 'Hold the crossfire',
  tags: ['retake'],
  review_state: 'open',
  created_at: '2026-08-13T04:00:00Z',
  updated_at: '2026-08-13T04:05:00Z',
};

const recordCallbacks = {
  onBeginEdit: () => undefined,
  onChangeDraft: () => undefined,
  onSubmitEdit: () => undefined,
  onCancelEdit: () => undefined,
  onToggleState: () => undefined,
  onRemove: () => undefined,
};

describe('evidence annotation panel', () => {
  it('anchors a review note composer to the exact evidence locator', () => {
    const markup = renderToStaticMarkup(
      <EvidenceAnnotationPanel item={item} onClose={() => undefined} onChanged={() => undefined} />,
    );

    expect(markup).toContain('role="dialog"');
    expect(markup).toContain('data-testid="evidence-annotation-panel"');
    expect(markup).toContain('data-evidence-id="demo:demo-1/event:kill-7"');
    expect(markup).toContain('R7 · tick 42,000');
    expect(markup).toContain('name="annotation-body"');
    expect(markup).toContain('name="annotation-tags"');
  });

  it('renders explicit view, edit, save, cancel, and saving states without locator inputs', () => {
    const viewing = renderToStaticMarkup(
      <EvidenceAnnotationRecord
        annotation={annotation}
        draft={null}
        pendingAction={null}
        {...recordCallbacks}
      />,
    );
    expect(viewing).toContain('data-edit-state="view"');
    expect(viewing).toContain('编辑');

    const editing = renderToStaticMarkup(
      <EvidenceAnnotationRecord
        annotation={annotation}
        draft={{ body: 'Updated review', tags: 'retake, utility' }}
        pendingAction={null}
        {...recordCallbacks}
      />,
    );
    expect(editing).toContain('data-edit-state="editing"');
    expect(editing).toContain('name="annotation-edit-body"');
    expect(editing).toContain('name="annotation-edit-tags"');
    expect(editing).toContain('保存修改');
    expect(editing).toContain('取消');
    expect(editing).not.toContain('name="demo_id"');
    expect(editing).not.toContain('name="evidence_id"');
    expect(editing).not.toContain('name="round"');
    expect(editing).not.toContain('name="tick"');

    const saving = renderToStaticMarkup(
      <EvidenceAnnotationRecord
        annotation={annotation}
        draft={{ body: 'Updated review', tags: 'retake, utility' }}
        pendingAction={{ kind: 'edit', annotationId: annotation.id }}
        {...recordCallbacks}
      />,
    );
    expect(saving).toContain('data-action-state="saving"');
    expect(saving).toContain('正在保存…');
  });

  it('builds an edit mutation from mutable review fields only', () => {
    const update = evidenceAnnotationUpdate(annotation, {
      body: 'Updated review',
      tags: ' retake, utility ',
    });

    expect(update).toEqual({
      body: 'Updated review',
      tags: ['retake', 'utility'],
      review_state: 'open',
    });
    expect(update).not.toHaveProperty('demo_id');
    expect(update).not.toHaveProperty('evidence_id');
    expect(update).not.toHaveProperty('round');
    expect(update).not.toHaveProperty('tick');
  });

  it('rejects an older annotation response after a successful mutation', async () => {
    let resolveList: ((page: { items: EvidenceAnnotation[] }) => void) | undefined;
    const oldList = new Promise<{ items: EvidenceAnnotation[] }>((resolve) => {
      resolveList = resolve;
    });
    const requests = arbitrateEvidenceAnnotationRequests();
    const request = requests.acceptCurrentList(oldList);
    requests.mutationSucceeded();
    resolveList?.({ items: [annotation] });

    await expect(request).resolves.toBeNull();
  });

  it('refreshes the owning summary after a delayed mutation persists even when the drawer closed earlier', async () => {
    let resolveMutation: ((value: EvidenceAnnotation) => void) | undefined;
    let persistedAnnotations: EvidenceAnnotation[] = [];
    let parentSummary = 0;
    let parentRefreshes = 0;
    const mutation = new Promise<EvidenceAnnotation>((resolve) => {
      resolveMutation = resolve;
    });
    const refreshParentSummary = () => {
      parentRefreshes += 1;
      parentSummary = persistedAnnotations.length;
    };

    const completion = completeEvidenceAnnotationMutation(
      mutation,
      (persisted) => {
        persistedAnnotations = [persisted];
      },
      refreshParentSummary,
    );

    refreshParentSummary(); // The drawer closes and the old close-time refresh wins the race.
    expect(parentSummary).toBe(0);
    expect(parentRefreshes).toBe(1);

    resolveMutation?.(annotation);
    await completion;

    expect(parentSummary).toBe(1);
    expect(parentRefreshes).toBe(2);
  });
});
