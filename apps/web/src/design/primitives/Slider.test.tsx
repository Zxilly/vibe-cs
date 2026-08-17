import { describe, expect, it } from 'vitest';

import { renderMarkupDom } from '../../test/render';
import { Slider } from './Slider';

/* `renderMarkupDom`, not `renderMarkup`: Radix hides the thumb and withholds
   `aria-valuenow` until it has measured itself, and `react-dom/server` has no
   layout to measure. Rendered for real, the thumb is there. */
const renderMarkup = renderMarkupDom;

describe('Slider markup', () => {
  it('puts the slider role on the thumb, with its bounds and value', () => {
    const html = renderMarkup(<Slider value={5} min={1} max={10} aria-label="take 上限" />);

    expect(html).toContain('role="slider"');
    expect(html).toContain('aria-label="take 上限"');
    expect(html).toContain('aria-valuemin="1"');
    expect(html).toContain('aria-valuemax="10"');
    expect(html).toContain('aria-valuenow="5"');
  });

  it('is the reference 4px track with a 14px square thumb', () => {
    const html = renderMarkup(<Slider value={50} aria-label="x" />);
    expect(html).toContain('h-[4px]');
    expect(html).toContain('size-[14px]');
    expect(html).not.toContain('rounded');
  });

  it('paints the range and the thumb from the accent token', () => {
    const html = renderMarkup(<Slider value={50} aria-label="x" />);
    expect(html).toContain('bg-accent');
    expect(html).toContain('bg-neutral-300');
    expect(html).not.toMatch(/#[0-9a-f]{3,8}/iu);
  });

  it('is single-handled: one thumb, whatever the value', () => {
    const html = renderMarkup(<Slider value={40} min={0} max={100} aria-label="x" />);
    expect(html.match(/role="slider"/gu)).toHaveLength(1);
  });

  it('gives assistive technology the same reading the row shows', () => {
    const html = renderMarkup(<Slider value={32} valueText="中 · 3.2m" aria-label="跟随距离" />);
    expect(html).toContain('aria-valuetext="中 · 3.2m"');
  });

  it('omits aria-valuetext when there is no human reading', () => {
    expect(renderMarkup(<Slider value={32} aria-label="x" />)).not.toContain('aria-valuetext');
  });

  it('dims the whole control when disabled', () => {
    const html = renderMarkup(<Slider value={32} disabled aria-label="x" />);
    expect(html).toContain('data-[disabled]:opacity-45');
    expect(html).toContain('data-disabled');
  });
});
