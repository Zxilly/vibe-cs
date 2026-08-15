import { Trans } from '@lingui/react/macro';
import { describe, expect, it } from 'vitest';

import { renderMarkup } from '../../test/render';
import { Seg } from './Seg';

const VIEW_OPTIONS = [
  { value: 'table', label: <Trans>表格</Trans> },
  { value: 'card', label: <Trans>卡片</Trans> },
] as const;

describe('Seg markup', () => {
  it('is a radio group of native radios, not a row of buttons', () => {
    const html = renderMarkup(
      <Seg name="library-view" value="table" options={VIEW_OPTIONS} aria-label="视图" />,
    );

    expect(html).toContain('role="radiogroup"');
    expect(html).toContain('aria-label="视图"');
    expect(html.match(/<input/gu)?.length).toBe(2);
    expect(html).toContain('type="radio"');
    expect(html).toContain('name="library-view"');
    expect(html).not.toContain('<button');
  });

  it('checks exactly the selected option', () => {
    const html = renderMarkup(<Seg name="v" value="card" options={VIEW_OPTIONS} aria-label="视图" />);
    expect(html.match(/checked=""/gu)?.length).toBe(1);
    expect(html).toMatch(/checked=""[^>]*value="card"/u);
  });

  it('renders every label', () => {
    const html = renderMarkup(<Seg name="v" value="table" options={VIEW_OPTIONS} aria-label="视图" />);
    expect(html).toContain('表格');
    expect(html).toContain('卡片');
  });

  it('draws the divider on every option but the first', () => {
    const html = renderMarkup(
      <Seg
        name="v"
        value="a"
        aria-label="视角"
        options={[
          { value: 'a', label: 'A' },
          { value: 'b', label: 'B' },
          { value: 'c', label: 'C' },
        ]}
      />,
    );
    expect(html.match(/border-l border-divider/gu)?.length).toBe(2);
  });

  it('lays out naturally by default and splits the width evenly when filled', () => {
    const natural = renderMarkup(<Seg name="v" value="table" options={VIEW_OPTIONS} aria-label="视图" />);
    expect(natural).not.toContain('w-full');
    expect(natural).not.toContain('flex-1');

    const filled = renderMarkup(<Seg name="v" value="table" options={VIEW_OPTIONS} fill aria-label="视图" />);
    expect(filled).toContain('w-full');
    expect(filled.match(/flex-1 justify-center/gu)?.length).toBe(2);
  });

  it('takes its height from a §3.3 token and its type from --text-sm at every height', () => {
    const small = renderMarkup(<Seg name="v" value="table" options={VIEW_OPTIONS} aria-label="视图" />);
    expect(small).toContain('h-[var(--h-ctl-sm)]');
    expect(small).toContain('text-sm');

    const medium = renderMarkup(
      <Seg name="v" value="table" options={VIEW_OPTIONS} size="md" aria-label="视图" />,
    );
    expect(medium).toContain('h-[var(--h-ctl-md)]');
    // A taller seg is a taller target, not a louder label.
    expect(medium).toContain('text-sm');
  });

  it('disables a single option without disabling the group', () => {
    const html = renderMarkup(
      <Seg
        name="v"
        value="a"
        aria-label="画质"
        options={[
          { value: 'a', label: 'A' },
          { value: 'b', label: 'B', disabled: true },
        ]}
      />,
    );
    expect(html.match(/disabled=""/gu)?.length).toBe(1);
  });

  it('carries no bare hex and no literal type size', () => {
    const html = renderMarkup(<Seg name="v" value="table" options={VIEW_OPTIONS} aria-label="视图" />);
    expect(html).not.toMatch(/#[0-9a-f]{3,8}/iu);
    expect(html).not.toMatch(/text-\[\d/u);
  });
});
