import { describe, expect, it } from 'vitest';

import { renderMarkup } from '../../test/render';
import { Input } from './Input';

describe('Input markup', () => {
  it('renders a bare input when there is no adornment', () => {
    const html = renderMarkup(<Input placeholder="搜索比赛、选手或文件名" />);

    expect(html).toMatch(/^<input/u);
    expect(html).toContain('type="text"');
    expect(html).toContain('placeholder="搜索比赛、选手或文件名"');
  });

  it('is the bordered box itself, so the base.css focus ring lands outside it', () => {
    const html = renderMarkup(<Input />);
    expect(html).toMatch(/<input[^>]*class="[^"]*\bborder\b/u);
    expect(html).toContain('border-divider');
    expect(html).not.toContain('outline-none');
  });

  it('takes its height from a §3.3 token, defaulting to the 32px floor', () => {
    expect(renderMarkup(<Input />)).toContain('h-[var(--h-ctl-sm)]');
    expect(renderMarkup(<Input size="md" />)).toContain('h-[var(--h-ctl-md)]');
    expect(renderMarkup(<Input />)).not.toMatch(/h-\[\d+px\]/u);
  });

  it('is transparent over its panel unless asked for the drawer ground', () => {
    expect(renderMarkup(<Input />)).toContain('bg-transparent');
    expect(renderMarkup(<Input ground="bg" />)).toContain('bg-bg');
  });

  it('switches the border to --color-fail when invalid, and says so', () => {
    const html = renderMarkup(<Input invalid />);
    expect(html).toContain('border-fail');
    expect(html).not.toContain('border-divider');
    expect(html).toContain('aria-invalid="true"');
  });

  it('uses the mono family for tabular values', () => {
    expect(renderMarkup(<Input mono value="148 812" readOnly />)).toContain('font-mono');
    expect(renderMarkup(<Input />)).not.toContain('font-mono');
  });

  /* Adornments moved to `InputGroup`. What this pins is that `Input` is the
     bare box again — one element, no wrapper to reason about. */
  it('is the input itself, with nothing wrapped around it', () => {
    expect(renderMarkup(<Input />)).toMatch(/^<input/u);
  });

  it('passes the Field ids straight through', () => {
    const html = renderMarkup(<Input id="duration" aria-describedby="duration-hint" />);
    expect(html).toContain('id="duration"');
    expect(html).toContain('aria-describedby="duration-hint"');
  });

  it('carries no bare hex and no literal type size', () => {
    const html = renderMarkup(<Input />);
    expect(html).not.toMatch(/#[0-9a-f]{3,8}/iu);
    expect(html).not.toMatch(/text-\[\d/u);
  });
});
