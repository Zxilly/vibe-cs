/*
 * `markup` project — the router-aware anchor.
 *
 * The point of the component is that pages never spell `#` themselves, so the
 * cases that matter are the two router modes producing two different hrefs from
 * the same `to`.
 */

import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';

import { renderMarkup } from '../test/render';
import { RouteLink } from './RouteLink';

describe('RouteLink', () => {
  it('is a real anchor, so middle-click and the back button keep working', () => {
    const html = renderMarkup(
      <MemoryRouter>
        <RouteLink to="/library">资料库</RouteLink>
      </MemoryRouter>,
    );
    expect(html).toContain('<a ');
    expect(html).toContain('href="/library"');
    expect(html).not.toContain('<button');
  });

  it('lets the router resolve the address instead of the page hard-coding it', () => {
    // A basename is the mode-agnostic proof: the page passed `/library` and the
    // router, not the page, decided what the anchor points at. The hash prefix
    // itself needs a document and is covered in `RouteLink.interaction.test.tsx`.
    const html = renderMarkup(
      <MemoryRouter basename="/app" initialEntries={['/app/']}>
        <RouteLink to="/library">资料库</RouteLink>
      </MemoryRouter>,
    );
    expect(html).toContain('href="/app/library"');
  });

  it('carries the query through', () => {
    const html = renderMarkup(
      <MemoryRouter>
        <RouteLink to="/delivery?view=tasks">任务记录</RouteLink>
      </MemoryRouter>,
    );
    expect(html).toContain('href="/delivery?view=tasks"');
  });

  it('keeps the design layer’s link treatment rather than restyling it', () => {
    const html = renderMarkup(
      <MemoryRouter>
        <RouteLink to="/">工作台</RouteLink>
      </MemoryRouter>,
    );
    // `design/primitives/Link`: underlined at rest, 13px by default.
    expect(html).toContain('underline');
    expect(html).toContain('text-sm');
  });

  it('passes size through to the primitive', () => {
    const html = renderMarkup(
      <MemoryRouter>
        <RouteLink to="/" size="xs">
          工作台
        </RouteLink>
      </MemoryRouter>,
    );
    expect(html).toContain('text-xs');
  });
});
