import { describe, expect, it } from 'vitest';

import { renderMarkup } from '../../test/render';
import { Slider, sliderPercent } from './Slider';

describe('sliderPercent', () => {
  it('maps the range onto 0–100', () => {
    expect(sliderPercent(0, 0, 10)).toBe(0);
    expect(sliderPercent(5, 0, 10)).toBe(50);
    expect(sliderPercent(10, 0, 10)).toBe(100);
  });

  it('clamps rather than letting the thumb leave the track', () => {
    expect(sliderPercent(-3, 0, 10)).toBe(0);
    expect(sliderPercent(99, 0, 10)).toBe(100);
  });

  it('degrades to 0 on a collapsed or unusable range', () => {
    expect(sliderPercent(5, 10, 10)).toBe(0);
    expect(sliderPercent(Number.NaN, 0, 10)).toBe(0);
  });
});

describe('Slider markup', () => {
  it('lays a real range input over the drawn track', () => {
    const html = renderMarkup(<Slider value={5} min={1} max={10} aria-label="take 上限" />);

    expect(html).toContain('type="range"');
    // The platform supplies the `slider` role; a hand-rolled div would have to
    // reimplement step arithmetic and Home / End as well.
    expect(html).not.toContain('role="slider"');
    expect(html).toContain('aria-label="take 上限"');
    expect(html).toContain('opacity-0');
  });

  it('is the reference 4px track with a 14px square thumb', () => {
    const html = renderMarkup(<Slider value={50} aria-label="x" />);
    expect(html).toContain('h-[4px]');
    expect(html).toContain('size-[14px]');
    expect(html).not.toContain('rounded');
  });

  it('paints the fill and the thumb from the accent token', () => {
    const html = renderMarkup(<Slider value={50} aria-label="x" />);
    expect(html).toContain('bg-accent');
    expect(html).toContain('bg-neutral-300');
    expect(html).not.toMatch(/#[0-9a-f]{3,8}/iu);
  });

  it('positions the fill and thumb from the value', () => {
    const html = renderMarkup(<Slider value={40} min={0} max={100} aria-label="x" />);
    expect(html).toContain('width:40%');
    expect(html).toContain('left:40%');
    // Inset rather than overhanging: the thumb stays inside the track at 100%.
    expect(html).toContain('translateX(-40%)');
  });

  it('passes min, max and step through to the platform', () => {
    const html = renderMarkup(<Slider value={3} min={1} max={12} step={1} aria-label="x" />);
    expect(html).toContain('min="1"');
    expect(html).toContain('max="12"');
    expect(html).toContain('step="1"');
    expect(html).toContain('value="3"');
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
    expect(html).toContain('opacity-45');
    expect(html).toContain('disabled=""');
  });
});
