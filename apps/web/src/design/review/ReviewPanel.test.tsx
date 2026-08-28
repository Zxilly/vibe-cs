import { describe, expect, it } from 'vitest';

import { renderMarkup } from '../../test/render';
import { ReviewPanel } from './ReviewPanel';

describe('ReviewPanel', () => {
  it('owns the shared review surface and focus treatment', () => {
    const markup = renderMarkup(<ReviewPanel emphasis="focus">Preview</ReviewPanel>);
    expect(markup).toContain('rounded-md');
    expect(markup).toContain('border-accent-400');
    expect(markup).toContain('var(--color-accent-100)');
  });

  it('uses the neutral divider by default', () => {
    expect(renderMarkup(<ReviewPanel>Diff</ReviewPanel>)).toContain('border-divider');
  });
});
