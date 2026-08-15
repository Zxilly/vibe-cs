import { describe, expect, it } from 'vitest';

import { renderMarkup } from '../../test/render';
import { TextInput } from './TextInput';

describe('TextInput markup', () => {
  it('renders a bare input when there is no adornment', () => {
    const html = renderMarkup(<TextInput placeholder="搜索比赛、选手或文件名" />);

    expect(html).toMatch(/^<input/u);
    expect(html).toContain('type="text"');
    expect(html).toContain('placeholder="搜索比赛、选手或文件名"');
  });

  it('is the bordered box itself, so the base.css focus ring lands outside it', () => {
    const html = renderMarkup(<TextInput />);
    expect(html).toMatch(/<input[^>]*class="[^"]*\bborder\b/u);
    expect(html).toContain('border-divider');
    expect(html).not.toContain('outline-none');
  });

  it('takes its height from a §3.3 token, defaulting to the 32px floor', () => {
    expect(renderMarkup(<TextInput />)).toContain('h-[var(--h-ctl-sm)]');
    expect(renderMarkup(<TextInput size="md" />)).toContain('h-[var(--h-ctl-md)]');
    expect(renderMarkup(<TextInput />)).not.toMatch(/h-\[\d+px\]/u);
  });

  it('is transparent over its panel unless asked for the drawer ground', () => {
    expect(renderMarkup(<TextInput />)).toContain('bg-transparent');
    expect(renderMarkup(<TextInput ground="bg" />)).toContain('bg-bg');
  });

  it('switches the border to --color-fail when invalid, and says so', () => {
    const html = renderMarkup(<TextInput invalid />);
    expect(html).toContain('border-fail');
    expect(html).not.toContain('border-divider');
    expect(html).toContain('aria-invalid="true"');
  });

  it('uses the mono family for tabular values', () => {
    expect(renderMarkup(<TextInput mono value="148 812" readOnly />)).toContain('font-mono');
    expect(renderMarkup(<TextInput />)).not.toContain('font-mono');
  });

  it('wraps and insets only when an adornment is present', () => {
    const bare = renderMarkup(<TextInput />);
    expect(bare).not.toContain('pl-9');

    const withIcon = renderMarkup(<TextInput leading={<svg />} />);
    expect(withIcon).toMatch(/^<span/u);
    expect(withIcon).toContain('pl-9');
    expect(withIcon).toContain('aria-hidden="true"');

    const withTrailing = renderMarkup(<TextInput trailing={<span>秒</span>} />);
    expect(withTrailing).toContain('pr-9');
  });

  it('passes the Field ids straight through', () => {
    const html = renderMarkup(<TextInput id="duration" aria-describedby="duration-hint" />);
    expect(html).toContain('id="duration"');
    expect(html).toContain('aria-describedby="duration-hint"');
  });

  it('carries no bare hex and no literal type size', () => {
    const html = renderMarkup(<TextInput leading={<svg />} />);
    expect(html).not.toMatch(/#[0-9a-f]{3,8}/iu);
    expect(html).not.toMatch(/text-\[\d/u);
  });
});
