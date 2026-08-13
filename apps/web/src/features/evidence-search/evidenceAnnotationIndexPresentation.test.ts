import { describe, expect, it } from 'vitest';

import type { EvidenceAnnotation } from '../../shared/desktop/dto';
import {
  evidenceAnnotationAnalysisHref,
  evidenceAnnotationIndexParameters,
  readEvidenceAnnotationIndexParameters,
} from './evidenceAnnotationIndexPresentation';

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

describe('evidence annotation index presentation', () => {
  it('restores only the current annotation filter contract from a shareable URL', () => {
    expect(readEvidenceAnnotationIndexParameters(new URLSearchParams(
      'view=annotations&q=late%20retake&tag=Utility&state=resolved&page=2&page_size=50',
    ))).toEqual({
      status: 'ready',
      query: {
        q: 'late retake',
        tag: 'Utility',
        state: 'resolved',
        page: 2,
        page_size: 50,
      },
    });
  });

  it('fails closed when the annotation index URL is outside the exact current contract', () => {
    const invalidQueries = [
      'view=unknown',
      'view=annotations&view=annotations',
      'view=annotations&state=pending',
      'view=annotations&review_state=resolved',
      'view=annotations&q=one&q=two',
      'view=annotations&page=0',
      'view=annotations&page=100001',
      'view=annotations&page_size=101',
      'view=annotations&unknown=value',
    ];

    for (const value of invalidQueries) {
      const result = readEvidenceAnnotationIndexParameters(new URLSearchParams(value));
      expect(result.status, value).toBe('invalid');
      if (result.status === 'invalid') expect(result.error, value).not.toBe('');
    }
  });

  it('serializes a global annotation page without compatibility aliases', () => {
    expect(evidenceAnnotationIndexParameters({
      q: '  late retake ',
      tag: ' Utility ',
      state: 'open',
      page: 3,
      page_size: 25,
    }).toString()).toBe(
      'view=annotations&q=late+retake&tag=Utility&state=open&page=3&page_size=25',
    );
  });

  it('opens the exact persisted evidence locator in analysis', () => {
    expect(evidenceAnnotationAnalysisHref(annotation, 'rounds')).toBe(
      '/analysis?demo=major-final-map-1&tab=rounds&round=20&tick=160986&evidence=demo%3Amajor-final-map-1%2Fevent%3Akill-160986',
    );
    expect(evidenceAnnotationAnalysisHref(annotation, 'replay')).toContain('tab=replay');
  });
});
