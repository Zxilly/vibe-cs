import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';

import type { EvidenceAnnotation } from '../../shared/desktop/dto';
import {
  EvidenceAnnotationIndexPage,
  EvidenceAnnotationIndexResults,
} from './EvidenceAnnotationIndexPage';

const annotation: EvidenceAnnotation = {
  id: 'annotation-1',
  demo_id: 'major-final-map-1',
  evidence_id: 'demo:major-final-map-1/event:kill-160986',
  round: 20,
  tick: 160_986,
  body: 'Review the late B retake.',
  tags: ['Retake', 'Utility'],
  review_state: 'open',
  created_at: '2026-06-22T18:00:00Z',
  updated_at: '2026-06-22T18:05:00Z',
};

describe('evidence annotation index', () => {
  it('renders persisted annotation truth and canonical analysis links', () => {
    const markup = renderToStaticMarkup(
      <MemoryRouter>
        <EvidenceAnnotationIndexResults
          page={{ items: [annotation], total: 51, page: 2, page_size: 50 }}
          onPage={() => undefined}
        />
      </MemoryRouter>,
    );

    expect(markup).toContain('data-testid="evidence-annotation-index-results"');
    expect(markup).toContain('data-annotation-id="annotation-1"');
    expect(markup).toContain('Review the late B retake.');
    expect(markup).toContain('Retake');
    expect(markup).toContain('major-final-map-1');
    expect(markup).toContain('R20');
    expect(markup).toContain('tick 160,986');
    expect(markup).toContain('href="/analysis?demo=major-final-map-1&amp;tab=rounds&amp;round=20&amp;tick=160986&amp;evidence=demo%3Amajor-final-map-1%2Fevent%3Akill-160986"');
    expect(markup).toContain('href="/analysis?demo=major-final-map-1&amp;tab=replay');
    expect(markup).toContain('>2</strong> / 2');
  });

  it('restores q, tag, and state filters from the annotation index URL', () => {
    const markup = renderToStaticMarkup(
      <MemoryRouter initialEntries={['/evidence-search?view=annotations&q=late%20retake&tag=Utility&state=resolved&page=2&page_size=25']}>
        <EvidenceAnnotationIndexPage />
      </MemoryRouter>,
    );

    expect(markup).toContain('data-testid="evidence-annotation-index-page"');
    expect(markup).toContain('data-testid="evidence-annotation-index-filters"');
    expect(markup).toContain('data-testid="evidence-annotation-index-workspace"');
    expect(markup).toContain('name="annotation-q"');
    expect(markup).toContain('value="late retake"');
    expect(markup).toContain('name="annotation-tag"');
    expect(markup).toContain('value="Utility"');
    expect(markup).toContain('value="resolved" selected=""');
    expect(markup).toContain('aria-busy="true"');
  });

  it('fails closed visibly instead of loading an aliased annotation URL', () => {
    const markup = renderToStaticMarkup(
      <MemoryRouter initialEntries={['/evidence-search?view=annotations&review_state=resolved']}>
        <EvidenceAnnotationIndexPage />
      </MemoryRouter>,
    );

    expect(markup).toContain('Unknown annotation index parameter &quot;review_state&quot;.');
    expect(markup).toContain('aria-busy="false"');
    expect(markup).not.toContain('正在读取持久注释');
  });
});
