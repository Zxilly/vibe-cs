import { describe, expect, it } from 'vitest';

import { renderMarkup } from '../../test/render';
import { InputGroup, InputGroupAddon, InputGroupInput, InputGroupText } from './InputGroup';

function search(): string {
  return renderMarkup(
    <InputGroup size="sm" ground="bg">
      <InputGroupAddon>
        <svg />
      </InputGroupAddon>
      <InputGroupInput aria-label="搜索比赛" placeholder="搜索比赛" />
    </InputGroup>,
  );
}

describe('InputGroup markup', () => {
  /* The seam this component removes: the border used to belong to the input,
     so an addon could only ever sit on top of it, in a fixed inset. */
  it('owns the border, and the input inside it does not', () => {
    const html = search();

    expect(html).toContain('border-divider');
    expect(html).toContain('focus-within:border-accent');
    expect(html).toMatch(/<input[^>]*class="[^"]*border-0/u);
  });

  it('takes its height and type step from the §3.3 tokens', () => {
    expect(search()).toContain('h-[var(--h-ctl-sm)]');
    expect(
      renderMarkup(
        <InputGroup size="md">
          <InputGroupInput aria-label="x" />
        </InputGroup>,
      ),
    ).toContain('h-[var(--h-ctl-md)]');
  });

  it('puts a trailing addon last without reordering the markup', () => {
    const html = renderMarkup(
      <InputGroup>
        <InputGroupInput aria-label="前留白" />
        <InputGroupAddon align="inline-end">
          <InputGroupText>秒</InputGroupText>
        </InputGroupAddon>
      </InputGroup>,
    );

    // The input still comes first in the DOM — the addon is ordered visually,
    // so the tab order and the reading order stay the order they were written.
    expect(html.indexOf('<input')).toBeLessThan(html.indexOf('秒'));
    expect(html).toContain('order-last');
    expect(html).toContain('data-align="inline-end"');
  });

  it('keeps a decorative addon out of the accessibility tree', () => {
    expect(search()).toMatch(/data-align="inline-start"[^>]*/u);
    expect(search()).toContain('aria-hidden="true"');
  });

  it('outlines with fail when the group is invalid', () => {
    const html = renderMarkup(
      <InputGroup invalid>
        <InputGroupInput aria-label="x" />
      </InputGroup>,
    );
    expect(html).toContain('border-fail');
  });

  it('carries no bare hex', () => {
    expect(search()).not.toMatch(/#[0-9a-f]{3,8}/iu);
  });
});
