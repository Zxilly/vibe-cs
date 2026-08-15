import { Trans } from '@lingui/react/macro';
import { describe, expect, it } from 'vitest';

import { renderMarkup } from '../../test/render';
import { Tag } from './Tag';

describe('Tag markup', () => {
  it('renders a neutral span by default', () => {
    const html = renderMarkup(
      <Tag>
        <Trans>已过期</Trans>
      </Tag>,
    );

    expect(html).toMatch(/^<span/u);
    expect(html).toContain('已过期');
    expect(html).toContain('bg-neutral-100');
    expect(html).toContain('text-neutral-800');
  });

  it('pairs step 100 with step 800 of the same ramp for every filled tone', () => {
    expect(renderMarkup(<Tag tone="accent">已分析</Tag>)).toContain('bg-accent-100');
    expect(renderMarkup(<Tag tone="accent">已分析</Tag>)).toContain('text-accent-800');
    expect(renderMarkup(<Tag tone="accent-2">合并</Tag>)).toContain('bg-accent-2-100');
    expect(renderMarkup(<Tag tone="accent-2">合并</Tag>)).toContain('text-accent-2-800');
  });

  it('outlines rather than fills the outline tone', () => {
    const html = renderMarkup(<Tag tone="outline">待处理</Tag>);
    expect(html).toContain('border-accent');
    expect(html).not.toContain('bg-accent-100');
  });

  it('declares a border on every tone so the box size does not move', () => {
    for (const tone of ['accent', 'accent-2', 'neutral', 'outline'] as const) {
      expect(renderMarkup(<Tag tone={tone}>x</Tag>)).toMatch(/class="[^"]*\bborder\b/u);
    }
  });

  it('uses the 11px step and no literal type size', () => {
    const html = renderMarkup(<Tag>x</Tag>);
    expect(html).toContain('text-2xs');
    expect(html).not.toMatch(/text-\[\d/u);
  });

  it('becomes a real button when the chip is actionable', () => {
    const html = renderMarkup(
      <Tag as="button" tone="outline">
        ＋ 选手
      </Tag>,
    );

    expect(html).toMatch(/^<button/u);
    expect(html).toContain('type="button"');
    expect(html).toContain('＋ 选手');
  });

  it('carries no bare hex', () => {
    expect(renderMarkup(<Tag tone="accent">x</Tag>)).not.toMatch(/#[0-9a-f]{3,8}/iu);
  });
});
