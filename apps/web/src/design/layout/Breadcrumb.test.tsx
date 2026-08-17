import { describe, expect, it } from 'vitest';

import { renderMarkup } from '../../test/render';
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
  BreadcrumbText,
} from './Breadcrumb';

function trail(): string {
  return renderMarkup(
    <Breadcrumb aria-label="位置">
      <BreadcrumbList>
        <BreadcrumbItem>
          <BreadcrumbText>资料库</BreadcrumbText>
        </BreadcrumbItem>
        <BreadcrumbSeparator />
        <BreadcrumbItem>
          <BreadcrumbLink href="/library">Demo 资料库</BreadcrumbLink>
        </BreadcrumbItem>
        <BreadcrumbSeparator />
        <BreadcrumbItem>
          <BreadcrumbPage>比赛工作区</BreadcrumbPage>
        </BreadcrumbItem>
      </BreadcrumbList>
    </Breadcrumb>,
  );
}

describe('Breadcrumb markup', () => {
  it('is a named nav around an ordered list', () => {
    const html = trail();

    expect(html).toMatch(/^<nav/u);
    expect(html).toContain('aria-label="位置"');
    expect(html).toContain('<ol');
    expect(html.match(/<li/gu)).toHaveLength(5); // three rungs, two separators
  });

  it('links the rungs that have somewhere to go', () => {
    expect(trail()).toContain('href="/library"');
  });

  /* A rail group is a heading in the nav, not a route. A link that goes
     nowhere is worse than no link. */
  it('leaves a rung with no destination as plain text', () => {
    expect(trail()).toMatch(/<span[^>]*>资料库</u);
    expect(trail()).not.toMatch(/<a[^>]*>资料库</u);
  });

  it('marks the last rung as the page, and never links it', () => {
    const html = trail();

    expect(html).toContain('aria-current="page"');
    expect(html).not.toMatch(/<a[^>]*>比赛工作区</u);
  });

  /* The reference's 「›」. It is punctuation between two names — read aloud it
     is noise, which is the whole reason a joined string was the wrong shape. */
  it('draws the reference separator and keeps it out of the reading', () => {
    const html = trail();

    expect(html.match(/›/gu)).toHaveLength(2);
    expect(html.match(/role="presentation"/gu)).toHaveLength(2);
    expect(html.match(/aria-hidden="true"/gu)).toHaveLength(2);
  });

  it('carries no bare hex', () => {
    expect(trail()).not.toMatch(/#[0-9a-f]{3,8}/iu);
  });
});
