import { Trans } from '@lingui/react/macro';
import { describe, expect, it } from 'vitest';

import { renderMarkup } from '../../test/render';
import { Checkbox } from './Checkbox';

describe('Checkbox markup', () => {
  it('wraps a native checkbox in its own label', () => {
    const html = renderMarkup(
      <Checkbox defaultChecked>
        <Trans>包含子目录</Trans>
      </Checkbox>,
    );

    expect(html).toMatch(/^<label/u);
    expect(html).toContain('type="checkbox"');
    expect(html).toContain('包含子目录');
  });

  it('is square — `.radio .dot` is the only round thing in the system', () => {
    const html = renderMarkup(<Checkbox aria-label="选择该行" />);
    expect(html).not.toContain('rounded');
    expect(html).not.toContain('50%');
  });

  it('draws the 15px box for lists and the 13px box for table rows', () => {
    expect(renderMarkup(<Checkbox aria-label="x" />)).toContain('size-[15px]');
    expect(renderMarkup(<Checkbox size="sm" aria-label="x" />)).toContain('size-[13px]');
  });

  it('fills with the accent when checked and outlines with neutral-400 when not', () => {
    const html = renderMarkup(<Checkbox aria-label="x" />);
    expect(html).toContain('border-neutral-400');
    expect(html).toContain('peer-checked:bg-accent');
    // The reference marks a checked box with a fill and nothing inside it.
    expect(html).not.toContain('✓');
  });

  it('hides the input the Industry way, not with sr-only', () => {
    const html = renderMarkup(<Checkbox aria-label="x" />);
    expect(html).toMatch(/<input[^>]*class="[^"]*opacity-0/u);
    expect(html).toMatch(/<input[^>]*class="[^"]*pointer-events-none/u);
    expect(html).not.toContain('sr-only');
  });

  it('announces a partial selection as mixed and draws the bar', () => {
    const html = renderMarkup(<Checkbox indeterminate aria-label="全选" />);
    expect(html).toContain('aria-checked="mixed"');
    expect(html).toContain('w-[7px]');
  });

  it('leaves the bar out of a two-state box', () => {
    const html = renderMarkup(<Checkbox aria-label="x" />);
    expect(html).not.toContain('aria-checked');
    expect(html).not.toContain('w-[7px]');
  });

  it('marks the whole row not-allowed when disabled, label included', () => {
    const html = renderMarkup(<Checkbox disabled aria-label="x" />);
    expect(html).toContain('disabled=""');
    expect(html).toMatch(/<label[^>]*class="[^"]*cursor-not-allowed/u);
  });

  it('carries no bare hex', () => {
    expect(renderMarkup(<Checkbox indeterminate aria-label="x" />)).not.toMatch(/#[0-9a-f]{3,8}/iu);
  });
});
