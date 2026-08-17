import { describe, expect, it } from 'vitest';

import { renderMarkup } from '../../test/render';
import { Kbd, KbdGroup } from './Kbd';

describe('Kbd markup', () => {
  it('is a kbd element in the reference chip', () => {
    const html = renderMarkup(<Kbd>ESC</Kbd>);

    expect(html).toMatch(/^<kbd/u);
    expect(html).toContain('border-divider');
    expect(html).toContain('text-2xs');
    expect(html).toContain('font-mono');
    // --radius-* is 0 system-wide; a rounded key would be an invention.
    expect(html).not.toContain('rounded');
  });

  /* A key chip beside a labelled control repeats what the control already
     says — 「关闭抽屉」 covers Esc — so it is decoration by default. */
  it('is hidden from assistive technology unless the caller says otherwise', () => {
    expect(renderMarkup(<Kbd>ESC</Kbd>)).toContain('aria-hidden="true"');
    expect(renderMarkup(<Kbd aria-hidden={false}>ESC</Kbd>)).toContain('aria-hidden="false"');
  });

  it('groups the keys of a chord', () => {
    const html = renderMarkup(
      <KbdGroup>
        <Kbd>⌘</Kbd>
        <Kbd>↵</Kbd>
      </KbdGroup>,
    );

    expect(html.match(/<kbd/gu)).toHaveLength(2);
    expect(html).toContain('inline-flex items-center gap-1');
  });

  it('carries no bare hex', () => {
    expect(renderMarkup(<Kbd>CTRL K</Kbd>)).not.toMatch(/#[0-9a-f]{3,8}/iu);
  });
});
