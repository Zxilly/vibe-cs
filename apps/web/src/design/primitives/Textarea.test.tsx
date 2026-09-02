import { describe, expect, it } from 'vitest';

import { renderMarkup } from '../../test/render';
import { Textarea } from './Textarea';

describe('Textarea markup', () => {
  it('shares Input’s box', () => {
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

  /*
   * The same contract `Button` carries, and it matters here for the same
   * reason it mattered there: the Agent composer wrote its reason to the
   * native `title`, and a disabled control shows none — it receives no pointer
   * events at all.
   */
  it('routes a disabled reason to both a screen reader and a pointer', () => {
    const html = renderMarkup(
      <Textarea aria-label="镜头意图" disabled disabledReason="本地服务离线" />,
    );

    expect(html).toContain('aria-describedby');
    expect(html).toContain('暂时不能输入：本地服务离线');
    // The wrapper the tooltip hangs on, focusable so the keyboard reaches it.
    expect(html).toContain('tabindex="0"');
    // And never the attribute that showed nothing.
    expect(html).not.toContain('title=');
  });

  it('adds nothing when there is no reason to give', () => {
    const html = renderMarkup(<Textarea aria-label="镜头意图" />);

    expect(html).toMatch(/^<textarea/u);
    expect(html).not.toContain('aria-describedby');
    expect(html).not.toContain('sr-only');
  });

  it('carries no bare hex', () => {
    expect(renderMarkup(<Textarea aria-label="x" />)).not.toMatch(/#[0-9a-f]{3,8}/iu);
  });
});
