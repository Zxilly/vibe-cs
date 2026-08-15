import { describe, expect, it } from 'vitest';

import { renderMarkup } from '../../test/render';
import { CompositionRow } from './CompositionRow';

describe('CompositionRow', () => {
  it('writes the slot, what fills it and where that came from', () => {
    const html = renderMarkup(
      <CompositionRow index={2} label="跟随突破 · 3.0s" source="来自 Take B · 压缩版" emphasis />,
    );

    expect(html).toContain('data-composition-slot="2"');
    expect(html).toContain('02');
    expect(html).toContain('跟随突破 · 3.0s');
    expect(html).toContain('data-composition-source');
    expect(html).toContain('来自 Take B · 压缩版');
    expect(html).toContain('data-composition-emphasis');
  });

  it('omits the source line for a slot that has none', () => {
    const html = renderMarkup(<CompositionRow index={1} label="建立地点 · 3.0s" />);

    expect(html).not.toContain('data-composition-source');
  });

  it('draws nothing to press when the caller offers no picker', () => {
    const html = renderMarkup(<CompositionRow index={1} label="建立地点 · 3.0s" />);

    expect(html).not.toContain('<button');
  });

  it('clips a long label rather than pushing the panel wide', () => {
    const html = renderMarkup(
      <CompositionRow index={1} label="建立地点 · 一个长到必须截断的镜头名 · 3.0s" source="来自 Take A" />,
    );

    expect(html.split('truncate').length - 1).toBeGreaterThanOrEqual(2);
  });
});
