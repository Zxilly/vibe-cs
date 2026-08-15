import { Trans } from '@lingui/react/macro';
import { describe, expect, it } from 'vitest';

import { renderMarkup } from '../../test/render';
import { Link } from './Link';

describe('Link markup', () => {
  it('renders an anchor that carries its destination', () => {
    const html = renderMarkup(
      <Link href="#/library">
        <Trans>查看全部</Trans>
      </Link>,
    );

    expect(html).toMatch(/^<a/u);
    expect(html).toContain('href="#/library"');
    expect(html).toContain('查看全部');
  });

  it('defaults to the 13px step and offers the 12px metadata step', () => {
    expect(renderMarkup(<Link href="#/x">a</Link>)).toContain('text-sm');
    expect(renderMarkup(<Link href="#/x" size="xs">a</Link>)).toContain('text-xs');
    expect(renderMarkup(<Link href="#/x" size="base">a</Link>)).toContain('text-base');
  });

  it('takes colour and underline offset from base.css rather than restating them', () => {
    const html = renderMarkup(<Link href="#/x">a</Link>);
    expect(html).not.toContain('text-accent');
    expect(html).not.toContain('underline-offset');
    expect(html).toContain('underline');
  });

  it('opens an external destination safely', () => {
    const html = renderMarkup(
      <Link href="https://example.invalid/docs" external>
        文档
      </Link>,
    );

    expect(html).toContain('target="_blank"');
    // Reverse tabnabbing is not hypothetical in a Tauri webview.
    expect(html).toContain('rel="noreferrer noopener"');
  });

  it('stays in place by default', () => {
    const html = renderMarkup(<Link href="#/x">a</Link>);
    expect(html).not.toContain('target=');
    expect(html).not.toContain('rel=');
  });

  it('carries no bare hex and no literal type size', () => {
    const html = renderMarkup(<Link href="#/x">a</Link>);
    expect(html).not.toMatch(/#[0-9a-f]{3,8}/iu);
    expect(html).not.toMatch(/text-\[\d/u);
  });
});
