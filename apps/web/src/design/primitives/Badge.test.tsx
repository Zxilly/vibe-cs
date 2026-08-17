import { Trans } from '@lingui/react/macro';
import { describe, expect, it } from 'vitest';

import { renderMarkup } from '../../test/render';
import { Badge } from './Badge';

describe('Badge markup', () => {
  it('renders a neutral span by default', () => {
    const html = renderMarkup(
      <Badge>
        <Trans>已过期</Trans>
      </Badge>,
    );

    expect(html).toMatch(/^<span/u);
    expect(html).toContain('已过期');
    expect(html).toContain('bg-neutral-100');
    expect(html).toContain('text-neutral-800');
  });

  it('pairs step 100 with step 800 of the same ramp for every filled tone', () => {
    expect(renderMarkup(<Badge variant="accent">已分析</Badge>)).toContain('bg-accent-100');
    expect(renderMarkup(<Badge variant="accent">已分析</Badge>)).toContain('text-accent-800');
    expect(renderMarkup(<Badge variant="accent-2">合并</Badge>)).toContain('bg-accent-2-100');
    expect(renderMarkup(<Badge variant="accent-2">合并</Badge>)).toContain('text-accent-2-800');
  });

  it('outlines rather than fills the outline tone', () => {
    const html = renderMarkup(<Badge variant="outline">待处理</Badge>);
    expect(html).toContain('border-accent');
    expect(html).not.toContain('bg-accent-100');
  });

  it('declares a border on every tone so the box size does not move', () => {
    for (const tone of ['accent', 'accent-2', 'neutral', 'outline'] as const) {
      expect(renderMarkup(<Badge variant={tone}>x</Badge>)).toMatch(/class="[^"]*\bborder\b/u);
    }
  });

  it('uses the 11px step and no literal type size', () => {
    const html = renderMarkup(<Badge>x</Badge>);
    expect(html).toContain('text-2xs');
    expect(html).not.toMatch(/text-\[\d/u);
  });

  it('lends its box to the element the caller means', () => {
    const html = renderMarkup(
      <Badge asChild variant="outline">
        <button type="button">
          ＋ 选手
        </button>
      </Badge>,
    );

    expect(html).toMatch(/^<button/u);
    expect(html).toContain('type="button"');
    expect(html).toContain('＋ 选手');
  });

  it('carries no bare hex', () => {
    expect(renderMarkup(<Badge variant="accent">x</Badge>)).not.toMatch(/#[0-9a-f]{3,8}/iu);
  });
});

describe('Badge · the count chip', () => {
  it('is the lighter hairline the nav tallies draw', () => {
    const html = renderMarkup(
      <Badge variant="count" size="sm">
        3
      </Badge>,
    );

    expect(html).toContain('border-accent-300');
    expect(html).toContain('text-accent-700');
    // No vertical padding and half the inline padding: a digit, not a word.
    expect(html).toContain('px-1.5');
    expect(html).not.toContain('py-[calc(var(--spacing)*0.9)]');
  });

  it('keeps the word chip on Industry’s own padding', () => {
    expect(renderMarkup(<Badge variant="accent">已分析</Badge>)).toContain(
      'py-[calc(var(--spacing)*0.9)]',
    );
  });
});
