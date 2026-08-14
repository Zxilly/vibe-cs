import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import type { ReviewTag } from '../../shared/desktop/dto';
import { ReviewMetadataForm } from './ReviewMetadataPanel';

const tag: ReviewTag = {
  id: '44444444-4444-4444-8444-444444444444',
  name: 'Review',
  color: '#dc2626',
  created_at: '2026-08-14T01:00:00Z',
  updated_at: '2026-08-14T01:00:00Z',
};

describe('ReviewMetadataForm', () => {
  it('renders a generic Comment / Tags editor without calling it evidence annotation', () => {
    const markup = renderToStaticMarkup(<ReviewMetadataForm
      title="Player comment / tags"
      description="Bound to exact Steam64"
      comment="Hold B"
      selectedTagIds={new Set([tag.id])}
      tags={[tag]}
      dirty
      saving={false}
      onCommentChange={() => undefined}
      onToggleTag={() => undefined}
      onSave={() => undefined}
    />);

    expect(markup).toContain('Player comment / tags');
    expect(markup).toContain('Hold B');
    expect(markup).toContain('checked=""');
    expect(markup).not.toContain('Evidence Annotation');
    expect(markup).toContain('不属于事件证据批注');
  });

  it('locks the draft while an exact save is in flight', () => {
    const markup = renderToStaticMarkup(<ReviewMetadataForm
      title="Round comment / tags"
      description="Bound to exact source"
      comment="Hold"
      selectedTagIds={new Set()}
      tags={[tag]}
      dirty
      saving
      onCommentChange={() => undefined}
      onToggleTag={() => undefined}
      onSave={() => undefined}
    />);
    expect(markup).toMatch(/<textarea[^>]*disabled=""/);
    expect(markup).toMatch(/<input[^>]*type="checkbox"[^>]*disabled=""/);
  });
});
