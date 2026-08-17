import { describe, expect, it } from 'vitest';

import { renderMarkup } from '../../test/render';
import { Textarea } from './Textarea';

describe('Textarea markup', () => {
  it('shares TextInput’s box', () => {
    const html = renderMarkup(<Textarea aria-label="镜头意图" />);

    expect(html).toMatch(/^<textarea/u);
    expect(html).toContain('border-divider');
    expect(html).toContain('focus:border-accent');
    expect(html).toContain('caret-accent');
  });

  /* The composer sits in a column whose height is already decided, and a drag
     there would push the send button out of the panel. */
  it('resizes vertically by default and not at all when told', () => {
    expect(renderMarkup(<Textarea aria-label="x" />)).toContain('resize-y');

    const fixed = renderMarkup(<Textarea aria-label="x" resize="none" />);
    expect(fixed).toContain('resize-none');
    expect(fixed).not.toContain('resize-y');
  });

  it('outlines with fail and says so when invalid', () => {
    const html = renderMarkup(<Textarea aria-label="x" invalid />);
    expect(html).toContain('border-fail');
    expect(html).toContain('aria-invalid="true"');
  });

  it('carries no bare hex', () => {
    expect(renderMarkup(<Textarea aria-label="x" />)).not.toMatch(/#[0-9a-f]{3,8}/iu);
  });
});
