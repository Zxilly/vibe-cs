import { describe, expect, it } from 'vitest';

import { renderMarkup } from '../../test/render';
import { LayerEmpty } from './LayerEmpty';

describe('LayerEmpty', () => {
  const html = renderMarkup(
    <svg>
      <LayerEmpty layer="heat" label="热力叠加：没有采样点" />
    </svg>,
  );

  it('carries the reason as both a description and an accessible name', () => {
    expect(html).toContain('role="note"');
    expect(html).toContain('aria-label="热力叠加：没有采样点"');
    expect(html).toContain('<desc>热力叠加：没有采样点</desc>');
  });

  it('is findable as the layer it stands in for', () => {
    expect(html).toContain('data-layer="heat"');
    expect(html).toContain('data-layer-state="empty"');
  });

  it('draws nothing at all — no zero-valued geometry', () => {
    expect(html).not.toContain('<path');
    expect(html).not.toContain('<rect');
    expect(html).not.toContain('<circle');
    expect(html).not.toContain('<line');
  });
});
